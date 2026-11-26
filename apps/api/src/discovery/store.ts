import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createRepositoryResearchRunIn } from "../acquisition/step.js";
import { githubOrgConfigSchema, SOURCE_KEY, DiscoveryError, type RepositoryCandidate } from "./types.js";

const createSourceSchema = z.object({
  sourceKey: z.string().regex(SOURCE_KEY),
  adapter: z.literal("github_org_repos"),
  displayName: z.string().min(1).max(200),
  config: githubOrgConfigSchema,
  minIntervalSeconds: z.number().int().min(300).max(604_800).default(3600),
}).strict();
export type CreateSourceInput = z.input<typeof createSourceSchema>;

async function audit(client: Pick<PoolClient, "query">, actor: string, action: string, entityType: string, entityId: string, reason: string, payload: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (actor, action, entity_type, entity_id, reason, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [actor, action, entityType, entityId, reason, JSON.stringify(payload)]);
}

/** Sources are always created disabled: nothing is fetched until a human enables it. */
export async function createSource(pool: Pool, input: CreateSourceInput, actor = "operator"): Promise<{ id: string; sourceKey: string }> {
  const parsed = createSourceSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ id: string }>(
      `INSERT INTO discovery_sources (source_key, adapter, display_name, config, min_interval_seconds, created_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`,
      [parsed.sourceKey, parsed.adapter, parsed.displayName, JSON.stringify(parsed.config), parsed.minIntervalSeconds, actor]);
    await audit(client, actor, "discovery.source.created", "discovery_source", row.rows[0]!.id, "Discovery source registered (disabled)", { source_key: parsed.sourceKey, adapter: parsed.adapter, org: parsed.config.org });
    await client.query("COMMIT");
    return { id: row.rows[0]!.id, sourceKey: parsed.sourceKey };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") throw new DiscoveryError("source_exists", `a source named ${parsed.sourceKey} already exists`);
    throw error;
  } finally { client.release(); }
}

export async function setSourceEnabled(pool: Pool, sourceKey: string, enabled: boolean, actor = "operator"): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ id: string }>(`UPDATE discovery_sources SET enabled = $2, updated_at = now() WHERE source_key = $1 RETURNING id`, [sourceKey, enabled]);
    if (!r.rows[0]) throw new DiscoveryError("unknown_source", `no source named ${sourceKey}`);
    await audit(client, actor, enabled ? "discovery.source.enabled" : "discovery.source.disabled", "discovery_source", r.rows[0].id, enabled ? "Source monitoring enabled by a human" : "Source monitoring disabled", { source_key: sourceKey });
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function listSources(pool: Pool): Promise<Array<Record<string, unknown>>> {
  return (await pool.query(`SELECT source_key, adapter, display_name, enabled, min_interval_seconds, last_attempt_at, last_success_at, consecutive_failures, config
    FROM discovery_sources ORDER BY source_key`)).rows;
}

const listFilter = z.object({
  state: z.enum(["discovered", "approved", "queued", "dismissed", "closed"]).optional(),
  platform: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,60}$/).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function listOpportunities(pool: Pool, filter: z.input<typeof listFilter> = {}): Promise<Array<Record<string, unknown>>> {
  const f = listFilter.parse(filter);
  return (await pool.query(
    `SELECT id, canonical_key, platform, title, state, source_url, priority_score, priority_reasons, repository_candidates, first_seen_at, last_seen_at
       FROM bounty_opportunities
      WHERE ($1::text IS NULL OR state = $1) AND ($2::text IS NULL OR platform = $2)
      ORDER BY priority_score DESC, last_seen_at DESC LIMIT $3`, [f.state ?? null, f.platform ?? null, f.limit])).rows;
}

export async function getOpportunity(pool: Pool, id: string): Promise<{ opportunity: Record<string, unknown>; events: Array<Record<string, unknown>> } | null> {
  const o = await pool.query(`SELECT * FROM bounty_opportunities WHERE id = $1`, [id]);
  if (!o.rows[0]) return null;
  const e = await pool.query(`SELECT seq, event_type, actor_kind, actor_id, observation_id, research_run_id, payload, created_at FROM opportunity_events WHERE opportunity_id = $1 ORDER BY seq`, [id]);
  return { opportunity: o.rows[0], events: e.rows };
}

const approveSchema = z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/), note: z.string().max(1000).optional() });

/**
 * A human chooses which candidate repository to research. The decision, the queued research run and the audit record are ONE
 * transaction; repeating the call for a queued opportunity returns the existing run instead of creating another.
 * Approval is not authorisation to test anything: the run is passive reading (`repository_research`, passive_only).
 */
export async function approveOpportunity(pool: Pool, id: string, input: z.input<typeof approveSchema>, actor: string): Promise<{ runId: string; stepId: string | null; reused: boolean }> {
  const parsed = approveSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query<{ state: string; repository_candidates: RepositoryCandidate[] }>(`SELECT state, repository_candidates FROM bounty_opportunities WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw new DiscoveryError("not_found", "no such opportunity");
    if (row.state === "queued") {
      const prior = (await client.query<{ research_run_id: string }>(`SELECT research_run_id FROM opportunity_events WHERE opportunity_id = $1 AND event_type = 'queued' ORDER BY seq DESC LIMIT 1`, [id])).rows[0]!;
      const queuedRepo = (await client.query<{ payload: { repository?: string } }>(`SELECT payload FROM opportunity_events WHERE opportunity_id = $1 AND event_type = 'queued' ORDER BY seq DESC LIMIT 1`, [id])).rows[0]?.payload.repository;
      if (queuedRepo && queuedRepo.toLowerCase() !== parsed.repository.toLowerCase()) throw new DiscoveryError("invalid_state", `already queued for ${queuedRepo}, not ${parsed.repository}`);
      await client.query("COMMIT");
      return { runId: prior.research_run_id, stepId: null, reused: true };
    }
    if (row.state !== "discovered") throw new DiscoveryError("invalid_state", `an opportunity in state ${row.state} cannot be approved`);
    const chosen = row.repository_candidates.find((c) => c.repository.toLowerCase() === parsed.repository.toLowerCase());
    if (!chosen) throw new DiscoveryError("repository_not_a_candidate", "the repository is not one of this opportunity's candidates");
    await client.query(`INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, payload) VALUES ($1,'approved','human',$2,$3::jsonb)`,
      [id, actor, JSON.stringify({ repository: chosen.repository, signal: chosen.signal, note: parsed.note ?? null })]);
    const run = await createRepositoryResearchRunIn(client, { repository: chosen.repository }, actor);
    await client.query(`INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, research_run_id, payload) VALUES ($1,'queued','human',$2,$3,$4::jsonb)`,
      [id, actor, run.runId, JSON.stringify({ repository: chosen.repository })]);
    await client.query(`UPDATE bounty_opportunities SET state = 'queued', updated_at = now() WHERE id = $1`, [id]);
    await audit(client, actor, "discovery.opportunity.approved", "bounty_opportunity", id, "A human approved passive research of a candidate repository", { repository: chosen.repository, research_run_id: run.runId });
    await client.query("COMMIT");
    return { runId: run.runId, stepId: run.stepId, reused: false };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function dismissOpportunity(pool: Pool, id: string, reason: string, actor: string): Promise<void> {
  const why = z.string().min(3).max(1000).parse(reason);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query<{ state: string }>(`SELECT state FROM bounty_opportunities WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw new DiscoveryError("not_found", "no such opportunity");
    if (row.state !== "discovered" && row.state !== "closed") throw new DiscoveryError("invalid_state", `an opportunity in state ${row.state} cannot be dismissed`);
    await client.query(`INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, payload) VALUES ($1,'dismissed','human',$2,$3::jsonb)`, [id, actor, JSON.stringify({ reason: why })]);
    await client.query(`UPDATE bounty_opportunities SET state = 'dismissed', updated_at = now() WHERE id = $1`, [id]);
    await audit(client, actor, "discovery.opportunity.dismissed", "bounty_opportunity", id, why, {});
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
