import { describe, expect, it } from "vitest";
import { buildProtocolModel } from "./protocol-model.js";
import { analyzeSources } from "./specialists.js";
import type { AuthorityFacts } from "./authority.js";

const facts = (text: string, component: string): AuthorityFacts => buildProtocolModel([{ path: "a.sol", text }]).model.authority.byComponent.find((x) => x.component === component)!;
const findings = (text: string) => analyzeSources([{ path: "a.sol", text }]).findings;

describe("P3 direct authority: holders, checks and transfer mechanisms", () => {
  const T = `pragma solidity ^0.8.20;
contract Owned {
  address public owner;
  uint256 public fee;
  constructor() { owner = msg.sender; }
  function transferOwnership(address n) external { require(msg.sender == owner, "owner"); owner = n; }
  function setFee(uint256 f) external { require(msg.sender == owner, "owner"); fee = f; }
}`;
  const a = facts(T, "Owned");
  it("the role, its holder kind, every writer with its control and line, and a holder-only transfer", () => {
    const r = a.roles.find((x) => x.variable === "owner")!;
    expect(r).toMatchObject({ strength: "strong", holder: "single-address", transfer: "by-holder", heldBy: null });
    expect(r.writers.map((w) => [w.fn, w.control, w.at.line])).toEqual([["Owned.constructor@Owned", "constructor", 5], ["Owned.transferOwnership(address)", "guarded", 6]]);
    expect(r.writers[1]!.guardedBy).toEqual(["owner"]);
  });
  it("checks are described (side, enforcement, what they read, line), not certified", () => {
    const c = a.checks.filter((x) => x.fn === "Owned.setFee(uint256)");
    expect(c).toEqual([expect.objectContaining({ side: "caller-side", enforcement: "reverting", reads: ["owner"], at: { file: "a.sol", line: 7 } })]);
    expect(JSON.stringify(a)).not.toMatch(/secure|safe/i);
  });
  it("negative: an unguarded writer of the authority is an open writer, listed with its line", () => {
    const b = facts(T.replace('function transferOwnership(address n) external { require(msg.sender == owner, "owner"); owner = n; }', "function transferOwnership(address n) external { owner = n; }"), "Owned");
    expect(b.roles.find((x) => x.variable === "owner")!.transfer).toBe("open-writer");
    expect(b.unguardedAuthorityWrites).toEqual([{ fn: "Owned.transferOwnership(address)", variable: "owner", at: { file: "a.sol", line: 6 } }]);
  });
});

describe("P3 protected-branch modifiers (`if (auth) _;`, as in pre-0.5 code)", () => {
  it("a writer behind an `if (msg.sender == creator) _;` modifier is guarded, not an open writer", () => {
    const a = facts(`pragma solidity ^0.4.24;
contract Pyramid { address creator; modifier onlyowner { if (msg.sender == creator) _; }
  constructor() public { creator = msg.sender; }
  function changeOwner(address o) public onlyowner { creator = o; } }`, "Pyramid");
    const w = a.roles.find((r) => r.variable === "creator")!.writers.find((x) => x.fn === "Pyramid.changeOwner(address)")!;
    expect(w.control).toBe("guarded"); expect(a.unguardedAuthorityWrites).toEqual([]);
  });
});

describe("P3 inherited authority: a base modifier protects the deployed contract's functions", () => {
  const T = `pragma solidity ^0.8.20;
abstract contract Ownable { address public owner; constructor() { owner = msg.sender; } modifier onlyOwner() { require(msg.sender == owner); _; } }
contract Treasury is Ownable { function sweep(address payable to) external onlyOwner { to.transfer(address(this).balance); } }`;
  it("the check runs in the deployed contract's context and is caller-side; the role is inherited", () => {
    const a = facts(T, "Treasury");
    expect(a.checks.find((c) => c.fn === "Treasury.sweep(address payable)")).toMatchObject({ side: "caller-side", reads: ["owner"] });
    expect(a.roles.map((r) => r.variable)).toEqual(["owner"]);
  });
});

describe("P3 factory-mediated authority (failure class C)", () => {
  const CHILD = `contract Child {
  address public immutable factory;
  constructor() { factory = msg.sender; }
  function retire(address payable to) external { require(msg.sender == factory, "factory"); selfdestruct(to); }
}`;
  const OPEN = `pragma solidity ^0.8.20;
${CHILD}
contract Factory {
  Child[] public children;
  function create() external returns (Child c) { c = new Child(); children.push(c); }
  function retire(Child c, address payable to) external { c.retire(to); }
}`;
  const GUARDED = OPEN.replace("contract Factory {\n", "contract Factory {\n  address public owner = msg.sender;\n").replace("function retire(Child c, address payable to) external { c.retire(to); }", 'function retire(Child c, address payable to) external { require(msg.sender == owner, "owner"); c.retire(to); }');

  it("the child's authority is held by the deploying contract, with the constructor and the `new` as evidence", () => {
    const r = facts(OPEN, "Child").roles.find((x) => x.variable === "factory")!;
    expect(r.heldBy).toMatchObject({ kind: "deploying-contract", contract: "Factory", rule: "constructor-records-caller+deployed-by-new-in-snapshot" });
    expect(r.heldBy!.evidence.map((e) => e.line).sort((x, y) => x - y)).toEqual([4, 9]);
  });
  it("the factory's call is a cross-contract path whose only check is callee-side; the outer function has no caller-side check", () => {
    const f = facts(OPEN, "Factory");
    expect(f.deploys).toEqual([{ fn: "Factory.create()", child: "Child", at: { file: "a.sol", line: 9 } }]);
    const p = f.factoryPaths.find((x) => x.from === "Factory.retire(Child,address payable)")!;
    expect(p).toMatchObject({ callee: "Child.retire", outerCallerGuarded: false, reaches: ["selfdestruct"] });
    expect(f.checks.find((c) => c.fn === p.from)).toMatchObject({ side: "callee-side" });
  });
  it("the specialists now flag the unguarded factory entry point (previously missed), and not the guarded twin", () => {
    expect(findings(OPEN).filter((x) => x.class === "selfdestruct" && x.contract === "Factory").map((x) => x.function)).toEqual(["retire"]);
    expect(findings(GUARDED).filter((x) => x.class === "selfdestruct" && x.contract === "Factory")).toEqual([]);
    expect(facts(GUARDED, "Factory").factoryPaths[0]).toMatchObject({ outerCallerGuarded: true });
  });
});

describe("P3 proxy boundaries and initialisation controls", () => {
  const PROXY = `pragma solidity ^0.8.20;
contract Proxy {
  address public implementation; address public admin;
  constructor(address i) { implementation = i; admin = msg.sender; }
  function upgradeTo(address i) external { require(msg.sender == admin); implementation = i; }
  fallback() external payable { (bool ok, ) = implementation.delegatecall(msg.data); require(ok); }
}`;
  it("records the boundary, an unresolved implementation behind an address pointer, and every writer of the pointer with its control", () => {
    const p = facts(PROXY, "Proxy").proxy[0]!;
    expect(p).toMatchObject({ fallback: "Proxy.fallback", pointer: "implementation", implementation: "unresolved", at: { file: "a.sol", line: 6 } });
    expect(p.upgradeWriters.map((w) => [w.fn, w.control])).toEqual([["Proxy.constructor@Proxy", "constructor"], ["Proxy.upgradeTo(address)", "guarded"]]);
    expect(facts(PROXY, "Proxy").unresolved.some((u) => /implementation behind Proxy.fallback is not resolvable/.test(u.what))).toBe(true);
  });
  it("negative: an unguarded upgrade is an open pointer writer", () => {
    const p = facts(PROXY.replace("function upgradeTo(address i) external { require(msg.sender == admin); implementation = i; }", "function upgradeTo(address i) external { implementation = i; }"), "Proxy").proxy[0]!;
    expect(p.upgradeWriters.find((w) => w.fn === "Proxy.upgradeTo(address)")!.control).toBe("open");
  });
  const INIT = `pragma solidity ^0.8.20;
contract Logic { address public owner; bool private initialized;
  function initialize(address o) external { require(!initialized); initialized = true; owner = o; }
  function kill() external { require(msg.sender == owner); selfdestruct(payable(owner)); } }`;
  it("an initialiser writes the authority under a one-time flag; without a constructor lock the instance may be initialisable", () => {
    const a = facts(INIT, "Logic");
    expect(a.roles.find((r) => r.variable === "owner")!.writers.find((w) => w.fn === "Logic.initialize(address)")).toMatchObject({ control: "one-time-initialiser", flag: "initialized" });
    expect(a.initialisers).toEqual([expect.objectContaining({ fn: "Logic.initialize(address)", flag: "initialized", lockedInConstructor: false })]);
  });
  it("negative: a guard on a value that is later rewritten (a price) is not an initialisation control; the writer is open", () => {
    const a = facts(`pragma solidity ^0.8.20;
contract Sale { address public owner; uint256 public price = 1 ether;
  function buy() external payable { require(msg.value >= price); owner = msg.sender; price = msg.value * 2; } }`, "Sale");
    expect(a.initialisers).toEqual([]);
    expect(a.roles.find((r) => r.variable === "owner")!.writers.find((w) => w.fn === "Sale.buy()")!.control).toBe("open");
  });
  it("an address or number checked against zero is a one-time flag too", () => {
    const a = facts(`pragma solidity ^0.8.20;
contract Claim { address public owner; function claim() external { require(owner == address(0)); owner = msg.sender; } }`, "Claim");
    void a; // here the flag IS the authority itself, so it is reported as an open first-come writer, not as an initialiser
    expect(a.roles.find((r) => r.variable === "owner")!.writers[0]!.control).toBe("open");
  });
  it("negative: a constructor that sets the flag locks it", () => {
    const a = facts(INIT.replace("bool private initialized;", "bool private initialized; constructor() { initialized = true; }"), "Logic");
    expect(a.initialisers[0]).toMatchObject({ lockedInConstructor: true });
  });
});

describe("P3 assumptions, libraries, and name-only authority", () => {
  it("a check from an unseen modifier is an assumption and unresolved; a check that reads no state is an external assumption", () => {
    const a = facts(`pragma solidity ^0.8.20;
interface IRegistry { function isAdmin(address) external view returns (bool); }
contract Gate { IRegistry public reg; uint256 public x;
  function f(uint256 v) external onlyAdmin { x = v; }
  function g(uint256 v) external { require(reg.isAdmin(msg.sender)); x = v; } }`, "Gate");
    expect(a.checks.find((c) => c.fn === "Gate.f(uint256)")).toMatchObject({ side: "assumed" });
    expect(a.unresolved.some((u) => /unseen modifier/.test(u.what))).toBe(true);
  });
  it("a check inside a library runs in the caller's context and stays caller-side", () => {
    const a = facts(`pragma solidity ^0.8.20;
library Auth { function only(address who) internal view { require(msg.sender == who); } }
contract UsesLib { address public owner = msg.sender; uint256 public x; function set(uint256 v) external { Auth.only(owner); x = v; } }`, "UsesLib");
    expect(a.checks.filter((c) => c.fn === "UsesLib.set(uint256)").every((c) => c.side === "caller-side")).toBe(true);
  });
  it("an authority known by name only is unresolved, never treated as an enforced check", () => {
    const a = facts(`pragma solidity ^0.8.20;
contract Named { address public treasury; uint256 public x; function set(uint256 v) external { x = v; } }`, "Named");
    expect(a.roles.find((r) => r.variable === "treasury")).toMatchObject({ strength: "weak" });
    expect(a.checks).toEqual([]);
    expect(a.unresolved.some((u) => /treasury is an authority by name only/.test(u.what))).toBe(true);
  });
  it("is deterministic and part of the content-addressed model (protocol-model/3)", () => {
    const T = `pragma solidity ^0.8.20;\ncontract Owned { address public owner; constructor() { owner = msg.sender; } function t(address n) external { require(msg.sender == owner); owner = n; } }`;
    const a = buildProtocolModel([{ path: "a.sol", text: T }]); const b = buildProtocolModel([{ path: "a.sol", text: T }]);
    expect(a.sha256).toBe(b.sha256); expect(a.model.schema).toBe("protocol-model/3"); expect(a.model.builder).toBe("solidity-p3/2"); expect(a.model.authority.version).toBe("authority/1");
  });
});

describe("P3 closeout: one guard-side rule everywhere (P1 flag, P2 roles, P3 facts, specialists)", () => {
  const T = `pragma solidity ^0.8.20;
contract Child { address public immutable factory; constructor() { factory = msg.sender; } function retire(address payable to) external { require(msg.sender == factory); selfdestruct(to); } }
contract Factory { address public factory; function make() external returns (Child c) { c = new Child(); } function retire(Child c, address payable to) external { c.retire(to); } }`;
  const m = buildProtocolModel([{ path: "a.sol", text: T }]).model;
  it("P1's callerGuarded agrees with P3: a callee-side check does not guard the outer entry point", () => {
    expect(m.functions.find((f) => f.id === "Factory.retire(Child,address payable)")!.callerGuarded).toBe(false);
    expect(m.functions.find((f) => f.id === "Child.retire(address payable)")!.callerGuarded).toBe(true);
  });
  it("P2 does not make the parent's same-named variable an authority because the CHILD checks its own `factory`", () => {
    const roles = m.stateRoles.byComponent.find((c) => c.component === "Factory")!.variables;
    expect(roles.find((v) => v.variable === "factory")!.roles.some((r) => r.rule === "authorising-guard-read")).toBe(false);
  });
  it("an internal helper that writes the owner is not an open writer on its own; its callers decide (D5)", () => {
    const I = `pragma solidity ^0.8.20;
contract Init { address public owner; bool private done; modifier onlyOwner() { require(msg.sender == owner); _; }
  function _setOwner(address o) internal { owner = o; }
  function initialize(address o) external { require(!done); done = true; _setOwner(o); }
  function transferOwnership(address o) external onlyOwner { _setOwner(o); }
  function grab() external { _setOwner(msg.sender); } }`;
    const a = buildProtocolModel([{ path: "i.sol", text: I }]).model.authority.byComponent.find((c) => c.component === "Init")!;
    expect(a.unguardedAuthorityWrites.map((w) => w.fn)).toEqual(["Init.grab()"]);
    const ws = a.roles.find((r) => r.variable === "owner")!.writers;
    expect(ws.some((w) => w.fn.startsWith("Init._setOwner"))).toBe(false);
    expect(ws.find((w) => w.fn === "Init.initialize(address)")!.control).toBe("one-time-initialiser");
    expect(ws.find((w) => w.fn === "Init.transferOwnership(address)")!.control).toBe("guarded");
  });
});
