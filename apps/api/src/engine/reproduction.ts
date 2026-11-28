import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { sealedSnapshot, withHeartbeat } from "../analysis/solidity/step.js";
import { ResearchStore, sha256Hex } from "../research-state.js";
import { WorkflowWorker, type ClaimedStep } from "../worker.js";
import { ATTENDED_REPRODUCE_STEP_KEY, capabilityById, FOUNDRY_STEP_KEY, FOUNDRY_VERSION, pinnedVersion } from "./capabilities.js";
import type { EngineStepContext } from "./steps.js";
import { runForgeTest } from "./tools/foundry.js";

/**
 * Reproduction (T-202): turning claims into technical evidence.
 *
 * Evaluations live in the claim's OWN run (0007: an evaluation references the hypothesis and a step of the same run), so a reproduction
 * is a CONTINUATION of the run that made the claims (T-149: one run, more steps), never a parallel lifecycle:
 *   ... existing steps ... -> specialist_reproduce (an attended test author writes test/*.sol per claim; never a claim's producer)
 *                          -> foundry_validate     (pinned forge, offline, each test run twice; one evaluation per tested claim).
 * A run holds one step per key (0001), so a run gets ONE reproduction round, covering every claim of that run that needs one at the
 * time; a claim that needs one later is deferred with that reason (a stated limitation). The run is reopened; an audit event keeps its
 * earlier completion. Outcome mapping, stated and fixed:
 *   intent "demonstrate", both runs pass identically -> supports    (the local defect is shown; live exploitability is NOT)
 *   intent "refute",      both runs pass identically -> weakens     (one test cannot prove impossibility, so never "contradicts")
 *   any matched test fails, identically               -> inconclusive (the claim may be false, or the test wrong)
 *   the two runs disagree                             -> inconclusive (non-deterministic)
 *   tool failure                                      -> inconclusive with the failure code
 *   no test written                                   -> no evaluation (recorded as not attempted)
 */
const ref = z.object({ id: z.string(), version: z.string() }).strict();
export const reproduceInputSchema = z.object({
  decisionId: z.string().uuid(),
  claims: z.array(z.object({ claim: z.string().regex(/^C\d{2,4}$/), hypothesisId: z.string().uuid() }).strict()).min(1).max(50),
  author: ref, evaluator: ref,
}).strict();
export type ReproduceInput = z.infer<typeof reproduceInputSchema>;

/** Whether this run has already had its reproduction round (one per run). */
export async function reproductionRoundUsed(db: Pick<PoolClient, "query">, runId: string): Promise<boolean> {
  return (await db.query("SELECT 1 FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [runId, ATTENDED_REPRODUCE_STEP_KEY])).rows.length > 0;
}

export async function appendReproductionIn(client: Pick<PoolClient, "query">, a: { decisionId: string; hypothesisIds: string[]; author: { id: string; version: string }; evaluator: { id: string; version: string } }, createdBy: string): Promise<{ runId: string; reproduceStepId: string; validateStepId: string }> {
  const hs = (await client.query<{ id: string; workflow_run_id: string; generator_id: string }>("SELECT id, workflow_run_id, generator_id FROM hypotheses WHERE id = ANY($1::uuid[])", [a.hypothesisIds])).rows;
  if (hs.length !== a.hypothesisIds.length) throw new Error("unknown hypothesis");
  if (hs.some((h) => h.generator_id === a.author.id)) throw new Error("the test author produced one of these claims: a specialist never validates its own claim");
  const runs = [...new Set(hs.map((h) => h.workflow_run_id))]; if (runs.length !== 1) throw new Error("one reproduction round covers the claims of one run");
  const runId = runs[0]!;
  const p = reproduceInputSchema.parse({ decisionId: a.decisionId, claims: a.hypothesisIds.map((h, i) => ({ claim: `C${String(i + 1).padStart(2, "0")}`, hypothesisId: h })), author: a.author, evaluator: a.evaluator });
  const run = (await client.query<{ status: string; completed_at: Date | null; correlation_id: string; n: number }>(
    "SELECT r.status, r.completed_at, r.correlation_id, (SELECT coalesce(max(sequence), -1) FROM workflow_steps WHERE workflow_run_id = r.id) n FROM workflow_runs r WHERE r.id = $1 FOR UPDATE", [runId])).rows[0]!;
  if (run.status !== "succeeded") throw new Error(`the claims' run is ${run.status}; a reproduction continues a finished run only`);
  if (await reproductionRoundUsed(client, runId)) throw new Error("this run has already had its reproduction round");
  const rep = await client.query<{ id: string }>(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, $3, 'test_author', $4::jsonb) RETURNING id`, [runId, ATTENDED_REPRODUCE_STEP_KEY, run.n + 1, JSON.stringify(p)]);
  const val = await client.query<{ id: string }>(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, $3, 'evaluator', $4::jsonb) RETURNING id`, [runId, FOUNDRY_STEP_KEY, run.n + 2, JSON.stringify(p)]);
  await client.query("UPDATE workflow_runs SET status = 'queued', completed_at = NULL WHERE id = $1", [runId]);
  await client.query(`INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason, payload) VALUES ($1, 'research_run.continued', 'workflow_run', $2, $3, 'Reproduction round appended to the run that made the claims (evaluations live in the claim''s own run)', $4::jsonb)`,
    [createdBy, runId, run.correlation_id, JSON.stringify({ decision_id: p.decisionId, hypothesis_ids: a.hypothesisIds, previously_completed_at: run.completed_at, steps: [rep.rows[0]!.id, val.rows[0]!.id] })]);
  return { runId, reproduceStepId: rep.rows[0]!.id, validateStepId: val.rows[0]!.id };
}

const testFile = z.object({ path: z.string().regex(/^test\/([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(\.t)?\.sol$/), content: z.string().min(1).max(200_000) }).strict();
const claimTest = z.union([
  z.object({ claim: z.string().regex(/^C\d{2,4}$/), files: z.array(testFile).min(1).max(10), matchTest: z.string().regex(/^[A-Za-z0-9_.|*^$()-]{1,200}$/), intent: z.enum(["demonstrate", "refute"]), demonstrates: z.string().min(3).max(2000) }).strict(),
  z.object({ claim: z.string().regex(/^C\d{2,4}$/), none: z.literal(true), reason: z.string().min(3).max(2000) }).strict(),
]);
export const testImportSchema = z.object({ tests: z.array(claimTest).min(1).max(50) }).strict();
type StoredTest = { claim: string; hypothesis_id: string } & ({ tests: Array<{ path: string; blob_sha256: string }>; match_test: string; intent: "demonstrate" | "refute"; demonstrates: string } | { none: true; reason: string });

/** The attended test author's result for one reproduction round. The author is never a claim's producer; every claim gets an answer. */
export async function importTest(pool: Pool, runId: string, raw: unknown, meta: { operator: string; tokens?: number | null; durationMs?: number | null }): Promise<{ runId: string; tested: number; none: number }> {
  if (!/^[A-Za-z0-9._@-]{2,100}$/.test(meta.operator)) throw new Error("a named operator is required");
  const step = (await pool.query<{ id: string; input: ReproduceInput }>("SELECT id, input FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2 AND status = 'queued'", [runId, ATTENDED_REPRODUCE_STEP_KEY])).rows[0];
  if (!step) throw new Error("this run has no reproduction step waiting for tests");
  const a = reproduceInputSchema.parse(step.input); const author = capabilityById(a.author.id);
  const gens = (await pool.query<{ id: string; generator_id: string }>("SELECT id, generator_id FROM hypotheses WHERE id = ANY($1::uuid[])", [a.claims.map((c) => c.hypothesisId)])).rows;
  if (gens.some((g) => g.generator_id === author.id)) throw new Error("the test author produced one of these claims: a specialist never validates its own claim");
  const t = testImportSchema.parse(raw);
  const answered = new Set(t.tests.map((x) => x.claim));
  for (const c of a.claims) if (!answered.has(c.claim)) throw new Error(`no answer for ${c.claim}: give tests or "none" with a reason for every claim`);
  if (t.tests.some((x) => !a.claims.some((c) => c.claim === x.claim))) throw new Error("an answer names a claim that is not in this round");
  const worker = new WorkflowWorker(pool, `attended:${meta.operator}`, 600, 1);
  const claimed = await worker.claimNext([ATTENDED_REPRODUCE_STEP_KEY], runId);
  if (!claimed || claimed.id !== step.id) throw new Error("the reproduction step could not be claimed (an earlier step has not finished)");
  const lease = { stepId: step.id, workerId: `attended:${meta.operator}` }; const store = new ResearchStore(pool);
  try {
    const stored: StoredTest[] = [];
    for (const x of t.tests) {
      const hypothesis_id = a.claims.find((c) => c.claim === x.claim)!.hypothesisId;
      if ("none" in x) { stored.push({ claim: x.claim, hypothesis_id, none: true, reason: x.reason }); continue; }
      const tests = []; for (const f of x.files) tests.push({ path: f.path, blob_sha256: (await store.putBlob(lease, Buffer.from(f.content, "utf8"))).sha256 });
      stored.push({ claim: x.claim, hypothesis_id, tests, match_test: x.matchTest, intent: x.intent, demonstrates: x.demonstrates });
    }
    await worker.complete(step.id, { status: "tests_recorded", author: { id: author.id, version: pinnedVersion(author), operator: meta.operator, runtime: author.profile.runtime }, tests: stored,
      effort: { subagent_tokens: meta.tokens ?? null, duration_ms: meta.durationMs ?? null }, wall_ms: meta.durationMs ?? 0 });
    await pool.query("INSERT INTO research_effort (workflow_run_id, step_id, method, wall_ms, decision_id) VALUES ($1,$2,$3,$4,$5)", [runId, step.id, author.id, Math.max(0, Math.round(meta.durationMs ?? 0)), a.decisionId]);
    return { runId, tested: stored.filter((s) => !("none" in s)).length, none: stored.filter((s) => "none" in s).length };
  } catch (e) { await worker.fail(step.id, e instanceof Error ? e.message.slice(0, 500) : "import failed", false).catch(() => undefined); throw e; }
}

/** The pinned Foundry evaluator: runs each claim's test twice against the run's sealed snapshot and records one evaluation per tested claim. */
export async function processFoundryValidateStep(ctx: EngineStepContext, step: ClaimedStep): Promise<void> {
  const a = reproduceInputSchema.parse(step.input); const env = ctx.env ?? process.env;
  const prev = (await ctx.pool.query<{ output: { tests: StoredTest[]; author: { id: string } } }>(
    "SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2 AND sequence = $3 AND status = 'succeeded'", [step.workflow_run_id, ATTENDED_REPRODUCE_STEP_KEY, step.sequence - 1])).rows[0]?.output;
  if (!prev) throw new Error("the reproduction step before this one has not produced a result");
  const lease = { stepId: step.id, workerId: ctx.workerId }; const store = new ResearchStore(ctx.pool);
  const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id); const started = Date.now();
  await withHeartbeat(ctx, step, async () => {
    const files = (await ctx.pool.query<{ path: string; content: Buffer }>(`SELECT f.path, b.content FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.snapshot_id = $1 AND f.path LIKE '%.sol' ORDER BY f.path COLLATE "C"`, [snap.snapshotId])).rows;
    const forgeBin = env["AGENTSMITH_FORGE_BIN"]; const solcBin = env["AGENTSMITH_SOLC_BIN"];
    const results: Array<Record<string, unknown>> = [];
    for (const t of prev.tests) {
      if ("none" in t) { results.push({ claim: t.claim, hypothesis_id: t.hypothesis_id, status: "no_test", reason: t.reason }); continue; }
      const primary = (await ctx.pool.query<{ span_id: string }>("SELECT span_id FROM hypothesis_evidence WHERE hypothesis_id = $1 ORDER BY (role = 'primary') DESC, span_id LIMIT 1", [t.hypothesis_id])).rows[0]?.span_id;
      const testSha = sha256Hex(JSON.stringify(t.tests)); const inputSha = sha256Hex(`${snap.manifestSha256}|${testSha}|${t.match_test}|${t.intent}`);
      const record = async (outcome: "supports" | "weakens" | "inconclusive", rationale: string, extra: Record<string, unknown>) => {
        const id = await store.recordEvaluation(lease, { hypothesisId: t.hypothesis_id, evaluatorId: "foundry-forge", evaluatorVersion: FOUNDRY_VERSION, outcome, rationale: rationale.slice(0, 7900), spanIds: outcome === "inconclusive" || !primary ? [] : [primary], inputSha256: inputSha });
        results.push({ claim: t.claim, hypothesis_id: t.hypothesis_id, status: "validated", outcome, evaluation_id: id, test: { sha256: testSha, files: t.tests, match_test: t.match_test, intent: t.intent, demonstrates: t.demonstrates }, ...extra });
      };
      if (!forgeBin || !solcBin) { await record("inconclusive", "tool_unavailable: AGENTSMITH_FORGE_BIN or AGENTSMITH_SOLC_BIN is not set on this machine (a persistent install is A39); nothing was executed", { failure: { code: "tool_unavailable" } }); continue; }
      const contents: Array<{ path: string; content: Buffer }> = [];
      for (const f of t.tests) {
        const c = (await ctx.pool.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [f.blob_sha256])).rows[0]!.content;
        if (sha256Hex(c) !== f.blob_sha256) throw new Error(`test ${f.path} does not match its stored hash`);
        contents.push({ path: f.path, content: c });
      }
      const run = () => runForgeTest({ files, test: { files: contents, matchTest: t.match_test }, forgeBin, solcBin, ...(env["AGENTSMITH_TOOL_TIMEOUT_MS"] ? { timeoutMs: Number(env["AGENTSMITH_TOOL_TIMEOUT_MS"]) } : {}) });
      const r1 = await run(); if (!r1.ok) { await record("inconclusive", `${r1.failure.code}: ${r1.failure.detail}`, { failure: r1.failure }); continue; }
      const r2 = await run(); if (!r2.ok) { await record("inconclusive", `second run ${r2.failure.code}: ${r2.failure.detail}`, { failure: r2.failure }); continue; }
      const key = (r: typeof r1) => JSON.stringify(r.results.map((x) => [x.test, x.passed]).sort());
      const blob = Buffer.byteLength(r1.rawOutput) <= 1_048_576 ? (await store.putBlob(lease, Buffer.from(r1.rawOutput, "utf8"))).sha256 : null;
      const tool = { name: "forge", version: r1.version, input_manifest_sha256: r1.inputManifestSha256, test_sha256: r1.testSha256, raw_output_blob: blob, results: r1.results, second_run_results: r2.results };
      if (key(r1) !== key(r2)) { await record("inconclusive", "non_deterministic: two identical runs disagree", { tool, failure: { code: "non_deterministic" } }); continue; }
      const summary = r1.results.map((x) => `${x.test}: ${x.passed ? "passed" : `failed (${x.reason ?? "no reason"})`}`).join("; ");
      if (!r1.results.every((x) => x.passed)) { await record("inconclusive", `the test failed in both runs (${summary}): the claim may be false, or the test may be wrong; a failing test is not a refutation`, { tool }); continue; }
      await record(t.intent === "refute" ? "weakens" : "supports",
        `${t.intent === "refute" ? "A refutation test" : "A reproducing test"} by ${prev.author.id} (not the claim's producer) passed in two identical pinned runs (forge ${r1.version}, offline): ${summary}. ${t.intent === "refute" ? "This weakens the claim; one test cannot prove impossibility." : "This demonstrates the local defect against the sealed snapshot; it does not establish live exploitability."}`, { tool });
    }
    await ctx.worker.complete(step.id, { status: "validated", results, snapshot_id: snap.snapshotId, manifest_sha256: snap.manifestSha256, wall_ms: Date.now() - started });
    await ctx.pool.query("INSERT INTO research_effort (workflow_run_id, step_id, method, wall_ms, decision_id) VALUES ($1,$2,'foundry-forge',$3,$4)", [step.workflow_run_id, step.id, Date.now() - started, a.decisionId]);
  });
}
