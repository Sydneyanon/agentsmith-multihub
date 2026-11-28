/**
 * PROTOTYPE (docs/architecture/apex-first-capability.md §10.2 item 1: state-space coverage). Measures what a search reached instead of
 * assuming it: distinct concrete and abstract states, distinct abstract transitions per function, guards exercised on each side,
 * functions never completed, statements never reached, abstentions, and an explicit list of unexplored regions.
 * Not wired anywhere; imported only by the APEX prototype and its tests.
 */
import type { Expr, FunctionDef, Stmt } from "../../analysis/solidity/parser.js";
import type { Value } from "../../analysis/solidity/simulate.js";
import type { GuardOutcome } from "./fidelity.js";
import type { Engine, Move, Node, StepOutcome } from "./state-explorer-prototype.js";

export type FunctionCoverage = {
  name: string; attempted: number; completed: number; reverted: number; unsupported: string | null; excluded: string | null;
  /** distinct (abstract pre-state -> abstract post-state) transitions this function produced */
  distinctTransitions: number; abstained: string[];
};
export type GuardCoverage = { at: string; kind: "require" | "if"; passed: number; failed: number; status: "both-sides" | "only-passed" | "only-failed" | "never-reached" };
export type Coverage = {
  functions: FunctionCoverage[]; sequences: number; distinctStates: number; abstractStates: number; depth: number; depthReached: number;
  budgetExhausted: boolean; fixpoint: boolean;
  guards: GuardCoverage[]; guardSummary: { total: number; bothSides: number; onlyPassed: number; onlyFailed: number; neverReached: number };
  statements: { total: number; reached: number; unreached: string[] };
  functionsNeverCompleted: string[]; abstentions: string[]; unexplored: string[];
  /** deep strategy: frontier states not expanded because their layer did not fit its share of the budget (0 for the baseline) */
  frontierDropped: number;
};

/** the statements and guards of the code a deployed contract can execute: entry points, modifiers, internal helpers (not constructors) */
export function staticSurface(engine: Engine): { statements: Set<string>; guards: Map<string, "require" | "if"> } {
  const statements = new Set<string>(); const guards = new Map<string, "require" | "if">();
  const bodies: FunctionDef[] = [...engine.fns];
  for (const c of engine.ix.linearize(engine.contract)) {
    bodies.push(...c.modifiers);
    bodies.push(...c.functions.filter((f) => f.kind === "function" && (f.visibility === "internal" || f.visibility === "private")));
  }
  const seen = new Set<Stmt[]>();
  const expr = (e: Expr | null | undefined, file: string): void => {
    if (!e) return;
    switch (e.k) {
      case "call": if (e.fn.k === "id" && (e.fn.name === "require" || e.fn.name === "assert") && e.args[0]) guards.set(`${file}:${e.line}`, "require"); expr(e.fn, file); e.args.forEach((a) => expr(a, file)); Object.values(e.opts).forEach((a) => expr(a, file)); break;
      case "member": expr(e.obj, file); break; case "index": expr(e.obj, file); expr(e.idx, file); break;
      case "unary": case "update": case "delete": expr(e.e, file); break; case "binary": case "assign": expr(e.l, file); expr(e.r, file); break;
      case "ternary": expr(e.c, file); expr(e.a, file); expr(e.b, file); break; case "tuple": e.items.forEach((i) => expr(i, file)); break;
      case "new": e.args.forEach((a) => expr(a, file)); break;
    }
  };
  const walk = (ss: Stmt[], file: string): void => {
    for (const s of ss) {
      statements.add(`${file}:${s.line}`);
      switch (s.k) {
        case "expr": expr(s.e, file); break; case "decl": expr(s.init, file); break; case "return": expr(s.e, file); break;
        case "if": guards.set(`${file}:${s.line}`, "if"); expr(s.cond, file); walk(s.then, file); walk(s.els, file); break;
        case "loop": expr(s.cond, file); walk(s.body, file); break; case "block": walk(s.body, file); break;
        case "try": expr(s.call, file); walk(s.body, file); s.catches.forEach((c) => walk(c, file)); break;
      }
    }
  };
  for (const f of bodies) if (f.body && !seen.has(f.body)) { seen.add(f.body); walk(f.body, f.file); }
  return { statements, guards };
}

const sign = (v: bigint): string => (v === 0n ? "0" : v > 0n ? "+" : "-");
const absValue = (v: Value): string => (typeof v === "bigint" ? sign(v) : typeof v === "boolean" ? String(v) : Array.isArray(v) ? `[${v.map(absValue).join(",")}]` : String(v));
/** abstraction: every number becomes its sign; booleans and addresses are kept; balance, receipts and sends become signs */
const abstractKeys = new WeakMap<Node, string>();
/** nodes are immutable once created, so their abstract keys are memoised */
export function abstractKey(n: Node): string {
  let k = abstractKeys.get(n); if (k === undefined) { k = abstractKeyUncached(n); abstractKeys.set(n, k); } return k;
}
function abstractKeyUncached(n: Node): string {
  return [...n.w.storage.entries()].filter(([k, v]) => !(k.includes("|") && (v === 0n || v === false || v === "zero" || v === null))).map(([k, v]) => `${k}=${absValue(v)}`).sort().join(";") + `#${sign(n.w.balance)}#${sign(n.w.received)}#${sign(n.sentByAttacker)}${n.approx.length ? "#T" : ""}`;
}

export class CoverageCollector {
  sequences = 0; budgetExhausted = false; fixpoint = false; depthReached = 0; frontierDropped = 0;
  readonly concrete = new Set<string>(); readonly abstract = new Set<string>();
  /** distinct `function|abstract pre -> abstract post` transitions */
  readonly transitions = new Set<string>();
  guards = new Map<string, GuardOutcome>(); reached = new Set<string>();
  private readonly perFn = new Map<string, FunctionCoverage & { trans: Set<string> }>();
  constructor(private readonly engine: Engine, private readonly depth: number) {}

  static empty(depth: number): Coverage {
    return { functions: [], sequences: 0, distinctStates: 0, abstractStates: 0, depth, depthReached: 0, budgetExhausted: false, fixpoint: false, guards: [],
      guardSummary: { total: 0, bothSides: 0, onlyPassed: 0, onlyFailed: 0, neverReached: 0 }, statements: { total: 0, reached: 0, unreached: [] }, functionsNeverCompleted: [], abstentions: [], unexplored: [], frontierDropped: 0 };
  }
  start(excluded: Map<string, string>): void {
    this.engine.it.guards = new Map(); this.engine.it.reached = new Set();
    for (const fn of this.engine.fns) {
      const name = fn.name || fn.kind;
      this.perFn.set(name, { name, attempted: 0, completed: 0, reverted: 0, unsupported: null, excluded: excluded.get(name) ?? null, distinctTransitions: 0, abstained: [], trans: new Set() });
    }
  }
  state(n: Node, key: string): void { this.concrete.add(key); this.abstract.add(abstractKey(n)); }
  transition(pre: Node, m: Move, o: StepOutcome): void {
    this.sequences++;
    const row = this.perFn.get(m.fn.name || m.fn.kind)!; row.attempted++;
    if (o.k === "revert") { row.reverted++; return; }
    if (o.k === "unsupported") { row.unsupported = o.why; const a = `abstained(${o.feature}@${o.at})`; if (!row.abstained.includes(a)) row.abstained.push(a); return; }
    row.completed++; const t = `${abstractKey(pre)}->${abstractKey(o.post)}`; row.trans.add(t); this.transitions.add(`${row.name}|${t}`);
  }
  /** copy the interpreter's guard outcomes and reached statements; called by the search as soon as it ends */
  snapshot(): void { this.guards = new Map(this.engine.it.guards); this.reached = new Set(this.engine.it.reached); }
  finish(): Coverage {
    const surface = staticSurface(this.engine);
    const guards: GuardCoverage[] = [...surface.guards.entries()].map(([at, kind]) => {
      const g = this.guards.get(at) ?? { passed: 0, failed: 0 };
      const status: GuardCoverage["status"] = g.passed && g.failed ? "both-sides" : g.passed ? "only-passed" : g.failed ? "only-failed" : "never-reached";
      return { at, kind, passed: g.passed, failed: g.failed, status };
    }).sort((a, b) => a.at.localeCompare(b.at, undefined, { numeric: true }));
    const unreached = [...surface.statements].filter((s) => !this.reached.has(s)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const functions: FunctionCoverage[] = [...this.perFn.values()].map(({ trans, ...r }) => ({ ...r, distinctTransitions: trans.size }));
    const never = functions.filter((f) => f.completed === 0);
    const abstentions = [...new Set(functions.flatMap((f) => f.abstained))];
    const unexplored: string[] = [
      ...never.map((f) => `function ${f.name}: never completed (${f.excluded ?? (f.abstained.length ? f.abstained.join(", ") : f.attempted ? `all ${f.attempted} attempts reverted` : "never attempted")})`),
      ...functions.filter((f) => f.completed > 0 && f.abstained.length).map((f) => `function ${f.name}: completed ${f.completed} time(s) but abstained in other states: ${f.abstained.join(", ")}`),
      ...guards.filter((g) => g.status !== "both-sides").map((g) => `guard ${g.at} (${g.kind}): ${g.status === "never-reached" ? "never reached" : g.status === "only-passed" ? "failing side never taken" : "passing side never taken"}`),
      ...unreached.map((s) => `statement ${s}: never reached`),
      ...(this.budgetExhausted ? [`budget exhausted after ${this.sequences} transitions at depth ${this.depthReached}`] : []),
      ...(this.frontierDropped ? [`${this.frontierDropped} frontier state(s) not expanded (coverage-guided selection under the budget)`] : []),
      ...(this.fixpoint ? [] : [`sequences longer than ${this.depth} transactions not explored`]),
    ];
    return {
      functions, sequences: this.sequences, distinctStates: this.concrete.size, abstractStates: this.abstract.size, depth: this.depth, depthReached: this.depthReached,
      budgetExhausted: this.budgetExhausted, fixpoint: this.fixpoint, guards,
      guardSummary: { total: guards.length, bothSides: guards.filter((g) => g.status === "both-sides").length, onlyPassed: guards.filter((g) => g.status === "only-passed").length, onlyFailed: guards.filter((g) => g.status === "only-failed").length, neverReached: guards.filter((g) => g.status === "never-reached").length },
      statements: { total: surface.statements.size, reached: surface.statements.size - unreached.length, unreached }, functionsNeverCompleted: never.map((f) => f.name), abstentions, unexplored, frontierDropped: this.frontierDropped,
    };
  }
}
