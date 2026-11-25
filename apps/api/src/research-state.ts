import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { LeaseLostError } from "./step-errors.js";

/**
 * Data access for the research-state schema (migration 0007, docs/research-state.md).
 * Hashing and line semantics here must match the SQL definitions byte for byte;
 * the integration tests check that they do.
 */

export const MAX_BLOB_BYTES = 1_048_576;
export const MAX_SPAN_LINES = 400;

export const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** Split on LF only; ignore one final empty element when the text ends with a newline; empty text is one empty line. */
export function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Lines `start`..`end` (1-based, inclusive) joined with LF, or null if the range does not exist. */
export function extractSpan(text: string, start: number, end: number): string | null {
  const lines = splitLines(text);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) return null;
  return lines.slice(start - 1, end).join("\n");
}

export function decodeUtf8Strict(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export type ManifestEntry = { path: string; blobSha256: string | null; skipReason: string | null };

/** sha256 over "path TAB (blob hash | skipped:reason) LF" lines, ordered by the UTF-8 bytes of the path. */
export function manifestSha256(entries: readonly ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  const body = sorted.map((entry) => `${entry.path}\t${entry.blobSha256 ?? `skipped:${entry.skipReason}`}\n`).join("");
  return sha256Hex(Buffer.from(body, "utf8"));
}

export type GeneratorIdentity = {
  kind: "deterministic_rule" | "model" | "human";
  id: string;
  version: string;
  /** Required for a model generator: the AI budget gateway reservation that paid for the call. */
  reservationId?: string;
};

export function claimFingerprint(input: {
  snapshotId: string;
  family: string;
  claim: string;
  generator: Pick<GeneratorIdentity, "kind" | "id" | "version">;
  spans: ReadonlyArray<{ spanId: string; role: string }>;
}): string {
  // Identity: what is claimed, by whom, about which cited lines. Everything else (rationale, checks, alternatives,
  // evidence roles, supersession, reservation) is compared in full on a retry and a difference is rejected.
  const spanIds = input.spans.map((span) => span.spanId).sort();
  return sha256Hex(JSON.stringify({
    snapshotId: input.snapshotId, family: input.family, claim: input.claim,
    generator: { kind: input.generator.kind, id: input.generator.id, version: input.generator.version },
    spanIds,
  }));
}

/** A retry that repeats an identity but not its content. Retries must be identical; this is never resolved silently. */
export class ResearchConflictError extends Error {
  constructor(readonly entity: string, readonly identity: string, readonly differing: readonly string[], message?: string) {
    super(message ?? `${entity} ${identity} already exists with different ${differing.join(", ")}; an identical retry is allowed, a changed one is not`);
    this.name = "ResearchConflictError";
  }

  static duplicateInRequest(path: string): ResearchConflictError {
    return new ResearchConflictError("manifest row", path, ["content"], `manifest path ${path} is listed twice with different content in one request`);
  }
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export type ManifestRowFields = {
  blob_sha256: string | null; git_blob_sha: string | null; size_bytes: number | string; classification: string; skip_reason: string | null;
};

/** Names of the manifest-row fields that differ between the stored row and the requested one. */
export function diffManifestRow(existing: ManifestRowFields, requested: {
  blobSha256: string | null; gitBlobSha: string | null; sizeBytes: number; classification: string; skipReason: string | null;
}): string[] {
  const differing: string[] = [];
  if (existing.blob_sha256 !== requested.blobSha256) differing.push("blob");
  if (existing.git_blob_sha !== requested.gitBlobSha) differing.push("git blob id");
  if (Number(existing.size_bytes) !== requested.sizeBytes) differing.push("size");
  if (existing.classification !== requested.classification) differing.push("classification");
  if (existing.skip_reason !== requested.skipReason) differing.push("skip reason");
  return differing;
}

export type HypothesisRecordFields = {
  family: string; claim: string; rationale: string; required_checks: unknown; alternative_explanations: unknown;
  generator_kind: string; generator_id: string; generator_version: string; generator_reservation_id: string | null;
  supersedes_id: string | null; spans: ReadonlyArray<{ span_id: string; role: string }>;
};

/** Names of the immutable fields that differ between the stored hypothesis and the one a retry asks for. */
export function diffHypothesis(existing: HypothesisRecordFields, requested: {
  family: string; claim: string; rationale: string; requiredChecks: readonly string[]; alternativeExplanations: readonly string[];
  generator: GeneratorIdentity; supersedesId: string | null; spans: ReadonlyArray<{ spanId: string; role: string }>;
}): string[] {
  const differing: string[] = [];
  if (existing.family !== requested.family) differing.push("family");
  if (existing.claim !== requested.claim) differing.push("claim");
  if (existing.rationale !== requested.rationale) differing.push("rationale");
  if (!sameJson(existing.required_checks, requested.requiredChecks)) differing.push("required checks");
  if (!sameJson(existing.alternative_explanations, requested.alternativeExplanations)) differing.push("alternative explanations");
  if (existing.generator_kind !== requested.generator.kind || existing.generator_id !== requested.generator.id
      || existing.generator_version !== requested.generator.version) differing.push("generator");
  if ((existing.generator_reservation_id ?? null) !== (requested.generator.reservationId ?? null)) differing.push("generator reservation");
  if ((existing.supersedes_id ?? null) !== requested.supersedesId) differing.push("supersedes");
  const key = (spans: ReadonlyArray<{ span_id?: string; spanId?: string; role: string }>) =>
    spans.map((span) => `${span.span_id ?? span.spanId}:${span.role}`).sort().join(",");
  if (key(existing.spans) !== key(requested.spans)) differing.push("evidence");
  return differing;
}

/** A worker's claim on a running step. Research writes made for a step happen only while it holds the lease. */
export type StepLease = { stepId: string; workerId: string };

export type SpanRole = "primary" | "supporting" | "context";
export type EvaluationOutcome = "supports" | "weakens" | "contradicts" | "inconclusive";
export type ReviewMode = "blinded_independent_assessment" | "disclosed_adjudication";
export type ReviewVerdict = "supports" | "rejects" | "needs_more_evidence" | "inconclusive";

/** Exactly what the reviewer was shown. Stored as facts; reports state them and the reader judges. */
export type ReviewerSaw = {
  claim: boolean;
  evidence_spans: boolean;
  generator_rationale: boolean;
  generator_identity: boolean;
  prior_evaluations: boolean;
  prior_reviews: boolean;
};

export type SnapshotFileInput =
  | { path: string; classification: string; sizeBytes: number; blobSha256: string; gitBlobSha?: string }
  | { path: string; classification: string; sizeBytes: number; skipReason: string; gitBlobSha?: string };

export type ResolvedSpan =
  | { ok: true; spanId: string; path: string; lineStart: number; lineEnd: number; text: string }
  | { ok: false; spanId: string; reason: string };

export class ResearchStore {
  constructor(private readonly pool: Pool) {}

  private async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Same ownership rule as source-snapshot persistence: current owner, running, unexpired. Returns the run id. */
  private async assertLease(client: PoolClient, lease: StepLease): Promise<string> {
    const owned = await client.query<{ workflow_run_id: string }>(
      `SELECT workflow_run_id FROM workflow_steps
       WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND lease_expires_at > now()
       FOR UPDATE`,
      [lease.stepId, lease.workerId],
    );
    if (!owned.rowCount) throw new LeaseLostError("Step lease lost before research state was written");
    return owned.rows[0]!.workflow_run_id;
  }

  private leased<T>(lease: StepLease, fn: (client: PoolClient, runId: string) => Promise<T>): Promise<T> {
    return this.inTransaction(async (client) => fn(client, await this.assertLease(client, lease)));
  }

  /** Idempotent: identical bytes are stored once. */
  putBlob(lease: StepLease, content: Buffer): Promise<{ sha256: string; sizeBytes: number }> {
    if (content.length > MAX_BLOB_BYTES) throw new Error(`blob of ${content.length} bytes exceeds the ${MAX_BLOB_BYTES} byte limit`);
    const sha256 = sha256Hex(content);
    return this.leased(lease, async (client) => {
      await client.query(
        "INSERT INTO research_blobs (content_sha256, size_bytes, content) VALUES ($1, $2, $3) ON CONFLICT (content_sha256) DO NOTHING",
        [sha256, content.length, content],
      );
      return { sha256, sizeBytes: content.length };
    });
  }

  createSnapshot(lease: StepLease, input: {
    repository: string; commitSha: string; refName?: string; acquisitionReport?: Record<string, unknown>;
  }): Promise<string> {
    return this.leased(lease, async (client, runId) => {
      const report = JSON.stringify(input.acquisitionReport ?? {});
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO repo_snapshots (workflow_run_id, produced_by_step_id, source_host, repository, commit_sha, ref_name, acquisition_report)
         VALUES ($1, $2, 'github.com', $3, $4, $5, $6::jsonb)
         ON CONFLICT (workflow_run_id, repository, commit_sha) DO NOTHING RETURNING id`,
        [runId, lease.stepId, input.repository, input.commitSha, input.refName ?? null, report],
      );
      if (inserted.rows[0]) return inserted.rows[0].id;
      const existing = await client.query<{ id: string; ref_name: string | null; acquisition_report: unknown }>(
        "SELECT id, ref_name, acquisition_report FROM repo_snapshots WHERE workflow_run_id = $1 AND repository = $2 AND commit_sha = $3",
        [runId, input.repository, input.commitSha]);
      const row = existing.rows[0]!;
      const differing: string[] = [];
      if (row.ref_name !== (input.refName ?? null)) differing.push("ref name");
      if (!sameJson(row.acquisition_report, input.acquisitionReport ?? {})) differing.push("acquisition report");
      if (differing.length) throw new ResearchConflictError("snapshot", `${input.repository}@${input.commitSha}`, differing);
      return row.id;
    });
  }

  /**
   * Adds manifest rows to a building snapshot, in one transaction. A row that already exists must match the requested
   * row exactly (an identical retry is a no-op, even after sealing); a conflicting retry is rejected, never merged.
   */
  addSnapshotFiles(lease: StepLease, snapshotId: string, files: readonly SnapshotFileInput[]): Promise<void> {
    const seen = new Map<string, SnapshotFileInput>();
    for (const file of files) {
      const earlier = seen.get(file.path);
      if (earlier && JSON.stringify(earlier) !== JSON.stringify(file)) return Promise.reject(ResearchConflictError.duplicateInRequest(file.path));
      seen.set(file.path, file);
    }
    return this.leased(lease, async (client, runId) => {
      const existing = await client.query<ManifestRowFields & { path: string }>(
        `SELECT path, blob_sha256, git_blob_sha, size_bytes, classification, skip_reason
         FROM repo_snapshot_files WHERE snapshot_id = $1 AND path = ANY($2::text[])`,
        [snapshotId, [...seen.keys()]]);
      const byPath = new Map(existing.rows.map((row) => [row.path, row]));
      for (const file of seen.values()) {
        const requested = {
          blobSha256: "blobSha256" in file ? file.blobSha256 : null, gitBlobSha: file.gitBlobSha ?? null, sizeBytes: file.sizeBytes,
          classification: file.classification, skipReason: "skipReason" in file ? file.skipReason : null,
        };
        const stored = byPath.get(file.path);
        if (stored) {
          const differing = diffManifestRow(stored, requested);
          if (differing.length) throw new ResearchConflictError("manifest row", file.path, differing);
          continue;
        }
        await client.query(
          `INSERT INTO repo_snapshot_files (snapshot_id, workflow_run_id, produced_by_step_id, path, blob_sha256, git_blob_sha, size_bytes, classification, skip_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [snapshotId, runId, lease.stepId, file.path, requested.blobSha256, requested.gitBlobSha, requested.sizeBytes, requested.classification, requested.skipReason]);
      }
    });
  }

  /** The database seals and computes; the application recomputes the manifest hash and refuses any difference. */
  sealSnapshot(lease: StepLease, snapshotId: string): Promise<{ manifestSha256: string; fileCount: number; totalBytes: number }> {
    return this.leased(lease, async (client, runId) => {
      const rows = await client.query<{ path: string; blob_sha256: string | null; skip_reason: string | null }>(
        "SELECT path, blob_sha256, skip_reason FROM repo_snapshot_files WHERE snapshot_id = $1", [snapshotId]);
      const local = manifestSha256(rows.rows.map((row) => ({ path: row.path, blobSha256: row.blob_sha256, skipReason: row.skip_reason })));
      const sealed = await client.query<{ manifest_sha256: string; file_count: number; total_bytes: string }>(
        `UPDATE repo_snapshots SET sealed_at = now(), sealed_by_step_id = $2
         WHERE id = $1 AND workflow_run_id = $3 RETURNING manifest_sha256, file_count, total_bytes`, [snapshotId, lease.stepId, runId]);
      const row = sealed.rows[0];
      if (!row) throw new Error(`snapshot ${snapshotId} does not exist in this step's run`);
      if (row.manifest_sha256 !== local) throw new Error("manifest hash computed by the database differs from the application's");
      return { manifestSha256: row.manifest_sha256, fileCount: row.file_count, totalBytes: Number(row.total_bytes) };
    });
  }

  /** Cites lines of a stored file. The excerpt hash is computed here and re-verified by the database. */
  createEvidenceSpan(lease: StepLease, input: { snapshotId: string; path: string; lineStart: number; lineEnd: number }): Promise<string> {
    return this.leased(lease, async (client, runId) => {
      const file = await client.query<{ blob_sha256: string | null }>(
        "SELECT blob_sha256 FROM repo_snapshot_files WHERE snapshot_id = $1 AND path = $2", [input.snapshotId, input.path]);
      const blobSha = file.rows[0]?.blob_sha256;
      if (!blobSha) throw new Error(`${input.path} is not a stored file of snapshot ${input.snapshotId}`);
      const blob = await client.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [blobSha]);
      if (!blob.rows[0]) throw new Error(`blob for ${input.path} has been evicted`);
      const excerpt = extractSpan(decodeUtf8Strict(blob.rows[0].content), input.lineStart, input.lineEnd);
      if (excerpt === null) throw new Error(`lines ${input.lineStart}-${input.lineEnd} do not exist in ${input.path}`);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO evidence_spans (workflow_run_id, produced_by_step_id, snapshot_id, path, blob_sha256, line_start, line_end, excerpt_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (snapshot_id, path, line_start, line_end) DO NOTHING RETURNING id`,
        [runId, lease.stepId, input.snapshotId, input.path, blobSha, input.lineStart, input.lineEnd, sha256Hex(Buffer.from(excerpt, "utf8"))],
      );
      if (inserted.rows[0]) return inserted.rows[0].id;
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM evidence_spans WHERE snapshot_id = $1 AND path = $2 AND line_start = $3 AND line_end = $4",
        [input.snapshotId, input.path, input.lineStart, input.lineEnd]);
      return existing.rows[0]!.id;
    });
  }

  /**
   * One transaction: the hypothesis and its evidence links. The identity of a claim is its snapshot, family, claim text,
   * generator and cited spans. A retry of that identity must repeat the stored record exactly (rationale, checks,
   * alternatives, supersession, reservation and evidence): identical returns the existing hypothesis, anything else is
   * rejected with a ResearchConflictError. To change content, change the claim text or the generator version.
   */
  createHypothesis(lease: StepLease, input: {
    snapshotId: string; family: string; claim: string; rationale: string;
    requiredChecks?: string[]; alternativeExplanations?: string[];
    generator: GeneratorIdentity; spans: ReadonlyArray<{ spanId: string; role: SpanRole }>; supersedesId?: string;
  }): Promise<{ id: string; created: boolean }> {
    const fingerprint = claimFingerprint({
      snapshotId: input.snapshotId, family: input.family, claim: input.claim, generator: input.generator, spans: input.spans,
    });
    const requiredChecks = input.requiredChecks ?? [];
    const alternativeExplanations = input.alternativeExplanations ?? [];
    return this.leased(lease, async (client, runId) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO hypotheses (workflow_run_id, produced_by_step_id, snapshot_id, supersedes_id, family, claim, rationale,
           required_checks, alternative_explanations, generator_kind, generator_id, generator_version, generator_reservation_id, claim_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)
         ON CONFLICT (snapshot_id, claim_fingerprint) DO NOTHING RETURNING id`,
        [runId, lease.stepId, input.snapshotId, input.supersedesId ?? null, input.family, input.claim, input.rationale,
          JSON.stringify(requiredChecks), JSON.stringify(alternativeExplanations),
          input.generator.kind, input.generator.id, input.generator.version, input.generator.reservationId ?? null, fingerprint],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<Omit<HypothesisRecordFields, "spans"> & { id: string }>(
          `SELECT id, family, claim, rationale, required_checks, alternative_explanations, generator_kind, generator_id,
                  generator_version, generator_reservation_id, supersedes_id
           FROM hypotheses WHERE snapshot_id = $1 AND claim_fingerprint = $2`, [input.snapshotId, fingerprint]);
        const row = existing.rows[0]!;
        const spans = await client.query<{ span_id: string; role: string }>(
          "SELECT span_id, role FROM hypothesis_evidence WHERE hypothesis_id = $1", [row.id]);
        const differing = diffHypothesis({ ...row, spans: spans.rows }, {
          family: input.family, claim: input.claim, rationale: input.rationale, requiredChecks, alternativeExplanations,
          generator: input.generator, supersedesId: input.supersedesId ?? null, spans: input.spans,
        });
        if (differing.length) throw new ResearchConflictError("hypothesis", row.id, differing);
        return { id: row.id, created: false };
      }
      const id = inserted.rows[0].id;
      for (const span of input.spans) {
        await client.query(
          "INSERT INTO hypothesis_evidence (hypothesis_id, span_id, workflow_run_id, produced_by_step_id, role) VALUES ($1,$2,$3,$4,$5)",
          [id, span.spanId, runId, lease.stepId, span.role]);
      }
      return { id, created: true };
    });
  }

  /** A deterministic evaluator's outcome. Abstaining is `inconclusive`, which needs a rationale but no spans. */
  recordEvaluation(lease: StepLease, input: {
    hypothesisId: string; evaluatorId: string; evaluatorVersion: string; outcome: EvaluationOutcome;
    rationale: string; spanIds: readonly string[]; inputSha256: string;
  }): Promise<string> {
    return this.leased(lease, async (client, runId) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [runId, input.hypothesisId, lease.stepId, input.evaluatorId, input.evaluatorVersion, input.outcome, input.rationale, input.inputSha256]);
      const id = inserted.rows[0]!.id;
      for (const spanId of input.spanIds) {
        await client.query(
          "INSERT INTO evaluation_evidence (evaluation_id, span_id, workflow_run_id, produced_by_step_id) VALUES ($1,$2,$3,$4)", [id, spanId, runId, lease.stepId]);
      }
      return id;
    });
  }

  /**
   * A review by an operator (human only, attributed to the operator) or by a leased step (a model review,
   * which must carry its gateway reservation). The mode and what the reviewer saw are stored as facts.
   */
  async recordReview(
    actor: { kind: "operator"; operatorId: string } | { kind: "step"; lease: StepLease },
    input: {
      hypothesisId: string; reviewerKind: "model" | "human"; reviewerId: string; mode: ReviewMode; reviewerSaw: ReviewerSaw;
      inputSha256: string; verdict: ReviewVerdict; rationale: string;
      model?: { provider: string; name: string; promptVersion: string; reservationId: string };
    },
  ): Promise<string> {
    if (actor.kind === "operator" && (input.reviewerKind !== "human" || input.reviewerId !== actor.operatorId)) {
      throw new Error("an operator can only record a human review under their own identity");
    }
    const insert = async (client: PoolClient, runId: string, stepId: string | null): Promise<string> => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO hypothesis_reviews (workflow_run_id, hypothesis_id, produced_by_step_id, reviewer_kind, reviewer_id, review_mode, reviewer_saw,
           input_sha256, verdict, rationale, model_provider, model_name, model_prompt_version, model_reservation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [runId, input.hypothesisId, stepId, input.reviewerKind, input.reviewerId, input.mode, JSON.stringify(input.reviewerSaw), input.inputSha256,
          input.verdict, input.rationale, input.model?.provider ?? null, input.model?.name ?? null,
          input.model?.promptVersion ?? null, input.model?.reservationId ?? null]);
      return inserted.rows[0]!.id;
    };
    if (actor.kind === "step") return this.leased(actor.lease, (client, runId) => insert(client, runId, actor.lease.stepId));
    return this.inTransaction(async (client) => {
      const run = await client.query<{ workflow_run_id: string }>("SELECT workflow_run_id FROM hypotheses WHERE id = $1", [input.hypothesisId]);
      if (!run.rows[0]) throw new Error(`hypothesis ${input.hypothesisId} does not exist`);
      return insert(client, run.rows[0].workflow_run_id, null);
    });
  }

  /** Appends a withdrawal event in the hypothesis's own run. Human only; the hypothesis and its history are untouched. */
  async withdraw(operatorId: string, hypothesisId: string, reason: string): Promise<void> {
    const inserted = await this.pool.query(
      `INSERT INTO hypothesis_events (workflow_run_id, hypothesis_id, event_type, actor_kind, actor_id, reason)
       SELECT workflow_run_id, id, 'withdrawn', 'human', $2, $3 FROM hypotheses WHERE id = $1`,
      [hypothesisId, operatorId, reason]);
    if (inserted.rowCount === 0) throw new Error(`hypothesis ${hypothesisId} does not exist`);
  }

  async getStatus(hypothesisId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query("SELECT * FROM hypothesis_status WHERE hypothesis_id = $1", [hypothesisId]);
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  /** Database-side check: ok | evicted | not_text | range_error | mismatch | unknown_span. */
  async verifySpan(spanId: string): Promise<string> {
    return (await this.pool.query<{ verdict: string }>("SELECT verify_evidence_span($1) AS verdict", [spanId])).rows[0]!.verdict;
  }

  async verifySnapshot(snapshotId: string): Promise<Record<string, unknown>> {
    return (await this.pool.query<{ result: Record<string, unknown> }>("SELECT verify_repo_snapshot($1) AS result", [snapshotId])).rows[0]!.result;
  }

  /**
   * Re-reads the cited text from the stored bytes and checks it against the recorded hash, independently of the
   * database function. Anything but `ok: true` must stop a dossier from citing the span.
   */
  async resolveSpan(spanId: string): Promise<ResolvedSpan> {
    const span = await this.pool.query<{ path: string; blob_sha256: string; line_start: number; line_end: number; excerpt_sha256: string }>(
      "SELECT path, blob_sha256, line_start, line_end, excerpt_sha256 FROM evidence_spans WHERE id = $1", [spanId]);
    const row = span.rows[0];
    if (!row) return { ok: false, spanId, reason: "unknown_span" };
    const blob = await this.pool.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [row.blob_sha256]);
    if (!blob.rows[0]) return { ok: false, spanId, reason: "evicted" };
    if (sha256Hex(blob.rows[0].content) !== row.blob_sha256) return { ok: false, spanId, reason: "blob_hash_mismatch" };
    let text: string;
    try { text = decodeUtf8Strict(blob.rows[0].content); } catch { return { ok: false, spanId, reason: "not_text" }; }
    const excerpt = extractSpan(text, row.line_start, row.line_end);
    if (excerpt === null) return { ok: false, spanId, reason: "range_error" };
    if (sha256Hex(Buffer.from(excerpt, "utf8")) !== row.excerpt_sha256) return { ok: false, spanId, reason: "mismatch" };
    return { ok: true, spanId, path: row.path, lineStart: row.line_start, lineEnd: row.line_end, text: excerpt };
  }
}
