import type { Pool } from "pg";
import { z } from "zod";

/**
 * Intra-step progress (docs/research-runs/live-operations-dashboard-spec.md §1). A worker reports how far it is inside a step as an
 * append-only audit event `workflow_step.progress` with payload `{phase, done, total, unit}`; no migration is needed. These numbers are
 * REPORTED BY THE WORKER (the dashboard labels them so); the counts the API derives from its own records are a different, verified source.
 *
 * Throttling happens twice: the worker's ProgressReporter sends at most one report per interval (plus every phase change and every
 * phase completion), and the writer refuses to store a report of the same phase within the interval anyway, so a misbehaving worker
 * cannot flood the table. A step also has a hard ceiling on the number of progress records.
 */
export const PROGRESS_ACTION = "workflow_step.progress";
/** Minimum spacing of two stored reports of the same phase (a phase change or a completed phase is always stored). */
export const PROGRESS_MIN_INTERVAL_MS = 2_000;
/** Hard ceiling of stored progress records per step attempt history (all attempts together). */
export const MAX_PROGRESS_RECORDS_PER_STEP = 500;

export const PROGRESS_UNITS = ["files", "blobs", "manifest_rows", "archive_entries", "solidity_files", "hypotheses", "leads", "evaluations", "dossiers", "api_requests"] as const;
export type ProgressUnit = (typeof PROGRESS_UNITS)[number];

export const stepProgressFields = {
  phase: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  done: z.number().int().min(0).max(1e9),
  total: z.number().int().min(0).max(1e9).nullable(),
  unit: z.enum(PROGRESS_UNITS),
};
export const doneWithinTotal = (p: { done: number; total: number | null }) => p.total === null || p.done <= p.total;
export const stepProgressSchema = z.object(stepProgressFields).strict().refine(doneWithinTotal, { message: "done must not exceed total" });
export type StepProgress = z.infer<typeof stepProgressSchema>;

export type ProgressWrite = { recorded: true } | { recorded: false; reason: "throttled" | "lease_not_held" | "limit_reached" };

/**
 * Stores one progress report for a step, but only while `owner` holds the step's live lease. One statement: the lease check, the
 * throttle (same phase within the interval, unless the phase is complete), the per-step ceiling and the insert cannot race apart.
 */
export async function recordStepProgress(db: Pick<Pool, "query">, input: { stepId: string; owner: string; actor: string; via: "direct_worker" | "worker_api"; tokenId?: string; progress: StepProgress }): Promise<ProgressWrite> {
  const p = stepProgressSchema.parse(input.progress);
  const complete = p.total !== null && p.done === p.total;
  const rows = (await db.query<{ held: boolean; throttled: boolean; full: boolean; inserted: boolean }>(
    `WITH s AS (
       SELECT st.id, st.step_key, st.attempt, wr.correlation_id FROM workflow_steps st JOIN workflow_runs wr ON wr.id = st.workflow_run_id
       WHERE st.id = $1 AND st.status = 'running' AND st.lease_owner = $2 AND st.lease_expires_at > now()
     ), last AS (
       SELECT a.payload->>'phase' AS phase, a.created_at FROM audit_events a
       WHERE a.entity_type = 'workflow_step' AND a.entity_id = $1::text AND a.action = '${PROGRESS_ACTION}' ORDER BY a.created_at DESC, a.id DESC LIMIT 1
     ), n AS (
       SELECT count(*)::int AS n FROM audit_events a WHERE a.entity_type = 'workflow_step' AND a.entity_id = $1::text AND a.action = '${PROGRESS_ACTION}'
     ), verdict AS (
       SELECT EXISTS (SELECT 1 FROM s) AS held,
              (NOT $8::boolean AND EXISTS (SELECT 1 FROM last WHERE last.phase = $4 AND last.created_at > now() - ($9::int * interval '1 millisecond'))) AS throttled,
              (SELECT n FROM n) >= $10::int AS full
     ), ins AS (
       INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, payload)
       SELECT $3, '${PROGRESS_ACTION}', 'workflow_step', s.id::text, s.correlation_id,
              jsonb_build_object('phase', $4::text, 'done', $5::bigint, 'total', $6::bigint, 'unit', $7::text, 'reported_by', 'worker', 'via', $11::text,
                                 'step_key', s.step_key, 'attempt', s.attempt) || CASE WHEN $12::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('token_id', $12::text) END
       FROM s, verdict WHERE verdict.held AND NOT verdict.throttled AND NOT verdict.full
       RETURNING 1
     )
     SELECT verdict.held, verdict.throttled, verdict.full, EXISTS (SELECT 1 FROM ins) AS inserted FROM verdict`,
    [input.stepId, input.owner, input.actor, p.phase, p.done, p.total, p.unit, complete, PROGRESS_MIN_INTERVAL_MS, MAX_PROGRESS_RECORDS_PER_STEP, input.via, input.tokenId ?? null])).rows[0]!;
  if (rows.inserted) return { recorded: true };
  if (!rows.held) return { recorded: false, reason: "lease_not_held" };
  if (rows.full) return { recorded: false, reason: "limit_reached" };
  return { recorded: false, reason: "throttled" };
}

export type ProgressSink = (stepId: string, progress: StepProgress) => Promise<unknown>;

/**
 * The worker side of the throttle. `report` never throws and never blocks the step: a report is sent when the phase changes, when a
 * phase completes, or when at least `intervalMs` passed since the last one sent; reports in between are dropped (the next one carries
 * the newer count). Reports are sent one at a time, in order. A failed send is swallowed: progress is an observation, never a reason
 * to fail research work.
 */
export class ProgressReporter {
  private lastPhase: string | null = null;
  private lastSentAt = -Infinity;
  private chain: Promise<void> = Promise.resolve();
  sent = 0; dropped = 0; failed = 0;

  constructor(private readonly sink: ProgressSink | undefined, private readonly stepId: string, private readonly opts: { intervalMs?: number; now?: () => number; onError?: (error: unknown) => void } = {}) {}

  report(phase: string, done: number, total: number | null, unit: ProgressUnit): void {
    if (!this.sink) return;
    const now = (this.opts.now ?? Date.now)();
    const complete = total !== null && done >= total;
    if (phase === this.lastPhase && !complete && now - this.lastSentAt < (this.opts.intervalMs ?? PROGRESS_MIN_INTERVAL_MS)) { this.dropped += 1; return; }
    this.lastPhase = phase; this.lastSentAt = now;
    const progress: StepProgress = { phase, done: Math.max(0, Math.floor(done)), total: total === null ? null : Math.max(0, Math.floor(total)), unit };
    if (progress.total !== null && progress.done > progress.total) progress.done = progress.total;
    const sink = this.sink;
    this.chain = this.chain.then(() => sink(this.stepId, progress)).then(() => { this.sent += 1; }, (error: unknown) => { this.failed += 1; this.opts.onError?.(error); });
  }

  /** Resolves when every report sent so far has been handled, or after `timeoutMs` at most (a slow report never holds up a step). */
  flush(timeoutMs = 2_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([this.chain, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]).finally(() => clearTimeout(timer));
  }
}

/** A reporter for a step whose lifecycle port may or may not support progress (older ports and fakes do not). */
export function progressFor(worker: { reportProgress?: ProgressSink }, stepId: string, opts?: ConstructorParameters<typeof ProgressReporter>[2]): ProgressReporter {
  return new ProgressReporter(worker.reportProgress ? (id, p) => worker.reportProgress!(id, p) : undefined, stepId, opts);
}

/** Maps the acquisition's internal progress events (acquire.ts) to stored progress. Events without a count are not reported. */
export function acquisitionProgress(event: string, fields: Record<string, unknown> = {}): StepProgress | null {
  const n = (k: string) => (typeof fields[k] === "number" && Number.isFinite(fields[k]) ? Math.max(0, Math.floor(fields[k] as number)) : null);
  switch (event) {
    case "resolved": return { phase: "resolved_commit", done: 0, total: null, unit: "files" };
    case "planned": return n("candidates") === null ? null : { phase: "planned", done: 0, total: n("candidates"), unit: "files" };
    case "archive_verified": return n("entries") === null ? null : { phase: "archive_verified", done: n("entries")!, total: n("entries"), unit: "archive_entries" };
    case "blobs_stored": return n("done") === null || n("total") === null ? null : { phase: "storing_blobs", done: Math.min(n("done")!, n("total")!), total: n("total"), unit: "blobs" };
    case "manifest_rows_added": return n("done") === null || n("total") === null ? null : { phase: "writing_manifest", done: Math.min(n("done")!, n("total")!), total: n("total"), unit: "manifest_rows" };
    case "sealed": return n("files") === null ? null : { phase: "sealed", done: n("files")!, total: n("files"), unit: "manifest_rows" };
    case "already_sealed": return { phase: "already_sealed", done: 0, total: null, unit: "files" };
    default: return null;
  }
}
