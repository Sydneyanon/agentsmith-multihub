/**
 * PROTOTYPE test of counterexample minimisation (docs/architecture/apex-first-capability.md §10.2 item 4). SELF-AUTHORED contracts and
 * hand-padded sequences: delta-debugging must keep exactly the steps that make the SAME candidate break at the SAME final function for
 * the SAME reason, with no approximation on the path, and it must keep both the original and the minimised sequence.
 */
import { describe, expect, it } from "vitest";
import type { Value } from "../../analysis/solidity/simulate.js";
import { Engine, ETHER, exploreStateInvariants, minimiseCounterexample, type Actor, type Move } from "./state-explorer-prototype.js";

const src = (text: string) => [{ path: "c.sol", text: `pragma solidity ^0.8.20;\n${text}` }];
const mv = (e: Engine, actor: Actor, fn: string, args: Value[] = [], value = 0n): Move => ({ actor, fn: e.fns.find((f) => f.name === fn)!, args, value });
const calls = (ms: Array<{ actor: string; call: string }>) => ms.map((s) => `${s.actor}:${s.call}`);
const CONS = "conservation:totalSupply=sum(balanceOf)";

const token = (extra: string, burnBody: string) => `
contract Token {
  address public owner; uint256 public totalSupply; mapping(address => uint256) public balanceOf; bool public flag;
  constructor() { owner = msg.sender; }
  function mint(address to, uint256 amount) external { require(msg.sender == owner, "owner"); balanceOf[to] += amount; totalSupply += amount; }
  function transfer(address to, uint256 amount) external { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; }
  function setFlag() external { flag = true; }
  ${extra}
  function burn(uint256 amount) external { ${burnBody} }
}`;

describe("PROTOTYPE APEX counterexample minimisation (§10.2 item 4)", () => {
  it("removes irrelevant steps and shrinks arguments, keeping the original", () => {
    const e = new Engine(src(token("", "balanceOf[msg.sender] -= amount;")), "Token");
    const padded = [mv(e, "owner0", "mint", ["alice", ETHER]), mv(e, "alice", "transfer", ["alice", ETHER]), mv(e, "alice", "setFlag"), mv(e, "owner0", "mint", ["owner0", ETHER]), mv(e, "owner0", "burn", [ETHER])];
    const m = minimiseCounterexample(e, CONS, padded)!;
    expect(calls(m.record.original)).toHaveLength(5);
    // one mint to the burner plus the burn is all the violation needs
    expect(calls(m.record.minimised)[0]).toMatch(/^owner0:mint\(owner0, /);
    expect(m.record.minimised).toHaveLength(2);
    expect(calls(m.record.minimised).at(-1)).toBe("owner0:burn(1)");
    expect(m.record.removedSteps).toBe(3);
    expect(m.record.shrunkArguments).toBeGreaterThan(0);
  });

  it("never removes a step whose removal would put an approximation on the path", () => {
    // without setFlag, burn takes the branch with a narrowing cast (an approximation): that sequence would be suppressed, so it is
    // not an acceptable minimisation even though the same invariant still breaks for the same reason
    const e = new Engine(src(token("", "if (flag) { balanceOf[msg.sender] -= amount; } else { uint256 c = uint128(amount); balanceOf[msg.sender] -= amount; }")), "Token");
    const padded = [mv(e, "alice", "setFlag"), mv(e, "owner0", "mint", ["alice", ETHER]), mv(e, "owner0", "mint", ["owner0", ETHER]), mv(e, "owner0", "burn", [ETHER])];
    const m = minimiseCounterexample(e, CONS, padded)!;
    expect(calls(m.record.minimised)[0]).toBe("alice:setFlag()");
    expect(m.record.minimised).toHaveLength(3);
  });

  it("never removes a step whose removal changes the REASON the same invariant breaks", () => {
    // settle() lowers the ledger when the flag is set (totalSupply > sum) and raises it otherwise (totalSupply < sum): removing setFlag
    // still breaks the same invariant at the same function, but for the opposite reason, so it is rejected
    const extra = "function settle() external { if (flag) { balanceOf[msg.sender] -= 1; } else { balanceOf[msg.sender] += 1; } }";
    const e = new Engine(src(token(extra, "")), "Token");
    const padded = [mv(e, "owner0", "mint", ["owner0", ETHER]), mv(e, "alice", "transfer", ["alice", 0n]), mv(e, "alice", "setFlag"), mv(e, "owner0", "settle")];
    const m = minimiseCounterexample(e, CONS, padded)!;
    expect(calls(m.record.minimised)).toEqual(["owner0:mint(owner0, 1)", "alice:setFlag()", "owner0:settle()"]);
    // the shorter sequence the check refused does break the same candidate at settle, for the opposite reason
    const path = e.replay([mv(e, "owner0", "settle")])!;
    const k = e.checks.find((c) => c.c.id === CONS)!;
    expect(e.verdict(k, path[0]!.pre, path[0]!.post, path[0]!.m)).toBe("violate");
    expect(k.reason(path[0]!.pre, path[0]!.post)).toBe("totalSupply < sum(balanceOf)");
  });

  it("refuses to minimise a sequence that is not a fully modelled counterexample to begin with", () => {
    const e = new Engine(src(token("", "uint256 c = uint128(amount); balanceOf[msg.sender] -= amount;")), "Token");
    expect(minimiseCounterexample(e, CONS, [mv(e, "owner0", "mint", ["owner0", ETHER]), mv(e, "owner0", "burn", [ETHER])])).toBeNull();
    const clean = new Engine(src(token("", "balanceOf[msg.sender] -= amount;")), "Token");
    expect(minimiseCounterexample(clean, CONS, [mv(clean, "owner0", "burn", [ETHER])])).toBeNull(); // reverts: not a counterexample
  });

  it("every reported violation carries both its original and its minimised sequence", () => {
    const r = exploreStateInvariants(src(token("", "balanceOf[msg.sender] -= amount;")), "Token");
    const v = r.violations[0]!;
    expect(calls(v.minimisation!.original)).toEqual(calls(v.sequence));
    expect(calls(v.minimisation!.minimised)).toEqual(["owner0:mint(owner0, 1e18)", "owner0:burn(1)"]);
    expect(r.hypotheses[0]!.rationale.minimisedCounterexample).toEqual(v.minimisation!.minimised);
  });
});
