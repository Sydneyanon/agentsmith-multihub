/**
 * Benchmark runner (Priority B, B3). Wraps the existing black-box scorer (eval/run-eval.ts `score`) and records everything a
 * result needs to be reproducible and honest: corpus version + manifest verification, analyzer capability + commit, exposure,
 * label integrity against the source, timing, deterministic per-class and overall metrics, detector collisions and unscored
 * findings (which `score` does not report), and failures. AI adjudication is a separate, optional pass (adjudicate.ts) whose
 * output is stored beside — never merged into — the deterministic result, and which can never change labels.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { analyzeSources } from "../../apps/api/src/analysis/solidity/specialists.js";
import { CAPABILITIES } from "../../apps/api/src/engine/capabilities.js";
import { loadCorpus, score } from "../run-eval.js";

export const RUNNER_VERSION = "benchmark-runner/1";

export type Label = { file: string; contract: string; function: string; class: string; vulnerable: boolean; line: number; pair?: string | null; note?: string; exploitable?: boolean };
export type FindingRow = { class: string; contract: string; function: string; file: string; line: number; claim: string };
type Counts = { tp: number; fp: number; fn: number; tn: number };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const rate = (num: number, den: number) => (den ? +(num / den).toFixed(3) : null);
export const metrics = (c: Counts) => ({ ...c, precision: rate(c.tp, c.tp + c.fp), recall: rate(c.tp, c.tp + c.fn), falsePositiveRate: rate(c.fp, c.fp + c.tn) });

/** Recomputes every hash in <corpus>/MANIFEST.sha256 (paths relative to the corpus root). */
export function verifyManifest(corpusRoot: string) {
  const path = join(corpusRoot, "MANIFEST.sha256");
  if (!existsSync(path)) return { present: false as const, ok: false, manifestSha256: null, mismatches: [] as string[], files: 0 };
  const text = readFileSync(path, "utf8");
  const mismatches: string[] = []; let files = 0;
  for (const line of text.split("\n").filter((l) => l.trim())) {
    const [hash, rel] = [line.slice(0, 64), line.slice(66)]; files += 1;
    const f = join(corpusRoot, rel);
    if (!existsSync(f) || sha256(readFileSync(f)) !== hash) mismatches.push(rel);
  }
  return { present: true as const, ok: mismatches.length === 0, manifestSha256: sha256(text), mismatches, files };
}

/**
 * Every archived version under <corpus>/versions/vN froze a set of files; an amendment may add files but must never alter one.
 * Each archived manifest line is re-checked against the current corpus (labels.json against the archived copy, since labels are
 * append-only and the archive keeps the version's exact file).
 */
export function verifyArchivedVersions(corpusRoot: string) {
  const dir = join(corpusRoot, "versions");
  if (!existsSync(dir)) return { versions: [] as string[], ok: true, problems: [] as string[] };
  const versions = readdirSync(dir).filter((v) => existsSync(join(dir, v, "MANIFEST.sha256"))).sort();
  const problems: string[] = [];
  for (const v of versions) for (const line of readFileSync(join(dir, v, "MANIFEST.sha256"), "utf8").split("\n").filter((l) => l.trim())) {
    const [hash, rel] = [line.slice(0, 64), line.slice(66)];
    const f = rel === "labels.json" ? join(dir, v, "labels.json") : join(corpusRoot, rel);
    if (!existsSync(f) || sha256(readFileSync(f)) !== hash) problems.push(`${v}: ${rel} altered or missing`);
  }
  return { versions, ok: problems.length === 0, problems };
}

type Span = { startLine: number; endLine: number };
type IndexLike = { findFunctions(c: string, f: string): Span[]; entryPoints?(c: string): Array<Span & { name: string }> };

/** Brace-matched span of `constructor(...) { ... }` in a source text (the parser index does not expose constructors). */
function constructorSpan(text: string): Span | null {
  const lines = text.split("\n"); const i = lines.findIndex((l) => /\bconstructor\s*\(/.test(l)); if (i < 0) return null;
  let depth = 0; let opened = false;
  for (let j = i; j < lines.length; j++) for (const ch of lines[j]!) {
    if (ch === "{") { depth++; opened = true; } else if (ch === "}") { depth--; if (opened && depth === 0) return { startLine: i + 1, endLine: j + 1 }; }
  }
  return null;
}

function spansOf(index: IndexLike, contract: string, name: string, text: string | undefined): Span[] {
  const found = index.findFunctions(contract, name);
  if (found.length) return found;
  const special = (index.entryPoints?.(contract) ?? []).filter((e) => e.name === name);
  if (special.length) return special;
  if (name === "constructor" && text) { const c = constructorSpan(text); if (c) return [c]; }
  return [];
}

/**
 * Each label must name a function that exists, and its line must be a non-empty line inside that function — or inside a
 * same-contract function it calls (a common convention: the label marks the external call in an internal helper reached from
 * the labelled entry point). Helper placements are reported (viaInternalCall), not silently accepted.
 */
export function checkLabels(labels: Label[], sources: Array<{ path: string; text: string }>, index: IndexLike) {
  const texts = new Map(sources.map((s) => [s.path, s.text]));
  const problems: string[] = []; const viaInternalCall: string[] = [];
  for (const l of labels) {
    const text = texts.get(l.file); const lines = text?.split("\n") ?? [];
    const own = spansOf(index, l.contract, l.function, text);
    if (!own.length) { problems.push(`${l.file}:${l.line} ${l.contract}.${l.function}: function not found`); continue; }
    const lineText = lines[l.line - 1];
    if (!lineText || !lineText.trim()) { problems.push(`${l.file}:${l.line}: empty or missing source line`); continue; }
    if (own.some((s) => l.line >= s.startLine && l.line <= s.endLine)) continue;
    const body = own.map((s) => lines.slice(s.startLine - 1, s.endLine).join("\n")).join("\n");
    const callees = [...new Set([...body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!))].filter((n) => n !== l.function);
    const helper = callees.find((n) => index.findFunctions(l.contract, n).some((s) => l.line >= s.startLine && l.line <= s.endLine));
    if (helper) viaInternalCall.push(`${l.file}:${l.line} ${l.contract}.${l.function} -> ${helper}`);
    else problems.push(`${l.file}:${l.line} ${l.contract}.${l.function}: line outside the function and its internal callees`);
  }
  return { ok: problems.length === 0, checked: labels.length, problems, viaInternalCall };
}

/**
 * Findings `score` does not account for. `collisions`: a finding on a LABELLED function whose class differs from that function's
 * label(s) — another detector firing on the benchmark's subject (e.g. a reentrancy heuristic on a cross-contract pair).
 * `unscored`: findings in functions that carry no label at all.
 */
export function classifyExtraFindings(rows: FindingRow[], labels: Label[]) {
  const labelled = new Map<string, Set<string>>();
  for (const l of labels) { const k = `${l.file}|${l.function}`; labelled.set(k, (labelled.get(k) ?? new Set()).add(l.class)); }
  const collisions: FindingRow[] = []; const unscored: FindingRow[] = [];
  for (const r of rows) {
    const classes = labelled.get(`${r.file}|${r.function}`);
    if (!classes) unscored.push(r); else if (!classes.has(r.class)) collisions.push(r);
  }
  return { collisions, unscored };
}

function gitInfo(repoRoot: string) {
  try {
    const commit = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", repoRoot, "status", "--porcelain", "--", "apps/api/src/analysis", "apps/api/src/engine"], { encoding: "utf8" }).trim().length > 0;
    return { commit, analyzerSourceDirty: dirty };
  } catch { return { commit: null, analyzerSourceDirty: null }; }
}

function exposureFor(repoRoot: string, capability: string, corpus: string) {
  try {
    const doc = JSON.parse(readFileSync(join(repoRoot, "eval", "exposure.json"), "utf8")) as { entries: Array<{ capability: string; corpus: string; status: string }> };
    return doc.entries.find((e) => e.capability === capability && e.corpus === corpus)?.status ?? "unregistered";
  } catch { return "unregistered"; }
}

export type BenchmarkOptions = { contractsDir: string; repoRoot: string; timeBudgetMs?: number; now?: () => number };

export function runBenchmark(opts: BenchmarkOptions) {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const corpusRoot = dirname(opts.contractsDir);
  const corpus = basename(corpusRoot);
  const cap = CAPABILITIES.find((c) => c.id === "solidity-structural-specialists")!;
  const capability = `${cap.id}@${cap.version}`;
  const failures: string[] = [];

  const benchmarkMeta = existsSync(join(corpusRoot, "BENCHMARK.json")) ? JSON.parse(readFileSync(join(corpusRoot, "BENCHMARK.json"), "utf8")) as { name: string; version: number } : null;
  const manifest = verifyManifest(corpusRoot);
  if (manifest.present && !manifest.ok) failures.push(`manifest mismatch: ${manifest.mismatches.join(", ")} (corpus is no longer the frozen version)`);
  const archived = verifyArchivedVersions(corpusRoot);
  if (!archived.ok) failures.push(`archived version altered: ${archived.problems.join("; ")}`);

  const { sources, labels } = loadCorpus(opts.contractsDir) as { sources: Array<{ path: string; text: string }>; labels: Label[] };

  const tAnalyze = now();
  let analysis: ReturnType<typeof analyzeSources> | null = null; let reproducible: boolean | null = null;
  try {
    analysis = analyzeSources(sources);
    const again = analyzeSources([...sources].reverse());
    const key = (fs: Array<{ file: string; line: number; class: string; function: string }>) => JSON.stringify(fs.map((f) => [f.file, f.line, f.class, f.function]).sort());
    reproducible = key(analysis.findings) === key(again.findings);
  } catch (e) { failures.push(`analyzer error: ${e instanceof Error ? e.message : String(e)}`); }
  const analyzeMs = +(now() - tAnalyze).toFixed(1);
  if (opts.timeBudgetMs && analyzeMs > opts.timeBudgetMs) failures.push(`analyzer exceeded time budget ${opts.timeBudgetMs} ms (${analyzeMs} ms; not preempted)`);

  const rows: FindingRow[] = (analysis?.findings ?? []).map((f) => ({ class: f.class, contract: f.contract, function: f.function, file: f.file, line: f.line, claim: f.claim }));
  const labelCheck = analysis ? checkLabels(labels, sources, analysis.index as unknown as IndexLike) : { ok: false, checked: 0, problems: ["analysis unavailable"], viaInternalCall: [] as string[] };
  if (!labelCheck.ok) failures.push(`label integrity: ${labelCheck.problems.length} problem(s)`);

  const s = score(capability, rows, labels, sources);
  const extra = classifyExtraFindings(rows, labels);
  const perClass = Object.fromEntries(Object.entries(s.perClass).map(([k, v]) => [k, metrics(v)]));
  const totalMs = +(now() - t0).toFixed(1);

  return {
    runner: RUNNER_VERSION,
    benchmark: { corpus, name: benchmarkMeta?.name ?? corpus, version: benchmarkMeta?.version ?? null, manifest, archivedVersions: archived },
    analyzer: { capability, declaredLimitations: cap.profile?.limitations ?? [], ...gitInfo(opts.repoRoot) },
    exposure: exposureFor(opts.repoRoot, capability, corpus),
    complete: failures.length === 0 && analysis !== null,
    failures,
    timing: { analyzeMs, totalMs },
    labels: { total: labels.length, vulnerable: labels.filter((l) => l.vulnerable).length, secure: labels.filter((l) => !l.vulnerable).length, integrity: labelCheck },
    deterministic: {
      reproducibleAcrossFileOrder: reproducible,
      findings: rows.length,
      overall: metrics(s.total), perClass,
      lineExact: s.total.lineExact, lineWithin2: s.total.lineNear,
      misses: s.misses, falsePositives: s.falsePos,
      collisions: extra.collisions, unscoredFindings: extra.unscored,
    },
    ai: { usedInDeterministicResult: false, adjudication: null as unknown },
    findingsDetail: rows,
  };
}

export type BenchmarkRecord = ReturnType<typeof runBenchmark>;

export function renderText(r: BenchmarkRecord): string {
  const d = r.deterministic; const o = d.overall;
  const out = [
    `## ${r.benchmark.name} v${r.benchmark.version ?? "?"} — ${r.analyzer.capability} @ ${r.analyzer.commit?.slice(0, 12) ?? "unknown"}${r.analyzer.analyzerSourceDirty ? " (analyzer source dirty)" : ""}`,
    `runner ${r.runner}; exposure: ${r.exposure}; complete: ${r.complete}; manifest: ${r.benchmark.manifest.present ? (r.benchmark.manifest.ok ? `OK (${r.benchmark.manifest.files} files, sha256 ${r.benchmark.manifest.manifestSha256?.slice(0, 16)}…)` : "MISMATCH") : "absent"}`,
    `labels: ${r.labels.total} (${r.labels.vulnerable} vulnerable / ${r.labels.secure} secure); label integrity: ${r.labels.integrity.ok ? "OK" : r.labels.integrity.problems.join("; ")}${r.labels.integrity.viaInternalCall.length ? ` (${r.labels.integrity.viaInternalCall.length} label line(s) in an internal callee: ${r.labels.integrity.viaInternalCall.join("; ")})` : ""}`,
    `time: analyze ${r.timing.analyzeMs} ms, total ${r.timing.totalMs} ms; reproducible across file order: ${d.reproducibleAcrossFileOrder}`,
    `OVERALL tp=${o.tp} fp=${o.fp} fn=${o.fn} tn=${o.tn} precision=${o.precision} recall=${o.recall} fpRate=${o.falsePositiveRate}`,
    ...Object.entries(d.perClass).map(([k, v]) => `  ${k.padEnd(22)} tp=${v.tp} fp=${v.fp} fn=${v.fn} tn=${v.tn} precision=${v.precision} recall=${v.recall} fpRate=${v.falsePositiveRate}`),
    `collisions (other detectors firing on labelled functions): ${d.collisions.length}`, ...d.collisions.map((c) => `  ${c.file}:${c.line} ${c.function} [${c.class}]`),
    `unscored findings (unlabelled functions): ${d.unscoredFindings.length}`, ...d.unscoredFindings.map((c) => `  ${c.file}:${c.line} ${c.function} [${c.class}]`),
    ...(d.misses.length ? ["MISSED:", ...d.misses.map((m) => `  ${m}`)] : []),
    ...(d.falsePositives.length ? ["FALSE POSITIVES:", ...d.falsePositives.map((m) => `  ${m}`)] : []),
    ...(r.failures.length ? ["FAILURES:", ...r.failures.map((f) => `  ${f}`)] : []),
    `declared analyzer limitations: ${r.analyzer.declaredLimitations.join("; ") || "none"}`,
  ];
  return out.join("\n");
}
