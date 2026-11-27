import type { Pool } from "pg";
import { classifyEligibility, eligibilitySummary, type Eligibility } from "./eligibility.js";
import type { Resolution } from "./resolve.js";
import { SCORING_VERSION } from "./rank.js";

/** Classify a stored row's resolved fields + verification into an eligibility tier (pure; no official verification is invented). */
export function eligOf(resolved: unknown, verification: string): Eligibility {
  return classifyEligibility({ resolved: (resolved ?? {}) as Resolution["resolved"], verification } as Resolution);
}

/** The honest headline: of all collected programmes, how many are genuinely eligible / need verification / out of this engine's scope. */
export async function eligibilityOverview(pool: Pool): Promise<Record<string, number>> {
  const rows = await pool.query<{ resolved: unknown; verification: string }>("SELECT resolved, verification FROM bounty_programs WHERE merged_into IS NULL");
  return eligibilitySummary(rows.rows.map((r) => eligOf(r.resolved, r.verification)));
}

/** Engine-suitable programmes a human could take toward an investigation, ranked. "eligible" = officially confirmed; the rest need verification. */
export async function researchCandidates(pool: Pool): Promise<Array<Record<string, unknown>>> {
  const { items } = await listPrograms(pool, { sort: "priority", limit: 1000 });
  const out: Array<Record<string, unknown>> = [];
  for (const r of items as Array<Record<string, unknown>>) {
    const e = eligOf(r.resolved, String(r.verification));
    if (!e.engineSuitable || e.tier === "ineligible") continue;
    out.push({ id: r.id, project: r.project_name, key: r.canonical_key, verification: r.verification, priority: r.priority === null ? null : Number(r.priority), reward: r.reward, eligibility: e });
  }
  return out;
}

/** Read models for the API and the dashboard. Public projections carry programme facts and provenance links only. */
export type ListFilters = { q?: string; chain?: string; tech?: string; category?: string; source?: string; status?: string; verification?: string; minReward?: number; needsVerification?: boolean;
  sort?: "priority" | "reward" | "discovered" | "updated" | "completeness"; limit?: number; offset?: number };

const SORTS: Record<NonNullable<ListFilters["sort"]>, string> = {
  priority: "s.priority DESC NULLS LAST, reward DESC NULLS LAST, p.project_name",
  reward: "reward DESC NULLS LAST, s.priority DESC NULLS LAST, p.project_name",
  discovered: "p.first_seen_at DESC, p.project_name",
  updated: "p.updated_at DESC, p.project_name",
  completeness: "(s.components->'completeness'->>'score')::numeric DESC NULLS LAST, s.priority DESC NULLS LAST",
};

const BASE = `
  SELECT p.id, p.canonical_key, p.project_name, p.resolved, p.status, p.status_basis, p.verification, p.first_seen_at, p.last_seen_at, p.last_checked_at, p.last_verified_at, p.updated_at,
         NULLIF(p.resolved->'maxReward'->>'value', '')::numeric AS reward, s.priority, s.components, s.explanation,
         (SELECT coalesce(json_agg(json_build_object('source', o.source_key, 'url', o.source_url, 'listed', o.listed, 'last_observed_at', o.last_observed_at) ORDER BY src.authority), '[]'::json)
            FROM bounty_observations o JOIN bounty_sources src USING (source_key) WHERE o.program_id = p.id) AS sources
    FROM bounty_programs p LEFT JOIN bounty_scores s ON s.program_id = p.id AND s.scoring_version = '${SCORING_VERSION}'
   WHERE p.merged_into IS NULL`;

export async function listPrograms(pool: Pool, f: ListFilters): Promise<{ total: number; items: Array<Record<string, unknown>> }> {
  const where: string[] = []; const args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replaceAll("$?", `$${args.length}`)); };
  if (f.q) add("(p.project_name ILIKE $? OR p.resolved->'programmeName'->>'value' ILIKE $? OR p.canonical_key ILIKE $?)", `%${f.q.replace(/[%_\\]/g, "\\$&")}%`);
  if (f.chain) add("EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(p.resolved->'chains'->'value', '[]')) c WHERE lower(c) = lower($?))", f.chain);
  if (f.tech) add("EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(p.resolved->'technologies'->'value', '[]') || coalesce(p.resolved->'assetTypes'->'value', '[]')) c WHERE lower(c) LIKE lower($?))", `%${f.tech}%`);
  if (f.category) add("EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(p.resolved->'categories'->'value', '[]')) c WHERE lower(c) = lower($?))", f.category);
  if (f.source) add("EXISTS (SELECT 1 FROM bounty_observations o WHERE o.program_id = p.id AND (o.source_key = $? OR lower(o.fields->>'platform') = lower($?)))", f.source);
  if (f.status) add("p.status = $?", f.status);
  if (f.verification) add("p.verification = $?", f.verification);
  if (f.minReward !== undefined) add("NULLIF(p.resolved->'maxReward'->>'value', '')::numeric >= $?", f.minReward);
  if (f.needsVerification) where.push("p.verification <> 'official_confirmed'");
  const filtered = `WITH b AS (${BASE}${where.length ? ` AND ${where.join(" AND ")}` : ""}) `;
  const order = SORTS[f.sort ?? "priority"].replaceAll("s.priority", "priority").replaceAll("s.components", "components").replaceAll("p.project_name", "project_name").replaceAll("p.first_seen_at", "first_seen_at").replaceAll("p.updated_at", "updated_at");
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 1000); const offset = Math.max(f.offset ?? 0, 0);
  const rows = await pool.query(`${filtered} SELECT *, count(*) OVER () AS total FROM b ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, args);
  return { total: rows.rows[0] ? Number(rows.rows[0].total) : 0, items: rows.rows.map(({ total: _t, ...r }) => r) };
}

export async function overview(pool: Pool): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = 'active')::int AS active_official,
      count(*) FILTER (WHERE status IN ('active', 'reported_active'))::int AS active_or_reported,
      count(*) FILTER (WHERE verification IN ('official_confirmed', 'official_stale'))::int AS officially_listed,
      count(*) FILTER (WHERE verification = 'official_confirmed')::int AS officially_confirmed,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM bounty_observations o JOIN bounty_sources s USING (source_key) WHERE o.program_id = p.id AND s.kind = 'official_platform'))::int AS without_official_source,
      count(*) FILTER (WHERE verification <> 'official_confirmed')::int AS needs_verification,
      count(*) FILTER (WHERE verification = 'conflicting')::int AS conflicting,
      count(*) FILTER (WHERE first_seen_at > now() - interval '7 days')::int AS new_7d,
      count(*) FILTER (WHERE status IN ('no_longer_listed', 'closed'))::int AS ended_or_delisted
    FROM bounty_programs p WHERE merged_into IS NULL`);
  const changed = await pool.query<{ n: number }>("SELECT count(DISTINCT program_id)::int AS n FROM bounty_program_changes WHERE field NOT LIKE '\\_%' AND changed_at > now() - interval '7 days'");
  const last = await pool.query<{ source_key: string; last_success_at: Date | null }>("SELECT source_key, last_success_at FROM bounty_sources WHERE last_success_at IS NOT NULL ORDER BY last_success_at DESC LIMIT 1");
  const dup = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM bounty_duplicate_candidates WHERE status = 'open'");
  return { ...r.rows[0], changed_7d: changed.rows[0]!.n, open_duplicate_candidates: dup.rows[0]!.n, last_successful_collection: last.rows[0] ?? null, eligibility: await eligibilityOverview(pool) };
}

export async function programDetail(pool: Pool, id: string): Promise<Record<string, unknown> | null> {
  const p = await pool.query(`${BASE} AND p.id = $1`, [id]);
  if (!p.rows[0]) {
    const merged = await pool.query<{ merged_into: string | null }>("SELECT merged_into FROM bounty_programs WHERE id = $1", [id]);
    return merged.rows[0]?.merged_into ? { merged_into: merged.rows[0].merged_into } : null;
  }
  const obs = await pool.query(`SELECT o.id, o.source_key, s.display_name, s.kind, s.authority, o.source_ref, o.source_url, o.source_title, o.source_author, o.published_at, o.match_basis, o.extraction_method,
      o.fields, o.listed, o.first_observed_at, o.last_observed_at, o.import_id FROM bounty_observations o JOIN bounty_sources s USING (source_key) WHERE o.program_id = $1 ORDER BY s.authority, o.first_observed_at`, [id]);
  const changes = await pool.query("SELECT field, old_value, new_value, source_key, changed_at FROM bounty_program_changes WHERE program_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 200", [id]);
  const dups = await pool.query(`SELECT d.id, d.reason, d.status, d.created_at, d.decided_by, CASE WHEN d.program_a = $1 THEN d.program_b ELSE d.program_a END AS other_id, o.project_name AS other_name, o.canonical_key AS other_key
      FROM bounty_duplicate_candidates d JOIN bounty_programs o ON o.id = CASE WHEN d.program_a = $1 THEN d.program_b ELSE d.program_a END WHERE $1 IN (d.program_a, d.program_b) ORDER BY d.created_at`, [id]);
  const scores = await pool.query("SELECT scoring_version, computed_at, priority FROM bounty_scores WHERE program_id = $1 ORDER BY computed_at DESC", [id]);
  return { ...p.rows[0], eligibility: eligOf(p.rows[0].resolved, p.rows[0].verification), observations: obs.rows, changes: changes.rows, duplicates: dups.rows, score_history: scores.rows };
}

export async function health(pool: Pool): Promise<Record<string, unknown>> {
  const sources = await pool.query(`SELECT s.source_key, s.display_name, s.kind, s.authority, s.collection_method, s.enabled, s.access_status, s.access_note, s.min_interval_seconds, s.last_attempt_at, s.last_success_at,
      s.last_error, s.consecutive_failures, s.next_attempt_at,
      (SELECT count(*)::int FROM bounty_observations o WHERE o.source_key = s.source_key) AS observations,
      (SELECT count(*)::int FROM bounty_observations o WHERE o.source_key = s.source_key AND o.listed) AS listed,
      (SELECT count(DISTINCT o.program_id)::int FROM bounty_observations o JOIN bounty_programs p ON p.id = o.program_id AND p.merged_into IS NULL WHERE o.source_key = s.source_key) AS programs_shown,
      (SELECT row_to_json(c) FROM (SELECT outcome, started_at, finished_at, http_status, bytes, pages, listings_extracted, programs_added, programs_updated, observations_unchanged, duplicates_matched, needs_verification, delisted, error
         FROM bounty_source_checks WHERE source_key = s.source_key ORDER BY started_at DESC LIMIT 1) c) AS last_check
    FROM bounty_sources s ORDER BY s.authority, s.source_key`);
  const runs = await pool.query("SELECT id, trigger, started_by, started_at, finished_at, status, summary FROM bounty_collection_runs ORDER BY started_at DESC LIMIT 20");
  return { sources: sources.rows, runs: runs.rows };
}

export async function listImports(pool: Pool): Promise<Array<Record<string, unknown>>> {
  return (await pool.query("SELECT id, submitted_url, left(submitted_text, 300) AS submitted_text_preview, url_kind, submitted_by, submitted_at, fetched_at, extracted_at, status, report FROM bounty_imports ORDER BY submitted_at DESC LIMIT 100")).rows;
}

export async function listDuplicates(pool: Pool, status = "open"): Promise<Array<Record<string, unknown>>> {
  return (await pool.query(`SELECT d.id, d.reason, d.status, d.created_at, a.id AS a_id, a.project_name AS a_name, a.canonical_key AS a_key, b.id AS b_id, b.project_name AS b_name, b.canonical_key AS b_key
    FROM bounty_duplicate_candidates d JOIN bounty_programs a ON a.id = d.program_a JOIN bounty_programs b ON b.id = d.program_b WHERE d.status = $1 ORDER BY d.created_at DESC LIMIT 500`, [status])).rows;
}

/** The public feed: programme facts, scores and provenance links only. No descriptions, no import text, no operator notes, no errors. */
/**
 * Sources whose CONTENT may be collected internally and fed to the engine, but may NOT be republished on the public page without the
 * platform's written permission. HackenProof's terms permit personal/internal use and forbid reproducing/publishing Content (owner
 * decision, docs/source-access-decisions.md). On the public feed we therefore suppress any field value these sources are the basis for
 * (falling back to a non-restricted source where one exists) and drop them from the advertised source list. AgentSmith's own derived
 * eligibility tier is not the platform's content and is kept.
 */
export const RESTRICTED_PUBLIC_SOURCES = new Set(["hackenproof"]);

export type ResolvedFieldView = { value: unknown; source: string; conflicts?: Array<{ value: unknown; source: string }> };
/** Public-feed view of a resolved field: if a display-restricted source is the basis, fall back to the best non-restricted conflict, or hide. */
export function publicFieldView(f: ResolvedFieldView | undefined): ResolvedFieldView | undefined {
  if (!f || !RESTRICTED_PUBLIC_SOURCES.has(f.source)) return f;
  const alt = (f.conflicts ?? []).find((c) => !RESTRICTED_PUBLIC_SOURCES.has(c.source));
  return alt ? { ...f, value: alt.value, source: alt.source } : { ...f, value: null, source: "" };
}

export async function publicFeed(pool: Pool): Promise<Record<string, unknown>> {
  const { items } = await listPrograms(pool, { sort: "priority", limit: 1000 });
  const v = (r: Record<string, unknown>, k: string): ResolvedFieldView | undefined =>
    publicFieldView((r.resolved as Record<string, ResolvedFieldView>)[k]);
  const pub = items.map((r) => ({
    id: r.id, key: r.canonical_key, project: r.project_name, programme: v(r, "programmeName")?.value ?? null, platform: v(r, "platform")?.value ?? null,
    official_url: v(r, "officialUrl")?.value ?? null,
    max_reward: v(r, "maxReward")?.value ?? null, currency: v(r, "rewardCurrency")?.value ?? null, reward_type: v(r, "rewardType")?.value ?? null, reward_source: v(r, "maxReward")?.source ?? null,
    reward_conflicts: (v(r, "maxReward")?.conflicts ?? []).length,
    tiers: ((v(r, "tiers")?.value as Array<{ severity: string; asset: string | null; min: number | null; max: number | null }> | undefined) ?? []).map((t) => ({ severity: t.severity, asset: t.asset, min: t.min, max: t.max })),
    chains: v(r, "chains")?.value ?? [], asset_types: v(r, "assetTypes")?.value ?? [], technologies: v(r, "technologies")?.value ?? [], categories: v(r, "categories")?.value ?? [],
    kyc: v(r, "kycRequired")?.value ?? null, fee: v(r, "submissionFee")?.value ?? null, launched: v(r, "launchedAt")?.value ?? null, source_updated: v(r, "sourceUpdatedAt")?.value ?? null,
    status: r.status, status_basis: r.status_basis, verification: r.verification, priority: r.priority === null ? null : Number(r.priority), components: r.components, explanation: r.explanation,
    first_seen: r.first_seen_at, last_checked: r.last_checked_at, last_verified: r.last_verified_at, updated: r.updated_at,
    sources: (r.sources as Array<{ source: string; url: string | null; listed: boolean }>).filter((s) => s.source !== "operator" && s.source !== "text-import" && !RESTRICTED_PUBLIC_SOURCES.has(s.source)).map((s) => ({ source: s.source, url: s.source === "web-import" ? null : s.url, listed: s.listed })),
    eligibility: eligOf(r.resolved, r.verification as string),
  }));
  const h = await health(pool);
  return {
    generated_at: new Date().toISOString(), scoring_version: SCORING_VERSION, overview: await overview(pool), eligibility: eligibilitySummary(pub.map((x) => x.eligibility)), programmes: pub,
    sources: (h.sources as Array<Record<string, unknown>>).map((s) => ({ key: s.source_key, name: s.display_name, kind: s.kind, enabled: s.enabled, access_status: s.access_status, access_note: s.access_note,
      last_success_at: s.last_success_at, programmes: s.programs_shown, last_outcome: (s.last_check as { outcome?: string } | null)?.outcome ?? null })),
  };
}
