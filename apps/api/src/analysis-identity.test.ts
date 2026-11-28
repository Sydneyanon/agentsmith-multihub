import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYSIS_IDENTITIES, analysisIdentity, evaluationRelation, PARSER_FAMILY } from "./analysis-identity.js";
import { CAPABILITIES } from "./engine/capabilities.js";
import { SPECIALIST_ID, VALIDATOR_ID } from "./analysis/solidity/pipeline.js";

const seed = readFileSync(join(__dirname, "..", "..", "..", "db", "drafts", "r3-evaluator-independence", "0015_evaluator_independence.sql"), "utf8");

describe("analysis identities (generator and evaluator families)", () => {
  it("the R3 draft's seed equals the code registry row for row", () => {
    const block = seed.slice(seed.indexOf("INSERT INTO analysis_identities"), seed.indexOf(";", seed.indexOf("INSERT INTO analysis_identities")));
    const rows = [...block.matchAll(/\('([^']+)', '([^']+)', '([^']+)', '([^']+)'\)/g)].map((m) => ({ id: m[1], role: m[2], analysisFamily: m[3], method: m[4] }));
    expect(rows).toEqual(ANALYSIS_IDENTITIES.map((x) => ({ ...x })));
  });

  it("the specialists and the execution validators share the parser substrate but not the method", () => {
    const g = analysisIdentity(SPECIALIST_ID)!; const v = analysisIdentity(VALIDATOR_ID)!;
    expect(g.analysisFamily).toBe(PARSER_FAMILY); expect(v.analysisFamily).toBe(PARSER_FAMILY); expect(g.method).not.toBe(v.method);
    expect(analysisIdentity("slither")!.analysisFamily).toBe("slither-ir");
    expect(analysisIdentity("foundry-forge")!.analysisFamily).toBe("evm-execution");
  });

  it("classifies agreement: same family is corroboration, a different family is independent, anything unlisted never counts", () => {
    const spec = { kind: "deterministic_rule", id: SPECIALIST_ID };
    expect(evaluationRelation(spec, VALIDATOR_ID)).toBe("same-family");
    expect(evaluationRelation(spec, "execution-challenge-access-control")).toBe("same-family");
    expect(evaluationRelation(spec, "foundry-forge")).toBe("cross-family");
    expect(evaluationRelation({ kind: "deterministic_rule", id: "slither" }, VALIDATOR_ID)).toBe("cross-family");
    expect(evaluationRelation(spec, "no-independent-validator")).toBe("abstention");
    expect(evaluationRelation(spec, "an-unregistered-checker")).toBe("unknown-family");
    expect(evaluationRelation({ kind: "deterministic_rule", id: "rule-x" }, "foundry-forge")).toBe("unknown-family");
    expect(evaluationRelation({ kind: "human", id: "owner" }, VALIDATOR_ID)).toBe("cross-family");
    // a generator id used as an evaluator id is never an independent evaluator
    expect(evaluationRelation({ kind: "deterministic_rule", id: "slither" }, SPECIALIST_ID)).toBe("unknown-family");
  });

  it("every active producer and evaluator capability that writes hypotheses or evaluations has a family", () => {
    for (const c of CAPABILITIES) {
      if (c.status !== "active") continue;
      if (c.kind === "producer") expect(analysisIdentity(c.id)?.role, c.id).toBe("generator");
      if (c.kind === "evaluator" && c.id !== "agentsmith-execution-validators") expect(analysisIdentity(c.id)?.role, c.id).toBe("evaluator");
    }
    // the declared execution-validator capability writes under per-class evaluator ids, all in the parser family
    for (const cls of CAPABILITIES.find((c) => c.id === "agentsmith-execution-validators")!.classes)
      expect(analysisIdentity(cls === "reentrancy" ? VALIDATOR_ID : `execution-challenge-${cls}`)?.analysisFamily, cls).toBe(PARSER_FAMILY);
  });
});
