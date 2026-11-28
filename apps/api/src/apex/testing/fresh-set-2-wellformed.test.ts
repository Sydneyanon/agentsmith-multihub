/**
 * PROTOTYPE: integrity and well-formedness of FRESH SET 2 (docs/architecture/apex-first-capability.md §11.2), frozen with its labels and
 * sha256 manifest before any false-positive rule was implemented. It checks the manifest, the required shape, that every contract parses
 * and deploys, and that every candidate id the deployed engine can generate is labelled on the controls. It runs no search.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRESH_DIR_2, loadLabels, sourcesOf, verifyManifest } from "./fresh-set.js";
import { Engine } from "./state-explorer-prototype.js";

describe("PROTOTYPE APEX fresh set 2: integrity", () => {
  it("every file of the set is in the manifest and matches its sha256", () => {
    const m = verifyManifest(FRESH_DIR_2);
    expect(m.filter((x) => !x.ok)).toEqual([]);
    const files = ["labels.json", ...readdirSync(join(FRESH_DIR_2, "contracts")).map((f) => `contracts/${f}`)].sort();
    expect(m.map((x) => x.file).sort()).toEqual(files);
  });

  it("the set has the required shape: >= 6 vulnerable with twins, >= 6 controls", () => {
    const L = loadLabels(FRESH_DIR_2);
    expect(L.vulnerable.length).toBeGreaterThanOrEqual(6);
    expect(L.vulnerable.every((v) => v.twin && v.twin !== v.file)).toBe(true);
    expect(L.controls.length).toBeGreaterThanOrEqual(6);
  });

  it("every contract parses and deploys, and every static candidate id of a control is labelled (no search is run)", () => {
    const L = loadLabels(FRESH_DIR_2);
    const all = [...L.vulnerable.flatMap((v) => [[v.file, v.contract], [v.twin, v.contract]]), ...L.controls.map((c) => [c.file, c.contract])];
    for (const [file, contract] of all) {
      const e = new Engine(sourcesOf(file!, FRESH_DIR_2), contract!);
      expect({ file, abstained: e.abstained, deployed: e.root !== null, deployApprox: e.root?.approx.length ?? -1 }).toEqual({ file, abstained: null, deployed: true, deployApprox: 0 });
    }
    for (const c of L.controls) {
      const e = new Engine(sourcesOf(c.file, FRESH_DIR_2), c.contract);
      const missing = e.checks.map((k) => k.c.id).filter((id) => !(id in c.truth));
      expect({ contract: c.contract, missing }).toEqual({ contract: c.contract, missing: [] });
    }
  });
});
