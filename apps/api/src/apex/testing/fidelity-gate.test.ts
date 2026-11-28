/**
 * PROTOTYPE test of the semantic-fidelity gate (docs/architecture/apex-first-capability.md §10.1). SELF-AUTHORED contracts only; they
 * demonstrate the mechanism, not detection quality. Each case injects ONE unsupported feature or ONE approximation into the path of an
 * otherwise-vulnerable contract and requires abstention or suppression, never a hypothesis. The uninjected contracts are checked first,
 * so the absence of a hypothesis is not vacuous. A suppressed counterexample here is, by construction, a TRUE bug withheld by the gate.
 */
import { describe, expect, it } from "vitest";
import { exploreStateInvariants, type ExploreReport } from "./state-explorer-prototype.js";

const HEADER = `pragma solidity ^0.8.20;
interface IOracle { function ping() external; }
contract Child { }
`;
const src = (text: string) => [{ path: "g.sol", text: HEADER + text }];
const lineOf = (text: string, marker: string): number => (HEADER + text).split("\n").findIndex((l) => l.includes(marker)) + 1;

// A: conservation broken by an honest sequence (mint, then burn); the injection goes into burn's path (marked //INJ)
const token = (decls: string, inject: string) => `
contract Token {
  address public owner; uint256 public totalSupply; mapping(address => uint256) public balanceOf; address public sink; address public oracle; address public impl;
  ${decls}
  constructor() { owner = msg.sender; }
  function mint(address to, uint256 amount) external { require(msg.sender == owner, "owner"); balanceOf[to] += amount; totalSupply += amount; }
  function transfer(address to, uint256 amount) external { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; }
  function burn(uint256 amount) external {
    ${inject} //INJ
    balanceOf[msg.sender] -= amount;
  }
}`;
// B: actor value: another actor withdraws a victim's deposit (adversarial); the injection goes into withdrawFor
const vault = (decls: string, inject: string) => `
contract Vault {
  mapping(address => uint256) public balances; uint256 public totalDeposits; address public sink; address public oracle; address public impl;
  ${decls}
  function deposit() external payable { balances[msg.sender] += msg.value; totalDeposits += msg.value; }
  function withdrawFor(address who, uint256 amount) external {
    ${inject} //INJ
    balances[who] -= amount; totalDeposits -= amount;
    (bool ok, ) = payable(msg.sender).call{value: amount}("");
    require(ok, "send");
  }
}`;

const UNSUPPORTED: Array<{ feature: string; decls: string; inject: string }> = [
  { feature: "external-call", decls: "", inject: `(bool s, ) = payable(sink).call{value: 0}(""); require(s);` },
  { feature: "other-contract", decls: "", inject: "IOracle(oracle).ping();" },
  { feature: "other-contract", decls: "", inject: "new Child();" },
  { feature: "block", decls: "", inject: "require(block.timestamp > 0);" },
  { feature: "block", decls: "", inject: "require(block.number > 0);" },
  { feature: "struct", decls: "struct S { uint256 x; } S public s;", inject: "s.x += 1;" },
  { feature: "array", decls: "uint256[] public log;", inject: "log.push(amount);" },
  { feature: "array", decls: "uint256[] public log;", inject: "require(log[0] == 0);" },
  { feature: "hashing", decls: "", inject: "bytes32 h = keccak256(abi.encodePacked(amount));" },
  { feature: "hashing", decls: "", inject: "bytes memory enc = abi.encode(amount);" },
  { feature: "try", decls: "", inject: "try IOracle(oracle).ping() { } catch { }" },
  { feature: "proxy", decls: "", inject: `(bool d, ) = impl.delegatecall(""); require(d);` },
  { feature: "inline-assembly", decls: "", inject: "assembly { let z := 1 }" },
];
const APPROXIMATIONS: Array<{ kind: string; decls: string; inject: string }> = [
  { kind: "loop-cap", decls: "", inject: "for (uint256 i = 0; i < 20; i++) { }" },
  { kind: "narrow-integer", decls: "uint8 public burns;", inject: "burns += 1;" },
  { kind: "narrow-integer", decls: "", inject: "int256 delta = 0;" },
  { kind: "cast", decls: "", inject: "uint256 c = uint128(amount);" },
  { kind: "string-literal", decls: "", inject: `string memory tag = "burn";` },
  { kind: "tx-origin", decls: "", inject: "require(tx.origin != address(0));" },
  { kind: "foreign-balance", decls: "", inject: "require(msg.sender.balance >= 0);" },
];

const noHypothesis = (r: ExploreReport) => { expect(r.hypotheses).toEqual([]); expect(r.violations).toEqual([]); };

describe("PROTOTYPE APEX semantic-fidelity gate (§10.1)", () => {
  it("baseline: the uninjected contracts DO produce a hypothesis (so the cases below are not vacuous)", () => {
    const a = exploreStateInvariants(src(token("", "")), "Token");
    expect(a.hypotheses.map((h) => h.family)).toEqual(["apex-invariant-conservation"]);
    expect(a.hypotheses[0]!.fidelity).toEqual({ fullyModelled: true, approximationsOnPath: 0 });
    expect(a.gate.suppressed.total).toBe(0); expect(a.gate.abstentions).toEqual([]);
    const b = exploreStateInvariants(src(vault("", "")), "Vault");
    expect(b.hypotheses.map((h) => h.family)).toEqual(["apex-invariant-actor-value"]);
  });

  for (const [name, make, contract] of [["Token.burn", token, "Token"], ["Vault.withdrawFor", vault, "Vault"]] as const) {
    for (const u of UNSUPPORTED) it(`unsupported ${u.feature} in ${name} (${u.inject}) -> abstained(${u.feature}@file:line), no hypothesis`, () => {
      const text = make(u.decls, u.inject);
      const r = exploreStateInvariants(src(text), contract);
      noHypothesis(r);
      const at = `g.sol:${lineOf(text, "//INJ")}`;
      expect(r.gate.abstentions.map((a) => `${a.feature}@${a.at}`)).toContain(`${u.feature}@${at}`);
      expect(r.coverage.honest.abstentions).toContain(`abstained(${u.feature}@${at})`);
    });
    for (const a of APPROXIMATIONS) it(`approximation ${a.kind} in ${name} (${a.inject}) -> suppressed(${a.kind}) counted, no hypothesis`, () => {
      const r = exploreStateInvariants(src(make(a.decls, a.inject)), contract);
      noHypothesis(r);
      expect(r.gate.abstentions).toEqual([]);
      // the bug is real in the contract as written; the gate withholds it and says so (counted, not hidden): either its counterexample
      // was suppressed, or (when the approximated function is also the only honest support) the candidate was never trusted at all
      expect(r.gate.withheld.length).toBe(1);
      const w = r.gate.withheld[0]!;
      expect(w.kinds).toContain(a.kind);
      if (w.why === "only-suppressed-counterexamples") expect(r.gate.suppressed.byKind[a.kind as keyof typeof r.gate.suppressed.byKind] ?? 0).toBeGreaterThan(0);
      if (contract === "Token") expect(w.why).toBe("only-suppressed-counterexamples");
      else expect(w.why).toBe("support-only-through-approximations"); // withdrawFor is both the honest support and the breaking step
    });
  }

  it("an approximation on a PREREQUISITE step (mint), not the breaking step, also suppresses the counterexample", () => {
    const text = token("uint8 public mints;", "").replace("totalSupply += amount; }", "totalSupply += amount; mints += 1; }");
    const r = exploreStateInvariants(src(text), "Token");
    noHypothesis(r);
    expect(r.gate.withheld.map((w) => [w.candidate, w.why, w.kinds])).toEqual([["conservation:totalSupply=sum(balanceOf)", "support-only-through-approximations", ["narrow-integer"]]]);
  });

  it("an approximation in deployment taints every sequence: everything is suppressed", () => {
    const text = token(`string public name;`, "").replace("constructor() { owner = msg.sender; }", `constructor() { owner = msg.sender; name = "T"; }`);
    const r = exploreStateInvariants(src(text), "Token");
    noHypothesis(r);
    expect(r.gate.withheld.map((w) => [w.why, w.kinds])).toEqual([["support-only-through-approximations", ["string-literal"]]]);
  });

  it("an unsupported feature in deployment abstains on the whole contract, with the location", () => {
    const text = token("", "").replace("constructor() { owner = msg.sender; }", "constructor() { owner = msg.sender; require(block.timestamp > 0); }");
    const r = exploreStateInvariants(src(text), "Token");
    noHypothesis(r);
    expect(r.abstained).toMatch(/abstained\(block@g\.sol:\d+\)/);
  });

  it("an unsupported feature on a path NOT taken by the counterexample does not block it (that region alone is abstained)", () => {
    // `audit` is never part of the burn counterexample; it is abstained, and the fully modelled mint -> burn sequence still stands
    const text = token("", "").replace("function burn(", "function audit() external { require(block.timestamp > 0); }\n  function burn(");
    const r = exploreStateInvariants(src(text), "Token");
    expect(r.hypotheses.map((h) => h.family)).toEqual(["apex-invariant-conservation"]);
    expect(r.gate.abstentions.map((a) => `${a.function}:${a.feature}`)).toEqual(["audit:block"]);
    expect(r.coverage.honest.functionsNeverCompleted).toContain("audit");
  });

  it("a branch-local approximation suppresses only the sequences that took that branch", () => {
    // burn by the owner casts (approximation); burn by anyone else does not: the clean counterexample (alice) survives
    const text = token("", `if (msg.sender == owner) { uint256 c = uint128(amount); }`);
    const r = exploreStateInvariants(src(text), "Token");
    expect(r.hypotheses).toHaveLength(1);
    expect(r.hypotheses[0]!.rationale.counterexample.at(-1)!.actor).not.toBe("owner0");
    expect(r.gate.suppressed.byKind.cast).toBeGreaterThan(0);
    expect(r.gate.candidatesWithOnlySuppressedCounterexamples).toEqual([]);
  });
});
