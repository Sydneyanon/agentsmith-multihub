import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY, SLITHER_STEP_KEY } from "../analysis/solidity/keys.js";
import { slitherScanStepInput } from "../analysis/solidity/slither-record.js";
import { LeaseLostError } from "../step-errors.js";
import { ResearchStore } from "../research-state.js";
import type { ClaimedStep, WorkflowWorker } from "../worker.js";
import { acquireRepository, type AcquireRequest, type AcquisitionResult, type AcquisitionStore } from "./acquire.js";
import { AcquisitionError } from "./errors.js";
import { parseRepositoryName, type RepositorySource } from "./github-source.js";
import { parseBountyScope, type BountyScope } from "./bounty-scope.js";
import { acquisitionProgress, progressFor, type ProgressSink } from "../step-progress.js";

export const REPOSITORY_RESEARCH_WORKFLOW = "repository_research";
export const ACQUIRE_STEP_KEY = "acquire_repository";

const stepInput = z.object({
  repository: z.string().min(3).max(201),
  ref: z.string().min(1).max(250).optional(),
  excludePathPrefixes: z.array(z.string().min(1).max(1024)).max(100).optional(),
  onUnrepresentable: z.enum(["fail", "seal_partial"]).optional(),
}).strict();

export type RepositoryResearchInput = z.infer<typeof stepInput>;
/** The acquisition step's input schema (the API's snapshot verification re-reads the queued options with it). */
export const acquireStepInput = stepInput;

/**
 * Creates a `repository_research` run with its single `acquire_repository` step. Nothing creates these automatically yet:
 * discovery (Task 5.3) will. The run is passive by construction: acquisition reads a public repository and executes nothing.
 */
export type RepositoryResearchOptions = {
  /** append the analysis stages (analyse, challenge, dossier) after acquisition; OFF by default */ structuralAnalysis?: boolean;
  /** also insert the pinned Slither stage between analyse and challenge; OFF by default; requires structuralAnalysis */ slitherScan?: boolean;
  /** the official bounty scope, recorded on the run so the dossier labels every lead in or out of scope; absent for most runs */ bountyScope?: BountyScope;
};

export async function createRepositoryResearchRun(pool: Pool, input: RepositoryResearchInput, createdBy = "operator", options: RepositoryResearchOptions = {}): Promise<{ runId: string; stepId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await createRepositoryResearchRunIn(client, input, createdBy, options);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The same insert inside the caller's transaction, so a caller (discovery approval) can make "decision recorded" and "run queued" atomic. */
export async function createRepositoryResearchRunIn(client: Pick<PoolClient, "query">, input: RepositoryResearchInput, createdBy = "operator", options: RepositoryResearchOptions = {}): Promise<{ runId: string; stepId: string }> {
  const parsed = stepInput.parse(input);
  parseRepositoryName(parsed.repository);
  if (options.slitherScan === true && options.structuralAnalysis !== true) throw new Error("slitherScan requires structuralAnalysis (the Slither stage runs between analyse and challenge)");
  const run = await client.query<{ id: string; correlation_id: string }>(
      `INSERT INTO workflow_runs (workflow_type, status, input, created_by) VALUES ($1, 'queued', $2::jsonb, $3) RETURNING id, correlation_id`,
      [REPOSITORY_RESEARCH_WORKFLOW, JSON.stringify({ kind: "repository", value: parsed.repository, source: "user", ...(parsed.ref ? { ref: parsed.ref } : {}), execution_mode: "passive_only", authorization_status: "unverified", ...(options.bountyScope ? { bounty_scope: parseBountyScope(options.bountyScope) } : {}) }), createdBy]);
    const step = await client.query<{ id: string }>(
      `INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 0, 'repository_acquirer', $3::jsonb) RETURNING id`,
      [run.rows[0]!.id, ACQUIRE_STEP_KEY, JSON.stringify(parsed)]);
    await client.query(
      `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason, payload)
       VALUES ($1, 'repository_research.created', 'workflow_run', $2, $3, 'Repository acquisition requested (passive reading of a public repository)', jsonb_build_object('repository', $4::text, 'passive_only', true))`,
      [createdBy, run.rows[0]!.id, run.rows[0]!.correlation_id, parsed.repository]);
  if (options.structuralAnalysis === true) {
    const stages: Array<[string, string, Record<string, unknown>]> = [[ANALYZE_STEP_KEY, "structural_analyst", {}],
      ...(options.slitherScan === true ? [[SLITHER_STEP_KEY, "external_producer", slitherScanStepInput()] as [string, string, Record<string, unknown>]] : []),
      [CHALLENGE_STEP_KEY, "lead_challenger", {}], [DOSSIER_STEP_KEY, "dossier_builder", {}]];
    for (const [i, [key, role, stageInput]] of stages.entries()) {
      await client.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, $3, $4, $5::jsonb)`, [run.rows[0]!.id, key, i + 1, role, JSON.stringify(stageInput)]);
    }
    if (options.slitherScan === true) {
      await client.query(
        `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason, payload)
         VALUES ($1, 'repository_research.slither_scan_requested', 'workflow_run', $2, $3, 'Pinned Slither stage requested on the sealed snapshot (offline; a tool failure is recorded as an abstention)', jsonb_build_object('pinned_version', $4::text))`,
        [createdBy, run.rows[0]!.id, run.rows[0]!.correlation_id, String(slitherScanStepInput().pinned_version)]);
    }
  }
  return { runId: run.rows[0]!.id, stepId: step.rows[0]!.id };
}

export type AcquireStepContext = {
  /** The direct worker's connection. Option D's remote worker passes `store` instead and has no pool. */
  pool?: Pool; worker: Pick<WorkflowWorker, "heartbeat" | "complete"> & { reportProgress?: ProgressSink }; workerId: string; source: RepositorySource;
  store?: AcquisitionStore;
  /** How often the step lease is renewed while the acquisition runs (the worker's lease is 90 s by default). */
  heartbeatMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

/** Output stored on the step: pointers and counts only, never content. */
export function stepOutput(result: AcquisitionResult): Record<string, unknown> {
  return {
    status: "snapshot_sealed", snapshot_id: result.snapshotId, repository: result.repository, commit_sha: result.commitSha, tree_sha: result.treeSha,
    manifest_sha256: result.manifestSha256, file_count: result.fileCount, stored_files: result.storedFiles, stored_bytes: result.storedBytes,
    skipped_by_reason: result.skipped, completeness: result.completeness, reused: result.reused,
    execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false,
  };
}

export async function processAcquireRepositoryStep(context: AcquireStepContext, step: ClaimedStep): Promise<void> {
  const parsed = stepInput.safeParse(step.input);
  if (!parsed.success) throw new AcquisitionError("invalid_reference", `the step input is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  const request: AcquireRequest = {
    repository: parsed.data.repository,
    ...(parsed.data.ref !== undefined ? { ref: parsed.data.ref } : {}),
    ...(parsed.data.excludePathPrefixes ? { excludePathPrefixes: parsed.data.excludePathPrefixes } : {}),
    ...(parsed.data.onUnrepresentable ? { onUnrepresentable: parsed.data.onUnrepresentable } : {}),
  };
  const controller = new AbortController();
  let leaseLost = false;
  const beat = setInterval(() => {
    context.worker.heartbeat(step.id).then((alive) => { if (!alive) { leaseLost = true; controller.abort(); } }, () => { /* a failed beat is retried at the next interval; the lease check on writes is the authority */ });
  }, context.heartbeatMs ?? 30_000);
  try {
    const store = context.store ?? (context.pool ? new ResearchStore(context.pool) : null);
    if (!store) throw new Error("acquisition needs either a database pool or a research store port");
    // intra-step progress (step-progress.ts): reported by the worker, throttled, never a reason to fail the acquisition
    const reporter = progressFor(context.worker, step.id, { onError: (error) => context.log?.("acquisition progress report not stored", { error: error instanceof Error ? error.message : String(error) }) });
    const progress = (event: string, fields?: Record<string, unknown>) => {
      context.log?.(`acquisition ${event}`, fields);
      const p = acquisitionProgress(event, fields);
      if (p) reporter.report(p.phase, p.done, p.total, p.unit);
    };
    const result = await acquireRepository({ store, source: context.source, signal: controller.signal, progress }, { stepId: step.id, workerId: context.workerId }, request);
    await reporter.flush();
    await context.worker.complete(step.id, stepOutput(result));
  } catch (error) {
    if (leaseLost) throw new LeaseLostError("the step lease was lost during acquisition");
    throw error;
  } finally {
    clearInterval(beat);
  }
}
