import { githubSourceFromEnv } from "./acquisition/github-source.js";
import { WorkerApiClient } from "./worker-api-client.js";
import { EXIT_REMOTE_CONFIG, EXIT_TOKEN_REJECTED, remoteWorkerSettings, runRemoteResearchWorker } from "./worker-remote.js";
import { redactWorkerTokens } from "./worker-tokens.js";

/**
 * Option D worker (WORKER_STORE=api): no database credential. Settings:
 * - WORKER_API_URL: the API's private-network address (https, or http to loopback / *.internal / *.flycast / fdaa::);
 * - WORKER_API_TOKEN: the run-scoped capability token (minted by an operator; delivered as a Fly secret, see db/drafts/d-worker-api);
 * - the same analysis switches as the direct worker (STRUCTURAL_ANALYSIS_ENABLED, SLITHER_SCAN_ENABLED, ...).
 * Exit codes: 0 the run finished (or a signal stopped the worker); 64 configuration refused (including ANY database URL present);
 * 77 the token was refused (expired, revoked or unknown).
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
  // the token stays in this process's memory only: child processes (the pinned Slither runner already gets a minimal environment) never inherit it
  delete process.env.WORKER_API_TOKEN;
  const workerId = `remote-${process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local"}`;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  log("info", "remote_worker_starting", { worker: workerId, api: new URL(settings.apiUrl).origin, token_id: settings.tokenId });
  try {
    const client = new WorkerApiClient({ baseUrl: settings.apiUrl, token: settings.token });
    const result = await runRemoteResearchWorker(client, workerId, controller.signal, { source: githubSourceFromEnv() });
    if (result.stop === "token_rejected") { log("fatal", "worker_token_rejected", { token_id: settings.tokenId, code: result.detail }); process.exitCode = EXIT_TOKEN_REJECTED; }
    else log("info", result.stop === "run_finished" ? "scoped_run_finished_exiting" : "remote_worker_stopped", { token_id: settings.tokenId });
  } catch (error) {
    log("fatal", "worker_stopped", { error: error instanceof Error ? error.message : String(error) });
    if (!process.exitCode) process.exitCode = 1;
  }
}
