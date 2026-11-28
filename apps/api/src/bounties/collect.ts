import type { Pool } from "pg";
import { ADAPTERS, type SourceAdapter } from "./adapters.js";
import type { HttpGet } from "./http.js";
import { markDelisted, recomputeProgram, upsertObservation } from "./store.js";
import { BountyError, type SourceFetchResult } from "./types.js";

/**
 * One collection run over the registered sources. Each source is fetched, extracted and saved on its own, in its own
 * transaction: one source failing never stops or rolls back another. Every stage is counted in bounty_source_checks.
 * Idempotent: a second run over the same content changes nothing but "last observed" times. A session advisory lock keeps two
 * runs from overlapping.
 */
const LOCK = 7_341_109_233;
export type CollectOptions = { trigger: "schedule" | "manual" | "import" | "test"; startedBy: string; sources?: string[]; force?: boolean; now?: () => Date; http: HttpGet;
  sleep?: (ms: number) => Promise<void>; adapters?: Record<string, SourceAdapter> };
export type CheckSummary = { source: string; outcome: string; listings: number; added: number; updated: number; unchanged: number; matched: number; needsVerification: number; delisted: number; error: string | null; notes: string[] };
export type RunSummary = { runId: string | null; status: "succeeded" | "partial" | "failed" | "already_running" | "nothing_due"; checks: CheckSummary[] };

const backoffSeconds = (interval: number, failures: number, retryAfter: number | null) => Math.max(retryAfter ?? 0, Math.min(86_400, interval * 2 ** Math.min(failures, 6)));

export async function runCollection(pool: Pool, o: CollectOptions): Promise<RunSummary> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const adapters = o.adapters ?? ADAPTERS;
  const lockClient = await pool.connect();
  try {
    const got = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
    if (!got.rows[0]?.ok) return { runId: null, status: "already_running", checks: [] };
    try {
      const sources = await pool.query<{ source_key: string; enabled: boolean; access_status: string; access_note: string; min_interval_seconds: number; next_attempt_at: Date | null; consecutive_failures: number; last_content_sha256: string | null }>(
        "SELECT source_key, enabled, access_status, access_note, min_interval_seconds, next_attempt_at, consecutive_failures, last_content_sha256 FROM bounty_sources WHERE source_key = ANY($1) ORDER BY source_key",
        [o.sources ?? Object.keys(adapters)]);
      // A run left "running" by a crashed process is closed as failed, so health never shows a phantom run.
      await pool.query("UPDATE bounty_collection_runs SET status = 'failed', finished_at = $1, summary = summary || '{\"note\":\"process ended before the run finished\"}'::jsonb WHERE status = 'running' AND started_at < $1::timestamptz - interval '1 hour'", [now()]);
      await pool.query("UPDATE bounty_source_checks SET outcome = 'failed', finished_at = $1, error = 'process ended before the check finished' WHERE outcome = 'running' AND started_at < $1::timestamptz - interval '1 hour'", [now()]);
      const run = await pool.query<{ id: string }>("INSERT INTO bounty_collection_runs (trigger, started_by, started_at) VALUES ($1, $2, $3) RETURNING id", [o.trigger, o.startedBy, now()]);
      const runId = run.rows[0]!.id; const checks: CheckSummary[] = [];
      const robots = new Map<string, string | null>();
      for (const s of sources.rows) {
        const adapter = adapters[s.source_key];
        const check = await pool.query<{ id: string }>("INSERT INTO bounty_source_checks (run_id, source_key, started_at) VALUES ($1, $2, $3) RETURNING id", [runId, s.source_key, now()]);
        const checkId = check.rows[0]!.id;
        const sum: CheckSummary = { source: s.source_key, outcome: "", listings: 0, added: 0, updated: 0, unchanged: 0, matched: 0, needsVerification: 0, delisted: 0, error: null, notes: [] };
        const finish = async (outcome: string, extra: Record<string, unknown> = {}) => {
          sum.outcome = outcome; checks.push(sum);
          await pool.query(`UPDATE bounty_source_checks SET finished_at = $2, outcome = $3, listings_extracted = $4, programs_added = $5, programs_updated = $6, observations_unchanged = $7,
              duplicates_matched = $8, needs_verification = $9, delisted = $10, error = $11, http_status = $12, bytes = $13, content_sha256 = $14, pages = $15, retry_after = $16 WHERE id = $1`,
            [checkId, now(), outcome, sum.listings, sum.added, sum.updated, sum.unchanged, sum.matched, sum.needsVerification, sum.delisted, sum.error, extra.httpStatus ?? null, extra.bytes ?? null, extra.sha ?? null, extra.pages ?? 0, extra.retryAfter ?? null]);
        };
        if (!adapter || adapter.blocked || s.access_status.startsWith("blocked")) { sum.error = adapter?.blocked ?? s.access_note; await finish("skipped_blocked"); continue; }
        if (!s.enabled) { sum.error = `disabled (${s.access_status}): ${s.access_note}`; await finish("skipped_disabled"); continue; }
        if (!o.force && s.next_attempt_at && s.next_attempt_at > now()) { sum.notes.push(`next attempt due ${s.next_attempt_at.toISOString()}`); await finish("skipped_not_due"); continue; }

        await pool.query("UPDATE bounty_sources SET last_attempt_at = $2, updated_at = $2 WHERE source_key = $1", [s.source_key, now()]);
        let result: SourceFetchResult;
        try { result = await adapter.retrieve(o.http, { robots, sleep }); } catch (e) {
          result = { ok: false, httpStatus: null, error: e instanceof BountyError ? `${e.code}: ${e.message}` : (e as Error).message, retryable: true, retryAfterSeconds: null };
        }
        if (!result.ok) {
          const failures = s.consecutive_failures + 1; const wait = backoffSeconds(s.min_interval_seconds, failures, result.retryAfterSeconds);
          const next = new Date(now().getTime() + wait * 1000);
          await pool.query("UPDATE bounty_sources SET consecutive_failures = $2, last_error = $3, next_attempt_at = $4, updated_at = $5 WHERE source_key = $1", [s.source_key, failures, result.error.slice(0, 1000), next, now()]);
          sum.error = result.error; sum.notes.push(`retry after ${next.toISOString()} (attempt ${failures})`);
          await finish("failed", { httpStatus: result.httpStatus, retryAfter: next });
          continue;
        }
        sum.listings = result.items.length; sum.notes.push(...result.notes.slice(0, 20));
        if (!result.items.length) {
          // An empty answer is recorded as empty, never as "everything closed": nothing is delisted.
          await pool.query("UPDATE bounty_sources SET last_success_at = $2, consecutive_failures = 0, last_error = NULL, next_attempt_at = $3, updated_at = $2 WHERE source_key = $1",
            [s.source_key, now(), new Date(now().getTime() + s.min_interval_seconds * 1000)]);
          await finish("empty", { httpStatus: result.httpStatus, bytes: result.bytes, sha: result.contentSha256, pages: result.pages });
          continue;
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const t = now(); const touched = new Set<string>(); const seen = new Set<string>();
          for (const item of result.items) {
            seen.add(item.sourceRef);
            const u = await upsertObservation(client, { sourceKey: s.source_key, item, extractionMethod: `${s.source_key} adapter`, sourceUrl: item.officialUrl, checkId, now: t });
            touched.add(u.programId);
            if (u.outcome === "added") sum.added += 1; else if (u.outcome === "updated") sum.updated += 1; else if (u.outcome === "matched") sum.matched += 1; else sum.unchanged += 1;
          }
          for (const id of touched) { const r = await recomputeProgram(client, id, t, { checkId, sourceKey: s.source_key }); if (r.needsVerification) sum.needsVerification += 1; }
          if (result.complete) {
            const listedBefore = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM bounty_observations WHERE source_key = $1 AND listed", [s.source_key]);
            if (listedBefore.rows[0]!.n > 0 && seen.size < listedBefore.rows[0]!.n * 0.5) sum.notes.push(`listing shrank from ${listedBefore.rows[0]!.n} to ${seen.size}; treated as incomplete, nothing delisted`);
            else sum.delisted = (await markDelisted(client, s.source_key, seen, t, checkId)).length;
          }
          await client.query("UPDATE bounty_sources SET last_success_at = $2, consecutive_failures = 0, last_error = NULL, next_attempt_at = $3, last_content_sha256 = $4, updated_at = $2 WHERE source_key = $1",
            [s.source_key, t, new Date(t.getTime() + s.min_interval_seconds * 1000), result.contentSha256]);
          await client.query("COMMIT");
          await finish("fetched", { httpStatus: result.httpStatus, bytes: result.bytes, sha: result.contentSha256, pages: result.pages });
        } catch (e) {
          await client.query("ROLLBACK");
          sum.error = `saving failed: ${(e as Error).message}`; sum.added = sum.updated = sum.unchanged = sum.matched = sum.needsVerification = sum.delisted = 0;
          await pool.query("UPDATE bounty_sources SET consecutive_failures = consecutive_failures + 1, last_error = $2, updated_at = $3 WHERE source_key = $1", [s.source_key, sum.error.slice(0, 1000), now()]);
          await finish("failed", { httpStatus: result.httpStatus, bytes: result.bytes });
        } finally { client.release(); }
      }
      const attempted = checks.filter((c) => c.outcome === "fetched" || c.outcome === "empty" || c.outcome === "failed");
      const failed = attempted.filter((c) => c.outcome === "failed");
      const status: RunSummary["status"] = !attempted.length ? "nothing_due" : failed.length === 0 ? "succeeded" : failed.length === attempted.length ? "failed" : "partial";
      await pool.query("UPDATE bounty_collection_runs SET finished_at = $2, status = $3, summary = $4 WHERE id = $1",
        [runId, now(), status === "nothing_due" ? "succeeded" : status, JSON.stringify({ checks, note: status === "nothing_due" ? "no source was due or enabled" : undefined })]);
      return { runId, status, checks };
    } finally { await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK]); }
  } finally { lockClient.release(); }
}
