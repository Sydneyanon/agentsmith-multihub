/**
 * PROTOTYPE (docs/architecture/apex-first-capability.md §11, priorities 1 and 2). The "deep" search strategy of the APEX state explorer.
 * NOT wired into any pipeline; imported only by `state-explorer-prototype.ts` and the APEX tests; excluded from production builds.
 *
 * What it changes, relative to the baseline strategy (kept, as `strategy: "baseline"`, to measure the difference):
 *  1. depth: one layered breadth-first search to depth + 1 under a transition budget (default accepting depth 5). The layers up to the
 *     accepting depth are the accepting search; the last layer is the depth-extension check, run in the SAME search. If the search
 *     reaches a fixpoint, every layer is accepting and no depth artefact is possible;
 *  2. amounts: boundary values (0, 1, max-1), values derived from the numeric literals and constants in the contract's code (c-1, c, c+1),
 *     and values derived from the pre-state (each uint scalar and each of the caller's mapping entries, v-1, v, v+1), for arguments and
 *     for msg.value; both booleans;
 *  3. coverage-guided frontier selection: when a layer does not fit its share of the budget, the frontier is reduced, preferring states
 *     with an abstract key (coverage.ts: numbers as signs) not yet expanded, then states reached through an abstract transition not yet
 *     seen, then states reached with the baseline's own arguments; every dropped state is counted and reported as unexplored;
 *  4. invariant quality, two new refutation rules (never a weakening of the fidelity gate, which is the same code for both strategies):
 *     - refinement: a conservation candidate `A = sum(L)` that honest transitions break is REFUTED when one extra term T (a uint scalar or
 *       another ledger) makes a linear relation (`A + T = sum(L)`, `A = sum(L) + T`, or `A = sum(L) + sum(M)`) hold, in its differential
 *       form, on EVERY honest transition that touched the candidate, its breakers included, with T moving on at least one breaker: value
 *       moved between two tracked pools, which is a designed asymmetry the narrow candidate cannot express. When the relation is one of
 *       the precommitted partition shapes, it becomes a candidate itself (`partition:...`) and goes through every rule;
 *     - direction: a solvency candidate `balance >= sum(L)` is REFUTED when an honest transition moves sum(L) and the ether held in
 *       strictly opposite directions (L grew while ether left, or shrank while ether arrived): L is then not a liability ledger;
 *  5. the adversarial search uses the same layered search, to the accepting depth;
 *  6. the false-positive rules of §11.2 (fp-rules.ts; `quality.fpRules`, defaults FP_RULE_DEFAULTS, `false` for the strategy as at d32f960):
 *     unit ratio and privileged refinement refute candidates; privileged breaker, privileged funding and designed cycle (off by default)
 *     reclassify a fully modelled counterexample instead of reporting it, and the next one no rule reclassifies is reported; residual
 *     breaker orders a conservation candidate's counterexamples. None of them changes a search, the gate or the minimiser.
 * Everything else (actors, families, the gate, minimisation, hypothesis drafts) is shared with the baseline and unchanged.
 */
import { abstractKey, CoverageCollector } from "./coverage.js";
import {
  ACTORS, Engine, ETHER, establish, finishReport, fmt, fnName, newStat, RANDOM_HONEST_DOMAIN, randomSequences, stateKey, sumLedger,
  type AbstentionRecord, type Actor, type CandidateResult, type Check, type ExploreOptions, type ExploreReport, type Found, type Move, type Node,
  type Stat, type StepRecord, type TransitionEvent,
} from "./state-explorer-prototype.js";
import type { Value } from "../../analysis/solidity/simulate.js";
import { designedCycle, privilegedBreaker, privilegedFunding, privilegeModel, type FpRules, type PrivilegeModel, type Reclassified } from "./fp-rules.js";
import type { FunctionDef } from "../../analysis/solidity/parser.js";

const MAX_UINT = 2n ** 256n - 1n;
/** the baseline's own argument values: 1e18 for amounts and msg.value (or no value), the caller for addresses, true for booleans */
const isGeneric = (m: Move): boolean => m.args.every((v) => (typeof v === "bigint" ? v === ETHER : typeof v === "boolean" ? v : v === m.actor)) && (m.value === 0n ? m.fn.mutability !== "payable" : m.value === ETHER);
export const DEEP_DEFAULTS = { depth: 5, budget: 6_000, maxDerived: 12, maxStateDerived: 6 } as const;

export type DeepDomain = { amounts: bigint[]; values: bigint[]; bools: boolean[]; adversarial: boolean };

/** numeric literals in every body the deployed contract can execute, plus the values of its constants */
export function codeConstants(engine: Engine): bigint[] {
  const out = new Set<bigint>(); const seen = new Set<object>();
  const visit = (x: unknown): void => {
    if (!x || typeof x !== "object" || seen.has(x)) return; seen.add(x);
    if (Array.isArray(x)) { x.forEach(visit); return; }
    const o = x as Record<string, unknown>;
    if (o["k"] === "num" && typeof o["v"] === "bigint") out.add(o["v"]);
    for (const v of Object.values(o)) if (v && typeof v === "object") visit(v);
  };
  const lin = engine.ix.linearize(engine.contract);
  for (const f of engine.fns) visit(f.body);
  for (const c of lin) { for (const m of c.modifiers) visit(m.body); for (const f of c.functions) if (f.kind === "function" && (f.visibility === "internal" || f.visibility === "private")) visit(f.body); }
  for (const c of lin) for (const v of c.stateVars) {
    visit(v.init);
    if (v.constant && engine.root) { try { engine.it.w.restore(engine.root.w); const val = engine.it.readVar(v.name, []); if (typeof val === "bigint") out.add(val); } catch { /* not evaluable: ignored */ } }
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** the deep strategy's argument domain; the baseline's own values come first, so its counterexample shapes are found first */
export function deepDomain(engine: Engine, adversarial: boolean): DeepDomain {
  const derived: bigint[] = [];
  for (const c of codeConstants(engine)) if (c >= 2n && c < MAX_UINT / 4n) derived.push(c - 1n, c, c + 1n);
  const uniq = (xs: bigint[]) => [...new Set(xs)];
  const d = uniq(derived).filter((x) => x !== ETHER && x > 1n).slice(0, DEEP_DEFAULTS.maxDerived);
  return { amounts: uniq([ETHER, 0n, 1n, ...d, MAX_UINT - 1n]), values: uniq([ETHER, 0n, 1n, ...d.filter((x) => x <= 10n ** 30n)]), bools: [true, false], adversarial };
}

/** the moves available from a state: the static domain, plus values derived from the pre-state for the first uint parameter and msg.value */
function moveTemplates(engine: Engine, d: DeepDomain): { statics: Move[]; excluded: Map<string, string>; derivable: Array<{ fn: FunctionDef; actor: Actor; uintAt: number; payable: boolean }> } {
  const statics: Move[] = []; const excluded = new Map<string, string>(); const derivable: Array<{ fn: FunctionDef; actor: Actor; uintAt: number; payable: boolean }> = [];
  for (const fn of engine.fns) for (const actor of ACTORS) {
    const choices: Value[][] = []; let ok = true; let uintSeen = 0; let uintAt = -1;
    fn.params.forEach((p, i) => {
      if (/^u?int/.test(p.type)) { choices.push(uintSeen++ === 0 ? d.amounts : [ETHER, 1n]); if (uintAt < 0) uintAt = i; }
      else if (/^address/.test(p.type)) choices.push(d.adversarial ? [...ACTORS] : [actor]);
      else if (/^bool/.test(p.type)) choices.push(d.bools);
      else ok = false;
    });
    if (!ok) { excluded.set(fnName(fn), "parameter types not modelled"); continue; }
    let variants: Value[][] = [[]];
    for (const c of choices) variants = variants.flatMap((prefix) => c.map((v) => [...prefix, v]));
    const payable = fn.mutability === "payable";
    for (const args of variants) for (const value of payable ? d.values : [0n]) statics.push({ actor, fn, args, value });
    if (uintAt >= 0 || payable) derivable.push({ fn, actor, uintAt, payable });
  }
  return { statics, excluded, derivable };
}

function stateDerived(n: Node, actor: Actor): bigint[] {
  const vs = new Set<bigint>();
  for (const [k, v] of n.w.storage) {
    if (typeof v !== "bigint" || v === 0n) continue;
    // a mapping entry counts only if one of its keys is the actor (the key segments after the variable name)
    if (k.includes("|") && !k.split("|").slice(1).includes(actor)) continue;
    vs.add(v - 1n); vs.add(v); vs.add(v + 1n);
  }
  return [...vs].filter((x) => x > 1n && x < MAX_UINT).sort((a, b) => (a < b ? -1 : 1));
}

/** the state-derived values each derivable move takes from a state (cheap: no move is built), and how many moves they add */
type Derived = { specs: Array<{ g: ReturnType<typeof moveTemplates>["derivable"][number]; xs: bigint[] }>; count: number };
function derivedFrom(n: Node, t: ReturnType<typeof moveTemplates>, haveAmounts: ReadonlySet<bigint>, haveValues: ReadonlySet<bigint>): Derived {
  const specs: Derived["specs"] = []; let count = 0; const perActor = new Map<Actor, bigint[]>();
  for (const g of t.derivable) {
    const have = g.uintAt >= 0 ? haveAmounts : haveValues;
    let derived = perActor.get(g.actor); if (!derived) { derived = stateDerived(n, g.actor); perActor.set(g.actor, derived); }
    const xs = derived.filter((x) => !have.has(x)).slice(0, DEEP_DEFAULTS.maxStateDerived);
    if (!xs.length) continue;
    specs.push({ g, xs }); count += xs.length * ((g.uintAt >= 0 ? 1 : 0) + (g.payable ? 1 : 0));
  }
  return { specs, count };
}
/** the moves available from a state: the static domain, then the state-derived moves, in a fixed order */
function movesFrom(t: ReturnType<typeof moveTemplates>, dv: Derived): Move[] {
  if (!dv.specs.length) return t.statics;
  const extra: Move[] = [];
  for (const { g, xs } of dv.specs) {
    const base: Value[] = g.fn.params.map((p) => (/^u?int/.test(p.type) ? ETHER : /^address/.test(p.type) ? g.actor : /^bool/.test(p.type) ? true : null));
    for (const x of xs) {
      if (g.uintAt >= 0) { const args = [...base]; args[g.uintAt] = x; extra.push({ actor: g.actor, fn: g.fn, args, value: g.payable ? ETHER : 0n }); }
      if (g.payable) extra.push({ actor: g.actor, fn: g.fn, args: base, value: x });
    }
  }
  return extra.length ? [...t.statics, ...extra] : t.statics;
}

export type LayeredResult = { col: CoverageCollector; layers: number; fixpoint: boolean; dropped: number };

/**
 * Layered breadth-first search with concrete-state deduplication. Each layer gets an equal share of the remaining budget; when its frontier
 * does not fit, the frontier is reduced by coverage-guided selection. A layer is only started if at least one state fits, and every selected
 * state is expanded with every move, so every executed layer is complete over its (possibly reduced) frontier.
 */
export function layeredSearch(engine: Engine, d: DeepDomain, maxLayers: number, budget: number, onTransition: (ev: TransitionEvent, layer: number) => void, onLayerStart: (layer: number) => void = () => {}): LayeredResult {
  const t = moveTemplates(engine, d); const haveAmounts = new Set(d.amounts); const haveValues = new Set(d.values);
  const col = new CoverageCollector(engine, maxLayers); col.start(t.excluded);
  const root = engine.root!;
  const seen = new Set<string>([stateKey(root)]); col.state(root, stateKey(root));
  const expandedAbs = new Set<string>(); const absTrans = new Set<string>();
  type Entry = { n: Node; prio: number };
  let frontier: Entry[] = [{ n: root, prio: 0 }];
  let dropped = 0; let layers = 0; let stoppedByBudget = false;
  for (let k = 1; k <= maxLayers && frontier.length; k++) {
    const allowance = Math.floor((budget - col.sequences) / (maxLayers - k + 1));
    // each state's number of moves is known without building them; moves are built only for the states selected for expansion
    const withMoves = frontier.map((e) => { const dv = derivedFrom(e.n, t, haveAmounts, haveValues); return { ...e, dv, cost: t.statics.length + dv.count }; });
    const total = withMoves.reduce((s, e) => s + e.cost, 0);
    let selected = withMoves;
    if (total > allowance) {
      const order = [...withMoves].sort((a, b) => a.prio - b.prio); // stable: BFS order within a priority
      selected = []; let cost = 0;
      for (const e of order) { if (cost + e.cost > allowance) continue; selected.push(e); cost += e.cost; }
      if (!selected.length) { stoppedByBudget = true; dropped += frontier.length; break; }
      dropped += frontier.length - selected.length;
      const keep = new Set(selected); selected = withMoves.filter((e) => keep.has(e)); // expand in BFS order
    }
    onLayerStart(k);
    const next: Entry[] = []; const novelHere = new Set<string>();
    for (const e of selected) {
      expandedAbs.add(abstractKey(e.n));
      for (const m of movesFrom(t, e.dv)) {
        const outcome = engine.step(e.n, m); col.transition(e.n, m, outcome); onTransition({ pre: e.n, m, outcome }, k);
        if (outcome.k !== "ok") continue;
        const key = stateKey(outcome.post); if (seen.has(key)) continue; seen.add(key); col.state(outcome.post, key);
        const a = abstractKey(outcome.post); const tr = `${fnName(m.fn)}|${abstractKey(e.n)}->${a}`;
        const baseArgs = m.args.every((v) => typeof v !== "bigint" || v === ETHER) && (m.value === 0n || m.value === ETHER);
        const prio = !expandedAbs.has(a) && !novelHere.has(a) ? 0 : !absTrans.has(tr) ? 1 : baseArgs ? 2 : 3;
        if (prio === 0) novelHere.add(a);
        absTrans.add(tr);
        next.push({ n: outcome.post, prio });
      }
    }
    layers = k;
    frontier = next;
  }
  const fixpoint = frontier.length === 0 && dropped === 0 && !stoppedByBudget;
  col.fixpoint = fixpoint; col.budgetExhausted = dropped > 0 || stoppedByBudget; col.depthReached = layers; col.frontierDropped = dropped; col.snapshot();
  return { col, layers, fixpoint, dropped };
}

// ---------------------------------------------------------------- refinement terms and partition candidates
type Term = { kind: "scalar-sum" | "scalar-diff" | "ledger"; name: string };
const termId = (t: Term) => `${t.kind}:${t.name}`;
function relationText(c: { a: string; l: string }, t: Term): string {
  return t.kind === "scalar-sum" ? `${c.a} + ${t.name} == sum(${c.l})` : t.kind === "scalar-diff" ? `${c.a} == sum(${c.l}) + ${t.name}` : `${c.a} == sum(${c.l}) + sum(${t.name})`;
}
/** the precommitted partition id a refinement corresponds to, or null when it is an explanation only (`A = sum(L) + B`) */
function partitionId(c: { a: string; l: string }, t: Term): string | null {
  if (t.kind === "scalar-sum") { const [x, y] = [c.a, t.name].sort(); return `partition:${x}+${y}=sum(${c.l})`; }
  if (t.kind === "ledger") { const [x, y] = [c.l, t.name].sort(); return `partition:${c.a}=sum(${x})+sum(${y})`; }
  return null;
}

function partitionChecks(engine: Engine): Check[] {
  const num = (v: Value): bigint => (typeof v === "bigint" ? v : 0n);
  const val = (n: Node, name: string) => num(engine.valueOf(n, name));
  const out: Check[] = [];
  const scalars = [...engine.uintScalars].sort();
  for (let i = 0; i < scalars.length; i++) for (let j = i + 1; j < scalars.length; j++) {
    const x = scalars[i]!; const y = scalars[j]!;
    if (!engine.aggregates.includes(x) && !engine.aggregates.includes(y)) continue;
    for (const l of engine.ledgers) {
      const side = (n: Node) => val(n, x) + val(n, y);
      out.push({
        c: { id: `partition:${x}+${y}=sum(${l})`, kind: "partition", statement: `${x} + ${y} == sum over accounts of ${l}[account]`, vars: [x, y, l] },
        holds: (n) => side(n) === sumLedger(n.w, l),
        touched: (p, q) => val(p, x) !== val(q, x) || val(p, y) !== val(q, y) || sumLedger(p.w, l) !== sumLedger(q.w, l),
        supports: (p, q) => side(p) !== side(q) && sumLedger(p.w, l) !== sumLedger(q.w, l),
        reason: (_p, q) => `${x} + ${y} ${side(q) > sumLedger(q.w, l) ? ">" : "<"} sum(${l})`,
      });
    }
  }
  const ledgers = [...engine.ledgers].sort();
  for (const a of engine.aggregates) for (let i = 0; i < ledgers.length; i++) for (let j = i + 1; j < ledgers.length; j++) {
    const l = ledgers[i]!; const m = ledgers[j]!; const side = (n: Node) => sumLedger(n.w, l) + sumLedger(n.w, m);
    out.push({
      c: { id: `partition:${a}=sum(${l})+sum(${m})`, kind: "partition", statement: `${a} == sum over accounts of ${l}[account] + sum over accounts of ${m}[account]`, vars: [a, l, m] },
      holds: (n) => val(n, a) === side(n),
      touched: (p, q) => val(p, a) !== val(q, a) || side(p) !== side(q),
      supports: (p, q) => val(p, a) !== val(q, a) && side(p) !== side(q),
      reason: (_p, q) => `${a} ${val(q, a) > side(q) ? ">" : "<"} sum(${l}) + sum(${m})`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- per-layer evidence (the last layer may turn out to be the extension)
type Evidence = {
  stats: Map<string, Stat>; clean: Map<string, Found>; tainted: Found[];
  /** `${candidate}|${term}` combinations whose differential relation failed on some honest transition of the candidate */
  inconsistent: Set<string>; movedOnBreak: Set<string>;
  /** solvency candidates with an honest transition moving the ledger and the ether held in opposite directions */
  opposite: Map<string, StepRecord[]>;
  /** breakers per candidate, with the first sequence */
  breakers: Map<string, Map<string, StepRecord[]>>;
  /** supporting transitions (fully modelled or not) whose arguments and msg.value are the baseline's generic ones (1e18, own address, true) */
  genericSupport: Map<string, number>;
  /** distinct `function(args){value}` signatures among the supporting transitions, fully modelled or not (capped at 2 per candidate) */
  supportSignatures: Map<string, Set<string>>;
  // ---- evidence for the false-positive rules (fp-rules.ts); collected only when the rule is on
  /** fully modelled counterexamples per candidate in discovery order (at most 3 per breaking function, 24 in all): the alternatives */
  alternatives: Map<string, Found[]>;
  /** privileged refinement: as `inconsistent` / `movedOnBreak`, over the transitions not statically privileged */
  inconsistentUnpriv: Set<string>; movedOnUnprivBreak: Set<string>;
  /** unit ratio, per conservation candidate: a breaking transition moved sum(L); transitions from a broken state moving both sides */
  ratioTwoSidedBreak: Set<string>; ratioProportional: Map<string, { n: number; generic: number; signatures: Set<string> }>; ratioNonProportional: Set<string>;
  /** designed cycle: honest one-way violations (capped at 200 per candidate; overflow recorded), and the maximum of each phase number */
  reversals: Map<string, Node[]>; reversalOverflow: Set<string>; maxima: Map<string, bigint>;
};
const newEvidence = (ids: string[]): Evidence => ({ stats: new Map(ids.map((id) => [id, newStat()])), clean: new Map(), tainted: [], inconsistent: new Set(), movedOnBreak: new Set(), opposite: new Map(), breakers: new Map(), genericSupport: new Map(), supportSignatures: new Map(),
  alternatives: new Map(), inconsistentUnpriv: new Set(), movedOnUnprivBreak: new Set(), ratioTwoSidedBreak: new Set(), ratioProportional: new Map(), ratioNonProportional: new Set(), reversals: new Map(), reversalOverflow: new Set(), maxima: new Map() });
const ALT_PER_FN = 3; const ALT_TOTAL = 24; const REVERSAL_CAP = 200;
function addAlternative(alts: Map<string, Found[]>, f: Found): void {
  const xs = alts.get(f.k.c.id) ?? []; if (xs.length >= ALT_TOTAL) return;
  if (xs.filter((x) => x.m.fn === f.m.fn).length >= ALT_PER_FN) return;
  xs.push(f); alts.set(f.k.c.id, xs);
}
function mergeInto(dst: Evidence, src: Evidence): void {
  for (const [id, s] of src.stats) {
    const d = dst.stats.get(id)!;
    d.maintaining += s.maintaining; d.approximatedSupport += s.approximatedSupport; s.approximatedKinds.forEach((k) => d.approximatedKinds.add(k));
    d.honestViolations += s.honestViolations; s.breakers.forEach((b) => d.breakers.add(b)); if (!d.example && s.example) d.example = s.example;
  }
  for (const [id, f] of src.clean) if (!dst.clean.has(id)) dst.clean.set(id, f);
  for (const f of src.tainted) if (dst.tainted.length < 10_000) dst.tainted.push(f);
  src.inconsistent.forEach((x) => dst.inconsistent.add(x)); src.movedOnBreak.forEach((x) => dst.movedOnBreak.add(x));
  for (const [id, s] of src.opposite) if (!dst.opposite.has(id)) dst.opposite.set(id, s);
  for (const [id, n] of src.genericSupport) dst.genericSupport.set(id, (dst.genericSupport.get(id) ?? 0) + n);
  for (const [id, xs] of src.supportSignatures) { const d = dst.supportSignatures.get(id) ?? new Set<string>(); for (const x of xs) if (d.size < 2) d.add(x); dst.supportSignatures.set(id, d); }
  for (const [id, b] of src.breakers) { const d = dst.breakers.get(id) ?? new Map<string, StepRecord[]>(); for (const [fn, s] of b) if (!d.has(fn)) d.set(fn, s); dst.breakers.set(id, d); }
  for (const xs of src.alternatives.values()) for (const f of xs) addAlternative(dst.alternatives, f);
  src.inconsistentUnpriv.forEach((x) => dst.inconsistentUnpriv.add(x)); src.movedOnUnprivBreak.forEach((x) => dst.movedOnUnprivBreak.add(x));
  src.ratioTwoSidedBreak.forEach((x) => dst.ratioTwoSidedBreak.add(x)); src.ratioNonProportional.forEach((x) => dst.ratioNonProportional.add(x));
  for (const [id, p] of src.ratioProportional) { const d = dst.ratioProportional.get(id) ?? { n: 0, generic: 0, signatures: new Set<string>() }; d.n += p.n; d.generic += p.generic; for (const x of p.signatures) if (d.signatures.size < 2) d.signatures.add(x); dst.ratioProportional.set(id, d); }
  for (const [id, xs] of src.reversals) { const d = dst.reversals.get(id) ?? []; for (const x of xs) { if (d.length < REVERSAL_CAP) d.push(x); else dst.reversalOverflow.add(id); } dst.reversals.set(id, d); }
  src.reversalOverflow.forEach((x) => dst.reversalOverflow.add(x));
  for (const [k, v] of src.maxima) if (!dst.maxima.has(k) || dst.maxima.get(k)! < v) dst.maxima.set(k, v);
}

/** the false-positive rules' defaults (§11.2); `quality.fpRules: false` turns every one off, as the deep strategy was at d32f960 */
export const FP_RULE_DEFAULTS: Required<FpRules> = { privilegedBreaker: true, privilegedFunding: true, designedCycle: false, unitRatio: true, privilegedRefinement: true, residualBreaker: true };
const ALL_RULES_OFF: Required<FpRules> = { privilegedBreaker: false, privilegedFunding: false, designedCycle: false, unitRatio: false, privilegedRefinement: false, residualBreaker: false };

export type DeepResult = { report: ExploreReport; engine: Engine; collectors: CoverageCollector[] };

export function exploreDeep(sources: ReadonlyArray<{ path: string; text: string }>, contract: string, options: ExploreOptions = {}): DeepResult {
  const depth = options.depth ?? DEEP_DEFAULTS.depth; const budget = options.maxSequences ?? DEEP_DEFAULTS.budget;
  const q = options.quality === false ? null : { minSupport: 2, randomSequences: 200, seed: 1, depthExtension: true, refinement: true, direction: true, ...(options.quality ?? {}) };
  const rules: Required<FpRules> = q && q.fpRules !== false ? { ...FP_RULE_DEFAULTS, ...(q.fpRules ?? {}) } : { ...ALL_RULES_OFF };
  const anyReporting = rules.privilegedBreaker || rules.privilegedFunding || rules.designedCycle || rules.residualBreaker;
  const engine = new Engine(sources, contract); engine.memo = options.memo !== false;
  const empty = () => CoverageCollector.empty(depth);
  const report: ExploreReport = {
    contract, abstained: engine.abstained, candidates: [], violations: [], hypotheses: [], coverage: { honest: empty(), adversarial: empty() },
    gate: { abstentions: [], suppressed: { total: 0, byKind: {}, examples: [] }, candidatesWithOnlySuppressedCounterexamples: [], withheld: [] },
  };
  if (engine.abstained || !engine.root) return { report, engine, collectors: [] };

  const narrow = engine.checks; const parts = q?.refinement ? partitionChecks(engine) : [];
  const all = [...narrow, ...parts];
  // refinement terms per narrow conservation candidate
  const conservation = narrow.filter((k) => k.c.kind === "conservation").map((k) => {
    const [a, l] = k.c.vars as [string, string];
    const terms: Term[] = [
      ...engine.uintScalars.filter((s) => s !== a).flatMap((s) => [{ kind: "scalar-sum" as const, name: s }, { kind: "scalar-diff" as const, name: s }]),
      ...engine.ledgers.filter((m) => m !== l).map((m) => ({ kind: "ledger" as const, name: m })),
    ];
    return { k, a, l, terms };
  });
  const num = (v: Value): bigint => (typeof v === "bigint" ? v : 0n);
  const priv: PrivilegeModel | null = rules.privilegedBreaker || rules.privilegedFunding || rules.privilegedRefinement ? privilegeModel(engine) : null;
  /** statically privileged: the deployer calling a function guarded by an unobtainable role (used inside the search, where no replay is done) */
  const staticPrivileged = (m: Move) => m.actor === "owner0" && !!priv?.has(fnName(m.fn));
  const dv = (p: Node, q2: Node, name: string) => num(engine.valueOf(q2, name)) - num(engine.valueOf(p, name));
  const dl = (p: Node, q2: Node, l: string) => sumLedger(q2.w, l) - sumLedger(p.w, l);

  const abst = new Map<string, AbstentionRecord>();
  const main = newEvidence(all.map((k) => k.c.id)); let layer = newEvidence(all.map((k) => k.c.id));
  if (rules.designedCycle) for (const p of engine.phaseVars) { const x = engine.valueOf(engine.root, p); if (typeof x === "bigint") main.maxima.set(p, x); }
  const recordAbstention = (ev: TransitionEvent, phase: string) => {
    const { m, outcome } = ev; if (outcome.k !== "unsupported") return;
    const key = `${outcome.feature}@${outcome.at}`; if (!abst.has(key)) abst.set(key, { function: fnName(m.fn), feature: outcome.feature, at: outcome.at, why: outcome.why, phase });
  };

  // ---- honest phase: one layered search to depth + 1; the last layer is buffered until we know whether it is the extension
  const honest = layeredSearch(engine, deepDomain(engine, false), depth + 1, budget, (ev) => {
    recordAbstention(ev, "honest");
    const { pre, m, outcome } = ev; if (outcome.k !== "ok") return; const post = outcome.post;
    for (const k of all) {
      const v = engine.verdict(k, pre, post, m); if (!v) continue;
      const st = layer.stats.get(k.c.id)!;
      if (v === "support") {
        if (isGeneric(m)) layer.genericSupport.set(k.c.id, (layer.genericSupport.get(k.c.id) ?? 0) + 1);
        else { const sig = layer.supportSignatures.get(k.c.id) ?? new Set<string>(); if (sig.size < 2) sig.add(`${fnName(m.fn)}(${m.args.map(fmt).join(",")}){${fmt(m.value)}}`); layer.supportSignatures.set(k.c.id, sig); }
        if (post.approx.length === 0) { st.maintaining++; if (!st.example) st.example = post.seq; }
        else { st.approximatedSupport++; for (const a of post.approx) st.approximatedKinds.add(a.kind); }
      }
      if (v === "violate") {
        st.honestViolations++; st.breakers.add(fnName(m.fn));
        const b = layer.breakers.get(k.c.id) ?? new Map<string, StepRecord[]>(); if (!b.has(fnName(m.fn))) b.set(fnName(m.fn), post.seq); layer.breakers.set(k.c.id, b);
        const f: Found = { k, phase: "honest", pre, post, m };
        if (post.approx.length) { if (layer.tainted.length < 10_000) layer.tainted.push(f); }
        else { if (!layer.clean.has(k.c.id)) layer.clean.set(k.c.id, f); if (anyReporting) addAlternative(layer.alternatives, f); }
        if (rules.designedCycle && k.c.kind === "one-way") { const xs = layer.reversals.get(k.c.id) ?? []; if (xs.length < REVERSAL_CAP) xs.push(post); else layer.reversalOverflow.add(k.c.id); layer.reversals.set(k.c.id, xs); }
      }
      if (k.c.kind === "solvency") {
        const dL = dl(pre, post, k.c.vars[0]!); const dB = post.w.balance - pre.w.balance;
        if (((dL > 0n && dB < 0n) || (dL < 0n && dB > 0n)) && !layer.opposite.has(k.c.id)) layer.opposite.set(k.c.id, post.seq);
      }
    }
    for (const c of conservation) {
      const v = engine.verdict(c.k, pre, post, m); if (!v) continue;
      const dA = dv(pre, post, c.a); const dL = dl(pre, post, c.l);
      for (const t of c.terms) {
        const dT = t.kind === "ledger" ? dl(pre, post, t.name) : dv(pre, post, t.name);
        const ok = t.kind === "scalar-sum" ? dA + dT === dL : dA === dL + dT;
        const id = `${c.k.c.id}|${termId(t)}`;
        if (!ok) layer.inconsistent.add(id); else if (v === "violate" && dT !== 0n) layer.movedOnBreak.add(id);
        if (rules.privilegedRefinement && !staticPrivileged(m)) { if (!ok) layer.inconsistentUnpriv.add(id); else if (v === "violate" && dT !== 0n) layer.movedOnUnprivBreak.add(id); }
      }
      if (rules.unitRatio && v === "violate" && dL !== 0n) layer.ratioTwoSidedBreak.add(c.k.c.id);
    }
    if (rules.unitRatio) for (const c of conservation) {
      // transitions from a state where A != sum(L) that move both sides: do they preserve the ratio A : sum(L), to rounding?
      const A = num(engine.valueOf(pre, c.a)); const L = sumLedger(pre.w, c.l); if (A === L || A === 0n || L === 0n) continue;
      const A2 = num(engine.valueOf(post, c.a)); const L2 = sumLedger(post.w, c.l); if (A2 === A || L2 === L) continue;
      const diff = A2 * L - A * L2; const bound = A > L ? A : L;
      if ((diff < 0n ? -diff : diff) < bound) {
        const p = layer.ratioProportional.get(c.k.c.id) ?? { n: 0, generic: 0, signatures: new Set<string>() }; p.n++;
        if (isGeneric(m)) p.generic++; else if (p.signatures.size < 2) p.signatures.add(`${fnName(m.fn)}(${m.args.map(fmt).join(",")}){${fmt(m.value)}}`);
        layer.ratioProportional.set(c.k.c.id, p);
      } else layer.ratioNonProportional.add(c.k.c.id);
    }
    if (rules.designedCycle) for (const p of engine.phaseVars) { const x = engine.valueOf(post, p); if (typeof x === "bigint" && (!layer.maxima.has(p) || layer.maxima.get(p)! < x)) layer.maxima.set(p, x); }
  }, (k) => { if (k > 1) { mergeInto(main, layer); layer = newEvidence(all.map((x) => x.c.id)); } });
  const extension = honest.fixpoint ? null : layer;
  if (honest.fixpoint) mergeInto(main, layer);
  const accepting = honest.fixpoint ? honest.layers : Math.max(0, honest.layers - 1);
  report.coverage.honest = honest.col.finish();

  // ---- establishment, then the quality rules
  // support through ONE specific boundary or derived argument is coincidence-prone (a counter that moves by 1 "matches" a ledger moved by
  // 1 wei): at least one supporting transition with the generic arguments, or two distinct argument signatures, is required
  const results = establish(report, all, main.stats, q?.minSupport ?? null, (id) => (q && !(main.genericSupport.get(id) ?? 0) && (main.supportSignatures.get(id)?.size ?? 0) < 2
    ? `supported only through one specific boundary or derived argument (${[...(main.supportSignatures.get(id) ?? [])].join("")}): coincidence-prone, not evidence` : null));
  const active = new Set<string>(narrow.map((k) => k.c.id));
  if (q) {
    if (q.refinement) for (const c of conservation) {
      const r = results.get(c.k.c.id)!; if (!r.established || r.quality.honestBreakers.length === 0) continue;
      let explaining = c.terms.filter((t) => !main.inconsistent.has(`${c.k.c.id}|${termId(t)}`) && main.movedOnBreak.has(`${c.k.c.id}|${termId(t)}`));
      let excused = false;
      if (!explaining.length && rules.privilegedRefinement) {
        // privileged refinement: the relation holds on every transition except ones only the deployer can perform (designed adjustments)
        explaining = c.terms.filter((t) => !main.inconsistentUnpriv.has(`${c.k.c.id}|${termId(t)}`) && main.movedOnUnprivBreak.has(`${c.k.c.id}|${termId(t)}`));
        excused = explaining.length > 0;
      }
      if (!explaining.length) continue;
      const best = explaining.find((t) => partitionId(c, t) !== null) ?? explaining[0]!;
      r.established = false; r.quality.explainedBy = relationText(c, best);
      r.dropReason = excused
        ? `explained by refinement, privileged transitions excused: ${relationText(c, best)} holds on every honest transition that touched it except those only the deployer can perform (${[...priv!.values()].map((e) => `${e.function}: ${e.role} at ${e.check.file}:${e.check.line}, ${e.transfer}`).join("; ")}), its unprivileged breakers included`
        : `explained by refinement: ${relationText(c, best)} holds on every honest transition that touched it, its breakers (${r.quality.honestBreakers.join(", ")}) included: value moves between tracked pools by design`;
      for (const t of explaining) { const pid = partitionId(c, t); if (pid) active.add(pid); }
    }
    if (q.direction) for (const k of narrow) if (k.c.kind === "solvency") {
      const r = results.get(k.c.id)!; const s = main.opposite.get(k.c.id); if (!r.established || !s) continue;
      r.established = false; r.dropReason = `not a liability ledger: ${k.c.vars[0]} and the ether held moved in opposite directions in ${s.map((x) => `${x.actor}:${x.call}`).join(" -> ")}`;
    }
    if (rules.unitRatio) for (const c of conservation) {
      const r = results.get(c.k.c.id)!; const id = c.k.c.id; const p = main.ratioProportional.get(id);
      if (!r.established || r.quality.honestBreakers.length === 0 || main.ratioTwoSidedBreak.has(id) || main.ratioNonProportional.has(id) || !p) continue;
      if (p.n < (q.minSupport ?? 2) || (!p.generic && p.signatures.size < 2)) continue;
      r.established = false;
      r.dropReason = `different units: ${c.a} and sum(${c.l}) are related by a ratio, not by equality: the breakers (${r.quality.honestBreakers.join(", ")}) move ${c.a} alone, and all ${p.n} honest transitions that moved both sides from a state where they differ preserved ${c.a} : sum(${c.l}) to rounding`;
    }
    if (rules.designedCycle) for (const k of narrow) if (k.c.kind === "one-way") {
      const r = results.get(k.c.id)!; const xs = main.reversals.get(k.c.id) ?? [];
      if (!r.established || !xs.length || main.reversalOverflow.has(k.c.id)) continue;
      const whys = xs.map((post) => designedCycle(engine, k.c.vars[0]!, post, main.maxima));
      if (whys.some((w) => w === null)) continue;
      r.established = false; r.dropReason = `every honest reversal (${xs.length}) is a designed cycle, e.g. ${whys[0]}`;
    }
  }
  const checks = all.filter((k) => active.has(k.c.id));
  for (const id of [...results.keys()]) if (!active.has(id)) results.delete(id);
  if (q) {
    const live = () => [...results.values()].filter((r) => r.established);
    if (q.depthExtension) for (const r of live()) {
      if (!extension) { r.quality.depthExtension = "passed"; continue; }
      const fresh = [...(extension.breakers.get(r.id) ?? new Map<string, StepRecord[]>()).entries()].filter(([fn]) => !r.quality.honestBreakers.includes(fn));
      if (fresh.length) {
        const [fn, seq] = fresh[0]!;
        r.quality.depthExtension = { rejected: `honestly broken by ${fn} at depth ${seq.length}: ${seq.map((s) => `${s.actor}:${s.call}`).join(" -> ")}` };
        r.established = false; r.dropReason = `depth artefact: holds at depth ${accepting} only; ${fn} breaks it honestly at depth ${seq.length}`;
      } else r.quality.depthExtension = "passed";
    }
    if (q.randomSequences > 0 && live().length) {
      const first = new Map<string, { fn: string; seq: StepRecord[] }>();
      const transitions = randomSequences(engine, RANDOM_HONEST_DOMAIN, q.randomSequences, accepting + 3, q.seed, ({ pre, m, outcome }) => {
        if (outcome.k !== "ok") return;
        for (const k of checks) {
          const r = results.get(k.c.id)!; if (!r.established || first.has(k.c.id)) continue;
          if (engine.verdict(k, pre, outcome.post, m) === "violate" && !r.quality.honestBreakers.includes(fnName(m.fn))) first.set(k.c.id, { fn: fnName(m.fn), seq: outcome.post.seq });
        }
      });
      for (const r of live()) {
        const f = first.get(r.id);
        if (f) { r.quality.randomised = { rejected: `honestly broken by ${f.fn} in a randomised sequence (seed ${q.seed})`, sequence: f.seq }; r.established = false; r.dropReason = `falsified by a randomised honest sequence: ${f.fn} breaks it`; }
        else r.quality.randomised = { sequences: q.randomSequences, seed: q.seed, transitions, passed: true };
      }
    }
  }
  report.candidates = [...results.values()];
  const established = new Set(report.candidates.filter((r) => r.established).map((r) => r.id));
  const clean = new Map([...main.clean].filter(([id]) => active.has(id)));
  const tainted = main.tainted.filter((f) => active.has(f.k.c.id));

  // ---- adversarial phase (established candidates only), the same layered search to the accepting depth
  const adversarial = layeredSearch(engine, deepDomain(engine, true), Math.max(1, accepting), budget, (ev) => {
    recordAbstention(ev, "adversarial");
    const { pre, m, outcome } = ev; if (outcome.k !== "ok") return; const post = outcome.post;
    for (const k of checks) {
      if (!established.has(k.c.id) || engine.verdict(k, pre, post, m) !== "violate") continue;
      const f: Found = { k, phase: "adversarial", pre, post, m };
      if (post.approx.length) { if (tainted.length < 10_000) tainted.push(f); continue; }
      if (!clean.has(k.c.id)) clean.set(k.c.id, f);
      if (anyReporting) addAlternative(main.alternatives, f);
    }
  });
  report.coverage.adversarial = adversarial.col.finish();
  // ---- the reported counterexample per candidate: the first fully modelled one that no reporting rule reclassifies (all rules off: the first)
  const allReclassified = new Set<string>(); // every fully modelled counterexample reclassified: not "withheld by the gate"
  if (anyReporting) {
    const reclassified: Reclassified[] = [];
    const cycleRecord = (id: string, f: Found): Reclassified | null => {
      const why = designedCycle(engine, f.k.c.vars[0]!, f.post, main.maxima);
      return why ? { candidate: id, rule: "designedCycle", breakingFunction: fnName(f.m.fn), sequence: f.post.seq, why, evidence: [] } : null;
    };
    // residual breaker: for a conservation candidate, a counterexample whose breaking transition no one-term refinement accounts for (no
    // tracked pool T that moved with the relation A = sum(L) +/- T holding across it) is reported before one that value moving between
    // tracked pools explains; a stable reordering of the same fully modelled alternatives
    const explained = (f: Found): boolean => {
      const c = conservation.find((x) => x.k.c.id === f.k.c.id); if (!c) return false;
      const dA = dv(f.pre, f.post, c.a); const dL = dl(f.pre, f.post, c.l);
      return c.terms.some((t) => { const dT = t.kind === "ledger" ? dl(f.pre, f.post, t.name) : dv(f.pre, f.post, t.name); return dT !== 0n && (t.kind === "scalar-sum" ? dA + dT === dL : dA === dL + dT); });
    };
    for (const id of [...clean.keys()]) {
      if (!established.has(id)) continue;
      let chosen: Found | null = null;
      const alts = main.alternatives.get(id) ?? [clean.get(id)!];
      const ordered = rules.residualBreaker ? [...alts.filter((f) => !explained(f)), ...alts.filter((f) => explained(f))] : alts;
      for (const f of ordered) {
        const why = (rules.privilegedBreaker ? privilegedBreaker(engine, priv!, id, f.pre, f.post, f.m) : null)
          ?? (rules.privilegedFunding && f.k.c.kind === "actor-value" ? privilegedFunding(engine, priv!, id, f.post) : null)
          ?? (rules.designedCycle && f.k.c.kind === "one-way" ? cycleRecord(id, f) : null);
        if (!why) { chosen = f; break; }
        if (!reclassified.some((x) => x.candidate === id && x.rule === why.rule && x.breakingFunction === why.breakingFunction)) reclassified.push(why);
      }
      if (chosen) clean.set(id, chosen); else { clean.delete(id); allReclassified.add(id); }
    }
    report.reclassified = reclassified;
  }
  engine.checks = checks; // minimisation looks candidates up by id
  const dom = deepDomain(engine, false);
  report.search = {
    strategy: "deep", acceptingDepth: accepting, extensionDepth: extension ? honest.layers : null, fixpoint: honest.fixpoint,
    honestTransitions: honest.col.sequences, adversarialTransitions: adversarial.col.sequences,
    randomTransitions: report.candidates.reduce((s, c) => Math.max(s, typeof c.quality.randomised === "object" && "transitions" in c.quality.randomised ? c.quality.randomised.transitions : 0), 0),
    budget, frontierDropped: { honest: honest.dropped, adversarial: adversarial.dropped }, amounts: dom.amounts.map(fmt), values: dom.values.map(fmt),
  };
  const finished = finishReport(engine, sources, report, results, checks, clean, tainted, abst, options, allReclassified);
  finished.search!.cost = { requested: engine.executions + engine.memoHits, interpreted: engine.executions };
  return { report: finished, engine, collectors: [honest.col, adversarial.col] };
}
export type { CandidateResult };
