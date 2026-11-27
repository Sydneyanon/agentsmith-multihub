import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProtocolModel } from "../analysis/solidity/protocol-model.js";
import { SPECIALIST_CLASSES } from "../engine/classes.js";
import { POLICY_JSON, POLICY_SHA256 } from "../engine/decisions.js";
import { sha256Hex } from "../research-state.js";
import { componentFeatures, scoreComponent } from "./component.js";
import { allocate } from "./score.js";

const corpus = join(__dirname, "..", "..", "..", "..", "eval", "dev", "contracts");
const model = buildProtocolModel(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, text: readFileSync(join(corpus, n), "utf8") }))).model;

describe("component priority (T-052, extending T-051)", () => {
  it("is deterministic and explains every point", () => {
    const a = componentFeatures(model, [], SPECIALIST_CLASSES).map((f) => scoreComponent(f, SPECIALIST_CLASSES));
    const b = componentFeatures(model, [], SPECIALIST_CLASSES).map((f) => scoreComponent(f, SPECIALIST_CLASSES));
    expect(a).toEqual(b);
    for (const s of a) {
      expect(s.contributions.map((c) => c.feature)).toEqual(["unexplored", "entry-points", "external-calls", "unguarded-writes", "cost"]);
      for (const c of s.contributions) expect(c.reason.length).toBeGreaterThan(10);
      expect(s.score).toBeGreaterThanOrEqual(0); expect(s.score).toBeLessThanOrEqual(100);
      expect(JSON.stringify(s)).not.toMatch(/probab/i);
    }
  });

  it("a component examined for every class at its current hash drops out of exploration and loses its unexplored points; a changed hash restores them", () => {
    const features = componentFeatures(model, [], SPECIALIST_CLASSES);
    const top = features.map((f) => scoreComponent(f, SPECIALIST_CLASSES)).sort((x, y) => y.score - x.score)[0]!;
    const target = features.find((f) => f.id === top.id)!;
    const examined = componentFeatures(model, [{ componentSha256: target.contentSha256, examinedClasses: [...SPECIALIST_CLASSES], notModelledClasses: [] }], SPECIALIST_CLASSES).find((f) => f.id === top.id)!;
    expect(examined.pendingClasses).toEqual([]);
    const after = scoreComponent(examined, SPECIALIST_CLASSES);
    expect(after.score).toBeLessThan(top.score); expect(after.explorationCandidate).toBe(false);
    // coverage recorded against an OLD version of the component does not count (version-aware)
    const stale = componentFeatures(model, [{ componentSha256: "0".repeat(64), examinedClasses: [...SPECIALIST_CLASSES], notModelledClasses: [] }], SPECIALIST_CLASSES).find((f) => f.id === top.id)!;
    expect(scoreComponent(stale, SPECIALIST_CLASSES)).toEqual(top);
  });

  it("feeds the existing allocate() unchanged (no second allocation engine)", () => {
    const scored = componentFeatures(model, [], SPECIALIST_CLASSES).map((f) => scoreComponent(f, SPECIALIST_CLASSES));
    const r = allocate(scored, 1, 7);
    expect(r.allocations).toHaveLength(1); expect(r.allocations[0]!.mode).toBe("exploit");
  });

  it("the research policy is a fixed, hashed document", () => {
    expect(sha256Hex(POLICY_JSON)).toBe(POLICY_SHA256);
    expect(JSON.parse(POLICY_JSON).version).toBe("research-policy/0");
  });
});
