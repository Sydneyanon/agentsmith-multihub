import { ACQUIRE_STEP_KEY, processAcquireRepositoryStep } from "./acquisition/step.js";
import type { RepositorySource } from "./acquisition/github-source.js";
import { dispatchAnalysisStep } from "./analysis/solidity/step.js";
import { RESEARCH_STEP_KEYS } from "./worker-api.js";
import { SLITHER_STEP_KEY } from "./analysis/solidity/keys.js";
import { slitherScanClaimable } from "./analysis/solidity/slither-step.js";
import { RunTerminalError, WorkerApiClient, WorkerTokenRejectedError } from "./worker-api-client.js";
import { intakeStepKeys } from "./worker-runtime.js";
import { runWorkerLoop, defaultLog, type WorkerLoopOptions } from "./worker-loop.js";
import { LeaseLostError } from "./step-errors.js";
import type { ClaimedStep } from "./worker.js";
import { parseWorkerToken, redactWorkerTokens } from "./worker-tokens.js";

/**
 * Option D's worker runtime: the same loop (runWorkerLoop) and the same step handlers as the direct worker, with the database replaced
 * by the API client. It claims only `repository_research` steps of the token's run; the API enforces that again on every call.
 */
export const EXIT_REMOTE_CONFIG = 64;
export const EXIT_TOKEN_REJECTED = 77;

export type RemoteWorkerSettings = { apiUrl: string; token: string; tokenId: string };

/** Environment names that would hand a remote worker a database connection. Any of them present refuses the start. */
const DATABASE_ENV = /^(DATABASE_URL|WORKER_DATABASE_URL|DIRECT_DATABASE_URL|TEST_DATABASE_URL|PG(HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLKEY|SSLCERT))$|DATABASE_URL$|_DB_URL$/;
const POSTGRES_VALUE = /^postgres(ql)?:\/\//i;

export class RemoteWorkerConfigError extends Error {
  constructor(message: string) { super(message); this.name = "RemoteWorkerConfigError"; }
}

/** Parses WORKER_STORE=api settings. Refuses any database URL or libpq connection variable in the environment. Never echoes the token. */
export function remoteWorkerSettings(env: Record<string, string | undefined>): RemoteWorkerSettings {
  if (env.WORKER_STORE !== "api") throw new RemoteWorkerConfigError("remote mode requires WORKER_STORE=api");
  const dbVars = Object.entries(env).filter(([k, v]) => v !== undefined && v !== "" && (DATABASE_ENV.test(k) || POSTGRES_VALUE.test(v.trim()))).map(([k]) => k);
  if (dbVars.length) throw new RemoteWorkerConfigError(`refusing to start in remote mode: database connection settings are present (${dbVars.sort().join(", ")}); a remote worker must hold no database credential`);
  const raw = env.WORKER_API_URL?.trim();
  if (!raw) throw new RemoteWorkerConfigError("WORKER_API_URL is required in remote mode");
  let url: URL;
  try { url = new URL(raw); } catch { throw new RemoteWorkerConfigError("WORKER_API_URL is not a URL"); }
  if (url.username || url.password || url.search || url.hash) throw new RemoteWorkerConfigError("WORKER_API_URL must not carry credentials, a query or a fragment");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const privateHost = host === "localhost" || host === "127.0.0.1" || host === "::1" || /\.(internal|flycast)$/.test(host) || /^fdaa:/i.test(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) throw new RemoteWorkerConfigError("WORKER_API_URL must be https, or http only to a loopback or Fly private-network (.internal, .flycast, fdaa::) host");
  const parsed = parseWorkerToken(env.WORKER_API_TOKEN?.trim());
  if (!parsed) throw new RemoteWorkerConfigError("WORKER_API_TOKEN is missing or is not a worker capability token");
  return { apiUrl: url.toString(), token: env.WORKER_API_TOKEN!.trim(), tokenId: parsed.tokenId };
}

/** The step keys a remote worker asks for: the research subset of what the switches enable (the same switches as the direct worker). */
export function remoteStepKeys(env: Record<string, string | undefined>): string[] {
  // slither_scan is also an engine-loop key: a remote worker asks for it only when the research Slither stage itself is claimable
  return intakeStepKeys(env).filter((k) => (RESEARCH_STEP_KEYS as readonly string[]).includes(k) && (k !== SLITHER_STEP_KEY || slitherScanClaimable(env)));
}

export type RemoteStop = "aborted" | "run_finished" | "token_rejected";

/** One claimed step through the SAME handlers the direct worker dispatches to, with the client as their port. */
export async function executeRemoteStep(client: WorkerApiClient, workerId: string, step: ClaimedStep,
  options: { source: RepositorySource; env?: Record<string, string | undefined>; heartbeatMs?: number }): Promise<void> {
  const env = options.env ?? process.env; const beat = options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {};
  client.scopeToStep(step.id);
  try {
    if (step.step_key === ACQUIRE_STEP_KEY) await processAcquireRepositoryStep({ worker: client, workerId, source: options.source, store: client, ...beat }, step);
    else if (!(await dispatchAnalysisStep({ worker: client, workerId, store: client, reads: client, env, ...beat }, step))) {
      throw new Error(`step ${step.step_key} is not served to a remote worker`);
    }
  } finally { client.scopeToStep(null); }
}

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
    if (error instanceof RunTerminalError) { stop = { stop: "run_finished" }; inner.abort(); return true; }
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
