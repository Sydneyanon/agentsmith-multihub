import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { canonicalJson } from "../research-state.js";
import { APEX_SHADOW_SCHEMA, UNVALIDATED, type ShadowResult } from "./shadow.js";
import { APEX_SHADOW_LABEL, APEX_SHADOW_STEP_KEY, APEX_SHADOW_TARGET, APEX_SHADOW_VERSION, apexShadowEligibility, type ApexShadowRefusalCode } from "./shadow-target.js";

/**
 * Storage of the APEX shadow record. No migration: one APPEND-ONLY audit event per report (`apex_shadow.reported`, entity the shadow step),
 * plus the shadow step's own output (a strict summary pointing at that event). Nothing here writes, or can write, a table the evidence path
 * reads: no hypothesis, evidence span, evaluation, review, outcome, blob or snapshot row. The dossier never reads these events.
 *
 * Whoever ran APEX (the direct worker, or a remote worker through `report_apex_shadow`), the record is checked by the RECORDER on its own
 * connection before it is stored: the step's lease, the run's eligibility (approved repository, commit and official scope, from the run's
 * own input), the sealed snapshot, that every analysed file is an in-scope file of that snapshot with the digest the snapshot holds, and a
 * cap on records per step. Overlaps with the specialists' leads are computed by the recorder from its own records. The content of the
 * measurement itself is REPORTED BY THE WORKER and labelled so.
 */
export const APEX_SHADOW_ACTION = "apex_shadow.reported";
export const MAX_SHADOW_RECORDS_PER_STEP = 3;
/** largest accepted report (also the worker-API operation's body limit, less the envelope) */
export const MAX_SHADOW_REPORT_BYTES = 4 * 1024 * 1024;

// ------------------------------------------------------------------------------------------------------------ the strict schema
const s = (n = 1000) => z.string().max(n);
const n = z.number().int().min(0).max(1e12);
const line = z.number().int().min(1).max(1e7).nullable();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const step = z.object({ actor: s(20), call: s(300), value: s(80) }).strict();
const seq = z.array(step).max(40);
const loc = z.object({ file: s(1024), line, at: s(1100) }).strict();
const ratio = z.object({ numerator: n, denominator: n, meaning: s(400) }).strict();
const searchCoverage = z.object({
  sequences: n, distinct_states: n, abstract_states: n, depth: n, depth_reached: n, budget_exhausted: z.boolean(), fixpoint: z.boolean(), frontier_dropped: n,
  functions: z.object({ total: n, completed: n, never_completed: z.array(s(200)).max(100) }).strict(),
  guards: z.object({ total: n, both_sides: n, only_passed: n, only_failed: n, never_reached: n }).strict(),
  statements: z.object({ total: n, reached: n }).strict(), unexplored: z.array(s(300)).max(50), unexplored_total: n,
}).strict();
const limits = z.object({ maxTransitions: n, perSearchBudget: n, softWallMs: n }).strict();
export const shadowResultSchema = z.object({
  schema: z.literal(APEX_SHADOW_SCHEMA), label: z.literal(APEX_SHADOW_LABEL), version: z.literal(APEX_SHADOW_VERSION),
  engine: z.object({ generator: s(100), strategy: z.literal("deep"), options: z.object({ depth: n, per_search_budget: n, quality: z.literal("defaults"), fp_rules: z.record(z.boolean()), minimise: z.literal(true), memo: z.literal(true) }).strict(), limits }).strict(),
  input_files: z.array(z.object({ path: s(1024), sha256: hex64, bytes: n }).strict()).max(2000),
  in_scope_paths_missing: z.array(s(1024)).max(2000),
  contracts: z.array(z.object({
    contract: s(300), file: s(1024), status: z.enum(["explored", "abstained_at_deployment", "no_entry_points", "skipped_transition_budget", "skipped_time_budget", "engine_error"]), reason: s(500).nullable(),
    honest: searchCoverage.nullable(), adversarial: searchCoverage.nullable(), statements: z.object({ total: n, reached: n }).strict().nullable(), entry_points: z.object({ total: n, completed: n }).strict().nullable(),
    search: z.object({ accepting_depth: n, extension_depth: n.nullable(), budget: n, honest_transitions: n, adversarial_transitions: n, random_transitions: n }).strict().nullable(),
    cost: z.object({ requested: n, interpreted: n, wall_ms: n }).strict(),
  }).strict()).max(2000),
  not_deployable: z.array(z.object({ contract: s(300), file: s(1024), kind: s(20) }).strict()).max(5000),
  abstentions: z.array(z.object({ contract: s(300), function: s(300), feature: s(40), file: s(1024), line, at: s(1100), why: s(500), phase: s(40), located_by: z.enum(["interpreter", "definition"]) }).strict()).max(20_000),
  abstentions_by_feature: z.record(n),
  suppressions: z.object({ total: n, by_kind: z.record(n), examples: z.array(z.object({ contract: s(300), candidate: s(300), phase: s(40), breaking_function: s(300), sequence: seq,
    approximations: z.array(z.object({ kind: s(40), file: s(1024), line, at: s(1100), what: s(200) }).strict()).max(20) }).strict()).max(20_000) }).strict(),
  withheld: z.array(z.object({ contract: s(300), candidate: s(300), why: s(80), kinds: z.array(s(40)).max(20) }).strict()).max(20_000),
  candidates: z.array(z.object({
    contract: s(300), id: s(300), kind: s(40), statement: s(300), vars: z.array(s(200)).max(20), decision: z.enum(["accepted", "rejected"]), rule: s(80), reason: s(500), maintaining: n, honest_violations: n,
    quality: z.object({ support: n, min_support: n, honest_breakers: z.array(s(300)).max(50), depth_extension: s(300), randomised: s(600), explained_by: s(300).nullable() }).strict(),
  }).strict()).max(20_000),
  invariant_decisions: z.array(z.object({ contract: s(300), candidate: s(300), decision: z.enum(["accepted", "rejected"]), rule: s(80), reason: s(500) }).strict()).max(20_000),
  reclassified: z.array(z.object({ contract: s(300), candidate: s(300), rule: s(80), breaking_function: s(300), sequence: seq, why: s(500),
    evidence: z.array(z.object({ function: s(300), role: s(300), transfer: s(80), check: loc, role_evidence: z.array(loc).max(10) }).strict()).max(20) }).strict()).max(20_000),
  would_be_hypotheses: z.array(z.object({
    contract: s(300), label: z.literal(UNVALIDATED), generator: s(100), family: s(100), claim: s(1000), spans: z.array(z.object({ file: s(1024), line: z.number().int().min(1), role: s(20) }).strict()).max(50),
    invariant: s(300), candidate: s(300), phase: s(40), breaking_function: s(300), reason: s(300), detail: s(300), counterexample: seq, minimised: seq.nullable(),
    fidelity: z.object({ fully_modelled: z.literal(true), approximations_on_path: z.literal(0) }).strict(), independent_of_scanners: z.boolean(), prior_leads_on_function: z.array(s(200)).max(20),
  }).strict()).max(5000),
  parse_problems: z.array(s(300)).max(200),
  coverage: z.object({ in_scope_files: ratio, contracts_explored: ratio, entry_points_completed: ratio, statements_reached: ratio, guard_sides_both: ratio, frontier_dropped: ratio }).strict(),
  cost: z.object({ transitions_requested: n, transitions_interpreted: n, wall_ms: n, peak_rss_bytes: n.nullable(), heap_used_bytes: n }).strict(),
}).strict();

export const FAILURE_CODES = ["cpu_limit", "wall_limit", "memory_limit", "output_too_large", "input_too_large", "compute_failed", "busy", "invalid_result", "error"] as const;
export const shadowReportSchema = z.object({
  schema: z.literal(APEX_SHADOW_SCHEMA), label: z.literal(APEX_SHADOW_LABEL), version: z.literal(APEX_SHADOW_VERSION),
  status: z.enum(["completed", "refused", "failed"]),
  refusal: z.object({ code: s(60), reason: s(1000) }).strict().nullable(),
  failure: z.object({ code: z.enum(FAILURE_CODES), message: s(1000), wall_ms: n }).strict().nullable(),
  provenance: z.object({
    apex_version: z.literal(APEX_SHADOW_VERSION), engine_generator: s(100).nullable(), strategy: z.literal("deep"),
    compute_limits: z.object({ cpuMs: n, wallMs: n, maxHeapMb: n, maxInputBytes: n, maxOutputBytes: n }).strict(), shadow_limits: limits,
    snapshot_id: z.string().uuid().nullable(), commit_sha: sha40.nullable(), manifest_sha256: hex64.nullable(), repository: s(201).nullable(),
    approved_by: s(200).nullable(), approved_commit: s(64).nullable(),
    input_files: z.array(z.object({ path: s(1024), sha256: hex64, bytes: n }).strict()).max(2000),
    worker: z.object({ mode: z.enum(["direct", "remote"]), build_commit: s(64).nullable() }).strict(),
    // C1 (optional; absent in reports of a stage that read no model): the shared protocol model the stage read BY HASH, and how the model's
    // syntactic prediction of unsupported features compares with what the fidelity gate actually abstained on
    protocol_model: z.union([
      z.object({ sha256: hex64, base_sha256: hex64, schema: s(100), read: z.literal("by_hash"), verified: z.literal("re-hashed on read"), used_for: s(300), inputs_total: n, inputs_matched: n, predicted_unsupported: z.record(n),
        gate_vs_model: z.object({ predicted_and_observed: z.array(s(40)).max(50), observed_not_predicted: z.array(s(40)).max(50), predicted_not_observed: z.array(s(40)).max(50) }).strict().nullable() }).strict(),
      z.object({ sha256: z.null(), read: z.literal("unavailable"), reason: s(500) }).strict(),
    ]).optional(),
  }).strict(),
  result: shadowResultSchema.nullable(),
  observed: z.object({ wall_ms: n, cpu_ms: n }).strict().nullable(),
}).strict().superRefine((r, ctx) => {
  if ((r.status === "completed") !== (r.result !== null)) ctx.addIssue({ code: "custom", message: "a completed report carries a result, and only a completed one" });
  if ((r.status === "refused") !== (r.refusal !== null)) ctx.addIssue({ code: "custom", message: "a refused report carries its refusal, and only a refused one" });
  if ((r.status === "failed") !== (r.failure !== null)) ctx.addIssue({ code: "custom", message: "a failed report carries its failure, and only a failed one" });
});
export type ShadowReport = z.infer<typeof shadowReportSchema>;
export const reportSha256 = (r: unknown) => createHash("sha256").update(canonicalJson(r)).digest("hex");

// ------------------------------------------------------------------------------------------------------------ overlaps
export type Overlap = { apex_kind: "would_be_hypothesis" | "abstention" | "suppression" | "reclassified"; apex_ref: string; apex_at: string | null; hypothesis_id: string; lead_family: string; lead_generator: string; lead_function: string | null; lead_at: string | null; relation: "same_line" | "same_function" | "same_file" };
export type Overlaps = { derived_by: "recorder"; leads_considered: number; summary: { same_line: number; same_function: number; same_file: number }; items: Overlap[]; truncated: number; note: string };

/** Overlaps of what APEX touched with the specialists' (and Slither's) leads of the same run, from the recorder's own records: same line > same function > same file. */
export async function shadowOverlaps(db: Pick<Pool, "query">, runId: string, result: ShadowResult | null): Promise<Overlaps> {
  const leads = (await db.query<{ id: string; family: string; generator_id: string; claim: string; path: string | null; line_start: number | null }>(
    `SELECT h.id, h.family, h.generator_id, h.claim, sp.path, sp.line_start FROM hypotheses h
       LEFT JOIN LATERAL (SELECT s.path, s.line_start FROM hypothesis_evidence he JOIN evidence_spans s ON s.id = he.span_id WHERE he.hypothesis_id = h.id ORDER BY (he.role = 'primary') DESC, s.path, s.line_start LIMIT 1) sp ON true
     WHERE h.workflow_run_id = $1 ORDER BY h.id`, [runId])).rows;
  const fnOf = (l: { generator_id: string; claim: string }) => l.generator_id === "slither" ? /^Slither \S+ \([^)]*\) in ([\w$]+(?:\.[\w$]+)?):/.exec(l.claim)?.[1] ?? null : /^(\w+\.\w+)/.exec(l.claim)?.[1] ?? null;
  const items: Overlap[] = []; const summary = { same_line: 0, same_function: 0, same_file: 0 };
  const touched: Array<{ kind: Overlap["apex_kind"]; ref: string; fn: string; file: string | null; line: number | null }> = [];
  if (result) {
    const fileOf = (contract: string) => result.contracts.find((c) => c.contract === contract)?.file ?? null;
    for (const h of result.would_be_hypotheses) touched.push({ kind: "would_be_hypothesis", ref: `${h.contract}:${h.candidate}`, fn: `${h.contract}.${h.breaking_function}`, file: h.spans[0]?.file ?? fileOf(h.contract), line: h.spans[0]?.line ?? null });
    for (const a of result.abstentions) touched.push({ kind: "abstention", ref: `${a.feature}@${a.at}`, fn: `${a.contract}.${a.function}`, file: a.file, line: a.line });
    for (const x of result.suppressions.examples) touched.push({ kind: "suppression", ref: `${x.contract}:${x.candidate}`, fn: `${x.contract}.${x.breaking_function}`, file: fileOf(x.contract), line: null });
    for (const x of result.reclassified) touched.push({ kind: "reclassified", ref: `${x.contract}:${x.candidate}:${x.rule}`, fn: `${x.contract}.${x.breaking_function}`, file: fileOf(x.contract), line: null });
  }
  let total = 0;
  for (const t of touched) for (const l of leads) {
    const lf = fnOf(l);
    const relation = t.file && l.path === t.file && t.line !== null && l.line_start === t.line ? "same_line" : lf !== null && lf === t.fn ? "same_function" : t.file && l.path === t.file ? "same_file" : null;
    if (!relation) continue;
    total += 1; summary[relation] += 1;
    if (items.length < 1000) items.push({ apex_kind: t.kind, apex_ref: t.ref.slice(0, 1100), apex_at: t.file ? `${t.file}${t.line ? `:${t.line}` : ""}` : null, hypothesis_id: l.id, lead_family: l.family, lead_generator: l.generator_id, lead_function: lf, lead_at: l.path ? `${l.path}:${l.line_start}` : null, relation });
  }
  return { derived_by: "recorder", leads_considered: leads.length, summary, items, truncated: total - items.length,
    note: "an overlap says only that APEX touched the same line, function or file as a lead; it is neither support nor contradiction of the lead" };
}

// ------------------------------------------------------------------------------------------------------------ recording
export type ShadowRecord = { audit_event_id: string; report_sha256: string; status: ShadowReport["status"]; recorded_status: ShadowReport["status"]; recorder_refusal: { code: string; reason: string } | null };
export class ShadowRecordRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ShadowRecordRefused"; }
}

/**
 * Records one shadow report for a step under its live lease (append-only). A COMPLETED or FAILED report for a run that is not the approved
 * target is not stored as such: the recorder stores a REFUSAL with its own reason instead, and says so. A completed report whose analysed
 * files are not in-scope files of the run's sealed snapshot, with the snapshot's digests, is refused outright (nothing stored).
 */
export async function recordApexShadow(db: Pick<Pool, "query">, input: { stepId: string; owner: string; actor: string; via: "direct_worker" | "worker_api"; tokenId?: string; report: unknown }): Promise<ShadowRecord> {
  const parsed = shadowReportSchema.safeParse(input.report);
  if (!parsed.success) throw new ShadowRecordRefused(422, "shadow_report_rejected", `the shadow report does not have its schema (${parsed.error.issues[0]?.path.join(".") || "report"}: ${parsed.error.issues[0]?.message ?? "invalid"})`);
  let report = parsed.data;
  const st = (await db.query<{ id: string; step_key: string; workflow_run_id: string; correlation_id: string | null; input: Record<string, unknown> }>(
    `SELECT st.id, st.step_key, st.workflow_run_id, r.correlation_id, r.input FROM workflow_steps st JOIN workflow_runs r ON r.id = st.workflow_run_id
      WHERE st.id = $1 AND st.status = 'running' AND st.lease_owner = $2 AND st.lease_expires_at > now()`, [input.stepId, input.owner])).rows[0];
  if (!st) throw new ShadowRecordRefused(409, "lease_not_held", "this worker does not hold the shadow step's lease");
  if (st.step_key !== APEX_SHADOW_STEP_KEY) throw new ShadowRecordRefused(403, "operation_not_allowed_for_step", `${st.step_key} steps may not record an APEX shadow report`);
  const prior = Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE entity_type = 'workflow_step' AND entity_id = $1 AND action = $2", [input.stepId, APEX_SHADOW_ACTION])).rows[0]!.n);
  if (prior >= MAX_SHADOW_RECORDS_PER_STEP) throw new ShadowRecordRefused(409, "shadow_record_limit", `this step already holds ${prior} shadow records`);

  // the recorder's own check of the run and its sealed snapshot (independent of what the worker read or claims)
  const snap = (await db.query<{ id: string; commit_sha: string; manifest_sha256: string | null; sealed: boolean }>(
    "SELECT id, commit_sha, manifest_sha256, sealed_at IS NOT NULL AS sealed FROM repo_snapshots WHERE workflow_run_id = $1 ORDER BY created_at DESC LIMIT 1", [st.workflow_run_id])).rows[0] ?? null;
  const acquired = (await db.query<{ snapshot_id: string | null }>("SELECT output->>'snapshot_id' AS snapshot_id FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = 'acquire_repository' AND status = 'succeeded'", [st.workflow_run_id])).rows[0]?.snapshot_id ?? null;
  const sealed = acquired ? (await db.query<{ id: string; commit_sha: string; manifest_sha256: string | null; sealed: boolean }>("SELECT id, commit_sha, manifest_sha256, sealed_at IS NOT NULL AS sealed FROM repo_snapshots WHERE id = $1", [acquired])).rows[0] ?? snap : snap;
  const eligibility = apexShadowEligibility({ repository: st.input["value"], ref: st.input["ref"], approval: st.input["apex_shadow"], scope: st.input["bounty_scope"] }, sealed ? { commitSha: sealed.commit_sha, sealed: sealed.sealed } : { commitSha: "", sealed: false });
  let recorderRefusal: { code: ApexShadowRefusalCode | "provenance_mismatch"; reason: string } | null = null;
  if (!eligibility.ok && report.status !== "refused") {
    recorderRefusal = { code: eligibility.code, reason: eligibility.reason };
    report = { ...report, status: "refused", refusal: { code: eligibility.code, reason: `refused by the recorder: ${eligibility.reason}` }, failure: null, result: null };
  }
  if (report.status === "completed") {
    if (!sealed || report.provenance.snapshot_id !== sealed.id || report.provenance.commit_sha !== sealed.commit_sha) throw new ShadowRecordRefused(422, "provenance_mismatch", "the report does not name the run's sealed snapshot and commit");
    const inScope = new Set(APEX_SHADOW_TARGET.inScopePaths);
    const files = report.result!.input_files;
    if (files.some((f) => !inScope.has(f.path))) throw new ShadowRecordRefused(422, "provenance_mismatch", "the report analysed a file outside the official scope");
    const stored = new Map((await db.query<{ path: string; text: string }>(
      `SELECT f.path, convert_from(b.content, 'UTF8') AS text FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.snapshot_id = $1 AND f.path = ANY($2::text[])`, [sealed.id, files.map((f) => f.path)])).rows.map((r) => [r.path, r.text]));
    const bad = files.filter((f) => { const t = stored.get(f.path); return t === undefined || createHash("sha256").update(t, "utf8").digest("hex") !== f.sha256; });
    if (bad.length) throw new ShadowRecordRefused(422, "provenance_mismatch", `the report's input digests do not match the sealed snapshot (${bad.slice(0, 3).map((f) => f.path).join(", ")})`);
    if (JSON.stringify(report.provenance.input_files) !== JSON.stringify(files)) throw new ShadowRecordRefused(422, "provenance_mismatch", "the provenance input files differ from the result's");
  }
  // C1: a report that says it read a shared protocol model must name the one this run's analysis step recorded
  const namedModel = report.provenance.protocol_model?.sha256 ?? null;
  if (namedModel) {
    const recorded = (await db.query<{ sha: string | null }>("SELECT output->>'shared_model_sha256' AS sha FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = 'analyze_structure' AND status = 'succeeded'", [st.workflow_run_id])).rows[0]?.sha ?? null;
    if (recorded !== namedModel) throw new ShadowRecordRefused(422, "provenance_mismatch", "the report names a shared protocol model other than the one this run's analysis recorded");
  }
  const overlaps = await shadowOverlaps(db, st.workflow_run_id, report.result as ShadowResult | null);
  const sha = reportSha256(report);
  const payload = { ...report, report_sha256: sha, reported_by: "worker", via: input.via, ...(input.tokenId ? { token_id: input.tokenId } : {}), overlaps,
    recorder: { checked: ["lease", "run eligibility (repository, commit, approval, official scope)", "sealed snapshot", ...(report.status === "completed" ? ["input files in scope with the snapshot's digests"] : []), ...(namedModel ? ["shared protocol model hash is the one the run's analysis recorded"] : [])], refused_worker_status: recorderRefusal ? parsed.data.status : null } };
  const id = (await db.query<{ id: string }>(
    `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason, payload) VALUES ($1, $2, 'workflow_step', $3, $4, $5, $6::jsonb) RETURNING id::text AS id`,
    [input.actor, APEX_SHADOW_ACTION, input.stepId, st.correlation_id, "APEX shadow (unvalidated, measurement only): not evidence", JSON.stringify(payload)])).rows[0]!.id;
  return { audit_event_id: id, report_sha256: sha, status: parsed.data.status, recorded_status: report.status, recorder_refusal: recorderRefusal };
}

/** The shadow step's stored output: a summary of ONE recorded report (by its hash), labelled; never a finding. */
export async function apexShadowStepOutput(db: Pick<Pool, "query">, stepId: string, sha: string | null, unrecorded?: { code: string; message: string }): Promise<Record<string, unknown>> {
  const passive = { execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false };
  const base = { label: APEX_SHADOW_LABEL, version: APEX_SHADOW_VERSION, reported_by: "worker", measurement_only: true, ...passive };
  if (!sha) return { status: "apex_shadow_failed", ...base, report_audit_event_id: null, report_sha256: null, failure: { code: "report_not_recorded", message: (unrecorded?.message ?? "the shadow report could not be recorded").slice(0, 500), worker_code: unrecorded?.code ?? null } };
  const row = (await db.query<{ id: string; payload: Record<string, any> }>(
    "SELECT id::text AS id, payload FROM audit_events WHERE entity_type = 'workflow_step' AND entity_id = $1 AND action = $2 AND payload->>'report_sha256' = $3 ORDER BY id DESC LIMIT 1", [stepId, APEX_SHADOW_ACTION, sha])).rows[0];
  if (!row) throw new ShadowRecordRefused(422, "shadow_report_not_recorded", "no shadow report with this hash is recorded for this step");
  const p = row.payload; const r = p.result as ShadowResult | null;
  return {
    status: p.status === "completed" ? "apex_shadow_recorded" : p.status === "refused" ? "apex_shadow_refused" : "apex_shadow_failed", ...base,
    report_audit_event_id: row.id, report_sha256: sha, snapshot_id: p.provenance?.snapshot_id ?? null, commit_sha: p.provenance?.commit_sha ?? null,
    refusal: p.refusal ?? null, failure: p.failure ?? null,
    ...(p.provenance?.protocol_model ? { protocol_model: p.provenance.protocol_model } : {}),
    counts: r ? { contracts_deployable: r.coverage.contracts_explored.denominator, contracts_explored: r.coverage.contracts_explored.numerator, abstentions: r.abstentions.length, suppressed_counterexamples: r.suppressions.total,
      withheld: r.withheld.length, candidates: r.candidates.length, accepted: r.candidates.filter((c) => c.decision === "accepted").length, rejected: r.candidates.filter((c) => c.decision === "rejected").length,
      reclassified: r.reclassified.length, would_be_hypotheses_unvalidated: r.would_be_hypotheses.length, overlaps: (p.overlaps?.summary ? p.overlaps.summary.same_line + p.overlaps.summary.same_function + p.overlaps.summary.same_file : 0) } : null,
    coverage: r ? r.coverage : null, cost: r ? r.cost : null,
  };
}

export type RunShadow = { step: { id: string; status: string; output: Record<string, any> | null } | null; record: { audit_event_id: string; at: string; payload: Record<string, any> } | null; records: number };
/** The run's shadow step and its latest recorded report (or nulls). Read-only. */
export async function apexShadowOfRun(db: Pick<Pool, "query">, runId: string): Promise<RunShadow> {
  const st = (await db.query<{ id: string; status: string; output: Record<string, any> | null }>("SELECT id, status, output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2 ORDER BY sequence LIMIT 1", [runId, APEX_SHADOW_STEP_KEY])).rows[0] ?? null;
  if (!st) return { step: null, record: null, records: 0 };
  const rows = (await db.query<{ id: string; created_at: Date; payload: Record<string, any> }>(
    "SELECT id::text AS id, created_at, payload FROM audit_events WHERE entity_type = 'workflow_step' AND entity_id = $1 AND action = $2 ORDER BY id DESC", [st.id, APEX_SHADOW_ACTION])).rows;
  const chosen = st.output?.report_sha256 ? rows.find((x) => x.payload?.report_sha256 === st.output!.report_sha256) ?? rows[0] : rows[0];
  return { step: st, record: chosen ? { audit_event_id: chosen.id, at: chosen.created_at.toISOString(), payload: chosen.payload } : null, records: rows.length };
}
