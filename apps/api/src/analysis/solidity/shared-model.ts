import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Pool } from "pg";
import type { DependencyManifest } from "../../acquisition/dependencies.js";
import { ProgramIndex } from "./index.js";
import type { Expr, FunctionDef, Stmt } from "./parser.js";
import { exprText } from "./parser.js";
import { PROTOCOL_MODEL_SCHEMA, type ProtocolModel } from "./protocol-model.js";
import { walkStmts } from "./state-roles.js";

/**
 * C1: the ONE shared, persistent protocol model of a sealed snapshot.
 *
 * It is built once, by the structural analysis, from the P1-P3 protocol model (`protocol-model/3`, unchanged and still stored by its own
 * hash) and stored content-addressed beside it. It does not fork that model: it names it by hash (`base`) and adds the sections every
 * engine needs, each with an explicit status. Every other engine (the challenge stage, the Slither stage, the APEX shadow, the dossier)
 * READS THIS DOCUMENT BY HASH, re-hashes it, and records the hash it read; none rebuilds a model of its own.
 *
 * Honesty rules, enforced by the shape:
 *  - a section is either `computed` (with the analysis that produced it and an epistemic status) or `not_computed` WITH a reason. A
 *    section is never absent and never an empty list standing for "none";
 *  - every fact carries its own epistemic status and the file:line it was read from (file hashes are in `inputs`, once);
 *  - `parsed` is what the parser read as written; `derived` is what a rule or an inlined trace computed from parsed facts; `verified`
 *    is reserved for what was independently checked, and this builder uses it for exactly one thing: the dependency set's content
 *    identity (stored bytes matched against the git objects of the pinned commit), never for what any code does; `unknown` is an open
 *    question. Parsed is never presented as understood.
 *
 * The document is a pure function of the sealed sources, the snapshot identity (repository, commit, manifest digest) and the run's
 * dependency manifest (by digest), so the same sealed input always yields the same hash. It holds no run-specific id.
 */
export const SHARED_MODEL_SCHEMA = "agentsmith-shared-protocol-model/1";
export const SHARED_MODEL_BUILDER = "shared-model-builder/1";
export const SHARED_MODEL_BLOB_LIMIT = 1_048_576;

export type Epistemic = "parsed" | "derived" | "verified" | "unknown";
export type At = { file: string; line_start: number; line_end: number };
export type SectionProvenance = { analysis: string; version: string; method: string; snapshot: { repository: string; commit_sha: string; manifest_sha256: string } };
export type Computed<T> = { status: "computed"; epistemic: Epistemic; provenance: SectionProvenance; note: string } & T;
export type NotComputed = { status: "not_computed"; reason: string };
export type Section<T> = Computed<T> | NotComputed;
type Fact = { epistemic: Epistemic; at: At[] };

export const SECTION_KEYS = ["contracts", "functions", "state", "actors_permissions", "assets_accounting", "external_dependencies", "invariants", "upgradeability", "unsupported_features", "unresolved_questions"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** The feature vocabulary of APEX's fidelity gate (apex/engine/fidelity.ts: UNSUPPORTED_FEATURES), predicted here from syntax only. */
export type PredictedFeature = "external-call" | "other-contract" | "block" | "struct" | "array" | "hashing" | "try" | "proxy" | "inline-assembly";

export type ImportFact = Fact & { file: string; path: string; resolution: "in_snapshot" | "dependency" | "unresolved"; resolved_path: string | null; dependency: string | null; reason: string | null };
export type SharedProtocolModel = {
  schema: typeof SHARED_MODEL_SCHEMA; builder: typeof SHARED_MODEL_BUILDER;
  snapshot: { repository: string; commit_sha: string; manifest_sha256: string };
  /** the P1-P3 model this document extends, by hash; its facts are not copied */
  base: { schema: string; builder: string; sha256: string };
  /** every Solidity source the model was built from, with its content hash (the file hash every `at` refers to) */
  inputs: Array<{ file: string; sha256: string }>;
  dependency_manifest_digest: string | null;
  sections: {
    contracts: Section<{ in_base: string[]; counts: { components: number; deployable: number; libraries: number; inheritance_relations: number } }>;
    functions: Section<{ in_base: string[]; counts: { functions: number; entry_points: number; call_edges: number }; callers: Array<Fact & { function: string; callers: string[] }> }>;
    state: Section<{ variables: Array<Fact & { component: string; variable: string; type: string; constant: boolean; immutable: boolean; roles: string[]; writers: Array<{ function: string; entry_point: boolean; caller_guarded: boolean }> }> }>;
    actors_permissions: Section<{
      functions: Array<Fact & { function: string; entry_point: boolean; caller_guarded: boolean; modifiers: string[]; guards: Array<{ side: string; enforcement: string; reads: string[]; at: At }> }>;
      roles: Array<Fact & { component: string; variable: string; holder: string; strength: string; transfer: string; writers: string[] }>;
      actors: NotComputed;
    }>;
    assets_accounting: Section<Record<string, never>>;
    external_dependencies: Section<{
      external_calls: Array<Fact & { from: string; kind: string; target: string; target_provenance: string | null; resolved_callee: string | null }>;
      imports: ImportFact[];
      dependency_set: Section<{ digest: string; acquired: Array<{ path: string; repository: string; pinned_commit: string; tree_sha: string; manifest_sha256: string }>;
        not_acquired: Array<{ path: string; status: string; reason: string }>; remappings: string[]; limitations: Array<{ code: string; subject: string; reason: string }> }>;
    }>;
    invariants: Section<Record<string, never>>;
    upgradeability: Section<{ markers: Array<Fact & { kind: "delegatecall" | "proxy_boundary" | "initializer" | "implementation_pointer"; component: string; subject: string; detail: string }> }>;
    unsupported_features: Section<{ predicted: Array<Fact & { feature: PredictedFeature; component: string; function: string; what: string }>; by_feature: Record<string, number>; gate_observations: NotComputed }>;
    unresolved_questions: Section<{ questions: Array<Fact & { question: string; about: string; raised_by: string; blocks: string[] }> }>;
  };
};

export type SharedModelContext = {
  snapshot: { repository: string; commit_sha: string; manifest_sha256: string };
  /** the run's dependency manifest and, per ACQUIRED dependency path, the paths its snapshot holds; null when no dependency stage ran */
  dependencies: { manifest: DependencyManifest; files: Record<string, string[]> } | null;
};

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const at = (file: string, a: number, b = a): At => ({ file, line_start: a, line_end: b });
const HASHING = new Set(["keccak256", "sha256", "sha3", "ripemd160", "ecrecover", "blockhash"]);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every `import` of a source file, as written (the parser skips them; they are read here from the text, comments removed). */
export function importsOf(text: string): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
  for (const m of clean.matchAll(/\bimport\b[^;"']*?["']([^"']+)["'][^;]*;/g)) out.push({ path: m[1]!, line: clean.slice(0, m.index).split("\n").length });
  return out;
}

function resolveImports(sources: ReadonlyArray<{ path: string; text: string }>, deps: SharedModelContext["dependencies"]): ImportFact[] {
  const have = new Set(sources.map((s) => s.path)); const out: ImportFact[] = [];
  const manifest = deps?.manifest ?? null;
  const remaps = (manifest?.remappings ?? []).slice().sort((a, b) => b.prefix.length - a.prefix.length);
  const depAt = (p: string) => (manifest?.dependencies ?? []).filter((d) => p === d.path || p.startsWith(`${d.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  for (const s of sources) for (const im of importsOf(s.text)) {
    const fact = (resolution: ImportFact["resolution"], resolved_path: string | null, dependency: string | null, reason: string | null): void => {
      out.push({ epistemic: resolution === "unresolved" ? "unknown" : "parsed", at: [at(s.path, im.line)], file: s.path, path: im.path.slice(0, 500), resolution, resolved_path, dependency, reason });
    };
    const candidates: string[] = [];
    if (/^\.\.?\//.test(im.path)) candidates.push(posix.normalize(posix.join(posix.dirname(s.path), im.path)));
    else {
      candidates.push(posix.normalize(im.path));
      const r = remaps.find((x) => im.path.startsWith(x.prefix) && (!x.context || s.path.startsWith(x.context)));
      if (r) candidates.unshift(posix.normalize(r.target.replace(/^\.\//, "") + im.path.slice(r.prefix.length)));
    }
    const inSnapshot = candidates.find((c) => have.has(c));
    if (inSnapshot) { fact("in_snapshot", inSnapshot, null, null); continue; }
    let done = false;
    for (const c of candidates) {
      const d = depAt(c); if (!d) continue;
      if (d.status === "acquired" && (deps!.files[d.path] ?? []).includes(c.slice(d.path.length + 1))) fact("dependency", c, d.path, null);
      else fact("unresolved", c, d.path, d.status === "acquired" ? `dependency ${d.path} was acquired at ${d.pinned_commit}, but it holds no file ${c.slice(d.path.length + 1)}` : `dependency ${d.path} is ${d.status}: ${d.reason ?? ""}`.trim());
      done = true; break;
    }
    if (done) continue;
    const pkg = candidates.map((c) => /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(c)?.[1]).find(Boolean) ?? (/^(@[^/]+\/[^/]+|[a-z0-9][a-z0-9._-]*)\//.exec(im.path)?.[1] && manifest?.packages.find((p) => im.path.startsWith(`${p.name}/`))?.name);
    if (pkg) { const p = manifest?.packages.find((x) => x.name === pkg); fact("unresolved", null, `node_modules/${pkg}`, p ? `package ${pkg} is ${p.status}: ${p.reason}` : `package ${pkg} is not declared by package.json; it is unpinned and never fetched`); continue; }
    fact("unresolved", null, null, manifest ? "the import is not a file of the analysed snapshot and no remapping or dependency provides it" : "the import is not a file of the analysed snapshot; dependency acquisition was not requested for this run");
  }
  return out.sort((a, b) => cmp(a.file, b.file) || a.at[0]!.line_start - b.at[0]!.line_start || cmp(a.path, b.path));
}

/** Syntax that APEX's fidelity gate does not model (its UNSUPPORTED_FEATURES), found by walking the parse. A PREDICTION, not the gate's result. */
function predictUnsupported(ix: ProgramIndex): Array<Fact & { feature: PredictedFeature; component: string; function: string; what: string }> {
  const out = new Map<string, Fact & { feature: PredictedFeature; component: string; function: string; what: string }>();
  const add = (feature: PredictedFeature, component: string, fn: string, file: string, line: number, what: string) => {
    const k = `${feature}|${file}|${line}`; if (!out.has(k)) out.set(k, { epistemic: "parsed", at: [at(file, line)], feature, component, function: fn, what: what.slice(0, 160) });
  };
  for (const c of ix.contracts.values()) {
    if (c.kind === "interface") continue;
    for (const v of c.stateVars) {
      const t = v.type.replace(/\s+/g, " ");
      if (/\[[^\]]*\]/.test(t)) add("array", c.name, "(state)", c.file, v.line, `state variable ${v.name}: ${t}`);
      const value = /^mapping/.test(t) ? (t.split("=>").pop() ?? "").replace(/[) ]*$/g, "").trim() : t;
      if (/^[A-Z]\w*(\.\w+)?$/.test(value) && !ix.isContractLike(value)) add("struct", c.name, "(state)", c.file, v.line, `state variable ${v.name}: user-defined type ${value}`);
      else if (/^[A-Z]\w*$/.test(value) && ix.isContractLike(value)) add("other-contract", c.name, "(state)", c.file, v.line, `state variable ${v.name}: contract-typed ${value}`);
    }
    for (const f of [...c.functions, ...c.modifiers] as FunctionDef[]) {
      if (!f.body) continue; const name = f.name || f.kind;
      const stmts = (ss: Stmt[]): void => { for (const s of ss) {
        if (s.k === "asm") add("inline-assembly", c.name, name, f.file, s.line, "inline assembly block");
        if (s.k === "try") { add("try", c.name, name, f.file, s.line, "try/catch"); stmts(s.body); s.catches.forEach(stmts); }
        if (s.k === "if") { stmts(s.then); stmts(s.els); } if (s.k === "loop" || s.k === "block") stmts(s.body);
      } };
      stmts(f.body);
      walkStmts(f.body, (e: Expr) => {
        if (e.k === "new") add("other-contract", c.name, name, f.file, e.line, `new ${e.type}`);
        if (e.k === "member" && e.obj.k === "id" && e.obj.name === "block") add("block", c.name, name, f.file, e.line, `block.${e.name}`);
        if (e.k === "id" && e.name === "now") add("block", c.name, name, f.file, e.line, "now");
        if (e.k !== "call") return;
        const fn = e.fn.k === "call" ? e.fn.fn : e.fn; // `.call{value: x}("")` parses the options into the call
        if (fn.k === "id" && HASHING.has(fn.name)) add("hashing", c.name, name, f.file, e.line, `${fn.name}(...)`);
        if (fn.k === "member" && fn.obj.k === "id" && fn.obj.name === "abi") add("hashing", c.name, name, f.file, e.line, `abi.${fn.name}(...)`);
        if (fn.k === "member" && fn.name === "delegatecall") add("proxy", c.name, name, f.file, e.line, `${exprText(fn.obj)}.delegatecall(...)`);
        else if (fn.k === "member" && ["call", "staticcall", "send", "transfer"].includes(fn.name) && !(fn.obj.k === "id" && ["abi", "super", "this"].includes(fn.obj.name))) add("external-call", c.name, name, f.file, e.line, `${exprText(fn.obj)}.${fn.name}(...)`);
      });
    }
  }
  return [...out.values()].sort((a, b) => cmp(a.at[0]!.file, b.at[0]!.file) || a.at[0]!.line_start - b.at[0]!.line_start || cmp(a.feature, b.feature));
}

export function buildSharedModel(sources: ReadonlyArray<{ path: string; text: string }>, base: { model: ProtocolModel; sha256: string }, ctx: SharedModelContext): { doc: SharedProtocolModel; json: string; sha256: string } {
  const m = base.model; const ix = new ProgramIndex(sources);
  const prov = (analysis: string, version: string, method: string): SectionProvenance => ({ analysis, version, method, snapshot: ctx.snapshot });
  const ev = (e: { file: string; lineStart: number; lineEnd: number }): At => at(e.file, e.lineStart, e.lineEnd);
  const fnById = new Map(m.functions.map((f) => [f.id, f]));

  const callers = new Map<string, Set<string>>();
  for (const e of m.callEdges) if (e.kind === "internal" || e.kind === "modifier") (callers.get(e.to) ?? callers.set(e.to, new Set()).get(e.to)!).add(e.from);

  const roles = new Map<string, string[]>();
  for (const c of m.stateRoles.byComponent) for (const v of c.variables) roles.set(`${c.component}\u0000${v.variable}`, v.roles.map((r) => `${r.role} (${r.basis}, ${r.strength})`));
  const variables: Extract<SharedProtocolModel["sections"]["state"], { status: "computed" }>["variables"] = [];
  for (const c of m.components) {
    const fns = m.functions.filter((f) => f.component === c.id);
    for (const v of c.stateVariables) variables.push({
      epistemic: "derived", at: [at(c.file, v.line)], component: c.id, variable: v.name, type: v.type, constant: v.constant, immutable: v.immutable, roles: roles.get(`${c.id}\u0000${v.name}`) ?? [],
      writers: fns.filter((f) => f.stateWrites.includes(v.name)).map((f) => ({ function: f.id, entry_point: f.entryPoint, caller_guarded: f.callerGuarded })),
    });
  }

  const checks = new Map<string, Array<{ side: string; enforcement: string; reads: string[]; at: At }>>();
  for (const a of m.authority.byComponent) for (const k of a.checks) (checks.get(k.fn) ?? checks.set(k.fn, []).get(k.fn)!).push({ side: k.side, enforcement: k.enforcement, reads: k.reads, at: at(k.at.file, k.at.line) });
  const permFns = m.functions.filter((f) => f.entryPoint || f.kind === "constructor").map((f) => ({ epistemic: "derived" as const, at: [ev(f.evidence)], function: f.id, entry_point: f.entryPoint, caller_guarded: f.callerGuarded, modifiers: f.modifiers, guards: checks.get(f.id) ?? [] }));
  const permRoles = m.authority.byComponent.flatMap((a) => a.roles.map((r) => ({ epistemic: "derived" as const, at: r.evidence.map((l) => at(l.file, l.line)), component: a.component, variable: r.variable, holder: r.holder, strength: r.strength, transfer: r.transfer,
    writers: r.writers.map((w) => `${w.fn} [${w.control}]`) })));

  const externalCalls = m.callEdges.filter((e) => e.kind !== "internal" && e.kind !== "modifier" && e.kind !== "unresolved").map((e) => ({ epistemic: (e.resolvedCallee ? "derived" : "parsed") as Epistemic, at: [ev(e.evidence)], from: e.from, kind: e.kind, target: e.to, target_provenance: e.targetProvenance, resolved_callee: e.resolvedCallee }));
  const imports = resolveImports(sources, ctx.dependencies);
  const dm = ctx.dependencies?.manifest ?? null;
  const dependency_set: Extract<SharedProtocolModel["sections"]["external_dependencies"], { status: "computed" }>["dependency_set"] = dm ? {
    status: "computed", epistemic: "verified", provenance: prov(dm.resolver, dm.schema, "gitlinks of the pinned parent tree; each dependency acquired at its pinned commit and verified against its git tree"),
    note: "`verified` here means only that each acquired dependency's stored bytes match the git objects of its pinned commit. It says nothing about what the code does.",
    digest: dm.digest,
    acquired: dm.dependencies.filter((d) => d.status === "acquired").map((d) => ({ path: d.path, repository: d.repository!, pinned_commit: d.pinned_commit!, tree_sha: d.tree_sha!, manifest_sha256: d.manifest_sha256! })),
    not_acquired: dm.dependencies.filter((d) => d.status !== "acquired").map((d) => ({ path: d.path, status: d.status, reason: d.reason ?? "" })),
    remappings: dm.remappings.filter((r) => r.available).map((r) => `${r.context ? `${r.context}:` : ""}${r.prefix}=${r.target}`),
    limitations: dm.limitations.map((l) => ({ code: l.code, subject: l.subject, reason: l.reason })),
  } : { status: "not_computed", reason: "dependency acquisition was not requested for this run: submodules, remappings and packages were not resolved" };

  const markers: Extract<SharedProtocolModel["sections"]["upgradeability"], { status: "computed" }>["markers"] = [];
  for (const e of m.callEdges) if (e.kind === "delegatecall") markers.push({ epistemic: "parsed", at: [ev(e.evidence)], kind: "delegatecall", component: fnById.get(e.from)?.component ?? e.from.split(".")[0]!, subject: e.from, detail: `delegatecall to ${e.to} (target from ${e.targetProvenance ?? "n/a"})` });
  for (const a of m.authority.byComponent) {
    for (const p of a.proxy) markers.push({ epistemic: "derived", at: [at(p.at.file, p.at.line)], kind: "proxy_boundary", component: a.component, subject: p.fallback, detail: `delegates to ${p.pointer} -> ${p.implementation}; ${p.note}`.slice(0, 400) });
    for (const i of a.initialisers) markers.push({ epistemic: "derived", at: [at(i.at.file, i.at.line)], kind: "initializer", component: a.component, subject: i.fn, detail: `flag ${i.flag}; ${i.lockedInConstructor ? "locked in the constructor" : "not locked in the constructor"}; ${i.note}`.slice(0, 400) });
  }
  for (const c of m.stateRoles.byComponent) for (const v of c.variables) for (const r of v.roles) if (r.role === "implementation_pointer") markers.push({ epistemic: "derived", at: r.evidence.map((l) => at(l.file, l.line)), kind: "implementation_pointer", component: c.component, subject: v.variable, detail: `${r.basis}, ${r.strength}, rule ${r.rule}` });
  markers.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.component, b.component) || cmp(a.subject, b.subject) || (a.at[0]?.line_start ?? 0) - (b.at[0]?.line_start ?? 0));

  const predicted = predictUnsupported(ix);
  const by_feature: Record<string, number> = {}; for (const p of predicted) by_feature[p.feature] = (by_feature[p.feature] ?? 0) + 1;

  const questions: Extract<SharedProtocolModel["sections"]["unresolved_questions"], { status: "computed" }>["questions"] = [];
  for (const u of m.unknowns) questions.push({ epistemic: "unknown", at: u.line ? [at(u.file, u.line)] : [], question: `not modelled: ${u.what}`.slice(0, 400), about: u.file, raised_by: "structural-analysis", blocks: ["structural-specialists", "execution-validators"] });
  for (const a of m.authority.byComponent) for (const u of a.unresolved) questions.push({ epistemic: "unknown", at: u.at ? [at(u.at.file, u.at.line)] : [], question: `authority unresolved: ${u.what}`.slice(0, 400), about: a.component, raised_by: "authority-facts", blocks: ["actors_permissions"] });
  for (const i of imports) if (i.resolution === "unresolved") questions.push({ epistemic: "unknown", at: i.at, question: `import "${i.path}" is not available: ${i.reason}`.slice(0, 400), about: i.file, raised_by: "import-resolution", blocks: ["slither", "foundry", "cross-contract analysis"] });
  for (const l of dm?.limitations ?? []) questions.push({ epistemic: "unknown", at: [], question: `dependency limitation (${l.code}) on ${l.subject}: ${l.reason}`.slice(0, 400), about: l.subject, raised_by: "dependency-acquisition", blocks: ["slither", "foundry"] });

  const sections: SharedProtocolModel["sections"] = {
    contracts: { status: "computed", epistemic: "parsed", provenance: prov("structural-analysis", `${m.schema} ${m.builder}`, "parse of the sealed sources; inheritance linearised by rule"),
      note: "The facts are the base model's `components` and `inheritance` (read them there, by the base hash). Parsed as written: a component listed here is not thereby understood.",
      in_base: ["components", "inheritance"], counts: { components: m.components.length, deployable: m.components.filter((c) => c.deployable).length, libraries: m.components.filter((c) => c.kind === "library").length, inheritance_relations: m.inheritance.length } },
    functions: { status: "computed", epistemic: "derived", provenance: prov("structural-analysis", `${m.schema} ${m.builder}`, "deployed-context traces with helpers and modifiers inlined"),
      note: "Functions and call edges are the base model's `functions` and `callEdges`; `callers` inverts its internal and modifier edges. External callers (other contracts, off-chain actors) are NOT known.",
      in_base: ["functions", "callEdges"], counts: { functions: m.functions.length, entry_points: m.functions.filter((f) => f.entryPoint).length, call_edges: m.callEdges.length },
      callers: [...callers.entries()].sort(([a], [b]) => cmp(a, b)).map(([fn, cs]) => ({ epistemic: "derived" as const, at: fnById.get(fn) ? [ev(fnById.get(fn)!.evidence)] : [], function: fn, callers: [...cs].sort() })) },
    state: { status: "computed", epistemic: "derived", provenance: prov("structural-analysis", `${m.stateRoles.version}`, "declarations as parsed; writers from inlined traces of each component's functions; roles by the P2 rules"),
      note: "Writers are the functions whose trace writes the variable in that component's dispatch context. Storage layout (slots, packing) and writes through assembly or unresolved calls are NOT modelled.", variables },
    actors_permissions: { status: "computed", epistemic: "derived", provenance: prov("authority-facts", m.authority.version, "guards found on each function's inlined trace, classified by side; roles by the P3 rules"),
      note: "A guard is described, never certified: `caller_guarded` means a caller-side check was found on the trace, not that it is sufficient. Who actually holds a role on a deployment is unknown.",
      functions: permFns, roles: permRoles, actors: { status: "not_computed", reason: "the actor set (deployer, role holders, unprivileged account, attacker contract) is not derived from authority facts yet; exploration still uses a fixed actor set" } },
    assets_accounting: { status: "not_computed", reason: "no rule derives assets, share tokens or accounting relations yet (protocol model R5). State-variable roles (ledger, aggregate) are in `state`; they are roles, not accounting relations." },
    external_dependencies: { status: "computed", epistemic: "parsed", provenance: prov("structural-analysis", SHARED_MODEL_BUILDER, "external call targets from traces, as written; import statements read from source text and resolved against the snapshot and the dependency manifest"),
      note: "A call target is the EXPRESSION as written unless `resolved_callee` names a contract typed inside the snapshot. Code behind an unresolved import or call was not read.", external_calls: externalCalls, imports, dependency_set },
    invariants: { status: "not_computed", reason: "no rule-derived or declared invariants exist. Candidates inferred by state exploration are measurement records, never model facts." },
    upgradeability: { status: "computed", epistemic: "parsed", provenance: prov("structural-analysis", `${m.authority.version} ${m.stateRoles.version}`, "delegatecall sites as parsed; proxy boundaries, initialisers and implementation pointers by the P2/P3 rules"),
      note: "Markers only. An empty list means these rules found none; it is NOT evidence that the code is not upgradeable (selector routing in assembly, diamonds and beacon patterns are not recognised).", markers },
    unsupported_features: { status: "computed", epistemic: "parsed", provenance: prov("structural-analysis", SHARED_MODEL_BUILDER, "syntactic scan for the features APEX's fidelity gate does not model (apex/engine/fidelity.ts: UNSUPPORTED_FEATURES)"),
      note: "A PREDICTION from syntax: the gate decides at execution, per transaction. Where APEX ran, its own abstentions are in the run's shadow record and are read with the model (unsupportedFeaturesOfRun).",
      predicted, by_feature, gate_observations: { status: "not_computed", reason: "the fidelity gate's abstentions exist only after the APEX shadow stage ran on this snapshot; they are recorded on the shadow step (worker-reported, measurement only), not in this immutable document" } },
    unresolved_questions: { status: "computed", epistemic: "unknown", provenance: prov("structural-analysis", SHARED_MODEL_BUILDER, "collected from the analyzer's not-modelled list, authority facts, import resolution and the dependency manifest"),
      note: "Open questions. None of them is evidence of a vulnerability or of its absence.", questions },
  };
  const doc: SharedProtocolModel = { schema: SHARED_MODEL_SCHEMA, builder: SHARED_MODEL_BUILDER, snapshot: ctx.snapshot, base: { schema: m.schema, builder: m.builder, sha256: base.sha256 }, inputs: m.inputs, dependency_manifest_digest: dm?.digest ?? null, sections };
  const json = JSON.stringify(doc);
  return { doc, json, sha256: sha(json) };
}

export const sectionStatuses = (doc: SharedProtocolModel): Record<SectionKey, string> =>
  Object.fromEntries(SECTION_KEYS.map((k) => { const s = doc.sections[k]; return [k, s.status === "computed" ? `computed:${s.epistemic}` : "not_computed"]; })) as Record<SectionKey, string>;

// ------------------------------------------------------------------------------------------------------------ reading by hash
export class SharedModelError extends Error { constructor(readonly code: "hash_mismatch" | "invalid" | "base_mismatch", message: string) { super(message); this.name = "SharedModelError"; } }
export type SharedModelRef = { sha256: string; base_sha256: string; json: string };
export type SharedModelUnavailable = { available: false; reason: string };
export type SharedModelRead = { available: true; sha256: string; base_sha256: string; doc: SharedProtocolModel } | SharedModelUnavailable;
/** What a consumer records about the model it read (its provenance): the hash, how it was read, and what it used it for. */
export type ModelReadRecord = { sha256: string; base_sha256: string; schema: string; read: "by_hash"; verified: "re-hashed on read"; used_for: string } | { sha256: null; read: "unavailable"; reason: string };

/** Re-hashes a model document against the hash it was read by. A mismatch is an integrity error, never repaired or rebuilt. */
export function verifySharedModel(ref: SharedModelRef): Extract<SharedModelRead, { available: true }> {
  if (sha(ref.json) !== ref.sha256) throw new SharedModelError("hash_mismatch", `the shared protocol model does not match the hash it was read by (${ref.sha256})`);
  let doc: SharedProtocolModel;
  try { doc = JSON.parse(ref.json) as SharedProtocolModel; } catch { throw new SharedModelError("invalid", "the shared protocol model is not valid JSON"); }
  if (doc.schema !== SHARED_MODEL_SCHEMA || !doc.sections || SECTION_KEYS.some((k) => !doc.sections[k] || (doc.sections[k].status !== "computed" && doc.sections[k].status !== "not_computed"))) throw new SharedModelError("invalid", "the shared protocol model does not have its schema (a section is missing or has no status)");
  if (doc.base.sha256 !== ref.base_sha256) throw new SharedModelError("base_mismatch", "the shared protocol model names another base model than the analysis step recorded");
  return { available: true, sha256: ref.sha256, base_sha256: ref.base_sha256, doc };
}
export const modelReadRecord = (r: SharedModelRead, used_for: string): ModelReadRecord =>
  r.available ? { sha256: r.sha256, base_sha256: r.base_sha256, schema: r.doc.schema, read: "by_hash", verified: "re-hashed on read", used_for } : { sha256: null, read: "unavailable", reason: r.reason };

/** The stored model of a run, located ONLY through its analysis step's recorded hash (never rebuilt). Null when the step recorded none. */
export async function sharedModelRefOfRun(db: Pick<Pool, "query">, runId: string): Promise<SharedModelRef | SharedModelUnavailable> {
  const o = (await db.query<{ sha: string | null; base: string | null; stored: boolean | null }>(
    `SELECT output->>'shared_model_sha256' AS sha, output->>'protocol_model_sha256' AS base, (output->>'shared_model_stored')::boolean AS stored FROM workflow_steps
      WHERE workflow_run_id = $1 AND step_key = 'analyze_structure' AND status = 'succeeded'`, [runId])).rows[0];
  if (!o) return { available: false, reason: "no successful structural-analysis step is recorded for this run" };
  if (!o.sha || !o.base) return { available: false, reason: "the analysis step recorded no shared protocol model (a build before the shared model)" };
  if (o.stored === false) return { available: false, reason: `the shared protocol model ${o.sha} was not stored (larger than one blob)` };
  const blob = (await db.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [o.sha])).rows[0];
  if (!blob) return { available: false, reason: `the recorded shared protocol model ${o.sha} is not stored` };
  return { sha256: o.sha, base_sha256: o.base, json: blob.content.toString("utf8") };
}
export async function readSharedModelOfRun(db: Pick<Pool, "query">, runId: string): Promise<SharedModelRead> {
  const ref = await sharedModelRefOfRun(db, runId);
  return "json" in ref ? verifySharedModel(ref) : ref;
}
export const readSharedModelRef = (ref: SharedModelRef | SharedModelUnavailable): SharedModelRead => ("json" in ref ? verifySharedModel(ref) : ref);

/** The base (P1-P3) model the shared model names, by that hash, re-hashed. */
export async function readBaseModel(db: Pick<Pool, "query">, baseSha256: string): Promise<ProtocolModel> {
  const blob = (await db.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [baseSha256])).rows[0];
  if (!blob) throw new SharedModelError("invalid", `the base protocol model ${baseSha256} is not stored`);
  if (createHash("sha256").update(blob.content).digest("hex") !== baseSha256) throw new SharedModelError("hash_mismatch", "the stored base protocol model does not match its recorded hash");
  const m = JSON.parse(blob.content.toString("utf8")) as ProtocolModel;
  if (m.schema !== PROTOCOL_MODEL_SCHEMA) throw new SharedModelError("invalid", `the base protocol model has schema ${String(m.schema)}`);
  return m;
}

/**
 * The model's `unsupported_features` section together with what APEX's fidelity gate actually abstained on, where the shadow stage ran on
 * this run: the gate's abstentions are read from the shadow step's recorded report (an append-only audit event; worker-reported,
 * measurement only) and are returned BESIDE the model's prediction, each with its own provenance. Neither is evidence about a lead.
 */
export type UnsupportedFeaturesView = {
  model_sha256: string | null;
  predicted: { status: "computed" | "not_computed"; epistemic: Epistemic | null; by_feature: Record<string, number>; total: number; reason?: string };
  gate: { status: "computed"; epistemic: "derived"; provenance: { analysis: "apex-fidelity-gate"; report_sha256: string; audit_event_id: string; reported_by: "worker"; label: string; model_sha256_read: string | null };
    by_feature: Record<string, number>; abstentions: Array<{ feature: string; contract: string; function: string; at: string; why: string }>; predicted_and_observed: string[]; observed_not_predicted: string[]; predicted_not_observed: string[] } | NotComputed;
};
export async function unsupportedFeaturesOfRun(db: Pick<Pool, "query">, runId: string): Promise<UnsupportedFeaturesView> {
  const model = await readSharedModelOfRun(db, runId);
  const sec = model.available ? model.doc.sections.unsupported_features : null;
  const predicted: UnsupportedFeaturesView["predicted"] = sec?.status === "computed" ? { status: "computed", epistemic: sec.epistemic, by_feature: sec.by_feature, total: sec.predicted.length }
    : { status: "not_computed", epistemic: null, by_feature: {}, total: 0, reason: model.available ? (sec as NotComputed).reason : model.reason };
  const row = (await db.query<{ id: string; payload: Record<string, any> }>(
    `SELECT a.id::text AS id, a.payload FROM audit_events a JOIN workflow_steps s ON s.id::text = a.entity_id
      WHERE s.workflow_run_id = $1 AND s.step_key = 'apex_shadow' AND a.entity_type = 'workflow_step' AND a.action = 'apex_shadow.reported' AND a.payload->>'status' = 'completed' ORDER BY a.id DESC LIMIT 1`, [runId])).rows[0];
  if (!row) return { model_sha256: model.available ? model.sha256 : null, predicted, gate: { status: "not_computed", reason: "no completed APEX shadow report is recorded for this run (the stage did not run, was refused or failed), so the fidelity gate observed nothing here" } };
  const r = row.payload.result as { abstentions: Array<{ feature: string; contract: string; function: string; at: string; why: string }>; abstentions_by_feature: Record<string, number>; input_files: Array<{ path: string }> };
  const files = new Set(r.input_files.map((f) => f.path));
  const p = new Set(sec?.status === "computed" ? sec.predicted.filter((x) => files.has(x.at[0]!.file)).map((x) => x.feature as string) : []);
  const o = new Set(Object.keys(r.abstentions_by_feature));
  return { model_sha256: model.available ? model.sha256 : null, predicted, gate: {
    status: "computed", epistemic: "derived",
    provenance: { analysis: "apex-fidelity-gate", report_sha256: String(row.payload.report_sha256), audit_event_id: row.id, reported_by: "worker", label: String(row.payload.label), model_sha256_read: row.payload.provenance?.protocol_model?.sha256 ?? null },
    by_feature: r.abstentions_by_feature, abstentions: r.abstentions.slice(0, 500).map((a) => ({ feature: a.feature, contract: a.contract, function: a.function, at: a.at, why: a.why })),
    predicted_and_observed: [...o].filter((f) => p.has(f)).sort(), observed_not_predicted: [...o].filter((f) => !p.has(f)).sort(), predicted_not_observed: [...p].filter((f) => !o.has(f)).sort(),
  } };
}
