import type { PoolClient } from "pg";
import { z } from "zod";
import { ACQUIRE_STEP_KEY, REPOSITORY_RESEARCH_WORKFLOW } from "../acquisition/step.js";
import { parseRepositoryName } from "../acquisition/github-source.js";
import { buildProtocolModel, coverageComponents } from "../analysis/solidity/protocol-model.js";
import { loadStoredHypotheses, readSnapshotSources, runChallenge, runStructuralAnalysis, SPECIALIST_ID, SPECIALIST_VERSION } from "../analysis/solidity/pipeline.js";
import { sealedSnapshot, withHeartbeat, type AnalysisStepContext } from "../analysis/solidity/step.js";
import { ResearchStore } from "../research-state.js";
import type { ClaimedStep } from "../worker.js";
import { SPECIALIST_CLASSES } from "./classes.js";

/**
 * A research ASSIGNMENT is a `repository_research` run (T-149: one workflow, no second lifecycle) created by a policy decision:
 *   acquire_repository (pinned to the decided commit: loads the sealed snapshot, never a different one)
 *   -> investigate_target (the specialist, scoped to the decided components)
 *   -> challenge_target   (independent evaluators of exactly the leads this assignment produced).
 * The specialist returns structured results only; coverage, memory and the next decision are written by the engine (loop.ts), not here.
 * Workers claim these steps only when ENGINE_LOOP_ENABLED=true (off everywhere by default).
 */
export const INVESTIGATE_STEP_KEY = "investigate_target";
export const CHALLENGE_TARGET_STEP_KEY = "challenge_target";
export const ENGINE_STEP_KEYS = [INVESTIGATE_STEP_KEY, CHALLENGE_TARGET_STEP_KEY] as const;
export const ENGINE_LOOP_SWITCH = "ENGINE_LOOP_ENABLED";

const target = z.object({ componentId: z.string().min(3).max(1000), contract: z.string().min(1).max(300), file: z.string().min(1).max(1000), contentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const assignmentSchema = z.object({
  decisionId: z.string().uuid(),
  repository: z.string().min(3).max(201),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  /** the snapshot the decision was made on; snapshots belong to their run (0007), so the assignment's own acquisition re-seals the same
   *  version under a new id, and the investigation checks the VERSION (commit + manifest hash) instead of the id */
  decidedOnSnapshotId: z.string().uuid(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  targets: z.array(target).min(1).max(5),
}).strict();
export type Assignment = z.infer<typeof assignmentSchema>;

export async function createInvestigationRunIn(client: Pick<PoolClient, "query">, raw: Assignment, createdBy: string): Promise<{ runId: string; investigateStepId: string }> {
  const a = assignmentSchema.parse(raw); parseRepositoryName(a.repository);
  const run = await client.query<{ id: string; correlation_id: string }>(
    `INSERT INTO workflow_runs (workflow_type, status, input, created_by) VALUES ($1, 'queued', $2::jsonb, $3) RETURNING id, correlation_id`,
    [REPOSITORY_RESEARCH_WORKFLOW, JSON.stringify({ kind: "repository", value: a.repository, ref: a.commitSha, source: "research_policy", assignment: { decision_id: a.decisionId, targets: a.targets.map((t) => t.componentId) }, execution_mode: "passive_only", authorization_status: "unverified" }), createdBy]);
  const runId = run.rows[0]!.id;
  await client.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 0, 'repository_acquirer', $3::jsonb)`, [runId, ACQUIRE_STEP_KEY, JSON.stringify({ repository: a.repository, ref: a.commitSha })]);
  const inv = await client.query<{ id: string }>(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 1, 'specialist', $3::jsonb) RETURNING id`, [runId, INVESTIGATE_STEP_KEY, JSON.stringify(a)]);
  await client.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 2, 'lead_challenger', '{}'::jsonb)`, [runId, CHALLENGE_TARGET_STEP_KEY]);
  await client.query(
    `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason, payload)
     VALUES ($1, 'research_assignment.created', 'workflow_run', $2, $3, 'Assignment created by a recorded research decision (passive analysis of a sealed snapshot)', jsonb_build_object('decision_id', $4::text, 'targets', $5::jsonb))`,
    [createdBy, runId, run.rows[0]!.correlation_id, a.decisionId, JSON.stringify(a.targets.map((t) => t.componentId))]);
  return { runId, investigateStepId: inv.rows[0]!.id };
}

const passive = { execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false } as const;

export async function processInvestigateTargetStep(ctx: AnalysisStepContext, step: ClaimedStep): Promise<void> {
  const a = assignmentSchema.parse(step.input);
  const store = new ResearchStore(ctx.pool); const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id);
  if (snap.commitSha !== a.commitSha || snap.manifestSha256 !== a.manifestSha256) throw new Error("the acquired snapshot is not the version the decision was made on; refusing to investigate a different version");
  const started = Date.now();
  await withHeartbeat(ctx, step, async () => {
    // the targets must still be exactly the component versions the decision saw (version-aware; fail closed)
    const model = buildProtocolModel(await readSnapshotSources(ctx.pool, snap.snapshotId)).model;
    const now = new Map(coverageComponents(model).map((c) => [c.id, c.contentSha256]));
    for (const t of a.targets) if (now.get(t.componentId) !== t.contentSha256) throw new Error(`target ${t.componentId} is not at the decided content hash`);
    const contracts = new Set(a.targets.map((t) => t.contract));
    const r = await runStructuralAnalysis(ctx.pool, store, { stepId: step.id, workerId: ctx.workerId }, snap.snapshotId, { include: (f) => contracts.has(f.contract) });
    const byClass: Record<string, number> = {}; for (const h of r.stored) byClass[h.finding.class] = (byClass[h.finding.class] ?? 0) + 1;
    await ctx.worker.complete(step.id, {
      status: "target_investigated", specialist: SPECIALIST_ID, specialist_version: SPECIALIST_VERSION, decision_id: a.decisionId, snapshot_id: snap.snapshotId, decided_on_snapshot_id: a.decidedOnSnapshotId, manifest_sha256: snap.manifestSha256, commit_sha: snap.commitSha,
      targets: a.targets, classes_examined: [...SPECIALIST_CLASSES], hypothesis_ids: r.stored.map((h) => h.id), leads_by_class: byClass,
      protocol_model_sha256: r.protocolModel.sha256, problems: r.problems.slice(0, 50), wall_ms: Date.now() - started, ...passive,
    });
  });
}

export async function processChallengeTargetStep(ctx: AnalysisStepContext, step: ClaimedStep): Promise<void> {
  const inv = (await ctx.pool.query<{ output: { hypothesis_ids?: string[]; snapshot_id?: string } }>(
    "SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2 AND status = 'succeeded'", [step.workflow_run_id, INVESTIGATE_STEP_KEY])).rows[0]?.output;
  if (!inv?.snapshot_id || !Array.isArray(inv.hypothesis_ids)) throw new Error("the investigation step has not produced structured results for this run");
  const store = new ResearchStore(ctx.pool); const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id);
  const ids = new Set(inv.hypothesis_ids); const started = Date.now();
  await withHeartbeat(ctx, step, async () => {
    const mine = (await loadStoredHypotheses(ctx.pool, snap.snapshotId)).filter((h) => ids.has(h.id));
    await runChallenge(ctx.pool, store, { stepId: step.id, workerId: ctx.workerId }, snap.snapshotId, mine);
    const evals = (await ctx.pool.query<{ outcome: string; n: string }>("SELECT outcome, count(*) n FROM hypothesis_evaluations WHERE produced_by_step_id = $1 GROUP BY outcome ORDER BY outcome", [step.id])).rows;
    await ctx.worker.complete(step.id, { status: "target_challenged", snapshot_id: snap.snapshotId, leads: mine.length, evaluations: Object.fromEntries(evals.map((e) => [e.outcome, Number(e.n)])), wall_ms: Date.now() - started, ...passive });
  });
}

export async function dispatchEngineStep(ctx: AnalysisStepContext, step: ClaimedStep): Promise<boolean> {
  if (step.step_key === INVESTIGATE_STEP_KEY) { await processInvestigateTargetStep(ctx, step); return true; }
  if (step.step_key === CHALLENGE_TARGET_STEP_KEY) { await processChallengeTargetStep(ctx, step); return true; }
  return false;
}
