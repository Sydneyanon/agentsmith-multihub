import type { ProgramIndex } from "./index.js";
import type { Expr, FunctionDef, Stmt } from "./parser.js";
import { isCaller, type TraceResult } from "./trace.js";

/**
 * Protocol model step P2: state-variable roles (docs/protocol-model-p1-p3-plan.md; conforms to T-149).
 *
 * ONE derivation of what each state variable is, shared by the protocol model, the specialists (authorities) and the execution validator
 * (ledgers and aggregates for consistent world seeding). It replaces the private derivations those components had.
 *
 * Every role carries:
 *  - basis: `established` when it follows directly from syntax with no heuristic (a declared address-keyed numeric mapping; a variable
 *    used as a delegatecall target), `inferred` when a named rule over syntax or traces produced it;
 *  - strength: strong | medium | weak. `weak` marks name-only or pattern-only evidence: it says what the code SUGGESTS, never what it
 *    guarantees. No role here is a security guarantee;
 *  - the rule id and the exact code locations that support it.
 * A variable with no role is kept as `unclassified` (reason recorded); roles of different kinds make it `ambiguous`.
 */
export const STATE_ROLES_VERSION = "state-roles/1";
export const AUTH_VAR_NAME = /^(owner|admin|governance|governor|guardian|operator|treasury|implementation|pendingOwner|oracle|feeRecipient|minter|authority|manager|keeper)s?$/i;
const ROLE_LIKE_NAME = /role|admin|operator|minter|whitelist|allowlist|authori[sz]ed|guardian|governor|keeper|manager|staff|signer/i;
const LEDGER_TYPE = /^mapping\s*\(\s*address\s*=>\s*u?int/;
const POINTER_NAME = /^_?(implementation|impl|logic|beacon|target|module|delegate)s?$/i;
const SLOT_NAME = /(IMPLEMENTATION|ADMIN|BEACON|OWNER)[A-Z_]*_SLOT$|^_?(IMPLEMENTATION|ADMIN|BEACON)_SLOT/;

export type RoleKind = "ledger" | "aggregate" | "authority" | "implementation_pointer" | "lock";
export type Basis = "established" | "inferred";
export type Strength = "strong" | "medium" | "weak";
export type Loc = { file: string; line: number };
export type Role = { role: RoleKind; basis: Basis; strength: Strength; rule: string; note?: string; evidence: Loc[] };
export type VariableRoles = {
  variable: string; declaredIn: string; type: string; declaration: Loc;
  status: "classified" | "weak-only" | "ambiguous" | "unclassified"; roles: Role[]; reason?: string;
};

/** expression walker over statement lists (shared with the validator) */
export function walkStmts(stmts: Stmt[], f: (e: Expr) => void): void {
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
      case "if": walk(s.cond); walkStmts(s.then, f); walkStmts(s.els, f); break;
      case "loop": walk(s.cond); walkStmts(s.body, f); break; case "block": walkStmts(s.body, f); break;
      case "return": walk(s.e); break; case "try": walk(s.call); walkStmts(s.body, f); s.catches.forEach((c) => walkStmts(c, f)); break;
    }
  }
}
const lineOf = (e: Expr): number | null => ((e as { line?: number }).line ?? null);

/** The roles of every state variable visible in `contract` (its own and inherited), derived over its linearisation. */
export function stateVariableRoles(ix: ProgramIndex, trace: (f: FunctionDef) => TraceResult, contract: string): VariableRoles[] {
  const lin = ix.linearize(contract);
  const roles = new Map<string, Role[]>();
  const add = (v: string, r: Role) => {
    const list = roles.get(v) ?? []; const same = list.find((x) => x.role === r.role && x.rule === r.rule);
    if (same) { for (const e of r.evidence) if (!same.evidence.some((x) => x.file === e.file && x.line === e.line)) same.evidence.push(e); }
    else list.push({ ...r, evidence: [...r.evidence] });
    roles.set(v, list);
  };
  const sv = (name: string) => ix.stateVar(contract, name);
  const ledgerNames = new Set<string>();
  for (const c of lin) for (const v of c.stateVars) if (LEDGER_TYPE.test(v.type)) ledgerNames.add(v.name);

  for (const c of lin) {
    for (const v of c.stateVars) {
      const decl = { file: c.file, line: v.line };
      if (LEDGER_TYPE.test(v.type)) add(v.name, { role: "ledger", basis: "established", strength: "strong", rule: "address-keyed-numeric-mapping", note: "declared type; that it holds per-account balances is how the validator uses it", evidence: [decl] });
      if (AUTH_VAR_NAME.test(v.name)) add(v.name, { role: "authority", basis: "inferred", strength: "weak", rule: "name-pattern", note: "name only: suggests an authority, guarantees nothing", evidence: [decl] });
      if (/^address/.test(v.type) && POINTER_NAME.test(v.name)) add(v.name, { role: "implementation_pointer", basis: "inferred", strength: "weak", rule: "pointer-name", note: "name only", evidence: [decl] });
      if (v.constant && /^bytes32/.test(v.type) && SLOT_NAME.test(v.name)) add(v.name, { role: "implementation_pointer", basis: "inferred", strength: "weak", rule: "storage-slot-constant-name", note: "a slot constant by name; its use is in inline assembly, which is not modelled", evidence: [decl] });
    }
    for (const f of [...c.functions, ...c.modifiers]) {
      if (!f.body) continue;
      const tr = trace(f);
      // authority: read by an authorising guard (polarity from the trace, so one-shot `require(!claimed[msg.sender])` does not qualify)
      // only checks that run in THIS contract (or a library it uses) say anything about this contract's authorities; a check inside a
      // contract it calls reads THAT contract's variables (the shared guard-side rule, authority.ts)
      for (const g of tr.events) if (g.k === "guard" && g.auth && !g.assumed && (g.contract === c.name || g.contract === contract || ix.contracts.get(g.contract)?.kind === "library")) for (const r of g.reads) { const v = sv(r); if (v && !v.constant && !v.immutable) add(r, { role: "authority", basis: "inferred", strength: "strong", rule: "authorising-guard-read", evidence: [{ file: g.file, line: g.line }] }); }
      // implementation pointer: a storage variable used as a delegatecall target (a direct fact of the code)
      for (const e of tr.events) if (e.k === "call" && e.low === "delegatecall" && e.targetTaint === "state" && e.targetVar && sv(e.targetVar)) add(e.targetVar, { role: "implementation_pointer", basis: "established", strength: "strong", rule: "delegatecall-target", evidence: [{ file: e.file, line: e.line }] });
      // lock: a SCALAR bool/uint flag that a guard reads, that is SET BY ASSIGNMENT before an external call and RESET after it
      // (the re-entrancy-lock shape). A ledger checked and decremented before a call is checks-effects-interactions, not a lock.
      const ev = tr.events;
      for (let i = 0; i < ev.length; i++) {
        const g = ev[i]!; if (g.k !== "guard") continue;
        for (const r of g.reads) {
          const v = sv(r); if (r.startsWith("<") || !v || !/^(bool|u?int)/.test(v.type) || v.constant || v.immutable) continue;
          const w = ev.findIndex((x, j) => j > i && x.k === "write" && x.variable === r && x.key === null && x.op === "=");
          const call = w > 0 ? ev.findIndex((x, j) => j > w && x.k === "call") : -1;
          const reset = call > 0 ? ev.findIndex((x, j) => j > call && x.k === "write" && x.variable === r && x.key === null && x.op === "=") : -1;
          if (reset > 0) add(r, { role: "lock", basis: "inferred", strength: "strong", rule: "checked-set-call-reset", evidence: [{ file: g.file, line: g.line }, { file: ev[w]!.file, line: ev[w]!.line }, { file: ev[reset]!.file, line: ev[reset]!.line }] });
        }
      }
      // aggregate (trace rule, through inlined helpers): a scalar uint updated with += / -= in the same trace as a ledger entry update
      const ledgerUpd = ev.some((x) => x.k === "write" && ledgerNames.has(x.variable) && x.key !== null && (x.op === "+=" || x.op === "-="));
      if (ledgerUpd) for (const x of ev) if (x.k === "write" && x.key === null && (x.op === "+=" || x.op === "-=")) {
        const v = sv(x.variable); if (v && /^u?int/.test(v.type) && !v.constant && !v.immutable) add(x.variable, { role: "aggregate", basis: "inferred", strength: "strong", rule: "co-updated-with-ledger-in-trace", evidence: [{ file: x.file, line: x.line }] });
      }
    }
    // constructor records msg.sender: a privileged role whatever it is called
    for (const f of c.functions) if (f.kind === "constructor" && f.body) walkStmts(f.body, (e) => {
      if (e.k === "assign" && e.op === "=" && isCaller(e.r) && e.l.k === "id" && sv(e.l.name)) add(e.l.name, { role: "authority", basis: "inferred", strength: "medium", rule: "constructor-records-caller", evidence: [{ file: f.file, line: lineOf(e) ?? f.startLine }] });
    });
    for (const f of [...c.functions, ...c.modifiers]) if (f.body) walkStmts(f.body, (e) => {
      const root = (x: Expr): string | null => x.k === "id" ? x.name : x.k === "index" || x.k === "member" ? root(x.obj) : null;
      if (e.k === "binary" && (e.op === "==" || e.op === "!=")) {
        const other = isCaller(e.l) ? e.r : isCaller(e.r) ? e.l : null; const r = other ? root(other) : null;
        if (r && sv(r)) add(r, { role: "authority", basis: "inferred", strength: "strong", rule: "compared-with-caller", evidence: [{ file: f.file, line: lineOf(e) ?? f.startLine }] });
      }
      // a caller-keyed flag is one-shot bookkeeping unless the name is role-like: weak, name-dependent
      if (e.k === "index" && e.idx && isCaller(e.idx)) { const r = root(e.obj); if (r && sv(r) && (AUTH_VAR_NAME.test(r) || ROLE_LIKE_NAME.test(r))) add(r, { role: "authority", basis: "inferred", strength: "weak", rule: "caller-indexed-role-name", note: "name-dependent", evidence: [{ file: f.file, line: lineOf(e) ?? f.startLine }] }); }
      // aggregate (syntactic rule, same function body): kept so the shared derivation is a superset of the validator's former rule
      if (e.k === "assign" && (e.op === "+=" || e.op === "-=") && e.l.k === "id") {
        const v = sv(e.l.name);
        if (v && /^u?int/.test(v.type) && !v.constant && !v.immutable && bodyUpdatesLedger(f.body!, ledgerNames)) add(e.l.name, { role: "aggregate", basis: "inferred", strength: "strong", rule: "co-updated-with-ledger-in-body", evidence: [{ file: f.file, line: lineOf(e) ?? f.startLine }] });
      }
    });
  }

  const out: VariableRoles[] = [];
  const seen = new Set<string>();
  for (const c of lin) for (const v of c.stateVars) {
    if (seen.has(v.name)) continue; seen.add(v.name);
    const rs = (roles.get(v.name) ?? []).map((r) => ({ ...r, evidence: [...new Map(r.evidence.map((e) => [`${e.file}:${e.line}`, e])).values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line) }))
      .sort((a, b) => a.role.localeCompare(b.role) || a.rule.localeCompare(b.rule));
    const firm = new Set(rs.filter((r) => r.strength !== "weak").map((r) => r.role));
    const status = rs.length === 0 ? "unclassified" : firm.size === 0 ? "weak-only" : firm.size > 1 ? "ambiguous" : "classified";
    out.push({ variable: v.name, declaredIn: c.name, type: v.type, declaration: { file: c.file, line: v.line }, status, roles: rs, ...(status === "unclassified" ? { reason: "no rule matched (not a ledger type, not read by an authorising guard, not compared with the caller, not a delegatecall target, not a checked-then-set lock, not co-updated with a ledger)" } : {}) });
  }
  return out.sort((a, b) => a.variable.localeCompare(b.variable));
}

function bodyUpdatesLedger(body: Stmt[], ledgers: Set<string>): boolean {
  let hit = false;
  walkStmts(body, (e) => {
    if (e.k === "assign" && (e.op === "+=" || e.op === "-=") && e.l.k === "index") { let r: Expr = e.l; while (r.k === "index" || r.k === "member") r = r.obj; if (r.k === "id" && ledgers.has(r.name)) hit = true; }
  });
  return hit;
}

export const namesWithRole = (rs: readonly VariableRoles[], role: RoleKind): string[] => rs.filter((v) => v.roles.some((r) => r.role === role)).map((v) => v.variable);
