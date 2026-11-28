/**
 * The worker entry point. WORKER_STORE selects how the worker reaches the database:
 * - unset or "db" (the default): worker-db-main.ts, the direct-database worker, unchanged;
 * - "api" (option D, opt-in): worker-remote-main.ts, which holds no database credential and refuses to start if one is present.
 * Any other value stops the worker before anything else happens.
 */
const store = process.env.WORKER_STORE;
if (store === undefined || store === "" || store === "db") await import("./worker-db-main.js");
else if (store === "api") await import("./worker-remote-main.js");
else {
  console.log(JSON.stringify({ level: "fatal", msg: "worker_store_invalid", detail: "WORKER_STORE must be unset, \"db\" or \"api\"" }));
  process.exitCode = 64;
}
