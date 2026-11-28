import { githubSourceFromEnv } from "./acquisition/github-source.js";
import { WorkerApiClient } from "./worker-api-client.js";
import { EXIT_REMOTE_CONFIG, EXIT_RUN_CANCELLED, EXIT_TOKEN_REJECTED, remoteWorkerSettings, runRemoteResearchWorker } from "./worker-remote.js";
import { redactWorkerTokens } from "./worker-tokens.js";

/**
 * Option D worker (WORKER_STORE=api): no database credential. Settings:
 * - WORKER_API_URL: the API's private-network address (https, or http to loopback / *.internal / *.flycast / fdaa::);
 * - WORKER_API_TOKEN_FILE: a file holding the run-scoped capability token (unlinked after reading where the mount allows), or "-" to read
 *   it from stdin. The token is NEVER accepted from an environment variable: WORKER_API_TOKEN set refuses the start (D6);
 * - the same analysis switches as the direct worker (STRUCTURAL_ANALYSIS_ENABLED, SLITHER_SCAN_ENABLED, ...).
 * Exit codes: 0 the run finished (or a signal stopped the worker); 64 configuration refused (including ANY database URL present, or a
 * token in the environment); 77 the token was refused (expired, revoked or unknown); 78 the run was cancelled or failed.
 */
const log = (level: string, msg: string, extra: Record<string, unknown> = {}) => console.log(redactWorkerTokens(JSON.stringify({ level, msg, ...extra })));
let settings: ReturnType<typeof remoteWorkerSettings> | null = null;
try {
  settings = remoteWorkerSettings(process.env);
} catch (error) {
  log("fatal", "remote_worker_config_refused", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = EXIT_REMOTE_CONFIG;
}
if (settings) {
  // the token lives in this process's memory only; it was never in the environment, so no child process can inherit it
  const workerId = `remote-${process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local"}`;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  log("info", "remote_worker_starting", { worker: workerId, api: new URL(settings.apiUrl).origin, token_id: settings.tokenId, token_source: settings.tokenSource, token_file_removed: settings.tokenFileRemoved });
  try {
    const client = new WorkerApiClient({ baseUrl: settings.apiUrl, token: settings.token });
    const result = await runRemoteResearchWorker(client, workerId, controller.signal, { source: githubSourceFromEnv() });
    if (result.stop === "token_rejected") { log("fatal", "worker_token_rejected", { token_id: settings.tokenId, code: result.detail }); process.exitCode = EXIT_TOKEN_REJECTED; }
    else if (result.stop === "run_cancelled") { log("fatal", "run_cancelled_stopping", { token_id: settings.tokenId, run_status: result.detail }); process.exitCode = EXIT_RUN_CANCELLED; }
    else log("info", result.stop === "run_finished" ? "scoped_run_finished_exiting" : "remote_worker_stopped", { token_id: settings.tokenId });
  } catch (error) {
    log("fatal", "worker_stopped", { error: error instanceof Error ? error.message : String(error) });
    if (!process.exitCode) process.exitCode = 1;
  }
}
