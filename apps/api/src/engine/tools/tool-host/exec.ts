import { execFile } from "node:child_process";

/**
 * The ONLY module of the engine that starts processes. It is excluded from the production build (tsconfig.build.json), so the deployed
 * hub image cannot spawn a process at all; a worker environment that is approved to run audit tools (A39) runs from source or a
 * separate build that includes it. Callers load it dynamically through run-tool.ts, which applies the dry-run guard first.
 */
export type Exec = { exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; spawnError: string | null; durationMs: number };

export function execFixed(bin: string, args: readonly string[], opts: { cwd: string; timeoutMs: number; home: string; maxBuffer?: number }): Promise<Exec> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(bin, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs, killSignal: "SIGKILL", maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: opts.home, LANG: "C.UTF-8" }, windowsHide: true },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string }) | null;
        const spawnError = e && typeof e.code === "string" ? e.code : null;
        resolve({ exitCode: e ? (typeof e.code === "number" ? e.code : null) : 0, signal: e?.signal ?? null, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(e?.killed && e.signal === "SIGKILL"), spawnError, durationMs: Date.now() - started });
      });
  });
}
