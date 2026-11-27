import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOUNDRY_VERSION } from "../capabilities.js";
import { inputManifestSha256, materialise, runFixed, sha256, toolVersion, type ToolFailure } from "./run-tool.js";

/**
 * Foundry as an independent VALIDATION capability (plane 2, T-202). Given the sealed snapshot and one reproducing test (test/*.sol files
 * written by someone other than the claim's producer), it runs `forge test --match-test` offline, pinned, with the solc binary given
 * explicitly, and reports passed/failed per test plus the reproducibility record. A passing test becomes an evaluation by `foundry-forge`
 * next to the claim: technical evidence by a party other than the producer, never the claim's own proof. Assignable only where the
 * pinned binaries are present; a persistent install is A39.
 */
export const FORGE_ARGS = (matchTest: string) => ["test", "--offline", "--json", "--match-test", matchTest];
export type ForgeRun = { ok: true; version: string; inputManifestSha256: string; testSha256: string; rawOutput: string; rawOutputSha256: string; durationMs: number; results: Array<{ test: string; passed: boolean; reason: string | null }> };

export function parseForgeJson(raw: string): Array<{ test: string; passed: boolean; reason: string | null }> | ToolFailure {
  let doc: Record<string, { test_results?: Record<string, { status?: string; reason?: string | null }> }>;
  try { doc = JSON.parse(raw); } catch { return { code: "output_invalid", detail: "forge did not print JSON" }; }
  const out: Array<{ test: string; passed: boolean; reason: string | null }> = [];
  for (const [suite, v] of Object.entries(doc)) for (const [test, r] of Object.entries(v.test_results ?? {})) out.push({ test: `${suite}::${test}`, passed: r.status === "Success", reason: r.reason ?? null });
  return out.length ? out : { code: "output_invalid", detail: "no test results" };
}

/** One reproducing test: one or more files under test/ (helpers allowed), at least one *.t.sol, and the test function(s) to run. */
export type ForgeTest = { files: ReadonlyArray<{ path: string; content: Buffer }>; matchTest: string };
export async function runForgeTest(input: { files: ReadonlyArray<{ path: string; content: Buffer }>; test: ForgeTest | { path: string; content: Buffer }; forgeBin: string; solcBin: string; timeoutMs?: number }): Promise<ForgeRun | { ok: false; failure: ToolFailure }> {
  const started = Date.now();
  const t: ForgeTest = "files" in input.test ? input.test : { files: [input.test], matchTest: "." };
  if (!t.files.length || t.files.some((f) => !/^test\/([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(\.t)?\.sol$/.test(f.path)) || !t.files.some((f) => f.path.endsWith(".t.sol"))) return { ok: false, failure: { code: "input_invalid", detail: "tests must be test/<name>.sol files, with at least one test/<name>.t.sol" } };
  if (!/^[A-Za-z0-9_.|*^$()-]{1,200}$/.test(t.matchTest)) return { ok: false, failure: { code: "input_invalid", detail: "matchTest must be a plain test-name pattern" } };
  const toml = Buffer.from(`[profile.default]\nsrc = "."\ntest = "test"\nlibs = ["lib"]\noffline = true\nsolc = "${input.solcBin.replace(/"/g, "")}"\n`, "utf8");
  const testPaths = new Set(t.files.map((f) => f.path));
  if (input.files.some((f) => testPaths.has(f.path))) return { ok: false, failure: { code: "input_invalid", detail: "a test file would overwrite a snapshot file" } };
  const files = [...input.files.filter((f) => f.path !== "foundry.toml"), { path: "foundry.toml", content: toml }, ...t.files];
  const work = materialise(files); const home = mkdtempSync(join(tmpdir(), "agentsmith-tool-home-"));
  try {
    const v = await toolVersion(input.forgeBin, home, work.dir); if ("code" in v) return { ok: false, failure: v };
    if (v.version !== FOUNDRY_VERSION) return { ok: false, failure: { code: "version_mismatch", detail: `forge ${v.version}; pinned ${FOUNDRY_VERSION}` } };
    const r = await runFixed(input.forgeBin, FORGE_ARGS(t.matchTest), { cwd: work.dir, timeoutMs: input.timeoutMs ?? 600_000, home });
    if (r.spawnError) return { ok: false, failure: { code: "tool_unavailable", detail: r.spawnError } };
    if (r.timedOut) return { ok: false, failure: { code: "timeout", detail: "forge test timed out" } };
    const results = parseForgeJson(r.stdout);
    if ("code" in results) return { ok: false, failure: /Compiler run failed|Error \(/.test(r.stderr + r.stdout) ? { code: "compile_failed", detail: r.stderr.slice(-2000) } : results };
    const stdout = r.stdout.split(work.dir).join("<snapshot>");
    return { ok: true, version: v.version, inputManifestSha256: inputManifestSha256(input.files), testSha256: inputManifestSha256(t.files), rawOutput: stdout, rawOutputSha256: sha256(stdout), durationMs: Date.now() - started, results };
  } finally { work.cleanup(); rmSync(home, { recursive: true, force: true }); }
}
