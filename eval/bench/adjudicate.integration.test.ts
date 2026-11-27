import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiBudgetGateway, type ModelAdapter, type ModelRequest } from "../../apps/api/src/ai-budget-gateway.js";
import { migratedTestDatabase, seedRun, skipIntegration, type TestDatabase } from "../../apps/api/src/integration/harness.js";
import { adjudicate, type Candidate } from "./adjudicate.js";
import { runBenchmark, type Label } from "./benchmark.js";
import { buildModelView } from "./model-view.js";
import { loadCorpus } from "../run-eval.js";

/**
 * Benchmark AI adjudication through the REAL budget gateway over a disposable, fully migrated Postgres, with local fake
 * adapters (no provider, no network, no spend). Proves: reservation -> call -> settlement and token accounting; blocks are
 * recorded as unavailable (empty catalog, per-call cap, emergency stop) and write nothing; a provider failure is charged and
 * halts the pass; the model never sees ground truth.
 */
const repoRoot = resolve(__dirname, "..", "..");

describe.skipIf(skipIntegration)("benchmark adjudication through AiBudgetGateway (real Postgres)", () => {
  let db: TestDatabase; let runId: string;
  let candidates: Candidate[]; let view: ReturnType<typeof buildModelView>; let labels: Label[];

  beforeAll(async () => {
    db = await migratedTestDatabase();
    ({ runId } = await seedRun(db.pool, ["benchmark_adjudication"]));
    await db.ownerPool.query(
      `INSERT INTO ai_model_prices (provider, model, price_version, input_usd_per_million_tokens, output_usd_per_million_tokens,
         max_input_tokens, max_output_tokens, enabled, reviewed_by, reviewed_at)
       VALUES ('fake','adjudicator','v1', 3, 15, 4000, 400, true, 'test-reviewer', now()),
              ('fake','too-expensive','v1', 10, 50, 100000, 4000, true, 'test-reviewer', now())`);
    // Real findings from a real corpus (heldout), presented as candidates; the corpus labels are only used to assert blindness.
    const contracts = join(repoRoot, "eval", "heldout", "contracts");
    const record = runBenchmark({ contractsDir: contracts, repoRoot });
    candidates = record.findingsDetail.slice(0, 3).map((finding) => ({ reason: "unscored" as const, finding }));
    const corpus = loadCorpus(contracts) as { sources: Array<{ path: string; text: string }>; labels: Label[] };
    labels = corpus.labels; view = buildModelView(corpus.sources);
    expect(candidates).toHaveLength(3);
  });
  afterAll(async () => { await db?.drop(); });

  const adapter = (model: string, generate: ModelAdapter["generate"]): ModelAdapter => ({ provider: "fake", model, generate });
  const reservations = async () => (await db.ownerPool.query("SELECT status, charged_usd::float AS charged, purpose, tier, input_tokens, output_tokens FROM ai_budget_reservations WHERE workflow_run_id = $1 ORDER BY created_at", [runId])).rows;

  it("completes through the gateway: reserves, settles, records tokens and cost, and the ledger matches", async () => {
    const seen: ModelRequest[] = [];
    const r = await adjudicate(candidates, view, { mode: "gateway", gateway: new AiBudgetGateway(db.pool, false), pool: db.pool, workflowRunId: runId,
      adapter: adapter("adjudicator", async (req) => { seen.push(req); return { text: '{"verdict":"real","severity":"high","rationale":"call before update"}', inputTokens: 900, outputTokens: 60 }; }) });
    expect(r.results.map((x) => x.status)).toEqual(["completed", "completed", "completed"]);
    expect(r.results[0]).toMatchObject({ verdict: "real", severity: "high", inputTokens: 900, outputTokens: 60 });
    const expected = (900 * 3 + 60 * 15) / 1_000_000;
    expect(r.results[0]!.costUsd).toBeCloseTo(expected, 10);
    const rows = await reservations();
    expect(rows.map((x) => x.status)).toEqual(["reconciled", "reconciled", "reconciled"]);
    expect(rows.every((x) => x.purpose === "independent_challenge" && x.tier === "tier3")).toBe(true);
    expect(rows.reduce((a, x) => a + x.charged, 0)).toBeCloseTo(r.spentUsd, 8);
    // Blindness through the real path: nothing the adapter received carries a label note or the labelled class vocabulary of the notes.
    const sent = seen.map((q) => q.system + q.user).join("\n");
    for (const l of labels) if (l.note) expect(sent).not.toContain(l.note);
    expect(sent).not.toMatch(/contracts\/[A-Za-z]+\.sol/); // only neutral file names
  });

  it("records an unpriced model (the empty production catalog) as unavailable and writes no reservation", async () => {
    const before = (await reservations()).length;
    const r = await adjudicate(candidates, view, { mode: "gateway", gateway: new AiBudgetGateway(db.pool, false), pool: db.pool, workflowRunId: runId,
      adapter: adapter("not-in-catalog", async () => { throw new Error("must not be called"); }) });
    expect(r.results.every((x) => x.status === "unavailable" && x.detail === "gateway_blocked:reviewed_model_price_unavailable")).toBe(true);
    expect(r.spentUsd).toBe(0);
    expect((await reservations()).length).toBe(before);
  });

  it("enforces the per-call cap for the configured tier (tier3, $0.10) before any call", async () => {
    const before = (await reservations()).length;
    const r = await adjudicate(candidates, view, { mode: "gateway", gateway: new AiBudgetGateway(db.pool, false), pool: db.pool, workflowRunId: runId,
      adapter: adapter("too-expensive", async () => { throw new Error("must not be called"); }) });
    expect(r.results[0]).toMatchObject({ status: "unavailable", detail: "gateway_blocked:per_call_cap_exceeded" });
    expect((await reservations()).length).toBe(before);
  });

  it("honours the emergency stop", async () => {
    const r = await adjudicate(candidates, view, { mode: "gateway", gateway: new AiBudgetGateway(db.pool, true), pool: db.pool, workflowRunId: runId,
      adapter: adapter("adjudicator", async () => { throw new Error("must not be called"); }) });
    expect(r.results.every((x) => x.detail === "gateway_blocked:global_emergency_stop")).toBe(true);
  });

  it("charges a failed provider call in the ledger, reports it as failed, and halts without retrying", async () => {
    let calls = 0;
    const before = (await reservations()).length;
    const r = await adjudicate(candidates, view, { mode: "gateway", gateway: new AiBudgetGateway(db.pool, false), pool: db.pool, workflowRunId: runId,
      adapter: adapter("adjudicator", async () => { calls += 1; throw new Error("provider exploded"); }) });
    expect(calls).toBe(1);
    expect(r.results[0]).toMatchObject({ status: "failed", detail: "provider exploded", verdict: null });
    expect(r.results.slice(1).every((x) => x.status === "unavailable")).toBe(true);
    const rows = await reservations();
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ status: "failed_charged" });
    expect(rows.at(-1)!.charged).toBeGreaterThan(0);
  });
});
