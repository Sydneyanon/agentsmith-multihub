import { ProgramIndex } from "./index.js";
import { exprText, type Expr, type FunctionDef, type Stmt } from "./parser.js";
import { isCaller, Tracer, type Ev, type Frame, type TraceResult } from "./trace.js";

/**
 * Deterministic specialists over the structural index. Each emits LEADS with cited lines, never verified vulnerabilities.
 * Findings carry the call chain through internal helpers and the assumptions made (for example a modifier imported from a file
 * that was not analysed), so a reviewer can see exactly why the claim was made and what it rests on.
 */
export type FindingClass = "reentrancy" | "access-control" | "initializer" | "delegatecall" | "unchecked-call" | "selfdestruct" | "tx-origin";
export type Span = { file: string; lineStart: number; lineEnd: number; role: "primary" | "supporting" | "context" };
export type Finding = {
  class: FindingClass; contract: string; function: string; file: string; line: number; claim: string; rationale: string;
  requiredChecks: string[]; alternatives: string[]; spans: Span[]; chain: Frame[]; assumptions: string[]; confidence: "high" | "medium" | "low";
  detail: Record<string, string | number | boolean | null>;
};

const AUTH_VAR_NAME = /^(owner|admin|governance|governor|guardian|operator|treasury|implementation|pendingOwner|oracle|feeRecipient|minter|authority|manager|keeper)s?$/i;
const PRIV_NAME = /^(set|update|change|configure|add|remove|grant|revoke|pause|unpause|upgrade|mint|burn|rescue|sweep|drain|withdrawAll|transferOwnership|renounce)/i;
const INIT_NAME = /^(__\w*_)?(re)?init(iali[sz]e)?\w*$|^setup\w*$/i;

function eachExpr(stmts: Stmt[], f: (e: Expr) => void): void {
  const walk = (e: Expr | null | undefined): void => {
    if (!e) return; f(e);
    switch (e.k) {
      case "member": walk(e.obj); break; case "index": walk(e.obj); walk(e.idx); break;
      case "call": walk(e.fn); e.args.forEach(walk); Object.values(e.opts).forEach(walk); break;
      case "unary": walk(e.e); break; case "binary": case "assign": walk(e.l); walk(e.r); break;
      case "update": case "delete": walk(e.e); break; case "ternary": walk(e.c); walk(e.a); walk(e.b); break;
      case "tuple": e.items.forEach(walk); break; case "new": e.args.forEach(walk); break;
    }
  };
  for (const s of stmts) {
    switch (s.k) {
      case "expr": walk(s.e); break; case "decl": walk(s.init); break;
      case "if": walk(s.cond); eachExpr(s.then, f); eachExpr(s.els, f); break;
      case "loop": walk(s.cond); eachExpr(s.body, f); break; case "block": eachExpr(s.body, f); break;
      case "return": walk(s.e); break; case "try": walk(s.call); eachExpr(s.body, f); s.catches.forEach((c) => eachExpr(c, f)); break;
    }
  }
}

export class Analyzer {
  private readonly traces = new Map<FunctionDef, TraceResult>();
  private readonly authCache = new Map<string, Set<string>>();
  constructor(readonly ix: ProgramIndex) {}

  trace(fn: FunctionDef): TraceResult { let t = this.traces.get(fn); if (!t) { t = new Tracer(this.ix).run(fn); this.traces.set(fn, t); } return t; }

  /** state variables that act as the authority in some check in this contract or its bases (owner, admins mapping, role tables ...) */
  authVars(contract: string): Set<string> {
    const cached = this.authCache.get(contract); if (cached) return cached;
    const out = new Set<string>();
    for (const c of this.ix.linearize(contract)) {
      for (const v of c.stateVars) if (AUTH_VAR_NAME.test(v.name)) out.add(v.name);
      for (const f of [...c.functions, ...c.modifiers]) if (f.body) eachExpr(f.body, (e) => {
        const root = (x: Expr): string | null => x.k === "id" ? x.name : x.k === "index" || x.k === "member" ? root(x.obj) : null;
        if (e.k === "binary" && (e.op === "==" || e.op === "!=")) {
          const other = isCaller(e.l) ? e.r : isCaller(e.r) ? e.l : null; const r = other ? root(other) : null;
          if (r && this.ix.stateVar(contract, r)) out.add(r);
        }
        if (e.k === "index" && e.idx && isCaller(e.idx)) { const r = root(e.obj); if (r && this.ix.stateVar(contract, r)) { const v = this.ix.stateVar(contract, r)!; if (/bool|mapping\s*\([^)]*=>\s*bool\)/.test(v.type) || AUTH_VAR_NAME.test(r) || /role|admin|operator|minter|whitelist|allow/i.test(r)) out.add(r); } }
      });
    }
    this.authCache.set(contract, out); return out;
  }

  private guardedBefore(events: Ev[], idx: number): boolean {
    const target = events[idx]!;
    if (target.prot) return true;
    // A REVERTING caller check protects the whole function wherever it sits (a revert undoes earlier writes and transfers);
    // a non-reverting early return only protects what comes after it.
    for (let i = 0; i < events.length; i++) { const g = events[i]!; if (g.k === "guard" && g.auth && !g.cond && (g.reverting || i < idx)) return true; }
    return false;
  }

  private span(file: string, line: number, role: Span["role"]): Span { return { file, lineStart: line, lineEnd: line, role }; }
  private chainSpans(chain: Frame[]): Span[] { return chain.map((f) => this.span(f.file, f.line, "supporting")); }

  analyze(): Finding[] {
    const out: Finding[] = [];
    for (const c of [...this.ix.contracts.values()].sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))) {
      if (c.kind === "interface" || c.kind === "library") continue;
      for (const fn of this.ix.entryPoints(c.name)) {
        const tr = this.trace(fn); const ev = tr.events;
        out.push(...this.reentrancy(fn, tr), ...this.accessControl(fn, tr), ...this.initializer(fn, tr), ...this.delegatecall(fn, tr),
          ...this.uncheckedCall(fn, tr), ...this.selfdestruct(fn, tr), ...this.txOrigin(fn, tr));
        void ev;
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.class.localeCompare(b.class) || a.function.localeCompare(b.function));
  }

  private mk(fn: FunctionDef, cls: FindingClass, line: number, file: string, p: Partial<Finding> & Pick<Finding, "claim" | "rationale">, tr: TraceResult): Finding {
    return {
      class: cls, contract: fn.contract, function: fn.name, file, line, requiredChecks: [], alternatives: [], spans: [this.span(file, line, "primary")], chain: [], assumptions: tr.assumptions.slice(),
      confidence: tr.assumptions.length || tr.unknowns.length ? "medium" : "high", detail: {}, ...p,
    };
  }

  // ---------------------------------------------------------------- reentrancy
  private reentrancy(fn: FunctionDef, tr: TraceResult): Finding[] {
    const ev = tr.events;
    for (let i = 0; i < ev.length; i++) {
      const c = ev[i]!;
      if (c.k !== "call" || !(c.low === "call" || c.low === null) || !c.attackerTarget) continue;
      // a lock engaged before the call: a guard that reads variable V followed by a write to V
      let locked: string | null = null;
      for (let a = 0; a < i && !locked; a++) { const g = ev[a]!; if (g.k !== "guard") continue; for (let b = a + 1; b < i; b++) { const w = ev[b]!; if (w.k === "write" && g.reads.includes(w.variable)) { locked = w.variable; break; } } }
      if (locked) continue;
      const readBefore = new Set<string>(); const writtenBefore = new Set<string>();
      for (let a = 0; a < i; a++) { const e = ev[a]!; if (e.k === "read") readBefore.add(e.variable); else if (e.k === "guard") e.reads.forEach((r) => readBefore.add(r)); else if (e.k === "write") writtenBefore.add(e.variable); }
      for (let b = i + 1; b < ev.length; b++) {
        const w = ev[b]!;
        if (w.k !== "write" || w.variable.startsWith("<") || !readBefore.has(w.variable) || writtenBefore.has(w.variable)) continue;
        const via = c.chain.length ? ` (the call is reached through ${c.chain.map((f) => `${f.contract}.${f.fn}`).join(" -> ")})` : "";
        return [this.mk(fn, "reentrancy", c.line, c.file, {
          claim: `${fn.contract}.${fn.name} makes an external call that hands control to ${c.targetText} (${c.file}:${c.line})${via} and only afterwards updates ${w.variable}${w.key ? `[${w.key}]` : ""} (${w.file}:${w.line}), which it relied on before the call; a re-entering receiver would see stale state.`,
          rationale: "Checks-effects-interactions is violated and no reentrancy lock is held at the call: the callee is attacker-controlled and the state it can re-enter against has not yet been updated.",
          requiredChecks: ["Confirm the callee can re-enter an external function of this contract", "Confirm no lock or earlier write to the same variable protects the path", "Reproduce with a malicious receiver in a local fork test"],
          alternatives: ["A lock or modifier the analysis could not see may protect the function", "Checked arithmetic on the later write may make the re-entrant path revert (see the independent validation)"],
          spans: [this.span(c.file, c.line, "primary"), this.span(w.file, w.line, "supporting"), ...this.chainSpans(c.chain)], chain: c.chain,
          detail: { callLine: c.line, writeLine: w.line, writtenVariable: w.variable, writeOp: w.op, target: c.targetText },
        }, tr)];
      }
    }
    return [];
  }

  // ---------------------------------------------------------------- access control
  private accessControl(fn: FunctionDef, tr: TraceResult): Finding[] {
    if (INIT_NAME.test(fn.name)) return [];
    const ev = tr.events; const auth = this.authVars(fn.contract);
    const paying = fn.mutability === "payable";
    const hasCallerDecrease = ev.some((e) => e.k === "write" && e.decreasing && e.keyedByCaller);
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!; let why: string | null = null; let priv = false;
      if (e.k === "write" && auth.has(e.variable)) why = `writes the authority variable ${e.variable}`;
      else if (e.k === "call" && e.hasValue && (e.low === "call" || e.low === "send" || e.low === "transfer") && e.targetTaint !== "msg.sender" && /address\s*\(\s*this\s*\)\s*\.balance|\bbalance\b/.test(e.valueText ?? "") && !/msg\.value/.test(e.valueText ?? "") && e.targetTaint !== "other") why = `sends ether (${e.valueText}) to ${e.targetText}, which is not the caller`;
      else if (e.k === "call" && e.hasValue && e.low !== null && e.targetTaint === "param" && !paying && !/msg\.value/.test(e.valueText ?? "") && !ev.some((x) => x.k === "write" && x.decreasing && x.keyedByCaller)) why = `sends ether to the caller-supplied address ${e.targetText}`;
      else if (e.k === "write" && e.increasing && e.keyedByParam && !e.keyedByCaller && !paying && !hasCallerDecrease && !ev.some((x) => x.k === "call" && x.callee !== null)) why = `increases ${e.variable}[${e.key}] for a caller-chosen account without consuming a matching amount from the caller`;
      else if (e.k === "write" && PRIV_NAME.test(fn.name) && !e.variable.startsWith("<") && !e.keyedByCaller && !paying) { why = `changes the state variable ${e.variable} (privileged-looking function name "${fn.name}")`; priv = true; }
      if (!why || this.guardedBefore(ev, i)) continue;
      return [this.mk(fn, "access-control", e.line, e.file, {
        claim: `${fn.contract}.${fn.name} ${why} (${e.file}:${e.line}) and no caller-authorisation check dominates that statement.`,
        rationale: "A privileged effect is reachable by any caller: no modifier, require, revert-guard or helper that compares the caller with an authority precedes it on the analysed path.",
        requiredChecks: ["Confirm the function is externally reachable in the deployed configuration", "Check for an access control outside the analysed files (proxy admin, inherited unanalysed modifier)"],
        alternatives: ["The function may be intentionally permissionless", "Authorisation may be enforced by a base contract that was not analysed"],
        spans: [this.span(e.file, e.line, "primary"), this.span(fn.file, fn.startLine, "context"), ...this.chainSpans(e.chain)], chain: e.chain, detail: { reason: why, sensitiveLine: e.line }, ...(priv ? { confidence: "medium" as const } : {}),
      }, tr)];
    }
    return [];
  }

  // ---------------------------------------------------------------- initializer
  private initializer(fn: FunctionDef, tr: TraceResult): Finding[] {
    if (!INIT_NAME.test(fn.name)) return [];
    const ev = tr.events; const auth = this.authVars(fn.contract);
    const idx = ev.findIndex((e) => e.k === "write" && auth.has(e.variable) && e.chain.length === 0 || (e.k === "write" && auth.has(e.variable)));
    if (idx < 0) return [];
    const w = ev[idx] as Extract<Ev, { k: "write" }>;
    if (this.guardedBefore(ev, idx)) return [];
    const oneTime = ev.some((g, gi) => g.k === "guard" && ev.some((x, xi) => x.k === "write" && xi > gi && g.reads.includes(x.variable) && !auth.has(x.variable)));
    if (oneTime) return [];
    return [this.mk(fn, "initializer", w.line, w.file, {
      claim: `${fn.contract}.${fn.name} sets the authority variable ${w.variable} (${w.file}:${w.line}) with no caller check and no one-time guard, so any account can call it (again) and take control.`,
      rationale: "Initialisation functions must run once and only by the deployer; here neither a flag that is checked and then set, nor an authorisation check, was found on the path.",
      requiredChecks: ["Confirm the function is callable after deployment", "Check whether a proxy or deployment script initialises atomically"],
      alternatives: ["Initialisation may be performed atomically in the deployment transaction, outside the analysed files"],
      detail: { variable: w.variable },
    }, tr)];
  }

  // ---------------------------------------------------------------- delegatecall
  private delegatecall(fn: FunctionDef, tr: TraceResult): Finding[] {
    const ev = tr.events;
    for (let i = 0; i < ev.length; i++) {
      const c = ev[i]!; if (c.k !== "call" || c.low !== "delegatecall") continue;
      let provenance: string | null = null;
      if (c.targetTaint === "param" || c.targetTaint === "msg.sender") provenance = "caller-supplied";
      else if (c.targetTaint === "state" && c.targetVar && this.attackerWritable(fn.contract, c.targetVar)) provenance = `a storage variable (${c.targetVar}) that an unguarded function can set`;
      if (!provenance || this.guardedBefore(ev, i)) continue;
      return [this.mk(fn, "delegatecall", c.line, c.file, {
        claim: `${fn.contract}.${fn.name} delegatecalls to ${c.targetText} (${c.file}:${c.line}), whose address is ${provenance}, with no caller-authorisation check before it.`,
        rationale: "delegatecall executes the target's code against this contract's storage; an attacker-chosen target can overwrite ownership and balances or self-destruct the contract.",
        requiredChecks: ["Confirm the target can be chosen by an unprivileged caller", "Confirm no allow-list restricts the target"],
        alternatives: ["The target may be validated against an allow-list the analysis could not see"],
        spans: [this.span(c.file, c.line, "primary"), ...this.chainSpans(c.chain)], chain: c.chain, detail: { target: c.targetText, provenance },
      }, tr)];
    }
    return [];
  }

  private attackerWritable(contract: string, variable: string): boolean {
    for (const c of this.ix.linearize(contract)) for (const f of this.ix.entryPoints(c.name)) {
      const t = this.trace(f);
      for (let i = 0; i < t.events.length; i++) { const e = t.events[i]!; if (e.k === "write" && e.variable === variable && !this.guardedBefore(t.events, i)) return true; }
    }
    return false;
  }

  // ---------------------------------------------------------------- unchecked low-level call
  private uncheckedCall(fn: FunctionDef, tr: TraceResult): Finding[] {
    for (const c of tr.events) {
      if (c.k !== "call" || c.low === null || c.checked !== "unchecked" || (c.low !== "call" && c.low !== "send" && c.low !== "delegatecall")) continue;
      const via = c.chain.length ? ` inside ${c.chain.map((f) => f.fn).join(" -> ")}` : "";
      return [this.mk(fn, "unchecked-call", c.line, c.file, {
        claim: `${fn.contract}.${fn.name} ignores the success flag of a low-level ${c.low} to ${c.targetText} (${c.file}:${c.line})${via}.`,
        rationale: "A failed call is treated as success, so any accounting done on the assumption that the transfer or call happened can diverge from reality.",
        requiredChecks: ["Confirm the result is not used on any path", "Find what state changes assume the call succeeded"],
        alternatives: ["The call may be deliberately best-effort"], spans: [this.span(c.file, c.line, "primary"), ...this.chainSpans(c.chain)], chain: c.chain, detail: { kind: c.low },
      }, tr)];
    }
    return [];
  }

  // ---------------------------------------------------------------- selfdestruct
  private selfdestruct(fn: FunctionDef, tr: TraceResult): Finding[] {
    const ev = tr.events;
    for (let i = 0; i < ev.length; i++) {
      const d = ev[i]!; if (d.k !== "destruct" || this.guardedBefore(ev, i)) continue;
      return [this.mk(fn, "selfdestruct", d.line, d.file, {
        claim: `${fn.contract}.${fn.name} can selfdestruct the contract (${d.file}:${d.line}) and no caller-authorisation check dominates it.`,
        rationale: "Any caller can destroy the contract and redirect its ether.", requiredChecks: ["Confirm no authorisation outside the analysed files applies"],
        alternatives: ["Access may be restricted by an unanalysed base contract or proxy"], spans: [this.span(d.file, d.line, "primary"), ...this.chainSpans(d.chain)], chain: d.chain,
      }, tr)];
    }
    return [];
  }

  // ---------------------------------------------------------------- tx.origin
  private txOrigin(fn: FunctionDef, tr: TraceResult): Finding[] {
    for (const o of tr.events) {
      if (o.k !== "origin" || o.usage !== "auth") continue;
      return [this.mk(fn, "tx-origin", o.line, o.file, {
        claim: `${fn.contract}.${fn.name} authorises with tx.origin (${o.file}:${o.line}: ${o.text}).`,
        rationale: "tx.origin is the externally owned account that started the transaction, so any contract that account is tricked into calling can act with its authority.",
        requiredChecks: ["Confirm the check protects a privileged action", "Confirm a phishing contract can be reached by the authorised account"],
        alternatives: ["If the comparison is only an anti-contract check (tx.origin == msg.sender) it is not authorisation"], spans: [this.span(o.file, o.line, "primary"), ...this.chainSpans(o.chain)], chain: o.chain,
      }, tr)];
    }
    return [];
  }
}

export function analyzeSources(sources: ReadonlyArray<{ path: string; text: string }>): { findings: Finding[]; index: ProgramIndex; problems: string[] } {
  const index = new ProgramIndex(sources); const a = new Analyzer(index);
  return { findings: a.analyze(), index, problems: index.problems };
}
void exprText;
