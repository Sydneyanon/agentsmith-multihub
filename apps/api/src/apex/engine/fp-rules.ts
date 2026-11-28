/**
 * PROTOTYPE (docs/architecture/apex-first-capability.md §11.2). Evidence-based rules against the false-positive kinds that remained on
 * fresh set 1. NOT wired anywhere; used only by `deep-explorer.ts` and the APEX tests. None of them touches the fidelity gate or the
 * minimiser: they decide which candidates are refuted and which fully modelled counterexample, if any, is reported as a violation.
 *
 *  - privileged breaker: a counterexample whose breaking transition only the deployer can perform is "privileged behaviour", not an attack;
 *  - privileged funding: an actor-value counterexample whose gain is covered by ether the deployer paid in through privileged transitions on
 *    the same path is "privileged behaviour" (the owner's yield, grant or bonus), not an attack;
 *  - designed cycle: a one-way reversal that completes a cycle (a phase variable reset from its extreme to its deployed value) and restores
 *    an earlier state of its own path, apart from counters that advanced, is a designed cycle; a one-way candidate whose every honest
 *    reversal is one is refuted;
 *  - unit ratio: a conservation candidate `A = sum(L)` broken only by transitions that move A alone, after which every honest transition
 *    moving both preserves the ratio A : sum(L) (to rounding), relates two quantities by a price, not by equality: refuted;
 *  - privileged refinement: the refinement rule (deep-explorer.ts) may excuse transitions only the deployer can perform;
 *  - residual breaker (deep-explorer.ts; a reporting order only): a conservation counterexample whose breaking transition no one-term
 *    refinement accounts for is reported before one that value moving between tracked pools explains.
 *
 * "Only the deployer can perform" needs two kinds of evidence, both cited: STATIC, from the protocol model's authority facts (P3,
 * `authorityFacts`): the function has a caller-side reverting authorising check reading a role whose holder is a single address and whose
 * transfer is `fixed-after-deployment` or `by-holder` (no other actor can obtain it); and DYNAMIC: at that pre-state the same call by every
 * other modelled actor reverts.
 */
import { authorityFacts, type Loc } from "../../analysis/solidity/authority.js";
import type { FunctionDef } from "../../analysis/solidity/parser.js";
import { stateVariableRoles } from "../../analysis/solidity/state-roles.js";
import { Tracer } from "../../analysis/solidity/trace.js";
import type { Value } from "../../analysis/solidity/simulate.js";
import { ACTORS, fnName, isDefaultMappingEntry, type Engine, type Move, type Node, type StepRecord } from "./state-explorer-prototype.js";

export const FP_RULES = ["privilegedBreaker", "privilegedFunding", "designedCycle", "unitRatio", "privilegedRefinement", "residualBreaker"] as const;
export type FpRule = (typeof FP_RULES)[number];
export type FpRules = Partial<Record<FpRule, boolean>>;

export type PrivilegeEvidence = { function: string; role: string; transfer: string; check: Loc; roleEvidence: Loc[] };
/** functions that only the holder of an unobtainable single-address role can complete, with the authority-fact evidence */
export type PrivilegeModel = Map<string, PrivilegeEvidence>;
const DEPLOYER = "owner0";

export function privilegeModel(engine: Engine): PrivilegeModel {
  const { ix, contract, fns } = engine;
  const traces = new Map<FunctionDef, ReturnType<Tracer["run"]>>();
  const trace = (f: FunctionDef) => { let t = traces.get(f); if (!t) { t = new Tracer(ix).run(f); traces.set(f, t); } return t; };
  const roles = stateVariableRoles(ix, trace, contract);
  const facts = authorityFacts(ix, trace, contract, fns.map((f) => ({ id: fnName(f), f })), roles);
  const unobtainable = new Map(facts.roles.filter((r) => r.holder === "single-address" && (r.transfer === "fixed-after-deployment" || r.transfer === "by-holder")).map((r) => [r.variable, r]));
  const out: PrivilegeModel = new Map();
  for (const c of facts.checks) {
    if (c.side !== "caller-side" || c.enforcement !== "reverting" || out.has(c.fn)) continue;
    const role = c.reads.find((r) => unobtainable.has(r)); if (!role) continue;
    const rf = unobtainable.get(role)!;
    out.set(c.fn, { function: c.fn, role, transfer: rf.transfer, check: c.at, roleEvidence: rf.evidence });
  }
  return out;
}

/** a step is privileged if it is the deployer's, its function is statically privileged, and the same call by every other actor reverts */
export function privilegedStep(engine: Engine, model: PrivilegeModel, pre: Node, m: Move): PrivilegeEvidence | null {
  if (m.actor !== DEPLOYER) return null;
  const ev = model.get(fnName(m.fn)); if (!ev) return null;
  for (const other of ACTORS) if (other !== DEPLOYER && engine.step(pre, { ...m, actor: other }).k !== "revert") return null;
  return ev;
}

export type Reclassified = { candidate: string; rule: FpRule; breakingFunction: string; sequence: StepRecord[]; why: string; evidence: PrivilegeEvidence[] };

const cite = (e: PrivilegeEvidence) => `${e.function} requires ${e.role} (check at ${e.check.file}:${e.check.line}; ${e.role} is ${e.transfer})`;

/** privileged breaker: the breaking transition can be performed only by the deployer */
export function privilegedBreaker(engine: Engine, model: PrivilegeModel, candidate: string, pre: Node, post: Node, m: Move): Reclassified | null {
  const ev = privilegedStep(engine, model, pre, m); if (!ev) return null;
  return { candidate, rule: "privilegedBreaker", breakingFunction: fnName(m.fn), sequence: post.seq, why: `privileged behaviour, not an attack: the breaking transition can be performed only by the deployer: ${cite(ev)}`, evidence: [ev] };
}

/** privileged funding (actor-value only): the observed actor's gain is covered by ether the deployer paid in through privileged steps */
export function privilegedFunding(engine: Engine, model: PrivilegeModel, candidate: string, post: Node): Reclassified | null {
  const path = engine.replay(post.moves); if (!path) return null;
  let inflow = 0n; const evs: PrivilegeEvidence[] = [];
  for (const t of path) { if (t.m.value === 0n) continue; const ev = privilegedStep(engine, model, t.pre, t.m); if (ev) { inflow += t.m.value; evs.push(ev); } }
  const gain = post.w.received - post.sentByAttacker;
  if (inflow === 0n || gain > inflow) return null;
  return { candidate, rule: "privilegedFunding", breakingFunction: fnName(post.moves[post.moves.length - 1]!.fn), sequence: post.seq,
    why: `privileged behaviour, not an attack: the observed actor's gain (${gain}) is covered by the ${inflow} wei the deployer paid in through privileged transitions on this path: ${evs.map(cite).join("; ")}`, evidence: evs };
}

/** the contract state of a node for cycle comparison: storage without default mapping entries or scalars at their deployed value, and the ether held */
function canon(engine: Engine, n: Node, exclude: ReadonlySet<string>): string {
  const keep: string[] = [];
  for (const [k, v] of n.w.storage) {
    if (exclude.has(k) || isDefaultMappingEntry(k, v)) continue;
    if (!k.includes("|") && engine.deployedValues.has(k) && engine.deployedValues.get(k) === v) continue;
    keep.push(`${k}=${typeof v === "bigint" ? `${v}n` : JSON.stringify(v)}`);
  }
  return keep.sort().join(";") + `#${n.w.balance}`;
}

/**
 * designed cycle: the reversal of one-way variable V by a non-deployer (pre -> post, the last step of post's path) completes a cycle when
 *  (a) V lands exactly on its deployed value;
 *  (b) the same transition resets some phase variable P (possibly V) from its extreme explored value (the maximum for a number) to its
 *      deployed value: the cycle had reached its end;
 *  (c) the post-state equals an earlier state of its own path (deployment included), ignoring only the scalars this transition increased.
 */
export function designedCycle(engine: Engine, v: string, post: Node, maxima: ReadonlyMap<string, bigint>): string | null {
  const path = engine.replay(post.moves); if (!path || !path.length) return null;
  const pre = path[path.length - 1]!.pre; const q = path[path.length - 1]!.post;
  const deployed = (name: string): Value | undefined => engine.deployedValues.get(name);
  if (engine.valueOf(q, v) !== deployed(v)) return null;
  const reset = engine.phaseVars.find((p) => {
    const d = deployed(p); const before = engine.valueOf(pre, p); const after = engine.valueOf(q, p);
    if (d === undefined || after !== d || before === d) return false;
    return typeof before === "bigint" ? maxima.get(p) === before : true;
  });
  if (!reset) return null;
  const increased = new Set(engine.uintScalars.filter((s) => { const a = engine.valueOf(pre, s); const b = engine.valueOf(q, s); return typeof a === "bigint" && typeof b === "bigint" && b > a; }));
  const target = canon(engine, q, increased);
  const states = [engine.root!, ...path.slice(0, -1).map((t) => t.post)];
  const j = states.findIndex((s) => canon(engine, s, increased) === target);
  if (j < 0) return null;
  return `designed cycle: ${fnName(path[path.length - 1]!.m.fn)} resets ${reset} from its extreme ${String(engine.valueOf(pre, reset))} to its deployed value and restores the state after step ${j} of its own path${increased.size ? `, apart from the counters it advanced (${[...increased].sort().join(", ")})` : ""}`;
}
