/**
 * PROTOTYPE measurement harness for the FRESH evaluation set (docs/architecture/apex-first-capability.md §11). The set itself
 * (`fresh-set/contracts/*.sol`, `fresh-set/labels.json`) was written and frozen, with a sha256 manifest (`fresh-set/MANIFEST.sha256`),
 * BEFORE any change to the explorer. This file only loads it, checks the manifest, and applies the scoring rules written in
 * `labels.json`. SELF-AUTHORED development data: it measures the mechanism, not detection quality on real code. Not wired anywhere.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareWithExhaustive, type CoverageGap } from "./exhaustive.js";
import { exploreStateInvariants, type ExploreOptions, type ExploreReport } from "./state-explorer-prototype.js";

export const FRESH_DIR = join(dirname(fileURLToPath(import.meta.url)), "fresh-set");
/** fresh set 2 (§11.2): frozen with its labels and manifest before any false-positive rule was implemented */
export const FRESH_DIR_2 = join(dirname(fileURLToPath(import.meta.url)), "fresh-set-2");

type Truth = Record<string, { invariant: boolean; why: string }>;
export type FreshLabels = {
  name: string;
  vulnerable: Array<{ id: string; contract: string; file: string; twin: string; category: string; needs: string; bug: string; accept: { breakers: string[]; families: string[] } }>;
  controls: Array<{ contract: string; file: string; design: string; truth: Truth }>;
  tiny: Array<{ contract: string; file: string; note: string }>;
};

/** every file listed in the manifest, with whether its sha256 still matches */
export function verifyManifest(dir: string = FRESH_DIR): Array<{ file: string; ok: boolean }> {
  const lines = readFileSync(join(dir, "MANIFEST.sha256"), "utf8").split("\n").filter((l) => l.trim());
  return lines.map((l) => {
    const [hash, file] = l.split(/\s+\*?/) as [string, string];
    const actual = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
    return { file, ok: actual === hash };
  });
}
export const loadLabels = (dir: string = FRESH_DIR): FreshLabels => JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as FreshLabels;
export const sourcesOf = (file: string, dir: string = FRESH_DIR) => [{ path: file, text: readFileSync(join(dir, "contracts", file), "utf8") }];

const family = (candidateId: string): string => candidateId.split(":")[0]!;
const transitionsOf = (r: ExploreReport): number => r.coverage.honest.sequences + r.coverage.adversarial.sequences;
const claim = (v: ExploreReport["violations"][number]) => `${v.candidate} by ${v.breakingFunction}`;

export type FreshScore = {
  options: ExploreOptions;
  vulnerable: Array<{ id: string; contract: string; detected: boolean; violations: string[]; wrongClaims: string[]; transitions: number; abstained: string | null }>;
  twins: Array<{ id: string; contract: string; falsePositives: string[]; transitions: number }>;
  controls: Array<{ contract: string; falsePositives: string[]; accepted: string[]; transitions: number }>;
  totals: {
    detected: number; vulnerable: number; recall: number; falseNegatives: string[];
    falsePositives: number; wrongClaims: number; twinFalsePositives: number; controlFalsePositives: number;
    falseAccepted: number; trueAccepted: number; falseInvariantRate: number; falseAcceptedIds: string[]; trueRejected: string[]; unlabelled: string[];
    transitions: number;
  };
  /** interpreter cost of the whole run (deep strategy only): transitions requested by every phase, and how many were actually interpreted */
  cost: { requested: number; interpreted: number };
  /** counterexamples a §11.2 rule reclassified instead of reporting (they count neither as detections nor as false positives) */
  reclassified: string[];
};

export function scoreFreshSet(options: ExploreOptions = {}, dir: string = FRESH_DIR): FreshScore {
  const L = loadLabels(dir);
  const s: FreshScore = { options, vulnerable: [], twins: [], controls: [], totals: { detected: 0, vulnerable: L.vulnerable.length, recall: 0, falseNegatives: [], falsePositives: 0, wrongClaims: 0, twinFalsePositives: 0, controlFalsePositives: 0, falseAccepted: 0, trueAccepted: 0, falseInvariantRate: 0, falseAcceptedIds: [], trueRejected: [], unlabelled: [], transitions: 0 }, cost: { requested: 0, interpreted: 0 }, reclassified: [] };
  const addCost = (r: ExploreReport) => { for (const x of r.reclassified ?? []) s.reclassified.push(`${r.contract}:${x.candidate} by ${x.breakingFunction} [${x.rule}]`); s.cost.requested += r.search?.cost?.requested ?? 0; s.cost.interpreted += r.search?.cost?.interpreted ?? 0; };
  for (const v of L.vulnerable) {
    const r = exploreStateInvariants(sourcesOf(v.file, dir), v.contract, options);
    const ok = (x: ExploreReport["violations"][number]) => v.accept.breakers.includes(x.breakingFunction) && v.accept.families.includes(family(x.candidate));
    const row = { id: v.id, contract: v.contract, detected: r.violations.some(ok), violations: r.violations.map(claim), wrongClaims: r.violations.filter((x) => !ok(x)).map(claim), transitions: transitionsOf(r), abstained: r.abstained };
    s.vulnerable.push(row); s.totals.transitions += row.transitions; addCost(r);
    if (row.detected) s.totals.detected++; else s.totals.falseNegatives.push(`${v.id} ${v.contract}`);
    s.totals.wrongClaims += row.wrongClaims.length;
    const t = exploreStateInvariants(sourcesOf(v.twin, dir), v.contract, options);
    s.twins.push({ id: v.id, contract: v.contract, falsePositives: t.violations.map(claim), transitions: transitionsOf(t) }); addCost(t);
    s.totals.twinFalsePositives += t.violations.length; s.totals.transitions += transitionsOf(t);
  }
  for (const c of L.controls) {
    const r = exploreStateInvariants(sourcesOf(c.file, dir), c.contract, options);
    s.controls.push({ contract: c.contract, falsePositives: r.violations.map(claim), accepted: r.candidates.filter((x) => x.established).map((x) => x.id), transitions: transitionsOf(r) }); addCost(r);
    s.totals.controlFalsePositives += r.violations.length; s.totals.transitions += transitionsOf(r);
    for (const cand of r.candidates) {
      const t = c.truth[cand.id]; if (!t) { s.totals.unlabelled.push(`${c.contract}:${cand.id}`); continue; }
      if (cand.established && t.invariant) s.totals.trueAccepted++;
      if (cand.established && !t.invariant) { s.totals.falseAccepted++; s.totals.falseAcceptedIds.push(`${c.contract}:${cand.id}`); }
      if (!cand.established && t.invariant && cand.maintaining > 0) s.totals.trueRejected.push(`${c.contract}:${cand.id}`);
    }
  }
  s.totals.recall = s.totals.detected / s.totals.vulnerable;
  s.totals.falsePositives = s.totals.wrongClaims + s.totals.twinFalsePositives + s.totals.controlFalsePositives;
  const acc = s.totals.falseAccepted + s.totals.trueAccepted; s.totals.falseInvariantRate = acc ? s.totals.falseAccepted / acc : 0;
  return s;
}

export type FreshCoverage = Array<{ contract: string; gap: CoverageGap }>;
export function coverageFreshSet(options: Parameters<typeof compareWithExhaustive>[2] = {}): FreshCoverage {
  return loadLabels().tiny.map((t) => ({ contract: t.contract, gap: compareWithExhaustive(sourcesOf(t.file), t.contract, options) }));
}
