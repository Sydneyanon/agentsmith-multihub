import { createHash } from "node:crypto";
import { Pool } from "pg";
import { buildPoolConfig, stderrWarning } from "../db-config.js";
import { createRepositoryResearchRun } from "./step.js";

/**
 * Creates ONE repository_research run with the analysis stages, for an approved, pre-registered input (A34). It refuses unless:
 * - the input's canonical SHA-256 equals --expect-sha256 (the hash recorded with the frozen answer key), so the run cannot drift
 *   from what was approved;
 * - no other run is queued, running or awaiting approval, so a run-scoped worker has exactly this one to execute.
 * It connects with WORKER_DATABASE_URL when set (the restricted role), else DATABASE_URL. It fetches nothing and starts no worker.
 *   node dist/apps/api/src/acquisition/create-run-main.js --input '<json>' --expect-sha256 <hex>
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const inputSha256 = (input: unknown) => createHash("sha256").update(canonicalJson(input)).digest("hex");

const args = process.argv.slice(2);
const arg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (process.argv[1]?.endsWith("create-run-main.js") || process.argv[1]?.endsWith("create-run-main.ts")) {
  const raw = arg("--input"); const expect = arg("--expect-sha256");
  if (!raw || !expect || !/^[0-9a-f]{64}$/.test(expect)) { console.error("usage: --input '<json>' --expect-sha256 <64 hex>"); process.exit(64); }
  const input = JSON.parse(raw) as { repository: string; ref?: string; excludePathPrefixes?: string[] };
  const got = inputSha256(input);
  if (got !== expect) { console.error(`input hash ${got} does not match the approved ${expect}; nothing was created`); process.exit(65); }
  const urlVariable = process.env.WORKER_DATABASE_URL ? "WORKER_DATABASE_URL" as const : "DATABASE_URL" as const;
  const pool = new Pool(buildPoolConfig(process.env, { max: 1, onWarning: stderrWarning, urlVariable, applicationName: "agentsmith-create-run" }));
  try {
    const pending = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM workflow_runs WHERE status IN ('queued', 'running', 'awaiting_approval')")).rows[0]!.n;
    if (pending > 0) { console.error(`${pending} run(s) are already pending; refusing so the scoped worker executes only the approved run`); process.exitCode = 66; }
    else {
      const r = await createRepositoryResearchRun(pool, input, "operator", { structuralAnalysis: true });
      console.log(JSON.stringify({ created: true, run_id: r.runId, acquire_step_id: r.stepId, input_sha256: got, connected_as: urlVariable }));
    }
  } finally { await pool.end(); }
}
