import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProgramIndex } from "./index.js";
import { lex } from "./lexer.js";
import { parseSolidity } from "./parser.js";
import { challengeFinding } from "./challenge.js";
import { validateReentrancy } from "./simulate.js";
import { analyzeSources } from "./specialists.js";

const dev = join(__dirname, "..", "..", "..", "..", "..", "eval", "dev");
const src = readdirSync(join(dev, "contracts")).sort().map((f) => ({ path: `contracts/${f}`, text: readFileSync(join(dev, "contracts", f), "utf8") }));
type Label = { file: string; function: string; class: string; vulnerable: boolean; line: number; exploitable?: boolean };
const labels = JSON.parse(readFileSync(join(dev, "labels.json"), "utf8")) as Label[];
const one = (text: string) => analyzeSources([{ path: "t.sol", text }]);

describe("lexer", () => {
  it("drops comments and hides string contents, so keywords there are never code", () => {
    const t = lex('// tx.origin\n/* selfdestruct(x); */ string s = "call{value:1}(tx.origin)"; uint a = 1;');
    expect(t.some((x) => x.v === "origin" || x.v === "selfdestruct")).toBe(false);
    expect(t.find((x) => x.k === "str")).toBeTruthy();
  });
  it("tracks line numbers across comments and strings", () => { expect(lex("a\n/* x\ny */\nb").find((t) => t.v === "b")?.line).toBe(4); });
});

describe("structural parser", () => {
  const f = parseSolidity("x.sol", `pragma solidity ^0.8.20;
interface IR { function ping(uint x) external; }
abstract contract Base { address public owner; modifier onlyOwner() { require(msg.sender == owner); _; } function _h() internal virtual {} }
contract C is Base, IR {
  mapping(address => mapping(uint => bool)) public m; uint public constant K = 5;
  event E(uint a); error Bad();
  constructor() { owner = msg.sender; }
  function go(uint a,
      address payable b) external payable onlyOwner returns (bool ok) { (bool s, ) = b.call{value: a}(""); return s; }
  function ping(uint x) external override {}
}`);
  it("recovers contracts, inheritance, state variables, modifiers and function attributes", () => {
    const [i, b, c] = f.contracts; expect([i?.kind, b?.kind, c?.kind]).toEqual(["interface", "abstract", "contract"]);
    expect(c?.bases).toEqual(["Base", "IR"]);
    expect(c?.stateVars.map((v) => [v.name, v.constant])).toEqual([["m", false], ["K", true]]);
    expect(b?.modifiers.map((m) => m.name)).toEqual(["onlyOwner"]);
    const go = c!.functions.find((x) => x.name === "go")!;
    expect(go).toMatchObject({ visibility: "external", mutability: "payable", params: [{ type: "uint", name: "a" }, { type: "address payable", name: "b" }] });
    expect(go.modifiers.map((m) => m.name)).toEqual(["onlyOwner"]); expect(go.startLine).toBe(8); expect(go.endLine).toBe(9);
  });
});

describe("specialists on the development corpus (a regression gate, not an independent evaluation)", () => {
  const { findings, problems } = analyzeSources(src);
  it("parses every file without problems", () => { expect(problems).toEqual([]); });
  it.each(labels.map((l) => [`${l.file} ${l.function} ${l.class} vulnerable=${l.vulnerable}`, l] as const))("%s", (_n, l) => {
    const hit = findings.filter((f) => f.file === l.file && f.function === l.function && f.class === l.class);
    if (l.vulnerable) { expect(hit.length).toBeGreaterThan(0); expect(hit[0]!.line).toBe(l.line); } else expect(hit).toEqual([]);
  });
  it("is deterministic regardless of file order", () => {
    const again = analyzeSources([...src].reverse()).findings;
    expect(again.map((f) => [f.file, f.line, f.class, f.claim])).toEqual(findings.map((f) => [f.file, f.line, f.class, f.claim]));
  });
  it("cites the call chain through an internal helper", () => {
    const f = findings.find((x) => x.function === "withdrawHelper" && x.class === "reentrancy")!;
    expect(f.chain.map((c) => c.fn)).toEqual(["_pay"]); expect(f.spans.map((s) => s.role)).toContain("supporting");
  });
});

describe("analysis behaviours that a line-pattern tool gets wrong", () => {
  it("does not flag words in comments or strings", () => {
    expect(one(`contract A { function f() external { string memory s = "tx.origin selfdestruct"; /* require(tx.origin == owner); */ } }`).findings).toEqual([]);
  });
  it("sees a guard inside an internal helper and inside a modifier", () => {
    const r = one(`contract A { address owner; modifier m() { _chk(); _; } function _chk() internal view { require(msg.sender == owner); }
      function a(address o) external m { owner = o; } function b(address o) external { _chk(); owner = o; } function c(address o) external { owner = o; } }`).findings;
    expect(r.map((f) => f.function)).toEqual(["c"]);
  });
  it("treats a reverting check after a write as protective, and a non-reverting early return after a write as not", () => {
    const r = one(`contract A { address owner;
      function late(address o) external { owner = o; require(msg.sender == owner); }
      function soft(address o) external { owner = o; if (msg.sender != owner) { return; } } }`).findings;
    expect(r.map((f) => f.function)).toEqual(["soft"]);
  });
  it("assumes by name only for unresolved modifiers, and says so", () => {
    const f = one(`contract A { address owner; function s(address o) external onlyOwner { owner = o; } function t(address o) external whenSomething { owner = o; } }`).findings;
    expect(f.map((x) => x.function)).toEqual(["t"]);
  });
  it("marks findings that rest on an assumed modifier as medium confidence", () => {
    const f = one(`contract A { uint x; function w(uint a) external nonReentrant { (bool ok,) = msg.sender.call{value: a}(""); require(ok); x = 1; } }`).findings;
    expect(f).toEqual([]);
    const g = one(`contract A { uint x; mapping(address=>uint) b; function w(uint a) external onlyAdmin { require(b[msg.sender] >= a); (bool ok,) = msg.sender.call{value: a}(""); require(ok); b[msg.sender] -= a; } }`).findings;
    expect(g.find((x) => x.class === "reentrancy")?.assumptions.length).toBeGreaterThan(0);
  });
});

describe("independent validation by execution", () => {
  const ix = new ProgramIndex(src);
  const v = (c: string, n: string, a: number) => validateReentrancy(ix, ix.findFunction(c, n, a)!);
  it("validates a zero-after-call payout with a concrete attacker trace", () => {
    const r = v("Bank2", "cashOut", 0); expect(r.verdict).toBe("validated"); expect(r.trace.join("\n")).toMatch(/re-enters cashOut/); expect(r.detail["reentrant"]).toBe("2 ether"); expect(r.detail["honest"]).toBe("1 ether");
  });
  it("validates unchecked subtraction and a flag set only after paying", () => { expect(v("Bank2", "withdrawUnchecked", 1).verdict).toBe("validated"); expect(v("Bank2", "claimBonus", 0).verdict).toBe("validated"); });
  it("REFUTES the classic pattern under checked 0.8 arithmetic: the re-entrant transaction reverts", () => {
    const r = v("Bank", "withdrawBad", 1); expect(r.verdict).toBe("refuted"); expect(r.reason).toMatch(/underflow/);
  });
  it("refutes a function that updates state before the call and one protected by a hand-rolled lock", () => { expect(v("Bank", "withdrawCei", 1).verdict).toBe("refuted"); expect(v("Bank", "withdrawLocked", 1).verdict).toBe("refuted"); });
  it("the same classic pattern IS exploitable when the pragma allows wrapping arithmetic", () => {
    const old = new ProgramIndex([{ path: "o.sol", text: src.find((s) => s.path.endsWith("Bank.sol"))!.text.replace("^0.8.20", "^0.7.6") }]);
    expect(validateReentrancy(old, old.findFunction("Bank", "withdrawBad", 1)!).verdict).toBe("validated");
  });
  it("rolls back a re-entrant call that pays and then reverts, so its payout is not counted as an exploit", () => {
    const r = new ProgramIndex([{ path: "r.sol", text: `contract R { bool done; bool inCall;
      function f() external { require(!done); bool was = inCall; inCall = true; (bool ok, ) = msg.sender.call{value: 1 ether}(""); require(ok); inCall = was; require(!was, "reentered"); done = true; } }` }]);
    expect(validateReentrancy(r, r.findFunction("R", "f", 0)!).verdict).toBe("refuted");
  });
  it("does not blame the entry function for a different function that is itself re-enterable", () => {
    const r = new ProgramIndex([{ path: "r.sol", text: `contract R { mapping(address => bool) c; mapping(address => uint) b;
      function a(uint x) external { require(b[msg.sender] >= x); (bool ok, ) = msg.sender.call{value: x}(""); require(ok); unchecked { b[msg.sender] -= x; } }
      function bonus() external { require(!c[msg.sender]); (bool ok, ) = msg.sender.call{value: 1 ether}(""); require(ok); c[msg.sender] = true; } }` }]);
    const res = validateReentrancy(r, r.findFunction("R", "a", 1)!);
    expect(res.verdict).toBe("validated"); expect(res.detail["reentered"]).toBe("a"); // via itself, not via the independently vulnerable bonus()
  });
  it("abstains when it meets something it does not model", () => {
    const u = new ProgramIndex([{ path: "u.sol", text: `contract U { IFoo f; mapping(address=>uint) b; function w(uint a) external { require(b[msg.sender] >= a); f.hook(a); (bool ok,) = msg.sender.call{value: a}(""); b[msg.sender] = 0; } }` }]);
    expect(validateReentrancy(u, u.findFunction("U", "w", 1)!).verdict).toBe("inconclusive");
  });
});

describe("independent challenge by unprivileged-caller execution", () => {
  const run = (text: string, fn: string) => { const r = one(text); const f = r.findings.find((x) => x.function === fn)!; expect(f, `${fn} must be flagged by the specialist`).toBeTruthy(); return challengeFinding(r.index, f)!; };
  it("validates an open privileged write, an open selfdestruct, an open initializer and an open delegatecall by reaching them as an attacker", () => {
    expect(run(`contract A { address owner; function set(address o) external { owner = o; } }`, "set").verdict).toBe("validated");
    expect(run(`contract A { function die() external { selfdestruct(payable(msg.sender)); } }`, "die").verdict).toBe("validated");
    expect(run(`contract A { address owner; function initialize(address o) external { owner = o; } }`, "initialize").verdict).toBe("validated");
    expect(run(`contract A { function fwd(address t, bytes calldata d) external { (bool ok,) = t.delegatecall(d); require(ok); } }`, "fwd").verdict).toBe("validated");
  });
  it("REFUTES a lead the specialist raised when execution shows the unprivileged call reverts", () => {
    const o = run(`contract A { address owner; function configure(address o) external { require(owner == address(0) || msg.sender == owner); owner = o; } }`, "configure");
    expect(o.verdict).toBe("refuted"); expect(o.reason).toMatch(/reverts/);
  });
  it("says plainly that reachability is not proof the statement is privileged", () => {
    expect(run(`contract A { address owner; function set(address o) external { owner = o; } }`, "set").trace.join(" ")).toMatch(/REACHABILITY/);
  });
  it("validates an ignored failing call that retains ether, and abstains on an unresolved modifier", () => {
    expect(run(`contract A { function pay(address to) external payable { to.call{value: msg.value}(""); } }`, "pay").verdict).toBe("validated");
    const r = one(`contract A { address owner; function s(address o) external whenSomething { owner = o; } }`); const f = r.findings[0]!;
    expect(challengeFinding(r.index, f)!.verdict).toBe("inconclusive");
  });
  it("does not treat a one-shot flag keyed by the caller as an authority", () => {
    expect(one(`contract A { mapping(address=>bool) claimed; function c() external { require(!claimed[msg.sender]); claimed[msg.sender] = true; } }`).findings).toEqual([]);
  });
});

describe("semantics added after the first independent evaluation (each from a general failure class, not a corpus-specific rule)", () => {
  const names = (t: string) => one(t).findings.map((f) => `${f.function}:${f.class}`).sort();
  it("a write on an early-return path before a later check is not protected by that check", () => {
    expect(names(`contract A { address admin; uint limit; uint constant MAX = 10;
      function setEarly(uint v) external { if (v > MAX) { limit = MAX; return; } require(msg.sender == admin); limit = v; }
      function setLate(uint v) external { require(msg.sender == admin); limit = v; } }`)).toEqual(["setEarly:access-control"]);
  });
  it("an argument passed to a helper or library stands for the authority it is", () => {
    expect(names(`library G { function enforce(address who) internal view { require(msg.sender == who); } }
      contract A { address steward; uint flow; constructor() { steward = msg.sender; } function set(uint f) external { G.enforce(steward); flow = f; } function setBad(uint f, address w) external { G.enforce(w); flow = f; } }`)).toEqual(["setBad:access-control"]);
  });
  it("a helper's delegatecall target is traced back to the state variable it came from", () => {
    expect(names(`contract A { address logic; function setLogic(address l) external { logic = l; }
      fallback() external payable { _run(logic); } function _run(address t) internal { (bool ok,) = t.delegatecall(msg.data); require(ok); } }`)).toEqual(expect.arrayContaining(["fallback:delegatecall"]));
  });
  it("a delegatecall target that must be in a stored allow-list is not caller-supplied", () => {
    expect(names(`contract A { mapping(address=>bool) allowed; address owner; function allow(address t) external { require(msg.sender == owner); allowed[t] = true; }
      function go(address t, bytes calldata d) external { require(allowed[t]); (bool ok,) = t.delegatecall(d); require(ok); } }`).filter((x) => x.endsWith("delegatecall"))).toEqual([]);
  });
  it("flags an unguarded halt-style state change and does not flag paying a fixed owner", () => {
    expect(names(`contract A { address steward; bool halted; constructor() { steward = msg.sender; } function halt() external { halted = true; } }`)).toEqual(["halt:access-control"]);
    expect(names(`contract A { address payable owner; function flush() external { (bool ok,) = owner.call{value: address(this).balance}(""); require(ok); } }`)).toEqual([]);
  });
  it("an initializer that sets state with a flag it checks but never sets is flagged", () => {
    expect(names(`contract A { bool ready; address beneficiary; function init(address b) external { require(!ready); beneficiary = b; } }`)).toEqual(["init:initializer"]);
  });
});

describe("pre-0.5 Solidity idioms found by the first real-repository run", () => {
  const legacy = (body: string) => analyzeSources([{ path: "l.sol", text: `pragma solidity ^0.4.18;\n${body}` }]);
  const names = (body: string) => legacy(body).findings.map((f) => `${f.function}:${f.class}`).sort();
  it("treats a same-name function as the constructor, and a near-miss name as an open function (the wrong-constructor-name bug)", () => {
    expect(names(`contract Wallet { address owner; function Wallet() public { owner = msg.sender; } }`)).toEqual([]);
    expect(names(`contract Wallet { address owner; function Walet() public { owner = msg.sender; } }`)).toEqual(["Walet:access-control"]);
  });
  it("normalises .call.value(v)() so the call, its value and its result are seen", () => {
    const r = legacy(`contract B { mapping(address=>uint) bal; function w() public { uint a = bal[msg.sender]; require(a > 0); if (!msg.sender.call.value(a)()) { throw; } bal[msg.sender] = 0; } }`);
    expect(r.findings.map((f) => f.class)).toEqual(["reentrancy"]);
    expect(validateReentrancy(r.index, r.index.findFunction("B", "w", 0)!).verdict).toBe("validated");
  });
  it("treats a same-name function as the constructor even without a pragma, and infers wrapping arithmetic only from legacy syntax", () => {
    const r = analyzeSources([{ path: "n.sol", text: `contract Old { address owner; function Old() { owner = msg.sender; } function f() { if (msg.sender != owner) throw; } }` }]);
    expect(r.findings).toEqual([]); expect(r.index.wrapsArithmetic.get("n.sol")).toBe(true);
    expect(new ProgramIndex([{ path: "m.sol", text: "contract M { uint x; }" }]).wrapsArithmetic.get("m.sol")).toBe(false);
  });
  it("does not flag an open setter in a contract with no notion of privilege, but does where an authority exists", () => {
    expect(names(`contract Box { uint v; function set(uint x) public { v = x; } }`)).toEqual([]);
    expect(names(`contract Box { address owner; uint v; function setV(uint x) public { v = x; } function o() public { require(msg.sender == owner); } }`)).toEqual(["setV:access-control"]);
  });
  it("recognises a role table read by an authorising guard as an authority, whatever its name, but not a one-shot claim flag", () => {
    expect(names(`contract R { mapping(bytes32 => mapping(address => bool)) holds; bool paused; bytes32 constant P = "p";
      function _need(bytes32 r) internal view { if (!holds[r][msg.sender]) revert(); } function pause() external { _need(P); paused = true; } function unpause() external { paused = false; } }`)).toEqual(["unpause:access-control"]);
    expect(names(`contract C { mapping(address=>bool) claimed; uint n; function c() external { require(!claimed[msg.sender]); claimed[msg.sender] = true; } function setN(uint x) external { n = x; } }`)).toEqual([]);
  });
  it("sees a transfer through a helper as debiting the caller (no false mint)", () => {
    expect(names(`contract T { address owner; mapping(address=>uint) bal; function o() public { require(msg.sender == owner); }
      function transfer(address to, uint v) public { _t(msg.sender, to, v); } function _t(address from, address to, uint v) internal { bal[from] -= v; bal[to] += v; } }`)).toEqual([]);
  });
  it("treats `throw;` as a revert, so `if (msg.sender != owner) throw;` is a guard", () => {
    expect(names(`contract A { address owner; function setOwner(address o) public { if (msg.sender != owner) throw; owner = o; } }`)).toEqual([]);
  });
  it("protects a body whose modifier runs `_` only inside an authorised branch", () => {
    expect(names(`contract A { address creator; modifier onlyowner { if (msg.sender == creator) _; } function setFee(uint f) onlyowner public { fee = f; } uint fee; }`)).toEqual([]);
  });
});

describe("deployed-contract dispatch context (failure class A, development fixtures)", () => {
  // An upgrade entry point declared in an abstract base calls a virtual authorisation hook; only the deployed contract's override decides.
  const UPGRADE_BASE = `pragma solidity ^0.8.20;
abstract contract Upgradable {
  address public implementation;
  function upgradeAndRun(address next, bytes calldata data) external {
    _authorize(next);
    implementation = next;
    (bool ok, ) = next.delegatecall(data);
    require(ok);
  }
  function _authorize(address next) internal virtual;
}`;
  it("an override with an owner check protects the inherited entry point: no finding", () => {
    const r = one(`${UPGRADE_BASE}
contract Guarded is Upgradable { address public owner; constructor() { owner = msg.sender; }
  function _authorize(address) internal view override { require(msg.sender == owner, "owner"); } }`);
    expect(r.findings.filter((f) => f.function === "upgradeAndRun")).toEqual([]);
  });
  it("an empty override leaves it open: delegatecall finding in the deployed contract's context", () => {
    const r = one(`${UPGRADE_BASE}
contract Open is Upgradable { function _authorize(address) internal override {} }`);
    const f = r.findings.find((x) => x.function === "upgradeAndRun" && x.class === "delegatecall");
    expect(f).toBeTruthy(); expect(f!.contract).toBe("Open");
  });
  it("two deployed contracts with different overrides are judged separately, and one statement is reported once", () => {
    const r = one(`${UPGRADE_BASE}
contract Guarded is Upgradable { address public owner; constructor() { owner = msg.sender; }
  function _authorize(address) internal view override { require(msg.sender == owner, "owner"); } }
contract OpenA is Upgradable { function _authorize(address) internal override {} }
contract OpenB is Upgradable { function _authorize(address) internal override {} }`);
    const hits = r.findings.filter((x) => x.function === "upgradeAndRun" && x.class === "delegatecall");
    expect(hits).toHaveLength(1); expect(["OpenA", "OpenB"]).toContain(hits[0]!.contract);
  });
  it("a modifier in a base calls a virtual check: the deployed override decides", () => {
    const base = `pragma solidity ^0.8.20;
abstract contract Gate { modifier gated() { _check(); _; } function _check() internal view virtual; }
abstract contract Kill is Gate { function shutdown(address payable to) external gated { selfdestruct(to); } }`;
    expect(one(`${base}\ncontract K1 is Kill { address public admin; constructor() { admin = msg.sender; } function _check() internal view override { require(msg.sender == admin); } }`).findings.filter((f) => f.class === "selfdestruct")).toEqual([]);
    expect(one(`${base}\ncontract K2 is Kill { function _check() internal view override {} }`).findings.filter((f) => f.class === "selfdestruct")).toHaveLength(1);
  });
  it("dispatch survives a second hop: a base helper calling a virtual check reaches the deployed override", () => {
    const base = `pragma solidity ^0.8.20;
abstract contract Vault2 { function _gate() internal view { _check(); } function _check() internal view virtual;
  function sweep(address payable to) external { _gate(); selfdestruct(to); } }`;
    expect(one(`${base}\ncontract S1 is Vault2 { address public admin; constructor() { admin = msg.sender; } function _check() internal view override { require(msg.sender == admin); } }`).findings.filter((f) => f.class === "selfdestruct")).toEqual([]);
    expect(one(`${base}\ncontract S2 is Vault2 { function _check() internal view override {} }`).findings.filter((f) => f.class === "selfdestruct")).toHaveLength(1);
  });
  it("an abstract contract that nothing deploys is still analysed on its own", () => {
    const r = one(`pragma solidity ^0.8.20;\nabstract contract Lonely { function kill(address payable to) external { selfdestruct(to); } }`);
    expect(r.findings.some((f) => f.class === "selfdestruct" && f.contract === "Lonely")).toBe(true);
  });
});

describe("reentrancy validator: consistent seeding and no refutation of unexplored targets (development fixtures)", () => {
  const run = (text: string, fn: string) => { const ix = new ProgramIndex([{ path: "v.sol", text }]); const entry = ix.findFunctions([...ix.contracts.keys()].at(-1)!, fn)[0]!; return validateReentrancy(ix, entry); };
  const POOL = (zeroFirst: boolean) => `pragma solidity ^0.8.20;
abstract contract Book { mapping(address => uint256) internal owed; uint256 internal outstanding;
  function _book(address who, uint256 amt) internal { owed[who] += amt; outstanding += amt; } }
contract Pool is Book {
  function claim() external {
    uint256 amt = owed[msg.sender]; require(amt > 0);
    ${zeroFirst ? "owed[msg.sender] = 0; outstanding -= amt;" : ""}
    (bool ok, ) = msg.sender.call{value: amt}(""); require(ok);
    ${zeroFirst ? "" : "owed[msg.sender] = 0; outstanding -= amt;"}
  }
}`;
  it("a total updated alongside the ledger is seeded consistently, so the real drain is validated (not refuted by a false underflow)", () => {
    const r = run(POOL(false), "claim"); expect(r.verdict).toBe("validated");
  });
  it("the safe twin that zeroes before the call is refuted", () => {
    expect(run(POOL(true), "claim").verdict).toBe("refuted");
  });
  it("a share pool with a payable deposit is not refuted while re-entry into deposit is unexplored", () => {
    const r = run(`pragma solidity ^0.8.20;
contract Shares { mapping(address => uint256) public units; uint256 public supply;
  function put() external payable { uint256 before = address(this).balance - msg.value; uint256 u = supply == 0 || before == 0 ? msg.value : msg.value * supply / before; units[msg.sender] += u; supply += u; }
  function take(uint256 u) external { uint256 amt = u * address(this).balance / supply; (bool ok, ) = msg.sender.call{value: amt}(""); require(ok); units[msg.sender] -= u; supply -= u; }
}`, "take");
    expect(r.verdict).toBe("inconclusive"); expect(r.reason).toMatch(/payable function\(s\) put is not modelled/);
  });
});

describe("interpreter: named return variables (development fixture)", () => {
  it("a named return variable is a local that starts at zero and is returned implicitly", () => {
    const text = `pragma solidity ^0.8.20;
contract Named { mapping(address => uint256) public bal;
  function quote(uint256 x) public pure returns (uint256 out) { out = x * 2; }
  function pull() external returns (uint256 amount) { amount = quote(bal[msg.sender]) / 2; bal[msg.sender] = 0; (bool ok, ) = msg.sender.call{value: amount}(""); require(ok); }
}`;
    const ix = new ProgramIndex([{ path: "n.sol", text }]);
    const r = validateReentrancy(ix, ix.findFunctions("Named", "pull")[0]!);
    expect(r.reason).not.toMatch(/unknown identifier/); expect(r.verdict).toBe("refuted");
  });
});
