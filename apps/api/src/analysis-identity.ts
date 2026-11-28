/**
 * Who produced a claim and who evaluated it, by ANALYSIS FAMILY (the substrate whose errors they share) and METHOD.
 *
 * Independence is a property of the family, not of the id: the structural specialists and the execution validators have different ids
 * and different methods (pattern rules over traces vs bounded execution of a modelled contract), but both read the code through the same
 * AgentSmith Solidity parser and index, so a parser misreading is shared by both. Their agreement is corroboration within one family,
 * never independent confirmation. Slither reads its own IR (slither-ir); Foundry compiles with solc and executes EVM bytecode
 * (evm-execution).
 *
 * This list is mirrored, row for row, by the seed of the R3 draft migration (db/drafts/r3-evaluator-independence); a unit test keeps
 * them equal. An id that is not listed has an UNKNOWN family and never counts as independent.
 */
export type AnalysisRole = "generator" | "evaluator" | "abstention";
export type AnalysisIdentity = { id: string; role: AnalysisRole; analysisFamily: string; method: string };

export const PARSER_FAMILY = "agentsmith-solidity-parser";
const exec = (id: string): AnalysisIdentity => ({ id, role: "evaluator", analysisFamily: PARSER_FAMILY, method: "bounded-execution" });
const attended = (id: string): AnalysisIdentity => ({ id, role: "generator", analysisFamily: "claude-model", method: "attended-model-reading" });

export const ANALYSIS_IDENTITIES: readonly AnalysisIdentity[] = [
  { id: "solidity-structural-specialists", role: "generator", analysisFamily: PARSER_FAMILY, method: "structural-pattern-rules" },
  { id: "slither", role: "generator", analysisFamily: "slither-ir", method: "static-detectors" },
  ...["claude-scoping", "claude-accounting", "claude-path", "claude-assumptions", "claude-liveness", "claude-hunter"].map(attended),
  exec("reentrancy-execution-validator"),
  ...["access-control", "selfdestruct", "delegatecall", "initializer", "unchecked-call"].map((c) => exec(`execution-challenge-${c}`)),
  { id: "foundry-forge", role: "evaluator", analysisFamily: "evm-execution", method: "compiled-test-execution" },
  { id: "no-independent-validator", role: "abstention", analysisFamily: "none", method: "abstention" },
];

const byId = new Map(ANALYSIS_IDENTITIES.map((x) => [x.id, x]));
export function analysisIdentity(id: string): AnalysisIdentity | null { return byId.get(id) ?? null; }

/** The family of a claim's generator: listed generators by id; a human generator is the `human` family; anything else is unknown (null). */
export function generatorFamily(g: { kind: string; id: string }): string | null {
  const x = byId.get(g.id);
  if (x && x.role === "generator") return x.analysisFamily;
  return g.kind === "human" ? "human" : null;
}

/**
 * How an evaluation relates to the claim it evaluates. Only `cross-family` can count toward independent confirmation; `same-family`
 * agreement is corroboration by the same substrate; `unknown-family` (an unlisted evaluator or generator) never counts.
 */
export type EvaluationRelation = "cross-family" | "same-family" | "unknown-family" | "abstention";
export function evaluationRelation(generator: { kind: string; id: string }, evaluatorId: string): EvaluationRelation {
  const e = byId.get(evaluatorId);
  if (e?.role === "abstention") return "abstention";
  const gf = generatorFamily(generator);
  if (!e || e.role !== "evaluator" || gf === null) return "unknown-family";
  return e.analysisFamily === gf ? "same-family" : "cross-family";
}
