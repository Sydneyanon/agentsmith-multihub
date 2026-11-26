// Usage: node run-reentrancy.mjs specs-reentrancy.json [out.json]
// GROUND TRUTH by compiling with solc and EXECUTING in a local JS EVM. For each spec and scenario (attacker credit 1|2 ether, amount 1|2 ether): fresh
// chain; the attacker CONTRACT re-enters once from its receive/fallback hook (only when enough gas is forwarded, so not under a 2300-gas transfer);
// compared with the best honest ordering of the same two calls with hooks disabled. Exploitable = re-entrant ether received > honest maximum.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Chain, ETHER, ATTACKER_SOURCE, compile, encodeCall } from "./lib.mjs";

const specsPath = process.argv[2]; const outPath = process.argv[3]; const specs = JSON.parse(readFileSync(specsPath, "utf8")); const base = dirname(resolve(specsPath));
const ab = compile("Attacker.sol", ATTACKER_SOURCE); if (ab.errors.length) throw new Error(ab.errors.join("\n"));
const AT = ab.contracts.Attacker;
const sub = (v, ctx) => typeof v !== "string" ? v : v === "$ATTACKER" ? ctx.attacker : v === "$VICTIM" ? ctx.victim : v === "$CREDIT" ? ctx.credit : v === "$AMT" ? ctx.amt : /^[0-9]+$/.test(v) ? BigInt(v) * ETHER : v;

async function scenario(spec, build, credit, amt, hooks, order) {
  const chain = await Chain.create(); const deployer = chain.addr(0xde1), victimEoa = chain.addr(0x71c);
  await chain.fund(deployer, 1000n * ETHER); await chain.fund(victimEoa, 1000n * ETHER);
  const target = await chain.deploy(build.bytecode, deployer); const attacker = await chain.deploy(AT.bytecode, deployer);
  const ctx = { attacker: attacker.toString(), victim: victimEoa.toString(), credit: credit * ETHER, amt: amt * ETHER };
  const enc = (f) => encodeCall(build.abi, f.fn, f.args.map((a) => sub(a, ctx)));
  const log = [];
  const viaAttacker = async (data, value = 0n) => chain.call(deployer, attacker, encodeCall(AT.abi, "exec", [data]), value);
  await chain.call(deployer, attacker, encodeCall(AT.abi, "configure", [target.toString(), "0x", 0]));
  for (const f of spec.fund) {
    const value = sub(f.value, ctx);
    const r = f.as === "victim" ? await chain.call(victimEoa, target, enc(f), value) : await viaAttacker(enc(f), value);
    log.push(`${f.as} ${f.fn}: ${r.ok ? "ok" : r.error}`);
  }
  await chain.call(deployer, attacker, encodeCall(AT.abi, "configure", [target.toString(), enc(spec.again), hooks]));
  const before = await chain.balance(attacker); const results = [];
  const seq = hooks > 0 ? [spec.entry] : order === "entry-first" ? [spec.entry, spec.again] : [spec.again, spec.entry];
  for (const st of seq) { const r = await viaAttacker(enc(st)); results.push(!r.ok ? r.error : BigInt(r.returnData) === 1n ? "target call succeeded" : "target call REVERTED (attacker exec returned false)"); }
  const after = await chain.balance(attacker);
  const num = async (fn) => Number((await chain.call(deployer, attacker, encodeCall(AT.abi, fn))).returnData);
  return { received: after - before, results, hooksUsed: await num("hooks"), hookFailures: await num("hookFailures"), log };
}

const report = [];
for (const spec of specs) {
  const src = readFileSync(resolve(base, spec.file), "utf8"); const built = compile(spec.file, src);
  if (built.errors.length) { report.push({ id: spec.id, compile: "FAILED", errors: built.errors }); continue; }
  const build = built.contracts[spec.contract]; const takesAmt = spec.entry.args.includes("$AMT");
  const rows = []; let exploit = null;
  for (const credit of [1n, 2n]) for (const amt of (takesAmt ? [1n, 2n] : [1n])) {
    const honest = []; for (const order of ["entry-first", "again-first"]) honest.push(await scenario(spec, build, credit, amt, 0, order));
    const honestMax = honest.reduce((m, h) => (h.received > m ? h.received : m), 0n);
    const re = await scenario(spec, build, credit, amt, 1, "entry-first");
    const row = { credit: `${credit} ether`, amount: takesAmt ? `${amt} ether` : "n/a", honestMax: `${honestMax / 10n ** 15n} milli-ether`, reentrant: `${re.received / 10n ** 15n} milli-ether`, entryResult: re.results[0], hookCalls: re.hooksUsed, hookFailures: re.hookFailures, exploit: re.received > honestMax };
    rows.push(row); if (row.exploit && !exploit) exploit = row;
  }
  report.push({ id: spec.id, labelled: spec.labelled, solc: built.solcVersion, groundTruth: exploit ? "EXPLOITABLE" : "not exploitable (bounded scenarios)", firstExploit: exploit, scenarios: rows });
}
const summary = report.map((r) => `${r.id.padEnd(28)} labelled=${String(r.labelled).padEnd(18)} ground truth: ${r.groundTruth}${r.firstExploit ? ` (credit ${r.firstExploit.credit}, re-entrant ${r.firstExploit.reentrant} vs honest ${r.firstExploit.honestMax})` : ""}`);
console.log(summary.join("\n"));
if (outPath) writeFileSync(outPath, JSON.stringify({ solc: report.find((r) => r.solc)?.solc, report }, null, 2));
