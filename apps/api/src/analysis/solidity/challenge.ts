import type { ProgramIndex } from "./index.js";
import type { FunctionDef } from "./parser.js";
import { Interp, Revert, sampleArgs, Unsupported, type Value } from "./simulate.js";
import type { Finding } from "./specialists.js";

/**
 * Independent challenge of non-reentrancy leads by EXECUTION, using a different method from the specialists: instead of reasoning about
 * which guards dominate a statement, it runs the entry function as an UNPRIVILEGED caller against a modelled contract (privileged addresses are
 * a third party, constructors are run by that third party) and asks whether the sensitive statement is actually reached by a transaction that
 * does not revert. A guard that is wrong, misplaced, or checks the wrong thing is therefore found by behaviour, not by pattern. Each challenge
 * can VALIDATE (with a trace), REFUTE (with the reverting condition or the unreached path) or ABSTAIN (something is not modelled).
 * Classes with no method here remain explicitly inconclusive. Nothing here proves a vulnerability on a real deployment.
 *
 * A refutation is one of two kinds, and the difference decides how it is recorded (pipeline.ts: runChallenge):
 *  - `counterexample` (recorded as `contradicts`): an EXECUTED counterexample in the modelled world. A control run shows the model can
 *    execute the claimed path (the privileged deployer reaches the flagged statement; the legitimate initialisation completes; with the
 *    call succeeding the transaction completes), and the claim's own adversarial transaction on that path then reverts at an explicit
 *    check (`require`/`assert`, with its condition) that negates the claim's mechanism: for reachability, a check on the caller's identity;
 *    for re-initialisation, any explicit check on the second call; for an unchecked call, a check reached after the modelled failure.
 *    The executed transactions and the reverting condition are returned as the trace.
 *  - `not-observed` (recorded as `weakens`): the claimed effect was not observed, but nothing executed negates the mechanism: the call
 *    completes without reaching the statement, nothing observable changes, or it reverts somewhere that is not such a check (arithmetic,
 *    a balance bound, a revert statement whose condition the model cannot attribute).
 * Anything the model cannot execute as claimed (including a control run that fails) is `inconclusive`. A counterexample holds only in the
 * modelled world (privileged addresses are a third party, bounded arguments); it never proves the code safe on a deployment.
 */
export type Refutation = "counterexample" | "not-observed";
export type ChallengeOutcome = { verdict: "validated" | "refuted" | "inconclusive"; method: string; reason: string; trace: string[]; scenarios: number; /** set exactly when verdict is "refuted" */ refutation?: Refutation };
const ETHER = 10n ** 18n;

/** an explicit check on the path, with its condition: not arithmetic, division, a failed transfer, or a revert the model cannot attribute */
export const explicitCheck = (why: string): boolean => /^(require|assert) failed: /.test(why);
/** an explicit check whose condition is about the caller's identity and is not an ordering bound (e.g. a balance): what an access check is */
export function callerIdentityCheck(why: string): boolean {
  const m = /^(?:require|assert) failed: ([\s\S]*)$/.exec(why); if (!m) return false;
  return /\bmsg\.sender\b|\btx\.origin\b|\b_msgSender\s*\(\s*\)/.test(m[1]!) && !/[<>]/.test(m[1]!);
}
const showArgs = (args: Value[]): string => args.map((a) => (typeof a === "bigint" ? (a >= ETHER && a % ETHER === 0n ? `${a / ETHER} ether` : String(a)) : JSON.stringify(a))).join(", ");
const MODEL_NOTE = "this counterexample holds in the modelled world (privileged addresses are a third party; constructors run by it; bounded arguments); it is not a proof for a real deployment";

function freshInterp(ix: ProgramIndex, contract: string, entry: FunctionDef): Interp {
  const it = new Interp(ix, contract, { reenter: [], maxDepth: 0, callbacks: false });
  it.entryFn = entry; it.thirdPartyAddressDefault = true;
  // honest deployment: constructors (base first) run by the third-party deployer
  for (const c of [...ix.linearize(contract)].reverse()) {
    const ctor = c.functions.find((f) => f.kind === "constructor");
    if (ctor?.body) { try { it.runFunction(ctor, contract, sampleArgs(ctor, [ETHER]) ?? [], "owner0", 0n); } catch (e: unknown) { if (!(e instanceof Revert) && !(e instanceof Unsupported)) throw e; } }
  }
  for (const c of ix.linearize(contract)) for (const v of c.stateVars) if (/^mapping\s*\(\s*address\s*=>\s*u?int/.test(v.type)) { it.writeVar(v.name, ["attacker"], 1n * ETHER); it.writeVar(v.name, ["owner0"], 10n * ETHER); }
  it.w.balance = 100n * ETHER; it.w.trace = [];
  return it;
}

type Attempt = { ok: boolean; why: string; args: Value[]; /** the world's trace and the statements reached at the end (or at the revert, before it is undone) */ trace: string[]; reachedAtEnd: Set<string> };
function attempt(it: Interp, fn: FunctionDef, sender: string, value = 0n, argOverride?: Value[]): Attempt {
  const args = argOverride ?? sampleArgs(fn, [ETHER]); if (!args) throw new Unsupported(`parameters of ${fn.name} cannot be modelled`);
  const snap = it.w.clone(); const reached = new Set(it.reached);
  try { it.runFunction(fn, fn.contract, args, sender, value); return { ok: true, why: "", args, trace: [...it.w.trace], reachedAtEnd: new Set(it.reached) }; }
  catch (e) {
    if (e instanceof Revert) { const at = { ok: false, why: e.why, args, trace: [...it.w.trace], reachedAtEnd: new Set(it.reached) }; it.w.restore(snap); it.reached = reached; return at; }
    throw e;
  }
}

/** the attacker chooses the arguments: try addresses set to themselves and to the third-party owner */
function argVariants(fn: FunctionDef): Value[][] {
  const base = sampleArgs(fn, [ETHER]); if (!base) throw new Unsupported(`parameters of ${fn.name} cannot be modelled`);
  const swap = (to: string) => base.map((v, i) => (/^address/.test(fn.params[i]?.type ?? "") ? to : v));
  return [swap("attacker"), swap("owner0")];
}
function attemptAny(it: Interp, fn: FunctionDef, sender: string, value: bigint, key: string): { ok: boolean; why: string; reachedKey: boolean; all: Attempt[] } {
  let last = { ok: false, why: "", reachedKey: false }; const all: Attempt[] = [];
  for (const args of argVariants(fn)) { const r = attempt(it, fn, sender, value, args); all.push(r); last = { ok: r.ok, why: r.why, reachedKey: it.reached.has(key) }; if (r.ok && last.reachedKey) return { ...last, all }; }
  return { ...last, all };
}
const keyOf = (f: Finding) => `${f.file}:${f.line}`;

/** access-control, selfdestruct and delegatecall: can an unprivileged caller reach the sensitive statement in a transaction that completes? */
export function challengeReachability(ix: ProgramIndex, f: Finding, entry: FunctionDef): ChallengeOutcome {
  const method = "unprivileged-caller execution (reachability of the sensitive statement)";
  try {
    const owner = freshInterp(ix, entry.contract, entry); const sanity = attemptAny(owner, entry, "owner0", entry.mutability === "payable" ? ETHER : 0n, keyOf(f));
    if (!sanity.ok || !sanity.reachedKey) return { verdict: "inconclusive", method, reason: `the sensitive statement is not reachable even by the privileged deployer in the model (${sanity.ok ? "statement not executed" : sanity.why}), so the model cannot judge it`, trace: [], scenarios: 1 };
    const it = freshInterp(ix, entry.contract, entry);
    if (f.class === "delegatecall" && /storage variable/.test(String(f.detail["provenance"] ?? ""))) {
      // two-step: can the attacker first point the stored target at their own code through some other entry point?
      for (const g of ix.entryPoints(entry.contract).filter((x) => x !== entry)) { const probe = attempt(it, g, "attacker", g.mutability === "payable" ? ETHER : 0n, sampleArgs(g, [ETHER])?.map((v) => (typeof v === "string" ? "attacker" : v)) ?? undefined); if (probe.ok) it.w.trace.push(`attacker first calls ${g.name} (completes)`); }
    }
    const r = attemptAny(it, entry, "attacker", entry.mutability === "payable" ? ETHER : 0n, keyOf(f));
    const reached = r.reachedKey;
    if (r.ok && reached) {
      const what = f.class === "selfdestruct" ? `selfdestruct executed (destroyed=${it.destructed})` : f.class === "delegatecall" ? `delegatecall executed to ${it.delegated.join(", ") || "?"}` : "the flagged statement executed";
      return { verdict: "validated", method, reason: `an unprivileged caller runs ${entry.name} to completion and reaches ${keyOf(f)}: ${what}`, trace: [`note: this shows REACHABILITY by an unprivileged caller; whether the statement is a privileged action is the specialist's classification, not something execution can prove`, `deployment: privileged address is a third party; constructor run by it`, ...it.w.trace, `attacker calls ${entry.name}(...) -> completes without reverting`], scenarios: 2 };
    }
    // counterexample: the deployer's control run reached the statement, and EVERY unprivileged attempt reverts at a check on the caller
    if (!r.ok && r.all.length > 0 && r.all.every((x) => !x.ok && callerIdentityCheck(x.why))) {
      return { verdict: "refuted", refutation: "counterexample", method, scenarios: 1 + r.all.length,
        reason: `executed counterexample: the privileged deployer's transaction reaches ${keyOf(f)}, and every unprivileged attempt on the same path reverts at a check on the caller (${r.why})`,
        trace: ["deployment: privileged address is a third party; constructor run by it", `control: the privileged deployer calls ${entry.name}(...) -> completes and reaches ${keyOf(f)}`,
          ...r.all.map((x) => `attacker calls ${entry.name}(${showArgs(x.args)}) -> REVERTS: ${x.why}`), `note: ${MODEL_NOTE}`] };
    }
    if (!r.ok) return { verdict: "refuted", refutation: "not-observed", method, reason: `an unprivileged caller's transaction reverts before the sensitive statement takes effect: ${r.why}`, trace: [], scenarios: 2 };
    return { verdict: "refuted", refutation: "not-observed", method, reason: "an unprivileged caller completes the call but the sensitive statement is not executed on that path", trace: [], scenarios: 2 };
  } catch (e) { if (e instanceof Unsupported) return { verdict: "inconclusive", method, reason: `not modelled: ${e.why}`, trace: [], scenarios: 0 }; throw e; }
}

/** initializer: after a legitimate initialisation by the deployer, can an attacker initialise again and take control? */
export function challengeInitializer(ix: ProgramIndex, f: Finding, entry: FunctionDef): ChallengeOutcome {
  const method = "re-initialisation by an unprivileged caller after a legitimate initialisation";
  try {
    const it = freshInterp(ix, entry.contract, entry);
    const legit = attempt(it, entry, "owner0", 0n, sampleArgs(entry, [ETHER])?.map((v) => (typeof v === "string" ? "owner0" : v)));
    if (!legit.ok) return { verdict: "inconclusive", method, reason: `the legitimate initialisation itself reverts in the model (${legit.why})`, trace: [], scenarios: 1 };
    it.reached = new Set(); it.w.trace.push("deployer initialises legitimately (completes)");
    const again = attempt(it, entry, "attacker", 0n, sampleArgs(entry, [ETHER])?.map((v) => (typeof v === "string" ? "attacker" : v)));
    if (again.ok && it.reached.has(keyOf(f))) return { verdict: "validated", method, reason: `after the deployer has initialised, an unprivileged caller calls ${entry.name} again and reaches ${keyOf(f)} without reverting: control can be taken over`, trace: [...it.w.trace, `attacker calls ${entry.name}(attacker) -> completes`], scenarios: 2 };
    // counterexample: the legitimate initialisation completed (control), and the attacker's second call reverts at an explicit check
    if (!again.ok && explicitCheck(again.why)) {
      return { verdict: "refuted", refutation: "counterexample", method, scenarios: 2, reason: `executed counterexample: after the deployer has initialised, an unprivileged caller's second ${entry.name} reverts at an explicit check (${again.why})`,
        trace: ["deployment: privileged address is a third party; constructor run by it", `control: deployer calls ${entry.name}(${showArgs(legit.args)}) -> completes`, `attacker calls ${entry.name}(${showArgs(again.args)}) -> REVERTS: ${again.why}`, `note: ${MODEL_NOTE}`] };
    }
    return { verdict: "refuted", refutation: "not-observed", method, reason: again.ok ? "the second call completes but the privileged statement is not reached" : `the second initialisation reverts: ${again.why}`, trace: [], scenarios: 2 };
  } catch (e) { if (e instanceof Unsupported) return { verdict: "inconclusive", method, reason: `not modelled: ${e.why}`, trace: [], scenarios: 0 }; throw e; }
}

/** unchecked-call: with the low-level call modelled as failing, does the function still complete and leave state or retained ether behind? */
export function challengeUncheckedCall(ix: ProgramIndex, f: Finding, entry: FunctionDef): ChallengeOutcome {
  const method = "failing low-level call: does the function still complete and advance state or retain ether?";
  try {
    const value = entry.mutability === "payable" ? ETHER : 0n;
    // control: the same transaction with the call SUCCEEDING. Only if it completes can a revert under failure be attributed to the failure.
    const control = attempt(freshInterp(ix, entry.contract, entry), entry, "attacker", value);
    const it = freshInterp(ix, entry.contract, entry); it.failCalls = true;
    const before = new Map(it.w.storage); const bal0 = it.w.balance;
    const r = attempt(it, entry, "attacker", value);
    if (value > 0n && r.ok) it.w.balance += value;
    if (!r.ok && !control.ok) return { verdict: "inconclusive", method, reason: `the transaction reverts for this caller even when the call succeeds (${control.why}), so the model cannot run the claimed path; a revert here says nothing about whether a failing call is accepted`, trace: [], scenarios: 2 };
    if (!r.ok && explicitCheck(r.why) && r.reachedAtEnd.has(keyOf(f))) {
      return { verdict: "refuted", refutation: "counterexample", method, scenarios: 2, reason: `executed counterexample: with the call succeeding the transaction completes, and with the flagged call failing it reverts at an explicit check (${r.why}); the failure is not silently accepted`,
        trace: [`control: ${entry.name}(${showArgs(control.args)}) with the call succeeding -> completes`, ...r.trace, `with the call failing -> REVERTS: ${r.why}`, `note: ${MODEL_NOTE}`] };
    }
    if (!r.ok) return { verdict: "refuted", refutation: "not-observed", method, reason: `when the call fails the transaction reverts (${r.why}); the failure is not silently accepted`, trace: [], scenarios: 2 };
    if (!it.reached.has(keyOf(f))) return { verdict: "inconclusive", method, reason: "the flagged call was not executed on the modelled path", trace: [], scenarios: 1 };
    const changed: string[] = []; for (const [k, v] of it.w.storage) if (before.get(k) !== v) changed.push(k.split("|")[0]!);
    const retained = it.w.balance - bal0;
    if (changed.length || retained > 0n) return { verdict: "validated", method, reason: `with the call failing the function still completes${changed.length ? ` and updates ${[...new Set(changed)].join(", ")}` : ""}${retained > 0n ? ` and retains ${retained / ETHER} ether that was not delivered` : ""}`, trace: it.w.trace, scenarios: 1 };
    return { verdict: "refuted", refutation: "not-observed", method, reason: "with the call failing the function completes but nothing observable changes in the model", trace: it.w.trace, scenarios: 1 };
  } catch (e) { if (e instanceof Unsupported) return { verdict: "inconclusive", method, reason: `not modelled: ${e.why}`, trace: [], scenarios: 0 }; throw e; }
}

export function challengeFinding(ix: ProgramIndex, f: Finding): ChallengeOutcome | null {
  const entry = ix.findFunctions(f.contract, f.function)[0]; if (!entry) return { verdict: "inconclusive", method: "none", reason: "function not found", trace: [], scenarios: 0 };
  switch (f.class) {
    case "access-control": case "selfdestruct": case "delegatecall": return challengeReachability(ix, f, entry);
    case "initializer": return challengeInitializer(ix, f, entry);
    case "unchecked-call": return challengeUncheckedCall(ix, f, entry);
    default: return null; // reentrancy has its own validator; tx-origin has no independent method yet
  }
}
