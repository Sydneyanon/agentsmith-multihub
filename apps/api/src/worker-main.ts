import { Pool } from "pg";
import { config } from "./config.js";
import { attachPoolErrorHandler, runIntakeWorker } from "./worker-runtime.js";

if (!config.databaseUrl) throw new Error("DATABASE_URL is required for the worker process");

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 3,
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
  ...(config.environment === "production" ? { ssl: { rejectUnauthorized: true } } : {}),
});

attachPoolErrorHandler(pool);

const workerId = `intake-${process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local"}`;
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runIntakeWorker(pool, workerId, controller.signal);
} finally {
  await pool.end();
}
