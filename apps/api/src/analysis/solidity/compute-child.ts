import { buildStructuralMap, computeChallenge, computeStructuralAnalysis, type StoredHypothesis } from "./pipeline.js";
import { computeApexShadow, type ShadowLimits } from "../../apex/shadow.js";

/**
 * The child process in which the API runs the deterministic analysis and the execution validators on a sealed snapshot (option D, D1
 * and D3; started by bounded-compute.ts). It reads ONE JSON request from stdin, computes, writes ONE JSON answer to stdout and exits.
 * It has no database connection, no network use, no token and a minimal environment; the parent bounds its CPU time, wall time, heap
 * and output size, and kills it on any limit. Nothing from the repository is executed: the sources are parsed as text.
 */
type Request = { task: "analyze"; sources: Array<{ path: string; text: string }> } | { task: "challenge"; sources: Array<{ path: string; text: string }>; stored: StoredHypothesis[] }
  // the APEX shadow stage (measurement only), started by the WORKER's own BoundedCompute on the in-scope sources of the sealed snapshot
  | { task: "apex_shadow"; sources: Array<{ path: string; text: string }>; in_scope_paths: string[]; limits?: Partial<ShadowLimits> };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const req = JSON.parse(await readStdin()) as Request;
  const result = req.task === "analyze"
    ? { structure: computeStructuralAnalysis(req.sources), map: buildStructuralMap(req.sources) }
    : req.task === "challenge" ? { planned: computeChallenge(req.sources, req.stored) }
    : req.task === "apex_shadow" ? { shadow: computeApexShadow({ sources: req.sources, inScopePaths: req.in_scope_paths, ...(req.limits ? { limits: req.limits } : {}) }) } : null;
  if (!result) throw new Error("unknown task");
  const cpu = process.cpuUsage();
  process.stdout.write(JSON.stringify({ ok: true, result, cpu_ms: Math.round((cpu.user + cpu.system) / 1000) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message.slice(0, 500) : "failed" }));
  process.exitCode = 1;
}
