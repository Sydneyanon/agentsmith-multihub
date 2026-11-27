import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ANALYZE_STEP_KEY, STRUCTURAL_ANALYSIS_SWITCH } from "./analysis/solidity/keys.js";
import { REPOSITORY_RESEARCH_WORKFLOW } from "./acquisition/step.js";
import { describeGitHubAuth } from "./net/github-auth.js";

/**
 * CR2 (docs/control-room-plan.md): one read-only, database-backed description of what the engine is doing right now.
 * Every number is a query over existing tables at request time; nothing is cached, seeded or inferred in the browser.
 * The response never carries environment values, connection strings, tokens or raw error bodies.
 */

export const ENGINE_STATUS_VERSION = "engine-status/1";
/** The prefix every worker process puts in its database session name (`application_name`), so presence is visible while idle. */
export const WORKER_APP_PREFIX = "agentsmith-worker/1";
export const API_APP_NAME = "agentsmith-api/1";

/** `agentsmith-worker/1 <workerId> structural=<0|1>`, at most 63 bytes (Postgres truncates longer names). */
export function workerApplicationName(workerId: string, env: Record<string, string | undefined>): string {
  const flag = env[STRUCTURAL_ANALYSIS_SWITCH] === "true" ? "1" : "0";
  const id = workerId.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 63 - WORKER_APP_PREFIX.length - " structural=0".length - 1);
  return `${WORKER_APP_PREFIX} ${id} structural=${flag}`;
}

export function parseWorkerApplicationName(name: string): { worker_id: string; structural_analysis: boolean } | null {
  const m = /^agentsmith-worker\/1 (\S+) structural=([01])$/.exec(name);
  return m ? { worker_id: m[1]!, structural_analysis: m[2] === "1" } : null;
}

export type DataKind = "production" | "synthetic" | "test" | "unlabelled";
export type BuildInfo = { commit: string | null; image: string | null; built_at: string | null; source: "build-info.json" | "none" };

/** Written by the image build (scripts/hub-image.sh) into dist/build-info.json. A missing file means the build is not identified, and says so. */
export function readBuildInfo(path = join(dirname(fileURLToPath(import.meta.url)), "../../../build-info.json")): BuildInfo {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
    return { commit: str(raw.commit, /^[0-9a-f]{40}$/), image: str(raw.image, /^[A-Za-z0-9._:/@-]{1,200}$/), built_at: str(raw.built_at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/), source: "build-info.json" };
  } catch { return { commit: null, image: null, built_at: null, source: "none" }; }
}

/** The migrations this build ships: db/migrations next to dist/ in the image (four levels up from dist/apps/api/src), or in the repository. */
export function expectedMigrations(dirs = ["../../../../db/migrations", "../../../db/migrations"].map((d) => join(dirname(fileURLToPath(import.meta.url)), d))): string[] | null {
  for (const dir of dirs) { try { return readdirSync(dir).filter((f) => /^\d+_[a-z0-9_-]+\.sql$/i.test(f)).sort(); } catch { /* next */ } }
  return null;
}

/**
 * Step errors are written by workers and may quote URLs, hosts or upstream messages. Only a short, scrubbed message is shown:
 * credentials in URLs, query strings, host:port pairs, IP addresses and long opaque strings (possible tokens) are removed.
 */
export function shapeError(error: unknown): { message: string; retryable: boolean | null } {
  const e = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  let m = typeof e.message === "string" ? e.message : typeof error === "string" ? error : "error recorded without a message";
  m = m
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (u) => { try { const x = new URL(u); return `${x.protocol}//${x.hostname}${x.pathname.length > 1 ? x.pathname.slice(0, 60) : ""}`; } catch { return "[url]"; } })
    .replace(/\b(\d{1,3}\.){3}\d{1,3}(:\d+)?\b/g, "[address]")
    .replace(/\b[a-z0-9.-]+\.[a-z]{2,}:\d{2,5}\b/gi, "[host:port]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]");
  return { message: m.length > 200 ? `${m.slice(0, 199)}…` : m, retryable: typeof e.retryable === "boolean" ? e.retryable : null };
}

type Row = Record<string, any>;
export type EngineInfo = { build: BuildInfo; dataKind: DataKind; expectedMigrations: string[] | null };

export function registerEngineStatusRoutes(app: FastifyInstance, pool: Pool | undefined, info: EngineInfo): void {
  app.get("/v1/engine/status", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    if (!pool) return reply.code(503).send({ error: "database_not_configured" });
    const q = (sql: string, params: unknown[] = []) => pool.query<Row>(sql, params).then((r) => r.rows);
    const [[now], applied, tables, sessions, leases, queue, runs, lastRun, lastFailure, lastSuccess, research, models] = await Promise.all([
      q("SELECT now() AS at"),
      q("SELECT name, applied_at FROM schema_migrations ORDER BY name").catch(() => null),
      q(`SELECT to_regclass('public.discovery_sources') IS NOT NULL AS discovery, to_regclass('public.knowledge_items') IS NOT NULL AS knowledge`),
      // application_name of other roles' sessions is visible to an unprivileged role; state and timestamps are not, and are not used
      q("SELECT application_name, count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE $1 GROUP BY 1 ORDER BY 1 LIMIT 50", [`${WORKER_APP_PREFIX} %`]),
      q(`SELECT s.lease_owner, s.step_key, r.workflow_type, s.lease_expires_at, s.lease_expires_at > now() AS live
         FROM workflow_steps s JOIN workflow_runs r ON r.id = s.workflow_run_id WHERE s.status = 'running' ORDER BY s.started_at NULLS LAST LIMIT 50`),
      q(`SELECT r.workflow_type, s.step_key,
                count(*) FILTER (WHERE s.status = 'queued' AND r.status IN ('queued','running'))::int AS queued,
                count(*) FILTER (WHERE s.status = 'running' AND s.lease_expires_at > now())::int AS running_live,
                count(*) FILTER (WHERE s.status = 'running' AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now()))::int AS running_expired,
                count(*) FILTER (WHERE s.status = 'awaiting_approval')::int AS awaiting_approval,
                count(*) FILTER (WHERE s.status = 'succeeded')::int AS succeeded,
                count(*) FILTER (WHERE s.status = 'failed')::int AS failed,
                count(*) FILTER (WHERE s.status = 'failed' AND s.completed_at > now() - interval '24 hours')::int AS failed_24h,
                EXTRACT(EPOCH FROM now() - min(s.created_at) FILTER (WHERE s.status = 'queued' AND r.status IN ('queued','running')))::int AS oldest_queued_age_seconds
         FROM workflow_steps s JOIN workflow_runs r ON r.id = s.workflow_run_id GROUP BY 1, 2 ORDER BY 1, min(s.sequence), 2`),
      q("SELECT workflow_type, status, count(*)::int AS n, max(created_at) AS last_created_at FROM workflow_runs GROUP BY 1, 2 ORDER BY 1, 2"),
      q("SELECT id, workflow_type, status, created_at, created_by FROM workflow_runs ORDER BY created_at DESC, id LIMIT 1"),
      q(`SELECT s.workflow_run_id AS run_id, r.workflow_type, s.step_key, s.attempt, s.completed_at, s.error
         FROM workflow_steps s JOIN workflow_runs r ON r.id = s.workflow_run_id WHERE s.status = 'failed' ORDER BY s.completed_at DESC NULLS LAST LIMIT 1`),
      q(`SELECT r.workflow_type, s.step_key, s.completed_at FROM workflow_steps s JOIN workflow_runs r ON r.id = s.workflow_run_id
         WHERE s.status = 'succeeded' ORDER BY s.completed_at DESC NULLS LAST LIMIT 1`),
      q(`SELECT (SELECT count(*)::int FROM repo_snapshots WHERE sealed_at IS NOT NULL) AS snapshots_sealed,
                (SELECT count(*)::int FROM repo_snapshots WHERE sealed_at IS NULL) AS snapshots_building,
                (SELECT count(*)::int FROM evidence_spans) AS evidence_spans,
                (SELECT count(*)::int FROM hypotheses) AS hypotheses,
                (SELECT count(*)::int FROM hypothesis_evaluations) AS evaluations,
                (SELECT count(*)::int FROM hypothesis_reviews WHERE review_mode = 'blinded_independent_assessment') AS blinded_reviews,
                (SELECT count(*)::int FROM hypothesis_reviews WHERE review_mode = 'disclosed_adjudication') AS adjudications`),
      q(`SELECT count(*)::int AS n FROM workflow_steps WHERE step_key = $1 AND status = 'succeeded' AND output ? 'protocol_model_sha256'`, [ANALYZE_STEP_KEY]),
    ]);
    const t = tables[0]!;
    const [hyp, discovery] = await Promise.all([
      q("SELECT status, count(*)::int AS n FROM hypothesis_status GROUP BY 1"),
      t.discovery
        ? q(`SELECT (SELECT count(*)::int FROM discovery_sources) AS sources, (SELECT count(*)::int FROM discovery_sources WHERE enabled) AS enabled,
                    (SELECT max(last_success_at) FROM discovery_sources) AS last_success_at,
                    (SELECT COALESCE(jsonb_object_agg(state, n), '{}'::jsonb) FROM (SELECT state, count(*)::int AS n FROM bounty_opportunities GROUP BY 1) x) AS opportunities`).then((r) => r[0]!)
        : Promise.resolve(null),
    ]);

    const appliedNames = applied ? applied.map((r) => String(r.name)) : null;
    const expected = info.expectedMigrations;
    const workerSessions = sessions.flatMap((s) => { const p = parseWorkerApplicationName(String(s.application_name)); return p ? [{ ...p, connections: s.n }] : []; });
    const liveOwners = [...new Set(leases.filter((l) => l.live).map((l) => String(l.lease_owner)))];
    const queuedTotal = queue.reduce((a, r) => a + r.queued, 0);
    const liveTotal = queue.reduce((a, r) => a + r.running_live, 0);
    const expiredTotal = queue.reduce((a, r) => a + r.running_expired, 0);
    const failed24h = queue.reduce((a, r) => a + r.failed_24h, 0);
    const workersSeen = workerSessions.length + liveOwners.filter((o) => !workerSessions.some((w) => w.worker_id === o)).length;
    const reasons: string[] = [];
    if (expiredTotal) reasons.push(`${expiredTotal} running step(s) have an expired lease: no worker is renewing them`);
    if (failed24h) reasons.push(`${failed24h} step(s) failed in the last 24 hours`);
    if (queuedTotal && workersSeen === 0) reasons.push(`${queuedTotal} step(s) are queued but no worker is connected`);
    if (expected && appliedNames) { const missing = expected.filter((m) => !appliedNames.includes(m)); if (missing.length) reasons.push(`migrations shipped with this build but not applied: ${missing.join(", ")}`); }
    const github = describeGitHubAuth(); // mode only: the token never appears in the status
    if (github.problem) reasons.push(github.problem);
    const state = reasons.length ? "attention" : liveTotal > 0 ? "working" : queuedTotal > 0 ? "queued" : "idle";
    const lanes: Record<string, { label: string; kind: "structural" | "legacy" | "other" }> = {
      [REPOSITORY_RESEARCH_WORKFLOW]: { label: "Structural repository research (T-149)", kind: "structural" },
    };
    const laneOf = (type: string) => lanes[type] ?? (type === "discovery_monitor" ? { label: "Discovery monitor", kind: "other" as const } : { label: `Legacy intake (${type})`, kind: "legacy" as const });
    const f = lastFailure[0];
    return {
      version: ENGINE_STATUS_VERSION,
      generated_at: new Date(now!.at).toISOString(),
      data_kind: info.dataKind,
      build: info.build,
      github,
      schema: {
        ledger_readable: appliedNames !== null,
        applied: appliedNames, expected,
        missing: expected && appliedNames ? expected.filter((m) => !appliedNames.includes(m)) : null,
        unknown: expected && appliedNames ? appliedNames.filter((m) => !expected.includes(m)) : null,
        discovery_installed: Boolean(t.discovery),
      },
      engine: { state, reasons },
      workers: {
        connected: workerSessions,
        live_lease_owners: liveOwners,
        presence_basis: "A worker names its database session `agentsmith-worker/1 <id> structural=<0|1>`; a live lease means it is running a step now. A connection pooler between the worker and the database can hide session names, so 'none seen' means none visible, not proven absent.",
        running: leases.map((l) => ({ worker: l.lease_owner, workflow_type: l.workflow_type, step_key: l.step_key, live: l.live, lease_expires_at: l.lease_expires_at })),
      },
      queue: {
        totals: { queued: queuedTotal, running_live: liveTotal, running_expired_lease: expiredTotal, failed_24h: failed24h },
        order_basis: "claim order (oldest first); no priority engine runs in this deployment",
        by_lane: Object.values(queue.reduce((acc: Record<string, any>, r) => {
          const lane = laneOf(r.workflow_type);
          (acc[r.workflow_type] ??= { workflow_type: r.workflow_type, label: lane.label, kind: lane.kind, steps: [] }).steps.push({ step_key: r.step_key, queued: r.queued, running_live: r.running_live, running_expired_lease: r.running_expired, awaiting_approval: r.awaiting_approval, succeeded: r.succeeded, failed: r.failed, failed_24h: r.failed_24h, oldest_queued_age_seconds: r.oldest_queued_age_seconds });
          return acc;
        }, {})),
      },
      runs: runs.map((r) => ({ workflow_type: r.workflow_type, lane: laneOf(r.workflow_type).kind, status: r.status, count: r.n, last_created_at: r.last_created_at })),
      last: {
        run: lastRun[0] ? { id: lastRun[0].id, workflow_type: lastRun[0].workflow_type, status: lastRun[0].status, created_at: lastRun[0].created_at, created_by: String(lastRun[0].created_by).slice(0, 60) } : null,
        step_success: lastSuccess[0] ?? null,
        failure: f ? { run_id: f.run_id, workflow_type: f.workflow_type, step_key: f.step_key, attempt: f.attempt, at: f.completed_at, error: shapeError(f.error) } : null,
      },
      stages: {
        discovery: discovery ? { installed: true, sources: discovery.sources, enabled_sources: discovery.enabled, last_success_at: discovery.last_success_at, opportunities_by_state: discovery.opportunities } : { installed: false, reason: "migration 0008 (discovery) is not applied in this database" },
        acquisition: { snapshots_sealed: research[0]!.snapshots_sealed, snapshots_building: research[0]!.snapshots_building },
        protocol_mapping: { stored_models: models[0]!.n, schema: "protocol-model/3 (P1–P3)" },
        hypotheses: { total: research[0]!.hypotheses, by_status: Object.fromEntries(hyp.map((r) => [r.status, r.n])), note: "hypotheses are leads, not findings" },
        evidence_spans: research[0]!.evidence_spans,
        validation: { evaluations: research[0]!.evaluations, blinded_reviews: research[0]!.blinded_reviews },
        adjudication: { disclosed_adjudications: research[0]!.adjudications, human_confirmed_findings: null, note: "no human-review/outcome API exists (T-149 S2 unapproved); confirmed findings are not recorded here" },
        memory: { installed: Boolean(t.knowledge), built: false, note: "experience memory is not built" },
      },
    };
  });
}
