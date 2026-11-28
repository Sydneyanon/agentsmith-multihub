import type { Pool } from "pg";
import { z } from "zod";

/**
 * The official bounty scope attached to a research run. The run still acquires and analyses the WHOLE repository: in-scope contracts
 * interact with out-of-scope ones, and the evidence must be complete. Scope is a LABEL on every lead, recorded with the evidence it
 * came from, so a dossier never presents an out-of-scope lead as an eligible bounty finding.
 */
const relPath = z.string().min(1).max(1024).refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "." || s === ""), "a relative path inside the repository");
export const bountyScopeSchema = z.object({
  programme: z.string().min(1).max(200),                       // e.g. "sherlock:273"
  in_scope_paths: z.array(relPath).min(1).max(2000),
  evidence: z.string().min(1).max(500),                          // where the scope was read (official page URL or recorded doc path)
  evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),           // hash of the official page as fetched
}).strict();
export type BountyScope = z.infer<typeof bountyScopeSchema>;
export type ScopeStatus = "in_scope" | "out_of_scope";

export function parseBountyScope(value: unknown): BountyScope {
  const parsed = bountyScopeSchema.parse(value);
  return { ...parsed, in_scope_paths: [...new Set(parsed.in_scope_paths)].sort() };
}

export function scopeOfPath(scope: BountyScope, path: string): ScopeStatus {
  return scope.in_scope_paths.includes(path) ? "in_scope" : "out_of_scope";
}

/** The bounty scope recorded on the run that produced this snapshot, or null when the run carries none (most runs). */
export async function bountyScopeOfSnapshot(pool: Pick<Pool, "query">, snapshotId: string): Promise<BountyScope | null> {
  const row = (await pool.query<{ scope: unknown }>(
    "SELECT r.input->'bounty_scope' AS scope FROM repo_snapshots s JOIN workflow_runs r ON r.id = s.workflow_run_id WHERE s.id = $1", [snapshotId])).rows[0];
  if (!row || row.scope === null || row.scope === undefined) return null;
  return parseBountyScope(row.scope);
}
