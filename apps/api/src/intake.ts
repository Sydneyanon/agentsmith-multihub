import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { resolveSourceReference } from "./source-resolver.js";

export const intakeSchema = z.object({
  kind: z.enum(["url", "idea"]),
  value: z.string().trim().min(3).max(4_000),
  source: z.enum(["user", "x", "github", "website", "other"]).default("user"),
  notes: z.string().trim().max(8_000).optional(),
}).strict();

const URL_PATTERN = /^https?:\/\//i;
export const isAllowedIntakeUrl = (value: string) => URL_PATTERN.test(value);

const workflow = [
  ["resolve_source", "intake"],
  ["identify_project", "researcher"],
  ["locate_official_repositories", "repository_scout"],
  ["establish_authorization", "scope_guard"],
  ["map_attack_surface", "code_hunter"],
  ["generate_hypotheses", "logic_hunter"],
  ["independent_challenge", "independent_judge"],
  ["prepare_research_brief", "report_writer"],
] as const;

export function registerIntakeRoutes(app: FastifyInstance, pool: Pool | undefined) {
  app.post("/v1/intake", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: "database_not_configured" });
    const parsed = intakeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_intake", details: parsed.error.flatten() });
    }

    const input = parsed.data;
    let sourceReference: ReturnType<typeof resolveSourceReference> | null = null;
    if (input.kind === "url") {
      if (!isAllowedIntakeUrl(input.value)) {
        return reply.code(400).send({ error: "url_must_use_http_or_https" });
      }
      try {
        sourceReference = resolveSourceReference(input.value);
      } catch (error) {
        return reply.code(400).send({
          error: "unsafe_or_invalid_source_url",
          message: error instanceof Error ? error.message : "Invalid source URL",
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{ id: string; correlation_id: string }>(
        `INSERT INTO workflow_runs (workflow_type, status, input, created_by)
         VALUES ('link_or_idea_intake', 'queued', $1::jsonb, 'user')
         RETURNING id, correlation_id`,
        [JSON.stringify({
          kind: input.kind,
          value: input.value,
          source: input.source,
          notes: input.notes ?? null,
          execution_mode: "passive_only",
          authorization_status: "unverified",
          source_reference: sourceReference,
        })],
      );
      const runId = run.rows[0]!.id;
      for (const [sequence, step] of workflow.entries()) {
        await client.query(
          `INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [runId, step[0], sequence, step[1], JSON.stringify({
            intake_kind: input.kind,
            ...(step[0] === "resolve_source" ? {
              value: input.value,
              source: input.source,
              notes: input.notes ?? null,
              source_reference: sourceReference,
              execution_mode: "passive_only",
              authorization_status: "unverified",
            } : {}),
          })],
        );
      }
      await client.query(
        `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason, payload)
         VALUES ('user', 'intake.created', 'workflow_run', $1, $2,
                 'User submitted a research URL or idea',
                 jsonb_build_object('kind', $3::text, 'source', $4::text, 'passive_only', true))`,
        [runId, run.rows[0]!.correlation_id, input.kind, input.source],
      );
      await client.query("COMMIT");
      return reply.code(202).send({
        id: runId,
        correlationId: run.rows[0]!.correlation_id,
        status: "queued",
        next: "passive_source_resolution",
        safety: "No active testing is initiated by intake.",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.error({ err: error }, "Failed to create intake workflow");
      return reply.code(500).send({ error: "intake_creation_failed" });
    } finally {
      client.release();
    }
  });
}
