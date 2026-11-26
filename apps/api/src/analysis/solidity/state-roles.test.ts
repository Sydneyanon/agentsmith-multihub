import { describe, expect, it } from "vitest";
import { ProgramIndex } from "./index.js";
import { buildProtocolModel } from "./protocol-model.js";
import { validateReentrancy } from "./simulate.js";
import { Analyzer } from "./specialists.js";
import { stateVariableRoles, type VariableRoles } from "./state-roles.js";

const rolesOf = (text: string, contract: string) => { const ix = new ProgramIndex([{ path: "r.sol", text }]); const an = new Analyzer(ix); return stateVariableRoles(ix, (f) => an.trace(f), contract); };
const v = (rs: VariableRoles[], name: string) => rs.find((x) => x.variable === name)!;
const has = (x: VariableRoles, role: string, rule: string) => x.roles.find((r) => r.role === role && r.rule === rule);

const BANK = `pragma solidity ^0.8.20;
contract Bank {
  address public owner;
  address public treasury;
  mapping(address => uint256) public balances;
  uint256 public totalDeposits;
  bool private entered;
  uint256 public feeBps;
  address public implementation;
  constructor() { owner = msg.sender; }
  function deposit() external payable { balances[msg.sender] += msg.value; totalDeposits += msg.value; }
  function withdraw(uint256 a) external {
    require(!entered); entered = true;
    require(balances[msg.sender] >= a); balances[msg.sender] -= a; totalDeposits -= a;
    (bool ok, ) = msg.sender.call{value: a}(""); require(ok);
    entered = false;
  }
  function setFee(uint256 f) external { require(msg.sender == owner, "owner"); feeBps = f; }
  function run(bytes calldata d) external { require(msg.sender == owner); (bool ok, ) = implementation.delegatecall(d); require(ok); }
}`;

describe("P2 state-variable roles: every classification cites code and says how strong it is", () => {
  const rs = rolesOf(BANK, "Bank");

  it("ledger: established from the declared type, with the declaration line", () => {
    expect(has(v(rs, "balances"), "ledger", "address-keyed-numeric-mapping")).toMatchObject({ basis: "established", strength: "strong", evidence: [{ file: "r.sol", line: 5 }] });
  });
  it("aggregate: inferred because it is co-updated with the ledger, citing the update lines", () => {
    const t = v(rs, "totalDeposits"); expect(t.status).toBe("classified");
    const r = has(t, "aggregate", "co-updated-with-ledger-in-trace")!; expect(r).toMatchObject({ basis: "inferred", strength: "strong" });
    expect(r.evidence.map((e) => e.line)).toEqual([11, 14]);
  });
  it("authority: strong only when the code checks it against the caller; constructor recording is medium; a name alone is weak", () => {
    const o = v(rs, "owner");
    expect(has(o, "authority", "compared-with-caller")).toMatchObject({ strength: "strong" });
    expect(has(o, "authority", "authorising-guard-read")).toMatchObject({ strength: "strong", evidence: expect.arrayContaining([{ file: "r.sol", line: 18 }]) });
    expect(has(o, "authority", "constructor-records-caller")).toMatchObject({ strength: "medium", evidence: [{ file: "r.sol", line: 10 }] });
    // `treasury` matches the authority NAME pattern but nothing enforces it: weak-only, with an explicit no-guarantee note
    const t = v(rs, "treasury"); expect(t.status).toBe("weak-only");
    expect(t.roles).toEqual([expect.objectContaining({ role: "authority", strength: "weak", rule: "name-pattern", note: expect.stringMatching(/guarantees nothing/) })]);
  });
  it("implementation pointer: established by its use as a delegatecall target (line), not by its name", () => {
    const i = v(rs, "implementation");
    expect(has(i, "implementation_pointer", "delegatecall-target")).toMatchObject({ basis: "established", strength: "strong", evidence: [{ file: "r.sol", line: 19 }] });
    expect(has(i, "implementation_pointer", "pointer-name")).toMatchObject({ strength: "weak" });
  });
  it("lock: a scalar flag checked, set before the call and reset after it, citing all three lines", () => {
    expect(has(v(rs, "entered"), "lock", "checked-set-call-reset")!.evidence.map((e) => e.line)).toEqual([13, 16]);
  });
  it("checks-effects-interactions on a ledger is NOT a lock", () => {
    expect(v(rs, "balances").roles.some((r) => r.role === "lock")).toBe(false);
  });
  it("negative cases: a one-time flag (never reset), a counter bumped before a call, and a timestamp set beside a ledger are NOT locks or aggregates", () => {
    const neg = rolesOf(`pragma solidity ^0.8.20;
contract Neg {
  mapping(address => uint256) public bal; bool public claimedOnce; uint256 public calls; uint256 public lastDeposit;
  function deposit() external payable { bal[msg.sender] += msg.value; lastDeposit = block.timestamp; }
  function claimOnce() external { require(!claimedOnce); claimedOnce = true; (bool ok, ) = msg.sender.call{value: 1}(""); require(ok); }
  function ping() external { require(calls < 10); calls += 1; (bool ok, ) = msg.sender.call(""); require(ok); calls = 0; }
}`, "Neg");
    expect(v(neg, "claimedOnce").roles.some((r) => r.role === "lock")).toBe(false); // set but never reset: a one-time flag
    expect(v(neg, "calls").roles.some((r) => r.role === "lock")).toBe(false);       // bumped with += before the call, not set by assignment
    expect(v(neg, "lastDeposit").roles.some((r) => r.role === "aggregate")).toBe(false); // assigned, not accumulated
  });
  it("a variable no rule explains stays unclassified, with the reason, for later investigation", () => {
    const f = v(rs, "feeBps"); expect(f.status).toBe("unclassified"); expect(f.roles).toEqual([]); expect(f.reason).toMatch(/no rule matched/);
  });
  it("roles of two different kinds at medium strength or above make a variable ambiguous", () => {
    const amb = rolesOf(`pragma solidity ^0.8.20;
contract Odd { address public x; function f(bytes calldata d) external { require(msg.sender == x); (bool ok, ) = x.delegatecall(d); require(ok); } }`, "Odd");
    expect(v(amb, "x").status).toBe("ambiguous");
  });
  it("is deterministic and part of the content-addressed protocol model (protocol-model/2)", () => {
    expect(JSON.stringify(rolesOf(BANK, "Bank"))).toBe(JSON.stringify(rs));
    const a = buildProtocolModel([{ path: "r.sol", text: BANK }]); const b = buildProtocolModel([{ path: "r.sol", text: BANK }]);
    expect(a.sha256).toBe(b.sha256); expect(a.model.schema).toBe("protocol-model/2"); expect(a.model.builder).toBe("solidity-p2/1");
    expect(a.model.stateRoles.byComponent.find((c) => c.component === "Bank")!.variables).toEqual(rs);
  });
});

describe("P2 improves validation: an aggregate updated in a helper is seeded consistently", () => {
  // The ledger update and the total update sit in DIFFERENT function bodies (the total is maintained by helpers). The validator's former
  // same-body rule did not see the total, seeded it at 0, and the honest withdrawal underflowed it: a refutation produced by the model.
  const SPLIT = `pragma solidity ^0.8.20;
contract Split {
  mapping(address => uint256) internal owed;
  uint256 internal outstanding;
  function _addTotal(uint256 a) internal { outstanding += a; }
  function _subTotal(uint256 a) internal { outstanding -= a; }
  function book(address who) external payable { owed[who] += msg.value; _addTotal(msg.value); }
  function claim() external {
    uint256 amt = owed[msg.sender]; require(amt > 0);
    (bool ok, ) = msg.sender.call{value: amt}(""); require(ok);
    owed[msg.sender] = 0; _subTotal(amt);
  }
}`;
  it("the aggregate is found only through the inlined trace (not by the former same-body rule)", () => {
    const o = v(rolesOf(SPLIT, "Split"), "outstanding");
    expect(o.roles.map((r) => r.rule)).toEqual(["co-updated-with-ledger-in-trace"]);
  });
  it("the real drain is now VALIDATED (the former rule produced a false refutation)", () => {
    const ix = new ProgramIndex([{ path: "s.sol", text: SPLIT }]);
    const r = validateReentrancy(ix, ix.findFunctions("Split", "claim")[0]!);
    expect(r.verdict).toBe("validated");
  });
});
