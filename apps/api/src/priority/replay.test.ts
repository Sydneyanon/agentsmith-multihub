import { describe, expect, it } from "vitest";
import { BASELINES, compare, replay, type ReplayScenario } from "./replay.js";

/** A frozen SYNTHETIC scenario. Its findings are invented for testing the harness; they are not evidence about any strategy. */
const comp = (id: string, ...versions: Array<[number, string]>) => ({ id, versions: versions.map(([fromDay, hash]) => ({ fromDay, hash })) });
const SCENARIO: ReplayScenario = {
  name: "synthetic-v1", synthetic: true, days: 20, slotsPerDay: 1,
  items: [
    { id: "old-big", publishedDay: 0, deadlineDay: null, maxRewardUsd: 500_000, costUnits: 40, components: [comp("ob.Core", [0, "a1"]), comp("ob.Router", [0, "a2"], [12, "a2b"])] },
    { id: "old-small", publishedDay: 0, deadlineDay: null, maxRewardUsd: 20_000, costUnits: 10, components: [comp("os.Vault", [0, "b1"])] },
    { id: "contest", publishedDay: 3, deadlineDay: 10, maxRewardUsd: 100_000, costUnits: 20, components: [comp("ct.Pool", [3, "c1"]), comp("ct.Oracle", [3, "c2"])] },
    { id: "new-late", publishedDay: 15, deadlineDay: null, maxRewardUsd: 50_000, costUnits: 15, components: [comp("nl.Bridge", [15, "d1"])] },
    { id: "unknown-reward", publishedDay: 1, deadlineDay: null, maxRewardUsd: null, costUnits: 30, components: [comp("ur.Main", [1, "e1"])] },
  ],
  findings: { "ob.Router@a2b": 2, "ct.Pool@c1": 1, "nl.Bridge@d1": 1, "os.Vault@b1": 1 },
};

describe("offline replay harness (T-057), synthetic scenario only", () => {
  it("labels its output synthetic and is reproducible from the seed", () => {
    const a = replay(SCENARIO, "engine-v1", 7); const b = replay(SCENARIO, "engine-v1", 7);
    expect(a).toEqual(b); expect(a.metrics.synthetic).toBe(true);
  });

  it("no strategy except the oracle can see the ground truth: changing the hidden findings never changes their picks", () => {
    const hidden = { ...SCENARIO, findings: { "ur.Main@e1": 9, "ob.Core@a1": 4 } };
    // decisions AND the engine's explained scores must be identical: a leak that only shifts scores is caught too
    for (const k of [...BASELINES, "engine-v1" as const]) expect(replay(hidden, k, 3).picks.map((p) => [p.day, p.itemId, p.mode, p.score])).toEqual(replay(SCENARIO, k, 3).picks.map((p) => [p.day, p.itemId, p.mode, p.score]));
    expect(replay(SCENARIO, "engine-v1", 3).picks.every((p) => typeof p.score === "number")).toBe(true);
  });

  it("reports every metric the backlog requires, for the four simple baselines and the engine", () => {
    const rows = compare(SCENARIO, 1);
    expect(rows.map((r) => r.strategy)).toEqual(["random", "newest-first", "highest-reward-first", "round-robin", "engine-v1"]);
    for (const r of rows) {
      expect(r).toEqual(expect.objectContaining({ confirmedFindings: expect.any(Number), findingsPerCostUnit: expect.any(Number), changedCodeCoverage: expect.any(Number), regret: expect.any(Number) }));
      expect(r.regret).toBeGreaterThanOrEqual(0); // nothing beats the oracle with the same capacity
      expect(r.picks).toBeLessThanOrEqual(SCENARIO.days * SCENARIO.slotsPerDay);
    }
    expect(rows.find((r) => r.strategy === "engine-v1")!.explorationYield).not.toBeNull();
    expect(rows.find((r) => r.strategy === "random")!.explorationYield).toBeNull();
  });

  it("no strategy counts a component version's findings more than once, even when it re-researches the same item", () => {
    const total = Object.values(SCENARIO.findings).reduce((a, b) => a + b, 0);
    for (const k of [...BASELINES, "engine-v1" as const, "oracle" as const]) expect(replay(SCENARIO, k, 4).metrics.confirmedFindings).toBeLessThanOrEqual(total);
    const repeated = replay({ ...SCENARIO, items: [SCENARIO.items[1]!], findings: { "os.Vault@b1": 1 } }, "round-robin");
    expect(repeated.picks.length).toBe(SCENARIO.days); expect(repeated.metrics.confirmedFindings).toBe(1);
  });

  it("the oracle has zero regret, and findings are counted once per component version", () => {
    const o = replay(SCENARIO, "oracle");
    expect(o.metrics.regret).toBe(0);
    expect(o.metrics.confirmedFindings).toBeLessThanOrEqual(Object.values(SCENARIO.findings).reduce((a, b) => a + b, 0));
  });

  it("an expired contest is not selected after its deadline, and nothing is selected before publication", () => {
    for (const k of [...BASELINES, "engine-v1" as const]) for (const p of replay(SCENARIO, k, 2).picks) {
      const item = SCENARIO.items.find((i) => i.id === p.itemId)!;
      expect(p.day).toBeGreaterThanOrEqual(item.publishedDay);
      if (item.deadlineDay !== null) expect(p.day).toBeLessThanOrEqual(item.deadlineDay);
    }
  });

  it("the engine reaches changed code: the router change on day 12 is researched", () => {
    expect(replay(SCENARIO, "engine-v1", 1).metrics.changedCodeCoverage).toBe(1);
  });
});

describe("T-057 diagnosis of synthetic-v1 (docs/priority-engine-diagnosis.md): pinned facts, not a policy change", () => {
  it("cause 1: capacity exceeds new work, so every strategy, the oracle included, spends most picks finding nothing", () => {
    for (const k of [...BASELINES, "engine-v1" as const, "oracle" as const]) expect(replay(SCENARIO, k, 1).picks.filter((p) => p.findings === 0).length).toBeGreaterThanOrEqual(15);
  });
  it("cause 4: policy v1 allocates no exploration slot at one slot per period", () => {
    expect(replay(SCENARIO, "engine-v1", 1).picks.filter((p) => p.mode === "explore")).toHaveLength(0);
  });
  it("cause 2: engine v1 re-researches an opportunity whose current versions are all researched", () => {
    const picks = replay(SCENARIO, "engine-v1", 1).picks.filter((p) => p.itemId === "contest");
    expect(picks.length).toBeGreaterThan(2); expect(picks.filter((p) => p.findings > 0)).toHaveLength(1);
  });
});
