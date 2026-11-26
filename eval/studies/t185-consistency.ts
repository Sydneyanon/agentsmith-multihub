/**
 * T-185 (P3 closeout D3, D4): a STUDY, not a product change. It asks what would happen if the specialists used the shared P3 facts
 * instead of their own rules, on DEVELOPMENT data only (dev, corpora 1-3; the real repository without labels).
 *   D3: the initializer specialist's own one-time rule  vs  P3's writer control (`one-time-initialiser` / `guarded` / `open`).
 *   D4: access-control findings that exist only because of a privileged-looking NAME  vs  P3's name-independent open authority writes.
 * Usage: npx tsx eval/studies/t185-consistency.ts <out.json>.  Corpus 4 is refused: it is spent and must not inform any decision.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSources, type Finding } from "../../apps/api/src/analysis/solidity/specialists.js";
import { buildProtocolModel } from "../../apps/api/src/analysis/solidity/protocol-model.js";
import { loadCorpus, score } from "../run-eval.js";

const INIT_NAME = /^(__\w*_)?(re)?init(iali[sz]e)?\w*$|^setup\w*$/i; // same pattern as specialists.ts
type Row = { class: string; contract: string; function: string; file: string; line: number };
const rowOf = (f: Finding): Row => ({ class: f.class, contract: f.contract, function: f.function, file: f.file, line: f.line });
const nameOf = (id: string) => { const [c, rest] = [id.slice(0, id.indexOf(".")), id.slice(id.indexOf(".") + 1)]; return { contract: c, function: rest.replace(/\(.*$/, "") }; };

function variants(sources: Array<{ path: string; text: string }>) {
  const { findings } = analyzeSources(sources);
  const { model } = buildProtocolModel(sources);
  const current = findings.map(rowOf);
  // P3 writers of authority variables on the callable surface (constructors excluded)
  const writers = model.authority.byComponent.flatMap((c) => c.roles.flatMap((r) => r.writers.filter((w) => w.control !== "constructor").map((w) => ({ ...nameOf(w.fn), control: w.control, variable: r.variable, file: w.at.file, line: w.at.line }))));
  const openWriters = writers.filter((w) => w.control === "open");
  // D3: initializer findings decided by P3 (an init-named function with an OPEN authority write; P3's unset-flag rule decides one-time)
  const p3Init: Row[] = [...new Map(openWriters.filter((w) => INIT_NAME.test(w.function)).map((w) => [`${w.file}|${w.function}`, { class: "initializer", contract: w.contract, function: w.function, file: w.file, line: w.line }])).values()];
  const d3 = [...current.filter((r) => r.class !== "initializer"), ...p3Init];
  // D4a: drop access-control findings whose only basis is the function NAME
  const nameOnly = findings.filter((f) => f.class === "access-control" && /privileged-looking function name/.test(String(f.detail.reason ?? ""))).map(rowOf);
  const nameKey = new Set(nameOnly.map((r) => `${r.file}|${r.function}|${r.line}`));
  const d4a = current.filter((r) => !(r.class === "access-control" && nameKey.has(`${r.file}|${r.function}|${r.line}`)));
  // D4b: D4a plus an access-control finding for every P3 open authority write outside init-named functions that has none yet
  const have = new Set(d4a.filter((r) => r.class === "access-control").map((r) => `${r.file}|${r.function}`));
  const d4b = [...d4a, ...[...new Map(openWriters.filter((w) => !INIT_NAME.test(w.function) && !have.has(`${w.file}|${w.function}`)).map((w) => [`${w.file}|${w.function}`, { class: "access-control", contract: w.contract, function: w.function, file: w.file, line: w.line }])).values()]];
  const specialistInit = current.filter((r) => r.class === "initializer");
  const disagreeD3 = {
    specialistOnly: specialistInit.filter((r) => !p3Init.some((p) => p.file === r.file && p.function === r.function)).map((r) => `${r.contract}.${r.function}`),
    p3Only: p3Init.filter((p) => !specialistInit.some((r) => r.file === p.file && r.function === p.function)).map((r) => `${r.contract}.${r.function}`),
  };
  return { current, d3, d4a, d4b, nameOnly: nameOnly.map((r) => `${r.contract}.${r.function}`), disagreeD3, initWriterControls: writers.filter((w) => INIT_NAME.test(w.function)).map((w) => `${w.contract}.${w.function} ${w.variable}: ${w.control}`) };
}

const walk = (d: string, r = ""): string[] => readdirSync(join(d, r)).flatMap((n) => { const p = r ? `${r}/${n}` : n; return statSync(join(d, p)).isDirectory() ? (n === ".git" ? [] : walk(d, p)) : p.endsWith(".sol") ? [p] : []; });
const out: Record<string, unknown> = { study: "T-185", corpora: "dev, corpus 1-3 (development data); corpus 4 excluded", generated: "deterministic" };
for (const c of ["dev", "heldout", "heldout2", "heldout3"]) {
  const { sources, labels } = loadCorpus(`eval/${c}/contracts`);
  const v = variants(sources);
  const s = (rows: Row[]) => { const r = score(c, rows, labels, sources); const pick = (k: string) => r.perClass[k] ? { tp: r.perClass[k]!.tp, fp: r.perClass[k]!.fp, fn: r.perClass[k]!.fn } : null; return { total: { tp: r.total.tp, fp: r.total.fp, fn: r.total.fn }, initializer: pick("initializer"), accessControl: pick("access-control") }; };
  out[c] = { current: s(v.current), D3_p3_one_time_rule: s(v.d3), D4a_drop_name_only: s(v.d4a), D4b_drop_name_only_plus_p3_open_writers: s(v.d4b), name_only_findings: v.nameOnly, D3_disagreements: v.disagreeD3 };
}
const repo = process.env.T185_REAL_REPO;
if (repo) {
  const sources = walk(repo).sort().map((p) => ({ path: p, text: readFileSync(join(repo, p), "utf8") }));
  const v = variants(sources); const n = (rows: Row[]) => rows.length;
  out["not-so-smart-contracts@020dbdb (no labels)"] = { findings: { current: n(v.current), D3: n(v.d3), D4a: n(v.d4a), D4b: n(v.d4b) }, name_only_findings: v.nameOnly, D3_disagreements: v.disagreeD3 };
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, (k, val) => (k === "name_only_findings" ? (val as string[]).length : val), 1));
