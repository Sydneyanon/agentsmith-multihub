import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ACQUIRE_STEP_KEY, acquireStepInput, REPOSITORY_RESEARCH_WORKFLOW } from "./acquisition/step.js";
import type { RepositorySource } from "./acquisition/github-source.js";
import { manifestFingerprint, manifestRows, SnapshotVerificationError, verifySnapshotAgainstGitHub, type SnapshotVerification } from "./acquisition/snapshot-verify.js";
import { ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY, SLITHER_STEP_KEY } from "./analysis/solidity/keys.js";
import { buildDossier, recordChallenge, writeStructuralAnalysis, type buildStructuralMap, type ComputedStructure, type PlannedEvaluation } from "./analysis/solidity/pipeline.js";
import { isResearchSlitherStep } from "./analysis/solidity/slither-record.js";
import { analyzeStepOutput, challengeInputs, challengeStepOutput, dbResearchReads, dossierStepOutput, passive, type ChallengeInputs } from "./analysis/solidity/step.js";
import { BoundedCompute, ComputeBusyError, ComputeLimitError, type ComputeLimits } from "./analysis/solidity/bounded-compute.js";
import { AuthFailureLimiter, rawPath } from "./auth.js";
import { IndependenceError, MAX_BLOB_BYTES, ResearchConflictError, ResearchStore, sha256Hex, type SnapshotFileInput } from "./research-state.js";
import type { ResearchReads, SealedSnapshotRef } from "./research-port.js";
import { LeaseLostError } from "./step-errors.js";
import { doneWithinTotal, recordStepProgress, stepProgressFields, type StepProgress } from "./step-progress.js";
import { WorkflowWorker } from "./worker.js";
import { assertProcessingBudget, chargeProcessing, chargeRead, DEFAULT_QUOTAS, QuotaExceeded, reserveStorage, type WorkerQuotas } from "./worker-quotas.js";
import { mintWorkerToken, parseWorkerToken, redactWorkerTokens, revokeWorkerToken, secretMatches, WorkerTokenError } from "./worker-tokens.js";

/**
 * Option D: the internal worker API. A `repository_research` worker that holds NO database credential performs every read and write
 * its run needs through these routes; the API executes them on its own (owner) connection under the same lease rules. There is no
 * generic query, no generic table write, and no update or delete of any research record: the operations below are the complete list.
 *
 * What the API TRUSTS the worker with, after the fixes D1-D7 (docs/security/worker-architecture-decision.md):
 * - D1: nothing about verdicts. The worker records no evaluation at all (`record_evaluation` is always refused). On `complete` of
 *   challenge_leads the API runs the execution validators itself, on the sealed snapshot, for the stored hypotheses by id, in a bounded
 *   child process, and records the evaluations with their provenance (validator identity, version and family from the API's registry,
 *   input hash, snapshot, raw output as a content-addressed blob).
 * - D2: nothing about content. Before sealing, the API resolves the pinned commit and fetches its tree from GitHub itself and checks every
 *   manifest row and every stored byte against it (acquisition/snapshot-verify.ts); the evidence is stored in snapshot_verifications.
 * - D3: nothing about analysis results or coverage. On `complete` of analyze_structure the API recomputes the structural analysis on the
 *   sealed snapshot itself (bounded) and stores only what it derived; every step's `complete` body must pass a strict per-step schema,
 *   and the stored output is built by the API (`derived_by: "api"`). The one exception is the optional Slither stage, which runs a tool on
 *   the worker: its output and leads are stored as WORKER-REPORTED observations and labelled so in the dossier.
 * - D4: per-token quotas (storage, blobs, reads, processing time; the request rate in memory). Blobs are scoped to the run.
 * - D5: no request holds a pool connection while it waits for another; pool timeouts are retryable 503s; the number of concurrent
 *   worker-API transactions is capped below the pool size, so operator routes keep connections.
 * - D7: idempotency records in the same transaction as each effect; evaluations idempotent on their key (0015).
 * Every accepted and refused call is written to audit_events with the token id (never the token).
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
  /** D2: the API's OWN authenticated, read-only GitHub source. Without it, no worker-uploaded snapshot can be sealed (refused, 503). */
  github?: RepositorySource;
  /** D1/D3: limits of the API's own analysis and validator runs. */
  compute?: Partial<ComputeLimits>;
  /** D4: per-token quotas. */
  quotas?: Partial<WorkerQuotas>;
  /**
   * D5: worker-API requests served at once, across all tokens. Each request uses at most ONE pool connection at a time, so with the
   * API's pool of 5 the default of 3 always leaves connections for operator routes. A request that cannot start within
   * `requestQueueMs` (default 5 s) is refused with a retryable 503.
   */
  maxConcurrentRequests?: number;
  requestQueueMs?: number;
};

type Kind = "plain" | "idempotent";
type LeaseRule = "none" | "held" | "owned";
type Services = { github: RepositorySource | null; compute: BoundedCompute; quotas: WorkerQuotas };
type Ctx = {
  db: Pick<Pool, "query">; tokenId: string; runId: string; owner: string; step: StepRow | null;
  worker: WorkflowWorker; store: ResearchStore; reads: ResearchReads; services: Services;
};
type StepRow = { id: string; step_key: string; input: Record<string, unknown>; status: string; lease_owner: string | null; unexpired: boolean };
type Operation = {
  kind: Kind; lease: LeaseRule; stepKeys: readonly string[] | "any"; bodyLimit: number; schema: z.ZodTypeAny;
  /** Expensive work done BEFORE the request transaction, holding no pool connection (GitHub verification, bounded analysis). */
  prepare?(ctx: Ctx, args: any): Promise<unknown>;
  run(ctx: Ctx, args: any, prepared: any): Promise<unknown>;
};

export class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); this.name = "Refusal"; }
}

const uuid = z.string().uuid();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const stepId = { step_id: uuid };
const KiB = 1024, MiB = 1024 * 1024;
const shortText = z.string().min(1).max(1000);
const fileRow = z.union([
  z.object({ path: z.string().min(1).max(1024), classification: z.string().min(1).max(32), size_bytes: z.number().int().min(0), blob_sha256: hex64, git_blob_sha: sha40.optional() }).strict(),
  z.object({ path: z.string().min(1).max(1024), classification: z.string().min(1).max(32), size_bytes: z.number().int().min(0), skip_reason: z.string().min(1).max(64), git_blob_sha: sha40.optional() }).strict(),
]);
const count = z.number().int().min(0).max(1e9);
const passiveFields = { execution_mode: z.literal("passive_only"), authorization_status: z.literal("unverified"), active_testing_allowed: z.literal(false) };

/**
 * D3: the ONLY bodies a worker may submit to `complete`, per step key. Every other field (an `authorization_status` other than
 * "unverified", coverage numbers, problems, hypothesis lists, ...) is refused. The stored output is then derived by the API.
 */
const leadRef = z.object({ hypothesisId: uuid, class: z.string().min(1).max(100), contract: z.string().max(200), function: z.string().max(200), file: z.string().min(1).max(1024), line: z.number().int().min(0) }).strict();
const slitherBase = {
  producer: z.literal("slither"), pinned_version: z.string().min(1).max(40), snapshot_id: uuid, repository: z.string().min(3).max(201), commit_sha: sha40, manifest_sha256: hex64,
  limits: z.record(z.union([z.number(), z.array(z.string().max(100)).max(20)])), wall_ms: count, ...passiveFields,
};
export const COMPLETE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  [A]: z.object({ status: z.literal("snapshot_sealed"), snapshot_id: uuid, repository: z.string().min(3).max(201), commit_sha: sha40, tree_sha: sha40, manifest_sha256: hex64, file_count: count,
    stored_files: count, stored_bytes: count, skipped_by_reason: z.record(count), completeness: z.enum(["complete", "partial"]), reused: z.enum(["new", "resumed", "sealed"]), ...passiveFields }).strict(),
  [Z]: z.object({ status: z.literal("structure_analyzed"), snapshot_id: uuid }).strict(),
  [S]: z.union([
    z.object({ status: z.literal("abstained"), abstention: z.object({ code: z.string().min(1).max(40), detail: z.string().max(2000) }).strict(), generator: z.null(), hypothesis_ids: z.array(uuid).max(0), leads: z.array(leadRef).max(0), leads_by_class: z.object({}).strict(), ...slitherBase }).strict(),
    z.object({ status: z.literal("tool_completed"), generator: z.string().regex(/^slither@[0-9A-Za-z.+-]{1,40}$/),
      tool: z.object({ name: z.literal("slither"), version: z.string().max(40), solc_version: z.string().max(80), args: z.array(z.string().max(300)).max(20), input_manifest_sha256: hex64, raw_output_sha256: hex64, raw_output_blob: hex64.nullable(), exit_codes: z.array(z.number().int().nullable()).max(10), duration_ms: count }).strict(),
      hypothesis_ids: z.array(uuid).max(5000), leads: z.array(leadRef).max(5000), leads_by_class: z.record(count), detections_total: count, informational_detections: count, unmapped_detectors: z.record(count),
      outside_snapshot_contracts: count, unanchored: count, leads_not_recorded: count, ...slitherBase }).strict(),
  ]),
  [C]: z.object({ status: z.literal("leads_challenged"), snapshot_id: uuid }).strict(),
  [D]: z.object({ status: z.literal("dossier_built"), snapshot_id: uuid }).strict(),
};

async function snapshotInRun(ctx: Pick<Ctx, "db" | "runId">, snapshotId: string): Promise<void> {
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

/** The run's sealed snapshot, which the worker's `complete` body must name. */
async function sealedOfRun(ctx: Ctx, named: string): Promise<SealedSnapshotRef> {
  let snap: SealedSnapshotRef;
  try { snap = await ctx.reads.sealedSnapshot(ctx.runId); } catch (error) { throw new Refusal(422, "output_rejected", error instanceof Error ? error.message : "no sealed snapshot"); }
  if (snap.snapshotId !== named) throw new Refusal(403, "cross_run_reference", "the output names a snapshot other than this run's sealed snapshot");
  return snap;
}

/** D1/D3: bounded API-side computation; processing time is charged to the token whether it succeeds, fails or hits a limit. */
async function bounded<T>(ctx: Ctx, task: "analyze" | "challenge", payload: Record<string, unknown>): Promise<T> {
  await assertProcessingBudget(ctx.db, ctx.tokenId, ctx.services.quotas);
  const started = Date.now();
  try {
    const r = await ctx.services.compute.run<T>(task, payload);
    await chargeProcessing(ctx.db, ctx.tokenId, r.wallMs);
    return r.result;
  } catch (error) {
    if (!(error instanceof ComputeBusyError)) await chargeProcessing(ctx.db, ctx.tokenId, Date.now() - started);
    throw error;
  }
}

type Prepared = { kind: "analyze"; snap: SealedSnapshotRef; structure: ComputedStructure; map: ReturnType<typeof buildStructuralMap> }
  | { kind: "challenge"; snap: SealedSnapshotRef; inputs: ChallengeInputs; planned: PlannedEvaluation[] }
  | { kind: "seal"; verification: SnapshotVerification | null };

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
  /**
   * Intra-step progress, REPORTED BY THE WORKER (the dashboard labels it so; it is never a verified count). Valid only for the token's
   * leased step; strict schema; counted against the token's storage quota (D4) before it is written; throttled and capped per step by
   * the writer (step-progress.ts), so a flood stores nothing more. Not idempotent: a retried report is at worst one more observation.
   */
  report_progress: {
    kind: "plain", lease: "held", stepKeys: "any", bodyLimit: 1 * KiB,
    schema: z.object({ ...stepId, ...stepProgressFields }).strict().refine(doneWithinTotal, { message: "done must not exceed total" }),
    async run(ctx, a: { phase: string; done: number; total: number | null; unit: StepProgress["unit"] }) {
      const progress: StepProgress = { phase: a.phase, done: a.done, total: a.total, unit: a.unit };
      await reserveStorage(ctx.db, ctx.tokenId, Buffer.byteLength(JSON.stringify(progress)), ctx.services.quotas, 0); // D4: quota-counted
      return recordStepProgress(ctx.db, { stepId: ctx.step!.id, owner: ctx.owner, actor: `worker-token:${ctx.tokenId}`, via: "worker_api", tokenId: ctx.tokenId, progress });
    },
  },
  complete: {
    kind: "idempotent", lease: "held", stepKeys: "any", bodyLimit: 2 * MiB,
    schema: z.object({ ...stepId, output: z.record(z.unknown()) }).strict(),
    async prepare(ctx, args: { output: Record<string, unknown> }): Promise<Prepared | null> {
      const key = ctx.step!.step_key; const out = strictOutput(key, args.output);
      if (key === Z) {
        const snap = await sealedOfRun(ctx, String(out["snapshot_id"]));
        const sources = await ctx.reads.snapshotSources(snap.snapshotId);
        const r = await bounded<{ structure: ComputedStructure; map: ReturnType<typeof buildStructuralMap> }>(ctx, "analyze", { sources });
        return { kind: "analyze", snap, structure: r.structure, map: r.map };
      }
      if (key === C) {
        const snap = await sealedOfRun(ctx, String(out["snapshot_id"]));
        let inputs: ChallengeInputs;
        try { inputs = await challengeInputs(ctx.reads, ctx.runId, snap.snapshotId); } catch (error) { throw new Refusal(422, "output_rejected", error instanceof Error ? error.message.slice(0, 400) : "challenge inputs"); }
        const sources = await ctx.reads.snapshotSources(snap.snapshotId);
        const r = await bounded<{ planned: PlannedEvaluation[] }>(ctx, "challenge", { sources, stored: [...inputs.stored, ...inputs.external] });
        return { kind: "challenge", snap, inputs, planned: r.planned };
      }
      return null;
    },
    async run(ctx, args: { output: Record<string, unknown> }, prepared: Prepared | null) {
      const key = ctx.step!.step_key; const out = strictOutput(key, args.output);
      let stored: Record<string, unknown>;
      if (key === A) stored = await acquisitionOutput(ctx, out);
      else if (key === Z && prepared?.kind === "analyze") {
        const a = await writeStructuralAnalysis(ctx.store, lease(ctx), prepared.snap.snapshotId, prepared.structure);
        stored = { ...analyzeStepOutput(prepared.snap, a, prepared.map), derived_by: "api" };
      } else if (key === C && prepared?.kind === "challenge") {
        const validations = await recordChallenge(ctx.store, lease(ctx), prepared.snap.snapshotId, prepared.planned, "api");
        stored = { ...challengeStepOutput(prepared.snap, prepared.inputs, validations), derived_by: "api", evaluations_recorded: prepared.planned.length };
      } else if (key === D) {
        const snap = await sealedOfRun(ctx, String(out["snapshot_id"]));
        const d = await buildDossier(ctx.db as Pool, ctx.store, snap.snapshotId);
        stored = { ...dossierStepOutput(snap, d), derived_by: "api" };
      } else if (key === S) stored = await slitherOutput(ctx, out);
      else throw new Refusal(422, "output_rejected", "this step has no API-side completion");
      await ctx.worker.complete(ctx.step!.id, stored); return null;
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
    schema: z.object({ ...stepId, repository: z.string().min(3).max(201), commit_sha: sha40 }).strict(),
    run: (ctx, a: { repository: string; commit_sha: string }) => ctx.store.findSnapshot(lease(ctx), a.repository, a.commit_sha),
  },
  create_snapshot: {
    kind: "idempotent", lease: "held", stepKeys: [A], bodyLimit: 2 * MiB,
    schema: z.object({ ...stepId, repository: z.string().min(3).max(201), commit_sha: sha40, ref_name: z.string().min(1).max(250).optional(), acquisition_report: z.record(z.unknown()).optional() }).strict(),
    run: (ctx, a: { repository: string; commit_sha: string; ref_name?: string; acquisition_report?: Record<string, unknown> }) => {
      // the snapshot must be of the repository and ref the operator queued (GitHub's canonical name may differ in case only)
      const input = ctx.step!.input as { repository?: unknown; ref?: unknown };
      if (typeof input.repository !== "string" || input.repository.toLowerCase() !== a.repository.toLowerCase() || (input.ref ?? null) !== (a.ref_name ?? null)) {
        throw new Refusal(403, "repository_mismatch", "the snapshot is not of the repository and ref this step was queued for");
      }
      return reserveStorage(ctx.db, ctx.tokenId, Buffer.byteLength(JSON.stringify(a.acquisition_report ?? {})), ctx.services.quotas, 0).then(() => ctx.store.createSnapshot(lease(ctx), { repository: a.repository, commitSha: a.commit_sha, ...(a.ref_name !== undefined ? { refName: a.ref_name } : {}), ...(a.acquisition_report ? { acquisitionReport: a.acquisition_report } : {}) }));
    },
  },
  put_blob: {
    kind: "idempotent", lease: "held", stepKeys: [A, S], bodyLimit: Math.ceil(MAX_BLOB_BYTES * 4 / 3) + 4 * KiB,
    schema: z.object({ ...stepId, content_base64: z.string().max(Math.ceil(MAX_BLOB_BYTES * 4 / 3) + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
    async run(ctx, a: { content_base64: string }) {
      const content = Buffer.from(a.content_base64, "base64");
      await reserveStorage(ctx.db, ctx.tokenId, content.length, ctx.services.quotas); // D4, in this transaction
      const r = await ctx.store.putBlob(lease(ctx), content);
      // D4: the run's upload index; a manifest row may cite only blobs its own run uploaded
      await ctx.db.query("INSERT INTO worker_blob_uploads (workflow_run_id, content_sha256, token_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [ctx.runId, r.sha256, ctx.tokenId]);
      return r;
    },
  },
  add_snapshot_files: {
    kind: "idempotent", lease: "held", stepKeys: [A], bodyLimit: 3 * MiB,
    schema: z.object({ ...stepId, snapshot_id: uuid, files: z.array(fileRow).min(1).max(500) }).strict(),
    async run(ctx, a: { snapshot_id: string; files: Array<Record<string, any>> }) {
      await snapshotInRun(ctx, a.snapshot_id);
      // D4: one answer whether a hash is unknown or stored by another run, so the API is no existence oracle and no cross-run read path
      const cited = [...new Set(a.files.filter((f) => "blob_sha256" in f).map((f) => String(f.blob_sha256)))];
      if (cited.length) {
        const mine = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM worker_blob_uploads WHERE workflow_run_id = $1 AND content_sha256 = ANY($2::text[])", [ctx.runId, cited])).rows[0]!.n;
        if (mine !== cited.length) throw new Refusal(422, "blob_not_uploaded", "a manifest row cites a blob that this run's worker has not uploaded");
      }
      const files: SnapshotFileInput[] = a.files.map((f) => ({ path: f.path, classification: f.classification, sizeBytes: f.size_bytes,
        ...("blob_sha256" in f ? { blobSha256: f.blob_sha256 } : { skipReason: f.skip_reason }), ...(f.git_blob_sha ? { gitBlobSha: f.git_blob_sha } : {}) }) as SnapshotFileInput);
      await ctx.store.addSnapshotFiles(lease(ctx), a.snapshot_id, files); return null;
    },
  },
  seal_snapshot: {
    kind: "idempotent", lease: "held", stepKeys: [A], bodyLimit: 4 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid }).strict(),
    async prepare(ctx, a: { snapshot_id: string }): Promise<Prepared> {
      await snapshotInRun(ctx, a.snapshot_id);
      const snap = (await ctx.db.query<{ commit_sha: string; sealed: boolean }>("SELECT commit_sha, sealed_at IS NOT NULL AS sealed FROM repo_snapshots WHERE id = $1", [a.snapshot_id])).rows[0]!;
      if (snap.sealed) return { kind: "seal", verification: null }; // a retry after a lost answer: run() returns the recorded seal
      if (!ctx.services.github) throw new Refusal(503, "github_verification_unavailable", "the API has no GitHub source configured, so it cannot verify the snapshot; refusing to seal");
      const input = acquireStepInput.parse(ctx.step!.input);
      await assertProcessingBudget(ctx.db, ctx.tokenId, ctx.services.quotas);
      const started = Date.now();
      try {
        const verification = await verifySnapshotAgainstGitHub(ctx.db, ctx.services.github, { id: a.snapshot_id, commitSha: snap.commit_sha }, input, AbortSignal.timeout(120_000));
        return { kind: "seal", verification };
      } finally { await chargeProcessing(ctx.db, ctx.tokenId, Date.now() - started); }
    },
    async run(ctx, a: { snapshot_id: string }, prepared: Prepared) {
      await snapshotInRun(ctx, a.snapshot_id);
      const snap = (await ctx.db.query<{ sealed: boolean; manifest_sha256: string | null; file_count: number | null; total_bytes: string | null }>(
        "SELECT sealed_at IS NOT NULL AS sealed, manifest_sha256, file_count, total_bytes FROM repo_snapshots WHERE id = $1 FOR UPDATE", [a.snapshot_id])).rows[0]!;
      const verified = (await ctx.db.query("SELECT 1 FROM snapshot_verifications WHERE snapshot_id = $1", [a.snapshot_id])).rowCount;
      if (snap.sealed) {
        if (!verified) throw new Refusal(409, "sealed_without_verification", "the snapshot was sealed without the API's GitHub verification");
        return { manifestSha256: snap.manifest_sha256, fileCount: snap.file_count, totalBytes: Number(snap.total_bytes) };
      }
      const v = prepared.kind === "seal" ? prepared.verification : null;
      if (!v) throw new Refusal(409, "verification_missing", "the snapshot was not verified; retry the seal");
      // the manifest the API verified is exactly the one it seals (nothing was added between the GitHub check and this transaction)
      if (manifestFingerprint(await manifestRows(ctx.db, a.snapshot_id)) !== v.manifestFingerprint) throw new Refusal(409, "manifest_changed", "the manifest changed during verification; retry the seal");
      for (const blob of [...v.fileBlobs, v.resultBlob]) await ctx.db.query("INSERT INTO research_blobs (content_sha256, size_bytes, content) VALUES ($1, $2, $3) ON CONFLICT (content_sha256) DO NOTHING", [sha256Hex(blob), blob.length, blob]);
      await ctx.db.query(`INSERT INTO snapshot_verifications (snapshot_id, workflow_run_id, verifier, requested_ref, resolved_commit, tree_sha, files_total, files_matched, skips_verified, skips_unverified, completeness, result_blob_sha256)
        VALUES ($1,$2,'api-github',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [a.snapshot_id, ctx.runId, v.requestedRef, v.resolvedCommit, v.treeSha, v.counts.total, v.counts.matched, v.counts.skipsVerified, v.counts.skipsUnverified, v.completeness, sha256Hex(v.resultBlob)]);
      return ctx.store.sealSnapshot(lease(ctx), a.snapshot_id);
    },
  },
  verify_snapshot: {
    kind: "plain", lease: "held", stepKeys: [A], bodyLimit: 4 * KiB, schema: z.object({ ...stepId, snapshot_id: uuid }).strict(),
    async run(ctx, a: { snapshot_id: string }) { await snapshotInRun(ctx, a.snapshot_id); return ctx.store.verifySnapshot(a.snapshot_id); },
  },

  // ---- analysis reads (the queries dbResearchReads runs; every answer is charged to the token's read quota) ----
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

  // ---- worker-reported observations (append-only): ONLY the optional Slither stage, whose tool runs on the worker ----
  create_evidence_span: {
    kind: "idempotent", lease: "held", stepKeys: [S], bodyLimit: 8 * KiB,
    schema: z.object({ ...stepId, snapshot_id: uuid, path: z.string().min(1).max(1024), line_start: z.number().int().min(1), line_end: z.number().int().min(1) }).strict(),
    async run(ctx, a: { snapshot_id: string; path: string; line_start: number; line_end: number }) {
      await snapshotInRun(ctx, a.snapshot_id);
      return ctx.store.createEvidenceSpan(lease(ctx), { snapshotId: a.snapshot_id, path: a.path, lineStart: a.line_start, lineEnd: a.line_end });
    },
  },
  create_hypothesis: {
    kind: "idempotent", lease: "held", stepKeys: [S], bodyLimit: 128 * KiB,
    schema: z.object({
      ...stepId, snapshot_id: uuid, family: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/), claim: z.string().min(10).max(2000), rationale: z.string().min(1).max(8000),
      required_checks: z.array(shortText).max(50), alternative_explanations: z.array(shortText).max(50),
      // a worker can only ever record the Slither stage's deterministic leads: never a model's, a human's or the specialists'
      generator: z.object({ kind: z.literal("deterministic_rule"), id: z.string().min(1).max(200), version: z.string().min(1).max(100) }).strict(),
      spans: z.array(z.object({ span_id: uuid, role: z.enum(["primary", "supporting", "context"]) }).strict()).min(1).max(50),
    }).strict(),
    async run(ctx, a: { snapshot_id: string; family: string; claim: string; rationale: string; required_checks: string[]; alternative_explanations: string[]; generator: { kind: "deterministic_rule"; id: string; version: string }; spans: Array<{ span_id: string; role: "primary" | "supporting" | "context" }> }) {
      if (a.generator.id !== "slither") throw new Refusal(403, "generator_not_allowed", `a ${ctx.step!.step_key} step may not record hypotheses as generator ${a.generator.id}`);
      await snapshotInRun(ctx, a.snapshot_id); await spansInRun(ctx, a.spans.map((s) => s.span_id));
      return ctx.store.createHypothesis(lease(ctx), { snapshotId: a.snapshot_id, family: a.family, claim: a.claim, rationale: a.rationale, requiredChecks: a.required_checks,
        alternativeExplanations: a.alternative_explanations, generator: a.generator, spans: a.spans.map((s) => ({ spanId: s.span_id, role: s.role })) });
    },
  },
  /**
   * D1: REFUSED, always. Evaluations are derived by the API (on `complete` of challenge_leads). A worker-submitted verdict is not
   * recorded anywhere, not even as a proposal: the request is audited as refused and nothing else happens. The route exists only so a
   * forged verdict gets an explicit, audited refusal instead of the operator hook's generic 401.
   */
  record_evaluation: {
    kind: "idempotent", lease: "held", stepKeys: [C], bodyLimit: 64 * KiB,
    schema: z.object({
      ...stepId, hypothesis_id: uuid, evaluator_id: z.string().min(1).max(200), evaluator_version: z.string().min(1).max(100),
      outcome: z.enum(["supports", "weakens", "contradicts", "inconclusive"]), rationale: z.string().min(1).max(8000), span_ids: z.array(uuid).max(50), input_sha256: hex64,
    }).strict(),
    async run() { throw new Refusal(403, "evaluations_are_api_derived", "a worker may not record evaluations: the API runs the validators itself and records only its own verdicts"); },
  },
};
export const WORKER_OPERATION_PATHS: ReadonlySet<string> = new Set(Object.keys(OPERATIONS).map((op) => `${WORKER_API_PREFIX}${op}`));
/** For the operator bearer hook: exactly these POST paths are authenticated by the worker token instead (and nothing else). */
export const isWorkerApiRequest = (method: string, rawUrl: string) => method === "POST" && WORKER_OPERATION_PATHS.has(rawPath(rawUrl));

function strictOutput(key: string, output: Record<string, unknown>): Record<string, unknown> {
  const schema = COMPLETE_SCHEMAS[key];
  if (!schema) throw new Refusal(422, "output_rejected", `${key} steps have no completion`);
  const r = schema.safeParse(output);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Refusal(422, "output_rejected", `a ${key} step completes only with its own result shape (${issue?.path.join(".") || "output"}: ${issue?.message ?? "invalid"})`);
  }
  return r.data as Record<string, unknown>;
}

/** D2/D3: the acquisition step's stored output, derived from the database and the API's own verification; the worker's values must agree. */
async function acquisitionOutput(ctx: Ctx, out: Record<string, unknown>): Promise<Record<string, unknown>> {
  const snapshotId = String(out["snapshot_id"]);
  const row = (await ctx.db.query<{ repository: string; commit_sha: string; manifest_sha256: string | null; file_count: number | null; total_bytes: string | null; sealed: boolean }>(
    "SELECT repository, commit_sha, manifest_sha256, file_count, total_bytes, sealed_at IS NOT NULL AS sealed FROM repo_snapshots WHERE id = $1 AND workflow_run_id = $2", [snapshotId, ctx.runId])).rows[0];
  if (!row) throw new Refusal(403, "cross_run_reference", "the output names a snapshot outside this token's run");
  if (!row.sealed) throw new Refusal(422, "output_rejected", "an acquisition completes only with a sealed snapshot");
  const v = (await ctx.db.query<{ resolved_commit: string; tree_sha: string; completeness: string; files_total: number; files_matched: number; skips_verified: number; skips_unverified: number; result_blob_sha256: string; verified_at: Date }>(
    "SELECT resolved_commit, tree_sha, completeness, files_total, files_matched, skips_verified, skips_unverified, result_blob_sha256, verified_at FROM snapshot_verifications WHERE snapshot_id = $1", [snapshotId])).rows[0];
  if (!v) throw new Refusal(422, "output_rejected", "the snapshot was not verified against GitHub by the API");
  const rows = await manifestRows(ctx.db, snapshotId);
  const skipped: Record<string, number> = {}; for (const r of rows) if (r.skip_reason) skipped[r.skip_reason] = (skipped[r.skip_reason] ?? 0) + 1;
  const derived = { status: "snapshot_sealed", snapshot_id: snapshotId, repository: row.repository, commit_sha: row.commit_sha, tree_sha: v.tree_sha, manifest_sha256: row.manifest_sha256!, file_count: row.file_count!,
    stored_files: rows.filter((r) => r.blob_sha256).length, stored_bytes: Number(row.total_bytes), skipped_by_reason: skipped, completeness: v.completeness };
  const differing = (["repository", "commit_sha", "tree_sha", "manifest_sha256", "file_count", "stored_files", "stored_bytes", "completeness"] as const).filter((k) => JSON.stringify(out[k]) !== JSON.stringify(derived[k]));
  if (JSON.stringify(Object.entries(out["skipped_by_reason"] as Record<string, number>).sort()) !== JSON.stringify(Object.entries(skipped).sort())) differing.push("skipped_by_reason" as never);
  if (differing.length) throw new Refusal(422, "output_rejected", `the worker's acquisition result disagrees with the API's records (${differing.join(", ")})`);
  return { ...derived, reused: out["reused"], derived_by: "api", ...passive,
    verification: { verifier: "api-github", resolved_commit: v.resolved_commit, tree_sha: v.tree_sha, files_total: v.files_total, files_matched: v.files_matched, skips_verified: v.skips_verified, skips_unverified: v.skips_unverified, result_blob_sha256: v.result_blob_sha256, verified_at: v.verified_at.toISOString() } };
}

/** The optional Slither stage: a WORKER-REPORTED observation (the tool runs on the worker). Its leads must be its own step's Slither hypotheses. */
async function slitherOutput(ctx: Ctx, out: Record<string, unknown>): Promise<Record<string, unknown>> {
  await sealedOfRun(ctx, String(out["snapshot_id"]));
  const ids = [...new Set([...(out["hypothesis_ids"] as string[]), ...(out["leads"] as Array<{ hypothesisId: string }>).map((l) => l.hypothesisId)])];
  if (ids.length) {
    const n = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM hypotheses WHERE id = ANY($1::uuid[]) AND workflow_run_id = $2 AND produced_by_step_id = $3 AND generator_id = 'slither'", [ids, ctx.runId, ctx.step!.id])).rows[0]!.n;
    if (n !== ids.length) throw new Refusal(422, "output_rejected", "the Slither output names hypotheses this step did not record");
  }
  return { ...out, ...passive, reported_by: "worker" };
}

type Auth = { tokenId: string; runId: string; runStatus: string; correlationId: string | null };
type AuditEntry = { auth: Partial<Auth> | null; operation: string; stepId: string | null; outcome: "accepted" | "refused" | "replayed"; code: string; status: number; presentedTokenId?: string };

const TRANSIENT_SQLSTATE = /^(08|57P0[123]|53300|40001|40P01)/;
const POOL_TRANSIENT = /timeout exceeded when trying to connect|connection terminated|connection error|Connection terminated|ECONNREFUSED|ECONNRESET|the database system is (starting|shutting) down/i;
/** Maps any failure to a refusal. ORDER MATTERS (D5): pool and connect timeouts are plain `Error`s, so they are recognised FIRST, as a retryable 503. */
export function asRefusal(error: unknown): Refusal {
  if (error instanceof Refusal) return error;
  if (error instanceof Error && !(typeof (error as { severity?: unknown }).severity === "string") && POOL_TRANSIENT.test(error.message)) return new Refusal(503, "database_unavailable", "the database is temporarily unavailable");
  if (error instanceof QuotaExceeded) return new Refusal(error.status, error.code, error.message);
  if (error instanceof ComputeBusyError) return new Refusal(503, "analysis_busy", error.message);
  if (error instanceof ComputeLimitError) return new Refusal(413, "processing_limit_exceeded", error.message, { limit: error.code });
  if (error instanceof SnapshotVerificationError) return error.retryable ? new Refusal(503, error.code, error.message) : new Refusal(422, "snapshot_verification_failed", error.message, { reason: error.code, problems: error.problems });
  if (error instanceof WorkerTokenError) return new Refusal(400, error.code, error.message);
  if (error instanceof LeaseLostError) return new Refusal(409, "lease_lost", error.message);
  if (error instanceof ResearchConflictError) return new Refusal(409, "research_conflict", error.message, { entity: error.entity, identity: error.identity, differing: error.differing });
  if (error instanceof IndependenceError) return new Refusal(422, "independence_violation", error.message);
  const sqlstate = typeof (error as { code?: unknown })?.code === "string" && typeof (error as { severity?: unknown }).severity === "string" ? (error as { code: string }).code : null;
  if (sqlstate) {
    if (TRANSIENT_SQLSTATE.test(sqlstate)) return new Refusal(503, "database_unavailable", "the database is temporarily unavailable");
    // trigger refusals (P0001) and constraint violations (23xxx) say what was refused; other driver messages are not passed on
    const message = /^(P0001|23)/.test(sqlstate) ? String((error as Error).message).slice(0, 300) : "the database refused the request";
    return new Refusal(422, "database_rejected", message, { sqlstate });
  }
  if (error instanceof z.ZodError) return new Refusal(422, "rejected", error.issues[0]?.message ?? "invalid");
  if (error instanceof Error && error.constructor === Error) return new Refusal(422, "rejected", error.message.slice(0, 500));
  return new Refusal(500, "internal_error", "internal error");
}

/** A counting semaphore with a bounded wait (D5). */
class Slots {
  private used = 0; private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number, private readonly waitMs: number) {}
  async take(): Promise<() => void> {
    if (this.used >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const go = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(() => { const i = this.queue.indexOf(go); if (i >= 0) this.queue.splice(i, 1); reject(new Refusal(503, "worker_api_busy", "the worker API is at its concurrency limit; retry later")); }, this.waitMs);
        this.queue.push(go);
      });
    }
    this.used += 1;
    let done = false;
    return () => { if (done) return; done = true; this.used -= 1; this.queue.shift()?.(); };
  }
}

export function registerWorkerApi(app: FastifyInstance, pool: Pool | undefined, options: WorkerApiOptions = {}): void {
  const limiter = options.limiter ?? new AuthFailureLimiter();
  const bucket = new TokenBucket(options.rateLimit?.perSecond ?? 200, options.rateLimit?.burst ?? 400);
  const leaseSeconds = options.leaseSeconds ?? 90; const maxAttempts = options.maxAttempts ?? 3;
  const services: Services = { github: options.github ?? null, compute: new BoundedCompute(options.compute ?? {}), quotas: { ...DEFAULT_QUOTAS, ...options.quotas } };
  const slots = new Slots(options.maxConcurrentRequests ?? 3, options.requestQueueMs ?? 5_000);
  const authOf = new WeakMap<FastifyRequest, Auth>();
  const slotOf = new WeakMap<FastifyRequest, () => void>();
  const releaseSlot = async (request: FastifyRequest) => { slotOf.get(request)?.(); slotOf.delete(request); };
  const peer = (r: FastifyRequest) => `peer:${r.socket.remoteAddress ?? "unknown"}`;
  const ownerOf = (tokenId: string) => `worker-api:${tokenId}`;

  const auditSql = `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, payload) VALUES ($1, $2, 'workflow_run', $3, $4, $5::jsonb)`;
  const auditParams = (e: AuditEntry) => {
    const tokenId = e.auth?.tokenId ?? null;
    return [tokenId ? `worker-token:${tokenId}` : "worker-api:unauthenticated", `worker_api.${e.outcome}`, e.auth?.runId ?? "unknown", e.auth?.correlationId ?? null,
      JSON.stringify({ token_id: tokenId, ...(e.presentedTokenId ? { presented_token_id: e.presentedTokenId } : {}), operation: e.operation, run_id: e.auth?.runId ?? null, step_id: e.stepId, outcome: e.outcome, code: e.code, http_status: e.status })];
  };
  /** Audit on the pool: only ever called while this request holds NO pool client (D5). */
  async function audit(e: AuditEntry): Promise<void> {
    if (!pool) return;
    await pool.query(auditSql, auditParams(e)).catch((error: unknown) => app.log.error({ err: error }, "worker api audit write failed"));
  }
  async function refuse(reply: FastifyReply, r: Refusal, e: Omit<AuditEntry, "outcome" | "code" | "status">): Promise<FastifyReply> {
    await audit({ ...e, outcome: "refused", code: r.code, status: r.status });
    if ((r.status === 429 || r.status === 503) && r.extra["retry_after_seconds"]) reply.header("retry-after", String(r.extra["retry_after_seconds"]));
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
    // D5: a bounded number of worker-API requests touch the database at once (released when the response is sent or the request aborts)
    try { slotOf.set(request, await slots.take()); } catch (error) {
      const r = asRefusal(error); return reply.code(r.status).header("retry-after", "1").send({ ok: false, error: r.code, message: r.message }); // not audited: auditing needs a connection
    }
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
    await pool.query("UPDATE worker_capability_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => undefined); // awaited: one connection per request at a time
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
    return { db, tokenId: auth.tokenId, runId: auth.runId, owner: ownerOf(auth.tokenId), step, worker: new WorkflowWorker(db, ownerOf(auth.tokenId), leaseSeconds, maxAttempts), store, reads: dbResearchReads(db, store), services };
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
    app.post(`${WORKER_API_PREFIX}${operation}`, { bodyLimit: op.bodyLimit, onRequest: authenticate, onResponse: releaseSlot, onRequestAbort: releaseSlot, errorHandler }, async (request, reply) => {
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
        let prior: { operation: string; request_sha256: string; response: unknown } | undefined;
        try { prior = (await db.query<{ operation: string; request_sha256: string; response: unknown }>("SELECT operation, request_sha256, response FROM worker_api_requests WHERE token_id = $1 AND idempotency_key = $2", [auth.tokenId, key])).rows[0]; }
        catch (error) { return refuse(reply, asRefusal(error), base); }
        if (prior) {
          if (prior.operation !== operation || prior.request_sha256 !== hash) return refuse(reply, new Refusal(409, "idempotency_conflict", "this idempotency key was used for a different request"), base);
          await audit({ ...base, outcome: "replayed", code: "replayed", status: 200 });
          return reply.send({ ok: true, result: prior.response, replayed: true });
        }
      }
      if (!["queued", "running"].includes(auth.runStatus)) return refuse(reply, new Refusal(403, "run_terminal", "the token's run is finished; the token is no longer valid", { run_status: auth.runStatus }), base);

      if (op.kind === "plain") {
        try {
          const step = op.lease === "none" ? null : await stepFor(db, auth, op, stepIdValue!, false);
          const result = (await op.run(contextFor(db, auth, step), args, null)) ?? null;
          const body = JSON.stringify({ ok: true, result });
          if (op.lease !== "none" && operation !== "heartbeat") await chargeRead(db, auth.tokenId, Buffer.byteLength(body), services.quotas); // D4: read volume
          await audit({ ...base, outcome: "accepted", code: "ok", status: 200 });
          return reply.header("content-type", "application/json; charset=utf-8").send(body);
        } catch (error) { return refuse(reply, asRefusal(error), base); }
      }

      // expensive preparation (GitHub verification, bounded analysis) with NO pool client held
      let prepared: unknown = null;
      if (op.prepare) {
        try {
          const step = await stepFor(db, auth, op, stepIdValue!, false);
          prepared = await op.prepare(contextFor(db, auth, step), args);
        } catch (error) { return refuse(reply, asRefusal(error), base); }
      }
      let client: PoolClient | undefined;
      const letGo = () => { client?.release(); client = undefined; };
      try {
        client = await db.connect();
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.tokenId}:${key}`]);
        const raced = (await client.query<{ response: unknown; request_sha256: string }>("SELECT response, request_sha256 FROM worker_api_requests WHERE token_id = $1 AND idempotency_key = $2", [auth.tokenId, key])).rows[0];
        if (raced) {
          await client.query("ROLLBACK");
          const same = raced.request_sha256 === hash;
          const entry: AuditEntry = same ? { ...base, outcome: "replayed", code: "replayed", status: 200 } : { ...base, outcome: "refused", code: "idempotency_conflict", status: 409 };
          // D5: the raced answer's audit goes on the SAME client, never on a second pool connection while this one is held
          await client.query(auditSql, auditParams(entry)).catch((error: unknown) => app.log.error({ err: error }, "worker api audit write failed"));
          letGo();
          if (!same) return reply.code(409).send({ ok: false, error: "idempotency_conflict", message: "this idempotency key was used for a different request" });
          return reply.send({ ok: true, result: raced.response, replayed: true });
        }
        const tx = transactionalPool(client);
        const step = op.lease === "none" ? null : await stepFor(tx, auth, op, stepIdValue!, true);
        const result = (await op.run(contextFor(tx, auth, step), args, prepared)) ?? null;
        const recordStep = step?.id ?? (operation === "claim" && result ? (result as { id: string }).id : null);
        await client.query(`INSERT INTO worker_api_requests (token_id, idempotency_key, operation, step_id, request_sha256, response) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [auth.tokenId, key, operation, recordStep, hash, JSON.stringify(result)]);
        await client.query(
          `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, payload) VALUES ($1, 'worker_api.accepted', 'workflow_run', $2, $3, $4::jsonb)`,
          [`worker-token:${auth.tokenId}`, auth.runId, auth.correlationId, JSON.stringify({ token_id: auth.tokenId, operation, run_id: auth.runId, step_id: recordStep, outcome: "accepted", code: "ok", http_status: 200, idempotency_key: key })]);
        await client.query("COMMIT");
        letGo();
        return reply.send({ ok: true, result });
      } catch (error) {
        await client?.query("ROLLBACK").catch(() => undefined);
        letGo(); // D5: release BEFORE the refusal's audit takes a pool connection
        return refuse(reply, asRefusal(error), base);
      } finally {
        letGo();
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
