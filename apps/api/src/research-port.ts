import type { Dossier } from "./analysis/solidity/pipeline.js";
import type { SlitherScanOutcome } from "./analysis/solidity/slither-record.js";
import type { ResearchStore } from "./research-state.js";
import type { ClaimedStep } from "./worker.js";

/**
 * Option D: the port between a `repository_research` worker and the database. Everything such a worker does to the database goes
 * through these three interfaces, and nothing else. Two implementations exist:
 *
 * - direct (the default, unchanged): `WorkflowWorker` + `ResearchStore` + `dbResearchReads` (analysis/solidity/step.ts), i.e. the very
 *   same SQL the worker always ran, on the worker's own database connection;
 * - remote (`WORKER_STORE=api`): `WorkerApiClient` (worker-api-client.ts), which holds NO database credential and calls the API's
 *   internal routes (worker-api.ts). The API side executes the same `WorkflowWorker`, `ResearchStore` and read functions on its own
 *   owner connection, under the same lease rules, so no business logic is duplicated.
 *
 * Types only: importing this module has no runtime effect (and creates no import cycle).
 */

/** The research-store writes (and the two lease-scoped reads acquisition makes through the store). There is no update or delete. */
export type ResearchStorePort = Pick<ResearchStore,
  "putBlob" | "createSnapshot" | "findSnapshot" | "addSnapshotFiles" | "sealSnapshot" | "verifySnapshot" | "createEvidenceSpan" | "createHypothesis" | "recordEvaluation">;

/** Step lifecycle under a lease. `claimNext` and `fail` are used by the loop; steps themselves only heartbeat and complete. */
export type StepLifecyclePort = {
  heartbeat(stepId: string): Promise<boolean>;
  complete(stepId: string, output?: Record<string, unknown>): Promise<void>;
};
export type WorkerLoopPort = StepLifecyclePort & {
  claimNext(allowedStepKeys?: readonly string[], onlyRunId?: string): Promise<ClaimedStep | null>;
  fail(stepId: string, reason: string, retryable?: boolean): Promise<void>;
};

export type SealedSnapshotRef = { snapshotId: string; commitSha: string; manifestSha256: string; repository: string };

/** The reads the analysis stages make (pipeline.ts uses the first three; `PipelineReads` there is this subset). */
export interface ResearchReads {
  /** The Solidity sources of a snapshot, as text, ordered by path bytes. */
  snapshotSources(snapshotId: string): Promise<Array<{ path: string; text: string }>>;
  /** The specialists' stored hypothesis with exactly this claim on the snapshot, if any. */
  specialistHypothesisId(snapshotId: string, claim: string): Promise<string | null>;
  /** A hypothesis's cited spans, primary first. */
  hypothesisSpanIds(hypothesisId: string): Promise<string[]>;
  /** The sealed, verified snapshot the acquisition step of a run produced (throws when there is none). */
  sealedSnapshot(runId: string): Promise<SealedSnapshotRef>;
  /** The Solidity sources of a snapshot as stored bytes (the Slither stage writes them to a private directory). */
  snapshotSolidityFiles(snapshotId: string): Promise<Array<{ path: string; content: Buffer }>>;
  /** The research-run Slither stage's recorded outcome. */
  slitherScanOfRun(runId: string): Promise<{ exists: boolean; outcome: SlitherScanOutcome | null }>;
  /** Of `ids`, those that really are Slither's hypotheses on this snapshot. */
  slitherHypothesisIds(ids: readonly string[], snapshotId: string): Promise<string[]>;
  /** The dossier, built ONLY from stored records (re-verifies every cited span; fails closed). */
  buildDossier(snapshotId: string): Promise<Dossier>;
}
