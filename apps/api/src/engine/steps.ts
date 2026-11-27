import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ACQUIRE_STEP_KEY, REPOSITORY_RESEARCH_WORKFLOW } from "../acquisition/step.js";
import { parseRepositoryName } from "../acquisition/github-source.js";
import { buildProtocolModel, coverageComponents } from "../analysis/solidity/protocol-model.js";
import { loadStoredHypotheses, readSnapshotSources, runChallenge, runStructuralAnalysis, SPECIALIST_ID, SPECIALIST_VERSION, type StoredHypothesis } from "../analysis/solidity/pipeline.js";
import type { Finding, FindingClass } from "../analysis/solidity/specialists.js";
import { sealedSnapshot, withHeartbeat, type AnalysisStepContext } from "../analysis/solidity/step.js";
import { MAX_SPAN_LINES, ResearchStore } from "../research-state.js";
import type { ClaimedStep } from "../worker.js";
import { ATTENDED_STEP_KEY, capabilityById, FOUNDRY_STEP_KEY, SLITHER_STEP_KEY, SLITHER_VERSION } from "./capabilities.js";
import { processFoundryValidateStep } from "./reproduction.js";
import { runSlither } from "./tools/slither.js";

/**
 * A research ASSIGNMENT is a `repository_research` run (T-149: one workflow, no second lifecycle) created by a policy decision:
 *   acquire_repository (pinned to the decided commit) -> <the chosen capability's producer step> -> challenge_target.
 * Producer steps: investigate_target (AgentSmith's structural specialists) and slither_scan (Slither, pinned). challenge_target runs the
 * independent evaluators on exactly the leads this assignment produced, whichever producer made them. Specialists return structured
 * results only; coverage, memory and the next decision are written by the engine (loop.ts).
 * Workers claim these steps only when ENGINE_LOOP_ENABLED=true and STRUCTURAL_ANALYSIS_ENABLED=true (off everywhere by default).
 */
export const INVESTIGATE_STEP_KEY = "investigate_target";
export const CHALLENGE_TARGET_STEP_KEY = "challenge_target";
export const ENGINE_STEP_KEYS = [INVESTIGATE_STEP_KEY, SLITHER_STEP_KEY, CHALLENGE_TARGET_STEP_KEY, FOUNDRY_STEP_KEY] as const;
export const ENGINE_LOOP_SWITCH = "ENGINE_LOOP_ENABLED";
export type EngineStepContext = AnalysisStepContext & { env?: Record<string, string | undefined> };

const target = z.object({ componentId: z.string().min(3).max(1000), contract: z.string().min(1).max(300), file: z.string().min(1).max(1000), contentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const assignmentSchema = z.object({
  decisionId: z.string().uuid(),
  capability: z.object({ id: z.string().min(1).max(100), version: z.string().min(1).max(50) }).strict(),
  repository: z.string().min(3).max(201),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  /** the snapshot the decision was made on; snapshots belong to their run (0007), so the assignment's own acquisition re-seals the same
   *  version under a new id, and the producer checks the VERSION (commit + manifest hash) instead of the id */
  decidedOnSnapshotId: z.string().uuid(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  targets: z.array(target).min(1).max(500),
}).strict();
export type Assignment = z.infer<typeof assignmentSchema>;

/** Structured lead summary every producer returns, so the challenge step treats all producers alike. */
export type LeadRef = { hypothesisId: string; class: string; contract: string; function: string; file: string; line: number };

export async function createInvestigationRunIn(client: Pick<PoolClient, "query">, raw: Assignment, createdBy: string): Promise<{ runId: string; investigateStepId: string }> {
  const a = assignmentSchema.parse(raw); parseRepositoryName(a.repository);
  const cap = capabilityById(a.capability.id);
  if ((cap.kind !== "producer" && cap.kind !== "mapper") || cap.status !== "active" || cap.version !== a.capability.version) throw new Error(`capability ${a.capability.id}@${a.capability.version} is not an active producer`);
  const run = await client.query<{ id: string; correlation_id: string }>(
    `INSERT INTO workflow_runs (workflow_type, status, input, created_by) VALUES ($1, 'queued', $2::jsonb, $3) RETURNING id, correlation_id`,
    [REPOSITORY_RESEARCH_WORKFLOW, JSON.stringify({ kind: "repository", value: a.repository, ref: a.commitSha, source: "research_policy", assignment: { decision_id: a.decisionId, capability: a.capability, targets: a.targets.map((t) => t.componentId) }, execution_mode: "passive_only", authorization_status: "unverified" }), createdBy]);
  const runId = run.rows[0]!.id;
  await client.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 0, 'repository_acquirer', $3::jsonb)`, [runId, ACQUIRE_STEP_KEY, JSON.stringify({ repository: a.repository, ref: a.commitSha })]);
  const inv = await client.query<{ id: string }>(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 1, 'specialist', $3::jsonb) RETURNING id`, [runId, cap.stepKey, JSON.stringify(a)]);
  await client.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 2, 'lead_challenger', '{}'::jsonb)`, [runId, CHALLENGE_TARGET_STEP_KEY]);
  await client.query(
    `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason, payload)
     VALUES ($1, 'research_assignment.created', 'workflow_run', $2, $3, 'Assignment created by a recorded research decision (passive analysis of a sealed snapshot)', jsonb_build_object('decision_id', $4::text, 'capability', $5::text, 'targets', $6::jsonb))`,
    [createdBy, runId, run.rows[0]!.correlation_id, a.decisionId, `${a.capability.id}@${a.capability.version}`, JSON.stringify(a.targets.map((t) => t.componentId))]);
  return { runId, investigateStepId: inv.rows[0]!.id };
}

const passive = { execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false } as const;

/** The targets must still be exactly the component versions the decision saw (version-aware; fail closed). */
async function checkVersion(pool: Pool, a: Assignment, snap: { snapshotId: string; commitSha: string; manifestSha256: string }): Promise<void> {
  if (snap.commitSha !== a.commitSha || snap.manifestSha256 !== a.manifestSha256) throw new Error("the acquired snapshot is not the version the decision was made on; refusing to investigate a different version");
  const model = buildProtocolModel(await readSnapshotSources(pool, snap.snapshotId)).model;
  const now = new Map(coverageComponents(model).map((c) => [c.id, c.contentSha256]));
  for (const t of a.targets) if (now.get(t.componentId) !== t.contentSha256) throw new Error(`target ${t.componentId} is not at the decided content hash`);
}

export async function processInvestigateTargetStep(ctx: EngineStepContext, step: ClaimedStep): Promise<void> {
  const a = assignmentSchema.parse(step.input);
  if (a.capability.id !== SPECIALIST_ID) throw new Error(`investigate_target runs ${SPECIALIST_ID}, not ${a.capability.id}`);
  const store = new ResearchStore(ctx.pool); const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id);
  await checkVersion(ctx.pool, a, snap);
  const started = Date.now();
  await withHeartbeat(ctx, step, async () => {
    const contracts = new Set(a.targets.map((t) => t.contract));
    const r = await runStructuralAnalysis(ctx.pool, store, { stepId: step.id, workerId: ctx.workerId }, snap.snapshotId, { include: (f) => contracts.has(f.contract) });
    const byClass: Record<string, number> = {}; for (const h of r.stored) byClass[h.finding.class] = (byClass[h.finding.class] ?? 0) + 1;
    const leads: LeadRef[] = r.stored.map((h) => ({ hypothesisId: h.id, class: h.finding.class, contract: h.finding.contract, function: h.finding.function, file: h.finding.file, line: h.finding.line }));
    await ctx.worker.complete(step.id, {
      status: "target_investigated", capability: a.capability, specialist: SPECIALIST_ID, specialist_version: SPECIALIST_VERSION, decision_id: a.decisionId, snapshot_id: snap.snapshotId, decided_on_snapshot_id: a.decidedOnSnapshotId, manifest_sha256: snap.manifestSha256, commit_sha: snap.commitSha,
      targets: a.targets, classes_examined: [...capabilityById(SPECIALIST_ID).classes], hypothesis_ids: leads.map((l) => l.hypothesisId), leads, leads_by_class: byClass,
      protocol_model_sha256: r.protocolModel.sha256, problems: r.problems.slice(0, 50), wall_ms: Date.now() - started, ...passive,
    });
  });
}

/**
 * Slither producer step. Runs the pinned tool offline on the materialised sealed snapshot; every mapped detector result on a target
 * contract becomes a plane-1 hypothesis (generator `slither@<version>`) anchored to a hash-verified evidence span. A tool failure is an
 * explicit result (`tool_failed` with a code), which the engine records as `abstained` coverage, never as "examined, nothing found".
 */
export async function processSlitherScanStep(ctx: EngineStepContext, step: ClaimedStep): Promise<void> {
  const a = assignmentSchema.parse(step.input);
  if (a.capability.id !== "slither" || a.capability.version !== SLITHER_VERSION) throw new Error(`slither_scan runs slither@${SLITHER_VERSION}, not ${a.capability.id}@${a.capability.version}`);
  const env = ctx.env ?? process.env;
  const store = new ResearchStore(ctx.pool); const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id);
  await checkVersion(ctx.pool, a, snap);
  const lease = { stepId: step.id, workerId: ctx.workerId };
  const base = { capability: a.capability, decision_id: a.decisionId, snapshot_id: snap.snapshotId, decided_on_snapshot_id: a.decidedOnSnapshotId, manifest_sha256: snap.manifestSha256, commit_sha: snap.commitSha, targets: a.targets, ...passive };
  await withHeartbeat(ctx, step, async () => {
    const slitherBin = env["AGENTSMITH_SLITHER_BIN"]; const solcBin = env["AGENTSMITH_SOLC_BIN"];
    const files = (await ctx.pool.query<{ path: string; content: Buffer }>(
      `SELECT f.path, b.content FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.snapshot_id = $1 AND f.path LIKE '%.sol' ORDER BY f.path COLLATE "C"`, [snap.snapshotId])).rows;
    const r = !slitherBin || !solcBin
      ? { ok: false as const, failure: { code: "tool_unavailable" as const, detail: "AGENTSMITH_SLITHER_BIN or AGENTSMITH_SOLC_BIN is not set on this worker" }, durationMs: 0 }
      : await runSlither({ files, slitherBin, solcBin, ...(env["AGENTSMITH_TOOL_TIMEOUT_MS"] ? { timeoutMs: Number(env["AGENTSMITH_TOOL_TIMEOUT_MS"]) } : {}) });
    if (!r.ok) { await ctx.worker.complete(step.id, { status: "tool_failed", failure: r.failure, classes_examined: [], hypothesis_ids: [], leads: [], wall_ms: r.durationMs, ...base }); return; }
    const rawBlob = Buffer.byteLength(r.rawOutput) <= 1_048_576 ? (await store.putBlob(lease, Buffer.from(r.rawOutput, "utf8"))).sha256 : null;
    const contracts = new Set(a.targets.map((t) => t.contract)); const paths = new Set(files.map((f) => f.path));
    const leads: LeadRef[] = []; const unmapped: Record<string, number> = {}; let outside = 0; let unanchored = 0;
    for (const d of r.detections) {
      if (!d.bugClass) { unmapped[d.check] = (unmapped[d.check] ?? 0) + 1; continue; }
      const el = d.elements.find((e) => e.type === "function" && e.contract && contracts.has(e.contract)) ?? d.elements.find((e) => e.contract && contracts.has(e.contract));
      if (!el) { outside++; continue; }
      if (!paths.has(el.file) || !el.lines.length) { unanchored++; continue; }
      const start = Math.min(...el.lines); const end = Math.max(...el.lines); const span = end - start + 1 <= MAX_SPAN_LINES ? [start, end] : [start, start];
      let spanId: string;
      try { spanId = await store.createEvidenceSpan(lease, { snapshotId: snap.snapshotId, path: el.file, lineStart: span[0]!, lineEnd: span[1]! }); } catch { unanchored++; continue; }
      const fn = el.type === "function" ? el.name : "";
      const h = await store.createHypothesis(lease, {
        snapshotId: snap.snapshotId, family: `slither-${d.check}`,
        claim: `Slither ${d.check} (${d.impact} impact, ${d.confidence} confidence) in ${el.contract}${fn ? `.${fn}` : ""}: ${d.description.split("\n")[0]!.slice(0, 600)}`,
        rationale: `Slither ${r.version} detector ${d.check}, mapped to AgentSmith class ${d.bugClass}. Tool output is a claim, not evidence. Full description: ${d.description.slice(0, 3000)}`,
        requiredChecks: ["independent validation by an evaluator other than Slither"], alternativeExplanations: ["detector false positive", "behaviour intended and guarded elsewhere"],
        generator: { kind: "deterministic_rule", id: "slither", version: r.version }, spans: [{ spanId, role: "primary" }],
      });
      if (!leads.some((l) => l.hypothesisId === h.id)) leads.push({ hypothesisId: h.id, class: d.bugClass, contract: el.contract!, function: fn, file: el.file, line: start });
    }
    const byClass: Record<string, number> = {}; for (const l of leads) byClass[l.class] = (byClass[l.class] ?? 0) + 1;
    await ctx.worker.complete(step.id, {
      status: "tool_completed", tool: { name: "slither", version: r.version, solc_version: r.solcVersion, args: r.args, input_manifest_sha256: r.inputManifestSha256, raw_output_sha256: r.rawOutputSha256, raw_output_blob: rawBlob, exit_codes: r.exitCodes, duration_ms: r.durationMs },
      classes_examined: [...capabilityById("slither").classes], hypothesis_ids: leads.map((l) => l.hypothesisId), leads, leads_by_class: byClass,
      detections_total: r.detections.length, unmapped_detectors: unmapped, outside_targets: outside, unanchored, wall_ms: r.durationMs, ...base,
    });
  });
}

/** Producer output of a run, whichever producer it was. */
export async function producerOutput(pool: Pick<Pool, "query">, runId: string): Promise<{ stepId: string; stepKey: string; status: string; output: Record<string, unknown> | null } | null> {
  const r = (await pool.query<{ id: string; step_key: string; status: string; output: Record<string, unknown> | null }>(
    "SELECT id, step_key, status, output FROM workflow_steps WHERE workflow_run_id = $1 AND sequence = 1 AND step_key = ANY($2::text[])", [runId, [INVESTIGATE_STEP_KEY, SLITHER_STEP_KEY, ATTENDED_STEP_KEY]])).rows[0];
  return r ? { stepId: r.id, stepKey: r.step_key, status: r.status, output: r.output } : null;
}

export async function processChallengeTargetStep(ctx: EngineStepContext, step: ClaimedStep): Promise<void> {
  const prod = await producerOutput(ctx.pool, step.workflow_run_id);
  const out = prod?.output as { snapshot_id?: string; leads?: LeadRef[]; status?: string } | null | undefined;
  if (!prod || prod.status !== "succeeded" || !out?.snapshot_id || !Array.isArray(out.leads)) throw new Error("the producer step has not produced structured results for this run");
  const store = new ResearchStore(ctx.pool); const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id);
  const started = Date.now();
  await withHeartbeat(ctx, step, async () => {
    let mine: StoredHypothesis[];
    if (prod.stepKey === INVESTIGATE_STEP_KEY) {
      const ids = new Set(out.leads!.map((l) => l.hypothesisId));
      mine = (await loadStoredHypotheses(ctx.pool, snap.snapshotId)).filter((h) => ids.has(h.id));
    } else {
      // an external producer's leads: the evaluators need only the class, the contract, the function and the location
      mine = [];
      for (const l of out.leads!) {
        const spans = (await ctx.pool.query<{ span_id: string }>("SELECT span_id FROM hypothesis_evidence WHERE hypothesis_id = $1 ORDER BY (role = 'primary') DESC, span_id", [l.hypothesisId])).rows.map((x) => x.span_id);
        const finding = { class: l.class as FindingClass, contract: l.contract, function: l.function, file: l.file, line: l.line, claim: "", rationale: "", requiredChecks: [], alternatives: [], spans: [], chain: [], assumptions: [], confidence: "low", detail: {} } as Finding;
        mine.push({ id: l.hypothesisId, finding, spanIds: spans });
      }
    }
    await runChallenge(ctx.pool, store, { stepId: step.id, workerId: ctx.workerId }, snap.snapshotId, mine);
    const evals = (await ctx.pool.query<{ outcome: string; n: string }>("SELECT outcome, count(*) n FROM hypothesis_evaluations WHERE produced_by_step_id = $1 GROUP BY outcome ORDER BY outcome", [step.id])).rows;
    await ctx.worker.complete(step.id, { status: "target_challenged", producer: prod.stepKey, snapshot_id: snap.snapshotId, leads: mine.length, evaluations: Object.fromEntries(evals.map((e) => [e.outcome, Number(e.n)])), wall_ms: Date.now() - started, ...passive });
  });
}

export async function dispatchEngineStep(ctx: EngineStepContext, step: ClaimedStep): Promise<boolean> {
  if (step.step_key === INVESTIGATE_STEP_KEY) { await processInvestigateTargetStep(ctx, step); return true; }
  if (step.step_key === SLITHER_STEP_KEY) { await processSlitherScanStep(ctx, step); return true; }
  if (step.step_key === CHALLENGE_TARGET_STEP_KEY) { await processChallengeTargetStep(ctx, step); return true; }
  if (step.step_key === FOUNDRY_STEP_KEY) { await processFoundryValidateStep(ctx, step); return true; }
  return false;
}
