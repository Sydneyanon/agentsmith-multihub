/**
 * CLI: npx tsx eval/bench/run.ts <corpus>/contracts [--out eval/results/<prefix>] [--adjudicate]
 * Writes <prefix>.json (full record) and <prefix>.txt (summary). Exit code 0 only when the run is complete (manifest OK,
 * labels intact, analyzer ran); a measured recall of 0 is NOT a failure.
 *
 * --adjudicate: AI adjudication runs only through AiBudgetGateway with a model adapter supplied programmatically
 * (see adjudicate.integration.test.ts). AgentSmith has no production provider adapter and ships an empty reviewed price
 * catalog, so from this CLI the pass is recorded as unavailable — never as a judgment, and never with a direct API call.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { adjudicate, selectCandidates } from "./adjudicate.js";
import { buildModelView } from "./model-view.js";
import { loadCorpus } from "../run-eval.js";
import { renderText, runBenchmark } from "./benchmark.js";

const args = process.argv.slice(2);
const contractsDir = args.find((a) => !a.startsWith("--"));
const outIdx = args.indexOf("--out"); const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
if (!contractsDir) { console.error("usage: run.ts <corpus>/contracts [--out prefix] [--adjudicate]"); process.exit(2); }

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const record = runBenchmark({ contractsDir: resolve(contractsDir), repoRoot, timeBudgetMs: 60_000 });
if (args.includes("--adjudicate")) {
  const candidates = selectCandidates(record);
  const view = buildModelView(loadCorpus(resolve(contractsDir)).sources);
  record.ai.adjudication = await adjudicate(candidates, view, { mode: "unavailable", reason: "no_model_adapter_configured (no production provider adapter exists; reviewed price catalog is empty by design)" });
}
const text = renderText(record) + (record.ai.adjudication ? `\nAI adjudication (separate from the deterministic result): ${JSON.stringify({ ...(record.ai.adjudication as object), results: undefined })}` : "");
console.log(text);
if (out) { writeFileSync(`${out}.json`, JSON.stringify(record, null, 2) + "\n"); writeFileSync(`${out}.txt`, text + "\n"); }
process.exit(record.complete ? 0 : 1);
