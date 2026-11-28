import { createServer } from "node:http";
import { Pool } from "pg";
import { config } from "./config.js";
import { buildApp } from "./app.js";
import { buildPoolConfig, stderrWarning } from "./db-config.js";
import { runRoleGuard } from "./db-roles.js";
import { API_APP_NAME } from "./engine-status.js";

const pool = config.databaseUrl ? new Pool(buildPoolConfig(process.env, { max: 5, onWarning: stderrWarning, applicationName: API_APP_NAME })) : undefined;

export function buildServer() {
  return buildApp({ pool, apiBearerToken: config.apiBearerToken, hubAllowedHosts: config.hubAllowedHosts, trustedProxyCidrs: config.trustedProxyCidrs, logLevel: config.logLevel, engineInfo: { dataKind: config.dataKind },
    // option D: the internal worker API answers ONLY on its private listener's port, never on the public one
    ...(config.workerApi.enabled ? { workerApi: { privateListenerPort: config.workerApi.port } } : {}) });
}

const app = buildServer();
// An idle client killed by the database (restart, auto-pause) must not crash the process with an unhandled event.
pool?.on("error", (error) => app.log.error({ err: error }, "idle database client error"));
try {
  await app.listen({ host: config.host, port: config.port });
  if (config.workerApi.enabled) {
    if (config.workerApi.port === config.port) throw new Error("WORKER_API_PORT must differ from PORT: the worker API is served on its own private listener");
    // Same application, second socket: bound to the private (6PN) address on a port no [[services]] entry exposes publicly.
    const internal = createServer((req, res) => app.server.emit("request", req, res));
    await new Promise<void>((resolve, reject) => { internal.once("error", reject); internal.listen(config.workerApi.port, config.workerApi.host, () => resolve()); });
    app.log.info({ host: config.workerApi.host, port: config.workerApi.port }, "internal worker API listening on the private listener only");
  }
  if (config.environment === "production" && config.hubAllowedHosts.length === 0) app.log.warn("HUB_ALLOWED_HOSTS is not set: any Host header is served in production");
  // After listening and not awaited: an unreachable or paused database must never delay or prevent boot (liveness and honest readiness first).
  if (pool && config.environment === "production") {
    void runRoleGuard(pool, {
      require: config.requireRestrictedDbRole,
      warn: (m) => app.log.warn(m),
      fatal: (m) => {
        app.log.fatal(m);
        setTimeout(() => process.exit(1), 5000).unref(); // never wait indefinitely for in-flight requests
        void app.close().finally(() => process.exit(1));
      },
    });
  }
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
