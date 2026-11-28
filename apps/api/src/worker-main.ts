import { Pool } from "pg";
import { buildPoolConfig, stderrWarning } from "./db-config.js";
import { assessConnectedRole, readOnlyMembershipsFromEnv } from "./db-roles.js";
import { attachPoolErrorHandler, runIntakeWorker } from "./worker-runtime.js";
import { workerApplicationName } from "./engine-status.js";
import { workerSettings } from "./worker-settings.js";

/**
 * The intake/research worker. R1 settings (all optional; with none set it behaves exactly as before):
 * - WORKER_DATABASE_URL: the worker's own connection (the restricted runtime role). The API keeps DATABASE_URL unchanged.
 * - HUB_REQUIRE_RESTRICTED_DB_ROLE=true: the role is checked BEFORE any step is claimed; a role that could disable triggers,
 *   delete, truncate, own or create anything stops the worker with exit code 78 and nothing is claimed.
 * - RUNTIME_ROLE_READONLY_MEMBERSHIPS=reader: tolerate that provider membership only after proving it read-only.
 * - WORKER_ONLY_RUN_ID=<uuid>: claim steps of this run only. WORKER_EXIT_WHEN_RUN_DONE=true: exit once that run is finished.
 */
const s = workerSettings(process.env);
const workerId = `intake-${process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local"}`;
// The session name lets the Control Room see this worker while it is idle (no lease); it holds the worker id and the structural switch only.
const pool = new Pool(buildPoolConfig(process.env, { max: 3, onWarning: stderrWarning, urlVariable: s.urlVariable, applicationName: workerApplicationName(workerId, process.env) }));
attachPoolErrorHandler(pool);
const log = (level: string, msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level, msg, worker: workerId, ...extra }));

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
let watcher: NodeJS.Timeout | undefined;

try {
  const role = await assessConnectedRole(pool, "public", readOnlyMembershipsFromEnv(process.env));
  const who = (await pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
  if (!role.ok) {
    log(s.requireRestrictedRole ? "fatal" : "warn", "worker_role_not_least_privilege", { role: who, problems: role.problems });
    if (s.requireRestrictedRole) { process.exitCode = 78; throw new Error("refusing to start: the database role is not least-privilege"); }
  } else log("info", "worker_role_verified", { role: who, url_variable: s.urlVariable });
  if (s.onlyRunId) {
    const run = (await pool.query<{ status: string; workflow_type: string }>("SELECT status, workflow_type FROM workflow_runs WHERE id = $1", [s.onlyRunId])).rows[0];
    if (!run) { process.exitCode = 66; throw new Error(`WORKER_ONLY_RUN_ID ${s.onlyRunId} does not exist`); }
    log("info", "worker_scoped_to_run", { run: s.onlyRunId, workflow_type: run.workflow_type, status: run.status });
    if (s.exitWhenRunDone) {
      const check = async () => {
        const st = (await pool.query<{ status: string }>("SELECT status FROM workflow_runs WHERE id = $1", [s.onlyRunId])).rows[0]?.status;
        if (st && !["queued", "running"].includes(st)) { log("info", "scoped_run_finished_exiting", { run: s.onlyRunId, status: st }); controller.abort(); }
      };
      watcher = setInterval(() => { check().catch((e: unknown) => log("error", "run_status_check_failed", { error: e instanceof Error ? e.message : String(e) })); }, 5_000);
      await check();
    }
  }
  if (!controller.signal.aborted) await runIntakeWorker(pool, workerId, controller.signal, s.onlyRunId ? { onlyRunId: s.onlyRunId } : {});
} catch (error) {
  log("fatal", "worker_stopped", { error: error instanceof Error ? error.message : String(error) });
  if (!process.exitCode) process.exitCode = 1;
} finally {
  if (watcher) clearInterval(watcher);
  await pool.end();
}
