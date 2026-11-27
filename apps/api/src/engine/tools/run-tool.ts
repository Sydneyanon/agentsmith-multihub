import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { assertSideEffectAllowed } from "../effects.js";

/**
 * Shared, reproducible execution for external audit tools. The sealed snapshot is materialised byte for byte into a fresh private
 * directory (paths validated: no absolute paths, no `..`), the tool runs with a fixed argument list, a minimal environment (PATH and a
 * private HOME only; no proxy, token or credential variables are passed) and a hard timeout, and the directory is always deleted.
 * Every call is refused inside a dry run (subprocess and filesystem effects).
 */
export type ToolFailureCode = "tool_unavailable" | "version_mismatch" | "compile_failed" | "timeout" | "output_invalid" | "crashed" | "input_invalid";
export type ToolFailure = { code: ToolFailureCode; detail: string };
export type Exec = { exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; spawnError: string | null; durationMs: number };

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export function inputManifestSha256(files: ReadonlyArray<{ path: string; content: Buffer }>): string {
  return sha256([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}\t${sha256(f.content)}\n`).join(""));
}

export function materialise(files: ReadonlyArray<{ path: string; content: Buffer }>): { dir: string; cleanup: () => void } {
  assertSideEffectAllowed("filesystem", `materialise ${files.length} snapshot files`);
  const dir = mkdtempSync(join(tmpdir(), "agentsmith-tool-"));
  try {
    for (const f of files) {
      const rel = normalize(f.path);
      if (rel.startsWith(sep) || rel.split(sep).includes("..") || /^[A-Za-z]:/.test(rel)) throw new Error(`unsafe snapshot path ${f.path}`);
      const abs = join(dir, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, f.content, { flag: "wx" });
    }
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Relative to this module; a variable so the production compile never follows it (the tool host is excluded from that build). */
const TOOL_HOST = "./tool-host/exec.js";
export async function loadToolHost(spec: string = TOOL_HOST): Promise<{ execFixed: (bin: string, args: readonly string[], opts: { cwd: string; timeoutMs: number; home: string; maxBuffer?: number }) => Promise<Exec> }> {
  try { return await import(new URL(spec, import.meta.url).href); }
  catch { throw new Error("tool execution is not part of this build (production images cannot start processes; see A39)"); }
}

export async function runFixed(bin: string, args: readonly string[], opts: { cwd: string; timeoutMs: number; home: string; maxBuffer?: number }): Promise<Exec> {
  assertSideEffectAllowed("subprocess", bin);
  let host: Awaited<ReturnType<typeof loadToolHost>>;
  try { host = await loadToolHost(); } catch (e) { return { exitCode: null, signal: null, stdout: "", stderr: (e as Error).message, timedOut: false, spawnError: "TOOL_HOST_UNAVAILABLE", durationMs: 0 }; }
  return host.execFixed(bin, args, opts);
}

/** Reads `<bin> --version`; returns the first version-looking token or a failure. */
export async function toolVersion(bin: string, home: string, cwd: string): Promise<{ version: string } | ToolFailure> {
  const r = await runFixed(bin, ["--version"], { cwd, timeoutMs: 30_000, home });
  if (r.spawnError) return { code: "tool_unavailable", detail: `${bin}: ${r.spawnError}` };
  const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  return m ? { version: m[1]! } : { code: "tool_unavailable", detail: `${bin} --version printed no version` };
}
