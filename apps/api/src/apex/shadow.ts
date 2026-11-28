import { createHash } from "node:crypto";
import { ProgramIndex } from "../analysis/solidity/index.js";
import { DEEP_DEFAULTS, exploreDeep, FP_RULE_DEFAULTS } from "./engine/deep-explorer.js";
import { PROTOTYPE_GENERATOR, type ExploreOptions, type ExploreReport, type StepRecord } from "./engine/state-explorer-prototype.js";
import type { Coverage } from "./engine/coverage.js";
import { APEX_SHADOW_LABEL, APEX_SHADOW_VERSION } from "./shadow-target.js";

/**
 * The APEX shadow computation: a PURE function of the in-scope sources of the sealed snapshot. It runs the unchanged APEX engine
 * (`engine/`: the fidelity gate, the deep strategy, the false-positive rules and minimisation exactly as measured in §11.2) on every
 * deployable contract defined in an in-scope file, and turns each report into a JSON-safe MEASUREMENT record: abstentions with file, line
 * and feature; suppressions with their kind; coverage with explicit numerators and denominators (dropped frontier states included); every
 * candidate with its decision and reason; reclassifications with rule and evidence; and what APEX would have claimed, labelled
 * "APEX-generated, unvalidated".
 *
 * Nothing here writes anything, and nothing here is evidence. It runs in a bounded child process (bounded-compute.ts, task `apex_shadow`),
 * never on a worker's or the API's event loop. Unsupported features are recorded as abstentions, never guessed; an engine error on one
 * contract is recorded for that contract and never stops the others.
 */
export const APEX_SHADOW_SCHEMA = "agentsmith-apex-shadow/1";
export const UNVALIDATED = "APEX-generated, unvalidated" as const;

export type ShadowLimits = {
  /** transitions requested across the whole run; allocated per contract before it starts (the engine's per-search budget) */
  maxTransitions: number;
  /** per-search budget given to the deep strategy (its default is 6 000) */
  perSearchBudget: number;
  /** wall time inside the child; a contract is not started after it (the parent's hard limit kills the child anyway) */
  softWallMs: number;
};
export const DEFAULT_SHADOW_LIMITS: ShadowLimits = { maxTransitions: 400_000, perSearchBudget: DEEP_DEFAULTS.budget, softWallMs: 240_000 };
/** Rough upper bound of the transitions one contract requests per unit of per-search budget (two searches, randomised sequences, minimisation). */
const REQUESTS_PER_BUDGET = 3;

export type Loc = { file: string; line: number | null; at: string };
export const locOf = (at: string): Loc => { const i = at.lastIndexOf(":"); const line = i > 0 ? Number(at.slice(i + 1)) : NaN; return Number.isInteger(line) && line > 0 ? { file: at.slice(0, i), line, at } : { file: at, line: null, at }; };
const cap = (s: unknown, n = 500): string => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const seq = (s: readonly StepRecord[]): StepRecord[] => s.slice(0, 40).map((x) => ({ actor: x.actor, call: cap(x.call, 300), value: cap(x.value, 80) }));

/** `located_by`: "interpreter" when the interpreter named the statement; "definition" when it named none (e.g. constructor parameters it cannot supply) and the record points at the definition instead */
export type ShadowAbstention = { contract: string; function: string; feature: string; file: string; line: number | null; at: string; why: string; phase: string; located_by: "interpreter" | "definition" };
export type ShadowSuppression = { contract: string; candidate: string; phase: string; breaking_function: string; sequence: StepRecord[]; approximations: Array<{ kind: string; file: string; line: number | null; at: string; what: string }> };
export type ShadowCandidate = {
  contract: string; id: string; kind: string; statement: string; vars: string[]; decision: "accepted" | "rejected"; rule: string; reason: string;
  maintaining: number; honest_violations: number;
  quality: { support: number; min_support: number; honest_breakers: string[]; depth_extension: string; randomised: string; explained_by: string | null };
};
export type ShadowReclassification = { contract: string; candidate: string; rule: string; breaking_function: string; sequence: StepRecord[]; why: string; evidence: Array<{ function: string; role: string; transfer: string; check: Loc; role_evidence: Loc[] }> };
export type ShadowWouldBe = {
  contract: string; label: typeof UNVALIDATED; generator: string; family: string; claim: string; spans: Array<{ file: string; line: number; role: string }>;
  invariant: string; candidate: string; phase: string; breaking_function: string; reason: string; detail: string;
  counterexample: StepRecord[]; minimised: StepRecord[] | null; fidelity: { fully_modelled: true; approximations_on_path: 0 };
  independent_of_scanners: boolean; prior_leads_on_function: string[];
};
export type ShadowWithheld = { contract: string; candidate: string; why: string; kinds: string[] };
export type SearchCoverage = {
  sequences: number; distinct_states: number; abstract_states: number; depth: number; depth_reached: number; budget_exhausted: boolean; fixpoint: boolean; frontier_dropped: number;
  functions: { total: number; completed: number; never_completed: string[] }; guards: { total: number; both_sides: number; only_passed: number; only_failed: number; never_reached: number };
  statements: { total: number; reached: number }; unexplored: string[]; unexplored_total: number;
};
export type ContractStatus = "explored" | "abstained_at_deployment" | "no_entry_points" | "skipped_transition_budget" | "skipped_time_budget" | "engine_error";
export type ShadowContract = {
  contract: string; file: string; status: ContractStatus; reason: string | null;
  honest: SearchCoverage | null; adversarial: SearchCoverage | null;
  statements: { total: number; reached: number } | null; entry_points: { total: number; completed: number } | null;
  search: { accepting_depth: number; extension_depth: number | null; budget: number; honest_transitions: number; adversarial_transitions: number; random_transitions: number } | null;
  cost: { requested: number; interpreted: number; wall_ms: number };
};
export type ShadowResult = {
  schema: typeof APEX_SHADOW_SCHEMA; label: typeof APEX_SHADOW_LABEL; version: typeof APEX_SHADOW_VERSION;
  engine: { generator: string; strategy: "deep"; options: { depth: number; per_search_budget: number; quality: "defaults"; fp_rules: Record<string, boolean>; minimise: true; memo: true }; limits: ShadowLimits };
  input_files: Array<{ path: string; sha256: string; bytes: number }>;
  in_scope_paths_missing: string[];
  contracts: ShadowContract[];
  not_deployable: Array<{ contract: string; file: string; kind: string }>;
  abstentions: ShadowAbstention[]; abstentions_by_feature: Record<string, number>;
  suppressions: { total: number; by_kind: Record<string, number>; examples: ShadowSuppression[] };
  withheld: ShadowWithheld[];
  candidates: ShadowCandidate[];
  invariant_decisions: Array<{ contract: string; candidate: string; decision: "accepted" | "rejected"; rule: string; reason: string }>;
  reclassified: ShadowReclassification[];
  would_be_hypotheses: ShadowWouldBe[];
  parse_problems: string[];
  coverage: {
    in_scope_files: { numerator: number; denominator: number; meaning: string };
    contracts_explored: { numerator: number; denominator: number; meaning: string };
    entry_points_completed: { numerator: number; denominator: number; meaning: string };
    statements_reached: { numerator: number; denominator: number; meaning: string };
    guard_sides_both: { numerator: number; denominator: number; meaning: string };
    frontier_dropped: { numerator: number; denominator: number; meaning: string };
  };
  cost: { transitions_requested: number; transitions_interpreted: number; wall_ms: number; peak_rss_bytes: number | null; heap_used_bytes: number };
};

function searchCoverage(c: Coverage): SearchCoverage {
  return {
    sequences: c.sequences, distinct_states: c.distinctStates, abstract_states: c.abstractStates, depth: c.depth, depth_reached: c.depthReached, budget_exhausted: c.budgetExhausted, fixpoint: c.fixpoint, frontier_dropped: c.frontierDropped,
    functions: { total: c.functions.length, completed: c.functions.filter((f) => f.completed > 0).length, never_completed: c.functionsNeverCompleted.slice(0, 100).map((x) => cap(x, 200)) },
    guards: { total: c.guardSummary.total, both_sides: c.guardSummary.bothSides, only_passed: c.guardSummary.onlyPassed, only_failed: c.guardSummary.onlyFailed, never_reached: c.guardSummary.neverReached },
    statements: { total: c.statements.total, reached: c.statements.reached }, unexplored: c.unexplored.slice(0, 50).map((x) => cap(x, 300)), unexplored_total: c.unexplored.length,
  };
}

/** The rule that decided a candidate, from the engine's own record (the reason text is kept verbatim beside it). */
export function candidateRule(c: ExploreReport["candidates"][number]): string {
  if (c.established) return "established";
  const q = c.quality;
  if (q.explainedBy) return "refinement";
  if (typeof q.depthExtension === "object") return "depth-extension";
  if (typeof q.randomised === "object" && "rejected" in q.randomised) return "randomised-sequences";
  const r = c.dropReason ?? "";
  if (/approximation/.test(r)) return "gate:support-only-through-approximations";
  if (/coincid|generic argument|signature/i.test(r)) return "coincidence";
  if (/direction|opposite/i.test(r)) return "direction";
  if (/unit|ratio/i.test(r)) return "unit-ratio";
  if (/vacuous|never exercised/.test(r)) return "vacuous";
  if (/never preserved/.test(r)) return "never-preserved";
  if (/at least \d+ required/.test(r)) return "min-support";
  return "other";
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Runs APEX on every deployable contract of the in-scope sources. `sources` must already be ONLY the in-scope files of the sealed snapshot. */
export function computeApexShadow(input: { sources: ReadonlyArray<{ path: string; text: string }>; inScopePaths: readonly string[]; limits?: Partial<ShadowLimits> }): ShadowResult {
  const started = Date.now();
  const limits: ShadowLimits = { ...DEFAULT_SHADOW_LIMITS, ...(input.limits ?? {}) };
  const inScope = new Set(input.inScopePaths);
  const sources = input.sources.filter((s) => inScope.has(s.path)); // never anything outside the scope, whatever the caller passed
  const options: ExploreOptions = { strategy: "deep", maxSequences: limits.perSearchBudget };
  const ix = new ProgramIndex(sources);
  const out: ShadowResult = {
    schema: APEX_SHADOW_SCHEMA, label: APEX_SHADOW_LABEL, version: APEX_SHADOW_VERSION,
    engine: { generator: PROTOTYPE_GENERATOR, strategy: "deep", options: { depth: DEEP_DEFAULTS.depth, per_search_budget: limits.perSearchBudget, quality: "defaults", fp_rules: { ...FP_RULE_DEFAULTS }, minimise: true, memo: true }, limits },
    input_files: sources.map((s) => ({ path: s.path, sha256: sha256(s.text), bytes: Buffer.byteLength(s.text, "utf8") })),
    in_scope_paths_missing: input.inScopePaths.filter((p) => !sources.some((s) => s.path === p)),
    contracts: [], not_deployable: [], abstentions: [], abstentions_by_feature: {}, suppressions: { total: 0, by_kind: {}, examples: [] }, withheld: [], candidates: [], invariant_decisions: [],
    reclassified: [], would_be_hypotheses: [], parse_problems: ix.problems.slice(0, 200).map((p) => cap(p, 300)),
    coverage: null as unknown as ShadowResult["coverage"],
    cost: { transitions_requested: 0, transitions_interpreted: 0, wall_ms: 0, peak_rss_bytes: null, heap_used_bytes: 0 },
  };
  const all = [...ix.contracts.values()].filter((c) => inScope.has(c.file)).sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  for (const c of all.filter((x) => x.kind !== "contract")) out.not_deployable.push({ contract: c.name, file: c.file, kind: c.kind });
  const deployable = all.filter((c) => c.kind === "contract");
  /** where a function (or the constructor) of a contract is defined, searching its linearisation (most derived first) */
  const definitionOf = (contract: string, fn: string): Loc | null => {
    for (const d of ix.linearize(contract)) {
      const f = d.functions.find((x) => (fn === "constructor" ? x.kind === "constructor" : (x.name || x.kind) === fn));
      if (f) return locOf(`${f.file}:${f.startLine}`);
    }
    return null;
  };
  const addAbstention = (a: ShadowAbstention) => { out.abstentions.push(a); out.abstentions_by_feature[a.feature] = (out.abstentions_by_feature[a.feature] ?? 0) + 1; };
  let used = 0;
  for (const c of deployable) {
    const row: ShadowContract = { contract: c.name, file: c.file, status: "explored", reason: null, honest: null, adversarial: null, statements: null, entry_points: null, search: null, cost: { requested: 0, interpreted: 0, wall_ms: 0 } };
    out.contracts.push(row);
    if (Date.now() - started > limits.softWallMs) { row.status = "skipped_time_budget"; row.reason = `not started: the shadow stage's time budget (${limits.softWallMs} ms) was spent`; continue; }
    const remaining = limits.maxTransitions - used;
    const budget = Math.min(limits.perSearchBudget, Math.floor(remaining / REQUESTS_PER_BUDGET));
    if (budget < 50) { row.status = "skipped_transition_budget"; row.reason = `not started: ${used} of ${limits.maxTransitions} transitions already requested`; continue; }
    const t0 = Date.now();
    let result: ReturnType<typeof exploreDeep> | null = null;
    try { result = exploreDeep(sources, c.name, { ...options, maxSequences: budget }); }
    catch (error) { row.status = "engine_error"; row.reason = cap(`the engine failed on this contract: ${error instanceof Error ? error.message : String(error)}`, 500); }
    row.cost.wall_ms = Date.now() - t0;
    if (!result) continue;
    const { report: r, engine } = result;
    row.cost = { requested: engine.executions + engine.memoHits, interpreted: engine.executions, wall_ms: row.cost.wall_ms };
    used += row.cost.requested; out.cost.transitions_requested += row.cost.requested; out.cost.transitions_interpreted += row.cost.interpreted;
    if (r.abstained) {
      const m = /abstained\(([a-z-]+)@(.*)\)\)?$/.exec(r.abstained);
      row.status = /^no state-changing entry points/.test(r.abstained) ? "no_entry_points" : "abstained_at_deployment"; row.reason = cap(r.abstained);
      if (row.status === "abstained_at_deployment") {
        // the interpreter names the location when it has one; a refusal before any statement ran (constructor parameters it cannot
        // supply) is located at that constructor's definition, and the record says so
        const named = m ? m[2]!.replace(/\)+$/, "") : "unknown";
        const owner = /constructor parameters of ([^\s()]+)/.exec(r.abstained)?.[1] ?? c.name;
        const l = named !== "unknown" ? { ...locOf(named), located_by: "interpreter" as const } : { ...definitionOf(owner, "constructor") ?? locOf(`${c.file}:${c.startLine}`), located_by: "definition" as const };
        addAbstention({ contract: c.name, function: "constructor", feature: m?.[1] ?? "other", file: l.file, line: l.line, at: l.at, why: cap(r.abstained), phase: "deployment", located_by: l.located_by });
      }
      continue;
    }
    row.honest = searchCoverage(r.coverage.honest); row.adversarial = searchCoverage(r.coverage.adversarial);
    const unreachedBoth = new Set(r.coverage.honest.statements.unreached.filter((s) => r.coverage.adversarial.statements.unreached.includes(s)));
    row.statements = { total: r.coverage.honest.statements.total, reached: r.coverage.honest.statements.total - unreachedBoth.size };
    const completed = new Set([...r.coverage.honest.functions, ...r.coverage.adversarial.functions].filter((f) => f.completed > 0).map((f) => f.name));
    row.entry_points = { total: r.coverage.honest.functions.length, completed: completed.size };
    if (r.search) row.search = { accepting_depth: r.search.acceptingDepth, extension_depth: r.search.extensionDepth, budget: r.search.budget, honest_transitions: r.search.honestTransitions, adversarial_transitions: r.search.adversarialTransitions, random_transitions: r.search.randomTransitions };
    for (const a of r.gate.abstentions) {
      const l = a.at !== "unknown" ? { ...locOf(a.at), located_by: "interpreter" as const } : { ...(definitionOf(c.name, a.function) ?? locOf(`${c.file}:${c.startLine}`)), located_by: "definition" as const };
      addAbstention({ contract: c.name, function: a.function, feature: a.feature, file: l.file, line: l.line, at: l.at, why: cap(a.why), phase: a.phase, located_by: l.located_by });
    }
    out.suppressions.total += r.gate.suppressed.total;
    for (const [k, n] of Object.entries(r.gate.suppressed.byKind)) out.suppressions.by_kind[k] = (out.suppressions.by_kind[k] ?? 0) + (n ?? 0);
    for (const s of r.gate.suppressed.examples) out.suppressions.examples.push({ contract: c.name, candidate: s.candidate, phase: s.phase, breaking_function: s.breakingFunction, sequence: seq(s.sequence),
      approximations: s.approximations.slice(0, 20).map((a) => { const l = locOf(a.at); return { kind: a.kind, file: l.file, line: l.line, at: l.at, what: cap(a.what, 200) }; }) });
    for (const w of r.gate.withheld) out.withheld.push({ contract: c.name, candidate: w.candidate, why: w.why, kinds: [...w.kinds] });
    for (const k of r.candidates) {
      const rule = candidateRule(k); const decision = k.established ? "accepted" as const : "rejected" as const;
      const reason = k.established ? `established: ${k.quality.support} fully modelled honest transitions moved both sides (min ${k.quality.minSupport}); depth extension ${typeof k.quality.depthExtension === "string" ? k.quality.depthExtension : "rejected"}; randomised ${typeof k.quality.randomised === "string" ? k.quality.randomised : "rejected" in k.quality.randomised ? "rejected" : "passed"}` : cap(k.dropReason ?? "not established");
      out.candidates.push({ contract: c.name, id: k.id, kind: k.kind, statement: cap(k.statement, 300), vars: k.vars.slice(0, 20), decision, rule, reason, maintaining: k.maintaining, honest_violations: k.honestViolations,
        quality: { support: k.quality.support, min_support: k.quality.minSupport, honest_breakers: k.quality.honestBreakers.slice(0, 50), depth_extension: cap(typeof k.quality.depthExtension === "string" ? k.quality.depthExtension : JSON.stringify(k.quality.depthExtension), 300),
          randomised: cap(typeof k.quality.randomised === "string" ? k.quality.randomised : JSON.stringify(k.quality.randomised), 600), explained_by: k.quality.explainedBy ?? null } });
      out.invariant_decisions.push({ contract: c.name, candidate: k.id, decision, rule, reason });
    }
    for (const x of r.reclassified ?? []) out.reclassified.push({ contract: c.name, candidate: x.candidate, rule: x.rule, breaking_function: x.breakingFunction, sequence: seq(x.sequence), why: cap(x.why),
      evidence: x.evidence.slice(0, 20).map((e) => ({ function: e.function, role: e.role, transfer: e.transfer, check: locOf(`${e.check.file}:${e.check.line}`), role_evidence: e.roleEvidence.slice(0, 10).map((l) => locOf(`${l.file}:${l.line}`)) })) });
    r.hypotheses.forEach((h, i) => {
      const v = r.violations[i]!;
      out.would_be_hypotheses.push({ contract: c.name, label: UNVALIDATED, generator: h.generator, family: h.family, claim: cap(h.claim, 1000), spans: h.spans.map((s) => ({ file: s.file, line: s.line, role: s.role })),
        invariant: cap(h.rationale.invariant, 300), candidate: v.candidate, phase: v.phase, breaking_function: v.breakingFunction, reason: cap(v.reason, 300), detail: cap(v.detail, 300),
        counterexample: seq(h.rationale.counterexample), minimised: h.rationale.minimisedCounterexample ? seq(h.rationale.minimisedCounterexample) : null,
        fidelity: { fully_modelled: true, approximations_on_path: 0 }, independent_of_scanners: h.independentOfScanners, prior_leads_on_function: h.priorLeadsOnFunction.slice(0, 20) });
    });
  }
  const explored = out.contracts.filter((c) => c.status === "explored");
  const sum = (f: (c: ShadowContract) => number) => explored.reduce((s, c) => s + f(c), 0);
  const filesWithDeployable = new Set(deployable.map((c) => c.file));
  const filesExplored = new Set(explored.map((c) => c.file));
  out.coverage = {
    in_scope_files: { numerator: filesExplored.size, denominator: input.inScopePaths.length, meaning: `in-scope files with at least one contract explored / official in-scope files (${filesWithDeployable.size} define a deployable contract; ${out.in_scope_paths_missing.length} missing from the snapshot)` },
    contracts_explored: { numerator: explored.length, denominator: deployable.length, meaning: "deployable contracts in in-scope files that APEX deployed and searched / deployable contracts in in-scope files (interfaces, libraries and abstract contracts are listed separately)" },
    entry_points_completed: { numerator: sum((c) => c.entry_points?.completed ?? 0), denominator: sum((c) => c.entry_points?.total ?? 0), meaning: "state-changing entry points completed at least once in a fully or partly modelled transaction / entry points of the explored contracts" },
    statements_reached: { numerator: sum((c) => c.statements?.reached ?? 0), denominator: sum((c) => c.statements?.total ?? 0), meaning: "statements reached by either search / statements of the explored contracts' executable surface" },
    guard_sides_both: { numerator: sum((c) => (c.honest?.guards.both_sides ?? 0)), denominator: sum((c) => (c.honest?.guards.total ?? 0)), meaning: "guards exercised on both sides by the honest search / guards of the explored contracts" },
    frontier_dropped: { numerator: sum((c) => (c.honest?.frontier_dropped ?? 0) + (c.adversarial?.frontier_dropped ?? 0)), denominator: sum((c) => (c.honest?.distinct_states ?? 0) + (c.adversarial?.distinct_states ?? 0)), meaning: "frontier states NOT expanded (dropped under the budget) / distinct concrete states reached, both searches" },
  };
  out.cost.wall_ms = Date.now() - started;
  out.cost.heap_used_bytes = process.memoryUsage().heapUsed;
  try { out.cost.peak_rss_bytes = process.resourceUsage().maxRSS * 1024; } catch { out.cost.peak_rss_bytes = null; }
  return out;
}
