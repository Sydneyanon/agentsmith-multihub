import type { Pool } from "pg";
import type { LeadRef } from "../../engine/tools/slither.js";
import type { ClaimedStep } from "../../worker.js";
import { SLITHER_SCAN_SCOPE, SLITHER_STEP_KEY, SLITHER_VERSION } from "./keys.js";

/**
 * How a repository_research run's optional Slither stage is marked and read back (by challenge_leads and the dossier). Kept apart from
 * the step itself so the dossier can read it without importing the runner.
 *
 * The step input that marks a research-run Slither stage (an engine-loop `slither_scan` step carries an assignment instead):
 */
export const slitherScanStepInput = () => ({ scope: SLITHER_SCAN_SCOPE, producer: "slither", pinned_version: SLITHER_VERSION });
export function isResearchSlitherStep(step: Pick<ClaimedStep, "step_key" | "input">): boolean {
  const i = step.input as { scope?: unknown } | null;
  return step.step_key === SLITHER_STEP_KEY && !!i && typeof i === "object" && i.scope === SLITHER_SCAN_SCOPE;
}

/** The research-run Slither stage's recorded outcome for a run or a snapshot's run; null when the run has no such stage. */
export type SlitherScanOutcome =
  | { status: "tool_completed"; version: string; solcVersion: string; leads: LeadRef[]; informational: number; unanchored: number; notRecorded: number }
  | { status: "abstained"; code: string; detail: string };
type StoredOutput = { status?: unknown; leads?: unknown; tool?: { version?: unknown; solc_version?: unknown }; abstention?: { code?: unknown; detail?: unknown }; informational_detections?: unknown; unanchored?: unknown; leads_not_recorded?: unknown };
function outcomeOf(o: StoredOutput | null | undefined): SlitherScanOutcome | null {
  if (!o) return null;
  if (o.status === "tool_completed") return { status: "tool_completed", version: String(o.tool?.version ?? ""), solcVersion: String(o.tool?.solc_version ?? ""), leads: Array.isArray(o.leads) ? (o.leads as LeadRef[]) : [],
    informational: Number(o.informational_detections ?? 0), unanchored: Number(o.unanchored ?? 0), notRecorded: Number(o.leads_not_recorded ?? 0) };
  if (o.status === "abstained") return { status: "abstained", code: String(o.abstention?.code ?? "unknown"), detail: String(o.abstention?.detail ?? "") };
  return null;
}
export async function slitherScanOfRun(pool: Pick<Pool, "query">, runId: string): Promise<{ exists: boolean; outcome: SlitherScanOutcome | null }> {
  const rows = (await pool.query<{ status: string; output: StoredOutput | null }>(
    `SELECT status, output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2 AND input->>'scope' = $3`, [runId, SLITHER_STEP_KEY, SLITHER_SCAN_SCOPE])).rows;
  if (!rows.length) return { exists: false, outcome: null };
  return { exists: true, outcome: rows[0]!.status === "succeeded" ? outcomeOf(rows[0]!.output) : null };
}
export async function slitherScanOfSnapshot(pool: Pick<Pool, "query">, snapshotId: string): Promise<{ exists: boolean; outcome: SlitherScanOutcome | null }> {
  const run = (await pool.query<{ workflow_run_id: string }>("SELECT workflow_run_id FROM repo_snapshots WHERE id = $1", [snapshotId])).rows[0];
  return run ? slitherScanOfRun(pool, run.workflow_run_id) : { exists: false, outcome: null };
}
