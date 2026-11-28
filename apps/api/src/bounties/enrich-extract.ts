/**
 * Extract candidate GitHub repositories from a programme's official page text (task: enrichment). Pure and deterministic: given the
 * page body (HTML or RSC markdown — GitHub URLs appear as plain links in both), it returns the distinct `owner/name` repositories with
 * a short evidence snippet and whether the owner is a known audit firm / report host (which is a target's reviewer, not the target).
 *
 * It does not decide confidence — the enrichment service does, after verifying each repository's identity against GitHub. It never
 * invents a repository: it only reports what the official page literally references.
 */
import { githubRepoFromUrl } from "./repo-resolve.js";

/** Owners that host audit reports / contest code, not a project's own in-scope repository. Their repos are reported but rejected. */
export const AUDITOR_OWNERS = new Set([
  "mixbytes", "spearbit", "trailofbits", "consensys", "consensys-diligence", "code-423n4", "sherlock-audit", "sherlockdefi",
  "cyfrin", "zokyo", "hacken", "hackenproof", "openzeppelin", "certik", "peckshield", "quantstamp", "slowmist", "halborn",
  "chainsecurity", "dedaub", "oak-security", "pashov-audit-group", "guardianaudits", "cantina", "immunefi", "immunefi-team",
]);

export type RepoReference = { repository: string; evidence: string; auditor: boolean };

const GITHUB_URL = /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[/#?][^\s"'<>)\]]*)?/gi;

export function extractRepositoryReferences(pageText: string): RepoReference[] {
  const found = new Map<string, RepoReference>();
  for (const m of pageText.matchAll(GITHUB_URL)) {
    const repository = githubRepoFromUrl(m[0]);
    if (!repository || found.has(repository)) continue;
    const owner = repository.split("/")[0]!;
    const start = Math.max(0, m.index - 60);
    const evidence = pageText.slice(start, m.index + m[0].length + 20).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    found.set(repository, { repository, evidence, auditor: AUDITOR_OWNERS.has(owner) });
  }
  return [...found.values()];
}
