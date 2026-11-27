import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { EXIT, runCli, type CliIo } from "../engine/cli.js";
import { recordHumanOutcome, trackRecords } from "../engine/loop.js";
import { appendReproductionIn, importTest } from "../engine/reproduction.js";
import { fakeTools } from "../engine/tools/testing/fake-tools.js";
import "../engine/tools/tool-host/register.js";
import { ResearchStore } from "../research-state.js";
import { applyDrafts } from "./drafts.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });
/** T-202 end to end on the specialist probe: recorded specialist outputs, the recorded challenger verdicts and the recorded reproduction
 *  tests (written by the attended reproduction specialist on 2026-11-27) replayed through the engine; the stand-in forge in CI, the
 *  REAL pinned forge when AGENTSMITH_FORGE_BIN and AGENTSMITH_SOLC_BIN are set. */
const PROBE = join(__dirname, "..", "..", "..", "..", "eval", "dev", "specialist-probe");
const recorded = (n: string) => JSON.parse(readFileSync(join(PROBE, "outputs", `${n}.json`), "utf8")) as Record<string, unknown>;
const OUTPUT_FOR: Record<string, string> = { "claude-scoping": "scope", "claude-accounting": "accounting", "claude-path": "paths", "claude-assumptions": "assumptions", "claude-liveness": "liveness" };
const REPRO = join(PROBE, "reproduction-tests");
const helpers = { path: "test/Helpers.sol", from: join(REPRO, "Helpers.sol") };
const f = (name: string) => [{ path: `test/${name}`, from: join(REPRO, name) }, helpers];
/** which recorded reproduction test fits a claim (by contract, function and mechanism); null = the author writes none */
function testFor(claim: string): { files: Array<{ path: string; from: string }>; matchTest: string } | null {
  const m = /\[\w+ confidence; (\w+)(?:\.(\w+))?\]/.exec(claim); const contract = m?.[1]; const fn = m?.[2] ?? "";
  if (contract === "RewardPool" && fn === "stake") return { files: f("RewardPool.t.sol"), matchTest: "test_freshStakerStealsPastRewards" };
  if (contract === "LendingPool" && fn === "setPair") return { files: f("LendingPoolSetPair.t.sol"), matchTest: "test_nonOwnerSetsPairAndDrains" };
  if (contract === "LendingPool" && /^(price|borrow|withdrawCollateral)$/.test(fn) && /spot|reserve|oracle|manipul/i.test(claim)) return { files: f("LendingPoolOracle.t.sol"), matchTest: "test_spotPriceManipulationOverBorrow" };
  if (contract === "PayoutSplitter" && fn === "distribute") return { files: f("PayoutSplitter.t.sol"), matchTest: "test_oneFailingRecipientLocksAllFunds" };
  return null;
}

describe.skipIf(skipIntegration)("T-202: claims become technical evidence through a pinned Foundry evaluator (throwaway database)", () => {
  let db: TestDatabase; let fx: GitFixture; let dir: string; let lines: string[] = [];
  const t = fakeTools("ok");
  const real = process.env["AGENTSMITH_FORGE_BIN"] && process.env["AGENTSMITH_SOLC_BIN"] ? { forge: process.env["AGENTSMITH_FORGE_BIN"]!, solc: process.env["AGENTSMITH_SOLC_BIN"]! } : null;
  const env: Record<string, string> = { AGENTSMITH_ATTENDED_OPERATOR: "owner-test", AGENTSMITH_FORGE_BIN: real?.forge ?? t.forge("pass"), AGENTSMITH_SOLC_BIN: real?.solc ?? t.solc };
  const io: CliIo = { out: (l) => lines.push(l), err: (l) => lines.push(l), env, sourceFactory: () => new FakeSource(fx) };
  const cli = async (args: string[]) => { lines = []; const code = await runCli([...args, "--database-url", db.url], io); return { code, text: lines.join("\n") }; };
  const exec = (args: string[]) => cli([...args, "--execute", "--confirm", db.name]);
  const json = async (args: string[]) => { const r = await exec([...args, "--json"]); expect(r.code, r.text).toBe(EXIT.ok); return JSON.parse(r.text) as Record<string, unknown>; };
  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.ownerPool.query(sql, p)).rows as T[];
  const file = (name: string, body: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(body)); return f; };
  const OP = ["--operator", "owner-test"];

  const attend = async (run: string) => {
    const b = JSON.parse((await cli(["brief", "--run", run, "--json"])).text) as { step?: string; capability: { id: string; classes: string[] }; claims?: Array<{ id: string; claim: string }> };
    if (b.step === "specialist_reproduce") {
      const tests = b.claims!.map((c) => { const tf = testFor(c.claim); return tf ? { claim: c.id, files: tf.files, matchTest: tf.matchTest, intent: "demonstrate", demonstrates: "balance-based impact (recorded reproduction test)" } : { claim: c.id, none: true, reason: "no recorded reproduction test for this claim" }; });
      const r = await exec(["import-test", "--run", run, "--file", file(`tests-${run}.json`, { tests }), ...OP, "--duration-ms", "60000"]);
      expect(r.code, r.text).toBe(EXIT.ok); return;
    }
    if (b.capability.id === "claude-challenger") {
      const input = recorded("challenge-input") as { claims: Array<{ id: string; title: string }> }; const verdicts = recorded("challenge") as { reviews: Array<{ claim: string }> };
      const reviews = b.claims!.flatMap((c) => { const src = input.claims.find((x) => c.claim.startsWith(x.title)); const v = src && verdicts.reviews.find((r) => r.claim === src.id); return v ? [{ ...v, claim: c.id }] : []; });
      expect((await exec(["import-challenge", "--run", run, "--file", file(`chal-${run}.json`, { specialist: "challenger", reviews }), ...OP])).code).toBe(EXIT.ok); return;
    }
    const out = OUTPUT_FOR[b.capability.id] && existsSync(join(PROBE, "outputs", `${OUTPUT_FOR[b.capability.id]}.json`)) ? join(PROBE, "outputs", `${OUTPUT_FOR[b.capability.id]}.json`)
      : file(`none-${run}.json`, { specialist: b.capability.id, findings: [], not_examined: [{ what: `every class (${b.capability.classes.join(", ")})`, why: "not run on this fixture" }] });
    expect((await exec(["import-specialist", "--run", run, "--file", out, ...OP])).code).toBe(EXIT.ok);
  };
  const drive = async () => {
    for (let i = 0; i < 250; i++) {
      const actions = JSON.parse((await cli(["next", "--json"])).text) as Array<{ command: string; who: string }>;
      const att = actions.find((x) => x.who === "attended"); if (att) { await attend(att.command.split(" ")[2]!); continue; }
      const step = actions.find((x) => x.who !== "human" && x.command !== "rank"); if (!step) return;
      const r = await exec([...step.command.split(" "), ...(step.command.startsWith("run-assignment") ? ["--allow-network"] : [])]);
      expect(r.code, `${step.command}\n${r.text}`).toBe(EXIT.ok);
    }
    throw new Error("the loop did not settle");
  };

  beforeAll(async () => {
    assertIntegrationConfigured(); db = await migratedTestDatabase(); await applyDrafts(db);
    fx = buildGitFixture(readdirSync(join(PROBE, "src")).sort().map((n) => ({ path: `src/${n}`, content: readFileSync(join(PROBE, "src", n), "utf8") })), { owner: "probe", repo: "defi" });
    dir = mkdtempSync(join(tmpdir(), "repro-"));
    const opp = String((await json(["register", "--file", file("opp.json", { source: { key: "board", displayName: "Board" }, canonicalKey: "board:probe", platform: "community", title: "Probe", referenceUrl: "https://example.org/probe", claims: { repositories: ["probe/defi"] } }), ...OP])).id);
    for (const [check, subject] of [["program_official", "probe"], ["repository_official", "probe/defi"], ["scope_includes_repository", "probe/defi"], ["eligibility", "probe"]]) await exec(["verify", "--opportunity", opp, "--check", check!, "--subject", subject!, "--verdict", "verified", "--method", "m", "--evidence-url", "https://example.org/x", ...OP]);
    const rank = await json(["rank"]); const sel = await json(["select", "--opportunity", opp, "--repository", "probe/defi", "--basis", String(rank.decisionId), ...OP]);
    await exec(["run-assignment", "--run", String(sel.acquisitionRunId), "--allow-network"]);
    await drive();
  });
  afterAll(async () => { fx?.cleanup(); t.cleanup(); rmSync(dir, { recursive: true, force: true }); await db?.drop(); });

  it("AgentSmith decides which claims to reproduce, continues each claim's own run, and keeps an audit trail", async () => {
    const reps = await q<{ workflow_run_id: string; input: { claims: Array<{ hypothesisId: string }>; author: { id: string } } }>("SELECT workflow_run_id, input FROM workflow_steps WHERE step_key = 'specialist_reproduce'");
    expect(reps.length).toBeGreaterThan(1); let claims = 0;
    for (const r of reps) for (const c of r.input.claims) {
      claims++;
      const [h] = await q<{ workflow_run_id: string; generator_id: string }>("SELECT workflow_run_id, generator_id FROM hypotheses WHERE id = $1", [c.hypothesisId]);
      expect(h!.workflow_run_id).toBe(r.workflow_run_id); // the claim's own run, not a parallel one
      expect(r.input.author.id).toBe("claude-reproducer"); expect(h!.generator_id).not.toBe("claude-reproducer");
      // only claims the independent challenger supported were sent for reproduction
      expect((await q("SELECT 1 FROM hypothesis_reviews WHERE hypothesis_id = $1 AND reviewer_kind = 'attended_model' AND verdict = 'supports'", [c.hypothesisId])).length).toBeGreaterThan(0);
    }
    const audit = await q<{ payload: { previously_completed_at: string | null } }>("SELECT payload FROM audit_events WHERE action = 'research_run.continued'");
    expect(audit.length).toBe(reps.length); for (const a of audit) expect(a.payload.previously_completed_at).not.toBeNull();
    const cands = await q<{ reason: string }>("SELECT reason FROM research_decision_candidates WHERE action = 'investigate' AND reason LIKE 'reproduction:%'");
    expect(cands.length).toBe(claims);
  });

  it("the pinned evaluator's result is technical evidence in the claim's own run, by a party other than the producer; untested claims stay untested", async () => {
    const ev = await q<{ outcome: string; evaluator_version: string; rationale: string; generator_id: string }>("SELECT e.outcome, e.evaluator_version, e.rationale, h.generator_id FROM hypothesis_evaluations e JOIN hypotheses h ON h.id = e.hypothesis_id WHERE e.evaluator_id = 'foundry-forge'");
    const supports = ev.filter((e) => e.outcome === "supports");
    expect(supports.length).toBeGreaterThanOrEqual(4); // the four recorded reproductions, for every specialist that claimed them
    for (const e of supports) { expect(e.evaluator_version).toBe("1.5.1"); expect(e.rationale).toMatch(/passed in two identical pinned runs/); expect(e.rationale).toMatch(/does not establish live exploitability/); }
    const noTest = await q("SELECT 1 FROM workflow_steps s, jsonb_array_elements(s.output->'results') r WHERE s.step_key = 'foundry_validate' AND r->>'status' = 'no_test'");
    expect(noTest.length).toBeGreaterThan(0); // claims without a test get no evaluation: recorded as not attempted, never as evidence
    const validated = await q<{ r: { tool: { results: unknown[]; second_run_results: unknown[] } } }>("SELECT r FROM workflow_steps s, jsonb_array_elements(s.output->'results') r WHERE s.step_key = 'foundry_validate' AND r->>'outcome' = 'supports' LIMIT 1");
    expect(validated[0]!.r.tool.results).toEqual(validated[0]!.r.tool.second_run_results);
    // the track records now show technical support for capabilities whose claims were reproduced
    const tr = await trackRecords(db.pool);
    expect(tr.filter((r) => r.capability.startsWith("claude-") && r.technicalSupports > 0).length).toBeGreaterThan(0);
    for (const r of tr) expect(r.usedInSelection).toBe(false);
  });

  it("the three planes complete only with a human: technical evidence + human adjudication makes 'confirmed' possible; neither alone does", async () => {
    const [e] = await q<{ id: string; hypothesis_id: string }>("SELECT e.id, e.hypothesis_id FROM hypothesis_evaluations e WHERE e.evaluator_id = 'foundry-forge' AND e.outcome = 'supports' LIMIT 1");
    await expect(recordHumanOutcome(db.pool, { hypothesisId: e!.hypothesis_id, category: "confirmed", decidedBy: "owner-test", rationale: "evidence without a human review", basisEvaluationIds: [e!.id] })).rejects.toThrow(/confirmed requires a human disclosed_adjudication/);
    const saw = { claim: true, evidence_spans: true, generator_rationale: true, generator_identity: true, prior_evaluations: true, prior_reviews: true };
    const review = await new ResearchStore(db.pool).recordReview({ kind: "operator", operatorId: "owner-test" }, { hypothesisId: e!.hypothesis_id, reviewerKind: "human", reviewerId: "owner-test", mode: "disclosed_adjudication", reviewerSaw: saw, inputSha256: "c".repeat(64), verdict: "supports", rationale: "test adjudication on a synthetic fixture" });
    const outcome = await recordHumanOutcome(db.pool, { hypothesisId: e!.hypothesis_id, category: "confirmed", decidedBy: "owner-test", rationale: "reproduced by the pinned evaluator and adjudicated (synthetic fixture)", basisEvaluationIds: [e!.id], basisReviewId: review });
    expect(outcome).toMatch(/^[0-9a-f-]{36}$/);
    expect((await trackRecords(db.pool)).find((r) => r.humanOutcomes["confirmed"])!.adjudicated).toBe(1);
  });

  it("outcome mapping is fixed: a failing test, a non-deterministic test and a refutation never count as support; a producer never writes its own test", async () => {
    const [d] = await q<{ id: string }>("SELECT id FROM research_decisions LIMIT 1");
    // structural-specialist claims in runs that had no reproduction round (one hypothesis from each of five different runs)
    const free = await q<{ id: string; generator_id: string }>(`SELECT DISTINCT ON (h.workflow_run_id) h.id, h.generator_id FROM hypotheses h JOIN workflow_runs r ON r.id = h.workflow_run_id
      WHERE r.status = 'succeeded' AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.workflow_run_id = h.workflow_run_id AND s.step_key = 'specialist_reproduce') ORDER BY h.workflow_run_id, h.id LIMIT 3`);
    expect(free.length).toBe(3);
    const tf = f("RewardPool.t.sol");
    const append = async (h: { id: string }, authorId = "claude-reproducer") => {
      const c = await db.pool.connect();
      try { await c.query("BEGIN"); const r = await appendReproductionIn(c, { decisionId: d!.id, hypothesisIds: [h.id], author: { id: authorId, version: "1" }, evaluator: { id: "foundry-forge", version: "1.5.1" } }, "test"); await c.query("COMMIT"); return r.runId; }
      catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    };
    const runOne = async (h: { id: string }, forge: string, intent: string) => {
      const runId = await append(h);
      const imp = await exec(["import-test", "--run", runId, "--file", file(`v-${h.id}.json`, { tests: [{ claim: "C01", files: tf, matchTest: "test_freshStakerStealsPastRewards", intent, demonstrates: "x demo" }] }), ...OP]); expect(imp.code, imp.text).toBe(EXIT.ok);
      env["AGENTSMITH_FORGE_BIN"] = forge; try { expect((await exec(["run-assignment", "--run", runId])).code).toBe(EXIT.ok); } finally { env["AGENTSMITH_FORGE_BIN"] = real?.forge ?? t.forge("pass"); }
      return (await q<{ outcome: string; rationale: string }>("SELECT outcome, rationale FROM hypothesis_evaluations WHERE hypothesis_id = $1 AND evaluator_id = 'foundry-forge'", [h.id]))[0]!;
    };
    expect(await runOne(free[0]!, t.forge("fail"), "demonstrate")).toMatchObject({ outcome: "inconclusive", rationale: expect.stringMatching(/failing test is not a refutation/) });
    expect(await runOne(free[1]!, t.forge("flaky"), "demonstrate")).toMatchObject({ outcome: "inconclusive", rationale: expect.stringMatching(/non_deterministic/) });
    expect(await runOne(free[2]!, t.forge("pass"), "refute")).toMatchObject({ outcome: "weakens", rationale: expect.stringMatching(/cannot prove impossibility/) });
    // one round per run: a second round on the same run is refused
    await expect(append(free[0]!)).rejects.toThrow(/already had its reproduction round/);
    // the producer can never be the test author (refused when the round is appended, and again at import)
    const [h4] = await q<{ id: string; generator_id: string }>("SELECT id, generator_id FROM hypotheses WHERE id = $1", [free[0]!.id]);
    await expect(append(h4!, h4!.generator_id)).rejects.toThrow(/never validates its own claim/);
    void importTest;
    // a dry run of a validation starts nothing; every claim in a round must be answered
    const [open] = await q<{ workflow_run_id: string }>("SELECT workflow_run_id FROM workflow_steps WHERE step_key = 'foundry_validate' LIMIT 1");
    expect((await cli(["run-assignment", "--run", open!.workflow_run_id])).code).toBe(EXIT.ok);
  });
});
