/**
 * The worker entry point. WORKER_STORE selects how the worker reaches the database:
 * - unset or "db" (the default): worker-db-main.ts, the direct-database worker, unchanged;
 * - "api" (option D, opt-in): worker-remote-main.ts, which holds no database credential and refuses to start if one is present.
 * Any other value stops the worker before anything else happens.
 */
import { runDbWorker } from "./worker-db-main.js";
import { runRemoteWorker } from "./worker-remote-main.js";

const store = process.env.WORKER_STORE;
if (store === undefined || store === "" || store === "db") await runDbWorker();
else if (store === "api") await runRemoteWorker();
else {
  console.log(JSON.stringify({ level: "fatal", msg: "worker_store_invalid", detail: "WORKER_STORE must be unset, \"db\" or \"api\"" }));
  process.exitCode = 64;
}
