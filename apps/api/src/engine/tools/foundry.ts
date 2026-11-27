import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOUNDRY_VERSION } from "../capabilities.js";
import { inputManifestSha256, materialise, runFixed, sha256, toolVersion, type ToolFailure } from "./run-tool.js";

/**
 * PREPARED, not assignable (capability status 'prepared'): Foundry as an independent VALIDATION capability (plane 2). Given the sealed
 * snapshot and one reproducing test written by someone other than the producer, it runs `forge test` offline, pinned, with the solc
 * binary given explicitly, and reports passed/failed per test plus the reproducibility record. It is never a claim's own proof: a passing
 * test is an evaluation by `foundry-forge`, recorded next to the claim. Not wired into a step until the owner approves installing Foundry
 * (an environment change) and a test author exists.
 */
export const FORGE_ARGS = (testPath: string) => ["test", "--offline", "--json", "--match-path", testPath];
export type ForgeRun = { ok: true; version: string; inputManifestSha256: string; testSha256: string; rawOutputSha256: string; durationMs: number; results: Array<{ test: string; passed: boolean; reason: string | null }> };

export function parseForgeJson(raw: string): Array<{ test: string; passed: boolean; reason: string | null }> | ToolFailure {
  let doc: Record<string, { test_results?: Record<string, { status?: string; reason?: string | null }> }>;
  try { doc = JSON.parse(raw); } catch { return { code: "output_invalid", detail: "forge did not print JSON" }; }
  const out: Array<{ test: string; passed: boolean; reason: string | null }> = [];
  for (const [suite, v] of Object.entries(doc)) for (const [test, r] of Object.entries(v.test_results ?? {})) out.push({ test: `${suite}::${test}`, passed: r.status === "Success", reason: r.reason ?? null });
  return out.length ? out : { code: "output_invalid", detail: "no test results" };
}

export async function runForgeTest(input: { files: ReadonlyArray<{ path: string; content: Buffer }>; test: { path: string; content: Buffer }; forgeBin: string; solcBin: string; timeoutMs?: number }): Promise<ForgeRun | { ok: false; failure: ToolFailure }> {
  const started = Date.now();
  if (!/^test\/[A-Za-z0-9_./-]+\.t\.sol$/.test(input.test.path)) return { ok: false, failure: { code: "input_invalid", detail: "the test must be test/<name>.t.sol" } };
  const toml = Buffer.from(`[profile.default]\nsrc = "."\ntest = "test"\nlibs = ["lib"]\noffline = true\nsolc = "${input.solcBin.replace(/"/g, "")}"\n`, "utf8");
  const files = [...input.files.filter((f) => f.path !== "foundry.toml"), { path: "foundry.toml", content: toml }, input.test];
  const work = materialise(files); const home = mkdtempSync(join(tmpdir(), "agentsmith-tool-home-"));
  try {
    const v = await toolVersion(input.forgeBin, home, work.dir); if ("code" in v) return { ok: false, failure: v };
    if (v.version !== FOUNDRY_VERSION) return { ok: false, failure: { code: "version_mismatch", detail: `forge ${v.version}; pinned ${FOUNDRY_VERSION}` } };
    const r = await runFixed(input.forgeBin, FORGE_ARGS(input.test.path), { cwd: work.dir, timeoutMs: input.timeoutMs ?? 600_000, home });
    if (r.spawnError) return { ok: false, failure: { code: "tool_unavailable", detail: r.spawnError } };
    if (r.timedOut) return { ok: false, failure: { code: "timeout", detail: "forge test timed out" } };
    const results = parseForgeJson(r.stdout);
    if ("code" in results) return { ok: false, failure: /Compiler run failed|Error \(/.test(r.stderr + r.stdout) ? { code: "compile_failed", detail: r.stderr.slice(-2000) } : results };
    return { ok: true, version: v.version, inputManifestSha256: inputManifestSha256(input.files), testSha256: sha256(input.test.content), rawOutputSha256: sha256(r.stdout), durationMs: Date.now() - started, results };
  } finally { work.cleanup(); rmSync(home, { recursive: true, force: true }); }
}
