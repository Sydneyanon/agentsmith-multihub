import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProtocolModel } from "../analysis/solidity/protocol-model.js";
import { availability, capabilityById, CAPABILITIES, producers, SLITHER_DETECTOR_CLASS, TRACKED_CLASSES } from "../engine/capabilities.js";
import { NOT_MODELLED_CLASSES } from "../engine/classes.js";
import { POLICY_JSON, POLICY_SHA256 } from "../engine/decisions.js";
import { sha256Hex } from "../research-state.js";
import { componentFeatures, scoreComponent, totalPairs } from "./component.js";
import { allocate } from "./score.js";

const corpus = join(__dirname, "..", "..", "..", "..", "eval", "dev", "contracts");
const model = buildProtocolModel(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, text: readFileSync(join(corpus, n), "utf8") }))).model;
const STRUCT = capabilityById("solidity-structural-specialists"); const SLITHER = capabilityById("slither");
const ONE = [STRUCT]; const TWO = [STRUCT, SLITHER];

describe("component priority (T-052, extending T-051) over capability-class pairs", () => {
  it("is deterministic and explains every point", () => {
    const a = componentFeatures(model, [], ONE).map((f) => scoreComponent(f, totalPairs(ONE)));
    expect(a).toEqual(componentFeatures(model, [], ONE).map((f) => scoreComponent(f, totalPairs(ONE))));
    for (const s of a) {
      expect(s.contributions.map((c) => c.feature)).toEqual(["unexplored", "entry-points", "external-calls", "unguarded-writes", "specialist-surface", "cost"]);
      for (const c of s.contributions) expect(c.reason.length).toBeGreaterThan(10);
      expect(s.score).toBeGreaterThanOrEqual(0); expect(s.score).toBeLessThanOrEqual(100);
      expect(JSON.stringify(s)).not.toMatch(/probab/i);
    }
  });

  it("examined classes drop out at the current hash only (version-aware)", () => {
    const features = componentFeatures(model, [], ONE);
    const top = features.map((f) => scoreComponent(f, totalPairs(ONE))).sort((x, y) => y.score - x.score)[0]!;
    const target = features.find((f) => f.id === top.id)!;
    const examinedAll = (sha: string) => [{ componentSha256: sha, examined: STRUCT.classes.map((cls) => ({ cls, method: STRUCT.id })), abstained: [] }];
    const done = componentFeatures(model, examinedAll(target.contentSha256), ONE).find((f) => f.id === top.id)!;
    expect(done.pendingByCapability).toEqual({}); expect(done.pendingPairs).toBe(0);
    const after = scoreComponent(done, totalPairs(ONE));
    expect(after.score).toBeLessThan(top.score); expect(after.explorationCandidate).toBe(false);
    const stale = componentFeatures(model, examinedAll("0".repeat(64)), ONE).find((f) => f.id === top.id)!;
    expect(scoreComponent(stale, totalPairs(ONE))).toEqual(top);
  });

  it("complementary machines: a class examined by one capability is still pending for another; a failed tool is not retried at the same version", () => {
    const f0 = componentFeatures(model, [], TWO)[0]!;
    const mem = [{ componentSha256: f0.contentSha256, examined: STRUCT.classes.map((cls) => ({ cls, method: STRUCT.id })), abstained: [] }];
    const f1 = componentFeatures(model, mem, TWO).find((f) => f.id === f0.id)!;
    expect(f1.pendingByCapability[STRUCT.id]).toBeUndefined();
    expect(f1.pendingByCapability[SLITHER.id]).toEqual([...SLITHER.classes]); // reentrancy is pending for Slither even though AgentSmith examined it
    const failed = [{ ...mem[0]!, abstained: SLITHER.classes.map((cls) => ({ cls, method: SLITHER.id, version: SLITHER.version })) }];
    expect(componentFeatures(model, failed, TWO).find((f) => f.id === f0.id)!.pendingPairs).toBe(0);
    const olderVersionFailed = [{ ...mem[0]!, abstained: SLITHER.classes.map((cls) => ({ cls, method: SLITHER.id, version: "0.9.0" })) }];
    expect(componentFeatures(model, olderVersionFailed, TWO).find((f) => f.id === f0.id)!.pendingByCapability[SLITHER.id]).toEqual([...SLITHER.classes]);
  });

  it("feeds the existing allocate() unchanged (no second allocation engine)", () => {
    const scored = componentFeatures(model, [], ONE).map((f) => scoreComponent(f, totalPairs(ONE)));
    const r = allocate(scored, 1, 7);
    expect(r.allocations).toHaveLength(1); expect(r.allocations[0]!.mode).toBe("exploit");
  });

  it("the research policy is a fixed, hashed document", () => {
    expect(sha256Hex(POLICY_JSON)).toBe(POLICY_SHA256);
    expect(JSON.parse(POLICY_JSON).version).toBe("research-policy/0");
  });
});

describe("capability declarations (T-201)", () => {
  it("each capability names a step of the one workflow, a pinned identity and its classes; producers and evaluators never share an id", () => {
    const ids = CAPABILITIES.map((c) => c.id); expect(new Set(ids).size).toBe(ids.length);
    for (const c of CAPABILITIES) { expect(c.stepKey).toMatch(/^[a-z_]+$/); expect(c.version).toMatch(/^\d+(\.\d+)*$/); expect(c.classes.length).toBeGreaterThan(0); }
    for (const k of NOT_MODELLED_CLASSES) expect(TRACKED_CLASSES).toContain(k);
    for (const cls of Object.values(SLITHER_DETECTOR_CLASS)) expect(SLITHER.classes).toContain(cls);
  });
  it("availability is a fact about this machine: tools without their pinned binaries are not assignable, and Foundry stays prepared", () => {
    expect(producers({}).map((c) => c.id)).toEqual(["solidity-structural-specialists"]);
    expect(producers({ AGENTSMITH_SLITHER_BIN: "/x/slither" }).map((c) => c.id)).toEqual(["solidity-structural-specialists"]); // solc missing
    expect(producers({ AGENTSMITH_SLITHER_BIN: "/x/slither", AGENTSMITH_SOLC_BIN: "/x/solc" }).map((c) => c.id)).toEqual(["solidity-structural-specialists", "slither"]);
    const forge = availability({ AGENTSMITH_FORGE_BIN: "/x/forge", AGENTSMITH_SOLC_BIN: "/x/solc" }).find((a) => a.capability.id === "foundry-forge")!;
    expect(forge.available).toBe(false); expect(forge.reason).toMatch(/prepared/);
    expect(availability({}).find((a) => a.capability.id === "slither")!.reason).toMatch(/AGENTSMITH_SLITHER_BIN/);
  });
});
