// Compile-and-execute substrate: solcjs + @ethereumjs/evm. No network, no host access, no repository code executed on the host:
// contracts run only inside the in-memory EVM.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const solc = require("solc");
import { createEVM } from "@ethereumjs/evm";
import { Address, createAccount, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { keccak256 } from "ethereum-cryptography/keccak.js";

export const ETHER = 10n ** 18n;
export function compile(path, text) {
  const input = { language: "Solidity", sources: { [path]: { content: text } }, settings: { evmVersion: "shanghai", optimizer: { enabled: false }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === "error").map((e) => e.formattedMessage.split("\n")[0]);
  const contracts = {};
  for (const [name, c] of Object.entries(out.contracts?.[path] ?? {})) if (c.evm.bytecode.object) contracts[name] = { abi: c.abi, bytecode: c.evm.bytecode.object };
  return { errors, contracts, solcVersion: solc.version() };
}

const pad = (b) => b.toString(16).padStart(64, "0");
const hex = (u8) => Buffer.from(u8).toString("hex");
/** ABI encoder for static types (uint/int/address/bool) and dynamic `bytes`, enough for the experiments */
export function encodeCall(abi, fn, args = []) {
  const item = abi.find((x) => x.type === "function" && x.name === fn && x.inputs.length === args.length);
  if (!item) throw new Error(`no function ${fn}/${args.length} in ABI`);
  const sig = `${fn}(${item.inputs.map((i) => i.type).join(",")})`;
  const sel = Buffer.from(keccak256(Buffer.from(sig))).subarray(0, 4).toString("hex");
  const heads = []; const tails = []; let tailOffset = 32 * item.inputs.length;
  item.inputs.forEach((inp, i) => {
    const a = args[i];
    if (inp.type === "bytes") {
      const data = a instanceof Uint8Array ? a : Uint8Array.from(Buffer.from(String(a).replace(/^0x/, ""), "hex"));
      const body = pad(BigInt(data.length)) + hex(data) + "00".repeat((32 - (data.length % 32)) % 32);
      heads.push(pad(BigInt(tailOffset))); tails.push(body); tailOffset += body.length / 2;
    } else if (inp.type === "address") heads.push(String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0"));
    else if (inp.type === "bool") heads.push(pad(a ? 1n : 0n));
    else if (/^u?int/.test(inp.type)) heads.push(pad(BigInt(a)));
    else throw new Error(`unsupported type ${inp.type}`);
  });
  return hexToBytes("0x" + sel + heads.join("") + tails.join(""));
}

export class Chain {
  static async create() { const c = new Chain(); c.evm = await createEVM(); c.nonce = 0n; return c; }
  addr(n) { return new Address(hexToBytes("0x" + n.toString(16).padStart(40, "0"))); }
  async fund(address, wei) { await this.evm.stateManager.putAccount(address, createAccount({ balance: wei })); }
  async balance(address) { return (await this.evm.stateManager.getAccount(address))?.balance ?? 0n; }
  async deploy(bytecode, from, ctorArgs = new Uint8Array()) {
    const data = new Uint8Array([...hexToBytes("0x" + bytecode), ...ctorArgs]);
    const r = await this.evm.runCall({ caller: from, data, value: 0n, gasLimit: 30_000_000n });
    if (r.execResult.exceptionError || !r.createdAddress) throw new Error("deploy failed: " + (r.execResult.exceptionError?.error ?? "no address"));
    return r.createdAddress;
  }
  /** returns {ok, revert}; a failed call leaves no state change (the EVM reverts it) */
  async call(from, to, data, value = 0n) {
    const r = await this.evm.runCall({ caller: from, to, data, value, gasLimit: 30_000_000n });
    return { ok: !r.execResult.exceptionError, error: r.execResult.exceptionError?.error ?? null, returnData: bytesToHex(r.execResult.returnValue) };
  }
}
export const ATTACKER_SOURCE = readFileSync(new URL("./Attacker.sol", import.meta.url), "utf8");
