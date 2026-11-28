/**
 * PROTOTYPE: integrity and well-formedness of the FRESH set (docs/architecture/apex-first-capability.md §11). It checks the sha256
 * manifest and that every contract parses and deploys under the instrumented interpreter. It runs no search.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRESH_DIR, loadLabels, sourcesOf, verifyManifest } from "./fresh-set.js";
import { Engine } from "./state-explorer-prototype.js";

describe("PROTOTYPE APEX fresh set: integrity", () => {
  it("every file of the set is in the manifest and matches its sha256", () => {
    const m = verifyManifest();
    expect(m.filter((x) => !x.ok)).toEqual([]);
    const files = ["labels.json", ...readdirSync(join(FRESH_DIR, "contracts")).map((f) => `contracts/${f}`)].sort();
    expect(m.map((x) => x.file).sort()).toEqual(files);
  });

  it("the set has the required shape: >= 8 vulnerable with twins, >= 4 controls, >= 3 tiny", () => {
    const L = loadLabels();
    expect(L.vulnerable.length).toBeGreaterThanOrEqual(8);
    expect(L.controls.length).toBeGreaterThanOrEqual(4);
    expect(L.tiny.length).toBeGreaterThanOrEqual(3);
  });

  it("every contract parses and deploys (no search is run)", () => {
    const L = loadLabels();
    const all = [...L.vulnerable.flatMap((v) => [[v.file, v.contract], [v.twin, v.contract]]), ...L.controls.map((c) => [c.file, c.contract]), ...L.tiny.map((t) => [t.file, t.contract])];
    for (const [file, contract] of all) {
      const e = new Engine(sourcesOf(file!), contract!);
      expect({ file, abstained: e.abstained, deployed: e.root !== null, deployApprox: e.root?.approx.length ?? -1 }).toEqual({ file, abstained: null, deployed: true, deployApprox: 0 });
    }
  });
});
