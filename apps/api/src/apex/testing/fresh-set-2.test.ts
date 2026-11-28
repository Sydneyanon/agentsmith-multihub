/**
 * PROTOTYPE measurement of the false-positive rules of docs/architecture/apex-first-capability.md §11.2 (fp-rules.ts, deep-explorer.ts).
 * Fresh set 2 was frozen with its labels and sha256 manifest (1c88343) and the deep strategy recorded on it (d1eedf0) before any rule was
 * committed. The rules were then developed while looking at set 2's results, so set 2 is now development data for them; fresh set 1's
 * false positives motivated them. SELF-AUTHORED by the author of the rules: these numbers show the mechanism, not detection quality on
 * real code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRESH_DIR, FRESH_DIR_2, scoreFreshSet, sourcesOf, type FreshScore } from "./fresh-set.js";
import { exploreStateInvariants } from "./state-explorer-prototype.js";

const recorded = (dir: string, name: string) => JSON.parse(readFileSync(join(__dirname, dir, name), "utf8")) as { totals: FreshScore["totals"]; reclassified: string[] };
let set2: FreshScore | null = null; const set2Default = () => (set2 ??= scoreFreshSet({}, FRESH_DIR_2));
const claims = (s: FreshScore) => [
  ...s.vulnerable.flatMap((v) => v.wrongClaims.map((w) => `${v.id}:${w}`)), ...s.twins.flatMap((t) => t.falsePositives.map((w) => `twin ${t.id}:${w}`)),
  ...s.controls.flatMap((c) => c.falsePositives.map((w) => `${c.contract}:${w}`)),
];

describe("PROTOTYPE APEX false-positive rules (§11.2) on fresh sets 2 and 1", () => {
  it("rules off: fresh set 2 reproduces the measurement recorded before any rule (d1eedf0): recall 4/7, 23 false positives, 9/16", () => {
    const s = scoreFreshSet({ quality: { fpRules: false } }, FRESH_DIR_2);
    expect(s.totals).toEqual(recorded("fresh-set-2-results", "deep-before.json").totals);
    expect(s.reclassified).toEqual([]);
  }, 60_000);

  it("default rules, fresh set 2: recall 6/7 (4/7 before), 7 false positives (23), false-invariant rate 6/13 (9/16)", () => {
    const s = set2Default();
    expect(s.totals).toEqual(recorded("fresh-set-2-results", "deep-fp-rules.json").totals);
    expect(s.reclassified).toEqual(recorded("fresh-set-2-results", "deep-fp-rules.json").reclassified);
    expect(s.totals.falseNegatives).toEqual(["W02 BonusPool"]);
    // what remains: cyclic resets (the one-way family cannot tell a designed reset from a premature one) and an unprivileged donation
    expect(claims(s)).toEqual([
      "twin W04:one-way:stage by finish", "twin W05:one-way:stage by newRound", "twin W05:one-way:tally by newRound",
      "Cycle3:one-way:phase by wrap", "Cycle3:one-way:marks by wrap", "Lap:one-way:lap by clear", "DonationShares:actor-value:attacker-net<=0 by redeem",
    ]);
    expect(s.totals.unlabelled).toEqual([]);
    expect(s.totals.transitions).toBe(168_207); // the rules change no search
  }, 60_000);

  it("default rules, fresh set 1: recall 10/10 unchanged, 1 false positive (9), false-invariant rate 3/14 (5/16)", () => {
    const s = scoreFreshSet({}, FRESH_DIR);
    expect(s.totals).toEqual(recorded("fresh-set-results", "deep-fp-rules.json").totals);
    expect(s.totals.falseNegatives).toEqual([]);
    expect(claims(s)).toEqual(["Seasons:one-way:season by rollover"]);
    expect(s.totals.transitions).toBe(275_995);
  }, 60_000);

  it("a reclassified counterexample is never a violation, a hypothesis or a gate withholding, and cites its evidence", () => {
    for (const [file, contract] of [["v07-rebase-pool.sol", "RebasePool"], ["s06-priced-vault.sol", "PricedVault"], ["v03-treasury.sol", "Treasury"]] as const) {
      const r = exploreStateInvariants(sourcesOf(file, FRESH_DIR_2), contract);
      expect(r.reclassified!.length).toBeGreaterThan(0);
      for (const x of r.reclassified!) {
        expect(r.violations.some((v) => v.candidate === x.candidate && v.breakingFunction === x.breakingFunction && x.rule.startsWith("privileged"))).toBe(false);
        expect(r.gate.withheld.map((w) => w.candidate)).not.toContain(x.candidate);
        expect(x.evidence.length).toBeGreaterThan(0); // the owner-only check and the role's authority evidence
        expect(x.why).toMatch(/requires owner \(check at .*:\d+; owner is fixed-after-deployment\)/);
      }
      expect(r.hypotheses.every((h) => h.fidelity.fullyModelled)).toBe(true);
    }
    // W07: the owner's rebase is reclassified, and the unprivileged full-exit bug is still reported
    const w07 = exploreStateInvariants(sourcesOf("v07-rebase-pool.sol", FRESH_DIR_2), "RebasePool");
    expect(w07.violations.map((v) => `${v.candidate} by ${v.breakingFunction}`)).toEqual(["conservation:totalStaked=sum(stakes) by unstake"]);
    // W03: the residual breaker is reported (withdrawAll books nothing), not the withdrawal that totalWithdrawn accounts for
    const w03 = exploreStateInvariants(sourcesOf("v03-treasury.sol", FRESH_DIR_2), "Treasury");
    expect(w03.violations.map((v) => `${v.candidate} by ${v.breakingFunction}`)).toEqual(["conservation:totalDeposited=sum(balances) by withdrawAll"]);
  }, 60_000);

  it("privilege needs an unobtainable role: when anyone can take the owner role, the owner's rebase is reported, not reclassified", () => {
    const text = readFileSync(join(FRESH_DIR_2, "contracts", "s07-rebase-pool.sol"), "utf8")
      .replace("constructor() { owner = msg.sender; }", "constructor() { owner = msg.sender; }\n  function setOwner(address o) external { owner = o; }");
    const r = exploreStateInvariants([{ path: "open-owner.sol", text }], "RebasePool");
    expect(r.reclassified ?? []).toEqual([]);
    expect(r.violations.map((v) => `${v.candidate} by ${v.breakingFunction}`)).toContain("conservation:totalStaked=sum(stakes) by rebase");
  }, 60_000);

  it("designedCycle stays OFF: it removes the cyclic resets but loses W05, whose stale reset looks like a designed one (recall 5/7)", () => {
    const s = scoreFreshSet({ quality: { fpRules: { designedCycle: true } } }, FRESH_DIR_2);
    expect(s.totals.falseNegatives).toEqual(["W02 BonusPool", "W05 Ballot"]);
    expect(claims(s)).toEqual(["DonationShares:actor-value:attacker-net<=0 by redeem"]);
  }, 60_000);

  it("privilegedFunding's measured trade-off: at 24 000 transitions per search W02 is found with the rules off and reclassified with them on", () => {
    const src = sourcesOf("v02-bonus-pool.sol", FRESH_DIR_2);
    const off = exploreStateInvariants(src, "BonusPool", { maxSequences: 24_000, quality: { fpRules: false } });
    const on = exploreStateInvariants(src, "BonusPool", { maxSequences: 24_000 });
    expect(off.violations.map((v) => `${v.candidate} by ${v.breakingFunction}`)).toEqual(["actor-value:attacker-net<=0 by withdraw"]);
    expect(on.violations).toEqual([]);
    expect(on.reclassified!.map((x) => `${x.candidate} by ${x.breakingFunction} [${x.rule}]`)).toEqual(["actor-value:attacker-net<=0 by withdraw [privilegedFunding]"]);
    // at the default budget the deep search does not reach it at all (frontier dropped), with or without the rule
    expect(set2Default().vulnerable.find((v) => v.id === "W02")!.violations).toEqual([]);
  }, 60_000);
});
