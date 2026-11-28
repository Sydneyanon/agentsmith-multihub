import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Bounded execution of the API's own deterministic analysis and validators (option D: D1, D3, D4). The work runs in a short-lived
 * child process (compute-child.ts), never on the API's event loop, so a hostile snapshot cannot stall operator routes. Limits, each
 * enforced by the parent: input size (refused before starting), CPU time (polled from /proc, killed on excess), wall time (killed),
 * heap (--max-old-space-size), output size, and concurrency (a process-wide cap; a request that cannot start in time is refused as
 * busy, retryably). The child gets a minimal environment: no database URL, no token, no secrets.
 */
export type ComputeLimits = {
  /** largest accepted request (the snapshot's Solidity text plus stored hypotheses), bytes; default 32 MiB */ maxInputBytes: number;
  /** CPU time of the child, ms; default 20 s */ cpuMs: number;
  /** wall time of the child, ms; default 30 s */ wallMs: number;
  /** V8 old-space heap of the child, MiB; default 512 */ maxHeapMb: number;
  /** largest accepted answer, bytes; default 64 MiB */ maxOutputBytes: number;
  /** concurrent children per API process; default 2 */ maxConcurrent: number;
  /** how long a request waits for a free slot before it is refused as busy, ms; default 10 s */ queueMs: number;
};
export const DEFAULT_COMPUTE_LIMITS: ComputeLimits = { maxInputBytes: 32 * 1024 * 1024, cpuMs: 20_000, wallMs: 30_000, maxHeapMb: 512, maxOutputBytes: 64 * 1024 * 1024, maxConcurrent: 2, queueMs: 10_000 };

export type ComputeLimitCode = "input_too_large" | "cpu_limit" | "wall_limit" | "memory_limit" | "output_too_large" | "compute_failed";
export class ComputeLimitError extends Error {
  constructor(readonly code: ComputeLimitCode, message: string, readonly usedMs = 0) { super(message); this.name = "ComputeLimitError"; }
}
export class ComputeBusyError extends Error {
  constructor() { super("the API's analysis capacity is busy; retry later"); this.name = "ComputeBusyError"; }
}

const here = fileURLToPath(import.meta.url);
const typescript = here.endsWith(".ts");
const childScript = here.replace(/bounded-compute\.(ts|js)$/, `compute-child.${typescript ? "ts" : "js"}`);
const tsxLoader = (): string => createRequire(import.meta.url).resolve("tsx");

/** CPU ticks of a live process from /proc (Linux); null where unavailable. */
function cpuMsOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100; // utime + stime, in clock ticks (USER_HZ = 100 on Linux)
  } catch { return null; }
}

export class BoundedCompute {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  readonly limits: ComputeLimits;
  constructor(limits: Partial<ComputeLimits> = {}) { this.limits = { ...DEFAULT_COMPUTE_LIMITS, ...limits }; }

  private async slot(): Promise<() => void> {
    if (this.running >= this.limits.maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { const i = this.waiting.indexOf(go); if (i >= 0) this.waiting.splice(i, 1); reject(new ComputeBusyError()); }, this.limits.queueMs);
        const go = () => { clearTimeout(timer); resolve(); };
        this.waiting.push(go);
      });
    }
    this.running += 1;
    return () => { this.running -= 1; this.waiting.shift()?.(); };
  }

  /** Runs one task in a bounded child. Throws ComputeLimitError on any limit (with the time used) and ComputeBusyError when saturated. */
  async run<T>(task: "analyze" | "challenge", payload: Record<string, unknown>, limits: Partial<ComputeLimits> = {}): Promise<{ result: T; wallMs: number; cpuMs: number }> {
    const L = { ...this.limits, ...limits };
    const input = Buffer.from(JSON.stringify({ task, ...payload }), "utf8");
    if (input.length > L.maxInputBytes) throw new ComputeLimitError("input_too_large", `the analysis input is ${input.length} bytes; the limit is ${L.maxInputBytes}`);
    const release = await this.slot();
    const started = Date.now();
    try {
      return await new Promise((resolve, reject) => {
        const args = [`--max-old-space-size=${L.maxHeapMb}`, ...(typescript ? ["--import", tsxLoader()] : []), childScript];
        const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV ?? "production" } });
        const out: Buffer[] = []; let outBytes = 0; let err = ""; let killed: ComputeLimitError | null = null; let lastCpu = 0;
        const kill = (e: ComputeLimitError) => { if (!killed) { killed = e; child.kill("SIGKILL"); } };
        const wall = setTimeout(() => kill(new ComputeLimitError("wall_limit", `the analysis exceeded ${L.wallMs} ms of wall time`, L.wallMs)), L.wallMs);
        const poll = setInterval(() => { const c = child.pid ? cpuMsOf(child.pid) : null; if (c !== null) { lastCpu = c; if (c > L.cpuMs) kill(new ComputeLimitError("cpu_limit", `the analysis exceeded ${L.cpuMs} ms of CPU time`, Date.now() - started)); } }, 25);
        child.stdout.on("data", (d: Buffer) => { outBytes += d.length; if (outBytes > L.maxOutputBytes) kill(new ComputeLimitError("output_too_large", `the analysis answer exceeded ${L.maxOutputBytes} bytes`, Date.now() - started)); else out.push(d); });
        child.stderr.on("data", (d: Buffer) => { if (err.length < 4000) err += d.toString("utf8"); });
        child.on("error", (e) => kill(new ComputeLimitError("compute_failed", `the analysis process could not start: ${e.message}`)));
        child.on("close", (code, signal) => {
          clearTimeout(wall); clearInterval(poll);
          const wallMs = Date.now() - started;
          if (killed) { (killed as { usedMs: number }).usedMs = wallMs; return reject(killed); }
          if (/heap out of memory|Allocation failed/i.test(err)) return reject(new ComputeLimitError("memory_limit", `the analysis exceeded its ${L.maxHeapMb} MiB heap`, wallMs));
          let parsed: { ok: boolean; result?: T; error?: string; cpu_ms?: number };
          try { parsed = JSON.parse(Buffer.concat(out).toString("utf8")); } catch { return reject(new ComputeLimitError("compute_failed", `the analysis process ended without an answer (exit ${code ?? signal})`, wallMs)); }
          if (!parsed.ok) return reject(new ComputeLimitError("compute_failed", `the analysis failed: ${parsed.error ?? "unknown"}`, wallMs));
          const cpuMs = parsed.cpu_ms ?? lastCpu;
          if (cpuMs > L.cpuMs) return reject(new ComputeLimitError("cpu_limit", `the analysis exceeded ${L.cpuMs} ms of CPU time`, wallMs));
          resolve({ result: parsed.result as T, wallMs, cpuMs });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
      });
    } finally { release(); }
  }
}
