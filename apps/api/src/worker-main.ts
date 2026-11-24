import { Pool } from "pg";
import { config } from "./config.js";
import { runIntakeWorker } from "./worker-runtime.js";

if (!config.databaseUrl) throw new Error("DATABASE_URL is required for the worker process");

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 3,
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
  ...(config.environment === "production" ? { ssl: { rejectUnauthorized: true } } : {}),
});

const workerId = `intake-${process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local"}`;
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

try {
  await runIntakeWorker(pool, workerId);
} finally {
  if (stopping) await pool.end();
}
