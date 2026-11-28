/**
 * PROTOTYPE test of the invariant-quality rules (docs/architecture/apex-first-capability.md §10.2 item 2). SELF-AUTHORED controls only
 * (`controls.ts`), written by the author of the rules, several to exercise one rule each: the before/after rates below show the rules
 * do what they were built to do, not how they would do on any other code. The costs (true invariants and true bugs the rules reject)
 * are measured and asserted too.
 */
import { describe, expect, it } from "vitest";
import { CONTROLS, measureFalseInvariants } from "./controls.js";
import { exploreStateInvariants, type ExploreOptions } from "./state-explorer-prototype.js";

const src = (text: string) => [{ path: "c.sol", text: `pragma solidity ^0.8.20;\n${text}` }];
const control = (name: string) => CONTROLS.find((c) => c.contract === name)!;
const cand = (name: string, id: string, options: ExploreOptions = {}) => exploreStateInvariants(src(control(name).source), name, options).candidates.find((c) => c.id === id)!;

describe("PROTOTYPE APEX invariant quality (§10.2 item 2)", () => {
  it("every candidate generated on the controls has a ground-truth label", () => {
    expect(measureFalseInvariants({}).unlabelled).toEqual([]);
    expect(measureFalseInvariants({ quality: false }).unlabelled).toEqual([]);
  });

  it("minimum support: a candidate exercised by a single honest transition is not established", () => {
    const c = cand("Seeded", "conservation:totalShares=sum(shares)");
    expect(c.maintaining).toBe(1);
    expect(c.established).toBe(false);
    expect(c.dropReason).toMatch(/only 1 fully modelled honest transition/);
    expect(cand("Seeded", "conservation:totalShares=sum(shares)", { quality: false }).established).toBe(true);
  });

  it("depth artefact: a candidate that holds at depth 3 only because the breaking step needs a 4th transaction is rejected", () => {
    const only = { quality: { randomSequences: 0 } };
    for (const [name, id, fn] of [["Staged", "conservation:totalDeposits=sum(balances)", "distribute"], ["Rounds", "one-way:round", "close"]] as const) {
      const c = cand(name, id, only);
      expect(c.established).toBe(false);
      expect(c.quality.depthExtension).toEqual({ rejected: expect.stringContaining(`honestly broken by ${fn} at depth 4`) });
      expect(cand(name, id, { quality: { randomSequences: 0, depthExtension: false } }).established).toBe(true);
    }
  });

  it("randomised honest sequences (seeded, other amounts, longer) falsify a candidate that held on the accepting search", () => {
    const off = { quality: { depthExtension: false, randomSequences: 0 } };
    expect(cand("GrossVault", "conservation:totalDeposits=sum(balances)", off).established).toBe(true);
    const on = { quality: { depthExtension: false, seed: 7 } };
    const c = cand("GrossVault", "conservation:totalDeposits=sum(balances)", on);
    expect(c.established).toBe(false);
    expect(c.quality.randomised).toMatchObject({ rejected: expect.stringContaining("deposit") });
    // reproducible: the same seed gives the same falsifying sequence
    const again = cand("GrossVault", "conservation:totalDeposits=sum(balances)", on);
    expect(again.quality.randomised).toEqual(c.quality.randomised);
    // a survivor records what it survived
    const s = cand("GrossVault", "solvency:balance>=sum(balances)", on);
    expect(s.quality.randomised).toMatchObject({ sequences: 200, seed: 7, passed: true });
  });

  it("false-invariant rate on the correct-but-asymmetric controls: 5/10 accepted are false without the rules, 1/5 with them", () => {
    const before = measureFalseInvariants({ quality: false });
    const after = measureFalseInvariants({});
    expect({ falseAccepted: before.falseAccepted, trueAccepted: before.trueAccepted, falseGenerated: before.falseGenerated }).toEqual({ falseAccepted: 5, trueAccepted: 5, falseGenerated: 12 });
    expect(before.falsePositiveHypotheses).toEqual(["Seeded.claim: apex-invariant-conservation", "Bonus.distribute: apex-invariant-conservation"]);
    expect({ falseAccepted: after.falseAccepted, trueAccepted: after.trueAccepted }).toEqual({ falseAccepted: 1, trueAccepted: 4 });
    expect(after.falseInvariantRate).toBeCloseTo(0.2);
    // what remains: a designed asymmetry reachable WITHIN the explored depth is indistinguishable from a bug (documented limit)
    expect(after.falseAcceptedIds).toEqual(["Bonus:conservation:totalDeposits=sum(balances)"]);
    expect(after.falsePositiveHypotheses).toEqual(["Bonus.distribute: apex-invariant-conservation"]);
    // the price: a true invariant exercised by exactly one honest transition is rejected by the minimum-support rule
    expect(after.trueRejected).toEqual(["Seeded:one-way:seeded"]);
  });

  it("COST: the depth rule also rejects a TRUE bug whose breaking step needs one more transaction than the depth", () => {
    const deepBurn = `contract DeepToken {
      address public owner; uint256 public totalSupply; mapping(address => uint256) public balanceOf; uint256 public mints;
      constructor() { owner = msg.sender; }
      function mint(address to, uint256 amount) external { require(msg.sender == owner, "owner"); balanceOf[to] += amount; totalSupply += amount; mints += 1; }
      function burn(uint256 amount) external { require(mints >= 3, "early"); balanceOf[msg.sender] -= amount; } }`;
    const r = exploreStateInvariants(src(deepBurn), "DeepToken");
    expect(r.hypotheses).toEqual([]);
    expect(r.candidates.find((c) => c.id === "conservation:totalSupply=sum(balanceOf)")!.dropReason).toMatch(/^depth artefact: .*burn breaks it honestly at depth 4/);
    // the same bug IS reported when the depth reaches it
    expect(exploreStateInvariants(src(deepBurn), "DeepToken", { depth: 4 }).hypotheses.map((h) => h.family)).toEqual(["apex-invariant-conservation"]);
  });

  it("COST: the randomised rule also rejects a TRUE bug that only appears with amounts the breadth-first phase never uses", () => {
    const bigBurn = `contract BigBurn {
      address public owner; uint256 public totalSupply; mapping(address => uint256) public balanceOf;
      constructor() { owner = msg.sender; }
      function mint(address to, uint256 amount) external { require(msg.sender == owner, "owner"); balanceOf[to] += amount; totalSupply += amount; }
      function burn(uint256 amount) external { balanceOf[msg.sender] -= amount; if (amount < 2 ether) { totalSupply -= amount; } } }`;
    const r = exploreStateInvariants(src(bigBurn), "BigBurn");
    expect(r.hypotheses).toEqual([]);
    expect(r.candidates[0]!.dropReason).toMatch(/falsified by a randomised honest sequence: burn breaks it/);
  });
});
