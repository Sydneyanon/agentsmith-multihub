import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

const idSchema = z.string().uuid();

export function registerWorkflowRoutes(app: FastifyInstance, pool: Pool | undefined) {
  app.get("/v1/workflows", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: "database_not_configured" });
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      status: z.enum(["queued", "running", "awaiting_approval", "succeeded", "failed", "rejected", "cancelled"]).optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    const result = await pool.query(
      `SELECT id, workflow_type, status, correlation_id, created_at, started_at, completed_at
       FROM workflow_runs
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [query.data.status ?? null, query.data.limit],
    );
    return { items: result.rows };
  });

  app.get("/v1/workflows/:id", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: "database_not_configured" });
    const params = z.object({ id: idSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_workflow_id" });
    const run = await pool.query(
      `SELECT id, workflow_type, status, correlation_id, input, result, created_at, started_at, completed_at
       FROM workflow_runs WHERE id = $1`,
      [params.data.id],
    );
    if (!run.rowCount) return reply.code(404).send({ error: "workflow_not_found" });
    const steps = await pool.query(
      `SELECT id, step_key, sequence, role, status, attempt, output, error, started_at, completed_at
       FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence`,
      [params.data.id],
    );
    return { ...run.rows[0], steps: steps.rows };
  });
}
