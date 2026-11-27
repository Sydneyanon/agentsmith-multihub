import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { ATTENDED_CHALLENGE_STEP_KEY, ATTENDED_STEP_KEY, availability, CAPABILITIES, pinnedVersion, producers } from "../engine/capabilities.js";
import { EXIT, runCli, type CliIo } from "../engine/cli.js";
import { recordHumanOutcome } from "../engine/loop.js";
import { ResearchStore } from "../research-state.js";
import { intakeStepKeys } from "../worker-runtime.js";
import { applyDrafts } from "./drafts.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
/** The specialist probe (eval/dev/specialist-probe): a synthetic fixture with a pre-registered answer key, and the REAL outputs of the
 *  Claude Code sub-agents run on it in an attended session on 2026-11-27. The test replays those recorded outputs through the engine. */
const PROBE = join(__dirname, "..", "..", "..", "..", "eval", "dev", "specialist-probe");
const recorded = (n: string) => JSON.parse(readFileSync(join(PROBE, "outputs", `${n}.json`), "utf8")) as Record<string, unknown>;
const OUTPUT_FOR: Record<string, string> = { "claude-scoping": "scope", "claude-accounting": "accounting", "claude-path": "paths", "claude-assumptions": "assumptions", "claude-liveness": "liveness" };
const OP = ["--operator", "owner-test"]; const ENV = { AGENTSMITH_ATTENDED_OPERATOR: "owner-test" };

describe("attended specialist capabilities: declarations (no database)", () => {
  it("every capability has a full profile; attended ones are interactive-only, prompt-pinned and never claimable by a worker", () => {
    for (const c of CAPABILITIES) {
      const p = c.profile;
      for (const k of ["specialisation", "runtime", "availabilityMode", "costNote"] as const) expect(String(p[k]).length, `${c.id}.${k}`).toBeGreaterThan(2);
      expect(p.inputs.length).toBeGreaterThan(0); expect(p.outputs.length).toBeGreaterThan(0); expect(p.limitations.length).toBeGreaterThan(0); expect(p.costUnits).toBeGreaterThan(0);
      if (p.runtime === "attended_session") {
        expect(p.availabilityMode).toBe("interactive_only"); expect(pinnedVersion(c)).toMatch(/^\d+\+prompt-[a-f0-9]{12}$/); expect(p.method).toMatch(/do not write step-by-step exploit instructions/);
      }
    }
    const all = intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", ENGINE_LOOP_ENABLED: "true" });
    expect(all).not.toContain(ATTENDED_STEP_KEY); expect(all).not.toContain(ATTENDED_CHALLENGE_STEP_KEY);
    expect(producers({}).map((c) => c.id)).toEqual(["solidity-structural-specialists"]); // no operator: no attended specialist is ever assigned
    expect(producers(ENV).map((c) => c.id)).toEqual(["solidity-structural-specialists", "claude-scoping", "claude-accounting", "claude-path", "claude-assumptions", "claude-liveness"]);
    expect(availability({}).find((a) => a.capability.id === "claude-challenger")!.reason).toMatch(/AGENTSMITH_ATTENDED_OPERATOR/);
  });
});

describe.skipIf(skipIntegration)("attended specialists through the research loop (recorded real outputs, throwaway database)", () => {
  let db: TestDatabase; let fx: GitFixture; let dir: string; let lines: string[] = [];
  const io: CliIo = { out: (l) => lines.push(l), err: (l) => lines.push(l), env: ENV, sourceFactory: () => new FakeSource(fx) };
  const cli = async (args: string[]) => { lines = []; const code = await runCli([...args, "--database-url", db.url], io); return { code, text: lines.join("\n") }; };
  const exec = (args: string[]) => cli([...args, "--execute", "--confirm", db.name]);
  const json = async (args: string[]) => { const r = await exec([...args, "--json"]); expect(r.code, r.text).toBe(EXIT.ok); return JSON.parse(r.text) as Record<string, unknown>; };
  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.ownerPool.query(sql, p)).rows as T[];
  const file = (name: string, body: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(body)); return f; };
  const assigned: string[] = [];

  beforeAll(async () => {
    assertIntegrationConfigured(); db = await migratedTestDatabase(); await applyDrafts(db);
    fx = buildGitFixture(readdirSync(join(PROBE, "src")).sort().map((n) => ({ path: `src/${n}`, content: readFileSync(join(PROBE, "src", n), "utf8") })), { owner: "probe", repo: "defi" });
    dir = mkdtempSync(join(tmpdir(), "attended-"));
    const opp = String((await json(["register", "--file", file("opp.json", { source: { key: "board", displayName: "Board (manual)" }, canonicalKey: "board:probe", platform: "community", title: "Probe", referenceUrl: "https://example.org/probe", claims: { repositories: ["probe/defi"] } }), ...OP])).id);
    for (const [check, subject] of [["program_official", "probe"], ["repository_official", "probe/defi"], ["scope_includes_repository", "probe/defi"], ["eligibility", "probe"]]) await exec(["verify", "--opportunity", opp, "--check", check!, "--subject", subject!, "--verdict", "verified", "--method", "m", "--evidence-url", "https://example.org/x", ...OP]);
    const rank = await json(["rank"]); const sel = await json(["select", "--opportunity", opp, "--repository", "probe/defi", "--basis", String(rank.decisionId), ...OP]);
    expect((await exec(["run-assignment", "--run", String(sel.acquisitionRunId), "--allow-network"])).code).toBe(EXIT.ok);
  });
  afterAll(async () => { fx?.cleanup(); rmSync(dir, { recursive: true, force: true }); await db?.drop(); });

  /** what an operator does for an attended step: read the brief, export the snapshot, run the specialist (here: its recorded output), import */
  const attend = async (run: string) => {
    const b = JSON.parse((await cli(["brief", "--run", run, "--json"])).text) as { capability: { id: string; version: string }; method: string; claims?: Array<{ id: string; claim: string }>; targets?: unknown[] };
    expect(b.method.length).toBeGreaterThan(50); expect(b.capability.version).toMatch(/\+prompt-/);
    assigned.push(b.capability.id);
    if (b.capability.id === "claude-challenger") {
      // the brief is blinded: no producer identity anywhere in what the challenger sees
      expect(JSON.stringify(b.claims)).not.toMatch(/claude-(accounting|path|assumptions|liveness|scoping)@|generator/);
      const input = recorded("challenge-input") as { claims: Array<{ id: string; title: string }> }; const verdicts = recorded("challenge") as { reviews: Array<{ claim: string }> };
      const reviews = b.claims!.flatMap((c) => { const src = input.claims.find((x) => c.claim.startsWith(x.title)); const v = src && verdicts.reviews.find((r) => r.claim === src.id); return v ? [{ ...v, claim: c.id }] : []; });
      const r = await exec(["import-challenge", "--run", run, "--file", file(`chal-${run}.json`, { specialist: "challenger", reviews }), ...OP, "--tokens", "93924", "--duration-ms", "165614"]);
      expect(r.code, r.text).toBe(EXIT.ok);
    } else {
      const out = join(dir, `snap-${run}`);
      expect((await cli(["export-snapshot", "--run", run, "--dir", out])).text).toMatch(/would write 6 hash-checked files.*nothing written/);
      expect((await exec(["export-snapshot", "--run", run, "--dir", out])).code).toBe(EXIT.ok);
      expect(readFileSync(join(out, "src", "ShareVault.sol"), "utf8")).toBe(readFileSync(join(PROBE, "src", "ShareVault.sol"), "utf8"));
      const r = await exec(["import-specialist", "--run", run, "--file", join(PROBE, "outputs", `${OUTPUT_FOR[b.capability.id]}.json`), ...OP, "--tokens", "80000", "--duration-ms", "100000"]);
      expect(r.code, r.text).toBe(EXIT.ok);
    }
  };
  /** follow `next`, doing what each actor would do; humans are not simulated */
  const drive = async () => {
    const trail: string[] = [];
    for (let i = 0; i < 150; i++) {
      const actions = JSON.parse((await cli(["next", "--json"])).text) as Array<{ command: string; who: string }>;
      trail.push(actions.map((a) => `${a.who}:${a.command.slice(0, 60)}`).join(" | "));
      const att = actions.find((x) => x.who === "attended");
      if (att) { await attend(att.command.split(" ")[2]!); continue; }
      const step = actions.find((x) => x.who !== "human" && x.command !== "rank"); if (!step) return;
      const r = await exec([...step.command.split(" "), ...(step.command.startsWith("run-assignment") ? ["--allow-network"] : [])]);
      expect(r.code, `${step.command}\n${r.text}`).toBe(EXIT.ok);
    }
    throw new Error(`the loop did not settle: assigned ${assigned.join(",")}; last: ${trail.slice(-4).join(" || ")}`);
  };

  it("the mapper goes first; AgentSmith then chooses each specialist by recorded value, and import keeps control of what enters memory", async () => {
    const acq = String((await q<{ id: string }>("SELECT id FROM workflow_runs ORDER BY created_at LIMIT 1"))[0]!.id);
    const m = await json(["map", "--run", acq]);
    expect((m.assignment as { capability: string }).capability).toBe("claude-scoping@1"); // an unmapped snapshot is scoped before anyone hunts
    const run = (m.assignment as { runId: string }).runId;
    expect((await exec(["run-assignment", "--run", run, "--allow-network"])).text).toMatch(/waiting for an attended specialist \(specialist_review\)/);
    // a worker can never run it, and an import is checked: a finding that does not anchor to the sealed code is rejected, not stored
    const bad = recorded("scope") as { findings: Array<{ locations: Array<{ line_start: number; line_end: number }> }> };
    const doctored = { ...bad, findings: bad.findings.map((f, i) => (i === 0 ? { ...f, locations: [{ file: "src/ShareVault.sol", line_start: 900, line_end: 901 }] } : f)) };
    const dry = await cli(["import-specialist", "--run", run, "--file", file("doctored.json", doctored), ...OP]);
    expect(dry.text).toMatch(/rejected \{"unanchored":1/); expect(dry.text).toMatch(/DRY RUN/);
    expect((await q("SELECT 1 FROM hypotheses WHERE generator_kind = 'attended_model'")).length).toBe(0);
    expect((await exec(["import-specialist", "--run", run, "--file", file("noop.json", { specialist: "x", findings: [] })])).code).toBe(EXIT.usage); // no operator
    await attend(run);
    expect((await exec(["import-specialist", "--run", run, "--file", join(PROBE, "outputs", "scope.json"), ...OP])).text).toMatch(/accepted once/); // never twice
    await exec(["run-assignment", "--run", run, "--allow-network"]); await exec(["ingest", "--run", run]);
    const f = await json(["map", "--run", run, "--follow-up"]);
    const [c] = await q<{ features: { capability_values: { value: Array<{ capability: string; value: number }> }; surface_rank: { value: number | null } }; score_components: { contributions: Array<{ feature: string; points: number }> } }>(
      "SELECT features, score_components FROM research_decision_candidates WHERE decision_id = $1 AND selected AND candidate_kind = 'component' LIMIT 1", [f.decisionId]);
    const values = c!.features.capability_values.value;
    expect(values.map((v) => v.capability)).toEqual(expect.arrayContaining(["solidity-structural-specialists@1", "claude-accounting@1"]));
    const best = [...values].sort((x, y) => y.value - x.value)[0]!;
    expect((f.assignment as { capability: string }).capability).toBe(best.capability); // the chosen specialist is the highest recorded value
    expect(c!.score_components.contributions.find((k) => k.feature === "specialist-surface")!.points).toBeGreaterThan(0); // the scoping map now steers targets
  });

  it("the loop assigns every specialist, challenges every model claim blindly, and sends only challenged claims to a human", async () => {
    await drive();
    for (const id of ["claude-accounting", "claude-path", "claude-assumptions", "claude-liveness", "claude-challenger"]) expect(assigned, id).toContain(id);
    const claims = await q<{ generator_id: string; generator_version: string; n: string }>("SELECT generator_id, generator_version, count(*) n FROM hypotheses WHERE generator_kind = 'attended_model' GROUP BY 1, 2 ORDER BY 1");
    expect(claims.length).toBe(5); for (const c of claims) expect(c.generator_version).toMatch(/\+prompt-[a-f0-9]{12}$/);
    // plane 2 stays technical: models never write evaluations; plane 2.5 (reviews) are blinded and never by the producer
    expect((await q("SELECT 1 FROM hypothesis_evaluations e JOIN hypotheses h ON h.id = e.hypothesis_id WHERE h.generator_kind = 'attended_model' AND e.evaluator_id LIKE 'claude-%'")).length).toBe(0);
    const reviews = await q<{ reviewer_kind: string; reviewer_id: string; review_mode: string; generator_id: string }>("SELECT r.reviewer_kind, r.reviewer_id, r.review_mode, h.generator_id FROM hypothesis_reviews r JOIN hypotheses h ON h.id = r.hypothesis_id");
    expect(reviews.length).toBeGreaterThan(5);
    for (const r of reviews) { expect(r).toMatchObject({ reviewer_kind: "attended_model", reviewer_id: "claude-challenger", review_mode: "blinded_independent_assessment" }); expect(r.reviewer_id).not.toBe(r.generator_id); }
    // every attended claim was put to the challenger exactly once
    const unchallenged = await q("SELECT h.id FROM hypotheses h WHERE h.generator_kind = 'attended_model' AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.step_key = $1 AND s.input->'claims' @> jsonb_build_array(jsonb_build_object('hypothesisId', h.id::text)))", [ATTENDED_CHALLENGE_STEP_KEY]);
    expect(unchallenged).toEqual([]);
    // the next human action: review of claims the challenger supported, never a claim straight from its producer
    const asked = await q<{ ref: string }>("SELECT DISTINCT candidate_ref ref FROM research_decision_candidates WHERE action = 'request_human_review'");
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) expect((await q("SELECT 1 FROM hypothesis_reviews WHERE hypothesis_id = $1 AND verdict = 'supports' UNION ALL SELECT 1 FROM hypothesis_evaluations WHERE hypothesis_id = $1 AND outcome = 'supports'", [a.ref])).length).toBeGreaterThan(0);
    // effort is memory: every attended assignment has its operator-reported duration
    expect((await q<{ n: string }>("SELECT count(*) n FROM research_effort WHERE method LIKE 'claude-%' AND wall_ms > 0"))[0]!.n).not.toBe("0");
  });

  it("no specialist can confirm a finding: self-review and model evidence are refused, and 'confirmed' needs technical evidence and a human", async () => {
    const [h] = await q<{ id: string; generator_id: string; workflow_run_id: string; produced_by_step_id: string }>("SELECT id, generator_id, workflow_run_id, produced_by_step_id FROM hypotheses WHERE generator_kind = 'attended_model' AND family LIKE 'claude-accounting-%' LIMIT 1");
    const store = new ResearchStore(db.pool);
    const saw = { claim: true, evidence_spans: true, generator_rationale: false, generator_identity: false, prior_evaluations: false, prior_reviews: false };
    await expect(db.ownerPool.query(`INSERT INTO hypothesis_reviews (workflow_run_id, hypothesis_id, reviewer_kind, reviewer_id, review_mode, reviewer_saw, input_sha256, verdict, rationale, model_provider, model_name, model_prompt_version)
      VALUES ($1,$2,'attended_model',$3,'blinded_independent_assessment',$4::jsonb,$5,'supports','self',  'anthropic','claude-code-subagent','1+prompt-0123456789ab')`, [h!.workflow_run_id, h!.id, h!.generator_id, JSON.stringify(saw), "a".repeat(64)])).rejects.toThrow(/cannot review its own claim/);
    await expect(db.ownerPool.query("INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256, actor_kind) VALUES ($1,$2,$3,'claude-challenger','1','supports','x',$4,'attended_model')", [h!.workflow_run_id, h!.id, h!.produced_by_step_id, "a".repeat(64)])).rejects.toThrow(/check/);
    const review = await store.recordReview({ kind: "operator", operatorId: "owner-test" }, { hypothesisId: h!.id, reviewerKind: "human", reviewerId: "owner-test", mode: "disclosed_adjudication", reviewerSaw: { ...saw, generator_rationale: true, generator_identity: true, prior_evaluations: true, prior_reviews: true }, inputSha256: "b".repeat(64), verdict: "supports", rationale: "test: human agrees" });
    await expect(recordHumanOutcome(db.pool, { hypothesisId: h!.id, category: "confirmed", decidedBy: "owner-test", rationale: "a model and a human agree, but nothing was executed", basisReviewId: review })).rejects.toThrow(/independent of the generator/);
  });

  it("comparison: who found what, independently, and who examined a target without finding it", async () => {
    const snap = String((await q<{ id: string }>("SELECT id FROM repo_snapshots ORDER BY created_at LIMIT 1"))[0]!.id);
    const c = JSON.parse((await cli(["compare", "--snapshot", snap, "--json"])).text) as { clusters: Array<{ contract: string; function: string; class: string; foundBy: Array<{ capability: string }>; examinedNotFoundBy: string[] }>; capabilities: Record<string, { leads: number }> };
    const withdraw = c.clusters.find((x) => x.contract === "ShareVault" && x.function === "withdraw" && x.class === "arithmetic-precision")!;
    expect(withdraw.foundBy.length).toBeGreaterThanOrEqual(2); // independent rediscovery by different methods
    const setPair = c.clusters.filter((x) => x.contract === "LendingPool" && x.function === "setPair");
    expect(setPair.flatMap((x) => x.foundBy.map((f) => f.capability))).toEqual(expect.arrayContaining(["solidity-structural-specialists"])); // the deterministic analyzer found S5 too
    expect(c.clusters.some((x) => x.examinedNotFoundBy.length > 0)).toBe(true); // candidate misses are visible per capability
    expect(Object.keys(c.capabilities)).toEqual(expect.arrayContaining(["claude-accounting", "solidity-structural-specialists"]));
  });
});
