import type { Pool } from "pg";
import { LeaseLostError } from "../../step-errors.js";
import { ResearchStore } from "../../research-state.js";
import type { ClaimedStep, WorkflowWorker } from "../../worker.js";
import { ACQUIRE_STEP_KEY } from "../../acquisition/step.js";
import { ANALYZER_VERSION, ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY } from "./keys.js";
import { buildDossier, buildStructuralMap, loadStoredHypotheses, runChallenge, runStructuralAnalysis, SPECIALIST_ID } from "./pipeline.js";
import { createHash } from "node:crypto";
import { readBuildInfo } from "../../engine-status.js";

/**
 * Worker steps that continue a `repository_research` run AFTER acquisition: analyse the sealed snapshot, challenge the leads, build the dossier.
 * They consume ONLY the sealed, commit-pinned snapshot the acquisition step produced, write through the existing research store under the step
 * lease, and read nothing from the network. They exist only in runs created with `structuralAnalysis`, and a worker claims them only when
 * STRUCTURAL_ANALYSIS_ENABLED=true. Passive: nothing from the analysed repository is executed on the host.
 */
export type AnalysisStepContext = { pool: Pool; worker: WorkflowWorker; workerId: string; heartbeatMs?: number };

export async function sealedSnapshot(pool: Pool, store: ResearchStore, runId: string): Promise<{ snapshotId: string; commitSha: string; manifestSha256: string; repository: string }> {
  const r = await pool.query<{ output: Record<string, unknown> }>("SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2 AND status = 'succeeded'", [runId, ACQUIRE_STEP_KEY]);
  const out = r.rows[0]?.output;
  if (!out || typeof out["snapshot_id"] !== "string") throw new Error("the acquisition step has not produced a sealed snapshot for this run");
  const verified = (await store.verifySnapshot(out["snapshot_id"])) as { ok?: boolean; sealed?: boolean };
  if (!verified.ok || verified.sealed !== true) throw new Error("the snapshot is not sealed and verified; refusing to analyse it");
  return { snapshotId: out["snapshot_id"], commitSha: String(out["commit_sha"]), manifestSha256: String(out["manifest_sha256"]), repository: String(out["repository"]) };
}

export async function withHeartbeat<T>(ctx: AnalysisStepContext, step: ClaimedStep, f: () => Promise<T>): Promise<T> {
  let lost = false;
  const beat = setInterval(() => { ctx.worker.heartbeat(step.id).then((alive) => { if (!alive) lost = true; }, () => undefined); }, ctx.heartbeatMs ?? 30_000);
  try { const r = await f(); if (lost) throw new LeaseLostError("the step lease was lost during analysis"); return r; } finally { clearInterval(beat); }
}

const passive = { execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false } as const;

export async function processAnalyzeStructureStep(ctx: AnalysisStepContext, step: ClaimedStep): Promise<void> {
  const store = new ResearchStore(ctx.pool); const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id);
  await withHeartbeat(ctx, step, async () => {
    const lease = { stepId: step.id, workerId: ctx.workerId };
    const a = await runStructuralAnalysis(ctx.pool, store, lease, snap.snapshotId);
    const sources = (await ctx.pool.query<{ path: string; text: string }>(`SELECT f.path, convert_from(b.content, 'UTF8') AS text FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.snapshot_id = $1 AND f.path LIKE '%.sol' ORDER BY f.path COLLATE "C"`, [snap.snapshotId])).rows;
    const map = buildStructuralMap(sources); const mapJson = JSON.stringify(map);
    await ctx.worker.complete(step.id, {
      status: "structure_analyzed", analyzer: ANALYZER_VERSION, analyzer_build: { commit: readBuildInfo().commit, image: readBuildInfo().image }, specialist: SPECIALIST_ID, snapshot_id: snap.snapshotId, repository: snap.repository, commit_sha: snap.commitSha, manifest_sha256: snap.manifestSha256,
      contracts: a.contracts, functions: a.functions, hypotheses: a.stored.length, hypothesis_ids: a.stored.map((h) => h.id), problems: a.problems,
      protocol_model_sha256: a.protocolModel.sha256, protocol_model_stored: a.protocolModel.stored, protocol_model_counts: { components: a.protocolModel.components, functions: a.protocolModel.functions, call_edges: a.protocolModel.callEdges, unknowns: a.protocolModel.unknowns },
      structural_map_sha256: createHash("sha256").update(mapJson).digest("hex"), structural_map: mapJson.length <= 400_000 ? map : { truncated: true, reason: "map exceeds 400 kB; see structural_map_sha256 and rebuild from the snapshot" }, ...passive,
    });
  });
}

export async function processChallengeLeadsStep(ctx: AnalysisStepContext, step: ClaimedStep): Promise<void> {
  const store = new ResearchStore(ctx.pool); const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id);
  await withHeartbeat(ctx, step, async () => {
    const stored = await loadStoredHypotheses(ctx.pool, snap.snapshotId);
    const validations = await runChallenge(ctx.pool, store, { stepId: step.id, workerId: ctx.workerId }, snap.snapshotId, stored);
    const verdicts: Record<string, number> = {}; for (const v of validations) verdicts[v.outcome.verdict] = (verdicts[v.outcome.verdict] ?? 0) + 1;
    await ctx.worker.complete(step.id, { status: "leads_challenged", analyzer: ANALYZER_VERSION, snapshot_id: snap.snapshotId, leads: stored.length, reentrancy_verdicts: verdicts, ...passive });
  });
}

export async function processBuildDossierStep(ctx: AnalysisStepContext, step: ClaimedStep): Promise<void> {
  const store = new ResearchStore(ctx.pool); const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id);
  const d = await buildDossier(ctx.pool, store, snap.snapshotId); // fails closed if any cited span cannot be verified
  await ctx.worker.complete(step.id, { status: "dossier_built", snapshot_id: snap.snapshotId, commit_sha: snap.commitSha, content_sha256: d.content_sha256, leads: d.entries.length, status_counts: d.summary, human_review: "none recorded", limitations: d.limitations, ...passive });
}

export async function dispatchAnalysisStep(ctx: AnalysisStepContext, step: ClaimedStep): Promise<boolean> {
  if (step.step_key === ANALYZE_STEP_KEY) { await processAnalyzeStructureStep(ctx, step); return true; }
  if (step.step_key === CHALLENGE_STEP_KEY) { await processChallengeLeadsStep(ctx, step); return true; }
  if (step.step_key === DOSSIER_STEP_KEY) { await processBuildDossierStep(ctx, step); return true; }
  return false;
}
