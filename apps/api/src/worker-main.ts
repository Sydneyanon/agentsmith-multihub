import { Pool } from "pg";
import { config } from "./config.js";
import { buildPoolConfig, stderrWarning } from "./db-config.js";
import { attachPoolErrorHandler, runIntakeWorker } from "./worker-runtime.js";
import { workerApplicationName } from "./engine-status.js";

if (!config.databaseUrl) throw new Error("DATABASE_URL is required for the worker process");

const workerId = `intake-${process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local"}`;
// The session name lets the Control Room see this worker while it is idle (no lease); it holds the worker id and the structural switch only.
const pool = new Pool(buildPoolConfig(process.env, { max: 3, onWarning: stderrWarning, applicationName: workerApplicationName(workerId, process.env) }));

attachPoolErrorHandler(pool);

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runIntakeWorker(pool, workerId, controller.signal);
} finally {
  await pool.end();
}
