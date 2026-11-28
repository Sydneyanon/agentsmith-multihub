/**
 * PROTOTYPE (docs/architecture/apex-first-capability.md §8). NOT wired into any pipeline, step, worker or engine loop; NOT scored on
 * any frozen corpus; excluded from production builds (`tsconfig.build.json` excludes every `testing/` directory). Its only purpose is to
 * answer one question: can the existing bounded interpreter (`simulate.ts: Interp`, `World`) execute bounded multi-call sequences by
 * distinct actors, and can candidate invariants inferred from the protocol model's state roles be (a) supported by honest sequences
 * and (b) violated by a concrete, replayable sequence?
 *
 * Method (v1 design, minimal form):
 *  1. deploy: constructors run base-first by the deployer `owner0`; no artificial seeding (inconsistent seeding was the V1 lesson);
 *  2. candidates from shared facts only: ledgers and aggregates (`stateVariableRoles`, P2), plus scalar phase-like variables;
 *  3. honest phase: breadth-first sequences (length <= depth) where every actor passes ITS OWN address for address parameters; every
 *     transition is recorded per candidate as maintaining, violating or not touching it. A candidate with no maintaining honest
 *     transition is never "established" and is dropped (sensitivity check: an invariant nothing honest exercises says nothing);
 *  4. adversarial phase: the same search, but address parameters may name other actors;
 *  5. every violation of an established candidate becomes a hypothesis DRAFT with the shortest counterexample sequence found.
 * Nothing here writes to the research store and nothing here is an evaluation: APEX may not validate its own output.
 */
import { ProgramIndex } from "../../analysis/solidity/index.js";
import type { FunctionDef } from "../../analysis/solidity/parser.js";
import { Interp, Revert, Unsupported, World, type Value } from "../../analysis/solidity/simulate.js";
import { namesWithRole, stateVariableRoles } from "../../analysis/solidity/state-roles.js";
import { analyzeSources } from "../../analysis/solidity/specialists.js";
import { Tracer } from "../../analysis/solidity/trace.js";

export const PROTOTYPE_GENERATOR = "apex-state-explorer@0-prototype";
const ETHER = 10n ** 18n;
/** `attacker` is the interpreter's only actor whose ether receipts are counted (World.received); in the honest phase it behaves honestly */
export const ACTORS = ["owner0", "alice", "attacker"] as const;
type Actor = (typeof ACTORS)[number];
const DEPLOYER: Actor = "owner0";

export type Move = { actor: Actor; fn: FunctionDef; args: Value[]; value: bigint };
export type StepRecord = { actor: Actor; call: string; value: string };
export type InvariantKind = "conservation" | "solvency" | "actor-value" | "one-way";
export type Candidate = { id: string; kind: InvariantKind; statement: string; vars: string[] };
export type CandidateResult = Candidate & {
  established: boolean; maintaining: number; honestViolations: number; example: StepRecord[] | null; dropReason?: string;
};
export type Violation = { candidate: string; kind: InvariantKind; phase: "honest" | "adversarial"; breakingFunction: string; sequence: StepRecord[]; detail: string };
export type HypothesisDraft = {
  generator: string; capabilityFamily: "agentsmith-interpreter"; family: string; claim: string;
  spans: Array<{ file: string; line: number; role: "primary" | "supporting" }>;
  rationale: { invariant: string; counterexample: StepRecord[]; supportedBy: { maintainingTransitions: number; example: StepRecord[] | null } };
  independentOfScanners: boolean; priorLeadsOnFunction: string[];
};
export type Coverage = {
  functions: Array<{ name: string; attempted: number; completed: number; reverted: number; unsupported: string | null; excluded: string | null }>;
  sequences: number; distinctStates: number; depth: number; budgetExhausted: boolean;
};
export type ExploreReport = {
  contract: string; abstained: string | null; candidates: CandidateResult[]; violations: Violation[]; hypotheses: HypothesisDraft[];
  coverage: { honest: Coverage; adversarial: Coverage };
};

type Node = { w: World; sentByAttacker: bigint; seq: StepRecord[] };

const fmt = (v: Value): string => (typeof v === "bigint" ? (v !== 0n && v % ETHER === 0n ? `${v / ETHER}e18` : String(v)) : Array.isArray(v) ? `[${v.map(fmt).join(",")}]` : String(v));

function argsFor(fn: FunctionDef, actor: Actor, adversarial: boolean): Value[][] | null {
  // one value per non-address parameter; address parameters are the actor itself (honest) or, adversarially, any actor
  const choices: Value[][] = [];
  for (const p of fn.params) {
    if (/^u?int/.test(p.type)) choices.push([ETHER]);
    else if (/^address/.test(p.type)) choices.push(adversarial ? [...ACTORS] : [actor]);
    else if (/^bool/.test(p.type)) choices.push([true]);
    else return null;
  }
  let out: Value[][] = [[]];
  for (const c of choices) out = out.flatMap((prefix) => c.map((v) => [...prefix, v]));
  return out;
}

function stateKey(n: Node): string {
  return [...n.w.storage.entries()].map(([k, v]) => `${k}=${fmt(v)}`).sort().join(";") + `#${n.w.balance}#${n.w.received}#${n.sentByAttacker}`;
}

function sumLedger(w: World, ledger: string): bigint {
  let s = 0n; for (const [k, v] of w.storage) if (k.startsWith(`${ledger}|`) && typeof v === "bigint") s += v; return s;
}

export function exploreStateInvariants(sources: ReadonlyArray<{ path: string; text: string }>, contract: string, options: { depth?: number; maxSequences?: number } = {}): ExploreReport {
  const depth = options.depth ?? 3; const maxSequences = options.maxSequences ?? 50_000;
  const ix = new ProgramIndex(sources);
  const fns = ix.deployedEntryPoints(contract);
  const emptyCov = (): Coverage => ({ functions: [], sequences: 0, distinctStates: 0, depth, budgetExhausted: false });
  const report: ExploreReport = { contract, abstained: null, candidates: [], violations: [], hypotheses: [], coverage: { honest: emptyCov(), adversarial: emptyCov() } };
  if (!fns.length) { report.abstained = "no state-changing entry points"; return report; }

  // ---- shared facts: state roles (P2), the same derivation the validator and the protocol model use
  const traces = new Map<FunctionDef, ReturnType<Tracer["run"]>>();
  const roles = stateVariableRoles(ix, (f) => { let t = traces.get(f); if (!t) { t = new Tracer(ix).run(f); traces.set(f, t); } return t; }, contract);
  const ledgers = namesWithRole(roles, "ledger"); const aggregates = namesWithRole(roles, "aggregate");
  const handlesEther = fns.some((f) => f.mutability === "payable");
  // phase-like scalars only: a bool/uint (not an aggregate) that some entry point READS IN A GUARD, so the protocol branches on it
  const guardReads = new Set(fns.flatMap((f) => new Tracer(ix).run(f).events.flatMap((e) => (e.k === "guard" ? e.reads : []))));
  const scalar = ix.linearize(contract).flatMap((c) => c.stateVars).filter((v) => !v.constant && !v.immutable && /^(bool|u?int\d*)$/.test(v.type.trim()) && !aggregates.includes(v.name) && guardReads.has(v.name));

  // ---- candidate invariants (each a predicate over (pre, post) states of one transition)
  // touched: the transition moved something the candidate is about (only such transitions are checked);
  // supports: the transition moved BOTH sides of the relation and it still held (only these count as honest support: sensitivity)
  type Check = { c: Candidate; holds: (n: Node) => boolean; touched: (pre: Node, post: Node) => boolean; supports: (pre: Node, post: Node) => boolean; transitionOk?: (pre: Node, post: Node, m: Move) => boolean };
  // an unwritten slot reads as its declared value or type default (as the interpreter reads it), so `closed = false` on a fresh slot is no change
  const val = (n: Node, name: string): Value => (n.w.storage.has(name) ? (n.w.storage.get(name) ?? null) : (deployedValues.get(name) ?? null));
  const checks: Check[] = [];
  for (const a of aggregates) for (const l of ledgers) checks.push({
    c: { id: `conservation:${a}=sum(${l})`, kind: "conservation", statement: `${a} == sum over accounts of ${l}[account]`, vars: [a, l] },
    holds: (n) => (typeof val(n, a) === "bigint" ? (val(n, a) as bigint) : 0n) === sumLedger(n.w, l),
    touched: (p, q) => val(p, a) !== val(q, a) || sumLedger(p.w, l) !== sumLedger(q.w, l),
    supports: (p, q) => val(p, a) !== val(q, a) && sumLedger(p.w, l) !== sumLedger(q.w, l),
  });
  if (handlesEther) for (const l of ledgers) checks.push({
    c: { id: `solvency:balance>=sum(${l})`, kind: "solvency", statement: `address(this).balance >= sum over accounts of ${l}[account]`, vars: [l] },
    holds: (n) => n.w.balance >= sumLedger(n.w, l),
    touched: (p, q) => sumLedger(p.w, l) !== sumLedger(q.w, l) || p.w.balance !== q.w.balance,
    supports: (p, q) => sumLedger(p.w, l) !== sumLedger(q.w, l) && p.w.balance !== q.w.balance,
  });
  if (handlesEther) checks.push({
    c: { id: "actor-value:attacker-net<=0", kind: "actor-value", statement: "the observed actor never receives more ether from the contract than it sent to it", vars: [] },
    holds: (n) => n.w.received <= n.sentByAttacker,
    touched: (p, q) => p.w.received !== q.w.received || p.sentByAttacker !== q.sentByAttacker,
    supports: (p, q) => p.w.received !== q.w.received,
  });
  for (const v of scalar) checks.push({
    // one-way: once moved away from its deployed value, only the deployer may move it back toward that value
    c: { id: `one-way:${v.name}`, kind: "one-way", statement: `${v.name} never returns toward its deployed value except by the deployer`, vars: [v.name] },
    holds: () => true,
    touched: (p, q) => val(p, v.name) !== val(q, v.name),
    supports: (p, q) => val(p, v.name) !== val(q, v.name),
    transitionOk: (p, q, m) => {
      if (m.actor === DEPLOYER) return true;
      const before = val(p, v.name); const after = val(q, v.name); const init = deployedValues.get(v.name) ?? null;
      if (before === after || before === init) return true;
      if (typeof before === "bigint" && typeof after === "bigint" && typeof init === "bigint") return !(after < before && init < before) && !(after > before && init > before);
      return after !== init;
    },
  });

  // ---- deployment
  const it = new Interp(ix, contract, { reenter: [], maxDepth: 0, callbacks: false }); it.entryFn = fns[0]!;
  try {
    for (const c of [...ix.linearize(contract)].reverse()) {
      const ctor = c.functions.find((f) => f.kind === "constructor"); if (!ctor?.body) continue;
      const args = argsFor(ctor, DEPLOYER, false); if (!args) throw new Unsupported(`constructor parameters of ${c.name}`);
      it.runFunction(ctor, contract, args[0]!, DEPLOYER, 0n);
    }
  } catch (e) { if (e instanceof Revert || e instanceof Unsupported) { report.abstained = `deployment not modelled: ${e.why}`; return report; } throw e; }
  it.w.trace = [];
  const root: Node = { w: it.w.clone(), sentByAttacker: 0n, seq: [] };
  const deployedValues = new Map<string, Value>([...scalar.map((v) => v.name), ...aggregates].map((name) => [name, (() => { try { it.w.restore(root.w); return it.readVar(name, []); } catch { return null; } })()]));

  // ---- bounded breadth-first exploration (shortest counterexample first), with state merging
  const results = new Map<string, CandidateResult>(checks.map((k) => [k.c.id, { ...k.c, established: false, maintaining: 0, honestViolations: 0, example: null }]));
  const violated = new Set<string>();
  const run = (phase: "honest" | "adversarial"): Coverage => {
    const cov = emptyCov(); const perFn = new Map<string, Coverage["functions"][number]>();
    const moves: Move[] = [];
    for (const fn of fns) {
      const row = { name: fn.name || fn.kind, attempted: 0, completed: 0, reverted: 0, unsupported: null as string | null, excluded: null as string | null }; perFn.set(row.name, row);
      for (const actor of ACTORS) {
        const variants = argsFor(fn, actor, phase === "adversarial"); if (!variants) { row.excluded = "parameter types not modelled"; continue; }
        for (const args of variants) moves.push({ actor, fn, args, value: fn.mutability === "payable" ? ETHER : 0n });
      }
    }
    const seen = new Set<string>([stateKey(root)]); let frontier: Node[] = [root];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: Node[] = [];
      for (const pre of frontier) for (const m of moves) {
        if (cov.sequences >= maxSequences) { cov.budgetExhausted = true; break; }
        cov.sequences++; const row = perFn.get(m.fn.name || m.fn.kind)!; row.attempted++;
        it.w.restore(pre.w); it.w.balance += m.value; // the EVM credits msg.value before the call executes
        const step: StepRecord = { actor: m.actor, call: `${m.fn.name || m.fn.kind}(${m.args.map(fmt).join(", ")})`, value: fmt(m.value) };
        try { it.runFunction(m.fn, contract, m.args, m.actor, m.value); }
        catch (e) {
          if (e instanceof Revert) { row.reverted++; continue; }
          if (e instanceof Unsupported) { row.unsupported = e.why; continue; }
          throw e;
        }
        row.completed++;
        const post: Node = { w: it.w.clone(), sentByAttacker: pre.sentByAttacker + (m.actor === "attacker" ? m.value : 0n), seq: [...pre.seq, step] };
        for (const k of checks) {
          const r = results.get(k.c.id)!;
          if (!k.touched(pre, post)) continue;
          const ok = k.holds(post) && (k.transitionOk ? k.transitionOk(pre, post, m) : true);
          if (!k.holds(pre)) continue; // only transitions from a state where the candidate held say anything about it
          if (ok) { if (phase === "honest" && k.supports(pre, post)) { r.maintaining++; if (!r.example) r.example = post.seq; } continue; }
          if (phase === "honest") r.honestViolations++;
          if (violated.has(k.c.id)) continue;
          if (phase === "adversarial" && !r.established) continue;
          violated.add(k.c.id);
          report.violations.push({ candidate: k.c.id, kind: k.c.kind, phase, breakingFunction: m.fn.name || m.fn.kind, sequence: post.seq,
            detail: k.c.kind === "actor-value" ? `observed actor received ${fmt(post.w.received)} having sent ${fmt(post.sentByAttacker)}` : `${k.c.statement} fails after the last step` });
        }
        const key = stateKey(post); if (seen.has(key)) continue; seen.add(key); next.push(post);
      }
      frontier = next;
    }
    cov.distinctStates = seen.size; cov.functions = [...perFn.values()];
    return cov;
  };
  report.coverage.honest = run("honest");
  // sensitivity check: a candidate is established only if honest use exercised it and preserved it at least once
  for (const r of results.values()) {
    r.established = r.maintaining > 0;
    if (!r.established) r.dropReason = r.honestViolations > 0 ? "never preserved by any honest transition: not an invariant of this protocol" : "never exercised by honest sequences: vacuous";
  }
  // an honest-phase violation counts only for an established candidate (otherwise the candidate is simply not an invariant)
  report.violations = report.violations.filter((v) => results.get(v.candidate)!.established);
  for (const v of [...violated]) if (!report.violations.some((x) => x.candidate === v)) violated.delete(v);
  report.coverage.adversarial = run("adversarial");
  report.candidates = [...results.values()];

  // ---- hypothesis drafts, with the "independent of scanners" marker computed against the specialists' leads (Slither is not run here)
  const prior = analyzeSources(sources).findings;
  for (const v of report.violations) {
    const fn = fns.find((f) => (f.name || f.kind) === v.breakingFunction)!;
    const onFn = prior.filter((f) => f.contract === contract && f.function === v.breakingFunction).map((f) => `solidity-structural-specialists@1:${f.class}`);
    const steps = [...new Set(v.sequence.map((s) => s.call.split("(")[0]!))].filter((n) => n !== v.breakingFunction);
    const r = results.get(v.candidate)!;
    report.hypotheses.push({
      generator: PROTOTYPE_GENERATOR, capabilityFamily: "agentsmith-interpreter", family: `apex-invariant-${v.kind}`,
      claim: `${contract}.${v.breakingFunction}: the sequence ${v.sequence.map((s) => `${s.actor}:${s.call}`).join(" -> ")} violates the inferred invariant "${r.statement}"`,
      spans: [{ file: fn.file, line: fn.startLine, role: "primary" }, ...steps.flatMap((n) => { const g = fns.find((f) => f.name === n); return g ? [{ file: g.file, line: g.startLine, role: "supporting" as const }] : []; })],
      rationale: { invariant: r.statement, counterexample: v.sequence, supportedBy: { maintainingTransitions: r.maintaining, example: r.example } },
      independentOfScanners: onFn.length === 0, priorLeadsOnFunction: onFn,
    });
  }
  return report;
}
