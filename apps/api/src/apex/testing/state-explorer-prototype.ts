/**
 * PROTOTYPE (docs/architecture/apex-first-capability.md §8 and §10). NOT wired into any pipeline, step, worker or engine loop; NOT
 * scored on any frozen corpus; excluded from production builds (`tsconfig.build.json` excludes every `testing/` directory); imported
 * by nothing outside its own tests. Off by default by construction: nothing calls it.
 *
 * Question it answers: can the existing bounded interpreter (`simulate.ts: Interp`, `World`, wrapped by `fidelity.ts: FidelityInterp`)
 * execute bounded multi-call sequences by distinct actors, and can candidate invariants inferred from the protocol model's state roles
 * be (a) supported by honest sequences and (b) violated by a concrete, replayable, FULLY MODELLED sequence?
 *
 * Method:
 *  1. deploy: constructors run base-first by the deployer `owner0`; no artificial seeding (inconsistent seeding was the V1 lesson);
 *  2. candidates from shared facts only: ledgers and aggregates (`stateVariableRoles`, P2), plus scalar phase-like variables;
 *  3. honest phase: breadth-first sequences (length <= depth) where every actor passes ITS OWN address for address parameters; every
 *     transition is recorded per candidate as maintaining, violating or not touching it;
 *  4. invariant quality (§10.2 item 2): a candidate is ESTABLISHED only if it has at least `minSupport` fully modelled honest
 *     transitions that moved both sides of it, and the set of functions that break it honestly does not grow when the honest search
 *     is extended by one step (depth artefact) or replaced by seeded randomised honest sequences with other amounts and lengths;
 *  5. adversarial phase: the same search, but address parameters may name other actors;
 *  6. semantic-fidelity gate (§10.1): a transaction that meets an unsupported feature does not complete and is recorded as
 *     `abstained(<feature>@<file:line>)`; a counterexample whose path touched an approximation is SUPPRESSED and counted per kind;
 *     only fully modelled counterexamples become violations, and only violations become hypothesis drafts;
 *  7. counterexample minimisation (§10.2 item 4): delta-debugging over steps, then argument shrinking, re-checking after each change
 *     that the SAME candidate breaks at the SAME final function for the SAME reason with no approximation on the path;
 *  8. coverage (§10.2 item 1): distinct concrete and abstract states, transitions per function, guards exercised, functions never
 *     completed, statements never reached, abstentions, and an explicit list of unexplored regions.
 * Two search strategies (§11.1): `deep` (default, `deep-explorer.ts`: layered search to depth + 1 under a budget, boundary/constant/state-
 * derived amounts, coverage-guided frontier selection, refinement/direction/coincidence refutation rules) and `baseline` (this file's
 * breadth-first search exactly as at ae41658, kept to measure the difference). Steps 6-7 (gate, minimisation) are one shared function.
 * Nothing here writes to the research store and nothing here is an evaluation: APEX may not validate its own output.
 */
import { ProgramIndex } from "../../analysis/solidity/index.js";
import type { FunctionDef } from "../../analysis/solidity/parser.js";
import { Revert, Unsupported, type Value, type World } from "../../analysis/solidity/simulate.js";
import { namesWithRole, stateVariableRoles } from "../../analysis/solidity/state-roles.js";
import { analyzeSources } from "../../analysis/solidity/specialists.js";
import { Tracer } from "../../analysis/solidity/trace.js";
import { CoverageCollector, type Coverage } from "./coverage.js";
import { exploreDeep } from "./deep-explorer.js";
import { classifyUnsupported, FidelityInterp, type Approximation, type ApproximationKind, type UnsupportedFeature } from "./fidelity.js";

export type { Coverage } from "./coverage.js";
export const PROTOTYPE_GENERATOR = "apex-state-explorer@0-prototype";
export const ETHER = 10n ** 18n;
/** `attacker` is the interpreter's only actor whose ether receipts are counted (World.received); in the honest phase it behaves honestly */
export const ACTORS = ["owner0", "alice", "attacker"] as const;
export type Actor = (typeof ACTORS)[number];
const DEPLOYER: Actor = "owner0";

export type Move = { actor: Actor; fn: FunctionDef; args: Value[]; value: bigint };
export type StepRecord = { actor: Actor; call: string; value: string };
export type InvariantKind = "conservation" | "solvency" | "actor-value" | "one-way" | "partition";
export type Candidate = { id: string; kind: InvariantKind; statement: string; vars: string[] };
export type QualityRecord = {
  /** fully modelled honest transitions that moved both sides of the relation and preserved it */
  support: number; minSupport: number;
  /** functions that broke it in the breadth-first honest phase (fully modelled or not) */
  honestBreakers: string[];
  depthExtension: "not-run" | "passed" | { rejected: string } | "incomplete";
  /** deep strategy only: the single-term refinement that explains every honest transition of this candidate, breakers included */
  explainedBy?: string;
  randomised: "not-run" | { sequences: number; seed: number; transitions: number; passed: true } | { rejected: string; sequence: StepRecord[] };
};
export type CandidateResult = Candidate & {
  established: boolean; maintaining: number; honestViolations: number; example: StepRecord[] | null; dropReason?: string; quality: QualityRecord;
};
export type Minimisation = { original: StepRecord[]; minimised: StepRecord[]; removedSteps: number; shrunkArguments: number; replays: number };
export type Violation = {
  candidate: string; kind: InvariantKind; phase: "honest" | "adversarial"; breakingFunction: string; sequence: StepRecord[]; detail: string;
  reason: string; minimisation: Minimisation | null;
};
export type Suppressed = { candidate: string; phase: "honest" | "adversarial"; breakingFunction: string; sequence: StepRecord[]; approximations: Approximation[] };
export type AbstentionRecord = { function: string; feature: UnsupportedFeature; at: string; why: string; phase: string };
export type HypothesisDraft = {
  generator: string; capabilityFamily: "agentsmith-interpreter"; family: string; claim: string;
  spans: Array<{ file: string; line: number; role: "primary" | "supporting" }>;
  rationale: { invariant: string; counterexample: StepRecord[]; minimisedCounterexample: StepRecord[] | null; supportedBy: { maintainingTransitions: number; example: StepRecord[] | null } };
  fidelity: { fullyModelled: true; approximationsOnPath: 0 };
  independentOfScanners: boolean; priorLeadsOnFunction: string[];
};
export type ExploreReport = {
  contract: string; abstained: string | null; candidates: CandidateResult[]; violations: Violation[]; hypotheses: HypothesisDraft[];
  coverage: { honest: Coverage; adversarial: Coverage };
  /** how the search was run (deep strategy only; absent for the baseline strategy) */
  search?: SearchRecord;
  gate: {
    /** `abstained(<feature>@<file:line>)`, one per distinct feature and location */
    abstentions: AbstentionRecord[];
    /** counterexamples withheld because an approximation was on their path, counted per approximation kind */
    suppressed: { total: number; byKind: Partial<Record<ApproximationKind, number>>; examples: Suppressed[] };
    /** established candidates whose ONLY counterexamples were suppressed: possibly true bugs the gate withheld */
    candidatesWithOnlySuppressedCounterexamples: string[];
    /**
     * every candidate the gate (not the protocol) kept from producing a hypothesis: its only counterexamples were suppressed, or its only
     * honest support touched an approximation. Each may be a true bug the gate withheld; they are counted, never silently dropped.
     */
    withheld: Array<{ candidate: string; why: "only-suppressed-counterexamples" | "support-only-through-approximations"; kinds: ApproximationKind[] }>;
  };
};

export type Domain = { amounts: bigint[]; values: bigint[]; bools: boolean[]; addresses: "self" | "actors" };
export const EXPLORER_DOMAIN = (adversarial: boolean): Domain => ({ amounts: [ETHER], values: [ETHER], bools: [true], addresses: adversarial ? "actors" : "self" });

export type SearchRecord = {
  strategy: "deep"; acceptingDepth: number; extensionDepth: number | null; fixpoint: boolean;
  honestTransitions: number; adversarialTransitions: number; randomTransitions: number; budget: number;
  /** frontier states not expanded because a layer did not fit its share of the budget (coverage-guided selection) */
  frontierDropped: { honest: number; adversarial: number };
  amounts: string[]; values: string[];
};
export type ExploreOptions = {
  /**
   * `deep` (default): layered breadth-first search to depth + 1 under a transition budget, with boundary, constant-derived and
   * state-derived amounts, coverage-guided frontier selection, and refutation of candidates explained by a single-term refinement
   * (`deep-explorer.ts`). `baseline`: the explorer exactly as it was at ae41658, kept to measure the difference.
   */
  strategy?: "deep" | "baseline";
  /** baseline: the breadth-first depth. deep: the accepting depth; layer depth + 1 is the depth-extension check. */
  depth?: number;
  /** transitions per search (baseline default 50 000; deep default 6 000 for the honest search, the same again for the adversarial one) */
  maxSequences?: number;
  /** invariant-quality rules (§10.2 item 2); `false` restores the bare sensitivity rule (support > 0), kept only to measure the difference */
  quality?: false | {
    minSupport?: number; randomSequences?: number; randomLength?: number; seed?: number; depthExtension?: boolean;
    /** deep only: refutation by a single-term refinement, and the partition candidates it yields (default true) */
    refinement?: boolean;
    /** deep only: refutation of a solvency candidate whose ledger moves against the ether held (default true) */
    direction?: boolean;
  };
  minimise?: boolean;
};

export type Node = { w: World; sentByAttacker: bigint; seq: StepRecord[]; moves: Move[]; approx: Approximation[] };
export type StepOutcome =
  | { k: "ok"; post: Node; tx: Approximation[] }
  | { k: "revert"; why: string }
  | { k: "unsupported"; feature: UnsupportedFeature; at: string; why: string };
export type Verdict = "support" | "maintain" | "violate" | null;
export type Check = {
  c: Candidate; holds: (n: Node) => boolean; touched: (pre: Node, post: Node) => boolean; supports: (pre: Node, post: Node) => boolean;
  transitionOk?: (pre: Node, post: Node, m: Move) => boolean; reason: (pre: Node, post: Node) => string;
};

export const fmt = (v: Value): string => (typeof v === "bigint" ? (v !== 0n && v % ETHER === 0n ? `${v / ETHER}e18` : String(v)) : Array.isArray(v) ? `[${v.map(fmt).join(",")}]` : String(v));
export const fnName = (fn: FunctionDef): string => fn.name || fn.kind;
export const stepOf = (m: Move): StepRecord => ({ actor: m.actor, call: `${fnName(m.fn)}(${m.args.map(fmt).join(", ")})`, value: fmt(m.value) });

export function argsFor(fn: FunctionDef, actor: Actor, d: Domain): Value[][] | null {
  // address parameters are the actor itself (honest) or, adversarially, any actor
  const choices: Value[][] = [];
  for (const p of fn.params) {
    if (/^u?int/.test(p.type)) choices.push(d.amounts);
    else if (/^address/.test(p.type)) choices.push(d.addresses === "actors" ? [...ACTORS] : [actor]);
    else if (/^bool/.test(p.type)) choices.push(d.bools);
    else return null;
  }
  let out: Value[][] = [[]];
  for (const c of choices) out = out.flatMap((prefix) => c.map((v) => [...prefix, v]));
  return out;
}

/** a mapping entry holding its type default is indistinguishable from an unwritten one (mappings have no initialiser) */
export const isDefaultMappingEntry = (k: string, v: Value): boolean => k.includes("|") && (v === 0n || v === false || v === "zero" || v === null);
export function stateKey(n: Node): string {
  return [...n.w.storage.entries()].filter(([k, v]) => !isDefaultMappingEntry(k, v)).map(([k, v]) => `${k}=${fmt(v)}`).sort().join(";") + `#${n.w.balance}#${n.w.received}#${n.sentByAttacker}${n.approx.length ? "#T" : ""}`;
}

export function sumLedger(w: World, ledger: string): bigint {
  let s = 0n; for (const [k, v] of w.storage) if (k.startsWith(`${ledger}|`) && typeof v === "bigint") s += v; return s;
}

/** One deployed contract under the instrumented interpreter: deployment, candidates, and single-transition execution. */
export class Engine {
  readonly ix: ProgramIndex; readonly fns: FunctionDef[]; readonly it: FidelityInterp;
  abstained: string | null = null; root: Node | null = null; checks: Check[] = [];
  /** shared facts kept for the deep strategy: ledgers and aggregates (P2), and every non-constant uint state variable */
  ledgers: string[] = []; aggregates: string[] = []; uintScalars: string[] = [];
  readonly deployedValues = new Map<string, Value>();
  constructor(readonly sources: ReadonlyArray<{ path: string; text: string }>, readonly contract: string) {
    this.ix = new ProgramIndex(sources);
    this.fns = this.ix.deployedEntryPoints(contract);
    this.it = new FidelityInterp(this.ix, contract, { reenter: [], maxDepth: 0, callbacks: false }, new Set(ACTORS));
    if (!this.fns.length) { this.abstained = "no state-changing entry points"; return; }
    this.it.entryFn = this.fns[0]!;
    this.buildChecks();
    this.deploy();
  }

  private buildChecks(): void {
    const { ix, contract, fns } = this;
    // ---- shared facts: state roles (P2), the same derivation the validator and the protocol model use
    const traces = new Map<FunctionDef, ReturnType<Tracer["run"]>>();
    const roles = stateVariableRoles(ix, (f) => { let t = traces.get(f); if (!t) { t = new Tracer(ix).run(f); traces.set(f, t); } return t; }, contract);
    const ledgers = namesWithRole(roles, "ledger"); const aggregates = namesWithRole(roles, "aggregate");
    this.ledgers = ledgers; this.aggregates = aggregates;
    this.uintScalars = ix.linearize(contract).flatMap((c) => c.stateVars).filter((v) => !v.constant && !v.immutable && /^uint\d*$/.test(v.type.trim())).map((v) => v.name);
    const handlesEther = fns.some((f) => f.mutability === "payable");
    // phase-like scalars only: a bool/uint (not an aggregate) that some entry point READS IN A GUARD, so the protocol branches on it
    const guardReads = new Set(fns.flatMap((f) => new Tracer(ix).run(f).events.flatMap((e) => (e.k === "guard" ? e.reads : []))));
    const scalar = ix.linearize(contract).flatMap((c) => c.stateVars).filter((v) => !v.constant && !v.immutable && /^(bool|u?int\d*)$/.test(v.type.trim()) && !aggregates.includes(v.name) && guardReads.has(v.name));
    this.phaseVars = [...scalar.map((v) => v.name), ...aggregates];
    // an unwritten slot reads as its declared value or type default (as the interpreter reads it), so `closed = false` on a fresh slot is no change
    const val = (n: Node, name: string): Value => this.valueOf(n, name);
    const num = (v: Value): bigint => (typeof v === "bigint" ? v : 0n);
    const checks: Check[] = [];
    for (const a of aggregates) for (const l of ledgers) checks.push({
      c: { id: `conservation:${a}=sum(${l})`, kind: "conservation", statement: `${a} == sum over accounts of ${l}[account]`, vars: [a, l] },
      holds: (n) => num(val(n, a)) === sumLedger(n.w, l),
      touched: (p, q) => val(p, a) !== val(q, a) || sumLedger(p.w, l) !== sumLedger(q.w, l),
      supports: (p, q) => val(p, a) !== val(q, a) && sumLedger(p.w, l) !== sumLedger(q.w, l),
      reason: (_p, q) => `${a} ${num(val(q, a)) > sumLedger(q.w, l) ? ">" : "<"} sum(${l})`,
    });
    if (handlesEther) for (const l of ledgers) checks.push({
      c: { id: `solvency:balance>=sum(${l})`, kind: "solvency", statement: `address(this).balance >= sum over accounts of ${l}[account]`, vars: [l] },
      holds: (n) => n.w.balance >= sumLedger(n.w, l),
      touched: (p, q) => sumLedger(p.w, l) !== sumLedger(q.w, l) || p.w.balance !== q.w.balance,
      supports: (p, q) => sumLedger(p.w, l) !== sumLedger(q.w, l) && p.w.balance !== q.w.balance,
      reason: () => `balance < sum(${l})`,
    });
    if (handlesEther) checks.push({
      c: { id: "actor-value:attacker-net<=0", kind: "actor-value", statement: "the observed actor never receives more ether from the contract than it sent to it", vars: [] },
      holds: (n) => n.w.received <= n.sentByAttacker,
      touched: (p, q) => p.w.received !== q.w.received || p.sentByAttacker !== q.sentByAttacker,
      supports: (p, q) => p.w.received !== q.w.received,
      reason: () => "observed actor received > sent",
    });
    for (const v of scalar) checks.push({
      // one-way: once moved away from its deployed value, only the deployer may move it back toward that value
      c: { id: `one-way:${v.name}`, kind: "one-way", statement: `${v.name} never returns toward its deployed value except by the deployer`, vars: [v.name] },
      holds: () => true,
      touched: (p, q) => val(p, v.name) !== val(q, v.name),
      supports: (p, q) => val(p, v.name) !== val(q, v.name),
      transitionOk: (p, q, m) => {
        if (m.actor === DEPLOYER) return true;
        const before = val(p, v.name); const after = val(q, v.name); const init = this.deployedValues.get(v.name) ?? null;
        if (before === after || before === init) return true;
        if (typeof before === "bigint" && typeof after === "bigint" && typeof init === "bigint") return !(after < before && init < before) && !(after > before && init > before);
        return after !== init;
      },
      reason: () => `${v.name} moved back toward its deployed value by a non-deployer`,
    });
    this.checks = checks;
  }
  private phaseVars: string[] = [];
  /** a scalar's value in a state: an unwritten slot reads as its deployed value or type default, as the interpreter reads it */
  valueOf(n: Node, name: string): Value { return n.w.storage.has(name) ? (n.w.storage.get(name) ?? null) : (this.deployedValues.get(name) ?? null); }

  private deploy(): void {
    const { ix, contract, it } = this;
    it.beginTransaction();
    try {
      for (const c of [...ix.linearize(contract)].reverse()) {
        const ctor = c.functions.find((f) => f.kind === "constructor"); if (!ctor?.body) continue;
        const args = argsFor(ctor, DEPLOYER, EXPLORER_DOMAIN(false)); if (!args) throw new Unsupported(`constructor parameters of ${c.name}`);
        it.runFunction(ctor, contract, args[0]!, DEPLOYER, 0n);
      }
    } catch (e) {
      if (e instanceof Revert) { this.abstained = `deployment not modelled: ${e.why}`; return; }
      if (e instanceof Unsupported) { this.abstained = `deployment not modelled: ${e.why} (abstained(${classifyUnsupported(e.why)}@${it.whereOf(e)}))`; return; }
      throw e;
    }
    const deployApprox = [...it.approximations];
    it.w.trace = [];
    const w = it.w.clone();
    this.root = { w, sentByAttacker: 0n, seq: [], moves: [], approx: deployApprox };
    for (const name of new Set([...this.phaseVars, ...this.uintScalars])) { try { it.w.restore(w); this.deployedValues.set(name, it.readVar(name, [])); } catch { this.deployedValues.set(name, null); } }
  }

  moves(d: Domain): { moves: Move[]; excluded: Map<string, string> } {
    const moves: Move[] = []; const excluded = new Map<string, string>();
    for (const fn of this.fns) for (const actor of ACTORS) {
      const variants = argsFor(fn, actor, d); if (!variants) { excluded.set(fnName(fn), "parameter types not modelled"); continue; }
      for (const args of variants) for (const value of fn.mutability === "payable" ? d.values : [0n]) moves.push({ actor, fn, args, value });
    }
    return { moves, excluded };
  }

  step(pre: Node, m: Move): StepOutcome {
    const it = this.it;
    it.w.restore(pre.w); it.w.balance += m.value; // the EVM credits msg.value before the call executes
    it.beginTransaction();
    try { it.runFunction(m.fn, this.contract, m.args, m.actor, m.value); }
    catch (e) {
      if (e instanceof Revert) return { k: "revert", why: e.why };
      if (e instanceof Unsupported) return { k: "unsupported", feature: classifyUnsupported(e.why), at: it.whereOf(e), why: e.why };
      throw e;
    }
    const tx = [...it.approximations];
    const post: Node = { w: it.w.clone(), sentByAttacker: pre.sentByAttacker + (m.actor === "attacker" ? m.value : 0n), seq: [...pre.seq, stepOf(m)], moves: [...pre.moves, m], approx: [...pre.approx, ...tx] };
    return { k: "ok", post, tx };
  }

  verdict(k: Check, pre: Node, post: Node, m: Move): Verdict {
    if (!k.touched(pre, post)) return null;
    if (!k.holds(pre)) return null; // only transitions from a state where the candidate held say anything about it
    const ok = k.holds(post) && (k.transitionOk ? k.transitionOk(pre, post, m) : true);
    if (ok) return k.supports(pre, post) ? "support" : "maintain";
    return "violate";
  }

  /** replay a sequence from the deployed state; null if any step reverts or is unsupported */
  replay(moves: Move[]): Array<{ pre: Node; post: Node; m: Move }> | null {
    let cur = this.root!; const out: Array<{ pre: Node; post: Node; m: Move }> = [];
    for (const m of moves) { const r = this.step(cur, m); if (r.k !== "ok") return null; out.push({ pre: cur, post: r.post, m }); cur = r.post; }
    return out;
  }
}

/** a transition event seen by a search */
export type TransitionEvent = { pre: Node; m: Move; outcome: StepOutcome };

/** bounded breadth-first search with state merging; shortest sequences first */
export function bfs(engine: Engine, d: Domain, depth: number, maxSequences: number, onTransition: (ev: TransitionEvent) => void): CoverageCollector {
  const { moves, excluded } = engine.moves(d);
  const col = new CoverageCollector(engine, depth); col.start(excluded);
  const root = engine.root!;
  const seen = new Set<string>([stateKey(root)]); col.state(root, stateKey(root)); let frontier: Node[] = [root];
  let d0 = 0;
  for (let k = 1; k <= depth && frontier.length; k++) {
    d0 = k; const next: Node[] = [];
    for (const pre of frontier) {
      for (const m of moves) {
        if (col.sequences >= maxSequences) { col.budgetExhausted = true; break; }
        const outcome = engine.step(pre, m); col.transition(pre, m, outcome); onTransition({ pre, m, outcome });
        if (outcome.k !== "ok") continue;
        const key = stateKey(outcome.post); if (seen.has(key)) continue; seen.add(key); col.state(outcome.post, key); next.push(outcome.post);
      }
      if (col.budgetExhausted) break;
    }
    frontier = next;
  }
  col.fixpoint = frontier.length === 0 && !col.budgetExhausted;
  col.depthReached = d0; col.snapshot();
  return col;
}

/** mulberry32: a small seeded PRNG, so randomised sequences are reproducible */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** honest randomised sequences use OTHER amounts and values than the breadth-first phase, and longer sequences */
export const RANDOM_HONEST_DOMAIN: Domain = { amounts: [1n, ETHER / 2n, ETHER, 2n * ETHER, 3n * ETHER], values: [0n, 1n, ETHER / 2n, ETHER, 2n * ETHER], bools: [true, false], addresses: "self" };

export function randomSequences(engine: Engine, d: Domain, count: number, length: number, seed: number, onTransition: (ev: TransitionEvent, seqIndex: number) => void): number {
  const { moves } = engine.moves(d); const rnd = prng(seed); let transitions = 0;
  if (!moves.length) return 0;
  for (let s = 0; s < count; s++) {
    let cur = engine.root!;
    for (let i = 0; i < length; i++) {
      const m = moves[Math.floor(rnd() * moves.length)]!;
      const outcome = engine.step(cur, m); transitions++; onTransition({ pre: cur, m, outcome }, s);
      if (outcome.k === "ok") cur = outcome.post;
    }
  }
  return transitions;
}

/**
 * Delta-debugging of a counterexample (§10.2 item 4): remove chunks of steps (ddmin over complements), then shrink arguments, keeping a
 * change only if the replay (a) completes every step, (b) has NO approximation anywhere on its path (deployment included), and (c)
 * first breaks the SAME candidate at the LAST step, in the SAME function, for the SAME reason. Both sequences are returned.
 */
export function minimiseCounterexample(engine: Engine, candidateId: string, moves: Move[]): { moves: Move[]; record: Minimisation } | null {
  const k = engine.checks.find((x) => x.c.id === candidateId); if (!k) return null;
  let replays = 0;
  const signature = (seq: Move[]): string | null => {
    replays++;
    if (!seq.length) return null;
    const path = engine.replay(seq); if (!path) return null;
    if (engine.root!.approx.length || path.some((t) => t.post.approx.length > t.pre.approx.length)) return null;
    for (let i = 0; i < path.length; i++) {
      const t = path[i]!; const v = engine.verdict(k, t.pre, t.post, t.m);
      if (v === "violate") return i === path.length - 1 ? `${fnName(t.m.fn)}|${k.reason(t.pre, t.post)}` : null;
    }
    return null;
  };
  const target = signature(moves); if (!target) return null;
  let cur = [...moves]; let n = 2;
  while (cur.length >= 2) {
    const size = Math.ceil(cur.length / n); let reduced = false;
    for (let i = 0; i < n; i++) {
      const complement = [...cur.slice(0, i * size), ...cur.slice((i + 1) * size)];
      if (complement.length && complement.length < cur.length && signature(complement) === target) { cur = complement; n = Math.max(n - 1, 2); reduced = true; break; }
    }
    if (!reduced) { if (n >= cur.length) break; n = Math.min(n * 2, cur.length); }
  }
  let shrunk = 0;
  for (let i = 0; i < cur.length; i++) {
    const m = cur[i]!;
    for (let a = 0; a < m.args.length; a++) {
      const v = m.args[a];
      const tries: Value[] = typeof v === "bigint" && v > 1n ? [1n] : typeof v === "string" && v !== m.actor ? [m.actor] : [];
      for (const t of tries) {
        const args = [...m.args]; args[a] = t; const cand = [...cur]; cand[i] = { ...cur[i]!, args };
        if (signature(cand) === target) { cur = cand; shrunk++; break; }
      }
    }
    if (cur[i]!.value > 1n) { const cand = [...cur]; cand[i] = { ...cur[i]!, value: 1n }; if (signature(cand) === target) { cur = cand; shrunk++; } }
  }
  return { moves: cur, record: { original: moves.map(stepOf), minimised: cur.map(stepOf), removedSteps: moves.length - cur.length, shrunkArguments: shrunk, replays } };
}

export function exploreStateInvariants(sources: ReadonlyArray<{ path: string; text: string }>, contract: string, options: ExploreOptions = {}): ExploreReport {
  return (options.strategy ?? "deep") === "baseline" ? exploreBaseline(sources, contract, options) : exploreDeep(sources, contract, options).report;
}

export type Stat = { maintaining: number; approximatedSupport: number; approximatedKinds: Set<ApproximationKind>; honestViolations: number; example: StepRecord[] | null; breakers: Set<string> };
export type Found = { k: Check; phase: "honest" | "adversarial"; pre: Node; post: Node; m: Move };
export const newStat = (): Stat => ({ maintaining: 0, approximatedSupport: 0, approximatedKinds: new Set(), honestViolations: 0, example: null, breakers: new Set<string>() });

/** establishment from honest-phase statistics: minimum support, and the gate's "withheld" record when only approximated support exists */
export function establish(report: ExploreReport, checks: Check[], stats: Map<string, Stat>, minSupportOpt: number | null, coincidental: (id: string) => string | null = () => null): Map<string, CandidateResult> {
  const results = new Map<string, CandidateResult>();
  for (const k of checks) {
    const st = stats.get(k.c.id)!;
    const quality: QualityRecord = { support: st.maintaining, minSupport: minSupportOpt ?? 1, honestBreakers: [...st.breakers].sort(), depthExtension: "not-run", randomised: "not-run" };
    const r: CandidateResult = { ...k.c, established: st.maintaining >= (minSupportOpt ?? 1), maintaining: st.maintaining, honestViolations: st.honestViolations, example: st.example, quality };
    const minSupport = minSupportOpt ?? 1;
    // deep strategy only: support that exists only through boundary or derived amounts is not evidence, approximated or not (never "withheld")
    const why = st.maintaining + st.approximatedSupport >= minSupport ? coincidental(k.c.id) : null;
    if (why) { r.established = false; r.dropReason = why; results.set(k.c.id, r); continue; }
    if (!r.established && st.maintaining + st.approximatedSupport >= minSupport) {
      // the gate, not the protocol, removed the evidence: count it as withheld (it may hide a true bug)
      r.dropReason = `support only through transitions that touched an approximation (${[...st.approximatedKinds].sort().join(", ")}): not trusted`;
      report.gate.withheld.push({ candidate: k.c.id, why: "support-only-through-approximations", kinds: [...st.approximatedKinds].sort() as ApproximationKind[] });
    } else if (!r.established) r.dropReason = st.maintaining === 0
      ? (st.honestViolations > 0 ? "never preserved by any honest transition: not an invariant of this protocol" : "never exercised by honest sequences: vacuous")
      : `exercised by only ${st.maintaining} fully modelled honest transition(s) moving both sides; at least ${minSupport} required`;
    results.set(k.c.id, r);
  }
  return results;
}

/**
 * The semantic-fidelity gate and everything after it, shared by both strategies so that the gate is literally the same code: abstentions,
 * suppressed counterexamples counted per kind, withheld candidates, violations from fully modelled sequences only, minimisation, and
 * hypothesis drafts with the independence marker.
 */
export function finishReport(engine: Engine, sources: ReadonlyArray<{ path: string; text: string }>, report: ExploreReport, results: Map<string, CandidateResult>, checks: Check[],
  clean: Map<string, Found>, tainted: Found[], abst: Map<string, AbstentionRecord>, options: ExploreOptions): ExploreReport {
  const { contract } = report; const { fns } = engine;
  const established = new Set(report.candidates.filter((r) => r.established).map((r) => r.id));
  // ---- the gate: abstentions, suppressed counterexamples, then violations from fully modelled sequences only
  report.gate.abstentions = [...abst.values()];
  const seenSup = new Set<string>();
  for (const f of tainted) {
    if (!established.has(f.k.c.id)) continue;
    const id = `${f.k.c.id}|${f.post.seq.map((s) => `${s.actor}:${s.call}:${s.value}`).join(">")}`; if (seenSup.has(id)) continue; seenSup.add(id);
    report.gate.suppressed.total++;
    for (const kind of new Set(f.post.approx.map((a) => a.kind))) report.gate.suppressed.byKind[kind] = (report.gate.suppressed.byKind[kind] ?? 0) + 1;
    if (report.gate.suppressed.examples.length < 20) report.gate.suppressed.examples.push({ candidate: f.k.c.id, phase: f.phase, breakingFunction: fnName(f.m.fn), sequence: f.post.seq, approximations: f.post.approx });
  }
  report.gate.candidatesWithOnlySuppressedCounterexamples = [...established].filter((id) => !clean.has(id) && tainted.some((t) => t.k.c.id === id)).sort();
  for (const id of report.gate.candidatesWithOnlySuppressedCounterexamples) report.gate.withheld.push({ candidate: id, why: "only-suppressed-counterexamples", kinds: [...new Set(tainted.filter((t) => t.k.c.id === id).flatMap((t) => t.post.approx.map((a) => a.kind)))].sort() });
  // honest-phase counterexamples are kept over adversarial ones for the same candidate (they were found first, and are shorter or equal)
  for (const k of checks) {
    const f = clean.get(k.c.id); if (!f || !established.has(k.c.id)) continue;
    if (f.post.approx.length) continue; // unreachable by construction; kept as the gate's last line
    const min = options.minimise === false ? null : minimiseCounterexample(engine, k.c.id, f.post.moves);
    report.violations.push({
      candidate: k.c.id, kind: k.c.kind, phase: f.phase, breakingFunction: fnName(f.m.fn), sequence: f.post.seq, reason: k.reason(f.pre, f.post),
      detail: k.c.kind === "actor-value" ? `observed actor received ${fmt(f.post.w.received)} having sent ${fmt(f.post.sentByAttacker)}` : `${k.c.statement} fails after the last step`,
      minimisation: min?.record ?? null,
    });
  }

  // ---- hypothesis drafts, with the "independent of scanners" marker computed against the specialists' leads (Slither is not run here)
  const prior = analyzeSources(sources).findings;
  for (const v of report.violations) {
    const fn = fns.find((f) => fnName(f) === v.breakingFunction)!;
    const onFn = prior.filter((f) => f.contract === contract && f.function === v.breakingFunction).map((f) => `solidity-structural-specialists@1:${f.class}`);
    const steps = [...new Set(v.sequence.map((s) => s.call.split("(")[0]!))].filter((n) => n !== v.breakingFunction);
    const r = results.get(v.candidate)!;
    report.hypotheses.push({
      generator: PROTOTYPE_GENERATOR, capabilityFamily: "agentsmith-interpreter", family: `apex-invariant-${v.kind}`,
      claim: `${contract}.${v.breakingFunction}: the sequence ${v.sequence.map((s) => `${s.actor}:${s.call}`).join(" -> ")} violates the inferred invariant "${r.statement}"`,
      spans: [{ file: fn.file, line: fn.startLine, role: "primary" }, ...steps.flatMap((n) => { const g = fns.find((f) => f.name === n); return g ? [{ file: g.file, line: g.startLine, role: "supporting" as const }] : []; })],
      rationale: { invariant: r.statement, counterexample: v.sequence, minimisedCounterexample: v.minimisation?.minimised ?? null, supportedBy: { maintainingTransitions: r.maintaining, example: r.example } },
      fidelity: { fullyModelled: true, approximationsOnPath: 0 },
      independentOfScanners: onFn.length === 0, priorLeadsOnFunction: onFn,
    });
  }
  return report;
}
/** the explorer exactly as it was at ae41658 (strategy "baseline"): breadth-first depth 3, one amount, depth-extension and randomised rules */
export function exploreBaseline(sources: ReadonlyArray<{ path: string; text: string }>, contract: string, options: ExploreOptions = {}): ExploreReport {
  const depth = options.depth ?? 3; const maxSequences = options.maxSequences ?? 50_000;
  const q = options.quality === false ? null : { minSupport: 2, randomSequences: 200, randomLength: depth + 3, seed: 1, depthExtension: true, ...(options.quality ?? {}) };
  const engine = new Engine(sources, contract);
  const emptyCov = (): Coverage => CoverageCollector.empty(depth);
  const report: ExploreReport = {
    contract, abstained: engine.abstained, candidates: [], violations: [], hypotheses: [], coverage: { honest: emptyCov(), adversarial: emptyCov() },
    gate: { abstentions: [], suppressed: { total: 0, byKind: {}, examples: [] }, candidatesWithOnlySuppressedCounterexamples: [], withheld: [] },
  };
  if (engine.abstained || !engine.root) return report;
  const { checks } = engine;

  const stats = new Map<string, Stat>(checks.map((k) => [k.c.id, newStat()]));
  const clean = new Map<string, Found>(); const tainted: Found[] = [];
  const abst = new Map<string, AbstentionRecord>();
  const visitor = (phase: "honest" | "adversarial", only: Set<string> | null) => (ev: TransitionEvent) => {
    const { pre, m, outcome } = ev;
    if (outcome.k === "unsupported") { const key = `${outcome.feature}@${outcome.at}`; if (!abst.has(key)) abst.set(key, { function: fnName(m.fn), feature: outcome.feature, at: outcome.at, why: outcome.why, phase }); return; }
    if (outcome.k !== "ok") return;
    const post = outcome.post;
    for (const k of checks) {
      if (only && !only.has(k.c.id)) continue;
      const v = engine.verdict(k, pre, post, m); if (!v) continue;
      const st = stats.get(k.c.id)!;
      if (v !== "violate") {
        if (phase === "honest" && v === "support") {
          if (post.approx.length === 0) { st.maintaining++; if (!st.example) st.example = post.seq; }
          else { st.approximatedSupport++; for (const a of post.approx) st.approximatedKinds.add(a.kind); }
        }
        continue;
      }
      if (phase === "honest") { st.honestViolations++; st.breakers.add(fnName(m.fn)); }
      const f: Found = { k, phase, pre, post, m };
      if (post.approx.length) { if (tainted.length < 10_000) tainted.push(f); continue; }
      if (!clean.has(k.c.id)) clean.set(k.c.id, f);
    }
  };

  // ---- honest phase
  const honestCol = bfs(engine, EXPLORER_DOMAIN(false), depth, maxSequences, visitor("honest", null));
  report.coverage.honest = honestCol.finish();

  // ---- establishment and invariant quality
  const results = establish(report, checks, stats, q?.minSupport ?? null);
  if (q) {
    const live = () => [...results.values()].filter((r) => r.established);
    // (a) depth artefact: extend the honest search by one step; a NEW honest breaker means the verdict depended on the explored depth
    if (q.depthExtension && live().length) {
      const breakers = new Map<string, Map<string, StepRecord[]>>();
      const col = bfs(engine, EXPLORER_DOMAIN(false), depth + 1, maxSequences, ({ pre, m, outcome }) => {
        if (outcome.k !== "ok") return;
        for (const k of checks) if (engine.verdict(k, pre, outcome.post, m) === "violate") {
          const b = breakers.get(k.c.id) ?? new Map<string, StepRecord[]>(); if (!b.has(fnName(m.fn))) b.set(fnName(m.fn), outcome.post.seq); breakers.set(k.c.id, b);
        }
      });
      for (const r of live()) {
        if (col.budgetExhausted) { r.quality.depthExtension = "incomplete"; r.established = false; r.dropReason = `depth-extension check (depth ${depth + 1}) did not complete within the budget`; continue; }
        const fresh = [...(breakers.get(r.id) ?? new Map<string, StepRecord[]>()).entries()].filter(([fn]) => !r.quality.honestBreakers.includes(fn));
        if (fresh.length) {
          const [fn, seq] = fresh[0]!;
          r.quality.depthExtension = { rejected: `honestly broken by ${fn} at depth ${seq.length}: ${seq.map((s) => `${s.actor}:${s.call}`).join(" -> ")}` };
          r.established = false; r.dropReason = `depth artefact: holds at depth ${depth} only; ${fn} breaks it honestly at depth ${seq.length}`;
        } else r.quality.depthExtension = "passed";
      }
    }
    // (b) randomised honest sequences (seeded), other amounts and longer than the accepting search
    if (q.randomSequences > 0 && live().length) {
      const first = new Map<string, { fn: string; seq: StepRecord[] }>();
      const transitions = randomSequences(engine, RANDOM_HONEST_DOMAIN, q.randomSequences, q.randomLength, q.seed, ({ pre, m, outcome }) => {
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

  // ---- adversarial phase (established candidates only)
  const adversarialCol = bfs(engine, EXPLORER_DOMAIN(true), depth, maxSequences, visitor("adversarial", established));
  report.coverage.adversarial = adversarialCol.finish();

  return finishReport(engine, sources, report, results, checks, clean, tainted, abst, options);
}
