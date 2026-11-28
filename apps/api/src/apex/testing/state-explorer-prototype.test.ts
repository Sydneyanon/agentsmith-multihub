/**
 * PROTOTYPE test (docs/architecture/apex-first-capability.md §8). The contracts below are SELF-AUTHORED controlled examples written for
 * this feasibility check only. They are development data, not a benchmark: nothing here is a measurement of detection quality, and no
 * frozen corpus (eval/**) is read. Expectations were written down before the explorer was first run on them; see the design document
 * for what changed afterwards and why.
 */
import { describe, expect, it } from "vitest";
import { exploreStateInvariants, type ExploreReport } from "./state-explorer-prototype.js";

const src = (text: string) => [{ path: "c.sol", text: `pragma solidity ^0.8.20;\n${text}` }];
const run = (text: string, contract: string): ExploreReport => exploreStateInvariants(src(text), contract, { depth: 3 });
const kinds = (r: ExploreReport) => r.violations.map((v) => `${v.kind}:${v.breakingFunction}`).sort();

// A: conservation (sequence-dependent: the supply must first exist)
const token = (burnBody: string) => `
contract Token {
  address public owner; uint256 public totalSupply; mapping(address => uint256) public balanceOf;
  constructor() { owner = msg.sender; }
  function mint(address to, uint256 amount) external { require(msg.sender == owner, "owner"); balanceOf[to] += amount; totalSupply += amount; }
  function transfer(address to, uint256 amount) external { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; }
  function burn(uint256 amount) external { ${burnBody} }
}`;
// B: value conservation across actors (needs a victim deposit first, then a cross-actor call)
const vault = (check: string) => `
contract Vault {
  mapping(address => uint256) public balances; uint256 public totalDeposits;
  function deposit() external payable { balances[msg.sender] += msg.value; totalDeposits += msg.value; }
  function withdrawFor(address who, uint256 amount) external {
    ${check}
    balances[who] -= amount; totalDeposits -= amount;
    (bool ok, ) = payable(msg.sender).call{value: amount}("");
    require(ok, "send");
  }
}`;
// C: one-way phase flag
const sale = (reopenGuard: string) => `
contract Sale {
  address public owner; bool public closed;
  constructor() { owner = msg.sender; }
  function close() external { require(msg.sender == owner, "owner"); closed = true; }
  function reopen() external { ${reopenGuard} closed = false; }
  function buy() external payable { require(!closed, "closed"); }
}`;
// D: negative control: intentionally asymmetric but correct accounting (fee kept outside the ledger) and an honest two-step flow
const feeVault = `
contract FeeVault {
  mapping(address => uint256) public balances; mapping(address => uint256) public pending; uint256 public totalFees;
  function deposit() external payable { uint256 fee = msg.value / 100; balances[msg.sender] += msg.value - fee; totalFees += fee; }
  function requestWithdraw(uint256 amount) external { balances[msg.sender] -= amount; pending[msg.sender] += amount; }
  function completeWithdraw() external { uint256 a = pending[msg.sender]; pending[msg.sender] = 0; payable(msg.sender).transfer(a); }
}`;

describe("PROTOTYPE apex state explorer over the bounded interpreter", () => {
  it("A vulnerable: burn breaks totalSupply == sum(balanceOf), found as an executed sequence after mint", () => {
    const r = run(token("balanceOf[msg.sender] -= amount;"), "Token");
    expect(r.abstained).toBeNull();
    expect(kinds(r)).toEqual(["conservation:burn"]);
    const v = r.violations[0]!;
    expect(v.sequence.length).toBe(2); // mint first, then burn: a single-function view of burn alone cannot show it from the deployed state
    expect(v.sequence[0]!.call).toMatch(/^mint/);
    const h = r.hypotheses[0]!;
    expect(h.rationale.supportedBy.maintainingTransitions).toBeGreaterThan(0);
    expect(h.independentOfScanners).toBe(true);
  });
  it("A secure: burn that also lowers totalSupply produces no violation", () => {
    expect(kinds(run(token("balanceOf[msg.sender] -= amount; totalSupply -= amount;"), "Token"))).toEqual([]);
  });

  it("B vulnerable: a second actor withdraws a victim's deposit (adversarial phase, two transactions)", () => {
    const r = run(vault(""), "Vault");
    expect(kinds(r)).toEqual(["actor-value:withdrawFor"]);
    const v = r.violations[0]!;
    expect(v.phase).toBe("adversarial");
    expect(v.sequence.map((s) => s.actor)).toEqual(["owner0", "attacker"]);
  });
  it("B secure: withdrawFor restricted to the caller's own account produces no violation", () => {
    expect(kinds(run(vault('require(who == msg.sender, "self");'), "Vault"))).toEqual([]);
  });

  it("C vulnerable: a non-deployer reverses the one-way flag `closed`", () => {
    const r = run(sale(""), "Sale");
    expect(kinds(r)).toEqual(["one-way:reopen"]);
    expect(r.violations[0]!.sequence.length).toBe(2);
  });
  it("C secure: reopen by the deployer only is an administrative action, not a violation", () => {
    expect(kinds(run(sale('require(msg.sender == owner, "owner");'), "Sale"))).toEqual([]);
  });

  it("D negative control: asymmetric fee accounting and an honest two-step withdrawal produce no violation", () => {
    const r = run(feeVault, "FeeVault");
    expect(r.abstained).toBeNull();
    expect(kinds(r)).toEqual([]);
    // the fee-vs-ledger conservation candidate is generated, then dropped by the honest-sequence check instead of being reported
    const c = r.candidates.find((x) => x.id === "conservation:totalFees=sum(balances)");
    expect(c?.established).toBe(false);
  });

  it("E negative control: unrelated counters and an ether sink are not mistaken for ledgers or phase flags", () => {
    // found during development (see the design document §8): before the both-sides support rule and the guard-read rule for phase
    // variables, this contract produced two spurious violations (solvency over a non-ether mapping; a resettable counter as "one-way")
    const r = exploreStateInvariants(src(`contract Big { uint256 public a; uint256 public b; uint256 public c; mapping(address => uint256) public m;
      function f1(uint256 x) external { a += x; } function f2(uint256 x) external { b += x; } function f3(address y) external { m[y] += 1; c++; }
      function f4() external payable {} function f5(address y, uint256 z) external { m[y] = z; } function f6() external { a = 0; } }`), "Big", { depth: 4 });
    expect(kinds(r)).toEqual([]);
    expect(r.coverage.adversarial.budgetExhausted).toBe(false);
    expect(r.coverage.honest.distinctStates).toBeGreaterThan(1000); // state merging keeps this bounded, but growth is exponential in depth
  });

  it("reports what it explored and what it could not model (coverage is part of the output)", () => {
    const r = exploreStateInvariants(src(`contract T { uint256 public t; function f() external { t = block.timestamp; } }`), "T", { depth: 2 });
    const f = r.coverage.honest.functions.find((x) => x.name === "f")!;
    expect(f.completed).toBe(0);
    expect(f.unsupported).toMatch(/block\.timestamp/);
  });
});
