import type { Pool } from "pg";

export type ClaimedStep = {
  id: string;
  workflow_run_id: string;
  step_key: string;
  sequence: number;
  role: string;
  attempt: number;
  input: Record<string, unknown>;
  correlation_id: string;
};

export class WorkflowWorker {
  constructor(
    private readonly pool: Pool,
    private readonly workerId: string,
    private readonly leaseSeconds = 90,
    private readonly maxAttempts = 3,
  ) {
    if (!workerId.trim()) throw new Error("workerId is required");
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) throw new Error("leaseSeconds must be at least 10");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be positive");
  }

  async claimNext(): Promise<ClaimedStep | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<ClaimedStep>(
        `WITH candidate AS (
           SELECT s.id
           FROM workflow_steps s
           JOIN workflow_runs r ON r.id = s.workflow_run_id
           WHERE r.status IN ('queued','running')
             AND (
               s.status = 'queued'
               OR (s.status = 'running' AND s.lease_expires_at < now())
             )
             AND s.attempt < $3
             AND NOT EXISTS (
               SELECT 1 FROM workflow_steps prior
               WHERE prior.workflow_run_id = s.workflow_run_id
                 AND prior.sequence < s.sequence
                 AND prior.status <> 'succeeded'
             )
           ORDER BY r.created_at, s.sequence
           FOR UPDATE OF s SKIP LOCKED
           LIMIT 1
         )
         UPDATE workflow_steps s
         SET status = 'running',
             attempt = s.attempt + 1,
             lease_owner = $1,
             lease_expires_at = now() + ($2::int * interval '1 second'),
             started_at = COALESCE(s.started_at, now())
         FROM candidate c
         WHERE s.id = c.id
         RETURNING s.id, s.workflow_run_id, s.step_key, s.sequence, s.role,
                   s.attempt, s.input,
                   (SELECT r.correlation_id FROM workflow_runs r WHERE r.id = s.workflow_run_id) AS correlation_id`,
        [this.workerId, this.leaseSeconds, this.maxAttempts],
      );
      if (!claimed.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      const step = claimed.rows[0]!;
      await client.query(
        `UPDATE workflow_runs SET status = 'running', started_at = COALESCE(started_at, now())
         WHERE id = $1 AND status IN ('queued','running')`,
        [step.workflow_run_id],
      );
      await client.query(
        `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, payload)
         VALUES ($1, 'workflow_step.claimed', 'workflow_step', $2, $3,
                 jsonb_build_object('step_key', $4::text, 'attempt', $5::int))`,
        [this.workerId, step.id, step.correlation_id, step.step_key, step.attempt],
      );
      await client.query("COMMIT");
      return step;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Convert abandoned, exhausted leases into terminal failures. Without this
   * sweep, a worker that dies on its final attempt would strand a run forever.
   */
  async reapExhaustedLeases(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<{ id: string; workflow_run_id: string }>(
        `UPDATE workflow_steps
         SET status = 'failed',
             error = COALESCE(error, '{}'::jsonb) ||
               jsonb_build_object('message', 'Worker lease expired after maximum attempts', 'retryable', false),
             completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
         WHERE status = 'running'
           AND lease_expires_at < now()
           AND attempt >= $1
         RETURNING id, workflow_run_id`,
        [this.maxAttempts],
      );
      const runIds = [...new Set(expired.rows.map((row) => row.workflow_run_id))];
      for (const runId of runIds) {
        await client.query(
          `UPDATE workflow_runs SET status = 'failed', completed_at = now()
           WHERE id = $1 AND status IN ('queued','running')`,
          [runId],
        );
      }
      for (const row of expired.rows) {
        await client.query(
          `INSERT INTO audit_events (actor, action, entity_type, entity_id, payload)
           VALUES ($1, 'workflow_step.lease_exhausted', 'workflow_step', $2,
                   jsonb_build_object('max_attempts', $3::int))`,
          [this.workerId, row.id, this.maxAttempts],
        );
      }
      await client.query("COMMIT");
      return expired.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(stepId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE workflow_steps
       SET lease_expires_at = now() + ($3::int * interval '1 second')
       WHERE id = $1 AND status = 'running' AND lease_owner = $2
         AND lease_expires_at > now()`,
      [stepId, this.workerId, this.leaseSeconds],
    );
    return result.rowCount === 1;
  }

  async complete(stepId: string, output: Record<string, unknown> = {}): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ workflow_run_id: string; correlation_id: string }>(
        `UPDATE workflow_steps
         SET status = 'succeeded', output = $3::jsonb, completed_at = now(),
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $1 AND status = 'running' AND lease_owner = $2
           AND lease_expires_at > now()
         RETURNING workflow_run_id,
           (SELECT correlation_id FROM workflow_runs WHERE id = workflow_run_id) AS correlation_id`,
        [stepId, this.workerId, JSON.stringify(output)],
      );
      if (!updated.rowCount) throw new Error("Step lease lost or step is not owned by this worker");
      const runId = updated.rows[0]!.workflow_run_id;
      const remaining = await client.query(
        `SELECT count(*)::int AS count FROM workflow_steps
         WHERE workflow_run_id = $1 AND status <> 'succeeded'`,
        [runId],
      );
      if (remaining.rows[0]!.count === 0) {
        await client.query(
          "UPDATE workflow_runs SET status = 'succeeded', completed_at = now() WHERE id = $1",
          [runId],
        );
      }
      await client.query(
        `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, payload)
         VALUES ($1, 'workflow_step.succeeded', 'workflow_step', $2, $3, $4::jsonb)`,
        [this.workerId, stepId, updated.rows[0]!.correlation_id, JSON.stringify(output)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async fail(stepId: string, reason: string, retryable = true): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query<{ workflow_run_id: string; attempt: number }>(
        `UPDATE workflow_steps
         SET status = CASE WHEN $3::boolean AND attempt < $4 THEN 'queued' ELSE 'failed' END,
             error = jsonb_build_object('message', left($5::text, 2000), 'retryable', $3::boolean),
             lease_owner = NULL, lease_expires_at = NULL,
             completed_at = CASE WHEN $3::boolean AND attempt < $4 THEN NULL ELSE now() END
         WHERE id = $1 AND status = 'running' AND lease_owner = $2
         RETURNING workflow_run_id, attempt`,
        [stepId, this.workerId, retryable, this.maxAttempts, reason],
      );
      if (!failed.rowCount) throw new Error("Step lease lost or step is not owned by this worker");
      const row = failed.rows[0]!;
      if (row.attempt >= this.maxAttempts || !retryable) {
        await client.query(
          "UPDATE workflow_runs SET status = 'failed', completed_at = now() WHERE id = $1",
          [row.workflow_run_id],
        );
      }
      await client.query(
        `INSERT INTO audit_events (actor, action, entity_type, entity_id, payload)
         VALUES ($1, 'workflow_step.failed', 'workflow_step', $2,
                 jsonb_build_object('attempt', $3::int, 'retryable', $4::boolean, 'reason', left($5::text, 2000)))`,
        [this.workerId, stepId, row.attempt, retryable, reason],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
