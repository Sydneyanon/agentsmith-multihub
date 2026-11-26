import { z } from "zod";

/** The only outbound host discovery may contact in this phase. Configuration cannot change it. */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** Adapter configuration for `github_org_repos`: a platform that publishes one public repository per contest in a GitHub organisation. */
export const githubOrgConfigSchema = z.object({
  org: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "not a GitHub organisation name"),
  platform: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,60}$/),
  /** Repository names must start with this (case-insensitive). Empty accepts every public repository. */
  namePrefix: z.string().regex(/^[A-Za-z0-9._-]{0,60}$/).default(""),
  /** Names must begin YYYY-MM- (the convention contest platforms use for their audit repositories). */
  requireDatePrefix: z.boolean().default(false),
  maxItems: z.number().int().min(1).max(100).default(30),
}).strict();
export type GithubOrgConfig = z.infer<typeof githubOrgConfigSchema>;

export const SOURCE_KEY = /^[a-z0-9][a-z0-9_.-]{1,80}$/;

export type RepositoryCandidate = { repository: string; signal: string; confidence: "high" | "medium" | "low" };

/** What an adapter extracts from one item of a source. Every field here is a claim by the source, not a verified fact. */
export type NormalizedOpportunity = {
  canonicalKey: string;
  platform: string;
  title: string;
  sourceUrl: string;
  details: Record<string, unknown>;
  repositoryCandidates: RepositoryCandidate[];
  closed: boolean;
  createdAt: string | null;
};

export class DiscoveryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DiscoveryError"; }
}
