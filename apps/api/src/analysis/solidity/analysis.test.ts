import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProgramIndex } from "./index.js";
import { lex } from "./lexer.js";
import { parseSolidity } from "./parser.js";
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
    const r = new ProgramIndex([{ path: "r.sol", text: `contract R { uint n; function f() external { n += 1; (bool ok, ) = msg.sender.call{value: 1 ether}(""); require(ok); require(n == 1, "second call"); } }` }]);
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
