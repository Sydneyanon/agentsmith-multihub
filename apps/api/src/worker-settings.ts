import type { UrlVariable } from "./db-config.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type WorkerSettings = { urlVariable: UrlVariable; requireRestrictedRole: boolean; onlyRunId: string | null; exitWhenRunDone: boolean };

/** Parses the worker's R1 settings; anything malformed is an error, never a silent default. Booleans must be exactly "true". */
export function workerSettings(env: Record<string, string | undefined>): WorkerSettings {
  const urlVariable: UrlVariable = env.WORKER_DATABASE_URL ? "WORKER_DATABASE_URL" : "DATABASE_URL";
  if (!env[urlVariable]) throw new Error("WORKER_DATABASE_URL or DATABASE_URL is required for the worker process");
  const onlyRunId = env.WORKER_ONLY_RUN_ID?.trim() || null;
  if (onlyRunId && !UUID.test(onlyRunId)) throw new Error("WORKER_ONLY_RUN_ID must be a UUID");
  const exitWhenRunDone = env.WORKER_EXIT_WHEN_RUN_DONE === "true";
  if (exitWhenRunDone && !onlyRunId) throw new Error("WORKER_EXIT_WHEN_RUN_DONE needs WORKER_ONLY_RUN_ID");
  return { urlVariable, requireRestrictedRole: env.HUB_REQUIRE_RESTRICTED_DB_ROLE === "true", onlyRunId, exitWhenRunDone };
}
