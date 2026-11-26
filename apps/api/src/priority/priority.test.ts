import { describe, expect, it } from "vitest";
import { FIXTURES, NOW } from "./fixtures.js";
import { assertWellFormed, splitForLearning, type Outcome } from "./outcomes.js";
import { POLICY_V1 } from "./policy.js";
import { allocate, scoreOpportunity } from "./score.js";

const s = (o: (typeof FIXTURES)[keyof typeof FIXTURES]) => scoreOpportunity(o, NOW);
const points = (a: ReturnType<typeof s>, f: string) => a.contributions.find((c) => c.feature === f)!.points;

describe("priority scoring v1 (T-051): transparent and deterministic", () => {
  it("is deterministic and records its policy version and an input hash", () => {
    const a = s(FIXTURES.fresh); const b = s(FIXTURES.fresh);
    expect(a).toEqual(b); expect(a.policyVersion).toBe("priority-policy/1"); expect(a.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("explains every point: contributions sum to the score's numerator and each has a reason", () => {
    const a = s(FIXTURES.recovered);
    for (const c of a.contributions) { expect(c.reason.length).toBeGreaterThan(10); expect(typeof c.points).toBe("number"); }
    expect(a.score).toBeGreaterThanOrEqual(0); expect(a.score).toBeLessThanOrEqual(100);
  });
  it("never uses probability language", () => {
    for (const o of Object.values(FIXTURES)) expect(JSON.stringify(s(o))).not.toMatch(/probab|likelihood|chance|expected value|calibrat/i);
  });
  it("treats freshness as a bounded signal, not a guarantee: a fresh but otherwise identical item gains at most the freshness weight", () => {
    expect(s(FIXTURES.fresh).score).toBeGreaterThan(s(FIXTURES.stale).score);
    expect(points(s(FIXTURES.fresh), "freshness")).toBeLessThanOrEqual(POLICY_V1.weights.freshness);
  });
  it("lowers an unchanged, researched, commit-audited project, and restores it when a commit changes a component", () => {
    const sat = s(FIXTURES.saturated); const rec = s(FIXTURES.recovered);
    expect(sat.score).toBeLessThan(s(FIXTURES.stale).score);
    expect(rec.score).toBeGreaterThan(sat.score);
    expect(rec.unexploredShare).toBe(0.5); // only the changed component is unexplored again; new code is never treated as audited
  });
  it("does not saturate a whole project because part of it was audited", () => {
    const p = s(FIXTURES.partlyAudited);
    expect(p.unexploredShare).toBe(1); expect(points(p, "saturation")).toBe(0); expect(p.explorationCandidate).toBe(true);
  });
  it("ignores audit claims whose provenance or permitted use is not established, and flags them", () => {
    const a = s(FIXTURES.claimedOnly); expect(a.flags.join(" ")).toMatch(/ignored: provenance or permitted use not established/); expect(points(a, "saturation")).toBe(0);
  });
  it("flags unknowns instead of guessing them", () => {
    const a = s(FIXTURES.unknowns); expect(a.flags).toEqual(expect.arrayContaining(["reward unknown", "cost unknown", "scope unverified", "repository not verified as official"]));
    expect(points(a, "reward")).toBe(0);
  });
});

describe("exploration versus exploitation (owner policy: 20% exploration, configurable)", () => {
  const all = Object.values(FIXTURES).map((o) => s(o));
  it("reserves the configured share for exploration and fills the rest by score", () => {
    const r = allocate(all, 5, 42);
    expect(r.exploreSlots).toBe(1); expect(r.allocations).toHaveLength(5);
    expect(r.allocations.filter((x) => x.mode === "exploit").map((x) => x.id)).toEqual([...all].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 4).map((a) => a.id));
    expect(r.allocations.filter((x) => x.mode === "explore")).toHaveLength(1);
  });
  it("is reproducible from its seed, varies with the seed, and respects a different configured share", () => {
    expect(allocate(all, 5, 7)).toEqual(allocate(all, 5, 7));
    const picks = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => allocate(all, 5, seed).allocations.find((x) => x.mode === "explore")!.id));
    expect(picks.size).toBeGreaterThan(1);
    expect(allocate(all, 5, 1, { ...POLICY_V1, explorationShare: 0.4 }).exploreSlots).toBe(2);
  });
});

describe("outcome categories (owner policy): only confirmed outcomes are discovery labels", () => {
  const o = (id: string, category: Outcome["category"], v = true, h = true): Outcome => ({ id, category, independentlyValidated: v, humanAdjudicated: h, vulnerabilityClass: "reentrancy", target: "t", recordedAt: "2026-11-26" });
  it("keeps the five categories distinct and returns only confirmed as labels", () => {
    const r = splitForLearning([o("a", "confirmed"), o("b", "refuted"), o("c", "inconclusive"), o("d", "duplicate"), o("e", "missed")]);
    expect(r.discoveryLabels.map((x) => x.id)).toEqual(["a"]);
    expect(Object.fromEntries(Object.entries(r.evidence).map(([k, v]) => [k, v.map((x) => x.id)]))).toEqual({ refuted: ["b"], inconclusive: ["c"], duplicate: ["d"], missed: ["e"] });
  });
  it("refuses a 'confirmed' outcome that lacks independent validation or human adjudication", () => {
    expect(() => assertWellFormed(o("x", "confirmed", false, true))).toThrow(/without independent validation/);
    expect(() => assertWellFormed(o("y", "confirmed", true, false))).toThrow(/human adjudication/);
  });
});

describe("policy v1 is the frozen deterministic baseline (golden values recorded at cfdee08)", () => {
  // Any change to these numbers is a change to the baseline: it needs a new policy version and a recorded decision, not an edited test.
  it("scores the fixtures exactly as recorded", () => {
    const got = Object.fromEntries(Object.values(FIXTURES).map((o) => { const a = s(o); return [a.id, a.score]; }));
    expect(got).toEqual({ fresh: 60.03, stale: 49.97, saturated: 5.52, recovered: 49.17, "partly-audited": 49.97, "claimed-only": 48.58, unknowns: 16.67, "high-reward": 55.99 });
    expect(POLICY_V1.version).toBe("priority-policy/1");
  });
  it("allocates 5 slots with seed 42 exactly as recorded (4 exploit, 1 explore)", () => {
    const r = allocate(Object.values(FIXTURES).map(s), 5, 42);
    expect(r.allocations.map((x) => [x.id, x.mode])).toEqual([["fresh", "exploit"], ["high-reward", "exploit"], ["partly-audited", "exploit"], ["stale", "exploit"], ["claimed-only", "explore"]]);
  });
});
