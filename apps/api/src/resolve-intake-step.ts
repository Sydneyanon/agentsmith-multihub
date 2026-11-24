import type { Pool } from "pg";
import { resolveSourceReference } from "./source-resolver.js";

/**
 * First executable workflow stage. It only normalizes a user-supplied reference:
 * no HTTP fetches, repository cloning, scanning, or authorization inference.
 */
export async function resolveIntakeStep(
  pool: Pick<Pool, "query">,
  workflowRunId: string,
): Promise<Record<string, unknown>> {
  const result = await pool.query<{ workflow_type: string; input: unknown }>(
    "SELECT workflow_type, input FROM workflow_runs WHERE id = $1",
    [workflowRunId],
  );
  const run = result.rows[0];
  if (!run || run.workflow_type !== "link_or_idea_intake") {
    throw new Error("Unsupported or missing intake workflow");
  }
  const input = run.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid intake payload");
  }
  const fields = input as Record<string, unknown>;
  if (fields.execution_mode !== "passive_only" ||
      fields.authorization_status !== "unverified") {
    throw new Error("Unexpected intake safety state");
  }
  if (fields.kind === "idea") {
    if (typeof fields.value !== "string" || !fields.value.trim()) {
      throw new Error("Invalid idea");
    }
    return {
      kind: "idea",
      idea: fields.value,
      requires_authorization: true,
      network_access_performed: false,
    };
  }
  if (fields.kind === "url" && typeof fields.value === "string") {
    const reference = resolveSourceReference(fields.value);
    return {
      kind: "url",
      source_reference: reference,
      requires_authorization: true,
      network_access_performed: false,
    };
  }
  throw new Error("Invalid intake kind or URL");
}
