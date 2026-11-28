import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYSIS_IDENTITIES, evaluationRelation, generatorFamily } from "../analysis-identity.js";
import { UNSUPPORTED_FEATURES } from "./engine/fidelity.js";
import { computeApexShadow, UNVALIDATED, type ShadowResult } from "./shadow.js";
import { shadowResultSchema } from "./shadow-record.js";
import { APEX_SHADOW_TARGET } from "./shadow-target.js";
import { usxLikeSources } from "./testing/usx-like.js";

/**
 * The shadow computation on the SELF-AUTHORED USX-like snapshot (apex/testing/usx-like/: the shapes of the scope, not USX's source).
 * These tests show the mechanism only: what is recorded and that nothing is guessed. They say nothing about detection quality.
 */
const scope = APEX_SHADOW_TARGET.inScopePaths;
let cached: ShadowResult | null = null;
const shadow = () => (cached ??= computeApexShadow({ sources: usxLikeSources(), inScopePaths: scope }));
const withoutCost = (r: ShadowResult) => JSON.parse(JSON.stringify({ ...r, cost: null, contracts: r.contracts.map((c) => ({ ...c, cost: { ...c.cost, wall_ms: 0 } })) }));

describe("APEX shadow computation on the USX-like snapshot (measurement only)", () => {
  it("analyses ONLY the 20 in-scope files, whatever else the snapshot holds, and records each file's digest", () => {
    const r = shadow();
    expect(usxLikeSources().some((s) => !scope.includes(s.path))).toBe(true); // the snapshot holds out-of-scope Solidity (src/cloak, test, script)
    expect(r.input_files.map((f) => f.path).sort()).toEqual([...scope].sort());
    for (const f of r.input_files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.contracts.map((c) => c.contract)).not.toContain("USXRebalancer"); // out of scope, although APEX could model it
    expect([...r.contracts, ...r.not_deployable].every((c) => scope.includes(c.file))).toBe(true);
    expect(r.in_scope_paths_missing).toEqual([]);
    expect(shadowResultSchema.safeParse(r).success).toBe(true);
  }, 120_000);

  it("every unsupported feature is an explicit abstention with file, line and feature; such a region yields no claim", () => {
    const r = shadow();
    expect(r.abstentions.length).toBeGreaterThan(0);
    for (const a of r.abstentions) {
      expect(scope).toContain(a.file); expect(Number.isInteger(a.line)).toBe(true); expect(UNSUPPORTED_FEATURES as readonly string[]).toContain(a.feature);
      expect(a.at).toBe(`${a.file}:${a.line}`); expect(a.why.length).toBeGreaterThan(0);
    }
    const at = (x: string) => r.abstentions.filter((a) => `${a.contract}.${a.function} ${a.feature}@${a.at}` === x);
    expect(at("StakedUSXOFT.burnToBridge external-call@src/oft/StakedUSXOFT.sol:26")).toHaveLength(1);
    expect(at("StakedUSXOFT.lzReceive array@src/oft/StakedUSXOFT.sol:17")).toHaveLength(1);
    expect(at("RewardDistributorFacet.distribute other-contract@src/facets/RewardDistributorFacet.sol:13")).toHaveLength(1);
    // the diamond's fallback reads msg.sig before its delegatecall: recorded as the interpreter classifies it, never guessed further
    expect(r.abstentions.some((a) => a.contract === "TreasuryDiamond" && a.function === "fallback" && a.file === "src/TreasuryDiamond.sol")).toBe(true);
    // constructors taking contract-typed parameters cannot be deployed: abstained, located at the constructor's definition, and said so
    const dep = r.abstentions.filter((a) => a.phase === "deployment");
    expect(dep.map((a) => a.contract).sort()).toEqual(r.contracts.filter((c) => c.status === "abstained_at_deployment").map((c) => c.contract).sort());
    for (const a of dep) expect(a.located_by).toBe("definition");
    const abstainedContracts = new Set(r.contracts.filter((c) => c.status !== "explored").map((c) => c.contract));
    expect(r.would_be_hypotheses.filter((h) => abstainedContracts.has(h.contract))).toEqual([]);
    expect(Object.values(r.abstentions_by_feature).reduce((a, b) => a + b, 0)).toBe(r.abstentions.length);
  }, 120_000);

  it("an injected unsupported feature on a breaking path is an abstention at its line, never a claim", () => {
    const inj = usxLikeSources().filter((s) => scope.includes(s.path)).map((s) => s.path !== "src/mocks/MockAssetManager.sol" ? s
      : { ...s, text: s.text.replace("        totalManaged -= amount;\n    }\n}", "        require(block.timestamp > 0, \"time\");\n        totalManaged -= amount;\n    }\n}") });
    const r = computeApexShadow({ sources: inj, inScopePaths: scope });
    const line = inj.find((s) => s.path === "src/mocks/MockAssetManager.sol")!.text.split("\n").findIndex((l) => l.includes("block.timestamp")) + 1;
    expect(r.abstentions).toContainEqual(expect.objectContaining({ contract: "MockAssetManager", function: "sweep", feature: "block", file: "src/mocks/MockAssetManager.sol", line }));
    expect(r.would_be_hypotheses.filter((h) => h.contract === "MockAssetManager" && h.breaking_function === "sweep")).toEqual([]);
  }, 120_000);

  it("an approximation-dependent counterexample is SUPPRESSED (counted per kind, withheld), never a claim", () => {
    const r = shadow();
    expect(r.suppressions.total).toBeGreaterThan(0);
    expect(Object.keys(r.suppressions.by_kind)).toEqual(["narrow-integer"]);
    expect(r.suppressions.examples.every((x) => x.contract === "BridgedToken" && x.approximations.every((a) => a.kind === "narrow-integer" && a.file === "src/BridgedToken.sol" && Number.isInteger(a.line)))).toBe(true);
    expect(r.withheld).toContainEqual({ contract: "BridgedToken", candidate: "conservation:totalSupply=sum(balanceOf)", why: "only-suppressed-counterexamples", kinds: ["narrow-integer"] });
    expect(r.would_be_hypotheses.filter((h) => h.contract === "BridgedToken")).toEqual([]);
  }, 120_000);

  it("records ALL candidates with a decision, a rule and a reason, rejected ones included; would-be claims are labelled unvalidated", () => {
    const r = shadow();
    expect(r.candidates.filter((c) => c.decision === "rejected").length).toBeGreaterThan(0);
    expect(r.candidates.filter((c) => c.decision === "accepted").length).toBeGreaterThan(0);
    for (const c of r.candidates) { expect(c.reason.length).toBeGreaterThan(0); expect(c.rule.length).toBeGreaterThan(0); }
    expect(r.invariant_decisions).toEqual(r.candidates.map((c) => ({ contract: c.contract, candidate: c.id, decision: c.decision, rule: c.rule, reason: c.reason })));
    expect(r.would_be_hypotheses.length).toBeGreaterThan(0);
    for (const h of r.would_be_hypotheses) { expect(h.label).toBe(UNVALIDATED); expect(h.fidelity).toEqual({ fully_modelled: true, approximations_on_path: 0 }); expect(h.counterexample.length).toBeGreaterThan(0); }
  }, 120_000);

  it("coverage carries explicit numerators and denominators (dropped frontier states included) and the cost is recorded", () => {
    const r = shadow();
    for (const m of Object.values(r.coverage)) { expect(m.numerator).toBeLessThanOrEqual(m.denominator); expect(m.meaning.length).toBeGreaterThan(10); }
    expect(r.coverage.in_scope_files.denominator).toBe(20);
    expect(r.coverage.contracts_explored.denominator).toBe(r.contracts.length);
    expect(r.coverage.frontier_dropped.numerator).toBe(r.contracts.reduce((s, c) => s + (c.honest?.frontier_dropped ?? 0) + (c.adversarial?.frontier_dropped ?? 0), 0));
    expect(r.cost.transitions_requested).toBe(r.contracts.reduce((s, c) => s + c.cost.requested, 0));
    expect(r.cost.transitions_interpreted).toBeLessThanOrEqual(r.cost.transitions_requested);
    expect(r.cost.heap_used_bytes).toBeGreaterThan(0);
    expect(r.engine).toMatchObject({ generator: "apex-state-explorer@0-prototype", strategy: "deep", options: { quality: "defaults", minimise: true, memo: true } });
  }, 120_000);

  it("is deterministic (nothing is sampled or guessed): the same input gives the same record, cost aside", () => {
    expect(withoutCost(computeApexShadow({ sources: usxLikeSources(), inScopePaths: scope }))).toEqual(withoutCost(shadow()));
  }, 120_000);

  it("the transition budget bounds the stage: contracts that do not fit are recorded as not started, with the reason", () => {
    const r = computeApexShadow({ sources: usxLikeSources(), inScopePaths: scope, limits: { maxTransitions: 15_000 } });
    const skipped = r.contracts.filter((c) => c.status === "skipped_transition_budget");
    expect(skipped.length).toBeGreaterThan(0);
    for (const c of skipped) expect(c.reason).toMatch(/not started: \d+ of 15000 transitions already requested/);
    const time = computeApexShadow({ sources: usxLikeSources(), inScopePaths: scope, limits: { softWallMs: 0 } });
    expect(time.contracts.every((c) => c.status === "skipped_time_budget")).toBe(true);
    expect(time.coverage.contracts_explored.numerator).toBe(0);
  }, 120_000);
});

describe("APEX shadow output can never be evidence", () => {
  const here = join(__dirname);
  const src = ["shadow.ts", "shadow-step.ts", "shadow-record.ts", "shadow-target.ts"].map((f) => readFileSync(join(here, f), "utf8")).join("\n");
  it("the shadow modules call no research-store write and insert into no table but audit_events", () => {
    for (const w of ["createHypothesis", "recordEvaluation", "recordReview", "createEvidenceSpan", "putBlob", "createSnapshot", "addSnapshotFiles", "sealSnapshot", "withdraw("]) expect(src, w).not.toContain(w);
    const inserts = [...src.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]);
    expect(inserts).toEqual(["audit_events"]);
    expect(src).not.toMatch(/\b(UPDATE|DELETE FROM)\s+\w+/);
  });
  it("APEX is no analysis identity: it can be neither a listed generator nor an evaluator, so it can never count as independent support", () => {
    expect(ANALYSIS_IDENTITIES.some((x) => /apex/i.test(x.id))).toBe(false);
    expect(generatorFamily({ kind: "deterministic_rule", id: "apex-state-explorer" })).toBeNull();
    expect(evaluationRelation({ kind: "deterministic_rule", id: "solidity-structural-specialists" }, "apex-state-explorer")).toBe("unknown-family");
    expect(evaluationRelation({ kind: "deterministic_rule", id: "apex-state-explorer" }, "apex-state-explorer")).toBe("unknown-family");
  });
});
