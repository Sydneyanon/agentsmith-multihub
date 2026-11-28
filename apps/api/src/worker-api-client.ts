import { randomUUID } from "node:crypto";
import type { Dossier } from "./analysis/solidity/pipeline.js";
import type { SlitherScanOutcome } from "./analysis/solidity/slither-record.js";
import { ResearchConflictError, type EvaluationOutcome, type GeneratorIdentity, type SnapshotFileInput, type SpanRole, type StepLease } from "./research-state.js";
import type { ResearchReads, ResearchStorePort, SealedSnapshotRef, WorkerLoopPort } from "./research-port.js";
import { LeaseLostError, StepError } from "./step-errors.js";
import type { ClaimedStep } from "./worker.js";
import { redactWorkerTokens } from "./worker-tokens.js";
import { internalApiFetch } from "./net/internal-fetch.js";

/**
 * Option D: the remote implementation of the research port. It holds no database credential, only the run-scoped worker token, and
 * talks to the API's internal routes (worker-api.ts).
 *
 * Failure semantics:
 * - API unreachable, timeout, 429 or 5xx: retried here with the SAME idempotency key (so a retry never writes twice), with backoff
 *   bounded well inside the 90 s lease; when the retries are exhausted the call throws a RETRYABLE StepError and the worker loop
 *   re-queues the step through the normal attempt ceiling. A step with such a failure can never complete (see `tainted`).
 * - Lease not held / lost: LeaseLostError, exactly as the direct store throws it.
 * - Token expired, revoked or unknown: WorkerTokenRejectedError; run finished: RunTerminalError. The runtime stops on either.
 * The token is sent only in the Authorization header; it never appears in a URL, an error or a log line.
 */
export class WorkerTokenRejectedError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorkerTokenRejectedError"; }
}
export class RunTerminalError extends Error {
  constructor(message: string) { super(message); this.name = "RunTerminalError"; }
}
/** The API refused the request outright (validation, scope, operation not allowed): permanent, like a store validation error. */
export class WorkerApiRefusedError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "WorkerApiRefusedError"; }
}

export type WorkerApiClientOptions = {
  baseUrl: string; token: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default 30 s (a dossier build or a large source read happens server-side). */
  timeoutMs?: number;
  /** Attempts per call for transient failures. Default 5. */
  attempts?: number;
  /** First backoff; doubles per attempt, capped at 8 s. Default 250 ms. */
  backoffMs?: number;
  /** Largest response accepted. Default 128 MiB. */
  maxResponseBytes?: number;
  sleep?: (ms: number) => Promise<void>;
};

type Envelope = { ok: boolean; result?: unknown; error?: string; message?: string; entity?: string; identity?: string; differing?: string[]; retry_after_seconds?: number };
const TOKEN_CODES = new Set(["token_invalid", "token_expired", "token_revoked", "run_not_eligible"]);

export class WorkerApiClient implements WorkerLoopPort, ResearchStorePort, ResearchReads {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  /** Steps for which a call failed for a transport reason after its retries: such a step must not be completed. */
  private readonly tainted = new Set<string>();
  readonly maxAttempts = 3;

  constructor(private readonly options: WorkerApiClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error("WORKER_API_URL must not carry credentials, a query or a fragment");
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, "")}/internal/worker/v1/`;
    this.fetchImpl = options.fetchImpl ?? internalApiFetch;
  }

  private async call<T>(operation: string, body: Record<string, unknown>, idempotent: boolean): Promise<T> {
    const key = idempotent ? randomUUID() : null;
    const attempts = this.options.attempts ?? 5; const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastProblem = "unknown";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.base + operation, {
          method: "POST", redirect: "error",
          headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
          body: JSON.stringify(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        lastProblem = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (attempt < attempts) await sleep(Math.min(8_000, (this.options.backoffMs ?? 250) * 2 ** (attempt - 1)));
        continue;
      }
      let envelope: Envelope | null = null;
      try { envelope = JSON.parse(await this.readBounded(response)) as Envelope; } catch { envelope = null; }
      const message = redactWorkerTokens(String(envelope?.message ?? envelope?.error ?? `HTTP ${response.status}`));
      if (response.ok && envelope?.ok) return envelope.result as T;
      if (response.status === 429 || response.status >= 500 || !envelope) {
        lastProblem = `HTTP ${response.status} ${envelope?.error ?? ""}`.trim();
        const hinted = Number(response.headers.get("retry-after") ?? 0) * 1000;
        if (attempt < attempts) await sleep(Math.min(8_000, Math.max(hinted, (this.options.backoffMs ?? 250) * 2 ** (attempt - 1))));
        continue;
      }
      const code = envelope.error ?? "unknown";
      if (response.status === 401 || TOKEN_CODES.has(code)) throw new WorkerTokenRejectedError(code, `worker API refused the token (${code})`);
      if (code === "run_terminal") throw new RunTerminalError(message);
      if (code === "lease_not_held" || code === "lease_lost") throw new LeaseLostError(`worker API: ${message}`);
      if (code === "research_conflict") throw new ResearchConflictError(envelope.entity ?? "record", envelope.identity ?? "", envelope.differing ?? [], message);
      throw new WorkerApiRefusedError(response.status, code, `worker API refused ${operation} (${code}): ${message}`);
    }
    if (typeof body["step_id"] === "string" && operation !== "heartbeat") this.tainted.add(body["step_id"]);
    throw new StepError(`worker API unavailable for ${operation} after ${attempts} attempts (${redactWorkerTokens(lastProblem)})`, true);
  }

  private async readBounded(response: Response): Promise<string> {
    const max = this.options.maxResponseBytes ?? 128 * 1024 * 1024;
    if (!response.body) return "";
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > max) { await reader.cancel(); throw new Error("worker API response exceeded the size limit"); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  // ---- lifecycle ----
  async claimNext(allowedStepKeys?: readonly string[]): Promise<ClaimedStep | null> {
    if (!allowedStepKeys || allowedStepKeys.length === 0) return null;
    const step = await this.call<ClaimedStep | null>("claim", { step_keys: [...allowedStepKeys] }, true);
    if (step) this.tainted.delete(step.id);
    return step;
  }
  async heartbeat(stepId: string): Promise<boolean> {
    try { return await this.call<boolean>("heartbeat", { step_id: stepId }, false); } catch (error) { if (error instanceof LeaseLostError) return false; throw error; }
  }
  async complete(stepId: string, output: Record<string, unknown> = {}): Promise<void> {
    if (this.tainted.has(stepId)) throw new StepError("an earlier worker API call for this step failed after its retries; the step is not completed and will be retried", true);
    await this.call("complete", { step_id: stepId, output }, true);
  }
  async fail(stepId: string, reason: string, retryable = true): Promise<void> {
    await this.call("fail", { step_id: stepId, reason: redactWorkerTokens(reason), retryable }, true);
  }

  // ---- research store (the lease's step is the only thing sent; the API derives the run and the lease owner from the token) ----
  putBlob(lease: StepLease, content: Buffer): Promise<{ sha256: string; sizeBytes: number }> {
    return this.call("put_blob", { step_id: lease.stepId, content_base64: content.toString("base64") }, true);
  }
  createSnapshot(lease: StepLease, input: { repository: string; commitSha: string; refName?: string; acquisitionReport?: Record<string, unknown> }): Promise<string> {
    return this.call("create_snapshot", { step_id: lease.stepId, repository: input.repository, commit_sha: input.commitSha, ...(input.refName !== undefined ? { ref_name: input.refName } : {}), ...(input.acquisitionReport ? { acquisition_report: input.acquisitionReport } : {}) }, true);
  }
  findSnapshot(lease: StepLease, repository: string, commitSha: string): ReturnType<ResearchStorePort["findSnapshot"]> {
    return this.call("find_snapshot", { step_id: lease.stepId, repository, commit_sha: commitSha }, false);
  }
  async addSnapshotFiles(lease: StepLease, snapshotId: string, files: readonly SnapshotFileInput[]): Promise<void> {
    await this.call("add_snapshot_files", { step_id: lease.stepId, snapshot_id: snapshotId, files: files.map((f) => ({
      path: f.path, classification: f.classification, size_bytes: f.sizeBytes,
      ...("blobSha256" in f ? { blob_sha256: f.blobSha256 } : { skip_reason: f.skipReason }), ...(f.gitBlobSha ? { git_blob_sha: f.gitBlobSha } : {}),
    })) }, true);
  }
  sealSnapshot(lease: StepLease, snapshotId: string): Promise<{ manifestSha256: string; fileCount: number; totalBytes: number }> {
    return this.call("seal_snapshot", { step_id: lease.stepId, snapshot_id: snapshotId }, true);
  }
  /** Lease-scoped on the API (the direct store's method takes no lease): the held step scopes it; the API serves it to acquisition only. */
  async verifySnapshot(snapshotId: string): Promise<Record<string, unknown>> {
    return this.call("verify_snapshot", { ...this.stepRef(), snapshot_id: snapshotId }, false);
  }
  createEvidenceSpan(lease: StepLease, input: { snapshotId: string; path: string; lineStart: number; lineEnd: number }): Promise<string> {
    return this.call("create_evidence_span", { step_id: lease.stepId, snapshot_id: input.snapshotId, path: input.path, line_start: input.lineStart, line_end: input.lineEnd }, true);
  }
  createHypothesis(lease: StepLease, input: {
    snapshotId: string; family: string; claim: string; rationale: string; requiredChecks?: string[]; alternativeExplanations?: string[];
    generator: GeneratorIdentity; spans: ReadonlyArray<{ spanId: string; role: SpanRole }>; supersedesId?: string;
  }): Promise<{ id: string; created: boolean }> {
    if (input.supersedesId !== undefined || input.generator.reservationId !== undefined) return Promise.reject(new Error("supersession and reserved generators are not available to a remote worker"));
    return this.call("create_hypothesis", {
      step_id: lease.stepId, snapshot_id: input.snapshotId, family: input.family, claim: input.claim, rationale: input.rationale,
      required_checks: input.requiredChecks ?? [], alternative_explanations: input.alternativeExplanations ?? [],
      generator: { kind: input.generator.kind, id: input.generator.id, version: input.generator.version }, spans: input.spans.map((s) => ({ span_id: s.spanId, role: s.role })),
    }, true);
  }
  recordEvaluation(lease: StepLease, input: { hypothesisId: string; evaluatorId: string; evaluatorVersion: string; outcome: EvaluationOutcome; rationale: string; spanIds: readonly string[]; inputSha256: string }): Promise<string> {
    return this.call("record_evaluation", { step_id: lease.stepId, hypothesis_id: input.hypothesisId, evaluator_id: input.evaluatorId, evaluator_version: input.evaluatorVersion,
      outcome: input.outcome, rationale: input.rationale, span_ids: [...input.spanIds], input_sha256: input.inputSha256 }, true);
  }

  // ---- reads (the port's reads take no lease; the runtime names the step it holds, which scopes them on the API) ----
  private heldStep: string | null = null;
  scopeToStep(stepId: string | null): void { this.heldStep = stepId; }
  private stepRef(): { step_id: string } {
    if (!this.heldStep) throw new Error("remote reads need a held step");
    return { step_id: this.heldStep };
  }
  sealedSnapshot(_runId: string): Promise<SealedSnapshotRef> { return this.call("sealed_snapshot", this.stepRef(), false); }
  snapshotSources(snapshotId: string): Promise<Array<{ path: string; text: string }>> { return this.call("snapshot_sources", { ...this.stepRef(), snapshot_id: snapshotId }, false); }
  async snapshotSolidityFiles(snapshotId: string): Promise<Array<{ path: string; content: Buffer }>> {
    const files = await this.call<Array<{ path: string; content_base64: string }>>("snapshot_solidity_files", { ...this.stepRef(), snapshot_id: snapshotId }, false);
    return files.map((f) => ({ path: f.path, content: Buffer.from(f.content_base64, "base64") }));
  }
  specialistHypothesisId(snapshotId: string, claim: string): Promise<string | null> { return this.call("specialist_hypothesis_id", { ...this.stepRef(), snapshot_id: snapshotId, claim }, false); }
  hypothesisSpanIds(hypothesisId: string): Promise<string[]> { return this.call("hypothesis_span_ids", { ...this.stepRef(), hypothesis_id: hypothesisId }, false); }
  slitherScanOfRun(_runId: string): Promise<{ exists: boolean; outcome: SlitherScanOutcome | null }> { return this.call("slither_scan_outcome", this.stepRef(), false); }
  slitherHypothesisIds(ids: readonly string[], snapshotId: string): Promise<string[]> { return this.call("slither_hypothesis_ids", { ...this.stepRef(), snapshot_id: snapshotId, ids: [...ids] }, false); }
  buildDossier(snapshotId: string): Promise<Dossier> { return this.call("build_dossier", { ...this.stepRef(), snapshot_id: snapshotId }, false); }
}
