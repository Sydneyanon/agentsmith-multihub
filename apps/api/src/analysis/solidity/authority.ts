import type { ProgramIndex } from "./index.js";
import type { Expr, FunctionDef } from "./parser.js";
import { walkStmts, type VariableRoles } from "./state-roles.js";
import type { Ev, TraceResult } from "./trace.js";

/**
 * Protocol model step P3: privileged roles and trust boundaries (docs/protocol-model-p1-p3-plan.md; conforms to T-149).
 *
 * It represents WHO can do WHAT and through WHICH check, with code evidence for every element:
 *  - privileged roles (from the P2 authority roles) with how they are held and every function that writes them, under which control;
 *  - every authorising check on an entry point, classified by WHERE it runs (see `guardSide`);
 *  - deployments, factory-mediated authority (a role held by the deploying contract) and cross-contract authority paths;
 *  - proxy / implementation boundaries and the writers of the implementation pointer;
 *  - initialisation controls (one-time guards) and whether the constructor locks them;
 *  - external trust assumptions and everything left unresolved.
 *
 * A check is described, never certified: "caller-guarded" means an authorising check on the caller exists on the path, NOT that it is
 * correct or sufficient. Names never establish authority (authority roles come from P2, where name-only evidence is weak and flagged).
 */
export const AUTHORITY_VERSION = "authority/1";
export type Loc = { file: string; line: number };

/**
 * Where a guard runs relative to the function under analysis. In Solidity, `msg.sender` inside a contract called by this one is THIS
 * contract, so a check there (e.g. `require(msg.sender == factory)` in a child) is satisfied by this contract itself and says nothing about
 * who called this function. Library code runs in the caller's context, so its checks are caller-side.
 */
export type GuardSide = "caller-side" | "callee-side" | "assumed";
export function guardSide(ix: ProgramIndex, component: string, g: Extract<Ev, { k: "guard" }>): GuardSide {
  if (g.assumed) return "assumed";
  if (g.contract !== component && ix.contracts.get(g.contract)?.kind !== "library") return "callee-side";
  return "caller-side";
}

export type Writer = { fn: string; variable: string; at: Loc; control: "constructor" | "one-time-initialiser" | "guarded" | "open"; guardedBy: string[]; flag?: string; basis: "inferred"; rule: string };
export type RoleFact = {
  variable: string; strength: "strong" | "medium" | "weak"; holder: "single-address" | "membership-table" | "role-table" | "contract-reference" | "other";
  heldBy: { kind: "deploying-contract"; contract: string; evidence: Loc[]; rule: string } | null;
  writers: Writer[]; transfer: "fixed-after-deployment" | "by-holder" | "by-other-role" | "open-writer" | "initialiser-only" | "mixed";
  evidence: Loc[];
};
export type Check = { fn: string; at: Loc; side: GuardSide; enforcement: "reverting" | "early-return"; reads: string[]; text: string; note?: string };
export type FactoryPath = { from: string; callee: string; at: Loc; calleeChecks: Array<{ at: Loc; reads: string[] }>; outerCallerGuarded: boolean; reaches: string[]; rule: string };
export type ProxyBoundary = { fallback: string; pointer: string; at: Loc; implementation: string | "unresolved"; upgradeWriters: Writer[]; note: string };
export type Initialiser = { fn: string; flag: string; at: Loc; lockedInConstructor: boolean; note: string };
export type Unresolved = { what: string; at: Loc | null };
export type AuthorityFacts = {
  component: string; roles: RoleFact[]; checks: Check[]; deploys: Array<{ fn: string; child: string; at: Loc }>;
  factoryPaths: FactoryPath[]; proxy: ProxyBoundary[]; initialisers: Initialiser[]; externalAssumptions: Array<{ fn: string; at: Loc; text: string; why: string }>;
  unguardedAuthorityWrites: Array<{ fn: string; variable: string; at: Loc }>; unresolved: Unresolved[];
};

const holderOf = (type: string): RoleFact["holder"] =>
  /^address/.test(type) ? "single-address" : /^mapping\s*\(\s*bytes32\s*=>\s*mapping\s*\(\s*address/.test(type) ? "role-table"
    : /^mapping\s*\(\s*address\s*=>\s*(bool|u?int)/.test(type) ? "membership-table" : /^[A-Z]\w*$/.test(type) ? "contract-reference" : "other";
const RANK = { weak: 0, medium: 1, strong: 2 } as const;

export function authorityFacts(
  ix: ProgramIndex, trace: (f: FunctionDef) => TraceResult, component: string,
  fns: ReadonlyArray<{ id: string; f: FunctionDef }>, roles: readonly VariableRoles[],
): AuthorityFacts {
  const authorityVars = new Map(roles.filter((v) => v.roles.some((r) => r.role === "authority")).map((v) => [v.variable, v]));
  const traced = fns.map(({ id, f }) => ({ id, f, t: trace(f) }));
  const loc = (e: { file: string; line: number }): Loc => ({ file: e.file, line: e.line });
  const callerGuards = (ev: Ev[]) => ev.filter((g): g is Extract<Ev, { k: "guard" }> => g.k === "guard" && g.auth && guardSide(ix, component, g) === "caller-side");

  // ---- checks on entry points (described, never certified)
  const checks: Check[] = [];
  const externalAssumptions: AuthorityFacts["externalAssumptions"] = [];
  for (const { id, f, t } of traced) {
    if (f.kind === "constructor") continue;
    for (const g of t.events) {
      if (g.k !== "guard" || !g.auth) continue;
      const side = guardSide(ix, component, g);
      checks.push({ fn: id, at: loc(g), side, enforcement: g.reverting ? "reverting" : "early-return", reads: [...g.reads].sort(), text: g.text.slice(0, 200),
        ...(side === "callee-side" ? { note: `runs inside ${g.contract}, where msg.sender is ${component}: satisfied by this contract, not a check on who calls ${id}` } : side === "assumed" ? { note: g.assumed! } : {}) });
      if (side === "assumed") externalAssumptions.push({ fn: id, at: loc(g), text: g.text, why: g.assumed! });
      else if (side === "caller-side" && g.reads.length === 0) externalAssumptions.push({ fn: id, at: loc(g), text: g.text.slice(0, 200), why: "the authorising condition reads no state variable of this contract (an external call or an unmodelled expression decides it)" });
    }
  }

  // ---- writers of each authority variable, and under which control
  const writers: Writer[] = [];
  for (const { id, f, t } of traced) {
    const ev = t.events;
    for (let i = 0; i < ev.length; i++) {
      const w = ev[i]!; if (w.k !== "write" || !authorityVars.has(w.variable) || w.contract !== component) continue;
      const cg = callerGuards(ev);
      let control: Writer["control"]; let rule: string; let flag: string | undefined;
      if (f.kind === "constructor") { control = "constructor"; rule = "written-in-constructor"; }
      // a write inside a branch an authorising condition protects (`if (msg.sender == owner) { ... }`, or a modifier `if (auth) _;`) is guarded too
      else if (cg.length || w.prot) { control = "guarded"; rule = cg.length ? "caller-side-authorising-check-on-path" : "inside-authorised-branch"; }
      else {
        // a one-time guard: a non-authority variable read by a reverting guard and written later on the same path
        // a ONE-TIME flag: a bool checked as unset (`!f`, `f == false`) or a number/address checked against zero, then written later on
        // the path. A guard that merely reads a variable later rewritten (a price, a balance) is not an initialisation control.
        const isUnsetCheck = (g: Extract<Ev, { k: "guard" }>, r: string) => {
          const t = ix.stateVar(component, r)?.type ?? ""; const x = g.text.replace(/\s+/g, "");
          return /^bool/.test(t) ? new RegExp(`(^|[^\\w])!${r}(\\b|$)|\\b${r}==false\\b|false==${r}\\b`).test(x)
            : /^(u?int|address)/.test(t) ? new RegExp(`\\b${r}==(0|address\\(0\\))(\\b|$)|(^|[^\\w])(0|address\\(0\\))==${r}\\b`).test(x) : false;
        };
        const once = ev.find((g, gi) => g.k === "guard" && g.reverting && !g.auth && g.reads.some((r) => !r.startsWith("<") && !authorityVars.has(r) && isUnsetCheck(g, r) && ev.some((x, xi) => xi > gi && x.k === "write" && x.variable === r)));
        if (once && once.k === "guard") { control = "one-time-initialiser"; rule = "unset-flag-check-then-set"; flag = once.reads.find((r) => !r.startsWith("<") && !authorityVars.has(r) && isUnsetCheck(once, r)); }
        else { control = "open"; rule = "no-caller-side-check-on-path"; }
      }
      writers.push({ fn: id, variable: w.variable, at: loc(w), control, guardedBy: [...new Set(cg.flatMap((g) => g.reads))].sort(), ...(flag ? { flag } : {}), basis: "inferred", rule });
    }
  }
  const uniqWriters = [...new Map(writers.map((w) => [`${w.fn}|${w.variable}|${w.at.file}:${w.at.line}`, w])).values()];

  // ---- deployments and the deploying-contract holder
  const deploys: AuthorityFacts["deploys"] = [];
  for (const { id, f } of traced) if (f.body) walkStmts(f.body, (e: Expr) => { if (e.k === "new" && ix.contracts.get(e.type)?.kind === "contract") deploys.push({ fn: id, child: e.type, at: { file: f.file, line: e.line } }); });
  const deployersOf = (child: string) => {
    const out: Array<{ contract: string; at: Loc }> = [];
    for (const c of ix.contracts.values()) if (c.kind === "contract") for (const fn of c.functions) if (fn.body) walkStmts(fn.body, (e) => { if (e.k === "new" && e.type === component) out.push({ contract: c.name, at: { file: fn.file, line: e.line } }); });
    void child; return out;
  };
  const myDeployers = deployersOf(component);
  const ctorCallerVars = new Map<string, Loc>();
  for (const { f } of traced) if (f.kind === "constructor" && f.body) walkStmts(f.body, (e) => { if (e.k === "assign" && e.op === "=" && e.l.k === "id" && e.r.k === "member" && e.r.obj.k === "id" && e.r.obj.name === "msg" && e.r.name === "sender") ctorCallerVars.set(e.l.name, { file: f.file, line: e.line }); });

  const roleFacts: RoleFact[] = [...authorityVars.values()].map((v) => {
    const auth = v.roles.filter((r) => r.role === "authority");
    const strength = auth.reduce((m, r) => (RANK[r.strength] > RANK[m] ? r.strength : m), "weak" as RoleFact["strength"]);
    const ws = uniqWriters.filter((w) => w.variable === v.variable);
    const after = ws.filter((w) => w.control !== "constructor");
    const transfer: RoleFact["transfer"] = after.length === 0 ? "fixed-after-deployment"
      : after.some((w) => w.control === "open") ? "open-writer"
      : after.every((w) => w.control === "one-time-initialiser") ? "initialiser-only"
      : after.every((w) => w.control === "guarded" && w.guardedBy.includes(v.variable)) ? "by-holder"
      : after.every((w) => w.control === "guarded") ? "by-other-role" : "mixed";
    const ctorAt = ctorCallerVars.get(v.variable);
    const immutableOrFixed = (ix.stateVar(component, v.variable)?.immutable ?? false) || transfer === "fixed-after-deployment";
    const heldBy = ctorAt && immutableOrFixed && myDeployers.length
      ? { kind: "deploying-contract" as const, contract: [...new Set(myDeployers.map((d) => d.contract))].sort().join("|"), evidence: [ctorAt, ...myDeployers.map((d) => d.at)], rule: "constructor-records-caller+deployed-by-new-in-snapshot" }
      : null;
    return { variable: v.variable, strength, holder: holderOf(v.type), heldBy, writers: ws, transfer, evidence: [v.declaration, ...auth.flatMap((r) => r.evidence)].filter((e, i, a) => a.findIndex((x) => x.file === e.file && x.line === e.line) === i) };
  }).sort((a, b) => a.variable.localeCompare(b.variable));

  // ---- cross-contract authority paths: this contract calls a snapshot contract whose checks are callee-side
  const factoryPaths: FactoryPath[] = [];
  for (const { id, f, t } of traced) {
    if (f.kind === "constructor") continue;
    const ev = t.events; const outerGuarded = callerGuards(ev).length > 0;
    for (let i = 0; i < ev.length; i++) {
      const c = ev[i]!; if (c.k !== "call" || c.low !== null || !c.calleeResolved || !c.callee) continue;
      const callee = c.callee.split(".")[0]!; if (callee === component || ix.contracts.get(callee)?.kind !== "contract") continue;
      // the callee's events follow the call event in the trace while the chain still contains the callee frame
      const inner: Ev[] = []; for (let j = i + 1; j < ev.length; j++) { const e = ev[j]!; if (e.contract === component && !e.chain.some((fr) => fr.contract === callee)) break; inner.push(e); }
      const calleeChecks = inner.filter((g): g is Extract<Ev, { k: "guard" }> => g.k === "guard" && g.auth && guardSide(ix, component, g) === "callee-side").map((g) => ({ at: loc(g), reads: [...g.reads].sort() }));
      const reaches = [...new Set(inner.flatMap((e) => e.k === "destruct" ? ["selfdestruct"] : e.k === "write" && e.contract === callee ? [`writes ${callee}.${e.variable}`] : e.k === "call" && e.hasValue ? ["sends ether"] : e.k === "call" && e.low === "delegatecall" ? ["delegatecall"] : []))].sort();
      if (calleeChecks.length) factoryPaths.push({ from: id, callee: c.callee, at: loc(c), calleeChecks, outerCallerGuarded: outerGuarded || c.prot, reaches, rule: "callee-side-check-satisfied-by-this-contract" });
    }
  }

  // ---- proxy boundaries
  const proxy: ProxyBoundary[] = [];
  const pointerRoles = new Set(roles.filter((v) => v.roles.some((r) => r.role === "implementation_pointer")).map((v) => v.variable));
  for (const { id, f, t } of traced) {
    if (f.kind !== "fallback" && f.kind !== "receive") continue;
    for (const e of t.events) if (e.k === "call" && e.low === "delegatecall") {
      const ptr = e.targetVar && pointerRoles.has(e.targetVar) ? e.targetVar : e.targetText;
      const tp = e.targetVar ? ix.stateVar(component, e.targetVar)?.type ?? "" : "";
      const impl = ix.contracts.get(tp)?.kind === "contract" ? tp : "unresolved";
      const pointerWriters: Writer[] = [];
      for (const { id: wid, f: wf, t: wt } of traced) for (const w of wt.events) if (w.k === "write" && w.variable === e.targetVar) {
        const cg = callerGuards(wt.events);
        pointerWriters.push({ fn: wid, variable: w.variable, at: loc(w), control: wf.kind === "constructor" ? "constructor" : cg.length || w.prot ? "guarded" : "open", guardedBy: [...new Set(cg.flatMap((g) => g.reads))].sort(), basis: "inferred", rule: "writes-implementation-pointer" });
      }
      proxy.push({ fallback: id, pointer: ptr, at: loc(e), implementation: impl, upgradeWriters: pointerWriters,
        note: impl === "unresolved" ? "implementation contract not resolvable from the pointer's type: the proxy's exposed surface and storage layout are not established" : `executes ${impl}'s code against this contract's storage` });
    }
  }

  // ---- initialisation controls
  const initialisers: Initialiser[] = [];
  const ctorWrites = new Set(traced.filter((x) => x.f.kind === "constructor").flatMap((x) => x.t.events.flatMap((e) => (e.k === "write" ? [e.variable] : []))));
  for (const w of uniqWriters) if (w.control === "one-time-initialiser" && w.flag && !initialisers.some((i) => i.fn === w.fn)) {
    const locked = ctorWrites.has(w.flag);
    initialisers.push({ fn: w.fn, flag: w.flag, at: w.at, lockedInConstructor: locked,
      note: locked ? "the constructor sets the one-time flag: a directly deployed instance cannot be initialised again" : "the constructor does not set the one-time flag: a directly deployed instance (e.g. a proxy's implementation) may be initialisable by anyone (inferred; impact depends on deployment)" });
  }

  const unguardedAuthorityWrites = uniqWriters.filter((w) => w.control === "open").map((w) => ({ fn: w.fn, variable: w.variable, at: w.at }));
  const unresolved: Unresolved[] = [
    ...checks.filter((c) => c.side === "assumed").map((c) => ({ what: `check in ${c.fn} comes from an unseen modifier (${c.text}); its condition is unknown`, at: c.at })),
    ...proxy.filter((p) => p.implementation === "unresolved").map((p) => ({ what: `implementation behind ${p.fallback} is not resolvable`, at: p.at })),
    ...roleFacts.filter((r) => r.strength === "weak").map((r) => ({ what: `${r.variable} is an authority by name only; no check on it was found`, at: r.evidence[0] ?? null })),
  ];
  const sortLoc = <T extends { at: Loc | null }>(xs: T[]) => xs.sort((a, b) => (a.at?.file ?? "").localeCompare(b.at?.file ?? "") || (a.at?.line ?? 0) - (b.at?.line ?? 0));
  return {
    component, roles: roleFacts, checks: sortLoc(checks).sort((a, b) => a.fn.localeCompare(b.fn) || a.at.line - b.at.line), deploys: deploys.sort((a, b) => a.fn.localeCompare(b.fn) || a.at.line - b.at.line),
    factoryPaths: factoryPaths.sort((a, b) => a.from.localeCompare(b.from) || a.at.line - b.at.line), proxy, initialisers: initialisers.sort((a, b) => a.fn.localeCompare(b.fn)),
    externalAssumptions: externalAssumptions.sort((a, b) => a.fn.localeCompare(b.fn) || a.at.line - b.at.line), unguardedAuthorityWrites: unguardedAuthorityWrites.sort((a, b) => a.fn.localeCompare(b.fn) || a.at.line - b.at.line),
    unresolved: sortLoc(unresolved),
  };
}
