import type { Pool } from "pg";
import { z } from "zod";
import type { ClaimedStep, WorkflowWorker } from "../worker.js";
import { monitorSource } from "./monitor.js";
import { SOURCE_KEY } from "./types.js";

export const SOURCE_MONITORING_WORKFLOW = "source_monitoring";
export const MONITOR_STEP_KEY = "monitor_source";
const stepInput = z.object({ source_key: z.string().regex(SOURCE_KEY) }).strict();

/**
 * Creates a monitoring run for every ENABLED source whose interval has elapsed and that has no queued or running run.
 * Called by the worker only when DISCOVERY_ENABLED=true; with no enabled source it does nothing.
 */
export async function ensureDueMonitorRuns(pool: Pool): Promise<number> {
  const due = await pool.query<{ source_key: string }>(
    `SELECT s.source_key FROM discovery_sources s
      WHERE s.enabled AND (s.last_attempt_at IS NULL OR s.last_attempt_at + make_interval(secs => s.min_interval_seconds) <= now())
        AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.workflow_type = $1 AND r.status IN ('queued','running') AND r.input->>'source_key' = s.source_key)`, [SOURCE_MONITORING_WORKFLOW]);
  let created = 0;
  for (const { source_key } of due.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialise per source so two schedulers cannot both create a run.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`discovery:${source_key}`]);
      const exists = await client.query(`SELECT 1 FROM workflow_runs WHERE workflow_type = $1 AND status IN ('queued','running') AND input->>'source_key' = $2`, [SOURCE_MONITORING_WORKFLOW, source_key]);
      if (!exists.rowCount) {
        const run = await client.query<{ id: string }>(`INSERT INTO workflow_runs (workflow_type, status, input, created_by) VALUES ($1,'queued',$2::jsonb,'discovery-scheduler') RETURNING id`, [SOURCE_MONITORING_WORKFLOW, JSON.stringify({ source_key })]);
        await client.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1,$2,0,'source_monitor',$3::jsonb)`, [run.rows[0]!.id, MONITOR_STEP_KEY, JSON.stringify({ source_key })]);
        created += 1;
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
  return created;
}

export async function processMonitorSourceStep(context: { pool: Pool; worker: WorkflowWorker; fetcher?: typeof fetch }, step: ClaimedStep): Promise<void> {
  const input = stepInput.parse(step.input);
  const result = await monitorSource({ pool: context.pool, sourceKey: input.source_key, workflowRunId: step.workflow_run_id, ...(context.fetcher ? { fetcher: context.fetcher } : {}) });
  await context.worker.complete(step.id, { ...result, execution_mode: "passive_only", active_testing_allowed: false });
}
