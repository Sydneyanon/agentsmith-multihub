import { readFileSync } from "node:fs";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture } from "../acquisition/testing/git-fixture.js";
import { WorkerApiClient } from "../worker-api-client.js";
import { EXIT_REMOTE_CONFIG, EXIT_TOKEN_REJECTED, remoteWorkerSettings, runRemoteResearchWorker } from "../worker-remote.js";
import { redactWorkerTokens } from "../worker-tokens.js";

/**
 * Test-only twin of worker-remote-main.ts, run as a SEPARATE PROCESS by worker-api.integration.test.ts with a scrubbed environment
 * (no database URL of any kind). The single difference from the production entry point is the repository source: a real local git
 * fixture (REMOTE_CHILD_FIXTURE, a JSON file of files) served by FakeSource instead of GitHub, so no network beyond the API is used.
 */
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(redactWorkerTokens(JSON.stringify({ msg, ...extra })));
let settings: ReturnType<typeof remoteWorkerSettings>;
try { settings = remoteWorkerSettings(process.env); } catch (error) {
  log("remote_worker_config_refused", { error: (error as Error).message }); process.exit(EXIT_REMOTE_CONFIG);
}
delete process.env.WORKER_API_TOKEN;
const spec = JSON.parse(readFileSync(process.env.REMOTE_CHILD_FIXTURE!, "utf8")) as { owner: string; repo: string; files: Array<{ path: string; content: string }> };
const fx = buildGitFixture(spec.files, { owner: spec.owner, repo: spec.repo });
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 90_000);
try {
  const client = new WorkerApiClient({ baseUrl: settings.apiUrl, token: settings.token, backoffMs: 50 });
  const r = await runRemoteResearchWorker(client, "remote-child", controller.signal, { source: new FakeSource(fx), pollMs: 50, log: (level, message, fields) => log(`${level}:${message}`, fields ?? {}) });
  log("stopped", { stop: r.stop, detail: r.detail ?? null, db_env_present: Object.keys(process.env).filter((k) => /DATABASE|^PG/.test(k)) });
  process.exitCode = r.stop === "token_rejected" ? EXIT_TOKEN_REJECTED : r.stop === "run_finished" ? 0 : 1;
} finally { clearTimeout(deadline); fx.cleanup(); }
