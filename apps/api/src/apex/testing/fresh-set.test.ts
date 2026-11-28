/**
 * PROTOTYPE measurement on the FRESH set (docs/architecture/apex-first-capability.md §11), frozen with its labels and sha256 manifest before
 * the explorer was changed (commit 2c0e4e9; baseline recorded in 95989c2). SELF-AUTHORED by the author of the change: these numbers show
 * the mechanism on contracts written before the change. They are not detection quality on real code, and recall 10/10 on a set the same
 * author wrote is not a claim that APEX finds such bugs elsewhere.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coverageFreshSet, scoreFreshSet } from "./fresh-set.js";

const recorded = (name: string) => JSON.parse(readFileSync(join(__dirname, "fresh-set-results", name), "utf8")) as { totals: Record<string, unknown> };

describe("PROTOTYPE APEX fresh set 1: baseline vs deep", () => {
  it("the baseline strategy reproduces the baseline recorded before the change", () => {
    const s = scoreFreshSet({ strategy: "baseline" });
    expect(s.totals).toEqual(recorded("baseline.json").totals);
    expect({ recall: s.totals.recall, fp: s.totals.falsePositives, fi: [s.totals.falseAccepted, s.totals.falseAccepted + s.totals.trueAccepted] }).toEqual({ recall: 0.2, fp: 12, fi: [7, 17] });
  });

  it("deep: recall 10/10 (baseline 2/10), false positives 9 (12), false-invariant rate 5/16 (7/17)", () => {
    const s = scoreFreshSet({});
    expect(s.totals).toEqual(recorded("after.json").totals);
    expect(s.totals.falseNegatives).toEqual([]);
    expect({ wrongClaims: s.totals.wrongClaims, twins: s.totals.twinFalsePositives, controls: s.totals.controlFalsePositives }).toEqual({ wrongClaims: 2, twins: 2, controls: 5 });
    expect(s.totals.falseAcceptedIds).toEqual([
      "Rebate:conservation:totalDeposited=sum(balances)", "Rebate:actor-value:attacker-net<=0", "Seasons:one-way:season",
      "YieldShares:conservation:totalAssets=sum(shares)", "YieldShares:actor-value:attacker-net<=0",
    ]);
    expect(s.totals.unlabelled).toEqual([]); // the partition candidates that appeared were labelled before the freeze
    // the price: about 40 times the interpreter transitions of the baseline (6 630)
    expect(s.totals.transitions).toBeGreaterThan(40 * 6_630);
  }, 60_000);

  it("coverage against exhaustive enumeration on the fresh tiny contracts: 9/9, 9/9, 35/38, 7/7 (baseline 6/9, 4/9, 26/38, 4/7)", () => {
    const base = coverageFreshSet({ explore: { strategy: "baseline" } }); const deep = coverageFreshSet({});
    const pair = (c: typeof base) => c.map((x) => [x.contract, Math.round(x.gap.gap.stateCoverage * x.gap.exhaustive.states), x.gap.exhaustive.states]);
    expect(pair(base)).toEqual([["Toggle", 6, 9], ["Thresh", 4, 9], ["Pass", 26, 38], ["Steps", 4, 7]]);
    expect(pair(deep)).toEqual([["Toggle", 9, 9], ["Thresh", 9, 9], ["Pass", 35, 38], ["Steps", 7, 7]]);
    expect(deep.every((x) => x.gap.exhaustive.fixpoint)).toBe(true);
    // states outside the reference domain (boundary and derived amounts) are reported separately, never counted as coverage
    expect(deep.map((x) => x.gap.gap.explorerOnly)).toEqual([0, 160, 201, 10]);
  }, 60_000);
});
