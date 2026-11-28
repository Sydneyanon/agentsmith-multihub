import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ACQUIRE_STEP_KEY, REPOSITORY_RESEARCH_WORKFLOW } from "./acquisition/step.js";
import { ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY, SLITHER_STEP_KEY } from "./analysis/solidity/keys.js";
import { SPECIALIST_ID, SPECIALIST_VERSION, VALIDATOR_ID } from "./analysis/solidity/pipeline.js";
import { isResearchSlitherStep } from "./analysis/solidity/slither-record.js";
import { dbResearchReads } from "./analysis/solidity/step.js";
import { AuthFailureLimiter, rawPath } from "./auth.js";
import { MAX_BLOB_BYTES, ResearchConflictError, ResearchStore, type SnapshotFileInput } from "./research-state.js";
import type { ResearchReads } from "./research-port.js";
import { LeaseLostError } from "./step-errors.js";
import { WorkflowWorker } from "./worker.js";
import { mintWorkerToken, parseWorkerToken, redactWorkerTokens, revokeWorkerToken, secretMatches, WorkerTokenError } from "./worker-tokens.js";

/**
 * Option D: the internal worker API. A `repository_research` worker that holds NO database credential performs every read and write
 * its run needs through these routes; the API executes them on its own (owner) connection with the SAME WorkflowWorker, ResearchStore
 * and read functions the direct worker uses, under the same lease rules. There is no generic query, no generic table write, and no
 * update or delete of any research record: the operations below are the complete list.
 *
 * Every request carries a run-scoped capability token (worker-tokens.ts). Every operation except `claim` names a step of the token's
 * run whose lease the token's worker currently holds, and each operation is allowed only for the step keys that need it. Every
 * accepted and refused call is written to audit_events with the token id (never the token). State-changing calls carry an
 * idempotency key and are recorded in worker_api_requests in the same transaction as their effect, so a retry never writes twice.
 */
export const WORKER_API_PREFIX = "/internal/worker/v1/";
export const RESEARCH_STEP_KEYS = [ACQUIRE_STEP_KEY, ANALYZE_STEP_KEY, SLITHER_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY] as const;
const A = ACQUIRE_STEP_KEY, Z = ANALYZE_STEP_KEY, S = SLITHER_STEP_KEY, C = CHALLENGE_STEP_KEY, D = DOSSIER_STEP_KEY;

export type WorkerApiOptions = {
  /** When set, the routes answer only on connections accepted on this local port (the private 6PN listener); others get 404. */
  privateListenerPort?: number;
  /** Per-token request rate. Default 200/s with a burst of 400 (acquisition stores one blob per request). */
  rateLimit?: { perSecond: number; burst: number };
  leaseSeconds?: number;
  maxAttempts?: number;
  /** How often the API reaps exhausted leases (remote workers do not). Default 60 s; 0 disables. */
  reaperIntervalMs?: number;
  limiter?: AuthFailureLimiter;
};

type Kind = "plain" | "idempotent";
type LeaseRule = "none" | "held" | "owned";
type Ctx = {
  db: Pick<Pool, "query">; tokenId: string; runId: string; owner: string; step: StepRow | null;
  worker: WorkflowWorker; store: ResearchStore; reads: ResearchReads;
};
type StepRow = { id: string; step_key: string; input: Record<string, unknown>; status: string; lease_owner: string | null; unexpired: boolean };
type Operation = {
  kind: Kind; lease: LeaseRule; stepKeys: readonly string[] | "any"; bodyLimit: number; schema: z.ZodTypeAny;
  run(ctx: Ctx, args: any): Promise<unknown>;
};

export class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); this.name = "Refusal"; }
}

const uuid = z.string().uuid();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const stepId = { step_id: uuid };
const KiB = 1024, MiB = 1024 * 1024;
const shortText = z.string().min(1).max(1000);
const fileRow = z.union([
  z.object({ path: z.string().min(1).max(1024), classification: z.string().min(1).max(32), size_bytes: z.number().int().min(0), blob_sha256: hex64, git_blob_sha: z.string().regex(/^[0-9a-f]{40}$/).optional() }).strict(),
  z.object({ path: z.string().min(1).max(1024), classification: z.string().min(1).max(32), size_bytes: z.number().int().min(0), skip_reason: z.string().min(1).max(64), git_blob_sha: z.string().regex(/^[0-9a-f]{40}$/).optional() }).strict(),
]);
const EVALUATOR = new RegExp(`^(no-independent-validator|${VALIDATOR_ID}|execution-challenge-[a-z][a-z-]{0,40})$`);
const EXPECTED_STATUS: Record<string, readonly string[]> = { [A]: ["snapshot_sealed"], [Z]: ["structure_analyzed"], [S]: ["tool_completed", "abstained"], [C]: ["leads_challenged"], [D]: ["dossier_built"] };

async function snapshotInRun(ctx: Ctx, snapshotId: string): Promise<void> {
  const ok = (await ctx.db.query("SELECT 1 FROM repo_snapshots WHERE id = $1 AND workflow_run_id = $2", [snapshotId, ctx.runId])).rowCount;
  if (!ok) throw new Refusal(403, "cross_run_reference", "the snapshot is not part of this token's run");
}
async function hypothesisInRun(ctx: Ctx, hypothesisId: string): Promise<void> {
  const ok = (await ctx.db.query("SELECT 1 FROM hypotheses WHERE id = $1 AND workflow_run_id = $2", [hypothesisId, ctx.runId])).rowCount;
  if (!ok) throw new Refusal(403, "cross_run_reference", "the hypothesis is not part of this token's run");
}
async function spansInRun(ctx: Ctx, spanIds: readonly string[]): Promise<void> {
  if (!spanIds.length) return;
  const n = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM evidence_spans WHERE id = ANY($1::uuid[]) AND workflow_run_id = $2", [[...new Set(spanIds)], ctx.runId])).rows[0]!.n;
  if (n !== new Set(spanIds).size) throw new Refusal(403, "cross_run_reference", "a cited span is not part of this token's run");
}
const lease = (ctx: Ctx) => ({ stepId: ctx.step!.id, workerId: ctx.owner });

/** The complete list of operations. Anything not named here does not exist. */
export const OPERATIONS: Record<string, Operation> = {
  // ---- step lifecycle (WorkflowWorker, the same SQL the direct worker runs) ----
  claim: {
    kind: "idempotent", lease: "none", stepKeys: "any", bodyLimit: 4 * KiB,
    schema: z.object({ step_keys: z.array(z.enum(RESEARCH_STEP_KEYS)).min(1).max(RESEARCH_STEP_KEYS.length) }).strict(),
    async run(ctx, args: { step_keys: string[] }) {
      let keys = [...new Set(args.step_keys)];
      // slither_scan is shared with the engine loop: never offer it when this run has a slither_scan step that is not the research stage
      if (keys.includes(S)) {
        const foreign = (await ctx.db.query(`SELECT 1 FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2 AND (input->>'scope') IS DISTINCT FROM 'repository_research'`, [ctx.runId, S])).rowCount;
        if (foreign) keys = keys.filter((k) => k !== S);
      }
      return ctx.worker.claimNext(keys, ctx.runId);
    },
  },
  heartbeat: { kind: "plain", lease: "held", stepKeys: "any", bodyLimit: 4 * KiB, schema: z.object(stepId).strict(), run: (ctx) => ctx.worker.heartbeat(ctx.step!.id) },
  complete: {
    kind: "idempotent", lease: "held", stepKeys: "any", bodyLimit: 2 * MiB,
    schema: z.object({ ...stepId, output: z.record(z.unknown()) }).strict(),
    async run(ctx, args: { output: Record<string, unknown> }) {
      const key = ctx.step!.step_key; const status = args.output["status"];
      if (typeof status !== "string" || !EXPECTED_STATUS[key]?.includes(status)) throw new Refusal(422, "output_rejected", `a ${key} step completes with status ${EXPECTED_STATUS[key]?.join(" or ")}`);
      if (typeof args.output["snapshot_id"] === "string" || key === A) {
        const snap = args.output["snapshot_id"];
        if (typeof snap !== "string" || !uuid.safeParse(snap).success) throw new Refusal(422, "output_rejected", "the output must name the run's snapshot");
        const row = (await ctx.db.query<{ sealed: boolean }>("SELECT sealed_at IS NOT NULL AS sealed FROM repo_snapshots WHERE id = $1 AND workflow_run_id = $2", [snap, ctx.runId])).rows[0];
        if (!row) throw new Refusal(403, "cross_run_reference", "the output names a snapshot outside this token's run");
        if (key === A && !row.sealed) throw new Refusal(422, "output_rejected", "an acquisition completes only with a sealed snapshot");
      }
      await ctx.worker.complete(ctx.step!.id, args.output); return null;
    },
  },
  fail: {
    kind: "idempotent", lease: "owned", stepKeys: "any", bodyLimit: 16 * KiB,
    schema: z.object({ ...stepId, reason: z.string().max(4000), retryable: z.boolean() }).strict(),
    async run(ctx, args: { reason: string; retryable: boolean }) { await ctx.worker.fail(ctx.step!.id, redactWorkerTokens(args.reason), args.retryable); return null; },
  },

  // ---- acquisition (ResearchStore) ----
  find_snapshot: {
    kind: "plain", lease: "held", stepKeys: [A], bodyLimit: 4 * KiB,
    schema: z.object({ ...stepId, repository: z.string().min(3).max(201), commit_sha: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
    run: (ctx, a: { repository: string; commit_sha: string }) => ctx.store.findSnapshot(lease(ctx), a.repository, a.commit_sha),
  },
  create_snapshot: {
    kind: "idempotent", lease: "held", stepKeys: [A], bodyLimit: 2 * MiB,
    schema: z.object({ ...stepId, repository: z.string().min(3).max(201), commit_sha: z.string().regex(/^[0-9a-f]{40}$/), ref_name: z.string().min(1).max(250).optional(), acquisition_report: z.record(z.unknown()).optional() }).strict(),
    run: (ctx, a: { repository: string; commit_sha: string; ref_name?: string; acquisition_report?: Record<string, unknown> }) => {
      // the snapshot must be of the repository and ref the operator queued (GitHub's canonical name may differ in case only)
      const input = ctx.step!.input as { repository?: unknown; ref?: unknown };
      if (typeof input.repository !== "string" || input.repository.toLowerCase() !== a.repository.toLowerCase() || (input.ref ?? null) !== (a.ref_name ?? null)) {
        throw new Refusal(403, "repository_mismatch", "the snapshot is not of the repository and ref this step was queued for");
      }
      return ctx.store.createSnapshot(lease(ctx), { repository: a.repository, commitSha: a.commit_sha, ...(a.ref_name !== undefined ? { refName: a.ref_name } : {}), ...(a.acquisition_report ? { acquisitionReport: a.acquisition_report } : {}) });
    },
  },
  put_blob: {
    kind: "idempotent", lease: "held", stepKeys: [A, Z, S], bodyLimit: Math.ceil(MAX_BLOB_BYTES * 4 / 3) + 4 * KiB,
    schema: z.object({ ...stepId, content_base64: z.string().max(Math.ceil(MAX_BLOB_BYTES * 4 / 3) + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
    run: (ctx, a: { content_base64: string }) => ctx.store.putBlob(lease(ctx), Buffer.from(a.content_base64, "base64")),
  },
  add_snapshot_files: {
    kind: "idempotent", lease: "held", stepKeys: [A], bodyLimit: 3 * MiB,
    schema: z.object({ ...stepId, snapshot_id: uuid, files: z.array(fileRow).min(1).max(500) }).strict(),
    async run(ctx, a: { snapshot_id: string; files: Array<Record<string, any>> }) {
      await snapshotInRun(ctx, a.snapshot_id);
      const files: SnapshotFileInput[] = a.files.map((f) => ({ path: f.path, classification: f.classification, sizeBytes: f.size_bytes,
        ...("blob_sha256" in f ? { blobSha256: f.blob_sha256 } : { skipReason: f.skip_reason }), ...(f.git_blob_sha ? { gitBlobSha: f.git_blob_sha } : {}) }) as SnapshotFileInput);
      await ctx.store.addSnapshotFiles(lease(ctx), a.snapshot_id, files); return null;
    },
  },
  seal_snapshot: {
    kind: "idempotent", lease: "held", stepKeys: [A], bodyLimit: 4 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid }).strict(),
    async run(ctx, a: { snapshot_id: string }) { await snapshotInRun(ctx, a.snapshot_id); return ctx.store.sealSnapshot(lease(ctx), a.snapshot_id); },
  },
  verify_snapshot: {
    kind: "plain", lease: "held", stepKeys: [A], bodyLimit: 4 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid }).strict(),
    async run(ctx, a: { snapshot_id: string }) { await snapshotInRun(ctx, a.snapshot_id); return ctx.store.verifySnapshot(a.snapshot_id); },
  },

  // ---- analysis reads (the queries dbResearchReads runs) ----
  sealed_snapshot: { kind: "plain", lease: "held", stepKeys: [Z, S, C, D], bodyLimit: 4 * KiB, schema: z.object(stepId).strict(), run: (ctx) => ctx.reads.sealedSnapshot(ctx.runId) },
  snapshot_sources: {
    kind: "plain", lease: "held", stepKeys: [Z, C], bodyLimit: 4 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid }).strict(),
    async run(ctx, a: { snapshot_id: string }) { await snapshotInRun(ctx, a.snapshot_id); return ctx.reads.snapshotSources(a.snapshot_id); },
  },
  snapshot_solidity_files: {
    kind: "plain", lease: "held", stepKeys: [S], bodyLimit: 4 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid }).strict(),
    async run(ctx, a: { snapshot_id: string }) {
      await snapshotInRun(ctx, a.snapshot_id);
      return (await ctx.reads.snapshotSolidityFiles(a.snapshot_id)).map((f) => ({ path: f.path, content_base64: f.content.toString("base64") }));
    },
  },
  specialist_hypothesis_id: {
    kind: "plain", lease: "held", stepKeys: [C], bodyLimit: 16 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid, claim: z.string().min(1).max(2000) }).strict(),
    async run(ctx, a: { snapshot_id: string; claim: string }) { await snapshotInRun(ctx, a.snapshot_id); return ctx.reads.specialistHypothesisId(a.snapshot_id, a.claim); },
  },
  hypothesis_span_ids: {
    kind: "plain", lease: "held", stepKeys: [C], bodyLimit: 4 * KiB, schema: z.object({ ...stepId, hypothesis_id: uuid }).strict(),
    async run(ctx, a: { hypothesis_id: string }) { await hypothesisInRun(ctx, a.hypothesis_id); return ctx.reads.hypothesisSpanIds(a.hypothesis_id); },
  },
  specialist_hypotheses_of_run: {
    kind: "plain", lease: "held", stepKeys: [C], bodyLimit: 4 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid }).strict(),
    async run(ctx, a: { snapshot_id: string }) { await snapshotInRun(ctx, a.snapshot_id); return ctx.reads.specialistHypothesesOfRun(ctx.runId, a.snapshot_id); },
  },
  slither_scan_outcome: { kind: "plain", lease: "held", stepKeys: [C], bodyLimit: 4 * KiB, schema: z.object(stepId).strict(), run: (ctx) => ctx.reads.slitherScanOfRun(ctx.runId) },
  slither_hypothesis_ids: {
    kind: "plain", lease: "held", stepKeys: [C], bodyLimit: 256 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid, ids: z.array(uuid).max(5000) }).strict(),
    async run(ctx, a: { snapshot_id: string; ids: string[] }) { await snapshotInRun(ctx, a.snapshot_id); return ctx.reads.slitherHypothesisIds(a.ids, a.snapshot_id); },
  },
  build_dossier: {
    kind: "plain", lease: "held", stepKeys: [D], bodyLimit: 4 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid }).strict(),
    async run(ctx, a: { snapshot_id: string }) { await snapshotInRun(ctx, a.snapshot_id); return ctx.reads.buildDossier(a.snapshot_id); },
  },

  // ---- analysis writes (ResearchStore; append-only) ----
  create_evidence_span: {
    kind: "idempotent", lease: "held", stepKeys: [Z, S], bodyLimit: 8 * KiB,
    schema: z.object({ ...stepId, snapshot_id: uuid, path: z.string().min(1).max(1024), line_start: z.number().int().min(1), line_end: z.number().int().min(1) }).strict(),
    async run(ctx, a: { snapshot_id: string; path: string; line_start: number; line_end: number }) {
      await snapshotInRun(ctx, a.snapshot_id);
      return ctx.store.createEvidenceSpan(lease(ctx), { snapshotId: a.snapshot_id, path: a.path, lineStart: a.line_start, lineEnd: a.line_end });
    },
  },
  create_hypothesis: {
    kind: "idempotent", lease: "held", stepKeys: [Z, S], bodyLimit: 128 * KiB,
    schema: z.object({
      ...stepId, snapshot_id: uuid, family: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/), claim: z.string().min(10).max(2000), rationale: z.string().min(1).max(8000),
      required_checks: z.array(shortText).max(50), alternative_explanations: z.array(shortText).max(50),
      // a worker can only ever record deterministic-rule leads: never a model's, a human's or an attended specialist's
      generator: z.object({ kind: z.literal("deterministic_rule"), id: z.string().min(1).max(200), version: z.string().min(1).max(100) }).strict(),
      spans: z.array(z.object({ span_id: uuid, role: z.enum(["primary", "supporting", "context"]) }).strict()).min(1).max(50),
    }).strict(),
    async run(ctx, a: { snapshot_id: string; family: string; claim: string; rationale: string; required_checks: string[]; alternative_explanations: string[]; generator: { kind: "deterministic_rule"; id: string; version: string }; spans: Array<{ span_id: string; role: "primary" | "supporting" | "context" }> }) {
      const key = ctx.step!.step_key;
      const allowed = key === Z ? a.generator.id === SPECIALIST_ID && a.generator.version === SPECIALIST_VERSION : a.generator.id === "slither";
      if (!allowed) throw new Refusal(403, "generator_not_allowed", `a ${key} step may not record hypotheses as generator ${a.generator.id}`);
      await snapshotInRun(ctx, a.snapshot_id); await spansInRun(ctx, a.spans.map((s) => s.span_id));
      return ctx.store.createHypothesis(lease(ctx), { snapshotId: a.snapshot_id, family: a.family, claim: a.claim, rationale: a.rationale, requiredChecks: a.required_checks,
        alternativeExplanations: a.alternative_explanations, generator: a.generator, spans: a.spans.map((s) => ({ spanId: s.span_id, role: s.role })) });
    },
  },
  record_evaluation: {
    kind: "idempotent", lease: "held", stepKeys: [C], bodyLimit: 64 * KiB,
    schema: z.object({
      ...stepId, hypothesis_id: uuid, evaluator_id: z.string().regex(EVALUATOR), evaluator_version: z.string().min(1).max(100),
      outcome: z.enum(["supports", "weakens", "contradicts", "inconclusive"]), rationale: z.string().min(1).max(8000), span_ids: z.array(uuid).max(50), input_sha256: hex64,
    }).strict(),
    async run(ctx, a: { hypothesis_id: string; evaluator_id: string; evaluator_version: string; outcome: "supports" | "weakens" | "contradicts" | "inconclusive"; rationale: string; span_ids: string[]; input_sha256: string }) {
      await hypothesisInRun(ctx, a.hypothesis_id); await spansInRun(ctx, a.span_ids);
      return ctx.store.recordEvaluation(lease(ctx), { hypothesisId: a.hypothesis_id, evaluatorId: a.evaluator_id, evaluatorVersion: a.evaluator_version, outcome: a.outcome, rationale: a.rationale, spanIds: a.span_ids, inputSha256: a.input_sha256 });
    },
  },
};
export const WORKER_OPERATION_PATHS: ReadonlySet<string> = new Set(Object.keys(OPERATIONS).map((op) => `${WORKER_API_PREFIX}${op}`));
/** For the operator bearer hook: exactly these POST paths are authenticated by the worker token instead (and nothing else). */
export const isWorkerApiRequest = (method: string, rawUrl: string) => method === "POST" && WORKER_OPERATION_PATHS.has(rawPath(rawUrl));

/**
 * Run the store's own transactions as savepoints inside the API's request transaction, so the effect, its idempotency record and its
 * audit record commit together or not at all. The store's code and SQL are unchanged; only BEGIN/COMMIT/ROLLBACK are mapped.
 */
function transactionalPool(client: PoolClient): Pool {
  let depth = 0;
  const query = (text: unknown, params?: unknown) => {
    if (text === "BEGIN") { depth += 1; return client.query(`SAVEPOINT wapi_${depth}`); }
    if (text === "COMMIT") { const d = depth; depth -= 1; return client.query(`RELEASE SAVEPOINT wapi_${d}`); }
    if (text === "ROLLBACK") { const d = depth; depth -= 1; return client.query(`ROLLBACK TO SAVEPOINT wapi_${d}`); }
    return client.query(text as string, params as unknown[]);
  };
  const wrapped = { query, release: () => undefined };
  return { connect: async () => wrapped, query } as unknown as Pool;
}

/** A per-key token bucket, in memory and per process. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly perSecond: number, private readonly burst: number, private readonly now: () => number = Date.now) {}
  /** 0 when allowed, else seconds to wait. */
  take(key: string): number {
    const t = this.now(); const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.perSecond); b.at = t;
    if (b.tokens < 1) { this.buckets.set(key, b); return Math.max(1, Math.ceil((1 - b.tokens) / this.perSecond)); }
    b.tokens -= 1; this.buckets.set(key, b);
    if (this.buckets.size > 10_000) for (const k of this.buckets.keys()) { this.buckets.delete(k); if (this.buckets.size <= 5_000) break; }
    return 0;
  }
}

type Auth = { tokenId: string; runId: string; runStatus: string; correlationId: string | null };
type AuditEntry = { auth: Partial<Auth> | null; operation: string; stepId: string | null; outcome: "accepted" | "refused" | "replayed"; code: string; status: number; presentedTokenId?: string };

const TRANSIENT_SQLSTATE = /^(08|57P0[123]|53300|40001|40P01)/;
function asRefusal(error: unknown): Refusal {
  if (error instanceof Refusal) return error;
  if (error instanceof WorkerTokenError) return new Refusal(400, error.code, error.message);
  if (error instanceof LeaseLostError) return new Refusal(409, "lease_lost", error.message);
  if (error instanceof ResearchConflictError) return new Refusal(409, "research_conflict", error.message, { entity: error.entity, identity: error.identity, differing: error.differing });
  const sqlstate = typeof (error as { code?: unknown })?.code === "string" && typeof (error as { severity?: unknown }).severity === "string" ? (error as { code: string }).code : null;
  if (sqlstate) {
    if (TRANSIENT_SQLSTATE.test(sqlstate)) return new Refusal(503, "database_unavailable", "the database is temporarily unavailable");
    // trigger refusals (P0001) and constraint violations (23xxx) say what was refused; other driver messages are not passed on
    const message = /^(P0001|23)/.test(sqlstate) ? String((error as Error).message).slice(0, 300) : "the database refused the request";
    return new Refusal(422, "database_rejected", message, { sqlstate });
  }
  if (error instanceof Error && error.constructor === Error) return new Refusal(422, "rejected", error.message.slice(0, 500));
  if (error instanceof Error && /connection terminated|timeout exceeded when trying to connect|connection error/i.test(error.message)) return new Refusal(503, "database_unavailable", "the database is temporarily unavailable");
  return new Refusal(500, "internal_error", "internal error");
}

export function registerWorkerApi(app: FastifyInstance, pool: Pool | undefined, options: WorkerApiOptions = {}): void {
  const limiter = options.limiter ?? new AuthFailureLimiter();
  const bucket = new TokenBucket(options.rateLimit?.perSecond ?? 200, options.rateLimit?.burst ?? 400);
  const leaseSeconds = options.leaseSeconds ?? 90; const maxAttempts = options.maxAttempts ?? 3;
  const authOf = new WeakMap<FastifyRequest, Auth>();
  const peer = (r: FastifyRequest) => `peer:${r.socket.remoteAddress ?? "unknown"}`;
  const ownerOf = (tokenId: string) => `worker-api:${tokenId}`;

  async function audit(e: AuditEntry): Promise<void> {
    if (!pool) return;
    const tokenId = e.auth?.tokenId ?? null;
    await pool.query(
      `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, payload) VALUES ($1, $2, 'workflow_run', $3, $4, $5::jsonb)`,
      [tokenId ? `worker-token:${tokenId}` : "worker-api:unauthenticated", `worker_api.${e.outcome}`, e.auth?.runId ?? "unknown", e.auth?.correlationId ?? null,
        JSON.stringify({ token_id: tokenId, ...(e.presentedTokenId ? { presented_token_id: e.presentedTokenId } : {}), operation: e.operation, run_id: e.auth?.runId ?? null, step_id: e.stepId, outcome: e.outcome, code: e.code, http_status: e.status })],
    ).catch((error: unknown) => app.log.error({ err: error }, "worker api audit write failed"));
  }
  async function refuse(reply: FastifyReply, r: Refusal, e: Omit<AuditEntry, "outcome" | "code" | "status">): Promise<FastifyReply> {
    await audit({ ...e, outcome: "refused", code: r.code, status: r.status });
    if (r.status === 429 && r.extra["retry_after_seconds"]) reply.header("retry-after", String(r.extra["retry_after_seconds"]));
    return reply.code(r.status).send({ ok: false, error: r.code, message: redactWorkerTokens(r.message), ...r.extra });
  }
  const opName = (r: FastifyRequest) => rawPath(r.url).slice(WORKER_API_PREFIX.length);
  const bodyStep = (r: FastifyRequest): string | null => { const s = (r.body as { step_id?: unknown } | undefined)?.step_id; return typeof s === "string" && uuid.safeParse(s).success ? s : null; };

  /** Route-level onRequest: before the body is read. Default deny. */
  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const operation = opName(request);
    if (options.privateListenerPort !== undefined && request.socket.localPort !== options.privateListenerPort) {
      // not on the private listener: indistinguishable from a missing route (counted against the client like a failed token)
      if (limiter.retryAfterSeconds(peer(request)) === 0) { limiter.recordFailure(peer(request)); await audit({ auth: null, operation, stepId: null, outcome: "refused", code: "not_private_listener", status: 404 }); }
      return reply.code(404).send({ message: "Route not found", error: "Not Found", statusCode: 404 });
    }
    if (!pool) return reply.code(503).send({ ok: false, error: "database_not_configured" });
    const wait = limiter.retryAfterSeconds(peer(request));
    if (wait > 0) return reply.code(429).header("retry-after", String(wait)).send({ ok: false, error: "too_many_attempts", retry_after_seconds: wait }); // throttled: not individually audited
    const header = request.headers.authorization;
    const parsed = parseWorkerToken(typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined);
    if (!parsed) { limiter.recordFailure(peer(request)); return refuse(reply, new Refusal(401, "token_invalid", "a valid worker capability token is required"), { auth: null, operation, stepId: null }); }
    let row: { id: string; workflow_run_id: string; secret_sha256: string; expired: boolean; revoked: boolean; status: string; workflow_type: string; correlation_id: string | null } | undefined;
    try {
      row = (await pool.query(
        `SELECT t.id, t.workflow_run_id, t.secret_sha256, t.expires_at <= now() AS expired, t.revoked_at IS NOT NULL AS revoked, r.status, r.workflow_type, r.correlation_id
         FROM worker_capability_tokens t JOIN workflow_runs r ON r.id = t.workflow_run_id WHERE t.id = $1`, [parsed.tokenId])).rows[0];
    } catch (error) { return refuse(reply, asRefusal(error), { auth: null, operation, stepId: null }); }
    if (!row || !secretMatches(parsed.secret, row.secret_sha256)) {
      limiter.recordFailure(peer(request));
      return refuse(reply, new Refusal(401, "token_invalid", "a valid worker capability token is required"), { auth: null, operation, stepId: null, ...(row ? { presentedTokenId: row.id } : {}) });
    }
    const auth: Auth = { tokenId: row.id, runId: row.workflow_run_id, runStatus: row.status, correlationId: row.correlation_id };
    if (row.revoked) return refuse(reply, new Refusal(401, "token_revoked", "this worker token has been revoked"), { auth, operation, stepId: null });
    if (row.expired) return refuse(reply, new Refusal(401, "token_expired", "this worker token has expired"), { auth, operation, stepId: null });
    if (row.workflow_type !== REPOSITORY_RESEARCH_WORKFLOW) return refuse(reply, new Refusal(403, "run_not_eligible", "the token's run is not a repository_research run"), { auth, operation, stepId: null });
    const slow = bucket.take(row.id);
    if (slow > 0) return refuse(reply, new Refusal(429, "rate_limited", "too many requests for this token", { retry_after_seconds: slow }), { auth, operation, stepId: null });
    authOf.set(request, auth);
    void pool.query("UPDATE worker_capability_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => undefined);
    return undefined;
  }

  async function stepFor(db: Pick<Pool, "query">, auth: Auth, op: Operation, stepIdValue: string, forUpdate: boolean): Promise<StepRow> {
    const row = (await db.query<StepRow>(
      `SELECT id, step_key, input, status, lease_owner, lease_expires_at > now() AS unexpired FROM workflow_steps WHERE id = $1 AND workflow_run_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [stepIdValue, auth.runId])).rows[0];
    if (!row) throw new Refusal(403, "step_not_in_run", "the step is not part of this token's run");
    if (row.status !== "running" || row.lease_owner !== ownerOf(auth.tokenId) || (op.lease === "held" && !row.unexpired)) throw new Refusal(409, "lease_not_held", "this worker does not hold the step's lease");
    if (op.stepKeys !== "any" && !op.stepKeys.includes(row.step_key)) throw new Refusal(403, "operation_not_allowed_for_step", `${row.step_key} steps may not use this operation`);
    if (row.step_key === S && !isResearchSlitherStep(row)) throw new Refusal(403, "operation_not_allowed_for_step", "only the research-run Slither stage is served");
    return row;
  }

  const contextFor = (db: Pool, auth: Auth, step: StepRow | null): Ctx => {
    const store = new ResearchStore(db);
    return { db, tokenId: auth.tokenId, runId: auth.runId, owner: ownerOf(auth.tokenId), step, worker: new WorkflowWorker(db, ownerOf(auth.tokenId), leaseSeconds, maxAttempts), store, reads: dbResearchReads(db, store) };
  };
  const requestHash = (operation: string, body: unknown) => createHash("sha256").update(`${operation}\n${JSON.stringify(body)}`).digest("hex");

  for (const [operation, op] of Object.entries(OPERATIONS)) {
    // body-parser failures (malformed JSON, oversized, wrong content type) happen after authentication and before the handler: refused and audited here
    const errorHandler = async (error: Error & { statusCode?: number; code?: string }, request: FastifyRequest, reply: FastifyReply) => {
      const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      const code = status === 413 ? "body_too_large" : status === 415 ? "unsupported_content_type" : status < 500 ? "malformed_body" : "internal_error";
      if (status >= 500) app.log.error({ err: error }, "worker api request failed");
      return refuse(reply, new Refusal(status, code, status < 500 ? "the request body was refused" : "internal error"), { auth: authOf.get(request) ?? null, operation, stepId: null });
    };
    app.post(`${WORKER_API_PREFIX}${operation}`, { bodyLimit: op.bodyLimit, onRequest: authenticate, errorHandler }, async (request, reply) => {
      const auth = authOf.get(request)!; const db = pool!;
      const parsed = op.schema.safeParse(request.body);
      const stepIdValue = bodyStep(request);
      const base = { auth, operation, stepId: stepIdValue };
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return refuse(reply, new Refusal(400, "invalid_request", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`), base);
      }
      const args = parsed.data as Record<string, unknown>;
      let key: string | null = null; let hash = "";
      if (op.kind === "idempotent") {
        const raw = request.headers["idempotency-key"];
        if (typeof raw !== "string" || !uuid.safeParse(raw).success) return refuse(reply, new Refusal(400, "idempotency_key_required", "state-changing operations need an Idempotency-Key header (a UUID)"), base);
        key = raw.toLowerCase(); hash = requestHash(operation, args);
        const prior = (await db.query<{ operation: string; request_sha256: string; response: unknown }>("SELECT operation, request_sha256, response FROM worker_api_requests WHERE token_id = $1 AND idempotency_key = $2", [auth.tokenId, key])).rows[0];
        if (prior) {
          if (prior.operation !== operation || prior.request_sha256 !== hash) return refuse(reply, new Refusal(409, "idempotency_conflict", "this idempotency key was used for a different request"), base);
          await audit({ ...base, outcome: "replayed", code: "replayed", status: 200 });
          return reply.send({ ok: true, result: prior.response, replayed: true });
        }
      }
      if (!["queued", "running"].includes(auth.runStatus)) return refuse(reply, new Refusal(403, "run_terminal", "the token's run is finished; the token is no longer valid"), base);

      if (op.kind === "plain") {
        try {
          const step = op.lease === "none" ? null : await stepFor(db, auth, op, stepIdValue!, false);
          const result = await op.run(contextFor(db, auth, step), args);
          await audit({ ...base, outcome: "accepted", code: "ok", status: 200 });
          return reply.send({ ok: true, result: result ?? null });
        } catch (error) { return refuse(reply, asRefusal(error), base); }
      }
      let client: PoolClient | undefined;
      try {
        client = await db.connect();
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.tokenId}:${key}`]);
        const raced = (await client.query<{ response: unknown; request_sha256: string }>("SELECT response, request_sha256 FROM worker_api_requests WHERE token_id = $1 AND idempotency_key = $2", [auth.tokenId, key])).rows[0];
        if (raced) {
          await client.query("ROLLBACK");
          if (raced.request_sha256 !== hash) return refuse(reply, new Refusal(409, "idempotency_conflict", "this idempotency key was used for a different request"), base);
          await audit({ ...base, outcome: "replayed", code: "replayed", status: 200 });
          return reply.send({ ok: true, result: raced.response, replayed: true });
        }
        const tx = transactionalPool(client);
        const step = op.lease === "none" ? null : await stepFor(tx, auth, op, stepIdValue!, true);
        const result = (await op.run(contextFor(tx, auth, step), args)) ?? null;
        const recordStep = step?.id ?? (operation === "claim" && result ? (result as { id: string }).id : null);
        await client.query(`INSERT INTO worker_api_requests (token_id, idempotency_key, operation, step_id, request_sha256, response) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [auth.tokenId, key, operation, recordStep, hash, JSON.stringify(result)]);
        await client.query(
          `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, payload) VALUES ($1, 'worker_api.accepted', 'workflow_run', $2, $3, $4::jsonb)`,
          [`worker-token:${auth.tokenId}`, auth.runId, auth.correlationId, JSON.stringify({ token_id: auth.tokenId, operation, run_id: auth.runId, step_id: recordStep, outcome: "accepted", code: "ok", http_status: 200, idempotency_key: key })]);
        await client.query("COMMIT");
        return reply.send({ ok: true, result });
      } catch (error) {
        await client?.query("ROLLBACK").catch(() => undefined);
        return refuse(reply, asRefusal(error), base);
      } finally {
        client?.release();
      }
    });
  }

  // Operator actions (behind the existing operator bearer token, like every /v1 route): mint and revoke run-scoped worker tokens.
  app.post("/v1/research/runs/:id/worker-tokens", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: "database_not_configured" });
    const params = z.object({ id: uuid }).safeParse(request.params);
    const body = z.object({ ttl_seconds: z.number().int().optional(), created_by: z.string().min(1).max(200).optional() }).strict().safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      const minted = await mintWorkerToken(pool, { runId: params.data.id, createdBy: body.data.created_by ?? "operator", ...(body.data.ttl_seconds !== undefined ? { ttlSeconds: body.data.ttl_seconds } : {}) });
      return reply.header("cache-control", "no-store").code(201).send({ token: minted.token, token_id: minted.tokenId, run_id: minted.runId, expires_at: minted.expiresAt });
    } catch (error) {
      if (error instanceof WorkerTokenError) return reply.code(error.code === "run_not_found" ? 404 : 409).send({ error: error.code, message: error.message });
      throw error;
    }
  });
  app.post("/v1/research/worker-tokens/:id/revoke", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: "database_not_configured" });
    const params = z.object({ id: uuid }).safeParse(request.params);
    const body = z.object({ reason: z.string().max(500).optional(), revoked_by: z.string().min(1).max(200).optional() }).strict().safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const r = await revokeWorkerToken(pool, { tokenId: params.data.id, revokedBy: body.data.revoked_by ?? "operator", ...(body.data.reason ? { reason: body.data.reason } : {}) });
    return reply.code(r.revoked ? 200 : 404).send(r);
  });

  // Remote workers never reap; the API does, for every run, with the same rule the direct worker applies.
  const every = options.reaperIntervalMs ?? 60_000;
  if (pool && every > 0) {
    const reaper = new WorkflowWorker(pool, "worker-api-lease-reaper", leaseSeconds, maxAttempts);
    const timer = setInterval(() => { reaper.reapExhaustedLeases().catch((error: unknown) => app.log.error({ err: error }, "lease reaper failed")); }, every);
    timer.unref();
    app.addHook("onClose", async () => { clearInterval(timer); });
  }
}
