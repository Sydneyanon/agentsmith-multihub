import type { ProgramIndex } from "./index.js";
import { exprText, type Expr, type FunctionDef, type Stmt } from "./parser.js";

/**
 * Effect trace: the ordered abstract events (guards, calls, state reads and writes) a function can perform, with internal helper
 * calls and modifiers INLINED, so a call hidden in a helper, a lock inside a modifier or a guard inside `_checkOwner()` is seen
 * where it executes. Control flow is approximated linearly; events inside non-terminating branches are marked conditional.
 */
export type Frame = { fn: string; contract: string; file: string; line: number };
type Base = { line: number; file: string; contract: string; cond: boolean; prot: boolean; ret: boolean; chain: Frame[] };
export type Ev =
  | (Base & { k: "guard"; auth: boolean; origin: boolean; reads: string[]; text: string; reverting: boolean; assumed?: string })
  | (Base & { k: "call"; low: "call" | "delegatecall" | "staticcall" | "send" | "transfer" | null; targetText: string; targetExpr: Expr | null; valueText: string | null; hasValue: boolean; callee: string | null; calleeResolved: boolean; attackerTarget: boolean; checked: "checked" | "unchecked" | "returned" | "n/a"; targetTaint: "param" | "msg.sender" | "state" | "constant" | "other"; targetVar: string | null })
  | (Base & { k: "write"; variable: string; owner: string; key: string | null; op: string; increasing: boolean; decreasing: boolean; keyedByCaller: boolean; keyedByParam: boolean; text: string })
  | (Base & { k: "read"; variable: string })
  | (Base & { k: "destruct"; text: string })
  | (Base & { k: "origin"; usage: "auth" | "eoa-check" | "other"; text: string });

type Ctx = {
  contract: string; file: string; fn: FunctionDef; params: Map<string, string>; locals: Map<string, string>;
  tainted: Set<string>; authLocals: Set<string>; success: Map<string, Extract<Ev, { k: "call" }>>; chain: Frame[]; depth: number;
  onPlaceholder: (() => void) | null; branch: { cond: boolean; prot: boolean; ret: boolean }; stack: string[]; aliases: Map<string, { expr: Expr; ctx: Ctx }>;
};
export type TraceResult = { events: Ev[]; assumptions: string[]; unknowns: string[] };

const BUILTIN_OBJ = new Set(["msg", "block", "tx", "abi", "type"]);
const ELEMENTARY = /^(address|bool|string|bytes\d*|u?int\d*)$/;
const AUTH_NAME = /(role|admin|owner|auth|operator|minter|whitelist|allow|guardian|governor|keeper|manager)/i;

export function isCaller(e: Expr): boolean {
  if (e.k === "member" && e.obj.k === "id" && ((e.obj.name === "msg" && e.name === "sender") || (e.obj.name === "tx" && e.name === "origin"))) return true;
  if (e.k === "call" && e.fn.k === "id" && (e.fn.name === "_msgSender" || e.fn.name === "msgSender")) return true;
  return false;
}
const isOrigin = (e: Expr) => e.k === "member" && e.obj.k === "id" && e.obj.name === "tx" && e.name === "origin";
const containsOrigin = (e: Expr): boolean => walkExpr(e, isOrigin);
function walkExpr(e: Expr, pred: (x: Expr) => boolean): boolean {
  if (pred(e)) return true;
  switch (e.k) {
    case "member": return walkExpr(e.obj, pred);
    case "index": return walkExpr(e.obj, pred) || (e.idx ? walkExpr(e.idx, pred) : false);
    case "call": return walkExpr(e.fn, pred) || e.args.some((a) => walkExpr(a, pred)) || Object.values(e.opts).some((a) => walkExpr(a, pred));
    case "unary": return walkExpr(e.e, pred);
    case "binary": case "assign": return walkExpr(e.l, pred) || walkExpr(e.r, pred);
    case "update": case "delete": return walkExpr(e.e, pred);
    case "ternary": return walkExpr(e.c, pred) || walkExpr(e.a, pred) || walkExpr(e.b, pred);
    case "tuple": return e.items.some((i) => i !== null && walkExpr(i, pred));
    case "new": return e.args.some((a) => walkExpr(a, pred));
    default: return false;
  }
}
function rootId(e: Expr): string | null {
  switch (e.k) { case "id": return e.name; case "index": return rootId(e.obj); case "member": return rootId(e.obj); case "call": return e.fn.k === "id" ? null : rootId(e.fn); default: return null; }
}
function endsWithRevert(stmts: Stmt[]): boolean {
  const last = stmts[stmts.length - 1]; if (!last) return false;
  if (last.k === "revert") return true;
  if (last.k === "expr" && last.e.k === "call" && last.e.fn.k === "id" && last.e.fn.name === "revert") return true;
  if (last.k === "block") return endsWithRevert(last.body);
  if (last.k === "if") return endsWithRevert(last.then) && last.els.length > 0 && endsWithRevert(last.els);
  return false;
}
function terminates(stmts: Stmt[]): boolean {
  const last = stmts[stmts.length - 1]; if (!last) return false;
  if (last.k === "revert" || last.k === "return") return true;
  if (last.k === "expr" && last.e.k === "call" && last.e.fn.k === "id" && (last.e.fn.name === "revert")) return true;
  if (last.k === "block") return terminates(last.body);
  if (last.k === "if") return terminates(last.then) && last.els.length > 0 && terminates(last.els);
  return false;
}

export class Tracer {
  readonly events: Ev[] = []; readonly assumptions: string[] = []; readonly unknowns: string[] = [];
  constructor(private readonly ix: ProgramIndex) {}

  run(fn: FunctionDef): TraceResult {
    const ctx = this.newCtx(fn, fn.contract, [], new Set(fn.params.map((p) => p.name).filter((n): n is string => !!n)), 0, []);
    this.runWithModifiers(fn, ctx, 0);
    return { events: this.events, assumptions: this.assumptions, unknowns: this.unknowns };
  }

  private newCtx(fn: FunctionDef, contract: string, chain: Frame[], tainted: Set<string>, depth: number, stack: string[]): Ctx {
    return {
      contract, file: fn.file, fn, params: new Map(fn.params.filter((p) => p.name).map((p) => [p.name!, p.type])), locals: new Map(), tainted,
      authLocals: new Set(), success: new Map(), chain, depth, onPlaceholder: null, branch: { cond: false, prot: false, ret: false }, stack: [...stack, `${contract}.${fn.name}`], aliases: new Map(),
    };
  }

  private base(ctx: Ctx, line: number): Base { return { line, file: ctx.file, contract: ctx.contract, cond: ctx.branch.cond, prot: ctx.branch.prot, ret: ctx.branch.ret, chain: ctx.chain }; }

  // ---------------------------------------------------------------- modifiers
  private runWithModifiers(fn: FunctionDef, ctx: Ctx, i: number): void {
    const uses = fn.kind === "constructor" ? [] : fn.modifiers;
    if (i >= uses.length) { if (fn.body) this.stmts(fn.body, ctx); return; }
    const use = uses[i]!; const def = this.ix.findModifier(ctx.contract, use.name);
    if (def && def.body) {
      // the modifier body runs in the DEPLOYED contract's context (virtual dispatch and state resolve there), not the declaring base's
      const mctx: Ctx = { ...this.newCtx(def, ctx.contract, [...ctx.chain, { fn: `modifier ${def.name}`, contract: def.contract, file: def.file, line: use.line }], ctx.tainted, ctx.depth + 1, ctx.stack), branch: { ...ctx.branch } };
      mctx.params = new Map(def.params.filter((p) => p.name).map((p) => [p.name!, p.type]));
      // a modifier parameter stands for the argument it was given: onlyBy(owner) compares the caller with `owner`, an authority
      def.params.forEach((p, k) => { const a = use.args[k]; if (!p.name || !a) return; if (this.isAuthority(a, ctx)) mctx.authLocals.add(p.name); if (this.tainted(a, ctx)) mctx.tainted.add(p.name); });
      // `_` may sit inside a branch of the modifier (`if (msg.sender == owner) _;`): the body runs under that branch's protection
      mctx.onPlaceholder = () => { const saved = ctx.branch; ctx.branch = { cond: saved.cond || mctx.branch.cond, prot: saved.prot || mctx.branch.prot, ret: saved.ret || mctx.branch.ret }; try { this.runWithModifiers(fn, ctx, i + 1); } finally { ctx.branch = saved; } };
      this.stmts(def.body, mctx);
      return;
    }
    // modifier not defined in the analysed files (typically imported): classify by name and SAY so
    const line = use.line; const b = { ...this.base(ctx, line), chain: ctx.chain };
    if (/^(only[A-Z_]|auth$|requiresAuth|restricted|isOwner|onlyOwner)/.test(use.name)) {
      const note = `modifier ${use.name} is not defined in the analysed files; assumed to be an access-control check because of its name`;
      this.assumptions.push(note); this.events.push({ ...b, k: "guard", auth: true, origin: false, reads: [], text: use.name, reverting: true, assumed: note });
    } else if (/nonReentrant|noReentr|reentrancyGuard|^mutex$|^lock$|^locked$/i.test(use.name)) {
      const note = `modifier ${use.name} is not defined in the analysed files; assumed to be a reentrancy lock because of its name`;
      this.assumptions.push(note);
      this.events.push({ ...b, k: "guard", auth: false, origin: false, reads: [`<lock:${use.name}>`], text: use.name, reverting: true, assumed: note });
      this.events.push({ ...b, k: "write", variable: `<lock:${use.name}>`, owner: ctx.contract, key: null, op: "=", increasing: false, decreasing: false, keyedByCaller: false, keyedByParam: false, text: use.name });
    } else if (/^(initializer|reinitializer|onlyInitializing)$/.test(use.name)) {
      const note = `modifier ${use.name} is not defined in the analysed files; assumed to be a one-time initialisation guard because of its name`;
      this.assumptions.push(note);
      this.events.push({ ...b, k: "guard", auth: false, origin: false, reads: ["<initialized>"], text: use.name, reverting: true, assumed: note });
      this.events.push({ ...b, k: "write", variable: "<initialized>", owner: ctx.contract, key: null, op: "=", increasing: false, decreasing: false, keyedByCaller: false, keyedByParam: false, text: use.name });
    }
    this.runWithModifiers(fn, ctx, i + 1);
  }

  // ---------------------------------------------------------------- statements
  private stmts(list: Stmt[], ctx: Ctx): void { for (const s of list) this.stmt(s, ctx); }

  private withBranch<T>(ctx: Ctx, cond: boolean, prot: boolean, f: () => T, ret = false): T {
    const saved = ctx.branch; ctx.branch = { cond: saved.cond || cond, prot: saved.prot || prot, ret: saved.ret || ret };
    try { return f(); } finally { ctx.branch = saved; }
  }

  private stmt(s: Stmt, ctx: Ctx): void {
    switch (s.k) {
      case "expr": this.expr(s.e, ctx, "discard"); return;
      case "decl": {
        if (s.init) {
          const before = this.events.length; this.expr(s.init, ctx, "capture");
          const lastCall = [...this.events.slice(before)].reverse().find((e): e is Extract<Ev, { k: "call" }> => e.k === "call" && e.low !== null);
          s.names.forEach((n, i) => {
            if (!n) return; ctx.locals.set(n, s.types[i] ?? "");
            if (this.tainted(s.init!, ctx)) ctx.tainted.add(n);
            if (this.isAuthority(s.init!, ctx)) ctx.authLocals.add(n);
            if (lastCall && i === 0 && /^bool/.test(s.types[0] ?? "")) { ctx.success.set(n, lastCall); }
          });
        } else s.names.forEach((n, i) => { if (n) ctx.locals.set(n, s.types[i] ?? ""); });
        return;
      }
      case "if": this.ifStmt(s, ctx); return;
      case "loop": { if (s.cond) this.expr(s.cond, ctx, "use"); this.withBranch(ctx, true, false, () => this.stmts(s.body, ctx)); return; }
      case "block": this.stmts(s.body, ctx); return;
      case "return": if (s.e) this.expr(s.e, ctx, "return"); return;
      case "placeholder": if (ctx.onPlaceholder) ctx.onPlaceholder(); return;
      case "try": { this.expr(s.call, ctx, "use"); this.withBranch(ctx, true, false, () => { this.stmts(s.body, ctx); for (const c of s.catches) this.stmts(c, ctx); }); return; }
      case "asm": this.unknowns.push(`${ctx.file}:${s.line}: inline assembly is not analysed`); return;
      default: return;
    }
  }

  private ifStmt(s: Extract<Stmt, { k: "if" }>, ctx: Ctx): void {
    this.expr(s.cond, ctx, "use");
    const termThen = terminates(s.then); const termEls = s.els.length > 0 && terminates(s.els);
    if (termThen && s.els.length === 0) { // `if (bad) revert/return;` is a guard on everything that follows
      this.emitGuard(s.cond, false, ctx, s.line, endsWithRevert(s.then));
      this.withBranch(ctx, true, false, () => this.stmts(s.then, ctx), !endsWithRevert(s.then)); return; // a branch that RETURNS skips any later check
    }
    if (termEls && !termThen) { this.emitGuard(s.cond, true, ctx, s.line, endsWithRevert(s.els)); this.stmts(s.then, ctx); return; }
    const authTrue = this.auth(s.cond, true, ctx); const authFalse = this.auth(s.cond, false, ctx);
    this.withBranch(ctx, true, authTrue, () => this.stmts(s.then, ctx), termThen && !endsWithRevert(s.then));
    this.withBranch(ctx, true, authFalse, () => this.stmts(s.els, ctx), termEls && !endsWithRevert(s.els));
  }

  private emitGuard(cond: Expr, positive: boolean, ctx: Ctx, line: number, reverting = true): void {
    const reads = this.collectReads(cond, ctx);
    const authOk = this.auth(cond, positive, ctx);
    if (containsOrigin(cond)) this.events.push({ ...this.base(ctx, line), k: "origin", usage: this.originUsage(cond), text: exprText(cond) });
    this.events.push({ ...this.base(ctx, line), k: "guard", auth: authOk, origin: containsOrigin(cond), reads, reverting, text: (positive ? "" : "!") + exprText(cond) });
  }

  private originUsage(cond: Expr): "auth" | "eoa-check" | "other" {
    let kind: "auth" | "eoa-check" | "other" = "other";
    const visit = (e: Expr): void => {
      if (e.k === "binary" && (e.op === "==" || e.op === "!=")) {
        const [a, b] = [e.l, e.r];
        const o = isOrigin(a) ? b : isOrigin(b) ? a : null;
        if (o) { const msgSender = o.k === "member" && o.obj.k === "id" && o.obj.name === "msg" && o.name === "sender"; if (msgSender) { if (kind === "other") kind = "eoa-check"; } else kind = "auth"; return; }
      }
      if (e.k === "binary") { visit(e.l); visit(e.r); } else if (e.k === "unary") visit(e.e); else if (e.k === "call") e.args.forEach(visit);
    };
    visit(cond);
    if (kind === "other" && containsOrigin(cond)) kind = "auth"; // tx.origin used in some other check: treat as authorisation-like
    return kind;
  }

  // ---------------------------------------------------------------- authority reasoning
  private rootIsState(name: string | null, ctx: Ctx): boolean { return !!name && !ctx.params.has(name) && !ctx.locals.has(name) && !!this.ix.stateVar(ctx.contract, name); }

  isAuthority(e: Expr, ctx: Ctx): boolean {
    if (e.k === "id") return ctx.authLocals.has(e.name) || this.rootIsState(e.name, ctx);
    if (e.k === "call") {
      if (e.fn.k === "id" && ELEMENTARY.test(e.fn.name)) { const a = e.args[0]; if (a && a.k === "num" && a.v === 0n) return false; return a ? this.isAuthority(a, ctx) || (a.k === "id" && a.name === "this") : false; }
      if (e.fn.k === "id" && this.ix.isContractLike(e.fn.name)) return e.args[0] ? this.isAuthority(e.args[0], ctx) : false;
      return true; // owner(), getAdmin(), registry.owner() ...
    }
    if (e.k === "member" || e.k === "index") { const r = rootId(e); return this.rootIsState(r, ctx) || (r !== null && ctx.authLocals.has(r)); }
    return false;
  }

  /** does `e == want` imply the caller is authorised? */
  auth(e: Expr, want: boolean, ctx: Ctx): boolean {
    switch (e.k) {
      case "unary": return e.op === "!" ? this.auth(e.e, !want, ctx) : false;
      case "binary": {
        if (e.op === "&&") return want ? this.auth(e.l, true, ctx) || this.auth(e.r, true, ctx) : this.auth(e.l, false, ctx) && this.auth(e.r, false, ctx);
        if (e.op === "||") return want ? this.auth(e.l, true, ctx) && this.auth(e.r, true, ctx) : this.auth(e.l, false, ctx) || this.auth(e.r, false, ctx);
        if (e.op === "==" || e.op === "!=") {
          const eq = (e.op === "==") === want; if (!eq) return false;
          if (isCaller(e.l) && this.isAuthority(e.r, ctx)) return true;
          if (isCaller(e.r) && this.isAuthority(e.l, ctx)) return true;
        }
        return false;
      }
      case "index": return want && !!e.idx && isCaller(e.idx) && this.rootIsState(rootId(e.obj), ctx);
      case "call": {
        if (!want) return false;
        const argIsCaller = e.args.some(isCaller);
        if (argIsCaller) {
          const name = e.fn.k === "id" ? e.fn.name : e.fn.k === "member" ? e.fn.name : "";
          if (AUTH_NAME.test(name)) return true;
          if (e.fn.k === "id") {
            const f = this.ix.findFunction(ctx.contract, e.fn.name, e.args.length);
            const ret = f?.body?.length === 1 && f.body[0]!.k === "return" ? (f.body[0] as Extract<Stmt, { k: "return" }>).e : null;
            if (ret) return this.auth(ret, true, { ...ctx, params: new Map(f!.params.filter((p) => p.name).map((p) => [p.name!, p.type])), locals: new Map() });
          }
        }
        if (e.fn.k === "id" && e.args.length === 0) { // isOwner() style helper
          const f = this.ix.findFunction(ctx.contract, e.fn.name, 0);
          const ret = f?.body?.length === 1 && f.body[0]!.k === "return" ? (f.body[0] as Extract<Stmt, { k: "return" }>).e : null;
          if (ret) return this.auth(ret, true, { ...ctx, params: new Map(), locals: new Map() });
        }
        return false;
      }
      default: return false;
    }
  }

  /** a helper parameter that stands for msg.sender at its call site (for example `_transfer(msg.sender, to, v)`) */
  private aliasIsCaller(name: string, ctx: Ctx): boolean {
    const al = ctx.aliases.get(name); if (!al) return false;
    return isCaller(al.expr) || (al.expr.k === "id" && this.aliasIsCaller(al.expr.name, al.ctx));
  }

  tainted(e: Expr, ctx: Ctx): boolean {
    return walkExpr(e, (x) => isCaller(x) || (x.k === "id" && ctx.tainted.has(x.name)));
  }

  private collectReads(e: Expr, ctx: Ctx): string[] {
    const out = new Set<string>();
    walkExpr(e, (x) => { if (x.k === "id" && this.rootIsState(x.name, ctx)) out.add(x.name); return false; });
    return [...out];
  }

  // ---------------------------------------------------------------- expressions
  private typeOf(e: Expr, ctx: Ctx): string | null {
    if (e.k === "id") return ctx.locals.get(e.name) ?? ctx.params.get(e.name) ?? this.ix.stateVar(ctx.contract, e.name)?.type ?? null;
    if (e.k === "call" && e.fn.k === "id" && (ELEMENTARY.test(e.fn.name) || this.ix.isContractLike(e.fn.name) || e.fn.name === "payable")) return e.fn.name === "payable" ? "address payable" : e.fn.name;
    if (e.k === "member" && e.obj.k === "id" && (e.obj.name === "msg" || e.obj.name === "tx")) return "address";
    return null;
  }

  private expr(e: Expr, ctx: Ctx, usage: "discard" | "use" | "capture" | "return"): void {
    switch (e.k) {
      case "id": {
        const sv = ctx.success.get(e.name); if (sv) sv.checked = usage === "return" ? "returned" : "checked";
        if (this.rootIsState(e.name, ctx)) this.events.push({ ...this.base(ctx, e.line), k: "read", variable: e.name });
        return;
      }
      case "member": if (e.obj.k === "id" && BUILTIN_OBJ.has(e.obj.name)) { if (isOrigin(e) && usage !== "use") { /* usage recorded by guards */ } return; } this.expr(e.obj, ctx, "use"); return;
      case "index": this.expr(e.obj, ctx, "use"); if (e.idx) this.expr(e.idx, ctx, "use"); return;
      case "unary": this.expr(e.e, ctx, "use"); return;
      case "binary": this.expr(e.l, ctx, "use"); this.expr(e.r, ctx, "use"); return;
      case "ternary": this.expr(e.c, ctx, "use"); this.withBranch(ctx, true, false, () => { this.expr(e.a, ctx, "use"); this.expr(e.b, ctx, "use"); }); return;
      case "tuple": for (const i of e.items) if (i) this.expr(i, ctx, usage === "return" ? "return" : "use"); return;
      case "assign": this.assign(e, ctx); return;
      case "update": this.writeTo(e.e, e.op === "++" ? "++" : "--", e.line, ctx, null); return;
      case "delete": this.writeTo(e.e, "delete", e.line, ctx, null); return;
      case "call": this.call(e, ctx, usage); return;
      default: return;
    }
  }

  private assign(e: Extract<Expr, { k: "assign" }>, ctx: Ctx): void {
    this.expr(e.r, ctx, "use"); if (e.op !== "=") this.expr(e.l, ctx, "use");
    const r = rootId(e.l);
    if (e.op === "=" && e.l.k === "id" && ctx.success.has(e.l.name)) return;
    if (e.l.k === "id" && (ctx.locals.has(e.l.name) || ctx.params.has(e.l.name))) { if (this.tainted(e.r, ctx)) ctx.tainted.add(e.l.name); if (this.isAuthority(e.r, ctx)) ctx.authLocals.add(e.l.name); }
    if (r && (e.l.k === "tuple")) return;
    this.writeTo(e.l, e.op, e.line, ctx, e.r);
  }

  private writeTo(target: Expr, op: string, line: number, ctx: Ctx, rhs: Expr | null): void {
    const r = rootId(target);
    if (target.k === "tuple") { for (const i of target.items) if (i) this.writeTo(i, op, line, ctx, rhs); return; }
    if (!r || !this.rootIsState(r, ctx)) return;
    const sv = this.ix.stateVar(ctx.contract, r)!;
    let key: string | null = null; let keyedByCaller = false; let keyedByParam = false;
    let cur: Expr = target;
    while (cur.k === "index" || cur.k === "member") {
      if (cur.k === "index" && cur.idx) {
        key = key ? exprText(cur.idx) + "," + key : exprText(cur.idx);
        if (walkExpr(cur.idx, (x) => isCaller(x) || (x.k === "id" && this.aliasIsCaller(x.name, ctx)))) keyedByCaller = true;
        if (walkExpr(cur.idx, (x) => x.k === "id" && ctx.params.has(x.name))) keyedByParam = true;
      }
      cur = cur.obj;
    }
    const increasing = op === "+=" || op === "++" || (op === "=" && !!rhs && walkExpr(rhs, (x) => x.k === "binary" && x.op === "+"));
    const decreasing = op === "-=" || op === "--" || op === "delete";
    this.events.push({ ...this.base(ctx, line), k: "write", variable: r, owner: sv.owner, key, op, increasing, decreasing, keyedByCaller, keyedByParam, text: exprText(target) });
  }

  private targetTaint(e: Expr, ctx: Ctx): { taint: "param" | "msg.sender" | "state" | "constant" | "other"; variable: string | null } {
    if (e.k === "id" && ctx.aliases.has(e.name)) { const al = ctx.aliases.get(e.name)!; return this.targetTaint(al.expr, al.ctx); } // a helper's parameter stands for the argument it was given
    if (walkExpr(e, isCaller)) return { taint: "msg.sender", variable: null };
    const roots: string[] = []; walkExpr(e, (x) => { if (x.k === "id") roots.push(x.name); return false; });
    if (roots.some((n) => ctx.tainted.has(n))) return { taint: "param", variable: roots.find((n) => ctx.tainted.has(n)) ?? null };
    const st = roots.find((n) => this.rootIsState(n, ctx));
    if (st) { const v = this.ix.stateVar(ctx.contract, st)!; return { taint: v.constant || v.immutable ? "constant" : "state", variable: st }; }
    if (e.k === "call" && e.args.length === 1 && e.args[0]!.k === "id" && e.args[0]!.name === "this") return { taint: "constant", variable: null };
    return { taint: "other", variable: null };
  }

  private lowCall(e: Extract<Expr, { k: "call" }>, obj: Expr, name: string, ctx: Ctx, usage: string): Extract<Ev, { k: "call" }> {
    for (const a of e.args) this.expr(a, ctx, "use");
    this.expr(obj, ctx, "use");
    const valueExpr = e.opts["value"] ?? ((name === "send" || name === "transfer") ? e.args[0] ?? null : null);
    if (valueExpr) this.expr(valueExpr, ctx, "use");
    const tt = this.targetTaint(obj, ctx);
    const checked: Extract<Ev, { k: "call" }>["checked"] = name === "transfer" ? "n/a" : name === "staticcall" ? "n/a" : usage === "discard" ? "unchecked" : usage === "use" ? "checked" : usage === "return" ? "returned" : "unchecked";
    const ev: Extract<Ev, { k: "call" }> = {
      ...this.base(ctx, e.line), k: "call", low: name as "call", targetText: exprText(obj), targetExpr: obj, valueText: valueExpr ? exprText(valueExpr) : null, hasValue: !!valueExpr,
      callee: null, calleeResolved: false, attackerTarget: tt.taint === "param" || tt.taint === "msg.sender", checked, targetTaint: tt.taint, targetVar: tt.variable,
    };
    this.events.push(ev); return ev;
  }

  private call(e: Extract<Expr, { k: "call" }>, ctx: Ctx, usage: "discard" | "use" | "capture" | "return"): void {
    const fn = e.fn;
    if (fn.k === "id") {
      const n = fn.name;
      if (n === "require" || n === "assert") {
        const cond = e.args[0]; if (!cond) return;
        this.expr(cond, ctx, "use"); this.emitGuard(cond, true, ctx, e.line); return;
      }
      if (n === "revert") return;
      if (n === "selfdestruct" || n === "suicide") { for (const a of e.args) this.expr(a, ctx, "use"); this.events.push({ ...this.base(ctx, e.line), k: "destruct", text: exprText(e) }); return; }
      if (["keccak256", "sha256", "ecrecover", "addmod", "mulmod", "blockhash", "gasleft", "payable"].includes(n) || ELEMENTARY.test(n) || this.ix.isContractLike(n)) { for (const a of e.args) this.expr(a, ctx, "use"); return; }
      // an internal call is dispatched on the deployed contract: the most-derived override is found from ctx.contract and the callee keeps
      // running in that context, so a base function calling a virtual hook reaches the override the deployed contract actually has
      const callee = this.ix.findFunction(ctx.contract, n, e.args.length);
      if (callee) { this.inline(callee, ctx.contract, e, ctx, usage); return; }
      for (const a of e.args) this.expr(a, ctx, "use"); this.unknowns.push(`${ctx.file}:${e.line}: call to unresolved function ${n}`); return;
    }
    if (fn.k === "member") {
      const obj = fn.obj; const name = fn.name;
      if (obj.k === "id" && BUILTIN_OBJ.has(obj.name)) { for (const a of e.args) this.expr(a, ctx, "use"); return; }
      if (obj.k === "id" && obj.name === "super") {
        const defs = this.ix.findFunctions(ctx.contract, name).filter((f) => f !== ctx.fn);
        const callee = defs.find((f) => f.params.length === e.args.length && f.body) ?? defs[0];
        if (callee) { this.inline(callee, callee.contract, e, ctx, usage); return; }
      }
      if (obj.k === "id" && obj.name === "this") {
        const callee = this.ix.findFunction(ctx.contract, name, e.args.length); if (callee) { this.inline(callee, ctx.contract, e, ctx, usage); return; }
      }
      if (obj.k === "id" && this.ix.contracts.get(obj.name)?.kind === "library") {
        const callee = this.ix.findFunction(obj.name, name, e.args.length); if (callee) { this.inline(callee, obj.name, e, ctx, usage); return; }
      }
      const t = this.typeOf(obj, ctx);
      const isAddr = !t || /^address/.test(t);
      if ((name === "call" || name === "delegatecall" || name === "staticcall") && isAddr) { this.lowCall(e, obj, name, ctx, usage); return; }
      if ((name === "send" || name === "transfer") && isAddr && e.args.length === 1) { this.lowCall(e, obj, name, ctx, usage); return; }
      if ((name === "push" || name === "pop") && rootId(obj) && this.rootIsState(rootId(obj), ctx)) { for (const a of e.args) this.expr(a, ctx, "use"); this.writeTo(obj, name, e.line, ctx, e.args[0] ?? null); return; }
      for (const a of e.args) this.expr(a, ctx, "use");
      if (e.opts["value"]) this.expr(e.opts["value"], ctx, "use");
      this.expr(obj, ctx, "use");
      // typed external call
      const tt = this.targetTaint(obj, ctx);
      const calleeDef = t && this.ix.isContractLike(t) ? this.ix.findFunction(t, name, e.args.length) : null;
      const concrete = !!calleeDef?.body;
      const ev: Extract<Ev, { k: "call" }> = {
        ...this.base(ctx, e.line), k: "call", low: null, targetText: exprText(obj), targetExpr: obj, valueText: e.opts["value"] ? exprText(e.opts["value"]) : null, hasValue: !!e.opts["value"],
        callee: t ? `${t}.${name}` : name, calleeResolved: concrete, attackerTarget: tt.taint === "param" || tt.taint === "msg.sender", checked: "n/a", targetTaint: tt.taint, targetVar: tt.variable,
      };
      this.events.push(ev);
      if (concrete && calleeDef && t) this.inline(calleeDef, t, e, ctx, usage, true);
      return;
    }
    // call on an arbitrary expression, e.g. f()(x) or (a.b)(x)
    for (const a of e.args) this.expr(a, ctx, "use"); this.expr(fn, ctx, "use");
  }

  private inline(callee: FunctionDef, contract: string, e: Extract<Expr, { k: "call" }>, ctx: Ctx, usage: "discard" | "use" | "capture" | "return", cross = false): void {
    for (const a of e.args) this.expr(a, ctx, "use");
    const key = `${contract}.${callee.name}`;
    if (ctx.depth >= 8 || ctx.stack.includes(key) || !callee.body) return;
    const tainted = new Set<string>();
    callee.params.forEach((p, i) => { const a = e.args[i]; if (p.name && a && (cross ? true : this.tainted(a, ctx))) tainted.add(p.name); });
    const chain = [...ctx.chain, { fn: callee.name, contract, file: callee.file, line: e.line }];
    const sub = this.newCtx(callee, contract, chain, tainted, ctx.depth + 1, ctx.stack);
    sub.branch = { ...ctx.branch };
    callee.params.forEach((p, i) => { const a = e.args[i]; if (!p.name || !a) return; sub.aliases.set(p.name, { expr: a, ctx }); if (this.isAuthority(a, ctx)) sub.authLocals.add(p.name); });
    const before = this.events.length;
    this.runWithModifiers(callee, sub, 0);
    const used: "checked" | "unchecked" | "returned" = usage === "discard" ? "unchecked" : usage === "return" ? "returned" : "checked";
    for (const ev of this.events.slice(before)) if (ev.k === "call" && ev.checked === "returned") ev.checked = used;
  }
}
