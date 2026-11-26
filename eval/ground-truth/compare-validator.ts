/** Compares the execution validator (src/analysis/solidity/simulate.ts) with compiler-backed EVM ground truth, spec by spec. Usage: npx tsx eval/ground-truth/compare-validator.ts [out.txt] */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProgramIndex } from "../../apps/api/src/analysis/solidity/index.js";
import { validateReentrancy } from "../../apps/api/src/analysis/solidity/simulate.js";

type Spec = { id: string; file: string; contract: string; labelled: string; entry: { fn: string; args: unknown[] } };
const here = join(process.cwd(), "eval", "ground-truth"); const out: string[] = []; let agree = 0, total = 0; const disagree: string[] = [];
for (const [specFile, gtFile] of [["specs-reentrancy.json", "ground-truth-reentrancy.json"], ["specs-counterfactual.json", "ground-truth-counterfactual.json"]] as const) {
  const specs = JSON.parse(readFileSync(join(here, specFile), "utf8")) as Spec[];
  const gt = (JSON.parse(readFileSync(join(here, "..", "results", gtFile), "utf8")) as { report: Array<{ id: string; groundTruth: string }> }).report;
  for (const s of specs) {
    const path = resolve(here, s.file); const ix = new ProgramIndex([{ path: s.file, text: readFileSync(path, "utf8") }]);
    const fn = ix.findFunction(s.contract, s.entry.fn, s.entry.args.length); if (!fn) { out.push(`${s.id}: function not found`); continue; }
    const v = validateReentrancy(ix, fn); const truth = gt.find((g) => g.id === s.id)!.groundTruth.startsWith("EXPLOITABLE");
    const model = v.verdict === "validated" ? true : v.verdict === "refuted" ? false : null;
    total++; const ok = model === truth; if (ok) agree++; else disagree.push(s.id);
    out.push(`${s.id.padEnd(80)} model=${v.verdict.padEnd(12)} EVM=${truth ? "EXPLOITABLE" : "not exploitable"} ${ok ? "AGREE" : "DISAGREE"}`);
  }
}
out.push(`\nagreement ${agree}/${total}; disagreements: ${disagree.length ? disagree.join(", ") : "none"}; abstentions are counted as disagreements`);
console.log(out.join("\n")); if (process.argv[2]) writeFileSync(process.argv[2], out.join("\n") + "\n");
