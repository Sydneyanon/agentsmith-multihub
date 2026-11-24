import type { Pool } from "pg";

export type ActiveTestingAuthorization = {
  programId: string;
  assetId: string;
  scopeVersionId: string;
  approvalId: string;
};

/**
 * Fail-closed authorization gate. Call immediately before every active test,
 * not just when a workflow is first created.
 */
export async function assertActiveTestingAllowed(
  pool: Pool,
  input: ActiveTestingAuthorization,
): Promise<void> {
  const result = await pool.query(
    `SELECT 1
     FROM programs p
     JOIN program_scope_versions sv
       ON sv.program_id = p.id
     JOIN program_assets pa
       ON pa.program_id = p.id
      AND pa.scope_version_id = sv.id
     JOIN approvals a
       ON a.target_type = 'asset'
      AND a.target_id = pa.asset_id
      AND a.action_type = 'active_testing'
      AND a.status = 'approved'
      AND a.id = $4
      AND (a.expires_at IS NULL OR a.expires_at > now())
     WHERE p.id = $1
       AND pa.asset_id = $2
       AND sv.id = $3
       AND p.status = 'active'
       AND pa.scope_status = 'in_scope'
       AND sv.verified_at IS NOT NULL
       AND (sv.valid_from IS NULL OR sv.valid_from <= now())
       AND (sv.valid_until IS NULL OR sv.valid_until > now())
     LIMIT 1`,
    [input.programId, input.assetId, input.scopeVersionId, input.approvalId],
  );
  if (result.rowCount !== 1) {
    throw new Error("Active testing blocked: current verified scope and explicit approval were not both confirmed");
  }
}
