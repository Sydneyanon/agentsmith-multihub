import { describe, expect, it } from "vitest";
import { ProgramIndex } from "./index.js";
import { callerIdentityCheck, challengeFinding, explicitCheck } from "./challenge.js";
import { challengeOutcome } from "./pipeline.js";
import { validateReentrancy } from "./simulate.js";
import { analyzeSources, type Finding } from "./specialists.js";

/**
 * Foundation C: when a deterministic validator's result is `contradicts` (an executed counterexample in the modelled world), `weakens`
 * (the claimed effect was not observed, nothing executed negates it) or `inconclusive` (the model cannot run the claimed path).
 * Leads are written by hand where the specialists (correctly) would not raise them, so each branch of the validator is exercised.
 */
const FILE = "t.sol";
/** a hand-written lead on `fn`, citing the line that contains `marker` */
function lead(text: string, cls: Finding["class"], contract: string, fn: string, marker: string): { ix: ProgramIndex; f: Finding } {
  const line = text.split("\n").findIndex((l) => l.includes(marker)) + 1; if (line < 1) throw new Error(`marker ${marker} not found`);
  const f = { class: cls, contract, function: fn, file: FILE, line, claim: `${contract}.${fn} test lead`, rationale: "", requiredChecks: [], alternatives: [], spans: [], chain: [], assumptions: [], confidence: "low", detail: {} } as Finding;
  return { ix: new ProgramIndex([{ path: FILE, text }]), f };
}
const challenge = (text: string, cls: Finding["class"], contract: string, fn: string, marker: string) => { const { ix, f } = lead(text, cls, contract, fn, marker); return challengeFinding(ix, f)!; };

describe("refutation kinds", () => {
  it("classifies reverting conditions", () => {
    expect(explicitCheck("require failed: msg.sender == owner")).toBe(true);
    expect(explicitCheck("arithmetic underflow in -")).toBe(false);
    expect(explicitCheck("revert at line 7")).toBe(false);
    expect(callerIdentityCheck("require failed: msg.sender == owner")).toBe(true);
    expect(callerIdentityCheck("require failed: hasRole(ADMIN, _msgSender())")).toBe(true);
    expect(callerIdentityCheck("require failed: authorized[msg.sender]")).toBe(true);
    expect(callerIdentityCheck("require failed: credit[msg.sender] >= 5 ether")).toBe(false); // a balance bound, not an access check
    expect(callerIdentityCheck("require failed: !initialized")).toBe(false);
  });

  it("access-control: a caller check that stops the attacker on the path the deployer completes is an executed counterexample -> contradicts", () => {
    const text = ["contract A {", "  address owner;", "  constructor() { owner = msg.sender; }", "  function setFee(uint f) external {", "    require(msg.sender == owner);", "    fee = f;", "  }", "  uint fee;", "}"].join("\n");
    const o = challenge(text, "access-control", "A", "setFee", "fee = f;");
    expect(o.verdict).toBe("refuted"); expect(o.refutation).toBe("counterexample");
    expect(o.trace.join(" | ")).toMatch(/control: the privileged deployer calls setFee\(\.\.\.\) -> completes and reaches t\.sol:6/);
    expect(o.trace.join(" | ")).toMatch(/attacker calls setFee\(.*\) -> REVERTS: require failed: msg\.sender == owner/);
    expect(o.trace.join(" | ")).toMatch(/modelled world/);
    expect(challengeOutcome(o)).toBe("contradicts");
  });

  it("the bootstrap pattern the specialist raises is contradicted in the modelled world (privileged address is a third party), and says so", () => {
    const r = analyzeSources([{ path: FILE, text: `contract A { address owner; function configure(address o) external { require(owner == address(0) || msg.sender == owner); owner = o; } }` }]);
    const o = challengeFinding(r.index, r.findings.find((x) => x.function === "configure")!)!;
    expect(o.refutation).toBe("counterexample"); expect(challengeOutcome(o)).toBe("contradicts");
    expect(o.trace.join(" ")).toMatch(/privileged address is a third party/);
  });

  it("access-control: a revert at a balance bound is not a counterexample to the access claim -> weakens", () => {
    const text = ["contract A {", "  mapping(address => uint) credit;", "  address sink;", "  function setSink(address s) external {", "    require(credit[msg.sender] >= 5 ether);", "    sink = s;", "  }", "}"].join("\n");
    const o = challenge(text, "access-control", "A", "setSink", "sink = s;");
    expect(o.verdict).toBe("refuted"); expect(o.refutation).toBe("not-observed"); expect(challengeOutcome(o)).toBe("weakens");
  });

  it("initializer: a second initialisation stopped by an explicit check after the legitimate one is a counterexample -> contradicts", () => {
    const text = ["contract A {", "  address owner;", "  bool initialized;", "  function initialize(address o) external {", "    require(!initialized);", "    initialized = true;", "    owner = o;", "  }", "}"].join("\n");
    const o = challenge(text, "initializer", "A", "initialize", "owner = o;");
    expect(o.refutation).toBe("counterexample"); expect(challengeOutcome(o)).toBe("contradicts");
    expect(o.trace.join(" | ")).toMatch(/control: deployer calls initialize\(.*\) -> completes \| attacker calls initialize\(.*\) -> REVERTS: require failed: !initialized/);
  });

  it("unchecked-call: a failure that makes the transaction revert at a check, where success completes, is a counterexample -> contradicts", () => {
    const text = ["contract A {", "  function pay(address to) external payable {", "    (bool ok, ) = to.call{value: msg.value}(\"\");", "    require(ok);", "  }", "}"].join("\n");
    const o = challenge(text, "unchecked-call", "A", "pay", "to.call");
    expect(o.refutation).toBe("counterexample"); expect(challengeOutcome(o)).toBe("contradicts");
    expect(o.trace.join(" | ")).toMatch(/with the call succeeding -> completes .*FAILS \(modelled failure, line 3\).* -> REVERTS: require failed: ok/);
  });

  it("unchecked-call: a revert that happens even when the call succeeds (an access check on the caller) says nothing -> inconclusive", () => {
    const text = ["contract A {", "  address owner;", "  constructor() { owner = msg.sender; }", "  function fwd(address to) external payable {", "    require(msg.sender == owner);", "    to.call{value: msg.value}(\"\");", "  }", "}"].join("\n");
    const o = challenge(text, "unchecked-call", "A", "fwd", "to.call");
    expect(o.verdict).toBe("inconclusive"); expect(o.reason).toMatch(/even when the call succeeds/); expect(challengeOutcome(o)).toBe("inconclusive");
  });

  it("unchecked-call: completing with nothing observable changed is the absence of an observation -> weakens", () => {
    const text = ["contract A {", "  function poke(address to) external {", "    to.call{value: 0}(\"\");", "  }", "}"].join("\n");
    const o = challenge(text, "unchecked-call", "A", "poke", "to.call");
    // it carries a trace (the modelled failure), yet it is NOT a counterexample: nothing executed negates the claim
    expect(o.verdict).toBe("refuted"); expect(o.refutation).toBe("not-observed"); expect(o.trace.length).toBeGreaterThan(0);
    expect(challengeOutcome(o)).toBe("weakens");
  });

  it("reentrancy: 'no exploit in N bounded scenarios' is never a counterexample -> weakens", () => {
    const ix = new ProgramIndex([{ path: FILE, text: `contract R { mapping(address=>uint) b; function w(uint a) external { require(b[msg.sender] >= a); b[msg.sender] -= a; (bool ok,) = msg.sender.call{value: a}(""); require(ok); } }` }]);
    const r = validateReentrancy(ix, ix.findFunction("R", "w", 1)!);
    expect(r.verdict).toBe("refuted"); expect(challengeOutcome(r)).toBe("weakens");
  });
});
