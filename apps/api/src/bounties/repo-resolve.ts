/**
 * Programme -> repository resolution (task 6, the biggest gap identified in the audit). A bounty programme's resolved record carries
 * an officialUrl (the platform page) and otherUrls (links a source attached — for Immunefi/the community board these include the
 * in-scope GitHub repositories). This turns those URLs into the `owner/name` form the existing repository_research workflow accepts.
 *
 * It is deliberately conservative: only github.com URLs, only the first two path segments, `.git` stripped, validated against the
 * same NAME_PART shape the acquisition layer enforces. A URL that points at a file/tree/blob inside a repo still resolves to the repo.
 * It does NOT fetch anything and makes no network calls; scope confirmation and commit pinning happen later in acquisition.
 */
import type { Resolution } from "./resolve.js";

const NAME_PART = /^[A-Za-z0-9._-]{1,100}$/;
// Owner/name paths that are github.com features, not repositories.
const RESERVED_OWNERS = new Set(["orgs", "sponsors", "features", "about", "pricing", "marketplace", "topics", "collections", "trending", "settings", "notifications", "login", "join", "apps"]);

/** Extract `owner/name` from a GitHub URL, or null if it is not a repository URL. */
export function githubRepoFromUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
  const segs = url.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0]!;
  let repo = segs[1]!;
  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (!NAME_PART.test(owner) || !NAME_PART.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function valueOf(resolved: Resolution["resolved"] | undefined, key: string): unknown {
  return resolved?.[key]?.value;
}
function asUrlArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export type ResolvedRepositories = {
  repositories: string[];      // unique owner/name, lowercased, in first-seen order
  officialUrl: string | null;  // the platform programme page, for provenance
  sources: Record<string, string>; // repository -> the URL it came from
};

/** Resolve the GitHub repositories a programme's resolved record points at (officialUrl + otherUrls). */
export function resolveProgrammeRepositories(resolved: Resolution["resolved"] | undefined): ResolvedRepositories {
  const officialUrl = typeof valueOf(resolved, "officialUrl") === "string" ? (valueOf(resolved, "officialUrl") as string) : null;
  const candidates = [officialUrl, ...asUrlArray(valueOf(resolved, "otherUrls"))].filter((u): u is string => typeof u === "string");
  const repositories: string[] = [];
  const sources: Record<string, string> = {};
  for (const u of candidates) {
    const repo = githubRepoFromUrl(u);
    if (repo && !repositories.includes(repo)) { repositories.push(repo); sources[repo] = u; }
  }
  return { repositories, officialUrl, sources };
}
