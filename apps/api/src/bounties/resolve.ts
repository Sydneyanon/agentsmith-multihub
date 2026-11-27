import type { ExtractedOpportunity } from "./types.js";

/**
 * Resolves a programme's displayed fields from everything its sources said. Pure and deterministic.
 * - Each field takes the value from the most authoritative source that states it (0 operator, 3 official platform, 4 community
 *   board, 5 X, 6 other); a tie goes to the most recent observation.
 * - Every differing value from another source is kept as a conflict, so a community figure never silently replaces an official
 *   one and an official figure never silently erases what the community reported.
 * - Verification and status come only from what sources actually said and when, never from the absence of a contrary signal.
 */
export type SourceKind = "official_platform" | "community_index" | "social" | "manual" | "operator";
export type ObservationInput = {
  id: string; sourceKey: string; sourceKind: SourceKind; authority: number; listed: boolean;
  firstObservedAt: string; lastObservedAt: string; sourceUrl: string | null; fields: Partial<ExtractedOpportunity> & Record<string, unknown>;
};
export type ResolvedField = { value: unknown; source: string; authority: number; observedAt: string; conflicts: Array<{ value: unknown; source: string; authority: number }> };
export type Resolution = {
  projectName: string;
  resolved: Record<string, ResolvedField>;
  status: "active" | "reported_active" | "paused" | "closed" | "no_longer_listed" | "unknown" | "requires_verification";
  statusBasis: string;
  verification: "official_confirmed" | "official_stale" | "community_reported" | "social_reported" | "unverified" | "conflicting";
  lastVerifiedAt: string | null;
  needsVerification: boolean;
  reasons: string[];
};

export const RESOLVED_FIELDS = [
  "projectName", "programmeName", "platform", "officialUrl", "maxReward", "rewardCurrency", "rewardText", "rewardType", "tiers", "chains",
  "technologies", "categories", "assetTypes", "kycRequired", "pocRequired", "submissionFee", "launchedAt", "sourceUpdatedAt", "description", "findingsCount",
] as const;
/** Fields where two sources disagreeing is a material conflict that blocks "confirmed". */
const MATERIAL = new Set(["maxReward", "rewardCurrency", "officialUrl", "platform"]);
export const OFFICIAL_FRESH_HOURS = 48;

const present = (v: unknown) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0) && v !== "";
const USD_PEGGED = /^(usd|usdc|usdt|dai|usds|pyusd)$/i;
const canonField = (f: string, v: unknown): unknown => (f === "rewardCurrency" && typeof v === "string" && USD_PEGGED.test(v.trim()) ? "USD" : v);
const canon = (v: unknown): string => JSON.stringify(Array.isArray(v) ? [...v].map((x) => (typeof x === "string" ? x.toLowerCase() : x)).sort() : typeof v === "string" ? v.trim().toLowerCase() : v);

export function resolveProgramme(observations: readonly ObservationInput[], now: Date): Resolution {
  const reasons: string[] = [];
  const pool = observations.some((o) => o.listed) ? observations.filter((o) => o.listed || o.sourceKind === "operator") : [...observations];
  const ordered = [...pool].sort((a, b) => a.authority - b.authority || b.lastObservedAt.localeCompare(a.lastObservedAt) || a.id.localeCompare(b.id));
  const resolved: Record<string, ResolvedField> = {};
  for (const f of RESOLVED_FIELDS) {
    const withValue = ordered.filter((o) => present(o.fields[f]));
    if (!withValue.length) continue;
    const top = withValue[0]!;
    const seen = new Set([canon(canonField(f, top.fields[f]))]);
    const conflicts: ResolvedField["conflicts"] = [];
    for (const o of withValue.slice(1)) {
      const c = canon(canonField(f, o.fields[f]));
      if (seen.has(c)) continue;
      seen.add(c); conflicts.push({ value: o.fields[f], source: o.sourceKey, authority: o.authority });
    }
    resolved[f] = { value: top.fields[f], source: top.sourceKey, authority: top.authority, observedAt: top.lastObservedAt, conflicts };
  }

  const official = observations.filter((o) => o.sourceKind === "official_platform");
  const officialListed = official.filter((o) => o.listed);
  const community = observations.filter((o) => o.sourceKind === "community_index");
  const communityListed = community.filter((o) => o.listed);
  const operatorStatus = observations.filter((o) => o.sourceKind === "operator" && o.fields.statusClaim).sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt))[0];
  const freshMs = OFFICIAL_FRESH_HOURS * 3600_000;
  const freshOfficial = officialListed.filter((o) => now.getTime() - Date.parse(o.lastObservedAt) <= freshMs);
  // Only official and community sources can make a record "conflicting"; a post or a manual page that disagrees is shown as a conflict
  // on the field but cannot by itself downgrade an official confirmation.
  const materialConflict = Object.entries(resolved).some(([k, v]) => MATERIAL.has(k) && v.conflicts.some((c) => c.authority <= 4));

  let verification: Resolution["verification"];
  let lastVerifiedAt: string | null = null;
  if (officialListed.length) {
    lastVerifiedAt = officialListed.map((o) => o.lastObservedAt).sort().at(-1)!;
    verification = materialConflict ? "conflicting" : freshOfficial.length ? "official_confirmed" : "official_stale";
    if (materialConflict) reasons.push("sources disagree on a material field; the official value is shown and the others are kept");
    if (!freshOfficial.length) reasons.push(`the official listing was last confirmed more than ${OFFICIAL_FRESH_HOURS} hours ago`);
  } else if (community.length) {
    verification = "community_reported"; reasons.push("reported by a community index; not yet confirmed on an official source by AgentSmith");
  } else if (observations.some((o) => o.sourceKind === "social")) {
    verification = "social_reported"; reasons.push("reported in a social-media post only");
  } else {
    verification = "unverified"; reasons.push("no official or community source confirms it yet");
  }

  let status: Resolution["status"]; let statusBasis: string;
  if (operatorStatus) {
    status = operatorStatus.fields.statusClaim === "active" ? "active" : (operatorStatus.fields.statusClaim as "paused" | "closed");
    statusBasis = `operator correction, ${operatorStatus.lastObservedAt.slice(0, 10)}`;
  } else if (officialListed.length) {
    const o = [...officialListed].sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt))[0]!;
    const claim = o.fields.statusClaim;
    status = claim === "paused" ? "paused" : claim === "closed" ? "closed" : "active";
    statusBasis = `${claim ? `marked ${claim}` : "listed"} on ${o.sourceKey}, checked ${o.lastObservedAt.slice(0, 16).replace("T", " ")} UTC`;
  } else if (official.length && !communityListed.length) {
    status = "no_longer_listed"; statusBasis = `no longer listed on ${official[0]!.sourceKey}`;
  } else if (communityListed.length) {
    const o = [...communityListed].sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt))[0]!;
    const claim = o.fields.statusClaim;
    status = claim === "paused" ? "paused" : claim === "closed" ? "closed" : "reported_active";
    statusBasis = `listed on ${o.sourceKey}, seen ${o.lastObservedAt.slice(0, 16).replace("T", " ")} UTC (community report)`;
  } else if (community.length) {
    status = "no_longer_listed"; statusBasis = `no longer listed on ${community[0]!.sourceKey}`;
  } else {
    status = "requires_verification"; statusBasis = "known only from a post or a manual import";
  }

  const maxReward = resolved.maxReward?.value;
  const needsVerification = verification !== "official_confirmed" || maxReward === undefined || status === "requires_verification";
  if (maxReward === undefined) reasons.push("no reward amount is stated by any source");
  const projectName = String(resolved.projectName?.value ?? observations[0]?.fields.projectName ?? "Unknown");
  return { projectName, resolved, status, statusBasis, verification, lastVerifiedAt, needsVerification, reasons };
}
