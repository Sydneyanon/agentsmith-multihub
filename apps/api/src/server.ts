import { Pool } from "pg";
import { config } from "./config.js";
import { buildApp } from "./app.js";
import { buildPoolConfig, stderrWarning } from "./db-config.js";
import { runRoleGuard } from "./db-roles.js";

const pool = config.databaseUrl ? new Pool(buildPoolConfig(process.env, { max: 5, onWarning: stderrWarning })) : undefined;

export function buildServer() {
  return buildApp({ pool, apiBearerToken: config.apiBearerToken, hubAllowedHosts: config.hubAllowedHosts, trustedProxyCidrs: config.trustedProxyCidrs, logLevel: config.logLevel });
}

const app = buildServer();
try {
  await app.listen({ host: config.host, port: config.port });
  // After listening and not awaited: an unreachable or paused database must never delay or prevent boot (liveness and honest readiness first).
  if (pool && config.environment === "production") {
    void runRoleGuard(pool, {
      require: config.requireRestrictedDbRole,
      warn: (m) => app.log.warn(m),
      fatal: (m) => { app.log.fatal(m); void app.close().finally(() => process.exit(1)); },
    });
  }
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
