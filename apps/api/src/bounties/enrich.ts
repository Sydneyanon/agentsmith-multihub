/**
 * Autonomous programme -> repository enrichment. For an eligible programme that has no resolved repository, it fetches the programme's
 * OFFICIAL page (Sherlock / HackenProof — the only sources whose terms and robots permit this; Immunefi stays disabled), extracts the
 * in-scope GitHub repositories, verifies each repository's identity against GitHub, and records a mapping with evidence and a confidence
 * status. Only `officially_confirmed` / `official_documentation` mappings are allowed to enter research automatically (via
 * verifiedRepositoriesFor); inferred/unverified/rejected ones are recorded but never auto-researched.
 *
 * Respects robots.txt and source access policy. Makes no model calls. The HTTP getter and the GitHub source are injected, so the whole
 * flow runs against disposable Postgres with fixtures — but the same code uses the real SSRF-guarded fetch and GitHub source in prod.
 */
import type { Pool } from "pg";
import { AcquisitionError } from "../acquisition/errors.js";
import type { RepositorySource } from "../acquisition/github-source.js";
import { canonicalFromUrl } from "./canonical.js";
import { extractRepositoryReferences } from "./enrich-extract.js";
import { checkRobots, type HttpGet } from "./http.js";
import type { Resolution } from "./resolve.js";

/** Platforms whose official programme pages AgentSmith is permitted to fetch for enrichment. Immunefi/Cantina are excluded. */
export const ENRICHABLE_PLATFORMS = new Set(["sherlock", "hackenproof", "code4rena", "codehawks"]);

export type EnrichDeps = { get: HttpGet; github: Pick<RepositorySource, "getRepository">; robots?: Map<string, string | null>; now?: () => Date };
export type EnrichOptions = { maxProgrammes?: number };
export type MappingStatus = "officially_confirmed" | "official_documentation" | "inferred_unverified" | "rejected" | "unavailable";
export type ProgrammeEnrichment = {
  programmeId: string; officialUrl: string | null; platform: string | null;
  outcome: "enriched" | "no_repositories" | "skipped_source" | "robots_disallowed" | "fetch_error";
  verified: number; rejected: number; unavailable: number; dropped: number; error: string | null;
};

const SELECT_PROG = "SELECT id, resolved FROM bounty_programs WHERE id = $1 AND merged_into IS NULL";

function officialUrlOf(resolved: Resolution["resolved"] | undefined): string | null {
  const v = resolved?.officialUrl?.value;
  return typeof v === "string" ? v : null;
}

/** Enrich one programme: fetch its official page, extract + verify repositories, store mappings with provenance and confidence. */
export async function enrichProgramme(pool: Pool, deps: EnrichDeps, programmeId: string): Promise<ProgrammeEnrichment> {
  const now = deps.now ?? (() => new Date());
  const runAt = now();
  const prog = await pool.query<{ id: string; resolved: Resolution["resolved"] }>(SELECT_PROG, [programmeId]);
  const row = prog.rows[0];
  const officialUrl = officialUrlOf(row?.resolved);
  const platform = canonicalFromUrl(officialUrl)?.platform ?? null;
  const base: ProgrammeEnrichment = { programmeId, officialUrl, platform, outcome: "skipped_source", verified: 0, rejected: 0, unavailable: 0, dropped: 0, error: null };
  if (!row || !officialUrl || !platform || !ENRICHABLE_PLATFORMS.has(platform)) return base;

  const robots = await checkRobots(deps.get, officialUrl, deps.robots ?? new Map());
  if (!robots.allowed) return { ...base, outcome: "robots_disallowed", error: robots.reason };

  let body: string;
  try {
    const r = await deps.get(officialUrl, { maxBytes: 8 * 1024 * 1024 });
    if (r.status !== 200) return { ...base, outcome: "fetch_error", error: `HTTP ${r.status}` };
    body = r.body;
  } catch (e) { return { ...base, outcome: "fetch_error", error: (e as Error).message }; }

  const refs = extractRepositoryReferences(body);
  if (refs.length === 0) return { ...base, outcome: "no_repositories" };

  let verified = 0, rejected = 0, unavailable = 0;
  for (const ref of refs) {
    if (ref.auditor) {
      await upsert(pool, programmeId, ref.repository, { source_url: officialUrl, evidence: ref.evidence, discovery_method: "official_page", verification_status: "rejected", confidence: "low", default_branch: null, repository_github_id: null, note: "auditor/report repository, not the programme's own code", last_seen_at: null, now: runAt });
      rejected += 1; continue;
    }
    const [owner, repo] = ref.repository.split("/") as [string, string];
    try {
      const id = await deps.github.getRepository(owner, repo);
      await upsert(pool, programmeId, ref.repository, { source_url: officialUrl, evidence: ref.evidence, discovery_method: "official_page", verification_status: "official_documentation", confidence: id.archived ? "medium" : "high", default_branch: id.defaultBranch, repository_github_id: id.repositoryId, note: id.archived ? "archived" : null, last_seen_at: runAt, now: runAt });
      verified += 1;
    } catch (e) {
      if (e instanceof AcquisitionError && e.code === "repository_not_found") {
        await upsert(pool, programmeId, ref.repository, { source_url: officialUrl, evidence: ref.evidence, discovery_method: "official_page", verification_status: "unavailable", confidence: "low", default_branch: null, repository_github_id: null, note: "not found / not public", last_seen_at: null, now: runAt });
        unavailable += 1;
      } // transient GitHub error: leave the repo for the next run rather than record a wrong status
    }
  }
  // Scope change: a repository previously documented but NOT seen on the page this run (last_seen_at did not advance).
  const dropped = Number((await pool.query(
    "SELECT count(*)::int AS n FROM bounty_repository_mappings WHERE bounty_program_id = $1 AND verification_status = 'official_documentation' AND (last_seen_at IS NULL OR last_seen_at < $2)",
    [programmeId, runAt])).rows[0]!.n);
  return { programmeId, officialUrl, platform, outcome: "enriched", verified, rejected, unavailable, dropped, error: null };
}

type UpsertFields = { source_url: string; evidence: string; discovery_method: string; verification_status: MappingStatus; confidence: string; default_branch: string | null; repository_github_id: number | null; note: string | null; last_seen_at: Date | null; now: Date };
async function upsert(pool: Pool, programmeId: string, repository: string, f: UpsertFields): Promise<void> {
  await pool.query(
    `INSERT INTO bounty_repository_mappings (bounty_program_id, repository, source_url, evidence, discovery_method, verification_status, confidence, default_branch, repository_github_id, note, discovered_at, last_checked_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)
     ON CONFLICT (bounty_program_id, repository) DO UPDATE SET
       source_url = EXCLUDED.source_url, evidence = EXCLUDED.evidence, discovery_method = EXCLUDED.discovery_method,
       verification_status = EXCLUDED.verification_status, confidence = EXCLUDED.confidence, default_branch = EXCLUDED.default_branch,
       repository_github_id = EXCLUDED.repository_github_id, note = EXCLUDED.note, last_checked_at = EXCLUDED.last_checked_at,
       last_seen_at = COALESCE(EXCLUDED.last_seen_at, bounty_repository_mappings.last_seen_at)`,
    [programmeId, repository, f.source_url, f.evidence, f.discovery_method, f.verification_status, f.confidence, f.default_branch, f.repository_github_id, f.note, f.now, f.last_seen_at]);
}

/** Enrich eligible programmes that have no verified repository yet. Bounded by maxProgrammes. */
export async function enrichEligibleProgrammes(pool: Pool, deps: EnrichDeps, opts: EnrichOptions = {}): Promise<{ attempted: number; enriched: number; verified_repositories: number; results: ProgrammeEnrichment[] }> {
  const max = opts.maxProgrammes ?? 50;
  // Candidates: not-merged programmes on an enrichable platform that have no verified mapping and no already-resolved github repo.
  const rows = (await pool.query<{ id: string }>(
    `SELECT p.id FROM bounty_programs p
       WHERE p.merged_into IS NULL
         AND NOT EXISTS (SELECT 1 FROM bounty_repository_mappings m WHERE m.bounty_program_id = p.id AND m.verification_status IN ('officially_confirmed','official_documentation'))
       ORDER BY p.id LIMIT $1`, [max])).rows;
  const results: ProgrammeEnrichment[] = [];
  let enriched = 0, verifiedRepos = 0;
  for (const { id } of rows) {
    const r = await enrichProgramme(pool, deps, id);
    results.push(r);
    if (r.outcome === "enriched" && r.verified > 0) { enriched += 1; verifiedRepos += r.verified; }
  }
  return { attempted: rows.length, enriched, verified_repositories: verifiedRepos, results };
}

/** The repositories a programme may automatically research: only officially_confirmed / official_documentation mappings. */
export async function verifiedRepositoriesFor(pool: Pool, programmeId: string): Promise<string[]> {
  const rows = (await pool.query<{ repository: string }>(
    "SELECT repository FROM bounty_repository_mappings WHERE bounty_program_id = $1 AND verification_status IN ('officially_confirmed','official_documentation') ORDER BY repository",
    [programmeId])).rows;
  return rows.map((r) => r.repository);
}
