import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDossier, renderDossierMarkdown, runChallenge, SPECIALIST_ID, SPECIALIST_VERSION } from "../analysis/solidity/pipeline.js";
import type { Finding } from "../analysis/solidity/specialists.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";
import { ResearchFixture } from "./research-helpers.js";

/**
 * Foundations C and D over real Postgres: a lead that an executed counterexample refutes is recorded as `contradicts`, the database view
 * derives `contradicted_by_static_check`, and the dossier shows it plainly as REFUTED with its evidence, separated into origin, supporting
 * and contradicting evidence, validators with their analysis family, reproduction, assessment and uncertainty. Never as "absent".
 */
const A = [
  "// SPDX-License-Identifier: MIT",
  "pragma solidity ^0.8.20;",
  "contract Fees {",
  "  address owner;",
  "  uint fee;",
  "  constructor() { owner = msg.sender; }",
  "  function setFee(uint f) external {",
  "    require(msg.sender == owner);",
  "    fee = f;",
  "  }",
  "  function setOwner(address o) external {",
  "    owner = o;",
  "  }",
  "}",
  "",
].join("\n");
const lead = (fn: string, line: number, claim: string): Finding => ({ class: "access-control", contract: "Fees", function: fn, file: "contracts/Fees.sol", line, claim, rationale: "r", requiredChecks: [], alternatives: [], spans: [], chain: [], assumptions: [], confidence: "medium", detail: {} });

describe.skipIf(skipIntegration)("refuted leads in the research store and the dossier (real Postgres)", () => {
  let db: TestDatabase; let fx: ResearchFixture;
  beforeAll(async () => { assertIntegrationConfigured(); db = await migratedTestDatabase(); fx = new ResearchFixture(db); });
  afterAll(async () => { await db?.drop(); });

  it("records an executed counterexample as contradicts and shows the lead as REFUTED with its evidence", async () => {
    const s = await fx.sealedSnapshot({ "contracts/Fees.sol": A });
    const span9 = await fx.span(s, 9, 9, "contracts/Fees.sol"); const span12 = await fx.span(s, 12, 12, "contracts/Fees.sol");
    const gen = { kind: "deterministic_rule" as const, id: SPECIALIST_ID, version: SPECIALIST_VERSION };
    const refutedClaim = "Fees.setFee changes privileged state with no caller check (test lead)";
    const openClaim = "Fees.setOwner changes the owner with no caller check (test lead)";
    const hRefuted = await fx.hypothesis(s, [span9], { generator: gen, claim: refutedClaim });
    const hOpen = await fx.hypothesis(s, [span12], { generator: gen, claim: openClaim });
    await runChallenge(db.pool, fx.store, s.lease, s.snapshotId, [
      { id: hRefuted, finding: lead("setFee", 9, refutedClaim), spanIds: [span9] },
      { id: hOpen, finding: lead("setOwner", 12, openClaim), spanIds: [span12] },
    ]);
    const ev = (await db.pool.query("SELECT outcome, rationale FROM hypothesis_evaluations WHERE hypothesis_id = $1", [hRefuted])).rows;
    expect(ev.map((e) => e.outcome)).toEqual(["contradicts"]);
    expect(ev[0].rationale).toMatch(/executed counterexample[\s\S]*REVERTS: require failed: msg\.sender == owner[\s\S]*CONTRADICTS the lead in the modelled world/);
    expect((await fx.status(hRefuted)).status).toBe("contradicted_by_static_check");
    // the evaluation cites the lead's primary span (the database requires evidence for a non-inconclusive outcome)
    expect(Number((await db.pool.query("SELECT count(*) n FROM evaluation_evidence ee JOIN hypothesis_evaluations e ON e.id = ee.evaluation_id WHERE e.hypothesis_id = $1", [hRefuted])).rows[0].n)).toBe(1);

    const d = await buildDossier(db.pool, fx.store, s.snapshotId);
    const r = d.entries.find((e) => e.hypothesis_id === hRefuted)!; const o = d.entries.find((e) => e.hypothesis_id === hOpen)!;
    expect(r.origin).toEqual({ generator: `${SPECIALIST_ID}@1`, generator_kind: "deterministic_rule", analysis_family: "agentsmith-solidity-parser", method: "structural-pattern-rules" });
    expect(r.assessment.verdict).toBe("refuted"); expect(r.assessment.text).toMatch(/^REFUTED in the modelled world/);
    expect(r.supporting_evidence).toEqual([]);
    expect(r.contradicting_evidence).toHaveLength(1);
    expect(r.contradicting_evidence[0]).toMatchObject({ evaluator: "execution-challenge-access-control@1", analysis_family: "agentsmith-solidity-parser", relation: "same-family", outcome: "contradicts", cited: [{ path: "contracts/Fees.sol", lines: "9-9" }] });
    expect(r.validators).toEqual([{ evaluator: "execution-challenge-access-control@1", version: "1", analysis_family: "agentsmith-solidity-parser", method: "bounded-execution", relation: "same-family", outcome: "contradicts" }]);
    expect(r.reproduction).toBe("none");
    expect(r.uncertainty.join(" ")).toMatch(/modelled world only/);
    expect(r.uncertainty.join(" ")).toMatch(/shares the generator's analysis family \(agentsmith-solidity-parser\)/);
    // the open lead is supported by the same family only: corroboration, not independent confirmation
    expect(o.assessment.verdict).toBe("corroborated_same_family");
    expect(o.corroboration).toMatchObject({ same_family: 1, cross_family: 0 });

    const md = renderDossierMarkdown(d);
    const section = md.slice(md.indexOf("Fees.setFee - "), md.indexOf("### 2. Fees.setOwner - "));
    expect(section).toMatch(/^Fees\.setFee - [a-z-]+: REFUTED \(executed counterexample\)/);
    expect(section).toMatch(/\*\*Contradicting evidence\.\*\*\n- execution-challenge-access-control@1 \(agentsmith-solidity-parser; the SAME analysis family as the generator\): \*\*contradicts\*\* citing `contracts\/Fees\.sol:9-9`/);
    expect(section).toMatch(/\*\*Supporting evidence\.\*\* none/);
    expect(section).toMatch(/\*\*Reproduction\.\*\* none/);
    expect(section).toMatch(/\*\*Uncertainty and limitations\.\*\*/);
    expect(section).not.toMatch(/absent/i); // a refuted lead is shown as refuted, never as "absent"
    expect(md).toMatch(/Fees\.setOwner - [a-z-]+: CORROBORATED within the same analysis family \(not independent\)/);
    expect(md).toMatch(/Assessments: (?=.*refuted=1)(?=.*corroborated_same_family=1)/);
  });
});
