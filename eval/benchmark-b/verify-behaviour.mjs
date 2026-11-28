// Behavioural ground truth for benchmark-b: compiles each matched pair with solcjs and runs it in an in-memory EVM to
// confirm that the VULNERABLE variant exhibits the labelled defect and the SECURE variant does not. This checks the
// labels against executed behaviour, not just by reading the code. It never runs the analyzer and never reads labels.json.
//
// Usage: GROUND_TRUTH_LIB=/path/to/lib.mjs node eval/benchmark-b/verify-behaviour.mjs
//   lib.mjs is eval/ground-truth/lib.mjs, run from a directory where solc@0.8.28 and @ethereumjs/evm are installed
//   (see eval/ground-truth/package.json: an isolated install, not a project dependency). No network at run time.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const libPath = process.env.GROUND_TRUTH_LIB ?? join(here, "..", "ground-truth", "lib.mjs");
const { Chain, ETHER, compile, encodeCall } = await import(pathToFileURL(libPath).href);

const MOCKS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockPrice { uint256 public spot; uint256 public twap; uint256 public lastUpdate;
  function set(uint256 s, uint256 t) external { spot = s; twap = t; } }
contract FixedEligibility { bool public answer; constructor(bool a) { answer = a; }
  function isEligible(address) external view returns (bool) { return answer; } }`;

const build = (file) => {
  const r = compile(`contracts/${file}`, readFileSync(join(here, "contracts", file), "utf8"));
  if (r.errors.length) throw new Error(`${file}: ${r.errors.join("; ")}`);
  return Object.values(r.contracts)[0] && r.contracts[file.replace(/\.sol$/, "")];
};
const mocks = compile("contracts/Mocks.sol", MOCKS);
if (mocks.errors.length) throw new Error(mocks.errors.join("; "));
const word = (v) => (typeof v === "string" ? v.toLowerCase().replace(/^0x/, "").padStart(64, "0") : BigInt(v).toString(16).padStart(64, "0"));
const ctor = (...args) => Uint8Array.from(Buffer.from(args.map(word).join(""), "hex"));
const uint = (r) => BigInt(r.returnData === "0x" ? 0 : r.returnData);

async function setup(file, ctorArgs) {
  const chain = await Chain.create();
  const [deployer, alice, mallory] = [chain.addr(0xd0), chain.addr(0xa1), chain.addr(0xbad)];
  for (const a of [deployer, alice, mallory]) await chain.fund(a, 1_000_000n * ETHER);
  const c = build(file);
  const at = await chain.deploy(c.bytecode, deployer, ctorArgs ?? new Uint8Array());
  const call = (from, fn, args = [], value = 0n) => chain.call(from, at, encodeCall(c.abi, fn, args), value);
  const read = async (fn, args = []) => uint(await call(deployer, fn, args));
  return { chain, deployer, alice, mallory, at, call, read };
}
const deployMock = async (chain, name, from, args) => chain.deploy(mocks.contracts[name].bytecode, from, args ?? new Uint8Array());
const mcall = (chain, from, to, name, fn, args = []) => chain.call(from, to, encodeCall(mocks.contracts[name].abi, fn, args));

// Each check returns { exhibits: boolean, detail } for one contract variant.
const CHECKS = {
  "accounting-error": async (file) => {
    const priceWei = ETHER / 1000n; // 0.001 ether per token -> 1 ether buys 1000 tokens
    const t = await setup(file, ctor(priceWei));
    const r = await t.call(t.alice, "buy", [], ETHER);
    const credited = await t.read("balanceOf", [t.alice.toString()]);
    return { exhibits: r.ok && credited !== 1000n, detail: `1 ether at 0.001 ether/token credited ${credited} tokens (fair: 1000)` };
  },
  "oracle-manipulation": async (file) => {
    const t = await setup(file, ctor("0x" + "00".repeat(20))); // placeholder; redeployed below with the real mock
    const mock = await deployMock(t.chain, "MockPrice", t.deployer);
    const c = build(file);
    const at = await t.chain.deploy(c.bytecode, t.deployer, ctor(mock.toString()));
    const call = (from, fn, args = []) => t.chain.call(from, at, encodeCall(c.abi, fn, args));
    await mcall(t.chain, t.deployer, mock, "MockPrice", "set", [100n * ETHER, ETHER]); // attacker pushed spot to 100x the TWAP
    await call(t.alice, "deposit", [10n]);
    const power = uint(await call(t.deployer, "borrowPower", [t.alice.toString()]));
    return { exhibits: power !== 10n * ETHER, detail: `10 units at TWAP 1 ether, manipulated spot 100 ether -> borrowPower ${power} (fair: ${10n * ETHER})` };
  },
  "state-transition": async (file) => {
    const t = await setup(file);
    await t.call(t.deployer, "allocate", [t.alice.toString(), 100n]);
    await t.call(t.deployer, "advance"); // Setup -> Active (allocations not final)
    const r = await t.call(t.alice, "claim");
    const got = await t.read("claimable", [t.alice.toString()]);
    return { exhibits: r.ok && got === 100n, detail: `claim during Active: ${r.ok ? "succeeded" : "reverted"}, claimable ${got}` };
  },
  "protocol-invariant": async (file) => {
    const t = await setup(file);
    await t.call(t.deployer, "burn", [10n * ETHER]);
    const bal = await t.read("balanceOf", [t.deployer.toString()]);
    const supply = await t.read("totalSupply");
    return { exhibits: bal !== supply, detail: `after burn: sum(balances)=${bal}, totalSupply=${supply}` };
  },
  "business-logic": async (file) => {
    const t = await setup(file);
    const r = await t.call(t.alice, "buy", [t.alice.toString()], (ETHER * 90n) / 100n); // self-referral at the discounted price
    // positive control for the secure variant: a genuine referral by an existing customer still gets the discount
    await t.call(t.mallory, "buy", ["0x" + "00".repeat(20)], ETHER);
    const ok2 = await t.call(t.deployer, "buy", [t.mallory.toString()], (ETHER * 90n) / 100n);
    return { exhibits: r.ok, detail: `self-referred buy at 0.9 ether: ${r.ok ? "accepted" : "rejected"}; genuine referral discount: ${ok2.ok ? "honoured" : "refused"}`, control: ok2.ok };
  },
  "economic-attack": async (file) => {
    const t = await setup(file);
    const before = await t.chain.balance(t.mallory);
    await t.call(t.mallory, "deposit", [], 1n);                         // first depositor: 1 wei -> 1 share
    await t.chain.call(t.mallory, t.at, new Uint8Array(), 10n * ETHER); // direct donation inflates the raw balance
    await t.call(t.alice, "deposit", [], 5n * ETHER);                   // victim
    const victimShares = await t.read("shares", [t.alice.toString()]);
    await t.call(t.mallory, "withdraw", [1n]);
    const profit = (await t.chain.balance(t.mallory)) - before;
    return { exhibits: victimShares === 0n && profit > 0n, detail: `victim deposited 5 ether -> ${victimShares} shares; attacker net ${profit} wei` };
  },
  "cross-contract": async (file) => {
    const chain = await Chain.create();
    const [deployer, mallory] = [chain.addr(0xd0), chain.addr(0xbad)];
    for (const a of [deployer, mallory]) await chain.fund(a, 1000n * ETHER);
    const configured = await deployMock(chain, "FixedEligibility", deployer, ctor(0n)); // the real list says: not eligible
    const fake = await deployMock(chain, "FixedEligibility", mallory, ctor(1n));       // attacker's contract says: eligible
    const c = build(file);
    const at = await chain.deploy(c.bytecode, deployer, ctor(configured.toString()));
    const hasParam = c.abi.find((x) => x.name === "claim").inputs.length === 1;
    const r = await chain.call(mallory, at, encodeCall(c.abi, "claim", hasParam ? [fake.toString()] : []));
    const bal = uint(await chain.call(deployer, at, encodeCall(c.abi, "balanceOf", [mallory.toString()])));
    return { exhibits: r.ok && bal > 0n, detail: `ineligible caller ${hasParam ? "supplies own eligibility contract" : "uses configured contract"}: claim ${r.ok ? "succeeded" : "reverted"}, balance ${bal}` };
  },
  "transaction-ordering": async (file) => {
    const t = await setup(file);
    const c = build(file);
    const hasMin = c.abi.find((x) => x.name === "swapAForB").inputs.length === 2;
    await t.call(t.alice, "depositA", [], 10n * ETHER);
    await t.call(t.mallory, "depositA", [], 100n * ETHER);
    const quote = (10n * ETHER * 1000n * ETHER) / (1000n * ETHER + 10n * ETHER); // what alice saw when she signed
    await t.call(t.mallory, "swapAForB", hasMin ? [100n * ETHER, 0n] : [100n * ETHER]); // front-run
    const r = await t.call(t.alice, "swapAForB", hasMin ? [10n * ETHER, quote] : [10n * ETHER]);
    const got = await t.read("balB", [t.alice.toString()]);
    return { exhibits: r.ok && got < quote, detail: `after a front-run, victim swap ${r.ok ? "executed" : "reverted"}; received ${got} vs quoted ${quote}` };
  },
};

const PAIRS = [
  ["accounting-error", "AccountingSaleBad.sol", "AccountingSaleGood.sol"],
  ["oracle-manipulation", "OraclePriceBad.sol", "OraclePriceGood.sol"],
  ["state-transition", "SalePhaseBad.sol", "SalePhaseGood.sol"],
  ["protocol-invariant", "SupplyInvariantBad.sol", "SupplyInvariantGood.sol"],
  ["business-logic", "ReferralSaleBad.sol", "ReferralSaleGood.sol"],
  ["economic-attack", "DonationVaultBad.sol", "DonationVaultGood.sol"],
  ["cross-contract", "AirdropTrustBad.sol", "AirdropTrustGood.sol"],
  ["transaction-ordering", "SwapNoSlippageBad.sol", "SwapNoSlippageGood.sol"],
];

const rows = [];
for (const [cls, bad, good] of PAIRS) {
  const b = await CHECKS[cls](bad); const g = await CHECKS[cls](good);
  const pass = b.exhibits === true && g.exhibits === false && (g.control === undefined || g.control === true);
  rows.push({ class: cls, pass, vulnerable: { file: bad, exhibits: b.exhibits, detail: b.detail }, secure: { file: good, exhibits: g.exhibits, detail: g.detail } });
}
const out = { tool: "benchmark-b/verify-behaviour", solc: compile("x.sol", "pragma solidity ^0.8.20; contract X {}").solcVersion, pairs: rows.length, passed: rows.filter((r) => r.pass).length, rows };
console.log(JSON.stringify(out, null, 2));
process.exit(out.passed === out.pairs ? 0 : 1);
