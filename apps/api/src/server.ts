import { Pool } from "pg";
import { config } from "./config.js";
import { buildApp } from "./app.js";
import { buildPoolConfig, stderrWarning } from "./db-config.js";

const pool = config.databaseUrl ? new Pool(buildPoolConfig(process.env, { max: 5, onWarning: stderrWarning })) : undefined;

export function buildServer() {
  return buildApp({ pool, apiBearerToken: config.apiBearerToken, hubAllowedHosts: config.hubAllowedHosts, logLevel: config.logLevel });
}

const app = buildServer();
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
