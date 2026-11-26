import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { buildDossier } from "./analysis/solidity/pipeline.js";
import { ResearchStore, decodeUtf8Strict, splitLines } from "./research-state.js";

/**
 * Read-only API for the private hub dashboard (docs/dashboard-api.md). Everything here is a bounded, parameterised
 * query over the research-state schema; no status, verdict or health is computed in the browser.
 */

export const HYPOTHESIS_STATUSES = [
  "unreviewed", "weakened_by_static_check", "contradicted_by_static_check", "supported_by_review", "rejected_by_review",
  "needs_more_evidence", "review_inconclusive", "reviews_disagree", "withdrawn",
] as const;

export const AUTOMATION_BASIS =
  "Research events carry an explicit actor_kind. Workflow audit events carry only an actor string: 'user' is classed human, anything else automated.";

const RUN_STATUSES = ["queued", "running", "awaiting_approval", "succeeded", "failed", "rejected", "cancelled"] as const;
const uuid = z.string().uuid();
const paging = (maxLimit = 100) => z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

type Row = Record<string, any>;

const invalidId = (reply: FastifyReply) => reply.code(400).send({ error: "invalid_id" });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" });
const invalidQuery = (reply: FastifyReply) => reply.code(400).send({ error: "invalid_query" });

function page<T>(rows: T[], limit: number, offset: number) {
  return { items: rows.slice(0, limit), limit, offset, has_more: rows.length > limit };
}

const countMap = (rows: Row[], key: string, value = "n"): Record<string, number> => Object.fromEntries(rows.map((row) => [row[key], Number(row[value])]));
const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

export function registerResearchRoutes(app: FastifyInstance, pool: Pool | undefined): void {
  const store = pool ? new ResearchStore(pool) : undefined;

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/v1/research/")) reply.header("cache-control", "no-store");
  });

  const guard = (reply: FastifyReply) => {
    if (pool && store) return { pool, store };
    reply.code(503).send({ error: "database_not_configured" });
    return null;
  };

  // ---------------------------------------------------------------- overview
  app.get("/v1/research/overview", async (_request, reply) => {
    const db = guard(reply); if (!db) return;
    const q = (sql: string) => db.pool.query<Row>(sql);
    const [runs, snaps, spans, evals, reviews, hyps, events, audit, pipe, steps, storage] = await Promise.all([
      q("SELECT status, count(*)::int AS n FROM workflow_runs GROUP BY status"),
      q("SELECT count(*) FILTER (WHERE sealed_at IS NOT NULL)::int AS sealed, count(*) FILTER (WHERE sealed_at IS NULL)::int AS building FROM repo_snapshots"),
      q("SELECT count(*)::int AS n FROM evidence_spans"),
      q("SELECT count(*)::int AS n FROM hypothesis_evaluations"),
      q("SELECT review_mode, count(*)::int AS n FROM hypothesis_reviews GROUP BY review_mode"),
      q("SELECT status, count(*)::int AS n FROM hypothesis_status GROUP BY status"),
      q("SELECT count(*)::int AS n FROM hypothesis_events WHERE created_at > now() - interval '24 hours'"),
      q("SELECT count(*)::int AS n FROM audit_events WHERE created_at > now() - interval '24 hours'"),
      q(`SELECT
           count(*) FILTER (WHERE s.status = 'queued' AND r.status IN ('queued','running'))::int AS queued,
           count(*) FILTER (WHERE s.status = 'running')::int AS running,
           count(*) FILTER (WHERE s.status = 'running' AND s.lease_expires_at < now())::int AS running_expired_lease,
           count(DISTINCT s.lease_owner) FILTER (WHERE s.status = 'running' AND s.lease_expires_at > now())::int AS live_lease_owners,
           count(*) FILTER (WHERE s.status = 'failed' AND s.completed_at > now() - interval '24 hours')::int AS failed_24h,
           count(*) FILTER (WHERE s.status = 'failed' AND s.completed_at > now() - interval '7 days')::int AS failed_7d,
           EXTRACT(EPOCH FROM now() - min(s.created_at) FILTER (WHERE s.status = 'queued' AND r.status IN ('queued','running')))::int AS oldest_queued_age_seconds,
           max(s.completed_at) FILTER (WHERE s.status = 'succeeded') AS last_success_at
         FROM workflow_steps s JOIN workflow_runs r ON r.id = s.workflow_run_id`),
      q("SELECT step_key, status, count(*)::int AS n FROM workflow_steps GROUP BY step_key, status"),
      q("SELECT * FROM research_storage_stats"),
    ]);
    const p = pipe.rows[0]!;
    const reasons: string[] = [];
    if (p.running_expired_lease > 0) reasons.push(`${p.running_expired_lease} running step(s) have an expired lease`);
    if (p.failed_24h > 0) reasons.push(`${p.failed_24h} step(s) failed in the last 24 hours`);
    const state = reasons.length ? "attention" : (p.running > 0 || p.queued > 0) ? "working" : "idle";
    const byStep: Record<string, Record<string, number>> = {};
    for (const row of steps.rows) (byStep[row.step_key] ??= {})[row.status] = row.n;
    const hypothesisByStatus = countMap(hyps.rows, "status");
    return {
      generated_at: new Date().toISOString(),
      projects: { total: sum(countMap(runs.rows, "status")), by_status: countMap(runs.rows, "status") },
      research: {
        snapshots: { sealed: snaps.rows[0]!.sealed, building: snaps.rows[0]!.building },
        evidence_spans: spans.rows[0]!.n,
        hypotheses: { total: sum(hypothesisByStatus), by_status: hypothesisByStatus },
        evaluations: evals.rows[0]!.n,
        reviews: countMap(reviews.rows, "review_mode"),
        events_24h: { research: events.rows[0]!.n, workflow: audit.rows[0]!.n },
      },
      pipeline: {
        health: { state, reasons },
        steps_queued: p.queued, steps_running: p.running, running_with_expired_lease: p.running_expired_lease,
        live_lease_owners: p.live_lease_owners, failed_steps_24h: p.failed_24h, failed_steps_7d: p.failed_7d,
        oldest_queued_age_seconds: p.oldest_queued_age_seconds, last_step_success_at: p.last_success_at,
        steps_by_key_and_status: byStep,
      },
      storage: storage.rows[0],
    };
  });

  // ---------------------------------------------------------------- projects
  const projectSelect = `
    SELECT r.id, r.workflow_type, r.status, r.created_at, r.started_at, r.completed_at,
           r.input->>'kind' AS input_kind, r.input->>'value' AS input_value, r.input->>'source' AS input_source,
           st.total AS steps_total, st.succeeded AS steps_succeeded, st.failed AS steps_failed, cur.step_key AS current_step, cur.status AS current_step_status,
           COALESCE(sn.total, 0) AS snapshots_total, COALESCE(sn.sealed, 0) AS snapshots_sealed, COALESCE(hy.total, 0) AS hypotheses_total,
           (SELECT count(*)::int FROM hypothesis_evaluations ev WHERE ev.workflow_run_id = r.id) AS evaluations_total,
           (SELECT count(*)::int FROM hypothesis_reviews rv WHERE rv.workflow_run_id = r.id) AS reviews_total
    FROM workflow_runs r
    LEFT JOIN LATERAL (SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
                              count(*) FILTER (WHERE status = 'failed')::int AS failed FROM workflow_steps WHERE workflow_run_id = r.id) st ON true
    LEFT JOIN LATERAL (SELECT step_key, status FROM workflow_steps WHERE workflow_run_id = r.id AND status IN ('running','queued') ORDER BY sequence LIMIT 1) cur ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS total, count(*) FILTER (WHERE sealed_at IS NOT NULL)::int AS sealed FROM repo_snapshots WHERE workflow_run_id = r.id) sn ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS total FROM hypotheses WHERE workflow_run_id = r.id) hy ON true`;

  const shapeProject = (row: Row, byStatus: Record<string, number>) => ({
    id: row.id, workflow_type: row.workflow_type, status: row.status, created_at: row.created_at, started_at: row.started_at, completed_at: row.completed_at,
    input: { kind: row.input_kind, value: row.input_value, source: row.input_source },
    progress: { steps_total: row.steps_total, steps_succeeded: row.steps_succeeded, steps_failed: row.steps_failed, current_step: row.current_step, current_step_status: row.current_step_status },
    snapshots: { total: row.snapshots_total, sealed: row.snapshots_sealed },
    hypotheses: { total: row.hypotheses_total, by_status: byStatus },
    evaluations: row.evaluations_total, reviews: row.reviews_total,
  });

  const hypothesisCounts = async (db: Pool, runIds: string[]) => {
    const out = new Map<string, Record<string, number>>();
    if (!runIds.length) return out;
    const rows = await db.query<Row>(
      `SELECT h.workflow_run_id AS run_id, s.status, count(*)::int AS n FROM hypotheses h JOIN hypothesis_status s ON s.hypothesis_id = h.id
       WHERE h.workflow_run_id = ANY($1::uuid[]) GROUP BY 1, 2`, [runIds]);
    for (const row of rows.rows) { const m = out.get(row.run_id) ?? {}; m[row.status] = row.n; out.set(row.run_id, m); }
    return out;
  };

  app.get("/v1/research/projects", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const query = paging().extend({ status: z.enum(RUN_STATUSES).optional() }).safeParse(request.query);
    if (!query.success) return invalidQuery(reply);
    const { limit, offset, status } = query.data;
    const rows = (await db.pool.query<Row>(`${projectSelect} WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`,
      [status ?? null, limit + 1, offset])).rows;
    const counts = await hypothesisCounts(db.pool, rows.slice(0, limit).map((row) => row.id));
    return page(rows.map((row) => shapeProject(row, counts.get(row.id) ?? {})), limit, offset);
  });

  app.get("/v1/research/projects/:id", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return invalidId(reply);
    const id = params.data.id;
    const run = await db.pool.query<Row>(`${projectSelect} WHERE r.id = $1`, [id]);
    if (!run.rows[0]) return notFound(reply);
    const [meta, steps, snapshots, legacyEvidence, legacyOutputs, counts] = await Promise.all([
      db.pool.query<Row>("SELECT correlation_id, created_by, input->>'notes' AS notes, input->'source_reference' AS source_reference FROM workflow_runs WHERE id = $1", [id]),
      db.pool.query<Row>(
        `SELECT id, step_key, role, sequence, status, attempt, error, started_at, completed_at, lease_owner, lease_expires_at,
                (status = 'running' AND lease_expires_at > now()) AS lease_live
         FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence`, [id]),
      db.pool.query<Row>(
        `SELECT s.id, s.repository, s.commit_sha, s.ref_name, s.sealed_at, s.file_count, s.total_bytes, s.manifest_sha256, s.created_at,
                (SELECT count(*)::int FROM evidence_spans e WHERE e.snapshot_id = s.id) AS spans,
                (SELECT count(*)::int FROM hypotheses h WHERE h.snapshot_id = s.id) AS hypotheses
         FROM repo_snapshots s WHERE s.workflow_run_id = $1 ORDER BY s.created_at`, [id]),
      db.pool.query<Row>("SELECT id, source_kind, source_uri, content_sha256, captured_at FROM source_snapshots WHERE workflow_run_id = $1 ORDER BY created_at", [id]),
      db.pool.query<Row>(
        `SELECT step_key, output FROM workflow_steps WHERE workflow_run_id = $1 AND status = 'succeeded' AND step_key IN ('prepare_research_brief','map_attack_surface')`, [id]),
      hypothesisCounts(db.pool, [id]),
    ]);
    const outputs = new Map(legacyOutputs.rows.map((row) => [row.step_key, row.output as Row]));
    const leads = Array.isArray(outputs.get("map_attack_surface")?.leads) ? (outputs.get("map_attack_surface")!.leads as unknown[]).slice(0, 500) : [];
    return {
      ...shapeProject(run.rows[0]!, counts.get(id) ?? {}),
      correlation_id: meta.rows[0]!.correlation_id, created_by: meta.rows[0]!.created_by, notes: meta.rows[0]!.notes, source_reference: meta.rows[0]!.source_reference,
      steps: steps.rows,
      snapshot_records: snapshots.rows,
      legacy: {
        note: "Output of the legacy passive pipeline (regex leads, template hypotheses, checklist). It is not research-state evidence and carries no independent review.",
        evidence_snapshots: legacyEvidence.rows,
        brief: outputs.get("prepare_research_brief")?.brief ?? null,
        leads,
      },
    };
  });

  // --------------------------------------------------------------- snapshots
  const snapshotSummary = `
    SELECT s.id, s.workflow_run_id, s.repository, s.source_host, s.commit_sha, s.ref_name, s.sealed_at, s.file_count, s.total_bytes, s.manifest_sha256,
           s.acquisition_report, s.produced_by_step_id, s.sealed_by_step_id, s.created_at,
           (SELECT count(*)::int FROM evidence_spans e WHERE e.snapshot_id = s.id) AS spans,
           (SELECT count(*)::int FROM hypotheses h WHERE h.snapshot_id = s.id) AS hypotheses
    FROM repo_snapshots s`;

  app.get("/v1/research/snapshots", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const query = paging().extend({ run: uuid.optional() }).safeParse(request.query);
    if (!query.success) return invalidQuery(reply);
    const { limit, offset, run } = query.data;
    const rows = (await db.pool.query<Row>(`${snapshotSummary} WHERE ($1::uuid IS NULL OR s.workflow_run_id = $1) ORDER BY s.created_at DESC, s.id LIMIT $2 OFFSET $3`,
      [run ?? null, limit + 1, offset])).rows;
    return page(rows, limit, offset);
  });

  app.get("/v1/research/snapshots/:id", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const params = z.object({ id: uuid }).safeParse(request.params);
    const query = z.object({ verify: z.enum(["0", "1"]).default("0") }).safeParse(request.query);
    if (!params.success) return invalidId(reply);
    if (!query.success) return invalidQuery(reply);
    const id = params.data.id;
    const snap = await db.pool.query<Row>(`${snapshotSummary} WHERE s.id = $1`, [id]);
    if (!snap.rows[0]) return notFound(reply);
    const [kinds, skips, stored] = await Promise.all([
      db.pool.query<Row>("SELECT classification, count(*)::int AS n FROM repo_snapshot_files WHERE snapshot_id = $1 GROUP BY classification", [id]),
      db.pool.query<Row>("SELECT skip_reason, count(*)::int AS n FROM repo_snapshot_files WHERE snapshot_id = $1 AND skip_reason IS NOT NULL GROUP BY skip_reason", [id]),
      db.pool.query<Row>("SELECT count(*) FILTER (WHERE blob_sha256 IS NOT NULL)::int AS stored, count(*) FILTER (WHERE blob_sha256 IS NULL)::int AS skipped FROM repo_snapshot_files WHERE snapshot_id = $1", [id]),
    ]);
    return {
      ...snap.rows[0],
      sealed: snap.rows[0]!.sealed_at !== null,
      files: { stored: stored.rows[0]!.stored, skipped: stored.rows[0]!.skipped, by_classification: countMap(kinds.rows, "classification"), skip_reasons: countMap(skips.rows, "skip_reason") },
      verification: query.data.verify === "1" ? await db.store.verifySnapshot(id) : null,
    };
  });

  app.get("/v1/research/snapshots/:id/files", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const params = z.object({ id: uuid }).safeParse(request.params);
    const query = paging(1000).extend({ prefix: z.string().max(1024).optional() }).safeParse(request.query);
    if (!params.success) return invalidId(reply);
    if (!query.success) return invalidQuery(reply);
    const { limit, offset, prefix } = query.data;
    if (!(await db.pool.query("SELECT 1 FROM repo_snapshots WHERE id = $1", [params.data.id])).rowCount) return notFound(reply);
    const rows = (await db.pool.query<Row>(
      `SELECT f.path, f.classification, f.size_bytes, (f.blob_sha256 IS NOT NULL) AS stored, f.skip_reason, f.blob_sha256,
              (SELECT count(*)::int FROM evidence_spans s WHERE s.snapshot_id = f.snapshot_id AND s.path = f.path) AS span_count,
              (SELECT count(DISTINCT he.hypothesis_id)::int FROM evidence_spans s JOIN hypothesis_evidence he ON he.span_id = s.id
                WHERE s.snapshot_id = f.snapshot_id AND s.path = f.path) AS hypothesis_count
       FROM repo_snapshot_files f
       WHERE f.snapshot_id = $1 AND ($2::text IS NULL OR starts_with(f.path, $2))
       ORDER BY f.path COLLATE "C" LIMIT $3 OFFSET $4`, [params.data.id, prefix ?? null, limit + 1, offset])).rows;
    return page(rows.map((row) => ({ ...row, size_bytes: Number(row.size_bytes) })), limit, offset);
  });

  app.get("/v1/research/snapshots/:id/file", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const params = z.object({ id: uuid }).safeParse(request.params);
    const query = z.object({ path: z.string().min(1).max(1024) }).safeParse(request.query);
    if (!params.success) return invalidId(reply);
    if (!query.success) return invalidQuery(reply);
    const { id } = params.data;
    const file = await db.pool.query<Row>(
      "SELECT path, classification, size_bytes, blob_sha256, skip_reason FROM repo_snapshot_files WHERE snapshot_id = $1 AND path = $2", [id, query.data.path]);
    const row = file.rows[0];
    if (!row) return notFound(reply);
    if (!row.blob_sha256) return reply.code(409).send({ error: "skipped", reason: row.skip_reason });
    const blob = await db.pool.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [row.blob_sha256]);
    if (!blob.rows[0]) return reply.code(410).send({ error: "evicted" });
    let text: string;
    try { text = decodeUtf8Strict(blob.rows[0].content); } catch { return reply.code(415).send({ error: "not_text" }); }
    const spans = await db.pool.query<Row>(
      `SELECT s.id, s.line_start, s.line_end,
              COALESCE((SELECT json_agg(json_build_object('id', hs.hypothesis_id, 'status', hs.status) ORDER BY hs.hypothesis_id)
                        FROM hypothesis_evidence he JOIN hypothesis_status hs ON hs.hypothesis_id = he.hypothesis_id WHERE he.span_id = s.id), '[]'::json) AS hypotheses
       FROM evidence_spans s WHERE s.snapshot_id = $1 AND s.path = $2 ORDER BY s.line_start, s.line_end`, [id, query.data.path]);
    return {
      path: row.path, classification: row.classification, size_bytes: Number(row.size_bytes), blob_sha256: row.blob_sha256,
      line_count: splitLines(text).length, text, spans: spans.rows,
    };
  });

  app.get("/v1/research/snapshots/:id/surface", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return invalidId(reply);
    const { id } = params.data;
    if (!(await db.pool.query("SELECT 1 FROM repo_snapshots WHERE id = $1", [id])).rowCount) return notFound(reply);
    const LIMIT = 5000;
    const [files, spans, hyps] = await Promise.all([
      db.pool.query<Row>(
        "SELECT path, classification, size_bytes, (blob_sha256 IS NOT NULL) AS stored, skip_reason FROM repo_snapshot_files WHERE snapshot_id = $1 ORDER BY path COLLATE \"C\" LIMIT $2", [id, LIMIT + 1]),
      db.pool.query<Row>("SELECT path, count(*)::int AS n FROM evidence_spans WHERE snapshot_id = $1 GROUP BY path", [id]),
      db.pool.query<Row>(
        `SELECT s.path, hs.status, count(DISTINCT he.hypothesis_id)::int AS n FROM evidence_spans s
         JOIN hypothesis_evidence he ON he.span_id = s.id JOIN hypothesis_status hs ON hs.hypothesis_id = he.hypothesis_id
         WHERE s.snapshot_id = $1 GROUP BY 1, 2`, [id]),
    ]);
    const spanCount = new Map(spans.rows.map((row) => [row.path, row.n as number]));
    const byPath = new Map<string, Record<string, number>>();
    for (const row of hyps.rows) { const m = byPath.get(row.path) ?? {}; m[row.status] = row.n; byPath.set(row.path, m); }
    return {
      truncated: files.rows.length > LIMIT,
      files: files.rows.slice(0, LIMIT).map((row) => ({
        path: row.path, classification: row.classification, size_bytes: Number(row.size_bytes), stored: row.stored, skip_reason: row.skip_reason,
        spans: spanCount.get(row.path) ?? 0, hypotheses_by_status: byPath.get(row.path) ?? {},
      })),
    };
  });

  /** The research dossier of a sealed snapshot, assembled ONLY from stored records with every cited span re-verified; refuses (409) rather than show unverifiable evidence. */
  app.get("/v1/research/snapshots/:id/dossier", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return invalidId(reply);
    const { id } = params.data;
    if (!(await db.pool.query("SELECT 1 FROM repo_snapshots WHERE id = $1", [id])).rowCount) return notFound(reply);
    try { return await buildDossier(db.pool, new ResearchStore(db.pool), id); }
    catch { return reply.code(409).send({ error: "dossier_unverifiable", message: "a cited span could not be verified, so no dossier is shown" }); }
  });

  // -------------------------------------------------------------- hypotheses
  const hypothesisSelect = `
    SELECT h.id, h.workflow_run_id, h.snapshot_id, sn.repository, sn.commit_sha, h.family, h.claim, h.created_at, h.supersedes_id,
           h.generator_kind, h.generator_id, h.generator_version,
           s.status, s.static_outcome, s.static_conflicts_with_review, s.evaluations, s.blinded_reviews, s.adjudications, s.last_event_seq,
           (SELECT count(*)::int FROM hypothesis_evidence he WHERE he.hypothesis_id = h.id) AS evidence_count
    FROM hypotheses h JOIN hypothesis_status s ON s.hypothesis_id = h.id JOIN repo_snapshots sn ON sn.id = h.snapshot_id`;

  const shapeHypothesis = (row: Row) => ({
    id: row.id, workflow_run_id: row.workflow_run_id, snapshot_id: row.snapshot_id, repository: row.repository, commit_sha: row.commit_sha,
    family: row.family, claim: row.claim, created_at: row.created_at, supersedes_id: row.supersedes_id,
    generator: { kind: row.generator_kind, id: row.generator_id, version: row.generator_version },
    status: row.status, static_outcome: row.static_outcome, static_conflicts_with_review: row.static_conflicts_with_review,
    counts: { evidence: row.evidence_count, evaluations: row.evaluations, blinded_reviews: row.blinded_reviews, adjudications: row.adjudications },
    last_event_seq: row.last_event_seq == null ? null : Number(row.last_event_seq),
  });

  app.get("/v1/research/hypotheses", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const query = paging().extend({ run: uuid.optional(), snapshot: uuid.optional(), status: z.enum(HYPOTHESIS_STATUSES).optional() }).safeParse(request.query);
    if (!query.success) return invalidQuery(reply);
    const { limit, offset, run, snapshot, status } = query.data;
    const [rows, facets] = await Promise.all([
      db.pool.query<Row>(
        `${hypothesisSelect}
         WHERE ($1::uuid IS NULL OR h.workflow_run_id = $1) AND ($2::uuid IS NULL OR h.snapshot_id = $2) AND ($3::text IS NULL OR s.status = $3)
         ORDER BY h.created_at DESC, h.id LIMIT $4 OFFSET $5`, [run ?? null, snapshot ?? null, status ?? null, limit + 1, offset]),
      db.pool.query<Row>(
        `SELECT s.status, count(*)::int AS n FROM hypotheses h JOIN hypothesis_status s ON s.hypothesis_id = h.id
         WHERE ($1::uuid IS NULL OR h.workflow_run_id = $1) AND ($2::uuid IS NULL OR h.snapshot_id = $2) GROUP BY s.status`, [run ?? null, snapshot ?? null]),
    ]);
    return { ...page(rows.rows.map(shapeHypothesis), limit, offset), facets: { status: countMap(facets.rows, "status") } };
  });

  app.get("/v1/research/hypotheses/:id", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return invalidId(reply);
    const id = params.data.id;
    const head = await db.pool.query<Row>(
      `${hypothesisSelect.replace("SELECT h.id,", "SELECT h.rationale, h.required_checks, h.alternative_explanations, h.generator_reservation_id, h.produced_by_step_id, h.id,")} WHERE h.id = $1`, [id]);
    const row = head.rows[0];
    if (!row) return notFound(reply);
    const [evidence, evaluations, reviews, events] = await Promise.all([
      db.pool.query<Row>(
        `SELECT he.role, s.id AS span_id, s.path, s.line_start, s.line_end FROM hypothesis_evidence he JOIN evidence_spans s ON s.id = he.span_id
         WHERE he.hypothesis_id = $1 ORDER BY CASE he.role WHEN 'primary' THEN 0 WHEN 'supporting' THEN 1 ELSE 2 END, s.path, s.line_start`, [id]),
      db.pool.query<Row>(
        `SELECT e.id, e.evaluator_id, e.evaluator_version, e.actor_kind, e.outcome, e.rationale, e.input_sha256, e.created_at, e.produced_by_step_id,
                COALESCE((SELECT json_agg(ee.span_id ORDER BY ee.span_id) FROM evaluation_evidence ee WHERE ee.evaluation_id = e.id), '[]'::json) AS span_ids
         FROM hypothesis_evaluations e WHERE e.hypothesis_id = $1 ORDER BY e.created_at, e.id`, [id]),
      db.pool.query<Row>(
        `SELECT r.id, r.reviewer_kind, r.reviewer_id, r.review_mode, r.reviewer_saw, r.input_sha256, r.verdict, r.rationale, r.created_at, r.produced_by_step_id,
                r.model_provider, r.model_name, r.model_prompt_version, r.model_reservation_id
         FROM hypothesis_reviews r WHERE r.hypothesis_id = $1 ORDER BY r.created_at, r.id`, [id]),
      db.pool.query<Row>(
        "SELECT seq, event_type, actor_kind, actor_id, reason, created_at, evaluation_id, review_id FROM hypothesis_events WHERE hypothesis_id = $1 ORDER BY seq", [id]),
    ]);
    const resolved: Array<Row & { resolution: Awaited<ReturnType<ResearchStore["resolveSpan"]>> }> = [];
    for (const span of evidence.rows) resolved.push({ ...span, resolution: await db.store.resolveSpan(span.span_id) });
    return {
      ...shapeHypothesis(row),
      rationale: row.rationale, required_checks: row.required_checks, alternative_explanations: row.alternative_explanations,
      generator_reservation_id: row.generator_reservation_id, produced_by_step_id: row.produced_by_step_id,
      evidence: resolved.map((span) => ({
        span_id: span.span_id, role: span.role, path: span.path, line_start: span.line_start, line_end: span.line_end,
        resolution: span.resolution.ok ? { ok: true, text: span.resolution.text } : { ok: false, reason: span.resolution.reason },
      })),
      evaluations: evaluations.rows,
      reviews: reviews.rows.map((r) => ({
        id: r.id, reviewer_kind: r.reviewer_kind, reviewer_id: r.reviewer_id, review_mode: r.review_mode, reviewer_saw: r.reviewer_saw,
        input_sha256: r.input_sha256, verdict: r.verdict, rationale: r.rationale, created_at: r.created_at, produced_by_step_id: r.produced_by_step_id,
        model: r.reviewer_kind === "model" ? { provider: r.model_provider, name: r.model_name, prompt_version: r.model_prompt_version, reservation_id: r.model_reservation_id } : null,
      })),
      events: events.rows.map((e) => ({ ...e, seq: Number(e.seq) })),
    };
  });

  // ---------------------------------------------------------------- evidence
  app.get("/v1/research/evidence", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const query = paging().extend({ snapshot: uuid.optional(), run: uuid.optional(), path: z.string().max(1024).optional() }).safeParse(request.query);
    if (!query.success) return invalidQuery(reply);
    const { limit, offset, snapshot, run, path } = query.data;
    const rows = (await db.pool.query<Row>(
      `SELECT s.id, s.snapshot_id, s.workflow_run_id, sn.repository, sn.commit_sha, s.path, s.line_start, s.line_end, s.created_at,
              (SELECT count(*)::int FROM hypothesis_evidence he WHERE he.span_id = s.id) AS cited_by_hypotheses,
              (SELECT count(*)::int FROM evaluation_evidence ee WHERE ee.span_id = s.id) AS cited_by_evaluations
       FROM evidence_spans s JOIN repo_snapshots sn ON sn.id = s.snapshot_id
       WHERE ($1::uuid IS NULL OR s.snapshot_id = $1) AND ($2::uuid IS NULL OR s.workflow_run_id = $2) AND ($3::text IS NULL OR starts_with(s.path, $3))
       ORDER BY s.created_at DESC, s.id LIMIT $4 OFFSET $5`, [snapshot ?? null, run ?? null, path ?? null, limit + 1, offset])).rows;
    return page(rows, limit, offset);
  });

  app.get("/v1/research/evidence/:id", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const params = z.object({ id: uuid }).safeParse(request.params);
    const query = z.object({ context: z.coerce.number().int().min(0).max(20).default(3) }).safeParse(request.query);
    if (!params.success) return invalidId(reply);
    if (!query.success) return invalidQuery(reply);
    const id = params.data.id;
    const span = await db.pool.query<Row>(
      `SELECT s.id, s.snapshot_id, s.workflow_run_id, sn.repository, sn.commit_sha, s.path, s.line_start, s.line_end, s.blob_sha256, s.excerpt_sha256, s.created_at, s.produced_by_step_id
       FROM evidence_spans s JOIN repo_snapshots sn ON sn.id = s.snapshot_id WHERE s.id = $1`, [id]);
    const row = span.rows[0];
    if (!row) return notFound(reply);
    const resolution = await db.store.resolveSpan(id);
    const verification = await db.store.verifySpan(id);
    let context: { before: Array<{ line: number; text: string }>; after: Array<{ line: number; text: string }> } | null = null;
    if (resolution.ok) {
      const blob = await db.pool.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [row.blob_sha256]);
      if (blob.rows[0]) {
        const lines = splitLines(decodeUtf8Strict(blob.rows[0].content));
        const n = query.data.context;
        const take = (from: number, to: number) => { const out = []; for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i += 1) out.push({ line: i, text: lines[i - 1]! }); return out; };
        context = { before: take(row.line_start - n, row.line_start - 1), after: take(row.line_end + 1, row.line_end + n) };
      }
    }
    const [hyps, evals] = await Promise.all([
      db.pool.query<Row>(
        `SELECT h.id, h.claim, h.family, he.role, hs.status FROM hypothesis_evidence he JOIN hypotheses h ON h.id = he.hypothesis_id
         JOIN hypothesis_status hs ON hs.hypothesis_id = h.id WHERE he.span_id = $1 ORDER BY h.created_at`, [id]),
      db.pool.query<Row>(
        `SELECT e.id, e.hypothesis_id, e.evaluator_id, e.outcome FROM evaluation_evidence ee JOIN hypothesis_evaluations e ON e.id = ee.evaluation_id
         WHERE ee.span_id = $1 ORDER BY e.created_at`, [id]),
    ]);
    return {
      span: { id: row.id, snapshot_id: row.snapshot_id, workflow_run_id: row.workflow_run_id, repository: row.repository, commit_sha: row.commit_sha, path: row.path,
        line_start: row.line_start, line_end: row.line_end, blob_sha256: row.blob_sha256, excerpt_sha256: row.excerpt_sha256, created_at: row.created_at, produced_by_step_id: row.produced_by_step_id },
      resolution: resolution.ok ? { ok: true, text: resolution.text } : { ok: false, reason: resolution.reason },
      verification, context,
      cited_by: { hypotheses: hyps.rows, evaluations: evals.rows },
    };
  });

  // ---------------------------------------------------------------- activity
  app.get("/v1/research/activity", async (request, reply) => {
    const db = guard(reply); if (!db) return;
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      automation: z.enum(["automated", "human", "model"]).optional(),
      before: z.string().datetime({ offset: true }).optional(),
      before_id: z.string().max(100).optional(),
    }).safeParse(request.query);
    if (!query.success) return invalidQuery(reply);
    const { limit, automation, before, before_id } = query.data;
    const rows = (await db.pool.query<Row>(
      `SELECT * FROM (
         SELECT 'research:' || e.seq AS id, e.created_at AS at, to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_cursor, 'research_event' AS source,
                CASE e.actor_kind WHEN 'human' THEN 'human' WHEN 'model' THEN 'model' ELSE 'automated' END AS automation,
                e.actor_kind, e.actor_id, e.event_type AS action, 'hypothesis' AS entity_type, e.hypothesis_id::text AS entity_id,
                e.workflow_run_id AS run_id, e.hypothesis_id, NULL::text AS step_key, e.reason
         FROM hypothesis_events e
         UNION ALL
         SELECT 'audit:' || lpad(a.id::text, 12, '0'), a.created_at, to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'workflow_audit',
                CASE WHEN a.actor = 'user' THEN 'human' ELSE 'automated' END,
                CASE WHEN a.actor = 'user' THEN 'human' ELSE 'worker' END, a.actor, a.action, a.entity_type, a.entity_id,
                CASE a.entity_type WHEN 'workflow_run' THEN a.entity_id::uuid ELSE ws.workflow_run_id END, NULL::uuid, ws.step_key, a.reason
         FROM audit_events a LEFT JOIN workflow_steps ws ON a.entity_type = 'workflow_step' AND ws.id::text = a.entity_id
       ) t
       WHERE ($1::text IS NULL OR t.automation = $1)
         AND ($2::timestamptz IS NULL OR (t.at, t.id) < ($2::timestamptz, $3::text))
       ORDER BY t.at DESC, t.id DESC LIMIT $4`, [automation ?? null, before ?? null, before_id ?? "￿", limit + 1])).rows;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, limit, has_more: rows.length > limit, next: rows.length > limit && last ? { before: last.at_cursor, before_id: last.id } : null, automation_basis: AUTOMATION_BASIS };
  });
}
