import { readFileSync } from "node:fs";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture } from "../acquisition/testing/git-fixture.js";
import { WorkerApiClient } from "../worker-api-client.js";
import { EXIT_REMOTE_CONFIG, EXIT_RUN_CANCELLED, EXIT_TOKEN_REJECTED, remoteWorkerSettings, runRemoteResearchWorker } from "../worker-remote.js";
import { redactWorkerTokens } from "../worker-tokens.js";

/**
 * Test-only twin of worker-remote-main.ts, run as a SEPARATE PROCESS by the integration tests with a scrubbed environment (no database
 * URL of any kind, no token: it comes from WORKER_API_TOKEN_FILE exactly as in production). The single difference from the production
 * entry point is the repository source: a real local git fixture (REMOTE_CHILD_FIXTURE, a JSON file of files) served by FakeSource
 * instead of GitHub, so no network beyond the API is used. REMOTE_CHILD_PAUSE_FILE (tests only): before running a step whose key is
 * listed in REMOTE_CHILD_PAUSE_BEFORE, the child writes the step id to that file and waits, so a test can kill it mid-step.
 */
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(redactWorkerTokens(JSON.stringify({ msg, ...extra })));
let settings: ReturnType<typeof remoteWorkerSettings>;
try { settings = remoteWorkerSettings(process.env); } catch (error) {
  log("remote_worker_config_refused", { error: (error as Error).message }); process.exit(EXIT_REMOTE_CONFIG);
}
// what a process on this machine could read about us: the kernel's copy of our environment holds no token
const environ = readFileSync("/proc/self/environ", "utf8");
log("started", { token_id: settings.tokenId, token_source: settings.tokenSource, token_file_removed: settings.tokenFileRemoved, environ_has_token: environ.includes(settings.token) || /WORKER_API_TOKEN=/.test(environ) });
const spec = JSON.parse(readFileSync(process.env.REMOTE_CHILD_FIXTURE!, "utf8")) as { owner: string; repo: string; files: Array<{ path: string; content: string }> };
const fx = buildGitFixture(spec.files, { owner: spec.owner, repo: spec.repo });
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), Number(process.env.REMOTE_CHILD_DEADLINE_MS ?? 90_000));
const pauseBefore = new Set((process.env.REMOTE_CHILD_PAUSE_BEFORE ?? "").split(",").filter(Boolean));
try {
  const client = new WorkerApiClient({ baseUrl: settings.apiUrl, token: settings.token, backoffMs: 50 });
  if (pauseBefore.size) {
    const original = client.claimNext.bind(client);
    client.claimNext = async (keys) => {
      const s = await original(keys);
      if (s && pauseBefore.has(s.step_key)) {
        const { existsSync, writeFileSync } = await import("node:fs");
        const pauseFile = process.env.REMOTE_CHILD_PAUSE_FILE!;
        writeFileSync(pauseFile, s.id);
        log("paused", { step: s.step_key, step_id: s.id });
        pauseBefore.delete(s.step_key); // pause once per key
        while (existsSync(pauseFile)) await new Promise((r) => setTimeout(r, 50)); // until the test removes the file (or kills us)
        log("resumed", { step: s.step_key });
      }
      return s;
    };
  }
  const r = await runRemoteResearchWorker(client, "remote-child", controller.signal, { source: new FakeSource(fx), pollMs: 50, log: (level, message, fields) => log(`${level}:${message}`, fields ?? {}) });
  log("stopped", { stop: r.stop, detail: r.detail ?? null, db_env_present: Object.keys(process.env).filter((k) => /DATABASE|^PG/.test(k)) });
  process.exitCode = r.stop === "token_rejected" ? EXIT_TOKEN_REJECTED : r.stop === "run_cancelled" ? EXIT_RUN_CANCELLED : r.stop === "run_finished" ? 0 : 1;
} finally { clearTimeout(deadline); fx.cleanup(); }
