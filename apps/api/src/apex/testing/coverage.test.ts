/**
 * PROTOTYPE test of coverage measurement (docs/architecture/apex-first-capability.md §10.2 item 1). SELF-AUTHORED tiny contracts whose
 * state space is small enough to enumerate exhaustively; the numbers measure the explorer's SEARCH (depth 3, one amount, own address
 * when honest, `true` for every bool) against exhaustive enumeration (amounts {0, 1e18, 2e18}, values {0, 1e18}, bools {false, true},
 * any actor for any address, run to a fixpoint). They are not a measurement of detection quality.
 */
import { describe, expect, it } from "vitest";
import { compareWithExhaustive } from "./exhaustive.js";
import { exploreStateInvariants } from "./state-explorer-prototype.js";

const BASELINE = { strategy: "baseline" } as const;

const src = (text: string) => [{ path: "c.sol", text: `pragma solidity ^0.8.20;\n${text}` }];

// T1: a cycle whose closing step needs 4 transactions (deeper than the explorer's default depth)
const cycle = `contract Cycle { uint256 public n; bool public done;
  function inc() external { require(n < 3, "cap"); n += 1; }
  function reset() external { require(n == 3, "full"); n = 0; done = true; } }`;
// T2: amount-dependent guards (the explorer only ever passes 1e18)
const caps = `contract Caps { mapping(address => uint256) public bal; uint256 public total;
  function put(uint256 a) external {
    require(a > 0, "zero");
    bal[msg.sender] += a; total += a;
    require(bal[msg.sender] <= 2 ether, "cap");
  }
  function take(uint256 a) external { bal[msg.sender] -= a; total -= a; } }`;
// T3: boolean parameters (the explorer only ever passes true)
const keys = `contract Keys { bool public a; bool public b; bool public done;
  function setA(bool v) external { a = v; }
  function setB(bool v) external { require(a, "a"); b = v; }
  function finish() external { if (a && !b) { done = true; } else { revert(); } } }`;

describe("PROTOTYPE APEX coverage measurement (§10.2 item 1)", () => {
  it("the explorer reports what it reached and lists every unexplored region", () => {
    const r = exploreStateInvariants(src(cycle), "Cycle", BASELINE);
    const h = r.coverage.honest;
    expect(h.functionsNeverCompleted).toEqual(["reset"]);
    expect(h.unexplored.filter((u) => /^function reset: never completed \(all \d+ attempts reverted\)$/.test(u))).toHaveLength(1);
    expect(h.unexplored).toContain("guard c.sol:3 (require): failing side never taken");
    expect(h.unexplored).toContain("guard c.sol:4 (require): passing side never taken");
    expect(h.unexplored).toContain("sequences longer than 3 transactions not explored");
    expect(h.guardSummary).toEqual({ total: 2, bothSides: 0, onlyPassed: 1, onlyFailed: 1, neverReached: 0 });
    expect(h.functions.find((f) => f.name === "inc")!.distinctTransitions).toBe(2); // abstractly: n 0 -> + and + -> +
    expect(h.abstractStates).toBe(2); expect(h.distinctStates).toBe(4);
  });

  it("statements never reached and guards never reached are listed", () => {
    const r = exploreStateInvariants(src(`contract G { uint256 public x; bool public open;
      function f(uint256 a) external {
        if (a == 0) {
          x = 7;
        }
        x += 1;
      } }`), "G", BASELINE);
    expect(r.coverage.honest.statements.unreached).toEqual(["c.sol:5"]);
    expect(r.coverage.honest.unexplored).toContain("guard c.sol:4 (if): passing side never taken");
  });

  it("T1 Cycle: a closing step one transaction beyond the depth is missed entirely", () => {
    const g = compareWithExhaustive(src(cycle), "Cycle", { explore: BASELINE });
    expect(g.exhaustive.fixpoint).toBe(true);
    expect(g.gap.explorerOnly).toBe(0);
    expect({ states: [g.explorer.states, g.exhaustive.states], abstract: [g.explorer.abstractStates, g.exhaustive.abstractStates], transitions: [g.explorer.transitions, g.exhaustive.transitions] })
      .toEqual({ states: [4, 8], abstract: [2, 4], transitions: [2, 6] });
    expect(g.gap.functionsNeverCompletedByExplorer).toEqual(["reset"]);
    expect(g.gap.guardSidesMissed).toEqual(["c.sol:3:fails", "c.sol:4:passes"]);
  });

  it("T2 Caps: a single amount never exercises the zero-amount guard and reaches about two thirds of the states", () => {
    const g = compareWithExhaustive(src(caps), "Caps", { explore: BASELINE });
    expect(g.exhaustive.fixpoint).toBe(true);
    expect(g.gap.explorerOnly).toBe(0);
    expect([g.explorer.states, g.exhaustive.states]).toEqual([18, 28]);
    expect([g.explorer.abstractStates, g.exhaustive.abstractStates]).toEqual([9, 9]); // the sign abstraction hides the gap
    expect([g.explorer.transitions, g.exhaustive.transitions]).toEqual([33, 43]);
    expect(g.gap.guardSidesMissed).toEqual(["c.sol:4:fails"]);
  });

  it("T3 Keys: passing only `true` for booleans reaches 5 of 13 states", () => {
    const g = compareWithExhaustive(src(keys), "Keys", { explore: BASELINE });
    expect(g.exhaustive.fixpoint).toBe(true);
    expect(g.gap.explorerOnly).toBe(0);
    expect([g.explorer.states, g.exhaustive.states]).toEqual([5, 13]);
    expect([g.explorer.transitions, g.exhaustive.transitions]).toEqual([9, 42]);
    expect(g.gap.guardSidesMissed).toEqual([]); // every guard side was seen, yet most states were not: guard coverage overstates
  });
});

// These three contracts MOTIVATED the 38-64% baseline figure; the deep strategy's claim rests on the fresh set (fresh-set.test.ts), not on them.
describe("PROTOTYPE APEX coverage, deep strategy (§11 priority 1), on the original tiny contracts", () => {
  it("the unexplored list reflects the deeper search: reset completes, and the zero-amount branch is reached", () => {
    const h = exploreStateInvariants(src(cycle), "Cycle").coverage.honest;
    expect(h.functionsNeverCompleted).toEqual([]);
    expect(h.guardSummary.bothSides).toBe(2);
    const g = exploreStateInvariants(src(`contract G { uint256 public x; bool public open;
      function f(uint256 a) external {
        if (a == 0) {
          x = 7;
        }
        x += 1;
      } }`), "G").coverage.honest;
    expect(g.statements.unreached).toEqual([]);
  });

  it("Cycle 7/8, Caps 28/28, Keys 13/13 of the exhaustive states (baseline 4/8, 18/28, 5/13)", () => {
    const cy = compareWithExhaustive(src(cycle), "Cycle"); const ca = compareWithExhaustive(src(caps), "Caps"); const ke = compareWithExhaustive(src(keys), "Keys");
    expect([cy, ca, ke].map((g) => g.exhaustive.fixpoint)).toEqual([true, true, true]);
    expect([cy, ca, ke].map((g) => [g.gap.stateCoverage * g.exhaustive.states, g.exhaustive.states])).toEqual([[7, 8], [28, 28], [13, 13]]);
    // the missing Cycle state needs 7 transactions (inc x3, reset, inc x3): one more than the deep search's 6 layers
    expect(cy.gap.functionsNeverCompletedByExplorer).toEqual([]);
    // boundary and derived amounts reach states outside the exhaustive domain; they are counted separately, not as coverage
    expect(ca.gap.explorerOnly).toBeGreaterThan(0);
    expect(ke.gap.explorerOnly).toBe(0);
  });
});
