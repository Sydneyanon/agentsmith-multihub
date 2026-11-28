import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Benchmark integrity (T-205). Rules this module enforces mechanically:
 * 1. Original labels are immutable: every labels file and answer key is pinned by hash in eval/LABELS.sha256 (the frozen corpora are
 *    also pinned by their own MANIFEST.sha256). A change is a deliberate, visible manifest change, never a silent one.
 * 2. A disputed label gets an adjudication record (eval/adjudications/*.json) that quotes the original label EXACTLY; a record that
 *    misquotes it is invalid.
 * 3. Only a record with an independent human sign-off changes the adjudicated reading. Pending records are shown as a separate,
 *    provisional reading, marked "not adopted"; they never change a reported score.
 * 4. Every score names its corpus, its labels hash, the adjudication records applied, and the capability's EXPOSURE to that corpus
 *    (tuned, blind, ...) from eval/exposure.json; a capability with no declared exposure is not scored.
 */
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export type Label = { file: string; contract: string; function: string; class: string; vulnerable: boolean; [k: string]: unknown };

/** eval/LABELS.sha256: "sha256  relative/path" lines (relative to eval/). */
export function verifyLabelManifest(evalRoot: string): { ok: boolean; checked: number; problems: string[] } {
  const lines = readFileSync(join(evalRoot, "LABELS.sha256"), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const problems: string[] = [];
  for (const l of lines) {
    const m = /^([a-f0-9]{64})\s+(\S+)$/.exec(l.trim()); if (!m) { problems.push(`bad manifest line: ${l}`); continue; }
    const p = join(evalRoot, m[2]!);
    if (!existsSync(p)) { problems.push(`${m[2]}: missing`); continue; }
    if (sha256(readFileSync(p)) !== m[1]) problems.push(`${m[2]}: changed (labels are immutable; a change needs a visible manifest update and a note in the results)`);
  }
  return { ok: problems.length === 0, checked: lines.length, problems };
}

/** The frozen corpora's own MANIFEST.sha256 files ("sha256  path" relative to the corpus directory). */
export function verifyFrozenManifests(evalRoot: string): { ok: boolean; corpora: string[]; problems: string[] } {
  const corpora = readdirSync(evalRoot).filter((d) => existsSync(join(evalRoot, d, "MANIFEST.sha256"))).sort();
  const problems: string[] = [];
  for (const c of corpora) for (const l of readFileSync(join(evalRoot, c, "MANIFEST.sha256"), "utf8").split("\n").filter(Boolean)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(l.trim()); if (!m) continue;
    const p = join(evalRoot, c, m[2]!);
    if (!existsSync(p) || sha256(readFileSync(p)) !== m[1]) problems.push(`${c}/${m[2]}: does not match the frozen manifest`);
  }
  return { ok: problems.length === 0, corpora, problems };
}

export type SignOff = "pending" | "signed" | "declined";
export type Adjudication = {
  id: string; recordFile: string; recordSha256: string; corpus: string;
  key: string; // contract.function|class
  originalVulnerable: boolean; effect: "overturned" | "upheld" | "other"; proposed: boolean;
  signOff: SignOff; signedBy: string | null; adjudicatorIndependent: boolean | null;
};
type RawRecord = {
  id: string; subject: { corpus: string; contract: string; function: string; class: string };
  originalLabel: Label; outcome: string | { label?: string }; humanSignOff?: string;
  adjudicator?: { kind?: string; humanSignOff?: string; signedBy?: string; independentOfDisputant?: boolean };
  disputedBy?: unknown; evidence?: unknown[];
};

function signOffOf(r: RawRecord): SignOff {
  const s = String(r.humanSignOff ?? r.adjudicator?.humanSignOff ?? "pending").toLowerCase();
  return s.startsWith("signed") ? "signed" : s.startsWith("declined") ? "declined" : "pending";
}
function effectOf(r: RawRecord): { effect: Adjudication["effect"]; proposed: boolean } {
  const text = (typeof r.outcome === "string" ? r.outcome : r.outcome?.label ?? "").toLowerCase();
  const proposed = /proposed/.test(text);
  return { effect: /overturn/.test(text) ? "overturned" : /upheld/.test(text) ? "upheld" : "other", proposed };
}

/** Loads and validates every adjudication record. A record must quote its corpus label exactly and carry evidence. */
export function loadAdjudications(evalRoot: string): { records: Adjudication[]; problems: string[] } {
  const dir = join(evalRoot, "adjudications"); const records: Adjudication[] = []; const problems: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const buf = readFileSync(join(dir, f)); const doc = JSON.parse(buf.toString("utf8")) as { schema?: string; records?: RawRecord[] };
    if (doc.schema !== "agentsmith-adjudication/1" || !Array.isArray(doc.records)) continue; // execution records, not adjudications
    for (const r of doc.records) {
      const where = `${f}#${r.id}`;
      if (!r.id || !r.subject?.corpus || !r.originalLabel) { problems.push(`${where}: missing id, subject or originalLabel`); continue; }
      if (!Array.isArray(r.evidence) || r.evidence.length === 0) problems.push(`${where}: no evidence`);
      if (!r.disputedBy) problems.push(`${where}: no disputing source`);
      const corpusDir = join(evalRoot, r.subject.corpus.replace(/^eval\//, ""));
      const labels = JSON.parse(readFileSync(join(corpusDir, "labels.json"), "utf8")) as Label[];
      const match = labels.find((l) => l.contract === r.subject.contract && l.function === r.subject.function && l.class === r.subject.class);
      if (!match) { problems.push(`${where}: the subject is not a label of ${r.subject.corpus}`); continue; }
      if (JSON.stringify(match) !== JSON.stringify(r.originalLabel)) problems.push(`${where}: originalLabel does not quote the corpus label exactly`);
      const so = signOffOf(r); const { effect, proposed } = effectOf(r);
      if (so === "signed" && (!r.adjudicator?.signedBy || r.adjudicator.independentOfDisputant !== true)) problems.push(`${where}: a signed record needs a named human (adjudicator.signedBy) independent of the disputant (adjudicator.independentOfDisputant: true)`);
      records.push({ id: r.id, recordFile: f, recordSha256: sha256(buf), corpus: r.subject.corpus.replace(/^eval\//, ""), key: `${r.subject.contract}.${r.subject.function}|${r.subject.class}`,
        originalVulnerable: r.originalLabel.vulnerable, effect, proposed, signOff: so, signedBy: r.adjudicator?.signedBy ?? null, adjudicatorIndependent: r.adjudicator?.independentOfDisputant ?? null });
    }
  }
  return { records, problems };
}

export type ExposureStatus = "tuned" | "blind" | "blind-labels" | "seen" | "same-family-authored";
export type Exposure = { capability: string; corpus: string; status: ExposureStatus; evidence: string; trainingExposure: string };
export function exposureFor(evalRoot: string, capability: string, corpus: string): Exposure {
  const doc = JSON.parse(readFileSync(join(evalRoot, "exposure.json"), "utf8")) as { entries: Exposure[] };
  const e = doc.entries.find((x) => x.capability === capability && x.corpus === corpus);
  if (!e) throw new Error(`no declared exposure of ${capability} to ${corpus}: a score without it is not reported (eval/exposure.json)`);
  return e;
}

export type Counts = { tp: number; fp: number; fn: number; tn: number };
export type DualReading = {
  capability: string; corpus: string; exposure: Exposure; labelsSha256: string;
  original: Counts;
  /** only records with an independent human sign-off are applied */
  adjudicated: Counts & { applied: string[] };
  /** pending records applied as if signed: NOT adopted, shown so a reader sees what is at stake */
  provisional: Counts & { pending: string[]; note: string };
  disagreements: Array<{ key: string; label: boolean; flagged: boolean; adjudication: string | null }>;
};

function count(labels: readonly Label[], flagged: ReadonlySet<string>, flip: ReadonlySet<string>): Counts {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const l of labels) {
    const key = `${l.contract}.${l.function}|${l.class}`; const truth = flip.has(key) ? !l.vulnerable : l.vulnerable; const hit = flagged.has(key);
    if (truth) hit ? c.tp++ : c.fn++; else hit ? c.fp++ : c.tn++;
  }
  return c;
}

/** Scores one capability's flagged set against the original labels and the adjudicated readings. */
export function dualReading(evalRoot: string, corpus: string, capability: string, flagged: ReadonlySet<string>): DualReading {
  const exposure = exposureFor(evalRoot, capability, corpus);
  const labelsPath = join(evalRoot, corpus, "labels.json"); const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Label[];
  const { records, problems } = loadAdjudications(evalRoot);
  if (problems.length) throw new Error(`invalid adjudication records: ${problems.join("; ")}`);
  const mine = records.filter((r) => r.corpus === corpus && r.effect === "overturned");
  const signed = mine.filter((r) => r.signOff === "signed"); const pending = mine.filter((r) => r.signOff === "pending");
  return {
    capability, corpus, exposure, labelsSha256: sha256(readFileSync(labelsPath)),
    original: count(labels, flagged, new Set()),
    adjudicated: { ...count(labels, flagged, new Set(signed.map((r) => r.key))), applied: signed.map((r) => `${r.id} (${r.recordFile} ${r.recordSha256.slice(0, 12)})`) },
    provisional: { ...count(labels, flagged, new Set([...signed, ...pending].map((r) => r.key))), pending: pending.map((r) => r.id), note: "pending adjudications applied as if signed: NOT adopted; for transparency only" },
    disagreements: labels.filter((l) => l.vulnerable !== flagged.has(`${l.contract}.${l.function}|${l.class}`)).map((l) => {
      const key = `${l.contract}.${l.function}|${l.class}`; return { key, label: l.vulnerable, flagged: flagged.has(key), adjudication: mine.find((r) => r.key === key)?.id ?? null };
    }),
  };
}
