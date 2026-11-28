import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthFailureLimiter, registerBearerAuth } from "../auth.js";
import { registerResearchRoutes } from "../research-api.js";
import { ACQUIRE_STEP_KEY, createRepositoryResearchRun, processAcquireRepositoryStep } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { ANALYSIS_STEP_KEYS, ANALYZE_STEP_KEY, ANALYZER_VERSION, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY } from "../analysis/solidity/keys.js";
import { buildDossier, renderDossierMarkdown } from "../analysis/solidity/pipeline.js";
import { ResearchFixture } from "./research-helpers.js";
import { dispatchAnalysisStep, processAnalyzeStructureStep } from "../analysis/solidity/step.js";
import { ResearchStore } from "../research-state.js";
import { intakeStepKeys } from "../worker-runtime.js";
import { WorkflowWorker, type ClaimedStep } from "../worker.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
const corpus = join(__dirname, "..", "..", "..", "..", "eval", "dev", "contracts");

describe("the intake worker's step keys", () => {
  it("claims the analysis stages only when the switch is exactly 'true'", () => {
    for (const k of ANALYSIS_STEP_KEYS) {
      expect(intakeStepKeys({})).not.toContain(k);
      expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "1" })).not.toContain(k);
      expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "TRUE" })).not.toContain(k);
      expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true" })).toContain(k);
    }
    expect(intakeStepKeys({})).toContain(ACQUIRE_STEP_KEY);
  });
});

describe.skipIf(skipIntegration)("structural analysis inside the repository_research workflow (real Postgres)", () => {
  let db: TestDatabase; let fx: GitFixture;
  beforeAll(async () => {
    assertIntegrationConfigured(); db = await migratedTestDatabase();
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "vaults" });
  });
  afterAll(async () => { fx?.cleanup(); await db?.drop(); });
  /** runs from other tests stay out of the queue so a worker claims only the run under test */
  const retire = async (runId: string) => { await db.ownerPool.query("UPDATE workflow_steps SET status = 'cancelled' WHERE workflow_run_id = $1 AND status = 'queued'", [runId]); await db.ownerPool.query("UPDATE workflow_runs SET status = 'cancelled' WHERE id = $1", [runId]); };
  const steps = async (runId: string) => (await db.pool.query("SELECT step_key, sequence, role, status, output FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [runId])).rows;

  it("is OFF by default: a plain run has only the acquisition step", async () => {
    const { runId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vaults", ref: "main" });
    expect((await steps(runId)).map((s) => s.step_key)).toEqual([ACQUIRE_STEP_KEY]);
    await retire(runId);
  });

  it("when requested, appends analyse, challenge and dossier stages after acquisition, and a worker without the switch cannot claim them", async () => {
    const { runId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vaults", ref: "main" }, "operator", { structuralAnalysis: true });
    expect((await steps(runId)).map((s) => [s.step_key, s.sequence, s.role])).toEqual([[ACQUIRE_STEP_KEY, 0, "repository_acquirer"], [ANALYZE_STEP_KEY, 1, "structural_analyst"], [CHALLENGE_STEP_KEY, 2, "lead_challenger"], [DOSSIER_STEP_KEY, 3, "dossier_builder"]]);
    const worker = new WorkflowWorker(db.pool, "gate-test", 60, 3);
    expect(await worker.claimNext(intakeStepKeys({}).filter((k) => k !== ACQUIRE_STEP_KEY))).toBeNull(); // nothing claimable: the analysis stages wait behind the switch
    await retire(runId);
  });

  it("runs the whole chain on a sealed, commit-pinned snapshot with provenance, and builds the dossier from verified stored records", async () => {
    const { runId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vaults", ref: "main" }, "operator", { structuralAnalysis: true });
    const worker = new WorkflowWorker(db.pool, "chain-worker", 120, 3); const ctx = { pool: db.pool, worker, workerId: "chain-worker", heartbeatMs: 40 };
    const acq = (await worker.claimNext([ACQUIRE_STEP_KEY]))!; expect(acq.workflow_run_id).toBe(runId);
    await processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "chain-worker", source: new FakeSource(fx) }, acq);
    for (const key of ANALYSIS_STEP_KEYS) { const s = (await worker.claimNext([key]))!; expect(s.step_key).toBe(key); expect(await dispatchAnalysisStep(ctx, s)).toBe(true); }
    const rows = await steps(runId);
    expect(rows.map((r) => r.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect((await db.pool.query("SELECT status FROM workflow_runs WHERE id = $1", [runId])).rows[0].status).toBe("succeeded");
    const [a, , , d] = [rows[0].output, rows[1].output, rows[2].output, rows[3].output];
    const analyze = rows[1].output; const dossier = rows[3].output;
    expect(analyze).toMatchObject({ status: "structure_analyzed", analyzer: ANALYZER_VERSION, snapshot_id: a.snapshot_id, commit_sha: fx.commitSha, manifest_sha256: a.manifest_sha256, execution_mode: "passive_only", active_testing_allowed: false });
    expect(analyze.hypotheses).toBeGreaterThan(5); expect(analyze.structural_map_sha256).toMatch(/^[0-9a-f]{64}$/); expect(analyze.structural_map.contracts.length).toBeGreaterThan(3);
    expect(dossier).toMatchObject({ status: "dossier_built", snapshot_id: a.snapshot_id, human_review: "none recorded" }); void d;
    // everything is in the existing research store: hypotheses with spans and evaluations on THIS snapshot
    const n = async (sql: string) => Number((await db.pool.query(sql, [a.snapshot_id])).rows[0].n);
    expect(await n("SELECT count(*) n FROM hypotheses WHERE snapshot_id = $1")).toBe(analyze.hypotheses);
    expect(await n("SELECT count(*) n FROM hypothesis_evaluations e JOIN hypotheses h ON h.id = e.hypothesis_id WHERE h.snapshot_id = $1")).toBe(analyze.hypotheses);
    // the dossier recorded by the step equals one rebuilt from the stored records
    expect((await buildDossier(db.pool, new ResearchStore(db.pool), a.snapshot_id)).content_sha256).toBe(dossier.content_sha256);
    // outputs carry pointers, counts and metadata, never source text
    expect(JSON.stringify(rows)).not.toMatch(/pragma solidity|SPDX-License/);
    // P1 (protocol model): stored content-addressed by the analysis step, linked from its output, and consumed by the dossier
    expect(analyze.protocol_model_sha256).toMatch(/^[0-9a-f]{64}$/); expect(analyze.protocol_model_stored).toBe(true);
    expect(analyze.protocol_model_counts.components).toBeGreaterThan(3);
    expect(Number((await db.pool.query("SELECT count(*) n FROM research_blobs WHERE content_sha256 = $1", [analyze.protocol_model_sha256])).rows[0].n)).toBe(1);
    const built = await buildDossier(db.pool, new ResearchStore(db.pool), a.snapshot_id);
    expect(built.architecture.available).toBe(true);
    if (built.architecture.available) {
      expect(built.architecture.model_sha256).toBe(analyze.protocol_model_sha256);
      const eps = built.architecture.components.flatMap((c) => c.entry_points);
      expect(eps.length).toBeGreaterThan(3);
      // the architecture section says, with code locations, which entry points are unguarded and where external calls go
      expect(eps.some((e) => !e.guarded)).toBe(true);
      for (const c of built.architecture.components) expect(c.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      for (const e of eps.flatMap((x) => x.external_calls)) expect(e.at).toMatch(/^contracts\/.+\.sol:\d+/);
      // calls made by an internal helper on behalf of an entry point are listed under the entry point (Bank.withdrawHelper -> _pay)
      const helper = eps.find((e) => e.fn === "Bank.withdrawHelper(uint256)");
      expect(helper).toBeTruthy(); expect(helper!.external_calls.some((x) => x.kind === "low-level-call" && x.target_provenance === "msg.sender")).toBe(true);
    }
    expect(renderDossierMarkdown(built)).toMatch(/## Architecture \(protocol model P1-P3\)/);
    // P2 in the dossier: state roles carry basis and strength; a name-only authority is shown as weak, never as enforced
    if (built.architecture.available) {
      const roles = built.architecture.components.flatMap((c) => c.state_roles);
      expect(roles.some((v) => v.roles.some((r) => /^ledger \(established, strong/.test(r)))).toBe(true);
      expect(roles.some((v) => v.roles.some((r) => /^authority \(inferred, strong, authorising-guard-read/.test(r)))).toBe(true);
      for (const v of roles) for (const r of v.roles) expect(r).toMatch(/@ contracts\/.+\.sol:\d+/);
      // P3 in the dossier: authority holders and writers with code locations; open writes and unresolved paths are listed, not hidden
      const au = built.architecture.components.map((c) => c.authority).filter((x): x is NonNullable<typeof x> => x !== null);
      expect(au.length).toBe(built.architecture.components.length);
      const roleRows = au.flatMap((a) => a.roles); expect(roleRows.length).toBeGreaterThan(0);
      for (const r of roleRows) for (const w of r.writers) expect(w).toMatch(/\[(constructor|one-time-initialiser|guarded|open)[^\]]*\] @ contracts\/.+\.sol:\d+$/);
      expect(au.some((a) => a.open_authority_writes.length > 0)).toBe(true); // the dev corpus contains unprotected authority setters
    }
  });


  it("refuses to analyse when acquisition has not produced a sealed snapshot", async () => {
    const { runId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vaults", ref: "main" }, "operator", { structuralAnalysis: true });
    const fake = { id: "00000000-0000-0000-0000-000000000000", workflow_run_id: runId, step_key: ANALYZE_STEP_KEY, role: "structural_analyst", input: {}, attempt: 1 } as unknown as ClaimedStep;
    await expect(processAnalyzeStructureStep({ pool: db.pool, worker: new WorkflowWorker(db.pool, "x", 60, 3), workerId: "x" }, fake)).rejects.toThrow(/sealed snapshot/);
    await retire(runId);
  });

  it("serves the dossier through the bearer-protected API, built from stored records, and refuses without authentication", async () => {
    const snapshotId = (await db.pool.query("SELECT id FROM repo_snapshots ORDER BY created_at DESC LIMIT 1")).rows[0].id as string;
    const token = "d".repeat(20) + "abcdefghijklmnopqrstuvwxyz0123456789"; const app = Fastify({ logger: false });
    registerBearerAuth(app, token, new AuthFailureLimiter({ perClientMax: 1000, globalMax: 100000, windowMs: 60_000 })); registerResearchRoutes(app, db.pool);
    try {
      const auth = { authorization: `Bearer ${token}` };
      expect((await app.inject({ method: "GET", url: `/v1/research/snapshots/${snapshotId}/dossier` })).statusCode).toBe(401);
      const ok = await app.inject({ method: "GET", url: `/v1/research/snapshots/${snapshotId}/dossier`, headers: auth });
      expect(ok.statusCode).toBe(200);
      const body = ok.json() as { content_sha256: string; entries: unknown[]; snapshot: { verified: boolean } };
      expect(body.snapshot.verified).toBe(true); expect(body.entries.length).toBeGreaterThan(5);
      expect(body.content_sha256).toBe((await buildDossier(db.pool, new ResearchStore(db.pool), snapshotId)).content_sha256);
      expect((await app.inject({ method: "GET", url: "/v1/research/snapshots/not-a-uuid/dossier", headers: auth })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/v1/research/snapshots/00000000-0000-0000-0000-000000000000/dossier", headers: auth })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("a dossier for a snapshot with no recorded protocol model says so instead of reconstructing one", async () => {
    const rfx = new ResearchFixture(db); const snap = await rfx.sealedSnapshot(); // sealed, but never through the analysis step
    const d = await buildDossier(db.pool, new ResearchStore(db.pool), snap.snapshotId);
    expect(d.architecture).toEqual({ available: false, reason: "no protocol model is recorded for this snapshot's analysis step" });
    expect(renderDossierMarkdown(d)).toMatch(/Not available: no protocol model is recorded/);
  });
});
