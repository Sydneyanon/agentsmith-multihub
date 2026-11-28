import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRepositoryResearchRun, processAcquireRepositoryStep } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { dispatchAnalysisStep } from "../analysis/solidity/step.js";
import { ResearchConflictError, ResearchStore, sha256Hex } from "../research-state.js";
import { WorkflowWorker } from "../worker.js";
import { assertIntegrationConfigured, expireLease, migratedTestDatabase, REPO_ROOT, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * D7 in DIRECT mode (the worker with a database connection, today's production path) and at the store: an evaluation is idempotent on
 * (hypothesis, evaluator, version, input hash). A worker killed mid-challenge and retried records nothing twice; concurrent duplicates
 * write once; a retry after a lost answer gets the ORIGINAL evaluation id; and nothing already recorded is overwritten or reordered,
 * including the hypothesis_events order that decides every evaluator's LATEST outcome (the ID-counter attack against B' moved exactly
 * that order; here no write path can append a second event for an evaluation key).
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
const corpus = join(REPO_ROOT, "eval", "dev", "contracts");

describe.skipIf(skipIntegration)("D7: evaluations are idempotent on their key (direct mode and the store)", () => {
  let db: TestDatabase; let fx: GitFixture;
  beforeAll(async () => {
    assertIntegrationConfigured(); db = await migratedTestDatabase();
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "d7" });
  });
  afterAll(async () => { fx?.cleanup(); await db?.drop(); });
  const events = async (runId: string) => (await db.ownerPool.query<{ seq: string; hypothesis_id: string; evaluation_id: string | null; event_type: string }>(
    "SELECT seq, hypothesis_id, evaluation_id, event_type FROM hypothesis_events WHERE workflow_run_id = $1 ORDER BY seq", [runId])).rows;
  const status = async (runId: string) => (await db.ownerPool.query("SELECT s.hypothesis_id, s.status, s.static_outcome, s.evaluations FROM hypothesis_status s JOIN hypotheses h ON h.id = s.hypothesis_id WHERE h.workflow_run_id = $1 ORDER BY 1", [runId])).rows;

  it("a direct worker killed mid-challenge and retried records no duplicate, and every earlier event keeps its place", async () => {
    process.env.STRUCTURAL_ANALYSIS_ENABLED = "true";
    try {
      const { runId } = await createRepositoryResearchRun(db.pool, { repository: "acme/d7", ref: "main" }, "operator", { structuralAnalysis: true });
      const worker = new WorkflowWorker(db.pool, "d7-worker", 60, 3);
      const acq = (await worker.claimNext(["acquire_repository"], runId))!;
      await processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "d7-worker", source: new FakeSource(fx) }, acq);
      const an = (await worker.claimNext(["analyze_structure"], runId))!; await dispatchAnalysisStep({ pool: db.pool, worker, workerId: "d7-worker" }, an);
      // the challenge is killed after its 5th committed evaluation (each evaluation is its own transaction in direct mode)
      const ch = (await worker.claimNext(["challenge_leads"], runId))!;
      const store = new ResearchStore(db.pool); let n = 0;
      const dying = new Proxy(store, { get: (t, k) => k === "recordEvaluation" ? async (...a: Parameters<ResearchStore["recordEvaluation"]>) => { if (n++ === 5) throw new Error("SIGKILL (simulated, mid-challenge)"); return t.recordEvaluation(...a); } : (t as never)[k] });
      const { researchContext } = await import("../analysis/solidity/step.js");
      const ctx = researchContext({ pool: db.pool, worker, workerId: "d7-worker" });
      await expect(dispatchAnalysisStep({ ...ctx, store: dying }, ch)).rejects.toThrow(/SIGKILL/);
      const partial = await events(runId); const partialStatus = await status(runId);
      expect(partial.filter((e) => e.event_type === "evaluation_recorded").length).toBe(5);
      // the lease expires; a NEW worker process (another id) reclaims the step and runs the whole challenge again
      await expireLease(db.ownerPool, ch.id);
      const reborn = new WorkflowWorker(db.pool, "d7-worker-reborn", 60, 3);
      const again = (await reborn.claimNext(["challenge_leads"], runId))!; expect([again.id, again.attempt]).toEqual([ch.id, 2]);
      await dispatchAnalysisStep({ pool: db.pool, worker: reborn, workerId: "d7-worker-reborn" }, again);
      const after = await events(runId);
      // no duplicate: one evaluation per lead, one event per evaluation
      expect((await db.ownerPool.query("SELECT hypothesis_id, evaluator_id, count(*) FROM hypothesis_evaluations WHERE workflow_run_id = $1 GROUP BY 1, 2 HAVING count(*) > 1", [runId])).rows).toEqual([]);
      const leads = Number((await db.ownerPool.query("SELECT count(*) FROM hypotheses WHERE workflow_run_id = $1", [runId])).rows[0].count);
      expect(after.filter((e) => e.event_type === "evaluation_recorded").length).toBe(leads);
      // nothing overwritten or reordered: the events before the kill are a PREFIX of the events after, with the same seq and ids
      expect(after.slice(0, partial.length)).toEqual(partial);
      // and the latest outcome of every lead that was already evaluated before the kill is unchanged
      const final = new Map((await status(runId)).map((r) => [r.hypothesis_id, r]));
      for (const r of partialStatus.filter((x) => x.evaluations > 0)) expect(final.get(r.hypothesis_id)).toEqual(r);
      // the retried evaluations returned the ORIGINAL ids (the store answered with the existing row)
      const ids = (await db.ownerPool.query<{ id: string }>("SELECT evaluation_id AS id FROM hypothesis_events WHERE workflow_run_id = $1 AND evaluation_id IS NOT NULL ORDER BY seq", [runId])).rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      // evaluation provenance was recorded by the direct worker, once per evaluation
      expect(Number((await db.ownerPool.query("SELECT count(*) FROM evaluation_provenance WHERE workflow_run_id = $1 AND recorded_by = 'direct-worker'", [runId])).rows[0].count)).toBe(leads);
    } finally { delete process.env.STRUCTURAL_ANALYSIS_ENABLED; }
  });

  it("concurrent duplicates write once; a retry after a lost answer returns the original id; a changed verdict for the same key is a conflict; a second writer past the store is refused", async () => {
    const run = (await db.ownerPool.query<{ id: string }>("SELECT workflow_run_id AS id FROM hypotheses LIMIT 1")).rows[0]!.id;
    const h = (await db.ownerPool.query<{ id: string }>("SELECT id FROM hypotheses WHERE workflow_run_id = $1 ORDER BY id LIMIT 1", [run])).rows[0]!.id;
    // a fresh leased step in that run
    const step = (await db.ownerPool.query<{ id: string }>("INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, 'd7_probe', 9, 'test', '{}'::jsonb) RETURNING id", [run])).rows[0]!.id;
    await db.ownerPool.query("UPDATE workflow_runs SET status = 'running' WHERE id = $1", [run]);
    await db.ownerPool.query("UPDATE workflow_steps SET status = 'running', lease_owner = 'd7-probe', lease_expires_at = now() + interval '5 minutes', attempt = 1 WHERE id = $1", [step]);
    const lease = { stepId: step, workerId: "d7-probe" }; const store = new ResearchStore(db.pool);
    const input = { hypothesisId: h, evaluatorId: "no-independent-validator", evaluatorVersion: "d7", outcome: "inconclusive" as const, rationale: "d7 probe", spanIds: [], inputSha256: sha256Hex("d7 probe") };
    const before = (await events(run)).length;
    const ids = await Promise.all(Array.from({ length: 8 }, () => store.recordEvaluation(lease, input)));
    expect(new Set(ids).size).toBe(1);
    expect(await store.recordEvaluation(lease, input)).toBe(ids[0]); // the retry after a lost answer
    expect((await events(run)).length).toBe(before + 1);
    await expect(store.recordEvaluation(lease, { ...input, outcome: "inconclusive", rationale: "a different verdict for the same input" })).rejects.toBeInstanceOf(ResearchConflictError);
    const r = (await db.ownerPool.query("SELECT workflow_run_id, produced_by_step_id FROM hypotheses WHERE id = $1", [h])).rows[0];
    await expect(db.ownerPool.query(`INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.workflow_run_id, h, r.produced_by_step_id, input.evaluatorId, input.evaluatorVersion, input.outcome, input.rationale, input.inputSha256])).rejects.toThrow(/duplicate key/);
    expect((await events(run)).length).toBe(before + 1);
  });
});
