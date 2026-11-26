import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { outboundFetch } from "../net/outbound.js";
import { orgReposUrl, parseOrgRepos } from "./github-org.js";
import { scoreOpportunity } from "./priority.js";
import { DiscoveryError, githubOrgConfigSchema, GITHUB_API_ORIGIN, type NormalizedOpportunity } from "./types.js";

export type MonitorOptions = {
  pool: Pool;
  sourceKey: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  workflowRunId?: string;
  maxBodyBytes?: number;
  timeoutMs?: number;
  /** Ignore the minimum interval (an explicit human "check now"). Never ignores `enabled`. */
  force?: boolean;
  /** With `force`, still refuse when the last attempt was fewer than this many seconds ago (a human cannot hammer the source). Default 0. */
  minForceGapSeconds?: number;
};

export type MonitorResult =
  | { outcome: "skipped"; reason: "disabled" | "too_soon" }
  | { outcome: "not_modified" }
  | { outcome: "failed"; errorCode: string }
  | { outcome: "ok"; seen: number; discovered: number; updated: number; closed: number };

type SourceRow = { id: string; source_key: string; adapter: string; config: unknown; enabled: boolean; min_interval_seconds: number; etag: string | null; last_attempt_at: Date | null };

/** Reads a response body, refusing to hold more than `max` bytes; returns null when it is larger. */
async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > max) { await response.body?.cancel().catch(() => undefined); return null; }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
/** Fields whose change is worth an event. `pushed_at` changes with every commit and is deliberately excluded. */
const material = (item: NormalizedOpportunity) => { const { pushed_at: _ignored, ...rest } = item.details as Record<string, unknown>; return stable({ title: item.title, rest, candidates: item.repositoryCandidates }); };

/**
 * One monitoring pass over one source. PASSIVE: a single GET to api.github.com (host fixed in code, never taken from configuration),
 * `redirect: manual`, bounded body, conditional request (ETag) so an unchanged listing costs no rate limit. Every attempt, successful
 * or not, leaves an observation row (url, status, body hash and size; never the body). Nothing is fetched for a disabled source.
 */
export async function monitorSource(options: MonitorOptions): Promise<MonitorResult> {
  const now = options.now ?? (() => new Date());
  const pool = options.pool;
  const src = (await pool.query<SourceRow>(`SELECT id, source_key, adapter, config, enabled, min_interval_seconds, etag, last_attempt_at FROM discovery_sources WHERE source_key = $1`, [options.sourceKey])).rows[0];
  if (!src) throw new DiscoveryError("unknown_source", `no source named ${options.sourceKey}`);
  if (!src.enabled) return { outcome: "skipped", reason: "disabled" };
  if (!options.force && src.last_attempt_at && now().getTime() - src.last_attempt_at.getTime() < src.min_interval_seconds * 1000) return { outcome: "skipped", reason: "too_soon" };

  const gap = options.minForceGapSeconds ?? 0;
  if (options.force && gap > 0 && src.last_attempt_at && now().getTime() - src.last_attempt_at.getTime() < gap * 1000) return { outcome: "skipped", reason: "too_soon" };

  const record = async (fields: { url: string; status: number | null; outcome: "ok" | "not_modified" | "failed"; error?: string; sha?: string; bytes?: number; items?: number }, client?: PoolClient): Promise<string> => {
    const db = client ?? pool;
    const r = await db.query<{ id: string }>(
      `INSERT INTO discovery_observations (source_id, workflow_run_id, url, http_status, outcome, error_code, content_sha256, bytes, items_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [src.id, options.workflowRunId ?? null, fields.url, fields.status, fields.outcome, fields.error ?? null, fields.sha ?? null, fields.bytes ?? null, fields.items ?? null]);
    return r.rows[0]!.id;
  };
  const failed = async (url: string, status: number | null, code: string): Promise<MonitorResult> => {
    await record({ url, status, outcome: "failed", error: code });
    await pool.query(`UPDATE discovery_sources SET last_attempt_at = now(), consecutive_failures = consecutive_failures + 1, updated_at = now() WHERE id = $1`, [src.id]);
    return { outcome: "failed", errorCode: code };
  };

  const config = githubOrgConfigSchema.safeParse(src.config);
  if (src.adapter !== "github_org_repos" || !config.success) return failed(`${GITHUB_API_ORIGIN}/`, null, "bad_config");
  const url = orgReposUrl(config.data);

  let response: Response;
  try {
    response = await (options.fetcher ?? outboundFetch)(url, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "AgentSmith-MultiHub-discovery/0.1", ...(src.etag ? { "if-none-match": src.etag } : {}) },
    });
  } catch (error) {
    const name = (error as { name?: string }).name;
    return failed(url, null, name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error");
  }
  if (response.status >= 300 && response.status < 400 && response.status !== 304) { await response.body?.cancel().catch(() => undefined); return failed(url, response.status, "redirect_refused"); }
  if (response.status === 304) {
    await response.body?.cancel().catch(() => undefined);
    await record({ url, status: 304, outcome: "not_modified" });
    await pool.query(`UPDATE discovery_sources SET last_attempt_at = now(), last_success_at = now(), consecutive_failures = 0, updated_at = now() WHERE id = $1`, [src.id]);
    return { outcome: "not_modified" };
  }
  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    return failed(url, response.status, response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after") || response.status === 429 ? "rate_limited" : "forbidden");
  }
  if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return failed(url, response.status, "http_error"); }

  const bytes = await readCapped(response, options.maxBodyBytes ?? 1_048_576);
  if (!bytes) return failed(url, 200, "response_too_large");
  const sha = createHash("sha256").update(bytes).digest("hex");
  let items: NormalizedOpportunity[]; let seen: number;
  try {
    ({ items, seen } = parseOrgRepos(JSON.parse(bytes.toString("utf8")) as unknown, config.data));
  } catch (error) {
    return failed(url, 200, error instanceof DiscoveryError ? error.code : "bad_json");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const observationId = await record({ url, status: 200, outcome: "ok", sha, bytes: bytes.length, items: seen }, client);
    let discovered = 0; let updated = 0; let closed = 0;
    for (const item of items) {
      const { score, reasons } = scoreOpportunity(item, now());
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bounty_opportunities (canonical_key, source_id, platform, title, state, source_url, details, repository_candidates, priority_score, priority_reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb) ON CONFLICT (canonical_key) DO NOTHING RETURNING id`,
        [item.canonicalKey, src.id, item.platform, item.title, item.closed ? "closed" : "discovered", item.sourceUrl, JSON.stringify(item.details), JSON.stringify(item.repositoryCandidates), score, JSON.stringify(reasons)]);
      if (inserted.rows[0]) {
        await client.query(`INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, observation_id, payload) VALUES ($1,'discovered','monitor',$2,$3,$4::jsonb)`,
          [inserted.rows[0].id, src.source_key, observationId, JSON.stringify({ title: item.title, source_url: item.sourceUrl })]);
        discovered += 1;
        continue;
      }
      const existing = (await client.query<{ id: string; title: string; state: string; details: Record<string, unknown>; repository_candidates: NormalizedOpportunity["repositoryCandidates"] }>(
        `SELECT id, title, state, details, repository_candidates FROM bounty_opportunities WHERE canonical_key = $1 FOR UPDATE`, [item.canonicalKey])).rows[0]!;
      const before = material({ ...item, title: existing.title, details: existing.details, repositoryCandidates: existing.repository_candidates });
      const changed = before !== material(item);
      if (changed) {
        await client.query(`UPDATE bounty_opportunities SET title = $2, details = $3::jsonb, repository_candidates = $4::jsonb, priority_score = $5, priority_reasons = $6::jsonb, last_seen_at = now(), updated_at = now() WHERE id = $1`,
          [existing.id, item.title, JSON.stringify(item.details), JSON.stringify(item.repositoryCandidates), score, JSON.stringify(reasons)]);
        await client.query(`INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, observation_id, payload) VALUES ($1,'updated','monitor',$2,$3,$4::jsonb)`,
          [existing.id, src.source_key, observationId, JSON.stringify({ title: item.title })]);
        updated += 1;
      } else {
        await client.query(`UPDATE bounty_opportunities SET last_seen_at = now() WHERE id = $1`, [existing.id]);
      }
      if (item.closed && existing.state !== "closed" && existing.state !== "dismissed") {
        // A queued (or approved) opportunity keeps its state so the link to its research run is not lost; the closure is still recorded.
        const keepsState = existing.state === "queued" || existing.state === "approved";
        await client.query(`UPDATE bounty_opportunities SET ${keepsState ? "" : "state = 'closed', "}priority_score = 0, updated_at = now() WHERE id = $1`, [existing.id]);
        await client.query(`INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, observation_id, payload) VALUES ($1,'closed','monitor',$2,$3,'{}'::jsonb)`, [existing.id, src.source_key, observationId]);
        closed += 1;
      }
    }
    const etag = response.headers.get("etag");
    await client.query(`UPDATE discovery_sources SET last_attempt_at = now(), last_success_at = now(), consecutive_failures = 0, etag = $2, updated_at = now() WHERE id = $1`, [src.id, etag && etag.length <= 200 ? etag : null]);
    await client.query("COMMIT");
    return { outcome: "ok", seen, discovered, updated, closed };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
