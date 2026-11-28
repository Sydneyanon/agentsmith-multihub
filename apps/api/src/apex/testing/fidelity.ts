/**
 * PROTOTYPE (docs/architecture/apex-first-capability.md §10.1, the semantic-fidelity gate). NOT wired into any pipeline, step, worker or
 * release; imported only by the APEX prototype and its tests.
 *
 * `FidelityInterp` wraps the bounded interpreter (`simulate.ts: Interp`) by SUBCLASSING it: `simulate.ts` is not changed, and every
 * existing caller keeps the exact behaviour it had. Every override either
 *  - delegates to the original method after recording what it is about to do, or
 *  - replays the original one-line semantics verbatim (the loop, `if`, `x.balance`) so that it can observe an outcome the original
 *    does not expose (loop cap reached, branch taken, whose balance was read);
 * and it never changes a value the original would have produced. The one deliberate difference is that features the original models
 * silently but WRONGLY for APEX's purpose (indexing a state array as if it were a mapping, `delegatecall` assumed to succeed, a call to
 * a non-actor address treated as a plain ether transfer, an attacker "hook" behind an interface cast) are turned into `Unsupported`, so
 * the explorer abstains on them instead of trusting them.
 *
 * Two outputs per transaction:
 *  - `approximations`: things the interpreter executed with KNOWN-INEXACT semantics (loop cap, narrow integers and casts, string
 *    literals, `tx.origin`, another address's balance). A counterexample whose path touched any of them is SUPPRESSED, never reported.
 *  - unsupported features (thrown as `Unsupported`, located by `whereOf`): the transaction does not complete; the explorer ABSTAINS on
 *    that region and records `abstained(<feature>@<file:line>)`.
 */
import type { ProgramIndex } from "../../analysis/solidity/index.js";
import { exprText, type Expr, type FunctionDef, type Stmt } from "../../analysis/solidity/parser.js";
import { Interp, Revert, Unsupported, type Frame, type Plan, type Value } from "../../analysis/solidity/simulate.js";

export const APPROXIMATION_KINDS = ["loop-cap", "narrow-integer", "cast", "string-literal", "tx-origin", "foreign-balance"] as const;
export type ApproximationKind = (typeof APPROXIMATION_KINDS)[number];
export const UNSUPPORTED_FEATURES = ["external-call", "other-contract", "block", "struct", "array", "hashing", "try", "proxy", "inline-assembly", "step-limit", "other"] as const;
export type UnsupportedFeature = (typeof UNSUPPORTED_FEATURES)[number];
export type Approximation = { kind: ApproximationKind; at: string; what: string };
export type Abstention = { feature: UnsupportedFeature; at: string; why: string };
export type GuardOutcome = { passed: number; failed: number };

const HASHING = new Set(["keccak256", "sha256", "sha3", "ripemd160", "ecrecover", "blockhash"]);
const BLOCK_IDS = new Set(["now", "block", "gasleft"]);
const ELEMENTARY = /^(u?int\d*|bool|address(\s+payable)?|bytes\d*|string|bytes)$/;
/** the value type of a (possibly nested) mapping, or the type itself */
export const valueType = (type: string): string => { const t = type.replace(/\s+/g, " ").trim(); return /^mapping/.test(t) ? (t.split("=>").pop() ?? "").replace(/[) ]*$/g, "").trim() : t; };
/** narrower than 256 bits, or signed: the interpreter computes both as unbounded-then-checked uint256 */
export const isNarrowInteger = (type: string): boolean => { const m = /^(u?)int(\d*)$/.exec(valueType(type)); if (!m) return false; return m[1] === "" || (m[2] !== "" && Number(m[2]) < 256); };
/** a cast whose semantics the interpreter does not apply (it returns the operand unchanged) */
const isInexactCast = (name: string): boolean => /^(u?int\d*|bytes\d*)$/.test(name) && !/^uint(256)?$/.test(name);

export function classifyUnsupported(why: string): UnsupportedFeature {
  if (/^array |\.(length|push|pop)\b|index base|indexing a local|write to a local mapping/.test(why)) return "array";
  if (/^struct /.test(why)) return "struct";
  if (/^proxy|delegatecall/.test(why)) return "proxy";
  if (/^hashing |keccak|sha256|sha3|ripemd|ecrecover|abi\./.test(why)) return "hashing";
  if (/member block\.|identifier (now|block|gasleft)\b|blockhash/.test(why)) return "block";
  if (/statement try|^try/.test(why)) return "try";
  if (/statement asm|assembly/.test(why)) return "inline-assembly";
  if (/step limit/.test(why)) return "step-limit";
  if (/^other-contract|interface cast|expression new|contract-typed/.test(why)) return "other-contract";
  if (/external call|call target|low-level call|non-actor/.test(why)) return "external-call";
  if (/^member \w+(\[[^\]]*\])*\.\w+|^assignment target \w+(\[[^\]]*\])*\.\w+/.test(why)) return "struct"; // `x.field` on a non-builtin: in this interpreter's grammar, a struct member
  return "other";
}

export class FidelityInterp extends Interp {
  /** approximations met in the current transaction (reset by `beginTransaction`) */
  approximations: Approximation[] = [];
  /** per guard location (`file:line`): how often its condition passed and failed, over the lifetime of this interpreter */
  guards = new Map<string, GuardOutcome>();
  private readonly where = new WeakMap<Error, string>();
  private readonly pix: ProgramIndex; private readonly pcontract: string;
  constructor(ix: ProgramIndex, contract: string, plan: Plan, private readonly actors: ReadonlySet<string>) { super(ix, contract, plan); this.pix = ix; this.pcontract = contract; }

  beginTransaction(): void { this.approximations = []; this.w.steps = 0; }
  /** `file:line` of the innermost expression or statement that raised `e` */
  whereOf(e: Error): string { return this.where.get(e) ?? "unknown"; }
  private approx(kind: ApproximationKind, f: Frame, line: number, what: string): void { this.approximations.push({ kind, at: `${f.fn.file}:${line}`, what }); }
  private locate<T>(f: Frame, line: number, run: () => T): T {
    try { return run(); } catch (err) { if (err instanceof Unsupported && !this.where.has(err)) this.where.set(err, `${f.fn.file}:${line}`); throw err; }
  }
  /**
   * when set, the coverage side effects of the current transaction (guard outcomes and statements entered, in order) are logged here, so
   * that a memoised transaction (state-explorer-prototype.ts: Engine.step) can replay them into a later collector exactly
   */
  txLog: { guards: Array<[string, boolean]>; reached: string[] } | null = null;
  /** records a guard outcome (also used to replay a memoised transaction's guard outcomes) */
  noteGuard(at: string, ok: boolean): void { const g = this.guards.get(at) ?? { passed: 0, failed: 0 }; if (ok) g.passed++; else g.failed++; this.guards.set(at, g); }
  private guard(at: string, ok: boolean): void { this.noteGuard(at, ok); this.txLog?.guards.push([at, ok]); }

  /** a state variable's type check is a pure function of its declaration: memoised (the throwing outcomes are re-thrown as new errors) */
  private readonly typeMemo = new Map<string, { t: string | null } | { unsupported: string }>();
  private checkType(name: string, ks: Value[]): string | null {
    let m = this.typeMemo.get(name);
    if (!m) { try { m = { t: this.checkTypeUncached(name) }; } catch (e) { if (!(e instanceof Unsupported)) throw e; m = { unsupported: e.why }; } this.typeMemo.set(name, m); }
    void ks;
    if ("unsupported" in m) throw new Unsupported(m.unsupported);
    return m.t;
  }
  private checkTypeUncached(name: string): string | null {
    const sv = this.pix.stateVar(this.pcontract, name); if (!sv) return null;
    const t = sv.type.replace(/\s+/g, " ").trim();
    if (/\[/.test(t)) throw new Unsupported(`array ${name} (${t})`);
    const vt = valueType(t);
    if (!ELEMENTARY.test(vt)) {
      if (this.pix.isContractLike(vt)) throw new Unsupported(`other-contract: contract-typed variable ${name} (${vt})`);
      throw new Unsupported(`struct ${name} (${vt}: user-defined type, not modelled)`);
    }
    return t;
  }
  private declaredAt(name: string): string { const sv = this.pix.stateVar(this.pcontract, name)!; return `${this.pix.contracts.get(sv.owner)?.file ?? "?"}:${sv.line}`; }
  override readVar(name: string, ks: Value[]): Value {
    const t = this.checkType(name, ks);
    if (t && isNarrowInteger(t)) this.approximations.push({ kind: "narrow-integer", at: this.declaredAt(name), what: `read of ${name} (${valueType(t)})` });
    return super.readVar(name, ks);
  }
  override writeVar(name: string, ks: Value[], v: Value): void {
    const t = this.checkType(name, ks);
    if (t && isNarrowInteger(t)) this.approximations.push({ kind: "narrow-integer", at: this.declaredAt(name), what: `write of ${name} (${valueType(t)})` });
    super.writeVar(name, ks, v);
  }

  override eval(e: Expr, f: Frame): Value {
    return this.locate(f, e.line, () => {
      if (e.k === "str") this.approx("string-literal", f, e.line, "string literal evaluated as an opaque placeholder");
      if (e.k === "id" && BLOCK_IDS.has(e.name) && !f.locals.has(e.name)) throw new Unsupported(`identifier ${e.name}`);
      if (e.k === "member" && e.obj.k === "id" && e.obj.name === "tx" && e.name === "origin") this.approx("tx-origin", f, e.line, "tx.origin is always the observed actor");
      if (e.k === "member" && e.name === "balance" && !(e.obj.k === "id" && (e.obj.name === "msg" || e.obj.name === "tx"))) {
        // verbatim replay of Interp.eval's `.balance` case, observing whose balance is read
        if (++this.w.steps > 20000) throw new Unsupported("step limit");
        const a = this.eval(e.obj, f);
        if (a !== "this") this.approx("foreign-balance", f, e.line, `balance of ${String(a)} read as 0`);
        return a === "this" ? this.w.balance : 0n;
      }
      return super.eval(e, f);
    });
  }

  override call(e: Extract<Expr, { k: "call" }>, f: Frame): Value {
    return this.locate(f, e.line, () => {
      const fn = e.fn;
      if (fn.k === "id") {
        const n = fn.name;
        if (HASHING.has(n)) throw new Unsupported(`hashing ${n}`);
        if ((n === "require" || n === "assert") && e.args[0]) {
          const at = `${f.fn.file}:${e.line}`;
          try { const r = super.call(e, f); this.guard(at, true); return r; }
          catch (err) { if (err instanceof Revert && err.why.startsWith(`${n} failed`)) this.guard(at, false); throw err; }
        }
        if (isInexactCast(n)) this.approx("cast", f, e.line, `${n}(...) returned unchanged`);
        return super.call(e, f);
      }
      if (fn.k === "member") {
        const target = fn.obj; const name = fn.name;
        if (target.k === "id" && target.name === "abi") throw new Unsupported(`hashing abi.${name}`);
        if (name === "delegatecall" || name === "staticcall" || name === "callcode") throw new Unsupported(`proxy: ${name} at ${exprText(fn)}`);
        if (target.k === "call" && target.fn.k === "id" && this.pix.isContractLike(target.fn.name)) throw new Unsupported(`other-contract: interface cast ${exprText(fn)}`);
        if (target.k === "id" && this.pix.isContractLike(target.name)) throw new Unsupported(`other-contract: call into ${target.name}.${name}`);
        if (name === "call" || name === "send" || name === "transfer") {
          // the original treats any address as an externally owned account; only the modelled actors are, so any other target is
          // an external call (a contract with code, the zero address, this contract) and is not modelled
          const to = this.pureAddress(target, f);
          if (to === undefined) throw new Unsupported(`external call to a computed target ${exprText(target)}`);
          if (!this.actors.has(String(to))) throw new Unsupported(`external call to non-actor ${String(to)} via ${name}`);
        }
      }
      return super.call(e, f);
    });
  }
  /** the value of a side-effect-free address expression (an identifier, msg.sender, payable(x)/address(x) of those), or undefined */
  private pureAddress(t: Expr, f: Frame): Value | undefined {
    if (t.k === "id") return f.locals.has(t.name) ? (f.locals.get(t.name) ?? null) : t.name === "this" ? "this" : super.readVar(t.name, []);
    if (t.k === "member" && t.obj.k === "id" && t.obj.name === "msg" && t.name === "sender") return f.sender;
    if (t.k === "call" && t.fn.k === "id" && (t.fn.name === "payable" || t.fn.name === "address") && t.args.length === 1) {
      const a = t.args[0]!; if (a.k === "num" && a.v === 0n) return "zero"; return this.pureAddress(a, f);
    }
    return undefined;
  }

  override runFunction(fn: FunctionDef, contract: string, args: Value[], sender: string, value: bigint): Value {
    for (const p of [...fn.params, ...fn.returns]) if (isNarrowInteger(p.type)) this.approximations.push({ kind: "narrow-integer", at: `${fn.file}:${fn.startLine}`, what: `${fn.name || fn.kind}: parameter ${p.name ?? "?"} (${p.type})` });
    return super.runFunction(fn, contract, args, sender, value);
  }

  override stmt(s: Stmt, f: Frame): ReturnType<Interp["stmt"]> {
    this.txLog?.reached.push(`${f.fn.file}:${s.line}`); // the statement Interp.stmt (or the replays below) marks as reached
    return this.locate(f, s.line, () => {
      switch (s.k) {
        case "try": throw new Unsupported("try statement");
        case "asm": throw new Unsupported("statement asm (inline assembly)");
        case "decl": for (const t of s.types) if (isNarrowInteger(t)) this.approx("narrow-integer", f, s.line, `local of type ${t}`); return super.stmt(s, f);
        case "if": {
          // verbatim replay of Interp.stmt's `if`, observing the branch taken
          this.reached.add(`${f.fn.file}:${s.line}`);
          const c = this.truthy(this.eval(s.cond, f)); this.guard(`${f.fn.file}:${s.line}`, c);
          return this.block(c ? s.then : s.els, f);
        }
        case "loop": {
          // verbatim replay of Interp.stmt's loop (at most 8 iterations), observing whether the cap cut the loop short
          this.reached.add(`${f.fn.file}:${s.line}`);
          let n = 0;
          for (;;) {
            const c = s.cond ? this.truthy(this.eval(s.cond, f)) : true;
            if (!c) break;
            if (n++ >= 8) { this.approx("loop-cap", f, s.line, "loop stopped at the 8-iteration cap while its condition still held"); break; }
            const r = this.block(s.body, f); if (r.kind === "return") return r;
          }
          return { kind: "next" };
        }
        default: return super.stmt(s, f);
      }
    });
  }
}
