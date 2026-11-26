import { z } from "zod";
import { DiscoveryError, GITHUB_API_ORIGIN, type GithubOrgConfig, type NormalizedOpportunity } from "./types.js";

/**
 * Documented GitHub REST API: GET /orgs/{org}/repos (public repositories, newest first).
 * Only the fields used below are read; everything else the API returns is ignored. Nullable fields are tolerated.
 */
const repoSchema = z.object({
  name: z.string().min(1).max(200),
  full_name: z.string().min(3).max(300),
  html_url: z.string().url().max(2000),
  description: z.string().max(5000).nullable().optional(),
  archived: z.boolean().optional(),
  fork: z.boolean().optional(),
  private: z.boolean().optional(),
  created_at: z.string().nullable().optional(),
  pushed_at: z.string().nullable().optional(),
  topics: z.array(z.string().max(100)).max(50).optional(),
}).passthrough();
const listSchema = z.array(repoSchema).max(200);

export function orgReposUrl(config: GithubOrgConfig): string {
  return `${GITHUB_API_ORIGIN}/orgs/${encodeURIComponent(config.org)}/repos?type=public&sort=created&direction=desc&per_page=100`;
}

const DATE_PREFIX = /^\d{4}-(0[1-9]|1[0-2])-/;

/** Parses a response body into opportunities. Throws DiscoveryError("bad_shape") when the body is not what the API documents. */
export function parseOrgRepos(body: unknown, config: GithubOrgConfig): { items: NormalizedOpportunity[]; seen: number } {
  const parsed = listSchema.safeParse(body);
  if (!parsed.success) throw new DiscoveryError("bad_shape", `unexpected response shape: ${parsed.error.issues[0]?.message ?? "unknown"} at ${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
  const prefix = config.namePrefix.toLowerCase();
  const items: NormalizedOpportunity[] = [];
  for (const repo of parsed.data) {
    if (repo.private === true || repo.fork === true) continue;
    if (!repo.full_name.toLowerCase().startsWith(`${config.org.toLowerCase()}/`)) continue; // the API must not hand us another owner's repository
    if (prefix && !repo.name.toLowerCase().startsWith(prefix)) continue;
    if (config.requireDatePrefix && !DATE_PREFIX.test(repo.name)) continue;
    const key = `github:${repo.full_name.toLowerCase()}`;
    if (!/^[a-z0-9:_./-]{3,255}$/.test(key)) continue; // a name the database would refuse is skipped, not guessed at
    items.push({
      canonicalKey: key,
      platform: config.platform,
      title: repo.name,
      sourceUrl: repo.html_url,
      details: {
        description: repo.description ?? null,
        created_at: repo.created_at ?? null,
        pushed_at: repo.pushed_at ?? null,
        archived: repo.archived === true,
        topics: repo.topics ?? [],
      },
      repositoryCandidates: [{ repository: repo.full_name, signal: `public repository in the ${config.org} GitHub organisation (${config.platform} publishes one per contest)`, confidence: "high" }],
      closed: repo.archived === true,
      createdAt: repo.created_at ?? null,
    });
    if (items.length >= config.maxItems) break;
  }
  return { items, seen: parsed.data.length };
}
