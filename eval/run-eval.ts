/**
 * Evaluation harness. Scores an analyzer against a labelled corpus WITHOUT any knowledge of how the analyzer works.
 * Usage: npx tsx eval/run-eval.ts <corpusDir> <analyzer: structural|baseline> [outPrefix]
 * Unit of scoring: one label = (file, function, class, vulnerable?). A label counts as detected when the analyzer reports a finding with the
 * same file, function and class. Findings in functions that carry no label are counted separately and NOT scored as false positives.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { analyzeSources, type Finding } from "../apps/api/src/analysis/solidity/specialists.js";
import { validateReentrancy } from "../apps/api/src/analysis/solidity/simulate.js";
import { baselineFindings } from "./baseline-prototype/prototype.js";

type Label = { file: string; contract: string; function: string; class: string; vulnerable: boolean; line: number; pair?: string | null; note?: string };
type Row = { class: string; contract: string; function: string; file: string; line: number };

function walk(dir: string, rel = ""): string[] { return readdirSync(join(dir, rel)).flatMap((n) => { const r = rel ? `${rel}/${n}` : n; return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : r.endsWith(".sol") ? [r] : []; }); }

export function loadCorpus(dir: string): { sources: Array<{ path: string; text: string }>; labels: Label[] } {
  const prefix = basename(dir);
  const sources = walk(dir).sort().map((p) => ({ path: `${prefix}/${p}`, text: readFileSync(join(dir, p), "utf8") }));
  const labels = JSON.parse(readFileSync(join(dir, "..", "labels.json"), "utf8")) as Label[];
  return { sources, labels };
}

export function score(name: string, rows: Row[], labels: Label[], sources: Array<{ path: string; text: string }>) {
  const byKey = new Map<string, Row[]>(); for (const r of rows) { const k = `${r.file}|${r.function}|${r.class}`; byKey.set(k, [...(byKey.get(k) ?? []), r]); }
  const lines = new Map(sources.map((s) => [s.path, s.text.split("\n")]));
  const perClass: Record<string, { tp: number; fp: number; fn: number; tn: number; lineExact: number; lineNear: number; spanValid: number }> = {};
  const misses: string[] = []; const falsePos: string[] = []; const detail: unknown[] = [];
  const labelledFns = new Set(labels.map((l) => `${l.file}|${l.function}`));
  for (const l of labels) {
    const c = (perClass[l.class] ??= { tp: 0, fp: 0, fn: 0, tn: 0, lineExact: 0, lineNear: 0, spanValid: 0 });
    const hit = byKey.get(`${l.file}|${l.function}|${l.class}`);
    if (l.vulnerable) {
      if (hit) { c.tp++; if (hit.some((h) => h.line === l.line)) c.lineExact++; if (hit.some((h) => Math.abs(h.line - l.line) <= 2)) c.lineNear++; const ln = lines.get(hit[0]!.file)?.[hit[0]!.line - 1]; if (ln && ln.trim()) c.spanValid++; }
      else { c.fn++; misses.push(`${l.file}:${l.line} ${l.function} (${l.class})`); }
    } else if (hit) { c.fp++; falsePos.push(`${l.file}:${l.line} ${l.function} (${l.class}) flagged at line ${hit[0]!.line}`); } else c.tn++;
    detail.push({ ...l, reported: !!hit, reportedLine: hit?.[0]?.line ?? null });
  }
  const unlabelled = rows.filter((r) => !labelledFns.has(`${r.file}|${r.function}`));
  const total = Object.values(perClass).reduce((a, c) => ({ tp: a.tp + c.tp, fp: a.fp + c.fp, fn: a.fn + c.fn, tn: a.tn + c.tn, lineExact: a.lineExact + c.lineExact, lineNear: a.lineNear + c.lineNear, spanValid: a.spanValid + c.spanValid }), { tp: 0, fp: 0, fn: 0, tn: 0, lineExact: 0, lineNear: 0, spanValid: 0 });
  const pr = (c: { tp: number; fp: number; fn: number }) => ({ precision: c.tp + c.fp ? +(c.tp / (c.tp + c.fp)).toFixed(3) : null, recall: c.tp + c.fn ? +(c.tp / (c.tp + c.fn)).toFixed(3) : null });
  return { name, labels: labels.length, perClass: Object.fromEntries(Object.entries(perClass).map(([k, v]) => [k, { ...v, ...pr(v) }])), total: { ...total, ...pr(total) }, misses, falsePos, unlabelledFindings: unlabelled.length, detail };
}

const hash = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");

export function evaluate(corpus: string, analyzer: string) {
  const { sources, labels } = loadCorpus(corpus);
  if (analyzer === "baseline") { const rows = baselineFindings(sources); return { score: score("baseline-prototype", rows, labels, sources), validation: null, reproducible: hash([...rows].sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line)) === hash(baselineFindings([...sources].reverse()).sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line)), findings: rows.length }; }
  const run = (s: typeof sources) => analyzeSources(s);
  const a = run(sources); const b = run([...sources].reverse());
  const rows: Row[] = a.findings.map((f) => ({ class: f.class, contract: f.contract, function: f.function, file: f.file, line: f.line }));
  const stable = (fs: Finding[]) => fs.map((f) => [f.file, f.line, f.class, f.function, f.claim]);
  const reproducible = hash(stable(a.findings)) === hash(stable(b.findings));
  // independent validation of reentrancy leads by execution
  const validation: Array<{ file: string; function: string; verdict: string; reason: string; labelled: boolean | null }> = [];
  for (const f of a.findings.filter((x) => x.class === "reentrancy")) {
    const fn = a.index.findFunctions(f.contract, f.function)[0]; if (!fn) continue;
    const r = validateReentrancy(a.index, fn); const lab = labels.find((l) => l.file === f.file && l.function === f.function && l.class === "reentrancy");
    validation.push({ file: f.file, function: f.function, verdict: r.verdict, reason: r.reason.slice(0, 160), labelled: lab ? lab.vulnerable : null });
  }
  return { score: score("structural-analyzer", rows, labels, sources), validation, reproducible, findings: rows.length, problems: a.problems };
}

if (process.argv[1] && process.argv[1].endsWith("run-eval.ts")) {
  const [corpus, analyzer = "structural", out] = process.argv.slice(2);
  if (!corpus) { console.error("usage: run-eval.ts <corpus/contracts dir> <structural|baseline> [outPrefix]"); process.exit(2); }
  const r = evaluate(corpus, analyzer);
  const s = r.score;
  const lines = [`## ${s.name} on ${corpus}`, `labels: ${s.labels}; findings: ${r.findings}; reproducible across file order: ${r.reproducible}; findings in unlabelled functions (unscored): ${s.unlabelledFindings}`,
    `TOTAL tp=${s.total.tp} fp=${s.total.fp} fn=${s.total.fn} tn=${s.total.tn} precision=${s.total.precision} recall=${s.total.recall}; key line exact ${s.total.lineExact}/${s.total.tp}, within 2 lines ${s.total.lineNear}/${s.total.tp}`,
    ...Object.entries(s.perClass).map(([k, v]) => `  ${k.padEnd(15)} tp=${v.tp} fp=${v.fp} fn=${v.fn} tn=${v.tn} precision=${v.precision} recall=${v.recall}`),
    ...(s.misses.length ? ["MISSED (false negatives):", ...s.misses.map((m) => "  " + m)] : []), ...(s.falsePos.length ? ["FALSE POSITIVES:", ...s.falsePos.map((m) => "  " + m)] : []),
    ...(r.validation && r.validation.length ? ["REENTRANCY VALIDATION (execution):", ...r.validation.map((v) => `  ${v.file}:${v.function} -> ${v.verdict} (label vulnerable=${v.labelled}) ${v.reason}`)] : [])];
  console.log(lines.join("\n"));
  if (out) { writeFileSync(`${out}.json`, JSON.stringify(r, null, 2)); writeFileSync(`${out}.txt`, lines.join("\n") + "\n"); }
}
