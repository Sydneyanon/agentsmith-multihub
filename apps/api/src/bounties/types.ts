/**
 * Workstream A (bounty intelligence collection). Independent of the research engine: nothing here creates a research run,
 * fetches a target, or tests anything. It reads public programme information through permitted methods only.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "informational" | "other";
export type RewardTier = { severity: Severity; asset: string | null; text: string; min: number | null; max: number | null };

/** What one source says about one opportunity. Every field is optional: a missing field is null, never guessed. */
export type ExtractedOpportunity = {
  /** Stable identity within the source (for the board: "<platform>:<id>"; for an X import: "<post url>#<n>"). */
  sourceRef: string;
  projectName: string;
  programmeName: string | null;
  platform: string | null;              // the bounty platform that hosts it, as the source states it
  officialUrl: string | null;           // the programme's own page on its platform or project site
  otherUrls: string[];                  // additional references (mirrors such as "Also on Mantis", linked pages)
  maxReward: number | null;
  rewardCurrency: string | null;
  rewardText: string | null;            // the reward as written, when not a plain number
  rewardType: "fixed" | "range" | "up_to" | "discretionary" | "percentage_capped" | null;
  tiers: RewardTier[];
  chains: string[];
  technologies: string[];
  categories: string[];
  assetTypes: string[];                 // smart contract, websites & apps, blockchain/DLT ...
  kycRequired: boolean | null;
  pocRequired: boolean | null;
  submissionFee: { amount: number; note: string | null } | null;
  launchedAt: string | null;            // ISO date
  sourceUpdatedAt: string | null;       // ISO date
  statusClaim: "active" | "paused" | "closed" | null;  // only when the source states it
  description: string | null;
  findingsCount: number | null;
  sourceTitle: string | null;
  sourceAuthor: string | null;
  publishedAt: string | null;
  /** Fields the extractor could not establish (for the "needs verification" signal and the detail view). */
  unresolved: string[];
};

export function emptyOpportunity(sourceRef: string, projectName: string): ExtractedOpportunity {
  return {
    sourceRef, projectName, programmeName: null, platform: null, officialUrl: null, otherUrls: [], maxReward: null, rewardCurrency: null,
    rewardText: null, rewardType: null, tiers: [], chains: [], technologies: [], categories: [], assetTypes: [], kycRequired: null,
    pocRequired: null, submissionFee: null, launchedAt: null, sourceUpdatedAt: null, statusClaim: null, description: null,
    findingsCount: null, sourceTitle: null, sourceAuthor: null, publishedAt: null, unresolved: [],
  };
}

/** The result of one source fetch. `complete` means the listing is the source's full current list, so absence means delisted. */
export type SourceFetchResult =
  | { ok: true; complete: boolean; httpStatus: number; bytes: number; contentSha256: string; pages: number; items: ExtractedOpportunity[]; notes: string[] }
  | { ok: false; httpStatus: number | null; error: string; retryable: boolean; retryAfterSeconds: number | null };

export class BountyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BountyError"; }
}
