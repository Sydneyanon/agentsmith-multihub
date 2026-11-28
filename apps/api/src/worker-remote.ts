import { ACQUIRE_STEP_KEY, processAcquireRepositoryStep } from "./acquisition/step.js";
import type { RepositorySource } from "./acquisition/github-source.js";
import { readFileSync, unlinkSync } from "node:fs";
import { withHeartbeat } from "./analysis/solidity/step.js";
import { processResearchSlitherScanStep } from "./analysis/solidity/slither-step.js";
import { isResearchSlitherStep } from "./analysis/solidity/slither-record.js";
import { ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY } from "./analysis/solidity/keys.js";
import { RESEARCH_STEP_KEYS } from "./worker-api.js";
import { SLITHER_STEP_KEY } from "./analysis/solidity/keys.js";
import { slitherScanClaimable } from "./analysis/solidity/slither-step.js";
import { RunTerminalError, WorkerApiClient, WorkerTokenRejectedError } from "./worker-api-client.js";
import { intakeStepKeys } from "./worker-runtime.js";
import { runWorkerLoop, defaultLog, type WorkerLoopOptions } from "./worker-loop.js";
import { LeaseLostError } from "./step-errors.js";
import type { ClaimedStep } from "./worker.js";
import { parseWorkerToken, redactWorkerTokens } from "./worker-tokens.js";
import { progressFor } from "./step-progress.js";

/**
 * Option D's worker runtime: the same loop (runWorkerLoop) and the same step handlers as the direct worker, with the database replaced
 * by the API client. It claims only `repository_research` steps of the token's run; the API enforces that again on every call.
 */
export const EXIT_REMOTE_CONFIG = 64;
export const EXIT_TOKEN_REJECTED = 77;
/** D6: the run was cancelled (or failed) while this worker held a token for it: the worker stops at once and writes nothing more. */
export const EXIT_RUN_CANCELLED = 78;

export type RemoteWorkerSettings = { apiUrl: string; token: string; tokenId: string };

/** Environment names that would hand a remote worker a database connection. Any of them present refuses the start. */
const DATABASE_ENV = /^(DATABASE_URL|WORKER_DATABASE_URL|DIRECT_DATABASE_URL|TEST_DATABASE_URL|PG(HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLKEY|SSLCERT))$|DATABASE_URL$|_DB_URL$/;
const POSTGRES_VALUE = /^postgres(ql)?:\/\//i;

export class RemoteWorkerConfigError extends Error {
  constructor(message: string) { super(message); this.name = "RemoteWorkerConfigError"; }
}

/**
 * Parses WORKER_STORE=api settings. Refuses any database URL or libpq connection variable in the environment. Never echoes the token.
 *
 * D6: the token is NEVER taken from the environment. It is read once from the file WORKER_API_TOKEN_FILE (or from stdin when that is
 * "-"), and the file is unlinked afterwards where possible. A WORKER_API_TOKEN variable refuses the start (it would sit in
 * /proc/<pid>/environ for the life of the process, readable by anything that runs as the same user). `readStdin` is injectable for tests.
 */
export function remoteWorkerSettings(env: Record<string, string | undefined>, io: { readStdin?: () => string; unlink?: (path: string) => void; readFile?: (path: string) => string } = {}): RemoteWorkerSettings & { tokenSource: string; tokenFileRemoved: boolean | null } {
  if (env.WORKER_STORE !== "api") throw new RemoteWorkerConfigError("remote mode requires WORKER_STORE=api");
  const dbVars = Object.entries(env).filter(([k, v]) => v !== undefined && v !== "" && (DATABASE_ENV.test(k) || POSTGRES_VALUE.test(v.trim()))).map(([k]) => k);
  if (dbVars.length) throw new RemoteWorkerConfigError(`refusing to start in remote mode: database connection settings are present (${dbVars.sort().join(", ")}); a remote worker must hold no database credential`);
  if (env.WORKER_API_TOKEN !== undefined) throw new RemoteWorkerConfigError("refusing to start in remote mode: WORKER_API_TOKEN is set in the environment; deliver the token in a file (WORKER_API_TOKEN_FILE) or on stdin (WORKER_API_TOKEN_FILE=-), never in an environment variable");
  const raw = env.WORKER_API_URL?.trim();
  if (!raw) throw new RemoteWorkerConfigError("WORKER_API_URL is required in remote mode");
  let url: URL;
  try { url = new URL(raw); } catch { throw new RemoteWorkerConfigError("WORKER_API_URL is not a URL"); }
  if (url.username || url.password || url.search || url.hash) throw new RemoteWorkerConfigError("WORKER_API_URL must not carry credentials, a query or a fragment");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const privateHost = host === "localhost" || host === "127.0.0.1" || host === "::1" || /\.(internal|flycast)$/.test(host) || /^fdaa:/i.test(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) throw new RemoteWorkerConfigError("WORKER_API_URL must be https, or http only to a loopback or Fly private-network (.internal, .flycast, fdaa::) host");
  const file = env.WORKER_API_TOKEN_FILE?.trim();
  if (!file) throw new RemoteWorkerConfigError("WORKER_API_TOKEN_FILE is required in remote mode (a file holding the token, or - for stdin)");
  let text: string;
  try { text = file === "-" ? (io.readStdin ?? (() => readFileSync(0, "utf8")))() : (io.readFile ?? ((p: string) => readFileSync(p, "utf8")))(file); }
  catch (error) { throw new RemoteWorkerConfigError(`the token could not be read from ${file === "-" ? "stdin" : "WORKER_API_TOKEN_FILE"} (${(error as NodeJS.ErrnoException).code ?? "error"})`); }
  let removed: boolean | null = null;
  if (file !== "-") { try { (io.unlink ?? unlinkSync)(file); removed = true; } catch { removed = false; } } // a read-only mount (e.g. a secret volume) cannot be unlinked
  const token = text.trim();
  const parsed = parseWorkerToken(token);
  if (!parsed) throw new RemoteWorkerConfigError("the token file does not hold a worker capability token");
  // D6 on platforms that also export secrets as environment variables (e.g. a Fly secret delivered as a file may ALSO be in the machine
  // environment): the token must not be in this process's environment under ANY name. Fail closed and name the variable, never the value.
  const leaked = Object.entries(env).filter(([, v]) => typeof v === "string" && v.trim() === token).map(([k]) => k);
  if (leaked.length) throw new RemoteWorkerConfigError(`refusing to start: the worker token is also present in the environment as ${leaked.join(", ")}; deliver it only as a file`);
  return { apiUrl: url.toString(), token, tokenId: parsed.tokenId, tokenSource: file === "-" ? "stdin" : "file", tokenFileRemoved: removed };
}

/** The step keys a remote worker asks for: the research subset of what the switches enable (the same switches as the direct worker). */
export function remoteStepKeys(env: Record<string, string | undefined>): string[] {
  // slither_scan is also an engine-loop key: a remote worker asks for it only when the research Slither stage itself is claimable
  return intakeStepKeys(env).filter((k) => (RESEARCH_STEP_KEYS as readonly string[]).includes(k) && (k !== SLITHER_STEP_KEY || slitherScanClaimable(env)));
}

export type RemoteStop = "aborted" | "run_finished" | "run_cancelled" | "token_rejected";

/**
 * One claimed step. Acquisition and the optional Slither stage run here (they handle untrusted archives and an external tool); for the
 * analysis, challenge and dossier steps the worker computes NOTHING that is trusted: it names the run's sealed snapshot and the API
 * recomputes the analysis, runs the validators and builds the dossier itself (D1, D3), while this worker keeps the lease alive.
 */
export async function executeRemoteStep(client: WorkerApiClient, workerId: string, step: ClaimedStep,
  options: { source: RepositorySource; env?: Record<string, string | undefined>; heartbeatMs?: number }): Promise<void> {
  const env = options.env ?? process.env; const beat = options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {};
  client.scopeToStep(step.id); client.adoptStep(step);
  try {
    if (step.step_key === ACQUIRE_STEP_KEY) await processAcquireRepositoryStep({ worker: client, workerId, source: options.source, store: client, ...beat }, step);
    else if (isResearchSlitherStep(step)) await processResearchSlitherScanStep({ worker: client, workerId, store: client, reads: client, env, ...beat }, step);
    else if (API_DERIVED[step.step_key]) {
      const snap = await client.sealedSnapshot(step.workflow_run_id);
      // the worker computes nothing here: it reports only that the API is now deriving the step (one request, no count to report)
      const progress = progressFor(client, step.id); progress.report("awaiting_api_derivation", 0, 1, "api_requests"); await progress.flush();
      await withHeartbeat({ worker: client, ...beat }, step, () => client.complete(step.id, { status: API_DERIVED[step.step_key]!, snapshot_id: snap.snapshotId }));
    } else throw new Error(`step ${step.step_key} is not served to a remote worker`);
  } finally { client.scopeToStep(null); }
}
const API_DERIVED: Record<string, string> = { [ANALYZE_STEP_KEY]: "structure_analyzed", [CHALLENGE_STEP_KEY]: "leads_challenged", [DOSSIER_STEP_KEY]: "dossier_built" };

export async function runRemoteResearchWorker(
  client: WorkerApiClient, workerId: string, signal: AbortSignal,
  options: WorkerLoopOptions & { source: RepositorySource; env?: Record<string, string | undefined>; heartbeatMs?: number },
): Promise<{ stop: RemoteStop; detail?: string }> {
  const env = options.env ?? process.env;
  const inner = new AbortController();
  const abort = () => inner.abort(); signal.addEventListener("abort", abort, { once: true });
  let stop: { stop: RemoteStop; detail?: string } = { stop: "aborted" };
  const log = options.log ?? defaultLog;
  const halt = (error: unknown): boolean => {
    if (error instanceof WorkerTokenRejectedError) { stop = { stop: "token_rejected", detail: error.code }; inner.abort(); return true; }
    if (error instanceof RunTerminalError) { stop = error.runStatus === "succeeded" || error.runStatus === null ? { stop: "run_finished" } : { stop: "run_cancelled", detail: error.runStatus }; inner.abort(); return true; }
    return false;
  };
  try {
    await runWorkerLoop({
      reapExhaustedLeases: async () => 0, // the API reaps; a run-scoped worker never touches other runs' leases
      claimNext: async () => {
        try { return await client.claimNext(remoteStepKeys(env)); } catch (error) { if (halt(error)) return null; throw error; }
      },
      fail: async (stepId, reason, retryable) => {
        try { await client.fail(stepId, redactWorkerTokens(reason), retryable); } catch (error) { if (halt(error)) throw new LeaseLostError("token no longer valid; the step is recovered by lease expiry"); throw error; }
      },
      execute: async (step) => {
        try { await executeRemoteStep(client, workerId, step, { source: options.source, env, ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}) }); } catch (error) {
          // a rejected token or a finished run ends the worker; the step (if still ours) is recovered by lease expiry, never failed by us
          if (halt(error)) throw new LeaseLostError(`stopping: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
      maxAttempts: client.maxAttempts,
    }, inner.signal, { ...options, log });
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return stop;
}
