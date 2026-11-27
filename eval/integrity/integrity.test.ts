import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { dualReading, exposureFor, loadAdjudications, verifyFrozenManifests, verifyLabelManifest } from "./integrity.js";
import { devReport, renderMarkdown } from "./score-dual.js";

const EVAL = fileURLToPath(new URL("..", import.meta.url));
const temps: string[] = []; afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
/** a throwaway copy of the evaluation records only (labels, manifests, adjudications, exposure) */
function copy(): string {
  const d = mkdtempSync(join(tmpdir(), "eval-integrity-")); temps.push(d);
  for (const f of ["LABELS.sha256", "exposure.json", "adjudications", "dev/labels.json", "heldout/labels.json", "heldout2/labels.json", "heldout3/labels.json", "heldout4/labels.json",
    "dev/specialist-probe/answer-key.json", "dev/specialist-probe/outputs/round2/prior-art-key.json", "dev/specialist-probe/outputs/round2/repro-criteria.json"]) cpSync(join(EVAL, f), join(d, f), { recursive: true });
  return d;
}

describe("T-205: original labels are immutable", () => {
  it("every labels file and answer key matches its pinned hash, and the frozen corpora match their manifests", () => {
    const l = verifyLabelManifest(EVAL); expect(l.problems).toEqual([]); expect(l.checked).toBe(8);
    const f = verifyFrozenManifests(EVAL); expect(f.problems).toEqual([]); expect(f.corpora).toEqual(["heldout", "heldout2", "heldout3", "heldout4"]);
  });
  it("a changed label is detected, never silent", () => {
    const d = copy(); const p = join(d, "dev/labels.json");
    const labels = JSON.parse(readFileSync(p, "utf8")) as Array<{ function: string; vulnerable: boolean }>;
    labels.find((x) => x.function === "transferOwner")!.vulnerable = true; // "fixing" a label in place is exactly what must not happen silently
    writeFileSync(p, JSON.stringify(labels, null, 2));
    expect(verifyLabelManifest(d).problems).toEqual([expect.stringMatching(/^dev\/labels\.json: changed/)]);
  });
});

describe("T-205: disputed labels are adjudicated separately", () => {
  it("every record quotes its label exactly and carries evidence; none is signed yet", () => {
    const { records, problems } = loadAdjudications(EVAL);
    expect(problems).toEqual([]);
    expect(records.map((r) => `${r.id}:${r.effect}:${r.signOff}`).sort()).toEqual([
      "ADJ-DEV-Config-transferOwner:overturned:pending", "ADJ-DEV-Misc-initOnce:overturned:pending",
      "ADJ-H3-EtherShareVault-redeem:upheld:pending", "ADJ-H3-MerchantEscrow-release:upheld:pending"]);
  });
  it("a record that misquotes the original label, or claims a sign-off without a named independent human, is invalid", () => {
    const d = copy(); const p = join(d, "adjudications/dev-access-control.json");
    const doc = JSON.parse(readFileSync(p, "utf8")) as { records: Array<{ originalLabel: { note: string }; humanSignOff: string; adjudicator: Record<string, unknown> }> };
    doc.records[0]!.originalLabel.note = "reworded";
    doc.records[1]!.humanSignOff = "signed"; // but no signedBy and no independence
    writeFileSync(p, JSON.stringify(doc));
    const { problems } = loadAdjudications(d);
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/does not quote the corpus label exactly/), expect.stringMatching(/needs a named human .* independent of the disputant/)]));
    expect(() => dualReading(d, "dev", "claude-hunter@1", new Set())).toThrow(/invalid adjudication records/);
  });
});

describe("T-205: scores report both readings, and exposure", () => {
  it("no exposure declared, no score", () => {
    expect(() => exposureFor(EVAL, "claude-accounting@1", "dev")).toThrow(/no declared exposure/);
    expect(() => dualReading(EVAL, "dev", "unknown-capability@1", new Set())).toThrow(/no declared exposure/);
    expect(exposureFor(EVAL, "solidity-structural-specialists@1", "dev").status).toBe("tuned");
  });
  it("pending overturns never change the reported or adjudicated score; only a signed, independent record does", () => {
    const flagged = new Set(["Config.transferOwner|access-control"]);
    const pending = dualReading(EVAL, "dev", "claude-hunter@1", flagged);
    expect(pending.adjudicated).toMatchObject({ ...pending.original, applied: [] });
    expect(pending.provisional.pending).toEqual(["ADJ-DEV-Config-transferOwner", "ADJ-DEV-Misc-initOnce"]);
    expect(pending.provisional.tp).toBe(pending.original.tp + 1);
    const d = copy(); const p = join(d, "adjudications/dev-access-control.json");
    const doc = JSON.parse(readFileSync(p, "utf8")) as { records: Array<{ humanSignOff: string; adjudicator: Record<string, unknown> }> };
    doc.records[0]!.humanSignOff = "signed"; doc.records[0]!.adjudicator = { ...doc.records[0]!.adjudicator, signedBy: "independent-human-test", independentOfDisputant: true };
    writeFileSync(p, JSON.stringify(doc));
    const signed = dualReading(d, "dev", "claude-hunter@1", flagged);
    expect(signed.adjudicated.applied).toEqual([expect.stringMatching(/^ADJ-DEV-Config-transferOwner/)]);
    expect(signed.adjudicated.tp).toBe(signed.original.tp + 1); expect(signed.original).toEqual(pending.original); // the original reading never moves
  });
  it("the committed dev report is current, names exposure, and keeps the tuned analyzer's perfect score labelled as tuned", () => {
    const r = devReport();
    expect(readFileSync(join(EVAL, "results/dev-dual-reading.md"), "utf8")).toBe(renderMarkdown(r));
    const p13 = r.readings.find((x) => x.capability === "solidity-structural-specialists@1")!;
    expect(p13.exposure.status).toBe("tuned"); expect(p13.original).toEqual({ tp: 17, fp: 0, fn: 0, tn: 14 }); expect(p13.provisional).toMatchObject({ fn: 2 });
    const hunter = r.readings.find((x) => x.capability === "claude-hunter@1")!;
    expect(hunter.original).toMatchObject({ tp: 17, fp: 2 }); expect(hunter.provisional).toMatchObject({ tp: 19, fp: 0 });
  });
});
