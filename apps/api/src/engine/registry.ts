import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { parseRepositoryName } from "../acquisition/github-source.js";
import { canonicalJson } from "../research-state.js";
import type { Db } from "./decisions.js";

/**
 * Opportunity registry for the research loop, built on 0008 and aligned with the T-040 unified opportunity model, not a parallel one:
 * - identity and deduplication: bounty_opportunities.canonical_key (UNIQUE); a second sighting is a new observation on the same identity;
 * - provenance: a discovery_observations row with provenance_kind 'operator_supplied' and the source's claims (never labelled as fetched);
 * - verification: a human 'verified' opportunity event per check, with evidence (T-040: verification is itself a recorded event);
 * - assessment: the policy's 'assessed' event (recommended, deferred, possible duplicate, ineligible, out of scope) with its reason and
 *   decision; it never changes state, never deletes and never blocks a human;
 * - selection: the existing human 'approved' + 'queued' events (approveOpportunityIn).
 * Manual import sources can never be enabled (database check), so nothing here is ever polled. This module makes no network request.
 */
export const registerSchema = z.object({
  source: z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,80}$/), displayName: z.string().min(1).max(200) }).strict(),
  canonicalKey: z.string().regex(/^[a-z0-9:_./-]{3,255}$/),
  platform: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,60}$/),
  title: z.string().min(1).max(300),
  referenceUrl: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "the reference must be an https URL"),
  /** what the source CLAIMS; nothing here is treated as verified */
  claims: z.object({
    maxRewardUsd: z.number().nonnegative().nullable().default(null),
    deadline: z.string().datetime().nullable().default(null),
    publishedAt: z.string().datetime().nullable().default(null),
    repositories: z.array(z.string().min(3).max(201)).max(20).default([]),
  }).strict(),
  /** hash of what the person read, if they recorded it; otherwise the hash of the claims as supplied */
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  recordedBy: z.string().min(1).max(200),
}).strict();
export type RegisterInput = z.input<typeof registerSchema>;
export type Claims = z.infer<typeof registerSchema>["claims"];

export async function registerManualOpportunity(pool: Pool, raw: RegisterInput): Promise<{ id: string; created: boolean; observationId: string }> {
  const input = registerSchema.parse(raw);
  for (const r of input.claims.repositories) parseRepositoryName(r);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO discovery_sources (source_key, adapter, display_name, config, enabled, created_by) VALUES ($1, 'manual_import', $2, '{}'::jsonb, false, $3) ON CONFLICT (source_key) DO NOTHING`,
      [input.source.key, input.source.displayName, input.recordedBy]);
    const source = (await client.query<{ id: string; adapter: string }>("SELECT id, adapter FROM discovery_sources WHERE source_key = $1", [input.source.key])).rows[0]!;
    if (source.adapter !== "manual_import") throw new Error(`source ${input.source.key} is an adapter source; manual registration needs a manual_import source`);
    const claimsJson = canonicalJson(input.claims);
    const obs = await client.query<{ id: string }>(
      `INSERT INTO discovery_observations (source_id, url, outcome, content_sha256, items_seen, provenance_kind, claims) VALUES ($1,$2,'ok',$3,1,'operator_supplied',$4::jsonb) RETURNING id`,
      [source.id, input.referenceUrl, input.contentSha256 ?? createHash("sha256").update(claimsJson).digest("hex"), claimsJson]);
    const observationId = obs.rows[0]!.id;
    const candidates = input.claims.repositories.map((repository) => ({ repository, signal: "claimed by a manually read reference source", confidence: "low" }));
    const ins = await client.query<{ id: string }>(
      `INSERT INTO bounty_opportunities (canonical_key, source_id, platform, title, source_url, details, repository_candidates)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT (canonical_key) DO NOTHING RETURNING id`,
      [input.canonicalKey, source.id, input.platform, input.title, input.referenceUrl, claimsJson, JSON.stringify(candidates)]);
    const created = Boolean(ins.rows[0]);
    const id = ins.rows[0]?.id ?? (await client.query<{ id: string }>("SELECT id FROM bounty_opportunities WHERE canonical_key = $1", [input.canonicalKey])).rows[0]!.id;
    if (!created) {
      // a second sighting: same identity, a new provenance record; the projection shows the latest claims, the history keeps all of them
      const known = (await client.query<{ repository_candidates: Array<{ repository: string }> }>("SELECT repository_candidates FROM bounty_opportunities WHERE id = $1", [id])).rows[0]!.repository_candidates;
      const merged = [...known, ...candidates.filter((c) => !known.some((k) => k.repository.toLowerCase() === c.repository.toLowerCase()))];
      await client.query("UPDATE bounty_opportunities SET details = $2::jsonb, repository_candidates = $3::jsonb, last_seen_at = now(), updated_at = now() WHERE id = $1", [id, claimsJson, JSON.stringify(merged)]);
    }
    await client.query(`INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, observation_id, payload) VALUES ($1, $2, 'human', $3, $4, $5::jsonb)`,
      [id, created ? "discovered" : "updated", input.recordedBy, observationId, JSON.stringify({ via: "manual_import", source_key: input.source.key })]);
    await client.query("COMMIT");
    return { id, created, observationId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export type CheckKind = "program_official" | "repository_official" | "scope_includes_repository" | "eligibility";
export type VerificationInput = {
  opportunityId: string; check: CheckKind; subject: string; verdict: "verified" | "unverified" | "contradicted"; method: string;
  /** each item names what was read: an official URL with the hash of its content, a commit, an organisation listing */
  evidence: Array<{ kind: string; ref: string; sha256?: string }>;
  humanId: string;
};
/** A human's check against the OFFICIAL source. AgentSmith never marks a program, scope or eligibility verified by itself. */
export async function recordVerification(db: Db, v: VerificationInput): Promise<void> {
  if (v.check === "repository_official" || v.check === "scope_includes_repository") parseRepositoryName(v.subject);
  await db.query(`INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, payload) VALUES ($1, 'verified', 'human', $2, $3::jsonb)`,
    [v.opportunityId, v.humanId, JSON.stringify({ check: v.check, subject: v.subject, verdict: v.verdict, method: v.method, evidence: v.evidence })]);
}

export type Assessment = "recommended" | "deferred" | "possible_duplicate" | "ineligible" | "out_of_scope";
export async function recordAssessment(db: Db, a: { opportunityId: string; assessment: Assessment; reason: string; duplicateOf?: string; decisionId: string }): Promise<void> {
  await db.query(`INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, decision_id, payload) VALUES ($1, 'assessed', 'policy', 'research-policy/0', $2, $3::jsonb)`,
    [a.opportunityId, a.decisionId, JSON.stringify({ assessment: a.assessment, reason: a.reason.slice(0, 2000), ...(a.duplicateOf ? { duplicate_of: a.duplicateOf } : {}) })]);
}

export type RegistryEntry = {
  id: string; canonicalKey: string; platform: string; title: string; firstSeenAt: string; state: string;
  claims: Claims; observations: number;
  /** latest verdict per (check, subject); later events supersede earlier ones, which stay in the log */
  checks: Array<{ check: CheckKind; subject: string; verdict: string }>;
  lastAssessment: { assessment: Assessment; reason: string } | null;
};

export async function readRegistry(db: Db): Promise<RegistryEntry[]> {
  const rows = (await db.query<{ id: string; canonical_key: string; platform: string; title: string; first_seen_at: Date; state: string; details: Claims; n: string; checks: RegistryEntry["checks"] | null; last: RegistryEntry["lastAssessment"] }>(
    `SELECT o.id, o.canonical_key, o.platform, o.title, o.first_seen_at, o.state, o.details,
            (SELECT count(*) FROM opportunity_events e WHERE e.opportunity_id = o.id AND e.observation_id IS NOT NULL) AS n,
            (SELECT jsonb_agg(jsonb_build_object('check', v.c, 'subject', v.s, 'verdict', v.v) ORDER BY v.c, v.s) FROM (
               SELECT DISTINCT ON (payload->>'check', lower(payload->>'subject')) payload->>'check' c, lower(payload->>'subject') s, payload->>'verdict' v
                 FROM opportunity_events WHERE opportunity_id = o.id AND event_type = 'verified' ORDER BY payload->>'check', lower(payload->>'subject'), seq DESC) v) AS checks,
            (SELECT jsonb_build_object('assessment', payload->>'assessment', 'reason', payload->>'reason') FROM opportunity_events WHERE opportunity_id = o.id AND event_type = 'assessed' ORDER BY seq DESC LIMIT 1) AS last
       FROM bounty_opportunities o ORDER BY o.first_seen_at, o.id`)).rows;
  return rows.map((r) => ({
    id: r.id, canonicalKey: r.canonical_key, platform: r.platform, title: r.title, firstSeenAt: r.first_seen_at.toISOString(), state: r.state,
    claims: { maxRewardUsd: r.details.maxRewardUsd ?? null, deadline: r.details.deadline ?? null, publishedAt: r.details.publishedAt ?? null, repositories: r.details.repositories ?? [] },
    observations: Number(r.n), checks: r.checks ?? [], lastAssessment: r.last,
  }));
}

/** Repositories that are BOTH verified official for the program and verified in scope. Claims alone never qualify a repository. */
export function verifiedRepositories(e: RegistryEntry): string[] {
  const ok = (check: CheckKind) => new Set(e.checks.filter((c) => c.check === check && c.verdict === "verified").map((c) => c.subject));
  const official = ok("repository_official"); const scope = ok("scope_includes_repository");
  return [...official].filter((r) => scope.has(r)).sort();
}
export const checkVerdict = (e: RegistryEntry, check: CheckKind): "verified" | "unverified" | "contradicted" => {
  const vs = e.checks.filter((c) => c.check === check).map((c) => c.verdict);
  return vs.includes("contradicted") ? "contradicted" : vs.includes("verified") ? "verified" : "unverified";
};
