import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { ACQUIRE_STEP_KEY } from "./acquisition/step.js";
import { parseBountyScope, type BountyScope } from "./acquisition/bounty-scope.js";
import { ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY, SLITHER_STEP_KEY } from "./analysis/solidity/keys.js";
import { buildDossier, type Dossier } from "./analysis/solidity/pipeline.js";
import { classifyEligibility } from "./bounties/eligibility.js";
import type { Resolution } from "./bounties/resolve.js";
import { availability, CAPABILITIES, TRACKED_CLASSES, type Availability } from "./engine/capabilities.js";
import { shapeError } from "./engine-status.js";
import { describeGitHubAuth, redactSecrets } from "./net/github-auth.js";
import { ResearchStore } from "./research-state.js";
import { PROGRESS_ACTION } from "./step-progress.js";
import { redactWorkerTokens } from "./worker-tokens.js";

/**
 * The live operations dashboard (docs/research-runs/live-operations-dashboard-spec.md). Read-only, behind the operator token like every
 * /v1 route. Every number is computed at request time from stored records; nothing is cached, simulated or defaulted to "done".
 *
 * Every metric is `{numerator, denominator, unit, kind, source, measurable, basis}`:
 * - kind: processing (planned work done), coverage (what should be examined, was), confidence (a distribution, never one %), outcome (counts);
 * - measurable is false whenever the denominator (or the count itself) is not recorded: the client then shows the count and
 *   "not measurable", never a percentage;
 * - basis: `verified` = counted by the API from its own records (and, where stated, checked by the API: D2/D3); `worker_reported` = a
 *   number a worker reported (progress records, direct-worker outputs) and taken as reported.
 */
export type MetricKind = "processing" | "coverage" | "confidence" | "outcome";
export type MetricBasis = "verified" | "worker_reported";
export type Metric = {
  key: string; label: string; numerator: number | null; denominator: number | null; unit: string; kind: MetricKind; source: string;
  measurable: boolean; basis: MetricBasis; note?: string;
};
export type ComponentState = "operational" | "available" | "experimental" | "unavailable" | "blocked";

type Row = Record<string, any>;
const uuid = z.string().uuid();

export function metric(m: Omit<Metric, "measurable"> & { measurable?: boolean }): Metric {
  const measurable = m.measurable ?? (m.numerator !== null && m.denominator !== null && m.denominator > 0 && m.numerator <= m.denominator);
  return { ...m, measurable: measurable && m.denominator !== null && m.numerator !== null };
}
const count = (key: string, label: string, n: number | null, unit: string, kind: MetricKind, source: string, basis: MetricBasis, note?: string): Metric =>
  metric({ key, label, numerator: n, denominator: null, unit, kind, source, basis, measurable: false, ...(note ? { note } : {}) });

// ------------------------------------------------------------------------------------------------------------------------- redaction
const SECRET_KEY = /(^|_)(token|secret|password|passwd|authorization|api_key|apikey|bearer|cookie|credential|private_key)$/i;
const ALLOWED_KEY = /^(token_id|presented_token_id|token_ids)$/;
const OMIT_KEY = new Set(["structural_map", "finding_payloads", "content", "content_base64", "text"]);
/** Token-shaped and credential-shaped text removed (worker tokens, GitHub tokens, bearer values, URL credentials, the configured token). */
export function redactText(text: string): string {
  return redactSecrets(redactWorkerTokens(text)).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, "$1[redacted]@");
}
/** A stored payload made safe and small for the timeline: secrets removed by key and by shape, large fields omitted, sizes capped. */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") { const t = redactText(value); return t.length > 600 ? `${t.slice(0, 599)}…` : t; }
  if (depth >= 6) return "[nested too deep]";
  if (Array.isArray(value)) {
    const head = value.slice(0, 25).map((v) => sanitizePayload(v, depth + 1));
    return value.length > 25 ? [...head, `… ${value.length - 25} more`] : head;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
      if (SECRET_KEY.test(k) && !ALLOWED_KEY.test(k)) out[k] = "[redacted]";
      else if (OMIT_KEY.has(k)) out[k] = "[omitted: large or content field]";
      else out[k] = sanitizePayload(v, depth + 1);
    }
    return out;
  }
  return String(value);
}
function cappedPayload(value: unknown): unknown {
  const clean = sanitizePayload(value);
  const json = JSON.stringify(clean) ?? "null";
  if (json.length <= 8_000) return clean;
  return { truncated: true, bytes: json.length, keys: clean && typeof clean === "object" ? Object.keys(clean as object).slice(0, 60) : [] };
}

// ----------------------------------------------------------------------------------------------------------------------- the panels
type Issues = {
  errors: Array<{ step_key: string; attempt: number | null; message: string; retryable: boolean | null; at: string | null; source: string }>;
  retries: Array<{ step_key: string; attempt: number }>;
  expired_leases: Array<{ step_key: string; lease_owner: string | null; lease_expired_at: string | null }>;
  lease_exhausted: number;
  abstentions: Array<{ code: string; detail: string; source: string }>;
  refusals: { total: number; quota: number; by_code: Record<string, number> };
  blockers: Array<{ text: string; source: string }>;
};
const noIssues = (): Issues => ({ errors: [], retries: [], expired_leases: [], lease_exhausted: 0, abstentions: [], refusals: { total: 0, quota: 0, by_code: {} }, blockers: [] });
export type StepActivity = {
  step_id: string; step_key: string; status: string; attempt: number; started_at: string | null; completed_at: string | null; elapsed_seconds: number | null;
  lease_owner: string | null; lease_expires_at: string | null; lease_live: boolean; running_live: boolean;
  latest_progress: { phase: string; done: number; total: number | null; unit: string; at: string; reported_by: "worker"; via: string | null } | null;
  progress_records: number;
};
export type Panel = {
  id: string; title: string;
  /** what the stored records say about this stage of THIS run */
  state: "not_started" | "queued" | "running" | "stalled" | "succeeded" | "failed" | "not_in_run" | "recorded" | "unavailable" | "experimental";
  state_basis: string;
  availability: { state: ComponentState; reason: string; evidence: string } | null;
  processing: Metric[]; coverage: Metric[]; counts: Metric[];
  activity: StepActivity[];
  issues: Issues;
  notes: string[];
  /** the tools panel only: one row per capability, with its state in this run and in this environment */
  capabilities?: unknown[];
};
const QUOTA_CODES = new Set(["storage_quota_exceeded", "read_quota_exceeded", "processing_budget_exhausted", "processing_limit_exceeded", "rate_limited"]);
const PANEL_STEP: Record<string, string> = { acquisition: ACQUIRE_STEP_KEY, protocol_analysis: ANALYZE_STEP_KEY, tools: SLITHER_STEP_KEY, validation: CHALLENGE_STEP_KEY, evidence: DOSSIER_STEP_KEY };

async function exists(pool: Pool, table: string): Promise<boolean> {
  return (await pool.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [`public.${table}`])).rows[0]?.t != null;
}

function stepState(steps: StepActivity[]): { state: Panel["state"]; basis: string } {
  if (!steps.length) return { state: "not_in_run", basis: "no such step was created for this run (workflow_steps)" };
  const s = steps[0]!;
  if (s.status === "running") return s.lease_live ? { state: "running", basis: `step running with a live lease held by ${s.lease_owner} until ${s.lease_expires_at}` } : { state: "stalled", basis: `step marked running but its lease expired at ${s.lease_expires_at}: no worker is renewing it` };
  if (s.status === "succeeded") return { state: "succeeded", basis: `step succeeded at ${s.completed_at} (processed)` };
  if (s.status === "failed") return { state: "failed", basis: `step failed at ${s.completed_at} after attempt ${s.attempt}` };
  if (s.status === "queued") return { state: s.attempt > 0 ? "queued" : "not_started", basis: s.attempt > 0 ? `re-queued after attempt ${s.attempt}` : "queued; no worker has claimed it" };
  return { state: "recorded", basis: `step status ${s.status}` };
}

/** Builds the whole progress document of one run. Exported for tests. */
export async function runProgress(pool: Pool, runId: string, env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown> | null> {
  const run = (await pool.query<Row>("SELECT id, workflow_type, status, input, created_at, started_at, completed_at, (SELECT now()) AS now FROM workflow_runs WHERE id = $1", [runId])).rows[0];
  if (!run) return null;
  const [hasVerifications, hasIndependence, hasBounty, hasLinks, hasProvenance] = await Promise.all(
    ["snapshot_verifications", "evaluation_independence", "bounty_collection_runs", "bounty_research_links", "evaluation_provenance"].map((t) => exists(pool, t)));
  const stepRows = (await pool.query<Row>(
    `SELECT id, step_key, sequence, status, attempt, error, input->>'scope' AS scope, started_at, completed_at, lease_owner, lease_expires_at,
            (status = 'running' AND lease_expires_at > now()) AS lease_live,
            CASE WHEN started_at IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - started_at))::int END AS elapsed_seconds,
            output - 'structural_map' - 'finding_payloads' - 'hypothesis_ids' - 'leads' AS output
     FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence, created_at`, [runId])).rows;
  const ids = stepRows.map((s) => String(s.id));
  const [progressRows, progressCounts, failures, exhausted, refusals] = await Promise.all([
    pool.query<Row>(`SELECT DISTINCT ON (entity_id) entity_id, payload, created_at FROM audit_events
      WHERE entity_type = 'workflow_step' AND entity_id = ANY($1::text[]) AND action = $2 ORDER BY entity_id, created_at DESC, id DESC`, [ids, PROGRESS_ACTION]),
    pool.query<Row>(`SELECT entity_id, count(*)::int AS n FROM audit_events WHERE entity_type = 'workflow_step' AND entity_id = ANY($1::text[]) AND action = $2 GROUP BY 1`, [ids, PROGRESS_ACTION]),
    pool.query<Row>(`SELECT entity_id, payload, created_at FROM audit_events WHERE entity_type = 'workflow_step' AND entity_id = ANY($1::text[]) AND action = 'workflow_step.failed' ORDER BY created_at`, [ids]),
    pool.query<Row>(`SELECT entity_id, count(*)::int AS n FROM audit_events WHERE entity_type = 'workflow_step' AND entity_id = ANY($1::text[]) AND action = 'workflow_step.lease_exhausted' GROUP BY 1`, [ids]),
    pool.query<Row>(`SELECT payload->>'step_id' AS step_id, payload->>'code' AS code, count(*)::int AS n FROM audit_events
      WHERE entity_type = 'workflow_run' AND entity_id = $1::text AND action = 'worker_api.refused' GROUP BY 1, 2`, [runId]),
  ]);
  const latest = new Map(progressRows.rows.map((r) => [String(r.entity_id), r]));
  const nProgress = new Map(progressCounts.rows.map((r) => [String(r.entity_id), Number(r.n)]));
  const activity = (s: Row): StepActivity => {
    const p = latest.get(String(s.id));
    return {
      step_id: s.id, step_key: s.step_key, status: s.status, attempt: s.attempt, started_at: iso(s.started_at), completed_at: iso(s.completed_at), elapsed_seconds: s.elapsed_seconds,
      lease_owner: s.lease_owner, lease_expires_at: iso(s.lease_expires_at), lease_live: Boolean(s.lease_live), running_live: s.status === "running" && Boolean(s.lease_live),
      latest_progress: p ? { phase: String(p.payload.phase), done: Number(p.payload.done), total: p.payload.total === null || p.payload.total === undefined ? null : Number(p.payload.total), unit: String(p.payload.unit), at: iso(p.created_at)!, reported_by: "worker", via: p.payload.via ?? null } : null,
      progress_records: nProgress.get(String(s.id)) ?? 0,
    };
  };
  const stepsOf = (key: string) => stepRows.filter((s) => s.step_key === key && (key !== SLITHER_STEP_KEY || s.scope === "repository_research"));
  const issuesFor = (keys: string[]): Issues => {
    const out = noIssues();
    const rows = stepRows.filter((s) => keys.includes(s.step_key));
    const byId = new Map(rows.map((s) => [String(s.id), s]));
    for (const f of failures.rows) {
      const s = byId.get(String(f.entity_id)); if (!s) continue;
      const shaped = shapeError({ message: String(f.payload?.reason ?? "") });
      out.errors.push({ step_key: s.step_key, attempt: typeof f.payload?.attempt === "number" ? f.payload.attempt : null, message: redactText(shaped.message), retryable: typeof f.payload?.retryable === "boolean" ? f.payload.retryable : null, at: iso(f.created_at), source: "audit_events workflow_step.failed" });
    }
    for (const s of rows) {
      if (s.status === "failed" && s.error && !out.errors.some((e) => e.step_key === s.step_key && e.attempt === s.attempt)) {
        const shaped = shapeError(s.error); out.errors.push({ step_key: s.step_key, attempt: s.attempt, message: redactText(shaped.message), retryable: shaped.retryable, at: iso(s.completed_at), source: "workflow_steps.error" });
      }
      if (s.attempt > 1) out.retries.push({ step_key: s.step_key, attempt: s.attempt });
      if (s.status === "running" && !s.lease_live) out.expired_leases.push({ step_key: s.step_key, lease_owner: s.lease_owner, lease_expired_at: iso(s.lease_expires_at) });
    }
    for (const e of exhausted.rows) if (byId.has(String(e.entity_id))) out.lease_exhausted += Number(e.n);
    for (const r of refusals.rows) {
      if (!r.step_id || !byId.has(String(r.step_id))) continue;
      out.refusals.total += Number(r.n); out.refusals.by_code[String(r.code)] = (out.refusals.by_code[String(r.code)] ?? 0) + Number(r.n);
      if (QUOTA_CODES.has(String(r.code))) out.refusals.quota += Number(r.n);
    }
    return out;
  };
  const runRefusalsWithoutStep = refusals.rows.filter((r) => !r.step_id || !ids.includes(String(r.step_id))).reduce((a, r) => a + Number(r.n), 0);
  const panel = (id: string, title: string, steps: StepActivity[], over: Partial<Panel> = {}): Panel => {
    const st = stepState(steps);
    return { id, title, state: st.state, state_basis: st.basis, availability: null, processing: [], coverage: [], counts: [], activity: steps, issues: issuesFor(steps.map((s) => s.step_key)), notes: [], ...over };
  };
  const out = (key: string) => stepsOf(key)[0]?.output as Row | null | undefined;
  const succeeded = (key: string) => stepsOf(key)[0]?.status === "succeeded";
  const derivedBasis = (key: string): MetricBasis => (out(key)?.derived_by === "api" ? "verified" : "worker_reported");

  // snapshot and its files
  const snap = (await pool.query<Row>("SELECT id, sealed_at, file_count, total_bytes, manifest_sha256, commit_sha FROM repo_snapshots WHERE workflow_run_id = $1 ORDER BY created_at DESC LIMIT 1", [runId])).rows[0] ?? null;
  const files = snap ? (await pool.query<Row>(
    `SELECT count(*)::int AS rows, count(*) FILTER (WHERE blob_sha256 IS NOT NULL)::int AS stored, count(*) FILTER (WHERE blob_sha256 IS NULL)::int AS skipped,
            count(*) FILTER (WHERE blob_sha256 IS NOT NULL AND path LIKE '%.sol')::int AS sol
     FROM repo_snapshot_files WHERE snapshot_id = $1`, [snap.id])).rows[0]! : null;
  let scope: BountyScope | null = null;
  try { scope = run.input?.bounty_scope ? parseBountyScope(run.input.bounty_scope) : null; } catch { scope = null; }

  const hyps = (await pool.query<Row>(
    `SELECT h.id, h.family, h.generator_id,
            (SELECT s.path FROM hypothesis_evidence he JOIN evidence_spans s ON s.id = he.span_id WHERE he.hypothesis_id = h.id
              ORDER BY (he.role = 'primary') DESC, he.role, s.path, s.line_start LIMIT 1) AS primary_path
     FROM hypotheses h WHERE h.workflow_run_id = $1`, [runId])).rows;
  const hypIds = hyps.map((h) => String(h.id));

  // ------------------------------------------------------------------------------------------------ 1. overall
  const all = stepRows.map(activity);
  const nSucceeded = stepRows.filter((s) => s.status === "succeeded").length;
  const current = all.find((s) => s.status === "running") ?? all.find((s) => s.status === "queued") ?? null;
  const overall = panel("overall", "Overall run", current ? [current] : [], {
    state: run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : current?.status === "running" ? (current.lease_live ? "running" : "stalled") : run.status === "queued" ? "not_started" : "recorded",
    state_basis: `run status ${run.status} (workflow_runs)${current ? `; current step ${current.step_key} (${current.status}${current.status === "running" ? current.lease_live ? ", live lease" : ", lease EXPIRED" : ""})` : ""}`,
    processing: [metric({ key: "stages_succeeded", label: "stages succeeded", numerator: nSucceeded, denominator: stepRows.length, unit: "stages", kind: "processing", source: "workflow_steps (status = succeeded) / workflow_steps of the run", basis: "verified",
      note: "the bar counts stages; stages differ in cost, so it does not estimate time (elapsed time per stage is listed)" })],
    issues: issuesFor(stepRows.map((s) => s.step_key)),
  });
  overall.issues.refusals.total += runRefusalsWithoutStep;
  // name the codes of refusals that cite no step of this run too, so the total always equals the sum of its listed codes
  for (const r of refusals.rows.filter((x) => !x.step_id || !ids.includes(String(x.step_id)))) {
    const code = String(r.code ?? "unknown"); overall.issues.refusals.by_code[code] = (overall.issues.refusals.by_code[code] ?? 0) + Number(r.n);
  }
  if (runRefusalsWithoutStep) overall.notes.push(`${runRefusalsWithoutStep} worker-API refusals name no step of this run (bad token, schema or foreign step)`);
  const stages = all.map((s) => ({ step_key: s.step_key, status: s.status, attempt: s.attempt, elapsed_seconds: s.elapsed_seconds, lease_live: s.lease_live, started_at: s.started_at, completed_at: s.completed_at }));

  // ------------------------------------------------------------------------------------------------ 2. programme discovery
  const discovery = panel("discovery", "Programme discovery", [], { state: "recorded", state_basis: "collector records (bounty_collection_runs, bounty_source_checks, bounty_programs)" });
  if (!hasBounty) Object.assign(discovery, { state: "unavailable", state_basis: "migration 0011 (bounty intelligence) is not applied", availability: { state: "unavailable", reason: "migration 0011 is not applied in this database", evidence: "to_regclass('public.bounty_collection_runs') is null" } });
  else {
    const [latestRun, enabled, programmes, link] = await Promise.all([
      pool.query<Row>("SELECT id, started_at, finished_at, status FROM bounty_collection_runs ORDER BY started_at DESC LIMIT 1"),
      pool.query<Row>("SELECT source_key, display_name, last_error, consecutive_failures, next_attempt_at, last_success_at FROM bounty_sources WHERE enabled ORDER BY source_key"),
      pool.query<Row>("SELECT resolved, verification FROM bounty_programs WHERE merged_into IS NULL"),
      hasLinks ? pool.query<Row>(`SELECT p.canonical_key, p.project_name, p.verification, l.repository, l.ref FROM bounty_research_links l JOIN bounty_programs p ON p.id = l.bounty_program_id WHERE l.workflow_run_id = $1`, [runId]) : Promise.resolve({ rows: [] as Row[] }),
    ]);
    const lr = latestRun.rows[0];
    const checks = lr ? (await pool.query<Row>("SELECT source_key, outcome, http_status, error, retry_after, finished_at FROM bounty_source_checks WHERE run_id = $1 ORDER BY source_key", [lr.id])).rows : [];
    const enabledKeys = new Set(enabled.rows.map((s) => String(s.source_key)));
    const checked = checks.filter((c) => enabledKeys.has(String(c.source_key)) && ["fetched", "empty", "unchanged"].includes(String(c.outcome))).length;
    discovery.processing.push(lr
      ? metric({ key: "sources_checked", label: "enabled sources checked successfully in the latest collection", numerator: checked, denominator: enabled.rows.length, unit: "sources", kind: "processing", source: `bounty_source_checks of collection ${lr.id} (outcome fetched/empty/unchanged) / bounty_sources (enabled)`, basis: "verified" })
      : count("sources_checked", "no collection has been recorded", null, "sources", "processing", "bounty_collection_runs (empty)", "verified"));
    const eligible = programmes.rows.filter((p) => { try { return classifyEligibility({ resolved: p.resolved ?? {}, verification: p.verification } as Resolution).tier === "eligible"; } catch { return false; } }).length;
    discovery.counts.push(metric({ key: "eligible_programmes", label: "eligible programmes of programmes collected (an outcome ratio)", numerator: eligible, denominator: programmes.rows.length, unit: "programmes", kind: "outcome", source: "bounty_programs (merged_into IS NULL), classified by bounties/eligibility.ts", basis: "verified" }));
    for (const c of checks.filter((x) => x.outcome === "failed")) discovery.issues.errors.push({ step_key: `source:${c.source_key}`, attempt: null, message: `${c.source_key}: ${redactText(shapeError({ message: String(c.error ?? "failed") }).message)}${c.http_status ? ` (HTTP ${c.http_status})` : ""}${c.retry_after ? `; next due ${iso(c.retry_after)}` : ""}`, retryable: null, at: iso(c.finished_at), source: "bounty_source_checks (outcome failed)" });
    for (const s of enabled.rows.filter((x) => Number(x.consecutive_failures) > 0)) discovery.issues.blockers.push({ text: `${s.display_name} (${s.source_key}): ${Number(s.consecutive_failures)} consecutive failures; last error ${redactText(shapeError({ message: String(s.last_error ?? "") }).message)}; next attempt ${iso(s.next_attempt_at) ?? "not scheduled"}`, source: "bounty_sources" });
    if (lr) discovery.notes.push(`latest collection ${lr.id}: ${lr.status}, started ${iso(lr.started_at)}${lr.finished_at ? `, finished ${iso(lr.finished_at)}` : ", not finished"}`);
    const l = link.rows[0];
    discovery.notes.push(l ? `this run is linked to programme ${l.canonical_key} (${l.project_name}, ${l.verification}) for ${l.repository} at ${l.ref ?? "the default branch"} (bounty_research_links)` : "this run is not linked to a programme (no bounty_research_links row)");
  }

  // ------------------------------------------------------------------------------------------------ 3. acquisition and verification
  const acq = stepsOf(ACQUIRE_STEP_KEY).map(activity);
  const acquisition = panel("acquisition", "Repository acquisition and verification", acq);
  const ap = acq[0]?.latest_progress;
  if (acq[0]?.status === "running") {
    if (!ap || ap.total === null) acquisition.processing.push(count("files_planned", ap ? `${ap.phase.replace(/_/g, " ")}: total not yet known` : "resolving commit: no progress reported yet", ap?.done ?? null, ap?.unit ?? "files", "processing", "audit_events workflow_step.progress", "worker_reported", "before the plan exists the number of files is unknown"));
    else acquisition.processing.push(metric({ key: "progress", label: `${ap.phase.replace(/_/g, " ")} (latest progress report)`, numerator: ap.done, denominator: ap.total, unit: ap.unit, kind: "processing", source: `audit_events ${PROGRESS_ACTION} at ${ap.at}`, basis: "worker_reported" }));
  }
  if (snap && files) {
    acquisition.processing.push(metric({ key: "files_stored", label: "manifest rows with stored content", numerator: files.stored, denominator: files.rows, unit: "files", kind: "processing", source: `repo_snapshot_files of snapshot ${snap.id} (blob_sha256 not null) / manifest rows`, basis: "verified",
      note: `${files.skipped} rows are recorded skips (binary, size, policy, submodule, symlink...), listed by reason in the step output` }));
    const o = out(ACQUIRE_STEP_KEY);
    if (o?.skipped_by_reason) acquisition.notes.push(`skipped by reason (step output): ${Object.entries(o.skipped_by_reason as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
    if (snap.sealed_at) acquisition.notes.push(`snapshot ${snap.id} sealed at ${iso(snap.sealed_at)}, commit ${snap.commit_sha}, manifest ${snap.manifest_sha256}`);
    else acquisition.notes.push(`snapshot ${snap.id} is building (not sealed)`);
    if (o && typeof o.file_count === "number" && o.file_count !== files.rows) acquisition.issues.blockers.push({ text: `the step output records ${o.file_count} files but the manifest holds ${files.rows} rows`, source: "workflow_steps.output vs repo_snapshot_files" });
  } else if (!acq.length) acquisition.notes.push("this run has no acquisition step");
  const v = snap && hasVerifications ? (await pool.query<Row>("SELECT files_total, files_matched, skips_verified, skips_unverified, completeness, resolved_commit, tree_sha, verified_at FROM snapshot_verifications WHERE snapshot_id = $1", [snap.id])).rows[0] : undefined;
  if (v) {
    acquisition.coverage.push(metric({ key: "d2_files_verified", label: "files verified by the API against the GitHub tree (D2)", numerator: v.files_matched + v.skips_verified, denominator: v.files_total, unit: "files", kind: "coverage", source: `snapshot_verifications (files_matched ${v.files_matched} + skips_verified ${v.skips_verified}) / files_total`, basis: "verified",
      note: `resolved commit ${v.resolved_commit}, tree ${v.tree_sha}, ${v.skips_unverified} content skips not verifiable, completeness ${v.completeness}, verified at ${iso(v.verified_at)}` }));
  } else {
    acquisition.coverage.push(count("d2_files_verified", "files verified by the API against the GitHub tree (D2)", null, "files", "coverage", hasVerifications ? "snapshot_verifications (no row for this snapshot)" : "snapshot_verifications (migration 0015 not applied)", "verified",
      snap ? "not recorded: this snapshot was not verified by the API against GitHub (a direct-worker snapshot has no D2 verification); the content is worker-reported" : "no snapshot yet"));
  }

  // ------------------------------------------------------------------------------------------------ 4. scope verification
  const scopePanel = panel("scope", "Scope verification", [], { state: scope ? "recorded" : "not_in_run", state_basis: scope ? `official scope ${scope.programme} recorded on the run (workflow_runs.input.bounty_scope)` : "this run carries no bounty scope (workflow_runs.input.bounty_scope is absent)" });
  if (scope) {
    const present = snap ? (await pool.query<Row>("SELECT path, blob_sha256 IS NOT NULL AS stored, skip_reason FROM repo_snapshot_files WHERE snapshot_id = $1 AND path = ANY($2::text[])", [snap.id, scope.in_scope_paths])).rows : [];
    const found = new Map(present.map((r) => [String(r.path), r]));
    const stored = present.filter((r) => r.stored).length;
    scopePanel.processing.push(snap
      ? metric({ key: "scope_paths_found", label: "in-scope paths stored in the snapshot", numerator: stored, denominator: scope.in_scope_paths.length, unit: "paths", kind: "processing", source: "repo_snapshot_files (path in bounty_scope.in_scope_paths, content stored) / bounty_scope.in_scope_paths", basis: "verified" })
      : count("scope_paths_found", "in-scope paths (no snapshot yet)", null, "paths", "processing", "workflow_runs.input.bounty_scope", "verified", `${scope.in_scope_paths.length} in-scope paths in the official scope`));
    if (snap) for (const p of scope.in_scope_paths.filter((x) => !found.get(x)?.stored).slice(0, 50)) scopePanel.issues.blockers.push({ text: found.has(p) ? `in-scope path ${p} is in the manifest but its content was skipped (${found.get(p)!.skip_reason})` : `in-scope path ${p} is missing from the snapshot`, source: "repo_snapshot_files vs bounty_scope" });
    const leadsIn = hyps.filter((h) => h.primary_path && scope!.in_scope_paths.includes(String(h.primary_path))).length;
    scopePanel.coverage.push(metric({ key: "leads_in_scope", label: "leads whose primary location is in scope", numerator: leadsIn, denominator: hyps.length, unit: "leads", kind: "coverage", source: "hypotheses of the run, primary evidence span path vs bounty_scope.in_scope_paths (the dossier's rule)", basis: "verified",
      ...(hyps.length ? {} : { note: "no leads yet" }) }));
    scopePanel.notes.push(`evidence ${scope.evidence} (sha256 ${scope.evidence_sha256.slice(0, 12)}…); the whole repository is analysed, only in-scope leads can be eligible findings`);
  }

  // ------------------------------------------------------------------------------------------------ 5. protocol analysis
  const ana = stepsOf(ANALYZE_STEP_KEY).map(activity);
  const analysis = panel("protocol_analysis", "Protocol analysis", ana);
  const ao = out(ANALYZE_STEP_KEY);
  if (ana[0]?.status === "running" && ana[0].latest_progress) {
    const p = ana[0].latest_progress;
    analysis.processing.push(p.total === null || p.total === 0 ? count("progress", p.phase.replace(/_/g, " "), p.done, p.unit, "processing", `audit_events ${PROGRESS_ACTION} at ${p.at}`, "worker_reported", "no total reported")
      : metric({ key: "progress", label: `${p.phase.replace(/_/g, " ")} (latest progress report)`, numerator: p.done, denominator: p.total, unit: p.unit, kind: "processing", source: `audit_events ${PROGRESS_ACTION} at ${p.at}`, basis: "worker_reported" }));
  }
  if (succeeded(ANALYZE_STEP_KEY) && ao) {
    const basis = derivedBasis(ANALYZE_STEP_KEY);
    const problems = Array.isArray(ao.problems) ? ao.problems.map(String) : [];
    const problemFiles = new Set(problems.map((p: string) => /^(.*?\.sol): /.exec(p)?.[1]).filter(Boolean) as string[]);
    let model: { inputs: Array<{ file: string }>; callEdges: Array<{ kind: string }>; unknowns: unknown[]; components: unknown[]; functions: unknown[] } | null = null;
    if (typeof ao.protocol_model_sha256 === "string") {
      const blob = (await pool.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [ao.protocol_model_sha256])).rows[0];
      if (blob && createHash("sha256").update(blob.content).digest("hex") === ao.protocol_model_sha256) { try { model = JSON.parse(blob.content.toString("utf8")); } catch { model = null; } }
    }
    const solDenominator = files?.sol ?? null;
    if (model) {
      const parsed = model.inputs.filter((i) => !problemFiles.has(i.file));
      analysis.processing.push(metric({ key: "sol_files_parsed", label: "Solidity files read by the analyzer without a recorded parse problem", numerator: parsed.length, denominator: solDenominator, unit: "files", kind: "processing", source: `protocol model ${String(ao.protocol_model_sha256).slice(0, 12)}… inputs minus files named in analyze_structure.output.problems / Solidity files stored in the snapshot`, basis,
        note: "parsed is not understood: this counts files the parser read, not what was established about them" }));
      if (scope) {
        const inScopeSol = scope.in_scope_paths.filter((p) => p.endsWith(".sol"));
        analysis.coverage.push(metric({ key: "in_scope_sol_parsed", label: "in-scope Solidity files read without a parse problem", numerator: parsed.filter((i) => inScopeSol.includes(i.file)).length, denominator: inScopeSol.length, unit: "files", kind: "coverage", source: "protocol model inputs vs bounty_scope.in_scope_paths (.sol)", basis }));
      }
      analysis.counts.push(count("unresolved_calls", "unresolved calls (e.g. into code outside the snapshot)", model.callEdges.filter((e) => e.kind === "unresolved").length, "call edges", "coverage", "protocol model callEdges (kind unresolved)", basis, "shown next to the bar: these paths were not analysed"));
      analysis.counts.push(count("not_modelled", "things not modelled", model.unknowns.length, "items", "coverage", "protocol model unknowns", basis));
    } else {
      analysis.processing.push(count("sol_files_parsed", "Solidity files parsed", null, "files", "processing", "protocol model (not stored or not readable)", basis, ao.protocol_model_stored === false ? "the protocol model was too large to store, so per-file parsing is not measurable" : "no protocol model is recorded for this analysis"));
    }
    analysis.counts.push(count("contracts", "contracts modelled", typeof ao.contracts === "number" ? ao.contracts : null, "contracts", "processing", "analyze_structure.output.contracts", basis));
    analysis.counts.push(count("functions", "functions modelled", typeof ao.functions === "number" ? ao.functions : null, "functions", "processing", "analyze_structure.output.functions", basis));
    analysis.counts.push(count("leads_generated", "leads generated by the structural specialists", typeof ao.hypotheses === "number" ? ao.hypotheses : null, "leads", "outcome", "analyze_structure.output.hypotheses", basis));
    for (const p of problems.slice(0, 30)) analysis.issues.blockers.push({ text: `parser problem: ${redactText(p).slice(0, 300)}`, source: "analyze_structure.output.problems" });
    analysis.notes.push(basis === "verified" ? "analysis derived by the API on the sealed snapshot (D3)" : "analysis output written by the direct worker (worker-reported)");
  }

  // ------------------------------------------------------------------------------------------------ 6. APEX
  const apexSteps = stepRows.filter((s) => /^apex/i.test(String(s.step_key)));
  const apex = panel("apex", "APEX exploration", [], {
    state: "experimental", state_basis: "APEX is not an assignable stage of repository_research",
    availability: { state: "experimental", reason: "experimental, off by default, not in the pipeline: only prototypes under apps/api/src/apex/testing exist; no capability declaration and no step key", evidence: `capability registry: ${CAPABILITIES.some((c) => /apex/i.test(c.id)) ? "declared" : "no APEX capability"}; workflow_steps of this run with an apex step key: ${apexSteps.length}` },
    notes: ["nothing else is shown until APEX is an assignable stage; then: regions explored / regions selected, abstentions and suppressions"],
  });

  // ------------------------------------------------------------------------------------------------ 7. specialist and tool execution
  const avail = availability(env);
  const av = (id: string) => avail.find((a) => a.capability.id === id)!;
  const sl = stepsOf(SLITHER_STEP_KEY).map(activity);
  const slOut = out(SLITHER_STEP_KEY);
  const capRow = (a: Availability, inRun: boolean, state: string, reason: string, source: string) => ({ id: a.capability.id, version: a.capability.version, kind: a.capability.kind, classes: a.capability.classes, in_run: inRun, state, reason, source, environment: a.available ? "available" : a.reason });
  const capabilities = [
    capRow(av("solidity-structural-specialists"), ana.length > 0, ana.length === 0 ? "not_in_run" : succeeded(ANALYZE_STEP_KEY) ? "completed" : ana[0]!.status, succeeded(ANALYZE_STEP_KEY) ? `${ao?.hypotheses ?? "?"} leads recorded` : `step ${ana[0]?.status ?? "absent"}`, "analyze_structure step"),
    capRow(av("slither"), sl.length > 0, sl.length === 0 ? (av("slither").available ? "not_in_run" : "unavailable") : slOut?.status === "tool_completed" ? "completed" : slOut?.status === "abstained" ? "abstained" : sl[0]!.status,
      sl.length === 0 ? (av("slither").available ? "the run was created without the Slither stage" : `unavailable: ${av("slither").reason}`) : slOut?.status === "abstained" ? `abstained (${slOut.abstention?.code})` : `step ${sl[0]!.status}`, sl.length ? "slither_scan step (worker-reported)" : "capability availability (API process environment)"),
    capRow(av("agentsmith-execution-validators"), stepsOf(CHALLENGE_STEP_KEY).length > 0, stepsOf(CHALLENGE_STEP_KEY).length === 0 ? "not_in_run" : succeeded(CHALLENGE_STEP_KEY) ? "completed" : stepsOf(CHALLENGE_STEP_KEY)[0]!.status, succeeded(CHALLENGE_STEP_KEY) ? `${out(CHALLENGE_STEP_KEY)?.leads ?? "?"} leads challenged` : "", "challenge_leads step"),
    capRow(av("foundry-forge"), false, av("foundry-forge").available ? "not_in_run" : "unavailable", av("foundry-forge").available ? "not a stage of repository_research" : `unavailable: ${av("foundry-forge").reason}`, "capability availability (API process environment)"),
  ];
  const tools = panel("tools", "Specialist and tool execution", sl, { state: sl.length ? stepState(sl).state : (succeeded(ANALYZE_STEP_KEY) ? "succeeded" : stepState(ana).state), state_basis: sl.length ? stepState(sl).basis : "no tool stage in this run; the structural specialists ran in the analysis stage" });
  const examined = new Set<string>();
  for (const c of capabilities) if (c.state === "completed" && (c.kind === "producer" || c.kind === "mapper")) for (const k of c.classes) examined.add(k);
  tools.coverage.push(metric({ key: "classes_examined", label: "lead classes examined by a producer that completed in this run", numerator: [...examined].filter((k) => TRACKED_CLASSES.includes(k)).length, denominator: TRACKED_CLASSES.length, unit: "classes", kind: "coverage", source: "capability declarations (engine/capabilities.ts) of producers whose stage succeeded / TRACKED_CLASSES", basis: "verified",
    note: "a class examined is not a class cleared: no lead means only that the patterns did not match" }));
  if (slOut?.status === "abstained") tools.issues.abstentions.push({ code: String(slOut.abstention?.code ?? "unknown"), detail: redactText(String(slOut.abstention?.detail ?? "")).slice(0, 300), source: "slither_scan.output.abstention (worker-reported)" });
  tools.capabilities = capabilities;

  // ------------------------------------------------------------------------------------------------ 8. independent validation
  const ch = stepsOf(CHALLENGE_STEP_KEY).map(activity);
  const validation = panel("validation", "Independent validation", ch);
  if (ch[0]?.status === "running" && ch[0].latest_progress) {
    const p = ch[0].latest_progress;
    validation.processing.push(p.total === null || p.total === 0 ? count("progress", p.phase.replace(/_/g, " "), p.done, p.unit, "processing", `audit_events ${PROGRESS_ACTION} at ${p.at}`, "worker_reported") : metric({ key: "progress", label: `${p.phase.replace(/_/g, " ")} (latest progress report)`, numerator: p.done, denominator: p.total, unit: p.unit, kind: "processing", source: `audit_events ${PROGRESS_ACTION} at ${p.at}`, basis: "worker_reported" }));
  }
  const evalRows = hypIds.length ? (await pool.query<Row>(
    `SELECT e.hypothesis_id, e.evaluator_id, ${hasProvenance ? "p.recorded_by" : "NULL::text AS recorded_by"}, ${hasIndependence ? "x.relation, x.evaluator_family" : "NULL::text AS relation, NULL::text AS evaluator_family"}
     FROM hypothesis_evaluations e ${hasProvenance ? "LEFT JOIN evaluation_provenance p ON p.evaluation_id = e.id" : ""} ${hasIndependence ? "LEFT JOIN evaluation_independence x ON x.evaluation_id = e.id" : ""}
     WHERE e.hypothesis_id = ANY($1::uuid[])`, [hypIds])).rows : [];
  const withAny = new Set(evalRows.map((e) => String(e.hypothesis_id)));
  const withApi = new Set(evalRows.filter((e) => e.recorded_by === "api").map((e) => String(e.hypothesis_id)));
  const isAbstention = (e: Row) => e.relation === "abstention" || e.evaluator_id === "no-independent-validator";
  const withValidator = new Set(evalRows.filter((e) => !isAbstention(e)).map((e) => String(e.hypothesis_id)));
  validation.processing.push(metric({ key: "evaluated_by_api", label: "hypotheses with an evaluation the API ran and recorded (D1)", numerator: withApi.size, denominator: hyps.length, unit: "hypotheses", kind: "processing", source: "evaluation_provenance (recorded_by = api) / hypotheses of the run", basis: "verified", ...(hyps.length ? {} : { note: "no hypotheses stored" }) }));
  validation.processing.push(metric({ key: "evaluated_any", label: "hypotheses with any recorded evaluation (direct-worker evaluations included)", numerator: withAny.size, denominator: hyps.length, unit: "hypotheses", kind: "processing", source: "hypothesis_evaluations / hypotheses of the run", basis: withAny.size === withApi.size ? "verified" : "worker_reported" }));
  validation.coverage.push(metric({ key: "with_independent_validator", label: "hypotheses evaluated by a validator (not the no-independent-validator abstention)", numerator: withValidator.size, denominator: hyps.length, unit: "hypotheses", kind: "coverage", source: `hypothesis_evaluations${hasIndependence ? " joined to evaluation_independence (relation <> abstention)" : " (evaluator_id <> no-independent-validator)"}`, basis: "verified" }));
  validation.counts.push(count("not_validated", "NOT validated (no independent validator, or not evaluated)", hyps.length - withValidator.size, "hypotheses", "coverage", "hypotheses minus those with a validator evaluation", "verified", "'no-independent-validator' is shown as not validated, never as done"));
  const abst = evalRows.filter(isAbstention).length;
  if (abst) validation.issues.abstentions.push({ code: "no-independent-validator", detail: `${abst} evaluations record that no independent validator exists for the lead's class`, source: "hypothesis_evaluations" });

  // ------------------------------------------------------------------------------------------------ 9. reproduction
  const forge = av("foundry-forge");
  const repro = evalRows.filter((e) => e.evaluator_family === "evm-execution" || e.evaluator_id === "foundry-forge");
  const reproduction = panel("reproduction", "Reproduction", [], {
    state: forge.available ? "recorded" : "unavailable", state_basis: forge.available ? "foundry-forge is available in the API process environment" : `Foundry unavailable here: ${forge.reason}`,
    availability: forge.available ? { state: "available", reason: "pinned forge and solc configured", evidence: "capability availability (API process environment)" } : { state: "unavailable", reason: forge.reason, evidence: "capability availability (engine/capabilities.ts, API process environment)" },
    counts: [count("reproductions", "reproductions recorded (evm-execution evaluations)", new Set(repro.map((e) => String(e.hypothesis_id))).size, "hypotheses", "processing", "hypothesis_evaluations by evm-execution-family evaluators", "verified",
      "not measurable as a ratio: no record defines which hypotheses are eligible for reproduction")],
    notes: forge.available ? [] : ["shown as unavailable, not 0%: nothing can be reproduced where Foundry is not installed"],
  });

  // ------------------------------------------------------------------------------------------------ 10. evidence and dossier
  const ds = stepsOf(DOSSIER_STEP_KEY).map(activity);
  const evidence = panel("evidence", "Evidence and dossier", ds);
  if (ds.length) evidence.processing.push(metric({ key: "dossier_built", label: "dossier built", numerator: succeeded(DOSSIER_STEP_KEY) ? 1 : 0, denominator: 1, unit: "dossiers", kind: "processing", source: `build_dossier step status${out(DOSSIER_STEP_KEY)?.derived_by === "api" ? " (dossier derived by the API)" : succeeded(DOSSIER_STEP_KEY) ? " (dossier written by the worker)" : ""}`, basis: "verified" }));
  const spanIds = hypIds.length ? (await pool.query<{ id: string }>(
    `SELECT DISTINCT span_id AS id FROM (SELECT span_id FROM hypothesis_evidence WHERE hypothesis_id = ANY($1::uuid[])
       UNION SELECT ee.span_id FROM evaluation_evidence ee JOIN hypothesis_evaluations e ON e.id = ee.evaluation_id WHERE e.hypothesis_id = ANY($1::uuid[])) x LIMIT 5001`, [hypIds])).rows.map((r) => r.id) : [];
  const store = new ResearchStore(pool);
  if (spanIds.length > 5000) evidence.processing.push(count("spans_reverified", "cited spans re-verified", null, "spans", "processing", "evidence_spans", "verified", "more than 5000 cited spans: not re-verified on every refresh"));
  else {
    let ok = 0; for (const id of spanIds) if (await store.verifySpan(id).then((x) => x === "ok").catch(() => false)) ok += 1;
    evidence.processing.push(metric({ key: "spans_reverified", label: "cited spans re-verified now (hash of the stored blob and excerpt)", numerator: ok, denominator: spanIds.length, unit: "spans", kind: "processing", source: "ResearchStore.verifySpan over spans cited by the run's hypotheses and evaluations", basis: "verified", ...(spanIds.length ? {} : { note: "no spans are cited" }) }));
    if (ok < spanIds.length) evidence.issues.blockers.push({ text: `${spanIds.length - ok} cited spans do not verify`, source: "ResearchStore.verifySpan" });
  }
  let dossier: Dossier | null = null; let dossierProblem: string | null = null;
  if (snap?.sealed_at) { try { dossier = await buildDossier(pool, store, snap.id); } catch { dossierProblem = "the dossier cannot be built now: a cited span could not be verified (fails closed)"; } }
  else dossierProblem = snap ? "the snapshot is not sealed yet" : "no snapshot yet";
  if (dossier) {
    evidence.notes.push(`dossier coverage status: ${dossier.coverage.status} (${dossier.coverage.solidity_files} Solidity files${dossier.coverage.problems.length ? `, ${dossier.coverage.problems.length} problems` : ""})`);
    const stored = out(DOSSIER_STEP_KEY)?.content_sha256;
    if (stored) {
      if (stored === dossier.content_sha256) evidence.notes.push(`rebuilt dossier content hash matches the stored one (${String(stored).slice(0, 12)}…)`);
      else evidence.issues.blockers.push({ text: `the dossier rebuilt now (${dossier.content_sha256.slice(0, 12)}…) differs from the stored build (${String(stored).slice(0, 12)}…): records changed after the dossier step`, source: "build_dossier.output.content_sha256" });
    }
    evidence.notes.push(`provenance: snapshot ${dossier.provenance.snapshot.status}; analysis ${dossier.provenance.analysis}; challenge ${dossier.provenance.challenge}; external tools ${dossier.provenance.external_tools}`);
  } else if (dossierProblem) evidence.notes.push(dossierProblem);

  // ------------------------------------------------------------------------------------------------ confidence and outcome
  const verdicts = ["refuted", "weakened", "open", "supported_unknown_family", "corroborated_same_family", "supported_cross_family", "reviewed", "withdrawn"] as const;
  const dist: Record<string, number> = Object.fromEntries(verdicts.map((x) => [x, 0]));
  for (const e of dossier?.entries ?? []) dist[e.assessment.verdict] = (dist[e.assessment.verdict] ?? 0) + 1;
  const entries = dossier?.entries ?? [];
  const confidence = dossier ? {
    available: true, kind: "confidence" as const, source: "dossier entries' assessment.verdict, rebuilt from stored evaluations (latest per evaluator)",
    total: entries.length, distribution: verdicts.map((k) => ({ verdict: k, count: dist[k] ?? 0 })),
    corroboration: {
      same_family: count("same_family", "leads corroborated within the generator's own analysis family", entries.filter((e) => e.corroboration.same_family > 0).length, "leads", "confidence", "dossier corroboration.same_family > 0", "verified", "same substrate: NOT independent"),
      cross_family: count("cross_family", "leads supported by another analysis family", entries.filter((e) => e.corroboration.cross_family > 0).length, "leads", "confidence", "dossier corroboration.cross_family > 0", "verified", "independent support, still NOT confirmation"),
    },
    note: "a distribution, never a single percentage",
  } : { available: false, reason: dossierProblem ?? "no dossier" };
  const openish = (dist.open ?? 0) + (dist.supported_unknown_family ?? 0) + (dist.corroborated_same_family ?? 0) + (dist.supported_cross_family ?? 0);
  const outcome = dossier ? {
    available: true, kind: "outcome" as const,
    counts: [
      count("confirmed", "confirmed", 0, "leads", "outcome", "no record can confirm a lead: confirmation needs a human outcome, which no API records", "verified"),
      count("open", "open (including supported or corroborated, not decided)", openish, "leads", "outcome", "dossier assessment verdicts open, supported_*, corroborated_same_family", "verified"),
      count("weakened", "weakened", dist.weakened ?? 0, "leads", "outcome", "dossier assessment verdict weakened", "verified"),
      count("refuted", "refuted (in the modelled world)", dist.refuted ?? 0, "leads", "outcome", "dossier assessment verdict refuted", "verified"),
      ...(dist.reviewed || dist.withdrawn ? [count("reviewed_or_withdrawn", "reviewed or withdrawn", (dist.reviewed ?? 0) + (dist.withdrawn ?? 0), "leads", "outcome", "dossier assessment verdicts reviewed, withdrawn", "verified")] : []),
    ],
    no_leads: entries.length === 0,
    note: entries.length === 0 ? "No leads. That is NOT evidence that the code is free of vulnerabilities." : "0 confirmed is the true count: nothing here is confirmed without a human outcome.",
  } : { available: false, reason: dossierProblem ?? "no dossier" };

  return {
    version: "run-progress/1", generated_at: iso(run.now),
    run: { id: run.id, workflow_type: run.workflow_type, status: run.status, repository: run.input?.value ?? null, ref: run.input?.ref ?? null, created_at: iso(run.created_at), started_at: iso(run.started_at), completed_at: iso(run.completed_at),
      snapshot_id: snap?.id ?? null, bounty_scope: scope ? { programme: scope.programme, in_scope_paths: scope.in_scope_paths.length } : null },
    stages,
    panels: [overall, discovery, acquisition, scopePanel, analysis, apex, tools, validation, reproduction, evidence],
    confidence, outcome,
    legend: {
      kinds: { processing: "how much of the planned work has been done (processed, never 'understood')", coverage: "how much of what should be examined was examined", confidence: "how strongly the evidence supports each lead: a distribution", outcome: "what research found: counts only" },
      basis: { verified: "counted by the API from its own records (D2/D3 where stated)", worker_reported: "reported by the worker and taken as reported" },
      measurable: "false when the denominator (or the count) is not recorded: no percentage is shown",
    },
  };
}
function iso(v: unknown): string | null { if (v === null || v === undefined) return null; const d = v instanceof Date ? v : new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }

// ------------------------------------------------------------------------------------------------------------------------- timeline
export async function runTimeline(pool: Pool, q: { run?: string; limit: number; before?: string; beforeId?: string }): Promise<Record<string, unknown>> {
  const hasDecisions = await exists(pool, "research_decisions");
  const hasIndependence = await exists(pool, "evaluation_independence");
  const rows = (await pool.query<Row>(
    `SELECT * FROM (
       SELECT 'audit:' || lpad(a.id::text, 12, '0') AS id, a.created_at AS at, to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_cursor,
              'audit_event' AS source, a.action, a.actor, a.entity_type, a.entity_id, ws.step_key, CASE a.entity_type WHEN 'workflow_step' THEN a.entity_id END AS step_id,
              a.reason, a.payload, NULL::uuid AS hypothesis_id,
              CASE a.entity_type WHEN 'workflow_run' THEN a.entity_id ELSE ws.workflow_run_id::text END AS run_id
       FROM audit_events a LEFT JOIN workflow_steps ws ON a.entity_type = 'workflow_step' AND ws.id::text = a.entity_id
       WHERE ($1::uuid IS NULL OR (a.entity_type = 'workflow_run' AND a.entity_id = $1::text) OR (a.entity_type = 'workflow_step' AND ws.workflow_run_id = $1::uuid))
       UNION ALL
       SELECT 'research:' || lpad(e.seq::text, 12, '0'), e.created_at, to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'hypothesis_event', 'hypothesis.' || e.event_type, e.actor_kind || ':' || e.actor_id, 'hypothesis', e.hypothesis_id::text, NULL, NULL,
              e.reason,
              jsonb_strip_nulls(jsonb_build_object('event_type', e.event_type, 'hypothesis_id', e.hypothesis_id, 'family', h.family, 'generator', h.generator_id,
                'evaluation', CASE WHEN ev.id IS NULL THEN NULL ELSE jsonb_build_object('evaluation_id', ev.id, 'evaluator', ev.evaluator_id, 'evaluator_version', ev.evaluator_version, 'outcome', ev.outcome${hasIndependence ? ", 'evaluator_family', x.evaluator_family, 'relation', x.relation" : ""}) END,
                'review', CASE WHEN rv.id IS NULL THEN NULL ELSE jsonb_build_object('review_id', rv.id, 'review_mode', rv.review_mode, 'verdict', rv.verdict, 'reviewer_kind', rv.reviewer_kind) END)),
              e.hypothesis_id, e.workflow_run_id::text
       FROM hypothesis_events e JOIN hypotheses h ON h.id = e.hypothesis_id
       LEFT JOIN hypothesis_evaluations ev ON ev.id = e.evaluation_id ${hasIndependence ? "LEFT JOIN evaluation_independence x ON x.evaluation_id = ev.id" : ""}
       LEFT JOIN hypothesis_reviews rv ON rv.id = e.review_id
       WHERE ($1::uuid IS NULL OR e.workflow_run_id = $1::uuid)
     ) t
     WHERE ($2::timestamptz IS NULL OR (t.at, t.id) < ($2::timestamptz, $3::text))
     ORDER BY t.at DESC, t.id DESC LIMIT $4`, [q.run ?? null, q.before ?? null, q.beforeId ?? "￿", q.limit + 1])).rows;
  const items = rows.slice(0, q.limit).map((r) => {
    const action = String(r.action);
    const category = action === PROGRESS_ACTION ? "progress" : action.startsWith("workflow_step.") ? "step_lifecycle" : action.startsWith("worker_api.") ? "worker_api" : action.startsWith("worker_token.") ? "worker_token" : action.startsWith("hypothesis.") ? "hypothesis" : action.startsWith("repository_research.") ? "run" : "other";
    const p = (r.payload ?? {}) as Row;
    const summary = category === "progress" ? `${p.phase}: ${p.done}${p.total === null || p.total === undefined ? "" : ` of ${p.total}`} ${p.unit} (reported by the worker)`
      : category === "worker_api" ? `${p.operation ?? "?"} ${p.outcome ?? ""}${p.code && p.code !== "ok" ? ` (${p.code}, HTTP ${p.http_status})` : ""}`
      : category === "hypothesis" ? `${p.event_type}${p.evaluation ? `: ${p.evaluation.evaluator} → ${p.evaluation.outcome}${p.evaluation.relation ? ` (${p.evaluation.relation})` : ""}` : ""}${p.review ? `: ${p.review.review_mode} ${p.review.verdict}` : ""}`
      : category === "step_lifecycle" ? `${action.slice("workflow_step.".length)}${typeof p.attempt === "number" ? ` (attempt ${p.attempt})` : ""}`
      : action;
    return { id: r.id, at: iso(r.at), source: r.source, category, action, actor: redactText(String(r.actor)).slice(0, 120), step_key: r.step_key ?? null, step_id: r.step_id ?? null, hypothesis_id: r.hypothesis_id ?? null, run_id: r.run_id ?? null,
      summary: redactText(summary).slice(0, 300), reason: r.reason ? redactText(String(r.reason)).slice(0, 500) : null, payload: cappedPayload(p) };
  });
  const last = rows.slice(0, q.limit).at(-1);
  const now = (await pool.query<{ at: Date }>("SELECT now() AS at")).rows[0]!.at;
  return {
    version: "run-timeline/1", generated_at: iso(now), items, limit: q.limit, has_more: rows.length > q.limit,
    next: rows.length > q.limit && last ? { before: last.at_cursor, before_id: last.id } : null,
    decisions: hasDecisions ? { available: true, note: "engine-loop decisions are recorded (research_decisions); they are not merged into this timeline yet" } : { available: false, note: "engine-loop decisions are not recorded in this database: migration 0010 (research_decisions) is not applied, so none can appear here" },
    sources: ["audit_events (run created, step claimed/succeeded/failed/lease_exhausted, worker_api.accepted/refused/replayed, workflow_step.progress)", "hypothesis_events (registered, evaluation_recorded, review_recorded)"],
  };
}

// ------------------------------------------------------------------------------------------------------------------------- system view
export async function systemComponents(pool: Pool, opts: { env?: Record<string, string | undefined>; workerApiEnabled: boolean; githubVerifierConfigured: boolean | null }): Promise<Record<string, unknown>> {
  const env = opts.env ?? process.env;
  const q = (sql: string, params: unknown[] = []) => pool.query<Row>(sql, params).then((r) => r.rows);
  const [[now]] = await Promise.all([q("SELECT now() AS at")]);
  const has = async (t: string) => exists(pool, t);
  const [hasBounty, hasVerif, hasWorkerApi, hasDiscovery, hasDecisions, hasIndependence] = await Promise.all(["bounty_collection_runs", "snapshot_verifications", "worker_capability_tokens", "discovery_sources", "research_decisions", "evaluation_independence"].map(has));
  const avail = availability(env);
  const av = (id: string) => avail.find((a) => a.capability.id === id)!;
  type Comp = { id: string; label: string; state: ComponentState; evidence: Array<{ source: string; detail: string; at?: string | null }> };
  const comps: Comp[] = [];
  const lastStep = async (key: string, extra = "") => (await q(`SELECT max(completed_at) FILTER (WHERE status = 'succeeded') AS ok_at, count(*) FILTER (WHERE status = 'succeeded')::int AS ok, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM workflow_steps WHERE step_key = $1 ${extra}`, [key]))[0]!;

  // programme collector, per source
  if (!hasBounty) comps.push({ id: "bounty_collector", label: "Programme collector", state: "unavailable", evidence: [{ source: "schema", detail: "migration 0011 (bounty intelligence) is not applied" }] });
  else {
    const runs = (await q("SELECT status, finished_at FROM bounty_collection_runs WHERE status IN ('succeeded','partial') ORDER BY finished_at DESC NULLS LAST LIMIT 1"))[0];
    comps.push({ id: "bounty_collector", label: "Programme collector", state: runs ? "operational" : "available", evidence: [{ source: "bounty_collection_runs", detail: runs ? `last ${runs.status} collection finished` : "no successful collection recorded", at: iso(runs?.finished_at) }] });
    for (const s of await q(`SELECT s.source_key, s.display_name, s.enabled, s.access_status, s.last_success_at, s.consecutive_failures, s.next_attempt_at, s.last_error,
         (SELECT c.outcome FROM bounty_source_checks c WHERE c.source_key = s.source_key ORDER BY c.started_at DESC LIMIT 1) AS last_outcome,
         (SELECT c.error FROM bounty_source_checks c WHERE c.source_key = s.source_key ORDER BY c.started_at DESC LIMIT 1) AS last_check_error
       FROM bounty_sources s ORDER BY s.source_key`)) {
      const failing = s.last_outcome === "failed" || Number(s.consecutive_failures) > 0;
      const state: ComponentState = !s.enabled ? "unavailable" : failing ? "blocked" : s.last_success_at ? "operational" : "available";
      comps.push({ id: `source:${s.source_key}`, label: `Source: ${s.display_name}`, state, evidence: [
        { source: "bounty_sources", detail: `${s.enabled ? "enabled" : "disabled"}; access ${s.access_status}; ${Number(s.consecutive_failures)} consecutive failures${s.next_attempt_at ? `; next attempt ${iso(s.next_attempt_at)}` : ""}`, at: iso(s.last_success_at) },
        ...(failing ? [{ source: "bounty_source_checks", detail: `last check ${s.last_outcome ?? "none"}: ${redactText(shapeError({ message: String(s.last_check_error ?? s.last_error ?? "") }).message)}` }] : []),
      ] });
    }
  }
  // GitHub access
  const gh = describeGitHubAuth(env as NodeJS.ProcessEnv);
  const lastVerification = hasVerif ? (await q("SELECT max(verified_at) AS at, count(*)::int AS n FROM snapshot_verifications"))[0]! : null;
  comps.push({ id: "github_verifier", label: "GitHub verification (D2)", state: !hasVerif ? "unavailable" : lastVerification && lastVerification.n > 0 ? "operational" : opts.githubVerifierConfigured === false ? "unavailable" : "available", evidence: [
    { source: "snapshot_verifications", detail: hasVerif ? `${lastVerification!.n} API verifications recorded` : "migration 0015 is not applied", at: iso(lastVerification?.at) },
    { source: "API process configuration", detail: opts.githubVerifierConfigured === null ? "worker API not registered in this API process" : opts.githubVerifierConfigured ? "a GitHub source is configured for verification" : "no GitHub source configured: worker-uploaded snapshots cannot be sealed" },
    { source: "GitHub auth mode", detail: `${gh.mode}${gh.problem ? `: ${gh.problem}` : ""}` },
  ] });
  // worker API (D)
  const wapi = hasWorkerApi ? (await q("SELECT count(*) FILTER (WHERE action = 'worker_api.accepted')::int AS accepted, count(*) FILTER (WHERE action = 'worker_api.refused')::int AS refused, max(created_at) FILTER (WHERE action = 'worker_api.accepted') AS at FROM audit_events WHERE action LIKE 'worker\\_api.%'"))[0]! : null;
  comps.push({ id: "worker_api", label: "Worker API (option D)", state: !hasWorkerApi ? "unavailable" : !opts.workerApiEnabled ? "unavailable" : wapi && wapi.accepted > 0 ? "operational" : "available", evidence: [
    { source: "schema", detail: hasWorkerApi ? "migration 0015 applied" : "migration 0015 is not applied" },
    { source: "API process configuration", detail: opts.workerApiEnabled ? "worker routes registered" : "worker routes not registered in this API process" },
    ...(wapi ? [{ source: "audit_events worker_api.*", detail: `${wapi.accepted} accepted, ${wapi.refused} refused`, at: iso(wapi.at) }] : []),
  ] });
  // pipeline stages
  for (const [key, label] of [[ACQUIRE_STEP_KEY, "Repository acquisition"], [ANALYZE_STEP_KEY, "Structural analyzer"], [CHALLENGE_STEP_KEY, "Execution validators (challenge)"], [DOSSIER_STEP_KEY, "Dossier builder"]] as const) {
    const s = await lastStep(key);
    comps.push({ id: `stage:${key}`, label, state: s.ok > 0 ? "operational" : "available", evidence: [{ source: "workflow_steps", detail: `${s.ok} succeeded, ${s.failed} failed${s.ok ? "" : ": deployed and assignable, not yet used successfully"}`, at: iso(s.ok_at) }] });
  }
  const slither = av("slither"); const slSteps = await lastStep(SLITHER_STEP_KEY, "AND input->>'scope' = 'repository_research'");
  comps.push({ id: "capability:slither", label: `Slither stage (${slither.capability.version})`, state: !slither.available ? "unavailable" : slSteps.ok > 0 ? "operational" : "experimental", evidence: [
    { source: "capability availability (API process environment)", detail: slither.available ? "pinned binaries configured" : slither.reason },
    { source: "workflow_steps slither_scan (research scope)", detail: `${slSteps.ok} succeeded, ${slSteps.failed} failed; off by default (created only with slitherScan)`, at: iso(slSteps.ok_at) }] });
  const forge = av("foundry-forge");
  const forgeEvals = (await q("SELECT count(*)::int AS n, max(created_at) AS at FROM hypothesis_evaluations WHERE evaluator_id = 'foundry-forge'"))[0]!;
  comps.push({ id: "capability:foundry-forge", label: `Foundry reproduction (${forge.capability.version})`, state: !forge.available ? "unavailable" : forgeEvals.n > 0 ? "operational" : "experimental", evidence: [
    { source: "capability availability (API process environment)", detail: forge.available ? "pinned forge and solc configured" : forge.reason },
    { source: "hypothesis_evaluations (foundry-forge)", detail: `${forgeEvals.n} recorded`, at: iso(forgeEvals.at) }] });
  const attended = avail.filter((a) => a.capability.profile.runtime === "attended_session");
  comps.push({ id: "capability:attended", label: "Attended Claude specialists", state: attended.some((a) => a.available) ? "available" : "unavailable", evidence: [{ source: "capability availability (API process environment)", detail: attended.some((a) => a.available) ? "an attended operator is configured (interactive only)" : attended[0]?.reason ?? "none declared" }] });
  comps.push({ id: "apex", label: "APEX exploration", state: "experimental", evidence: [{ source: "capability registry and step keys", detail: `experimental, off by default, not in the pipeline: ${CAPABILITIES.some((c) => /apex/i.test(c.id)) ? "declared" : "no capability declared"}; prototypes only under apps/api/src/apex/testing` }] });
  comps.push({ id: "independence", label: "Independence views (0016)", state: hasIndependence ? "operational" : "unavailable", evidence: [{ source: "schema", detail: hasIndependence ? "evaluation_independence and hypothesis_independence exist" : "migration 0016 is not applied" }] });
  comps.push({ id: "discovery", label: "Discovery monitor (0008)", state: hasDiscovery ? "available" : "unavailable", evidence: [{ source: "schema", detail: hasDiscovery ? "discovery tables exist" : "migration 0008 is not applied in this database" }] });
  comps.push({ id: "engine_loop", label: "Engine-loop decisions (0010)", state: hasDecisions ? "available" : "unavailable", evidence: [{ source: "schema", detail: hasDecisions ? "research_decisions exists" : "migration 0010 is not applied (draft)" }] });
  return { version: "system-components/1", generated_at: iso(now!.at), rules: {
    operational: "used successfully, with a recorded event", available: "deployed and assignable, not yet used successfully", experimental: "in code, off by default",
    unavailable: "the capability probe or schema check fails here, with its reason", blocked: "a recorded blocker (e.g. a source's last failure)" }, components: comps };
}

// ------------------------------------------------------------------------------------------------------------------------- routes
export function registerOperationsRoutes(app: FastifyInstance, pool: Pool | undefined, opts: { workerApiEnabled: boolean; githubVerifierConfigured: boolean | null }): void {
  const guard = (reply: FastifyReply) => { if (pool) return pool; reply.code(503).send({ error: "database_not_configured" }); return null; };
  app.get("/v1/research/runs/:id/progress", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const db = guard(reply); if (!db) return;
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    const r = await runProgress(db, params.data.id);
    return r ?? reply.code(404).send({ error: "not_found" });
  });
  app.get("/v1/research/timeline", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const db = guard(reply); if (!db) return;
    const query = z.object({ run: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(100), before: z.string().datetime({ offset: true }).optional(), before_id: z.string().max(100).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    return runTimeline(db, { ...(query.data.run ? { run: query.data.run } : {}), limit: query.data.limit, ...(query.data.before ? { before: query.data.before } : {}), ...(query.data.before_id ? { beforeId: query.data.before_id } : {}) });
  });
  app.get("/v1/engine/components", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const db = guard(reply); if (!db) return;
    return systemComponents(db, opts);
  });
}
