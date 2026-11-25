import { Pool } from "pg";
import { config } from "./config.js";
import { buildPoolConfig } from "./db-config.js";
import { attachPoolErrorHandler, runIntakeWorker } from "./worker-runtime.js";

if (!config.databaseUrl) throw new Error("DATABASE_URL is required for the worker process");

const pool = new Pool(buildPoolConfig(process.env, { max: 3 }));

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
