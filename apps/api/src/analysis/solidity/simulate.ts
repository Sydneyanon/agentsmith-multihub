import type { ProgramIndex } from "./index.js";
import { exprText, type Expr, type FunctionDef, type Stmt } from "./parser.js";

/**
 * Independent validation of a reentrancy lead by EXECUTION of a modelled contract, not by pattern matching.
 * It interprets the statements of the function (checked 0.8 arithmetic, mappings, modifiers, internal helpers, low-level calls with
 * value), lets an attacker contract re-enter on every call that forwards gas to it, and compares the ether the attacker extracts
 * with the best an honest sequence of the same calls could extract. If the re-entrant run yields strictly more, the lead is
 * VALIDATED with a concrete trace; if every bounded scenario fails to, it is REFUTED with the reason; if the interpreter meets
 * something it does not model, it ABSTAINS. It never reports a verified vulnerability: the model is a bounded abstraction.
 */
type Value = bigint | boolean | string | Value[] | null;
class Revert extends Error { constructor(readonly why: string) { super(why); } }
export class Unsupported extends Error { constructor(readonly why: string) { super(why); } }
type Signal = { kind: "next" } | { kind: "return"; value: Value };

const ETHER = 10n ** 18n; const MAX = 2n ** 256n;
export type SimOutcome = { verdict: "validated" | "refuted" | "inconclusive"; reason: string; trace: string[]; scenarios: number; detail: Record<string, string | number | boolean> };

type Frame = { fn: FunctionDef; contract: string; sender: string; value: bigint; locals: Map<string, Value>; unchecked: boolean };

class World {
  storage = new Map<string, Value>(); balance = 0n; received = 0n; payouts = 0; trace: string[] = []; steps = 0;
  clone(): World { const w = new World(); w.storage = new Map(this.storage); w.balance = this.balance; w.received = this.received; w.payouts = this.payouts; w.trace = [...this.trace]; w.steps = this.steps; return w; }
  restore(o: World): void { this.storage = new Map(o.storage); this.balance = o.balance; this.received = o.received; this.payouts = o.payouts; this.trace = [...o.trace]; this.steps = o.steps; }
}

type Plan = { reenter: Array<{ fn: FunctionDef; args: Value[] }>; maxDepth: number; callbacks: boolean };

class Interp {
  w = new World(); depth = 0; plan: Plan; entryFn: FunctionDef | null = null;
  constructor(private readonly ix: ProgramIndex, private readonly contract: string, plan: Plan) { this.plan = plan; }

  key(name: string, ks: Value[]): string { return [name, ...ks.map((k) => String(k))].join("|"); }
  defaultFor(type: string): Value { if (/^mapping/.test(type)) { const last = type.replace(/\s+/g, " ").split("=>").pop() ?? ""; return this.defaultFor(last.replace(/[) ]*$/g, "").trim()); } if (/^u?int/.test(type)) return 0n; if (/^bool/.test(type)) return false; if (/^address/.test(type)) return "zero"; return null; }

  readVar(name: string, ks: Value[]): Value {
    const sv = this.ix.stateVar(this.contract, name); if (!sv) throw new Unsupported(`unknown identifier ${name}`);
    const k = this.key(name, ks); if (this.w.storage.has(k)) return this.w.storage.get(k) ?? null;
    if (ks.length === 0 && sv.init) { try { return this.eval(sv.init, this.dummyFrame()); } catch { /* fall through to the type default */ } }
    return this.defaultFor(sv.type);
  }
  dummyFrame(): Frame { return { fn: this.entryFn as FunctionDef, contract: this.contract, sender: "zero", value: 0n, locals: new Map(), unchecked: false }; }
  writeVar(name: string, ks: Value[], v: Value): void { this.w.storage.set(this.key(name, ks), v); }

  num(v: Value, what: string): bigint { if (typeof v === "bigint") return v; if (typeof v === "boolean") return v ? 1n : 0n; throw new Unsupported(`${what} is not a number`); }
  arith(op: string, a: bigint, b: bigint, f: Frame): bigint {
    let r: bigint;
    switch (op) { case "+": r = a + b; break; case "-": r = a - b; break; case "*": r = a * b; break; case "/": if (b === 0n) throw new Revert("division by zero"); r = a / b; break; case "%": if (b === 0n) throw new Revert("modulo by zero"); r = a % b; break; case "**": r = a ** b; break; default: throw new Unsupported(`operator ${op}`); }
    if (r < 0n || r >= MAX) { if (f.unchecked) return ((r % MAX) + MAX) % MAX; throw new Revert(`arithmetic ${r < 0n ? "underflow" : "overflow"} in ${op}`); }
    return r;
  }

  // ------------------------------------------------------------ expressions
  eval(e: Expr, f: Frame): Value {
    if (++this.w.steps > 20000) throw new Unsupported("step limit");
    switch (e.k) {
      case "num": if (e.v === null) throw new Unsupported(`number ${e.text}`); return e.v;
      case "bool": return e.v;
      case "str": return "<str>";
      case "id": {
        if (f.locals.has(e.name)) return f.locals.get(e.name) ?? null;
        if (e.name === "this") return "this";
        return this.readVar(e.name, []);
      }
      case "member": {
        if (e.obj.k === "id" && e.obj.name === "msg") { if (e.name === "sender") return f.sender; if (e.name === "value") return f.value; throw new Unsupported(`msg.${e.name}`); }
        if (e.obj.k === "id" && e.obj.name === "tx" && e.name === "origin") return "attacker";
        if (e.name === "balance") { const a = this.eval(e.obj, f); return a === "this" ? this.w.balance : 0n; }
        throw new Unsupported(`member ${exprText(e)}`);
      }
      case "index": {
        const ks: Value[] = []; let cur: Expr = e;
        while (cur.k === "index") { if (!cur.idx) throw new Unsupported("empty index"); ks.unshift(this.eval(cur.idx, f)); cur = cur.obj; }
        if (cur.k !== "id") throw new Unsupported(`index base ${exprText(cur)}`);
        if (f.locals.has(cur.name)) throw new Unsupported("indexing a local");
        return this.readVar(cur.name, ks);
      }
      case "unary": { const v = this.eval(e.e, f); if (e.op === "!") return !this.truthy(v); if (e.op === "-") return this.arith("-", 0n, this.num(v, "operand"), f); throw new Unsupported(`unary ${e.op}`); }
      case "binary": {
        if (e.op === "&&") return this.truthy(this.eval(e.l, f)) && this.truthy(this.eval(e.r, f));
        if (e.op === "||") return this.truthy(this.eval(e.l, f)) || this.truthy(this.eval(e.r, f));
        const a = this.eval(e.l, f); const b = this.eval(e.r, f);
        if (e.op === "==") return a === b; if (e.op === "!=") return a !== b;
        if (["<", ">", "<=", ">="].includes(e.op)) { const x = this.num(a, "left"), y = this.num(b, "right"); return e.op === "<" ? x < y : e.op === ">" ? x > y : e.op === "<=" ? x <= y : x >= y; }
        return this.arith(e.op, this.num(a, "left"), this.num(b, "right"), f);
      }
      case "ternary": return this.truthy(this.eval(e.c, f)) ? this.eval(e.a, f) : this.eval(e.b, f);
      case "tuple": return e.items.map((i) => (i ? this.eval(i, f) : null));
      case "assign": return this.assign(e, f);
      case "update": { const cur = this.num(this.eval(e.e, f), "operand"); const nv = this.arith(e.op === "++" ? "+" : "-", cur, 1n, f); this.store(e.e, nv, f); return cur; }
      case "delete": this.store(e.e, this.defaultOfTarget(e.e), f); return null;
      case "call": return this.call(e, f);
      default: throw new Unsupported(`expression ${e.k}`);
    }
  }
  truthy(v: Value): boolean { if (typeof v === "boolean") return v; if (typeof v === "bigint") return v !== 0n; throw new Unsupported("condition is not boolean"); }
  defaultOfTarget(t: Expr): Value { let c: Expr = t; while (c.k === "index") c = c.obj; return c.k === "id" ? this.defaultFor(this.ix.stateVar(this.contract, c.name)?.type ?? "") : null; }

  store(t: Expr, v: Value, f: Frame): void {
    if (t.k === "id") { if (f.locals.has(t.name)) { f.locals.set(t.name, v); return; } this.writeVar(t.name, [], v); return; }
    if (t.k === "index") {
      const ks: Value[] = []; let cur: Expr = t;
      while (cur.k === "index") { if (!cur.idx) throw new Unsupported("empty index"); ks.unshift(this.eval(cur.idx, f)); cur = cur.obj; }
      if (cur.k !== "id" || f.locals.has(cur.name)) throw new Unsupported("write to a local mapping");
      this.writeVar(cur.name, ks, v); return;
    }
    if (t.k === "tuple") { const arr = Array.isArray(v) ? v : [v]; t.items.forEach((it, i) => { if (it) this.store(it, arr[i] ?? null, f); }); return; }
    throw new Unsupported(`assignment target ${exprText(t)}`);
  }
  assign(e: Extract<Expr, { k: "assign" }>, f: Frame): Value {
    const r = this.eval(e.r, f);
    if (e.op === "=") { this.store(e.l, r, f); return r; }
    const cur = this.eval(e.l, f); const nv = this.arith(e.op.slice(0, -1), this.num(cur, "target"), this.num(r, "value"), f);
    this.store(e.l, nv, f); return nv;
  }

  // ------------------------------------------------------------ calls
  call(e: Extract<Expr, { k: "call" }>, f: Frame): Value {
    const fn = e.fn;
    if (fn.k === "id") {
      const n = fn.name;
      if (n === "require" || n === "assert") { const c = e.args[0]; if (!c) throw new Unsupported("require without condition"); if (!this.truthy(this.eval(c, f))) throw new Revert(`${n} failed: ${exprText(c)}`); return null; }
      if (n === "payable" || /^address$|^u?int\d*$/.test(n)) { const a = e.args[0]; return a ? (n === "address" && a.k === "num" && a.v === 0n ? "zero" : this.eval(a, f)) : null; }
      if (this.ix.isContractLike(n)) throw new Unsupported(`interface cast ${n}`);
      const callee = this.ix.findFunction(f.contract, n, e.args.length); if (!callee || !callee.body) throw new Unsupported(`unresolved call ${n}`);
      return this.runFunction(callee, f.contract, e.args.map((a) => this.eval(a, f)), f.sender, 0n);
    }
    if (fn.k === "member") {
      const target = fn.obj; const name = fn.name;
      if ((name === "call" || name === "send" || name === "transfer") && !(target.k === "id" && this.ix.contracts.has(target.name))) {
        const to = this.eval(target, f); if (typeof to !== "string") throw new Unsupported("call target is not an address");
        const valExpr = e.opts["value"] ?? (name === "call" ? null : e.args[0] ?? null);
        const v = valExpr ? this.num(this.eval(valExpr, f), "value") : 0n;
        if (name === "call" && !valExpr) throw new Unsupported("low-level call without value");
        if (this.w.balance < v) { if (name === "transfer") throw new Revert("transfer: insufficient balance"); return name === "send" ? false : [false, ""]; }
        this.w.balance -= v;
        if (to === "attacker") { this.w.received += v; this.w.payouts += 1; this.w.trace.push(`${f.fn.name}: ${name} sends ${fmt(v)} to the attacker (line ${e.line})`); }
        if (to === "attacker" && name === "call" && this.plan.callbacks) this.callback(f, e.line);
        return name === "send" ? true : name === "transfer" ? null : [true, ""];
      }
      if (target.k === "call" && target.fn.k === "id" && this.ix.isContractLike(target.fn.name) && target.args[0]) {
        // IHook(addr).method(...): when addr is the attacker this is the attacker's hook, which may re-enter
        const addr = this.eval(target.args[0], f);
        if (addr === "attacker") { this.w.trace.push(`${f.fn.name}: calls the attacker's hook ${exprText(fn)} (line ${e.line})`); for (const a of e.args) this.eval(a, f); if (this.plan.callbacks) this.callback(f, e.line); return null; }
      }
      throw new Unsupported(`external call ${exprText(fn)}`);
    }
    throw new Unsupported("complex call");
  }

  /** the attacker contract's receive hook: re-enter planned functions, swallowing any revert (the attacker's best case) */
  callback(f: Frame, line: number): void {
    if (this.depth >= this.plan.maxDepth) return;
    const step = this.plan.reenter[this.depth]; if (!step) return;
    const snapshot = this.w.clone(); this.depth++;
    this.w.trace.push(`attacker receive hook re-enters ${step.fn.name}(${step.args.map(String).join(", ")}) at depth ${this.depth} (triggered by line ${line})`);
    try { this.runFunction(step.fn, this.contract, step.args, "attacker", 0n); }
    catch (err) {
      if (err instanceof Revert) { this.w.restore(snapshot); this.w.trace.push(`  the re-entrant call reverted (${err.why}); the attacker swallows it and its effects are undone`); }
      else throw err;
    } finally { this.depth--; }
  }

  runFunction(fn: FunctionDef, contract: string, args: Value[], sender: string, value: bigint): Value {
    if (!fn.body) throw new Unsupported(`${fn.name} has no body`);
    const locals = new Map<string, Value>(); fn.params.forEach((p, i) => { if (p.name) locals.set(p.name, args[i] ?? null); });
    const frame: Frame = { fn, contract, sender, value, locals, unchecked: this.ix.wrapsArithmetic.get(fn.file) ?? false };
    return this.withModifiers(frame, 0);
  }
  withModifiers(frame: Frame, i: number): Value {
    const mods = frame.fn.kind === "constructor" ? [] : frame.fn.modifiers;
    if (i >= mods.length) { const r = this.block(frame.fn.body ?? [], frame); return r.kind === "return" ? r.value : null; }
    const use = mods[i]!; const def = this.ix.findModifier(frame.contract, use.name);
    if (!def || !def.body) throw new Unsupported(`modifier ${use.name} is not defined in the analysed files`);
    const mframe: Frame = { fn: def, contract: frame.contract, sender: frame.sender, value: frame.value, locals: new Map(), unchecked: frame.unchecked };
    def.params.forEach((p, k) => { if (p.name && use.args[k]) mframe.locals.set(p.name, this.eval(use.args[k]!, frame)); });
    const prev = this.placeholder; this.placeholder = () => { this.withModifiers(frame, i + 1); };
    try { this.block(def.body, mframe); } finally { this.placeholder = prev; }
    return null;
  }
  placeholder: (() => void) | null = null;

  // ------------------------------------------------------------ statements
  block(stmts: Stmt[], f: Frame): Signal {
    for (const s of stmts) { const r = this.stmt(s, f); if (r.kind === "return") return r; }
    return { kind: "next" };
  }
  stmt(s: Stmt, f: Frame): Signal {
    switch (s.k) {
      case "expr": this.eval(s.e, f); return { kind: "next" };
      case "decl": {
        const v = s.init ? this.eval(s.init, f) : null;
        if (s.names.length === 1) { if (s.names[0]) f.locals.set(s.names[0], s.init ? v : this.defaultFor(s.types[0] ?? "")); }
        else { const arr = Array.isArray(v) ? v : [v]; s.names.forEach((n, i) => { if (n) f.locals.set(n, arr[i] ?? null); }); }
        return { kind: "next" };
      }
      case "if": return this.block(this.truthy(this.eval(s.cond, f)) ? s.then : s.els, f);
      case "loop": { let n = 0; while ((s.cond ? this.truthy(this.eval(s.cond, f)) : true) && n++ < 8) { const r = this.block(s.body, f); if (r.kind === "return") return r; } return { kind: "next" }; }
      case "block": { const prev = f.unchecked; if (s.unchecked) f.unchecked = true; try { return this.block(s.body, f); } finally { f.unchecked = prev; } }
      case "return": return { kind: "return", value: s.e ? this.eval(s.e, f) : null };
      case "revert": throw new Revert(`revert at line ${s.line}`);
      case "placeholder": if (this.placeholder) this.placeholder(); return { kind: "next" };
      case "emit": case "other": return { kind: "next" };
      default: throw new Unsupported(`statement ${s.k}`);
    }
  }
}

const fmt = (v: bigint) => (v % ETHER === 0n ? `${v / ETHER} ether` : `${v} wei`);

function sampleArgs(fn: FunctionDef, amounts: bigint[]): Value[] | null {
  const out: Value[] = []; let ai = 0;
  for (const p of fn.params) {
    if (/^u?int/.test(p.type)) out.push(amounts[ai++ % amounts.length] ?? ETHER);
    else if (/^address/.test(p.type)) out.push("attacker");
    else if (/^bool/.test(p.type)) out.push(true);
    else return null;
  }
  return out;
}

/** Validate a reentrancy lead for `entry` by bounded attacker search. */
export function validateReentrancy(ix: ProgramIndex, entry: FunctionDef): SimOutcome {
  const contract = entry.contract; const trace: string[] = []; let scenarios = 0; let inconclusive = ""; const reasonsRefuted = new Set<string>();
  const others = ix.entryPoints(contract).filter((g) => g !== entry && g.mutability !== "payable");
  const holder = new Interp(ix, contract, { reenter: [], maxDepth: 0, callbacks: false });
  // accounting variables: mappings keyed by address holding uints
  const ledgers: string[] = []; for (const c of ix.linearize(contract)) for (const v of c.stateVars) if (/^mapping\s*\(\s*address\s*=>\s*u?int/.test(v.type)) ledgers.push(v.name);
  void holder;
  for (const credit of [1n, 2n]) for (const amount of [1n, 2n]) for (const depth of [1, 2]) for (const next of [entry, ...others]) {
    const args = sampleArgs(entry, [amount * ETHER]); const nextArgs = sampleArgs(next, [amount * ETHER]); if (!args || !nextArgs) continue;
    scenarios++;
    const seed = (it: Interp) => {
      for (const l of ledgers) { it.writeVar(l, ["attacker"], credit * ETHER); it.writeVar(l, ["victim"], 10n * ETHER); }
      it.w.balance = (credit + 10n) * ETHER;
    };
    // honest baseline: the SAME two calls (entry, then `next`; and the reverse order) executed sequentially with no re-entrancy; a call that
    // reverts is skipped. Re-entering a different function only counts as an exploit if it beats every honest ordering of those calls.
    let honest = 0n;
    try {
      const orders: Array<Array<[FunctionDef, Value[]]>> = [[[entry, args], [next, next === entry ? args : nextArgs]], [[next, next === entry ? args : nextArgs], [entry, args]]];
      for (const order of orders) {
        const base = new Interp(ix, contract, { reenter: [], maxDepth: 0, callbacks: false }); seed(base);
        for (const [fnc, a] of order) { const snap = base.w.clone(); try { base.runFunction(fnc, contract, a, "attacker", 0n); } catch (e) { if (e instanceof Revert) base.w.restore(snap); else throw e; } }
        if (base.w.received > honest) honest = base.w.received;
      }
    } catch (e) { if (e instanceof Unsupported) { inconclusive = e.why; continue; } throw e; }
    // re-entrant run
    const sim = new Interp(ix, contract, { reenter: Array.from({ length: depth }, () => ({ fn: next, args: next === entry ? args : nextArgs })), maxDepth: depth, callbacks: true }); seed(sim);
    try {
      sim.runFunction(entry, contract, args, "attacker", 0n);
      if (sim.w.received > honest) {
        return { verdict: "validated", reason: `a re-entrant attacker extracts ${fmt(sim.w.received)} where the best honest sequence of the same calls extracts ${fmt(honest)} (attacker credit ${credit} ether, amount ${amount} ether, re-entering ${next.name}, depth ${depth})`,
          trace: [`scenario: contract holds ${credit + 10n} ether (attacker credit ${credit} ether, others 10 ether)`, `entry: ${entry.name}(${args.map((a) => typeof a === "bigint" ? fmt(a) : String(a)).join(", ")})`, ...sim.w.trace, `result: attacker received ${fmt(sim.w.received)} in ${sim.w.payouts} payout(s); honest sequence: ${fmt(honest)}`], scenarios, detail: { honest: fmt(honest), reentrant: fmt(sim.w.received), reentered: next.name, depth } };
      }
      reasonsRefuted.add("the re-entrant run extracted no more than an honest sequence");
    } catch (e) {
      if (e instanceof Revert) reasonsRefuted.add(`the re-entrant transaction reverts (${e.why})`);
      else if (e instanceof Unsupported) inconclusive = e.why; else throw e;
    }
    trace.length = 0;
  }
  if (inconclusive && scenarios === 0) return { verdict: "inconclusive", reason: `not modelled: ${inconclusive}`, trace: [], scenarios, detail: {} };
  if (scenarios === 0) return { verdict: "inconclusive", reason: "the entry function's parameters could not be modelled", trace: [], scenarios, detail: {} };
  if (inconclusive) return { verdict: "inconclusive", reason: `some scenarios could not be modelled (${inconclusive}); the rest found no exploit`, trace: [], scenarios, detail: {} };
  return { verdict: "refuted", reason: `no exploit in ${scenarios} bounded scenarios: ${[...reasonsRefuted].join("; ")}`, trace: [], scenarios, detail: {} };
}
