import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACQUIRE_STEP_KEY, createRepositoryResearchRun, processAcquireRepositoryStep } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY } from "../analysis/solidity/keys.js";
import { dispatchAnalysisStep } from "../analysis/solidity/step.js";
import { WorkflowWorker } from "../worker.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * Foundation A (hypothesis identity): challenge_leads challenges EXACTLY the hypotheses analyze_structure stored, by id from its step
 * output, with their findings from the stored payloads. The analyzer is made to change between the two steps (as a deploy between them
 * would): before the fix the challenge stage re-ran it, matched by claim text and silently challenged nothing.
 */
const mutate = vi.hoisted(() => ({ on: false }));
vi.mock("../analysis/solidity/specialists.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../analysis/solidity/specialists.js")>();
  return { ...m, analyzeSources: (s: Parameters<typeof m.analyzeSources>[0]) => { const r = m.analyzeSources(s); return mutate.on ? { ...r, findings: r.findings.map((f) => ({ ...f, claim: `${f.claim} (analyzer changed)`, function: `${f.function}_renamed` })) } : r; } };
});

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
const corpus = join(__dirname, "..", "..", "..", "..", "eval", "heldout", "contracts");

describe.skipIf(skipIntegration)("challenge_leads reads hypothesis identity from stored records (real Postgres)", () => {
  let db: TestDatabase; let fx: GitFixture;
  beforeAll(async () => {
    assertIntegrationConfigured(); db = await migratedTestDatabase();
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "identity" });
  });
  afterAll(async () => { fx?.cleanup(); await db?.drop(); });

  async function analysed() {
    await db.ownerPool.query("UPDATE workflow_steps SET status = 'cancelled' WHERE status = 'queued'");
    const { runId } = await createRepositoryResearchRun(db.pool, { repository: "acme/identity", ref: "main" }, "operator", { structuralAnalysis: true });
    const worker = new WorkflowWorker(db.pool, "id-worker", 120, 3); const ctx = { pool: db.pool, worker, workerId: "id-worker", heartbeatMs: 1000 };
    await processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "id-worker", source: new FakeSource(fx) }, (await worker.claimNext([ACQUIRE_STEP_KEY]))!);
    await dispatchAnalysisStep(ctx, (await worker.claimNext([ANALYZE_STEP_KEY]))!);
    const output = (await db.pool.query("SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [runId, ANALYZE_STEP_KEY])).rows[0].output;
    return { runId, worker, ctx, output: output as { snapshot_id: string; hypothesis_ids: string[]; finding_payloads: Record<string, string> } };
  }
  const evals = async (ids: string[]) => (await db.pool.query<{ hypothesis_id: string; evaluator_id: string; outcome: string; rationale: string }>(
    "SELECT hypothesis_id, evaluator_id, outcome, rationale FROM hypothesis_evaluations WHERE hypothesis_id = ANY($1::uuid[]) ORDER BY hypothesis_id", [ids])).rows;

  it("challenges every stored hypothesis by id even when the analyzer changes between the steps", async () => {
    const r = await analysed();
    expect(r.output.hypothesis_ids.length).toBeGreaterThan(10);
    mutate.on = true;
    try {
      await dispatchAnalysisStep(r.ctx, (await r.worker.claimNext([CHALLENGE_STEP_KEY]))!);
      await dispatchAnalysisStep(r.ctx, (await r.worker.claimNext([DOSSIER_STEP_KEY]))!);
    } finally { mutate.on = false; }
    const ev = await evals(r.output.hypothesis_ids);
    // exactly one evaluation per stored hypothesis, and only for those
    expect(ev.map((e) => e.hypothesis_id).sort()).toEqual([...r.output.hypothesis_ids].sort());
    // findings came from the stored payloads (the original function names), not from the changed analyzer
    expect(ev.some((e) => /_renamed|analyzer changed/.test(e.rationale))).toBe(false);
    expect(ev.filter((e) => e.outcome === "supports").length).toBeGreaterThan(0);
    expect(Object.keys(r.output.finding_payloads).sort()).toEqual([...r.output.hypothesis_ids].sort());
    const out = (await db.pool.query("SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [r.runId, CHALLENGE_STEP_KEY])).rows[0].output;
    expect(out.hypothesis_ids).toEqual(r.output.hypothesis_ids); expect(out.unresolved).toEqual([]);
  });

  it("records a stored hypothesis it cannot read back as inconclusive with the reason, never skipping it", async () => {
    const r = await analysed();
    const [noPayload, otherPayload] = r.output.hypothesis_ids;
    // the producing step's record is damaged: one hypothesis has no payload, another points at a payload describing a different hypothesis
    const payloads = { ...r.output.finding_payloads }; delete payloads[noPayload!]; payloads[otherPayload!] = r.output.finding_payloads[noPayload!]!;
    await db.ownerPool.query("UPDATE workflow_steps SET output = jsonb_set(output, '{finding_payloads}', $2::jsonb) WHERE workflow_run_id = $1 AND step_key = $3", [r.runId, JSON.stringify(payloads), ANALYZE_STEP_KEY]);
    await dispatchAnalysisStep(r.ctx, (await r.worker.claimNext([CHALLENGE_STEP_KEY]))!);
    const ev = await evals(r.output.hypothesis_ids);
    expect(ev.length).toBe(r.output.hypothesis_ids.length);
    const a = ev.find((e) => e.hypothesis_id === noPayload)!; const b = ev.find((e) => e.hypothesis_id === otherPayload)!;
    expect(a.outcome).toBe("inconclusive"); expect(a.rationale).toMatch(/Not challenged: no canonical finding payload is recorded/);
    expect(b.outcome).toBe("inconclusive"); expect(b.rationale).toMatch(/Not challenged: the recorded finding payload does not describe this hypothesis/);
    const out = (await db.pool.query("SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [r.runId, CHALLENGE_STEP_KEY])).rows[0].output;
    expect(out.unresolved.map((u: { hypothesis_id: string }) => u.hypothesis_id).sort()).toEqual([noPayload, otherPayload].sort());
  });

  it("records a stored hypothesis whose function is absent from the re-parsed index as inconclusive with the reason", async () => {
    const r = await analysed();
    const id = r.output.hypothesis_ids.find(Boolean)!;
    const original = JSON.parse((await db.pool.query("SELECT convert_from(content, 'UTF8') AS t FROM research_blobs WHERE content_sha256 = $1", [r.output.finding_payloads[id]])).rows[0].t);
    // a payload (content-addressed, so a new blob) naming a function the sealed snapshot does not contain
    const forged = Buffer.from(JSON.stringify({ ...original, function: "doesNotExist" }), "utf8");
    const sha = (await import("node:crypto")).createHash("sha256").update(forged).digest("hex");
    await db.ownerPool.query("INSERT INTO research_blobs (content_sha256, size_bytes, content) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [sha, forged.length, forged]);
    await db.ownerPool.query("UPDATE workflow_steps SET output = jsonb_set(output, ARRAY['finding_payloads', $2::text], to_jsonb($3::text)) WHERE workflow_run_id = $1 AND step_key = $4", [r.runId, id, sha, ANALYZE_STEP_KEY]);
    await dispatchAnalysisStep(r.ctx, (await r.worker.claimNext([CHALLENGE_STEP_KEY]))!);
    const e = (await evals([id]))[0]!;
    expect(e.outcome).toBe("inconclusive");
    expect(e.rationale).toMatch(new RegExp(`names ${original.contract}\\.doesNotExist, which is not a function of the index re-parsed from the sealed snapshot`));
  });

  it("fails the step when the producing step lists an id that is not a specialist hypothesis of this snapshot", async () => {
    const r = await analysed();
    await db.ownerPool.query("UPDATE workflow_steps SET output = jsonb_set(output, '{hypothesis_ids}', (output->'hypothesis_ids') || to_jsonb('00000000-0000-0000-0000-000000000000'::text)) WHERE workflow_run_id = $1 AND step_key = $2", [r.runId, ANALYZE_STEP_KEY]);
    await expect(dispatchAnalysisStep(r.ctx, (await r.worker.claimNext([CHALLENGE_STEP_KEY]))!)).rejects.toThrow(/not a solidity-structural-specialists hypothesis of snapshot/);
  });
});
