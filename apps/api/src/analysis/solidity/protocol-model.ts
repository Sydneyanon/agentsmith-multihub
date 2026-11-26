import { createHash } from "node:crypto";
import { ProgramIndex } from "./index.js";
import type { ContractDef, FunctionDef } from "./parser.js";
import { Analyzer } from "./specialists.js";

/**
 * Protocol model v1, step P1 (docs/protocol-model-p1-p3-plan.md; conforms to T-149, docs/unified-research-workflow.md).
 *
 * A deterministic, versioned artifact derived from a sealed snapshot's Solidity sources. It EXPORTS what the structural index and the
 * deployed-context traces already know (components, functions, call edges, inheritance, unknowns); it does not re-derive anything.
 * Every fact carries code evidence (file, lines, the file's content hash = its research-blob hash) and a derivation kind.
 * P1 deliberately contains NO roles, assets, value flows, trust boundaries or transitions (P2+ are not approved).
 */
export const PROTOCOL_MODEL_SCHEMA = "protocol-model/1";
export const PROTOCOL_MODEL_BUILDER = "solidity-p1/1";

export type Evidence = { file: string; lineStart: number; lineEnd: number; fileSha256: string };
export type Derivation = "syntactic" | `inferred:${string}`;
export type ComponentFact = {
  id: string; kind: "contract" | "abstract" | "library"; deployable: boolean; file: string; contentSha256: string;
  linearization: string[]; stateVariables: Array<{ name: string; type: string; constant: boolean; immutable: boolean; line: number }>;
  evidence: Evidence; derivation: Derivation;
};
export type FunctionFact = {
  id: string; component: string; declaredIn: string; name: string; kind: string; visibility: string; mutability: string; modifiers: string[];
  entryPoint: boolean; callerGuarded: boolean; stateWrites: string[]; evidence: Evidence; derivation: Derivation;
};
export type CallEdge = {
  from: string; kind: "internal" | "modifier" | "external" | "low-level-call" | "delegatecall" | "staticcall" | "send" | "transfer" | "unresolved";
  /** internal/modifier: `Contract.function`; external and low-level: the target EXPRESSION as written (never a guessed contract);
   *  unresolved: the name that could not be resolved */
  to: string; targetProvenance: string | null;
  /** external calls only: the contract/function the typed call resolves to inside the snapshot, or null when it cannot be resolved */
  resolvedCallee: string | null;
  evidence: Evidence; derivation: Derivation;
};
export type InheritanceFact = { component: string; linearization: string[]; resolved: Array<{ function: string; resolvedTo: string; alsoDeclaredIn: string[] }>; evidence: Evidence; derivation: Derivation };
export type Unknown = { file: string; line: number | null; what: string };
export type ProtocolModel = {
  schema: typeof PROTOCOL_MODEL_SCHEMA; builder: typeof PROTOCOL_MODEL_BUILDER;
  inputs: Array<{ file: string; sha256: string }>;
  components: ComponentFact[]; functions: FunctionFact[]; callEdges: CallEdge[]; inheritance: InheritanceFact[]; unknowns: Unknown[];
};

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const byKey = <T>(k: (x: T) => string) => (a: T, b: T) => { const x = k(a), y = k(b); return x < y ? -1 : x > y ? 1 : 0; };
const sig = (f: FunctionDef) => (f.kind === "function" ? `${f.name}(${f.params.map((p) => p.type).join(",")})` : f.kind === "constructor" ? `constructor@${f.contract}` : f.kind);

export function buildProtocolModel(sources: ReadonlyArray<{ path: string; text: string }>): { model: ProtocolModel; json: string; sha256: string } {
  const ix = new ProgramIndex(sources); const an = new Analyzer(ix);
  const fileSha = new Map(sources.map((s) => [s.path, sha(s.text)]));
  const lines = new Map(sources.map((s) => [s.path, s.text.split("\n")]));
  const ev = (file: string, lineStart: number, lineEnd = lineStart): Evidence => ({ file, lineStart, lineEnd, fileSha256: fileSha.get(file) ?? "" });
  const inherited = ix.inheritedByDeployable();
  const components: ComponentFact[] = []; const functions: FunctionFact[] = []; const edges = new Map<string, CallEdge>(); const inheritance: InheritanceFact[] = [];
  const unknowns = new Map<string, Unknown>();
  for (const p of ix.problems) { const m = /^(.*?): (.*)$/.exec(p); unknowns.set(`p:${p}`, { file: m?.[1] ?? "", line: null, what: m?.[2] ?? p }); }

  const contracts = [...ix.contracts.values()].filter((c) => c.kind !== "interface").sort(byKey((c: ContractDef) => `${c.file}\u0000${c.name}`));
  for (const c of contracts) {
    const text = (lines.get(c.file) ?? []).slice(c.startLine - 1, c.endLine).join("\n");
    const deployable = c.kind === "contract";
    components.push({
      id: c.name, kind: c.kind as ComponentFact["kind"], deployable, file: c.file, contentSha256: sha(text), linearization: ix.linearize(c.name).map((x) => x.name),
      stateVariables: c.stateVars.map((v) => ({ name: v.name, type: v.type, constant: v.constant, immutable: v.immutable, line: v.line })),
      evidence: ev(c.file, c.startLine, c.endLine), derivation: "syntactic",
    });
    // An abstract base that some deployable contract inherits is analysed only through that contract (as the specialists do); libraries
    // and stand-alone abstract contracts are described on their own.
    if (c.kind === "abstract" && inherited.has(c.name)) continue;
    // the function surface in this component's own dispatch context: the most-derived definition of each signature in its linearisation
    const seen = new Set<string>(); const fns: FunctionDef[] = [];
    for (const k of deployable ? ix.linearize(c.name) : [c]) for (const f of k.functions) {
      // constructors are included (every constructor in the linearisation runs at deployment and often sets authority), never as entry points
      if (!f.body || !(f.kind === "function" || f.kind === "receive" || f.kind === "fallback" || f.kind === "constructor")) continue;
      const s = sig(f); if (seen.has(s)) continue; seen.add(s); fns.push(f.contract === c.name ? f : { ...f, contract: c.name });
    }
    for (const f of fns) {
      const declaredIn = ix.contracts.has(f.contract) && ix.contracts.get(f.contract)!.functions.some((x) => x.startLine === f.startLine && x.file === f.file) ? f.contract : (ix.linearize(c.name).find((k) => k.functions.some((x) => x.startLine === f.startLine && x.file === f.file && x.name === f.name))?.name ?? f.contract);
      const id = `${c.name}.${sig(f)}`;
      const t = an.trace(f);
      const entryPoint = f.kind !== "constructor" && (f.visibility === "external" || f.visibility === "public") && f.mutability !== "view" && f.mutability !== "pure";
      functions.push({
        id, component: c.name, declaredIn, name: f.name, kind: f.kind, visibility: f.visibility, mutability: f.mutability, modifiers: f.modifiers.map((m) => m.name),
        entryPoint, callerGuarded: t.events.some((e) => e.k === "guard" && e.auth),
        stateWrites: [...new Set(t.events.flatMap((e) => (e.k === "write" && !e.variable.startsWith("<") ? [e.variable] : [])))].sort(),
        evidence: ev(f.file, f.startLine, f.endLine), derivation: "inferred:deployed-context-trace",
      });
      for (const e of t.events) {
        // internal hops: every inlined frame on an event's chain is a call from the previous frame (or the function itself)
        let from = id;
        for (const fr of e.chain) {
          const isMod = fr.fn.startsWith("modifier ");
          const to = `${fr.contract}.${isMod ? fr.fn.slice("modifier ".length) : fr.fn}`;
          const k = `${from}>${to}`; if (!edges.has(k)) edges.set(k, { from, kind: isMod ? "modifier" : "internal", to, targetProvenance: null, resolvedCallee: null, evidence: ev(fr.file, fr.line), derivation: "inferred:inlined-trace" });
          from = to;
        }
        if (e.k === "call") {
          const kind: CallEdge["kind"] = e.low === null ? "external" : e.low === "call" ? "low-level-call" : (e.low as CallEdge["kind"]);
          const k = `${from}>${kind}:${e.targetText}@${e.file}:${e.line}`;
          if (!edges.has(k)) edges.set(k, { from, kind, to: e.targetText, targetProvenance: e.targetTaint ?? null, resolvedCallee: e.calleeResolved && e.callee ? e.callee : null, evidence: ev(e.file, e.line), derivation: "inferred:trace-call" });
        }
      }
      for (const u of t.unknowns) {
        const m = /^(.*?):(\d+): (.*)$/.exec(u); unknowns.set(`u:${u}`, { file: m?.[1] ?? f.file, line: m ? Number(m[2]) : null, what: m?.[3] ?? u });
        // an unresolved call is a relationship of THIS function whose target is unknown: recorded as such, never connected to a guess
        const un = m ? /^call to unresolved function (\S+)$/.exec(m[3]!) : null;
        if (un && m) { const k = `${id}>unresolved:${un[1]}@${m[1]}:${m[2]}`; if (!edges.has(k)) edges.set(k, { from: id, kind: "unresolved", to: un[1]!, targetProvenance: null, resolvedCallee: null, evidence: ev(m[1]!, Number(m[2])), derivation: "inferred:trace-unresolved" }); }
      }
    }
    if (deployable) {
      const lin = ix.linearize(c.name); const names = new Map<string, string[]>();
      for (const k of lin) for (const f of k.functions) if (f.kind === "function" && f.body) { const s = sig(f); names.set(s, [...(names.get(s) ?? []), k.name]); }
      const resolved = [...names.entries()].filter(([, ds]) => ds.length > 1).map(([s, ds]) => ({ function: s, resolvedTo: ds[0]!, alsoDeclaredIn: ds.slice(1) })).sort(byKey((x) => x.function));
      inheritance.push({ component: c.name, linearization: lin.map((k) => k.name), resolved, evidence: ev(c.file, c.startLine), derivation: "syntactic" });
    }
  }
  const model: ProtocolModel = {
    schema: PROTOCOL_MODEL_SCHEMA, builder: PROTOCOL_MODEL_BUILDER,
    inputs: [...fileSha.entries()].map(([file, s]) => ({ file, sha256: s })).sort(byKey((x) => x.file)),
    components, functions: functions.sort(byKey((x) => x.id)),
    callEdges: [...edges.values()].sort(byKey((x) => `${x.from}\u0000${x.kind}\u0000${x.to}\u0000${x.evidence.file}:${x.evidence.lineStart}`)),
    inheritance, unknowns: [...unknowns.values()].sort(byKey((x) => `${x.file}\u0000${String(x.line ?? 0).padStart(8, "0")}\u0000${x.what}`)),
  };
  const json = JSON.stringify(model);
  return { model, json, sha256: sha(json) };
}

/** P1 consumer (Priority Engine / T-052): version-aware coverage units, one per component, keyed by the component's content hash. */
export function coverageComponents(model: ProtocolModel): Array<{ id: string; contentSha256: string; weight: number }> {
  const entry = new Map<string, number>(); for (const f of model.functions) if (f.entryPoint) entry.set(f.component, (entry.get(f.component) ?? 0) + 1);
  return model.components.filter((c) => c.deployable || c.kind === "library").map((c) => ({ id: `${c.file}#${c.id}`, contentSha256: c.contentSha256, weight: Math.max(1, entry.get(c.id) ?? 0) }));
}

/** Every non-internal call an entry point can reach, following its internal and modifier edges (helpers make calls on its behalf). */
export function reachableCalls(model: ProtocolModel, fnId: string): CallEdge[] {
  const seen = new Set<string>([fnId]); const queue = [fnId]; const out: CallEdge[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of model.callEdges) if (e.from === cur) {
      if (e.kind === "internal" || e.kind === "modifier") { if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); } }
      else out.push(e);
    }
  }
  return out;
}
