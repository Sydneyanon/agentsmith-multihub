/**
 * PROTOTYPE: the transaction memo (state-explorer-prototype.ts: Engine.memo) is a pure cost reduction. With it on (the default) and off,
 * every report is identical, field for field, except the cost record itself; on the fresh sets most transitions are replayed from the memo
 * (keyed by the slots a transaction read) instead of being re-interpreted. Self-authored contracts: this measures cost, not detection quality.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROLS } from "./controls.js";
import { FRESH_DIR, FRESH_DIR_2, scoreFreshSet, sourcesOf } from "./fresh-set.js";
import { exploreStateInvariants, type ExploreOptions, type ExploreReport } from "./state-explorer-prototype.js";

const withoutCost = (r: ExploreReport) => JSON.parse(JSON.stringify({ ...r, search: r.search ? { ...r.search, cost: undefined } : undefined }, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
const cases: Array<[string, ReturnType<typeof sourcesOf>, string]> = [
  ["set 1 V02", sourcesOf("v02-fee-round.sol"), "FeeRound"], ["set 1 S08", sourcesOf("s08-yield-vault.sol"), "YieldVault"],
  ["set 1 Seasons", sourcesOf("c03-seasons.sol"), "Seasons"], ["set 1 Pass", sourcesOf("t03-pass.sol"), "Pass"],
  ["set 2 W06", sourcesOf("v06-priced-vault.sol", FRESH_DIR_2), "PricedVault"],
  ["control Rounds", [{ path: "c.sol", text: `pragma solidity ^0.8.20;\n${CONTROLS.find((c) => c.contract === "Rounds")!.source}` }], "Rounds"],
];

describe("PROTOTYPE APEX transaction memo: identical reports, lower interpreter cost", () => {
  for (const strategy of ["deep", "baseline"] as const) it(`${strategy}: every report is identical with and without the memo`, () => {
    for (const [name, src, contract] of cases) {
      const on = exploreStateInvariants(src, contract, { strategy } as ExploreOptions); const off = exploreStateInvariants(src, contract, { strategy, memo: false });
      expect({ name, r: withoutCost(on) }).toEqual({ name, r: withoutCost(off) });
      if (strategy === "deep") { expect(off.search!.cost!.interpreted).toBe(off.search!.cost!.requested); expect(on.search!.cost!.requested).toBe(off.search!.cost!.requested); expect(on.search!.cost!.interpreted).toBeLessThan(on.search!.cost!.requested); }
    }
  }, 60_000);

  // the recorded totals were measured before the memo existed (fresh set 1: d32f960; fresh set 2: d1eedf0), so equality is the acceptance test
  it("fresh set 1: every finding as recorded, the search unchanged (275 995 transitions), about 80% fewer transitions interpreted", () => {
    const s = scoreFreshSet({}, FRESH_DIR);
    expect(s.totals).toEqual((JSON.parse(readFileSync(join(__dirname, "fresh-set-results", "after.json"), "utf8")) as { totals: unknown }).totals);
    expect(s.cost).toEqual({ requested: 317_885, interpreted: 64_372 }); // 317 885 before the memo; 197 191 with the exact-world memo
  }, 60_000);

  it("fresh set 2: every finding as recorded before the memo, the search unchanged (168 207 transitions)", () => {
    const s = scoreFreshSet({}, FRESH_DIR_2);
    expect(s.totals).toEqual((JSON.parse(readFileSync(join(__dirname, "fresh-set-2-results", "deep-before.json"), "utf8")) as { totals: unknown }).totals);
    expect(s.cost).toEqual({ requested: 200_675, interpreted: 32_240 });
  }, 60_000);
});
