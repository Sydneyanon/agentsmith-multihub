import { describe, expect, it } from "vitest";
import { analyzeSources } from "./specialists.js";

/**
 * A write through a `storage` reference (a local declared `T storage x = ...`, or a helper parameter declared `T storage x`) is a write to
 * the state variable it points into. The reentrancy specialist used to drop such writes (their root identifier is a local, not a state
 * variable), so the classic "cache a storage pointer, pay, then zero through the pointer" pattern went unreported. A `memory` copy is
 * NOT storage: writing it after the call changes nothing on chain and must not be reported. All contracts here are synthetic.
 */
const src = (body: string) => `pragma solidity ^0.8.20;
contract Vault {
    struct Account { uint256 balance; uint256 nonce; }
    mapping(address => Account) internal accounts;
    function deposit() external payable { accounts[msg.sender].balance += msg.value; }
${body}
}`;
const analyse = (body: string) => {
  const text = src(body);
  const lines = text.split("\n");
  const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
  const findings = analyzeSources([{ path: "s/Vault.sol", text }]).findings;
  return { findings, lineOf, reentrancy: (fn: string) => findings.filter((f) => f.class === "reentrancy" && f.function === fn) };
};

describe("writes through storage references count as state writes for reentrancy", () => {
  it("flags a write through a storage local made after the external call", () => {
    const { reentrancy, lineOf } = analyse(`
    function withdraw() external {
        Account storage a = accounts[msg.sender];
        uint256 amt = a.balance;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok);
        a.balance = 0;
    }`);
    const f = reentrancy("withdraw");
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(lineOf("msg.sender.call"));
    expect(f[0]!.detail).toMatchObject({ writtenVariable: "accounts", writeLine: lineOf("a.balance = 0;") });
    expect(f[0]!.claim).toContain("accounts[msg.sender]");
    expect(f[0]!.claim).toContain("storage reference a");
  });

  it("flags a write through a storage parameter of an internal helper called after the external call", () => {
    const { reentrancy, lineOf } = analyse(`
    function _clear(Account storage a) internal { a.balance = 0; a.nonce++; }
    function withdraw() external {
        uint256 amt = accounts[msg.sender].balance;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok);
        _clear(accounts[msg.sender]);
    }`);
    const f = reentrancy("withdraw");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatchObject({ writtenVariable: "accounts", writeLine: lineOf("function _clear") });
    expect(f[0]!.claim).toContain("accounts[msg.sender]");
  });

  it("follows a storage local passed on to a storage parameter, and `delete` through the reference", () => {
    const { reentrancy } = analyse(`
    function _wipe(Account storage acct) internal { delete acct.balance; }
    function withdraw() external {
        Account storage a = accounts[msg.sender];
        (bool ok,) = msg.sender.call{value: a.balance}("");
        require(ok);
        _wipe(a);
    }`);
    const f = reentrancy("withdraw");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatchObject({ writtenVariable: "accounts", writeOp: "delete" });
  });

  it("flags a storage local that is declared first and bound by a later assignment", () => {
    const { reentrancy } = analyse(`
    function withdraw() external {
        Account storage a;
        a = accounts[msg.sender];
        (bool ok,) = msg.sender.call{value: a.balance}("");
        require(ok);
        a.balance = 0;
    }`);
    expect(reentrancy("withdraw")).toHaveLength(1);
  });

  it("does NOT flag a write to a memory copy after the call", () => {
    const { reentrancy } = analyse(`
    function withdraw() external {
        Account memory m = accounts[msg.sender];
        (bool ok,) = msg.sender.call{value: m.balance}("");
        require(ok);
        m.balance = 0;
    }`);
    expect(reentrancy("withdraw")).toHaveLength(0);
  });

  it("does NOT flag a write to a memory parameter of a helper after the call", () => {
    const { reentrancy } = analyse(`
    function _clearCopy(Account memory a) internal pure returns (Account memory) { a.balance = 0; return a; }
    function withdraw() external {
        uint256 amt = accounts[msg.sender].balance;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok);
        _clearCopy(accounts[msg.sender]);
    }`);
    expect(reentrancy("withdraw")).toHaveLength(0);
  });

  it("does NOT flag checks-effects-interactions through a storage local (write before the call)", () => {
    const { reentrancy } = analyse(`
    function withdraw() external {
        Account storage a = accounts[msg.sender];
        uint256 amt = a.balance;
        a.balance = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok);
    }`);
    expect(reentrancy("withdraw")).toHaveLength(0);
  });

  it("does NOT flag checks-effects-interactions through a storage parameter (helper called before the call)", () => {
    const { reentrancy } = analyse(`
    function _clear(Account storage a) internal { a.balance = 0; }
    function withdraw() external {
        uint256 amt = accounts[msg.sender].balance;
        _clear(accounts[msg.sender]);
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok);
    }`);
    expect(reentrancy("withdraw")).toHaveLength(0);
  });

  it("does NOT flag the storage-local pattern when a nonReentrant lock defined in the file guards the function", () => {
    const { reentrancy } = analyse(`
    bool private locked;
    modifier nonReentrant() { require(!locked); locked = true; _; locked = false; }
    function withdraw() external nonReentrant {
        Account storage a = accounts[msg.sender];
        uint256 amt = a.balance;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok);
        a.balance = 0;
    }`);
    expect(reentrancy("withdraw")).toHaveLength(0);
  });

  it("re-pointing a storage local is not itself a state write", () => {
    const { reentrancy } = analyse(`
    function touch(address other) external {
        Account storage a = accounts[msg.sender];
        (bool ok,) = msg.sender.call{value: a.balance}("");
        require(ok);
        a = accounts[other];
    }`);
    expect(reentrancy("touch")).toHaveLength(0);
  });
});
