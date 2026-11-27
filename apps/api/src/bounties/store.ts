import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalFromUrl, nameKey } from "./canonical.js";
import { scoreProgramme, SCORING_VERSION } from "./rank.js";
import { resolveProgramme, type ObservationInput, type Resolution, type SourceKind } from "./resolve.js";
import { BountyError, type ExtractedOpportunity } from "./types.js";

type Q = Pick<PoolClient, "query">;

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export const contentHash = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex");

export type UpsertOutcome = { programId: string; outcome: "added" | "updated" | "unchanged" | "matched"; matchBasis: string; observationId: string };

/** Follows merged_into to the surviving record. */
async function live(q: Q, id: string): Promise<string> {
  let cur = id;
  for (let i = 0; i < 20; i += 1) {
    const r = await q.query<{ merged_into: string | null }>("SELECT merged_into FROM bounty_programs WHERE id = $1", [cur]);
    if (!r.rows[0]?.merged_into) return cur;
    cur = r.rows[0].merged_into;
  }
  return cur;
}

async function addDuplicateCandidate(q: Q, a: string, b: string, reason: string): Promise<void> {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  await q.query("INSERT INTO bounty_duplicate_candidates (program_a, program_b, reason) VALUES ($1, $2, $3) ON CONFLICT (program_a, program_b) DO NOTHING", [x, y, reason]);
}

/**
 * Records what one source says about one opportunity and links it to a programme:
 * 1. the same listing from the same source (source_ref) updates its own observation;
 * 2. a recognised platform programme URL (canonical key) joins the programme with that key, whatever the source;
 * 3. a name-only opportunity joins a programme only when exactly one programme has exactly that normalised name;
 * 4. otherwise a new programme is created, and same-name programmes elsewhere become possible duplicates for review (never merged).
 */
export async function upsertObservation(q: Q, input: { sourceKey: string; item: ExtractedOpportunity; extractionMethod: string; sourceUrl: string | null; checkId?: string | null; importId?: string | null; now: Date }): Promise<UpsertOutcome> {
  const { item, sourceKey, now } = input;
  const fields = { ...item } as Record<string, unknown>; delete fields.sourceRef;
  const sha = contentHash(fields);
  const prior = await q.query<{ id: string; program_id: string; content_sha256: string; listed: boolean }>(
    "SELECT id, program_id, content_sha256, listed FROM bounty_observations WHERE source_key = $1 AND source_ref = $2", [sourceKey, item.sourceRef]);
  if (prior.rows[0]) {
    const p = prior.rows[0]; const programId = await live(q, p.program_id);
    if (p.content_sha256 === sha && p.listed) {
      await q.query("UPDATE bounty_observations SET last_observed_at = $2, check_id = COALESCE($3, check_id) WHERE id = $1", [p.id, now, input.checkId ?? null]);
      return { programId, outcome: "unchanged", matchBasis: "source_ref", observationId: p.id };
    }
    await q.query("UPDATE bounty_observations SET fields = $2, content_sha256 = $3, last_observed_at = $4, listed = true, check_id = COALESCE($5, check_id), import_id = COALESCE($6, import_id), source_url = COALESCE($7, source_url), source_title = $8, source_author = $9, published_at = $10 WHERE id = $1",
      [p.id, JSON.stringify(fields), sha, now, input.checkId ?? null, input.importId ?? null, input.sourceUrl, item.sourceTitle, item.sourceAuthor, item.publishedAt]);
    return { programId, outcome: "updated", matchBasis: "source_ref", observationId: p.id };
  }

  const canonical = [item.officialUrl, ...item.otherUrls].map((u) => canonicalFromUrl(u)).find((c) => c !== null) ?? null;
  const nk = nameKey(item.projectName);
  let programId: string | null = null; let matchBasis: UpsertOutcome["matchBasis"] = "new_record"; let created = false;
  if (canonical) {
    const r = await q.query<{ id: string }>("SELECT id FROM bounty_programs WHERE canonical_key = $1", [canonical.key]);
    if (r.rows[0]) { programId = await live(q, r.rows[0].id); matchBasis = "canonical_key"; }
  } else {
    const r = await q.query<{ id: string }>("SELECT id FROM bounty_programs WHERE name_key = $1 AND merged_into IS NULL ORDER BY first_seen_at", [nk]);
    if (r.rows.length === 1) { programId = r.rows[0]!.id; matchBasis = "name_exact"; }
  }
  if (!programId) {
    const r = await q.query<{ id: string }>("INSERT INTO bounty_programs (canonical_key, project_name, name_key, first_seen_at, last_seen_at) VALUES ($1, $2, $3, $4, $4) RETURNING id",
      [canonical?.key ?? null, item.projectName.slice(0, 300), nk, now]);
    programId = r.rows[0]!.id; created = true;
    await q.query("INSERT INTO bounty_program_changes (program_id, field, old_value, new_value, source_key, check_id) VALUES ($1, '_created', NULL, $2, $3, $4)",
      [programId, JSON.stringify({ canonical_key: canonical?.key ?? null, project: item.projectName }), sourceKey, input.checkId ?? null]);
    const same = await q.query<{ id: string; canonical_key: string | null }>("SELECT id, canonical_key FROM bounty_programs WHERE name_key = $1 AND id <> $2 AND merged_into IS NULL", [nk, programId]);
    for (const other of same.rows) {
      const otherPlatform = other.canonical_key?.split(":")[0] ?? null;
      if (canonical && otherPlatform === canonical.platform) continue; // two programmes on one platform are distinct by their ids
      await addDuplicateCandidate(q, programId, other.id, canonical && otherPlatform ? `same project name "${item.projectName}" on ${canonical.platform} and ${otherPlatform}` : `same project name "${item.projectName}"; one of them has no platform link`);
    }
  }
  const ins = await q.query<{ id: string }>(
    `INSERT INTO bounty_observations (program_id, source_key, source_ref, source_url, source_title, source_author, published_at, match_basis, extraction_method, fields, content_sha256, import_id, check_id, first_observed_at, last_observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
    [programId, sourceKey, item.sourceRef.slice(0, 600), input.sourceUrl, item.sourceTitle, item.sourceAuthor, item.publishedAt, matchBasis, input.extractionMethod, JSON.stringify(fields), sha, input.importId ?? null, input.checkId ?? null, now]);
  return { programId, outcome: created ? "added" : "matched", matchBasis, observationId: ins.rows[0]!.id };
}

const TRACKED = ["status", "verification", "projectName", "programmeName", "officialUrl", "maxReward", "rewardCurrency", "tiers", "chains", "assetTypes", "kycRequired", "submissionFee", "sourceUpdatedAt"] as const;

/** Re-resolves one programme from all its observations, appends field changes to history and stores the current score. */
export async function recomputeProgram(q: Q, programId: string, now: Date, ctx: { checkId?: string | null; sourceKey?: string | null } = {}): Promise<Resolution> {
  const p = await q.query<{ resolved: Record<string, { value: unknown }>; status: string; verification: string; first_seen_at: Date; canonical_key: string | null }>(
    "SELECT resolved, status, verification, first_seen_at, canonical_key FROM bounty_programs WHERE id = $1 FOR UPDATE", [programId]);
  if (!p.rows[0]) throw new BountyError("not_found", "programme not found");
  const obs = await q.query<{ id: string; source_key: string; kind: SourceKind; authority: number; listed: boolean; first_observed_at: Date; last_observed_at: Date; source_url: string | null; fields: Record<string, unknown> }>(
    `SELECT o.id, o.source_key, s.kind, s.authority, o.listed, o.first_observed_at, o.last_observed_at, o.source_url, o.fields
       FROM bounty_observations o JOIN bounty_sources s USING (source_key) WHERE o.program_id = $1`, [programId]);
  const inputs: ObservationInput[] = obs.rows.map((o) => ({ id: o.id, sourceKey: o.source_key, sourceKind: o.kind, authority: o.authority, listed: o.listed,
    firstObservedAt: o.first_observed_at.toISOString(), lastObservedAt: o.last_observed_at.toISOString(), sourceUrl: o.source_url, fields: o.fields }));
  const r = resolveProgramme(inputs, now);
  const old = p.rows[0];
  const before: Record<string, unknown> = { status: old.status, verification: old.verification };
  for (const k of TRACKED) if (k !== "status" && k !== "verification") before[k] = old.resolved?.[k]?.value ?? null;
  const after: Record<string, unknown> = { status: r.status, verification: r.verification };
  for (const k of TRACKED) if (k !== "status" && k !== "verification") after[k] = r.resolved[k]?.value ?? null;
  const isNew = Object.keys(old.resolved ?? {}).length === 0;
  if (!isNew) for (const k of TRACKED) {
    if (stable(before[k]) === stable(after[k])) continue;
    await q.query("INSERT INTO bounty_program_changes (program_id, field, old_value, new_value, source_key, check_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [programId, k, JSON.stringify(before[k] ?? null), JSON.stringify(after[k] ?? null), ctx.sourceKey ?? null, ctx.checkId ?? null]);
  }
  // A canonical key learned later (a name-only record that gains a platform link through a correction) is adopted when free.
  const officialUrl = r.resolved.officialUrl?.value as string | undefined;
  const key = !old.canonical_key && officialUrl ? canonicalFromUrl(officialUrl)?.key ?? null : null;
  const lastSeen = inputs.map((o) => o.lastObservedAt).sort().at(-1) ?? now.toISOString();
  await q.query(
    `UPDATE bounty_programs SET resolved = $2, status = $3, status_basis = $4, verification = $5, project_name = $6, name_key = $7, last_seen_at = $8, last_checked_at = $9,
       last_verified_at = $10, updated_at = CASE WHEN $11 THEN $9 ELSE updated_at END,
       canonical_key = COALESCE(canonical_key, CASE WHEN $12::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bounty_programs x WHERE x.canonical_key = $12::text) THEN $12::text END)
     WHERE id = $1`,
    [programId, JSON.stringify(r.resolved), r.status, r.statusBasis, r.verification, r.projectName.slice(0, 300), nameKey(r.projectName), lastSeen, now, r.lastVerifiedAt, isNew || stable(before) !== stable(after), key]);
  const score = scoreProgramme(r, { now, firstSeenAt: old.first_seen_at.toISOString(), sourceCount: new Set(inputs.map((o) => o.sourceKey)).size });
  await q.query(
    `INSERT INTO bounty_scores (program_id, scoring_version, computed_at, priority, components, explanation) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (program_id, scoring_version) DO UPDATE SET computed_at = EXCLUDED.computed_at, priority = EXCLUDED.priority, components = EXCLUDED.components, explanation = EXCLUDED.explanation`,
    [programId, SCORING_VERSION, now, score.priority, JSON.stringify(score.components), JSON.stringify([...score.explanation, ...r.reasons.map((x) => `verification: ${x}`)])]);
  return r;
}

/** After a COMPLETE successful listing, listings the source no longer shows are marked delisted (kept, never deleted). */
export async function markDelisted(q: Q, sourceKey: string, seenRefs: ReadonlySet<string>, now: Date, checkId: string | null): Promise<string[]> {
  const r = await q.query<{ id: string; source_ref: string; program_id: string }>("SELECT id, source_ref, program_id FROM bounty_observations WHERE source_key = $1 AND listed", [sourceKey]);
  const gone = r.rows.filter((o) => !seenRefs.has(o.source_ref));
  for (const o of gone) await q.query("UPDATE bounty_observations SET listed = false, check_id = COALESCE($2, check_id) WHERE id = $1", [o.id, checkId]);
  const programs = [...new Set(gone.map((o) => o.program_id))];
  for (const id of programs) await recomputeProgram(q, await live(q, id), now, { checkId, sourceKey });
  return programs;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Operator actions

export const CORRECTABLE = ["projectName", "programmeName", "officialUrl", "maxReward", "rewardCurrency", "chains", "assetTypes", "kycRequired", "statusClaim"] as const;
export async function addCorrection(pool: Pool, programId: string, input: { field: string; value: unknown; note: string; by: string }, now = new Date()): Promise<Resolution> {
  if (!(CORRECTABLE as readonly string[]).includes(input.field)) throw new BountyError("invalid_field", `${input.field} cannot be corrected here`);
  if (!input.note.trim()) throw new BountyError("note_required", "a correction needs a note saying what it is based on");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = await live(client, programId);
    const exists = await client.query("SELECT 1 FROM bounty_programs WHERE id = $1", [id]);
    if (!exists.rowCount) throw new BountyError("not_found", "programme not found");
    const ref = `operator:${id}:${input.field}`;
    const prior = await client.query<{ fields: Record<string, unknown> }>("SELECT fields FROM bounty_observations WHERE source_key = 'operator' AND source_ref = $1", [ref]);
    const fields = { [input.field]: input.value, correctionNote: input.note.slice(0, 1000), correctedBy: input.by };
    if (prior.rows[0]) await client.query("UPDATE bounty_observations SET fields = $2, content_sha256 = $3, last_observed_at = $4 WHERE source_key = 'operator' AND source_ref = $1", [ref, JSON.stringify(fields), contentHash(fields), now]);
    else await client.query(`INSERT INTO bounty_observations (program_id, source_key, source_ref, match_basis, extraction_method, fields, content_sha256, source_author, first_observed_at, last_observed_at)
      VALUES ($1, 'operator', $2, 'operator', 'operator correction', $3, $4, $5, $6, $6)`, [id, ref, JSON.stringify(fields), contentHash(fields), input.by, now]);
    const r = await recomputeProgram(client, id, now, { sourceKey: "operator" });
    await client.query("COMMIT");
    return r;
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

export async function decideDuplicate(pool: Pool, candidateId: string, decision: "merge" | "reject", by: string, now = new Date()): Promise<{ survivor: string | null }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await client.query<{ program_a: string; program_b: string; status: string }>("SELECT program_a, program_b, status FROM bounty_duplicate_candidates WHERE id = $1 FOR UPDATE", [candidateId]);
    if (!c.rows[0]) throw new BountyError("not_found", "candidate not found");
    if (c.rows[0].status !== "open") throw new BountyError("invalid_state", `candidate is already ${c.rows[0].status}`);
    let survivor: string | null = null;
    if (decision === "merge") {
      const a = await live(client, c.rows[0].program_a); const b = await live(client, c.rows[0].program_b);
      if (a !== b) {
        const first = await client.query<{ id: string }>("SELECT id FROM bounty_programs WHERE id IN ($1, $2) ORDER BY (canonical_key IS NULL), first_seen_at LIMIT 1", [a, b]);
        survivor = first.rows[0]!.id; const absorbed = survivor === a ? b : a;
        await client.query("UPDATE bounty_observations SET program_id = $1 WHERE program_id = $2", [survivor, absorbed]);
        await client.query("UPDATE bounty_programs SET merged_into = $1, updated_at = $3 WHERE id = $2", [survivor, absorbed, now]);
        await client.query("INSERT INTO bounty_program_changes (program_id, field, old_value, new_value, source_key) VALUES ($1, '_merged', $2, $3, 'operator')",
          [survivor, JSON.stringify({ absorbed }), JSON.stringify({ by, candidate: candidateId })]);
        await recomputeProgram(client, survivor, now, { sourceKey: "operator" });
      } else survivor = a;
    }
    await client.query("UPDATE bounty_duplicate_candidates SET status = $2, decided_at = $3, decided_by = $4 WHERE id = $1", [candidateId, decision === "merge" ? "merged" : "rejected", now, by]);
    await client.query("COMMIT");
    return { survivor };
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

/**
 * Enable or disable a collection source (operator action). Enabling a source whose adapter is blocked, or that has no adapter, is
 * refused — a blocked source (Cantina; Immunefi until its terms decision keeps it off) cannot be turned on by mistake. Enabling sets
 * access_status to the given value (default 'permitted') and records the actor; this is the one authenticated call that acts on an
 * owner's source-access decision, instead of a manual database edit.
 */
export async function setBountySourceEnabled(pool: Pool, sourceKey: string, enabled: boolean, by: string, opts: { accessStatus?: string; adapterBlocked?: boolean; note?: string } = {}): Promise<{ sourceKey: string; enabled: boolean; accessStatus: string }> {
  const cur = (await pool.query<{ access_status: string; enabled: boolean }>("SELECT access_status, enabled FROM bounty_sources WHERE source_key = $1", [sourceKey])).rows[0];
  if (!cur) throw new BountyError("not_found", `no source ${sourceKey}`);
  if (enabled && opts.adapterBlocked) throw new BountyError("source_blocked", `${sourceKey} cannot be enabled: its access is blocked, not an owner decision`);
  const access = enabled ? (opts.accessStatus ?? "permitted") : (opts.accessStatus ?? cur.access_status);
  const r = (await pool.query<{ access_status: string; enabled: boolean }>(
    "UPDATE bounty_sources SET enabled = $2, access_status = $3, access_note = CASE WHEN $4::text IS NULL THEN access_note ELSE $4 END, updated_at = now() WHERE source_key = $1 RETURNING enabled, access_status",
    [sourceKey, enabled, access, opts.note ?? null])).rows[0]!;
  await pool.query("INSERT INTO bounty_collection_runs (trigger, started_by, started_at, finished_at, status, summary) VALUES ('manual', $1, now(), now(), 'succeeded', $2::jsonb)",
    [by, JSON.stringify({ action: enabled ? "source_enabled" : "source_disabled", source: sourceKey, access_status: access })]);
  return { sourceKey, enabled: r.enabled, accessStatus: r.access_status };
}
