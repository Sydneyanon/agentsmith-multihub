import { usdComparable } from "./money.js";
import type { Resolution } from "./resolve.js";

/**
 * Deterministic, explainable opportunity ranking. It does NOT estimate the chance of finding or being paid for a bug, exploitability,
 * or competition (no evidence of crowding is collected, so it is not scored). A large maximum reward is reward attractiveness only.
 * Each component is 0-100, or null when the data needed for it is missing; a null component is left out of the weighted average and
 * the explanation says so. Change SCORING_VERSION whenever any rule or weight changes: scores are stored per version.
 */
export const SCORING_VERSION = "bounty-rank/1";
export const WEIGHTS = { reward: 0.35, credibility: 0.25, suitability: 0.2, completeness: 0.1, freshness: 0.1 } as const;
export type Component = { score: number | null; why: string };
export type Score = { version: string; priority: number | null; components: Record<keyof typeof WEIGHTS, Component>; explanation: string[] };

const SMART_CONTRACT = /smart ?contract|solidity|evm|defi|blockchain|dlt|protocol|move|rust|cairo|vyper/i;
/** Post-incident bounties pay for recovering stolen funds or identifying attackers, not for reporting vulnerabilities. */
export const INCIDENT_RECOVERY = /\b(post-incident|forensics|hack (bounty|recovery)|recovery (bounty|program)|bounty hunt|stolen funds|exploiter)\b/i;
const WEB_ONLY = /^(web|websites?( & apps)?|apps?|mobile|websites and applications|web and mobile)$/i;

function round1(n: number): number { return Math.round(n * 10) / 10; }
function arr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : []; }

export function scoreProgramme(r: Resolution, meta: { now: Date; firstSeenAt: string; sourceCount: number }): Score {
  const v = (k: string) => r.resolved[k]?.value;
  const explanation: string[] = [];

  // 1. Reward attractiveness: log scale of the stated maximum in USD-comparable currency; $1k = 0, $10M+ = 100.
  const max = typeof v("maxReward") === "number" ? (v("maxReward") as number) : null;
  const usd = usdComparable(max, (v("rewardCurrency") as string | undefined) ?? null);
  const reward: Component = usd === null
    ? { score: null, why: max === null ? "no maximum reward is stated" : `maximum ${max} ${String(v("rewardCurrency"))} is not in a USD-comparable currency, so it is not scored` }
    : { score: round1(Math.max(0, Math.min(100, ((Math.log10(Math.max(usd, 1)) - 3) / 4) * 100))), why: `stated maximum ${usd.toLocaleString("en-US")} USD-equivalent (log scale: $1k = 0, $10M = 100)` };

  // 2. Programme credibility: who confirms it, not how attractive it is.
  const credTable: Record<Resolution["verification"], [number, string]> = {
    official_confirmed: [100, "listed on its official platform and confirmed by AgentSmith within 48 hours"],
    official_stale: [75, "listed on its official platform, but the confirmation is older than 48 hours"],
    conflicting: [55, "officially listed, but sources disagree on a material field"],
    community_reported: [r.resolved.officialUrl ? 55 : 40, r.resolved.officialUrl ? "reported by the community board with a link to an official platform page (not fetched by AgentSmith)" : "reported by the community board without an official link"],
    social_reported: [20, "known only from a social-media post"],
    unverified: [10, "no source confirms it"],
  };
  const [credScore, credWhy] = credTable[r.verification];
  const credibility: Component = { score: credScore, why: credWhy };

  // 3. Technical research suitability for this workspace (smart-contract research), from stated scope only.
  const assetish = [...arr(v("assetTypes")), ...arr(v("categories")), ...arr(v("technologies"))];
  const chains = arr(v("chains"));
  let suitability: Component;
  const title = `${String(v("projectName") ?? "")} ${String(v("programmeName") ?? "")}`;
  if (INCIDENT_RECOVERY.test(title)) suitability = { score: 5, why: "a post-incident recovery or forensics bounty (pays for recovering funds or identifying an attacker), not a vulnerability bounty" };
  else if (!assetish.length && !chains.length) suitability = { score: null, why: "no scope, asset type or chain is stated" };
  else {
    const sc = assetish.some((a) => SMART_CONTRACT.test(a)) || chains.length > 0;
    const webOnly = assetish.length > 0 && assetish.every((a) => WEB_ONLY.test(a.trim()));
    let s = webOnly ? 20 : sc ? 75 : 45; const notes: string[] = [webOnly ? "web/app scope only" : sc ? "smart-contract or blockchain scope stated" : "scope stated, not smart-contract specific"];
    if (chains.length) { s += 10; notes.push(`chains stated (${chains.slice(0, 4).join(", ")}${chains.length > 4 ? ", …" : ""})`); }
    if (v("kycRequired") === true) { s -= 10; notes.push("KYC required"); }
    const fee = v("submissionFee") as { amount: number } | undefined;
    if (fee && fee.amount > 0) { s -= 10; notes.push(`submission fee or stake of ${fee.amount}`); }
    suitability = { score: Math.max(0, Math.min(100, s)), why: notes.join("; ") };
  }

  // 4. Information completeness.
  const checks: Array<[string, boolean]> = [
    ["maximum reward", max !== null], ["reward tiers", arr(v("tiers")).length > 0], ["official link", !!v("officialUrl")], ["chains or assets", chains.length + assetish.length > 0],
    ["official status", r.verification === "official_confirmed" || r.verification === "official_stale"], ["last-updated date", !!v("sourceUpdatedAt")],
  ];
  const have = checks.filter(([, ok]) => ok).length;
  const completeness: Component = { score: round1((have / checks.length) * 100), why: `${have} of ${checks.length} key facts known${have < checks.length ? `; missing: ${checks.filter(([, ok]) => !ok).map(([n]) => n).join(", ")}` : ""}` };

  // 5. Freshness: when the source last says it changed, else when AgentSmith first saw it.
  const basis = (v("sourceUpdatedAt") as string | undefined) ?? null;
  const ref = basis ?? meta.firstSeenAt;
  const days = Math.max(0, (meta.now.getTime() - Date.parse(ref)) / 86_400_000);
  const freshness: Component = Number.isFinite(days)
    ? { score: round1(days <= 7 ? 100 : days <= 30 ? 80 : days <= 90 ? 55 : days <= 365 ? 30 : 10), why: `${basis ? "source last updated" : "first seen by AgentSmith"} ${Math.floor(days)} days ago` }
    : { score: null, why: "no date known" };

  const components = { reward, credibility, suitability, completeness, freshness };
  let total = 0; let weight = 0;
  for (const [k, c] of Object.entries(components) as Array<[keyof typeof WEIGHTS, Component]>) {
    if (c.score === null) { explanation.push(`${k}: not scored (${c.why})`); continue; }
    total += c.score * WEIGHTS[k]; weight += WEIGHTS[k];
    explanation.push(`${k} ${c.score} × ${WEIGHTS[k]}: ${c.why}`);
  }
  let priority = weight >= 0.5 ? round1(total / weight) : null;
  if (priority !== null && INCIDENT_RECOVERY.test(`${String(v("projectName") ?? "")} ${String(v("programmeName") ?? "")}`) && priority > 40) {
    explanation.push(`priority capped at 40 (from ${priority}): a recovery or forensics bounty is not a vulnerability-research opportunity`); priority = 40;
  }
  if (priority === null) explanation.push("too little is known to compute a priority (components covering less than half of the weight)");
  else if (weight < 1) explanation.push(`priority is the weighted average of the ${Math.round(weight * 100)}% of weight that could be scored`);
  if (meta.sourceCount > 1) explanation.push(`reported by ${meta.sourceCount} sources`);
  return { version: SCORING_VERSION, priority, components, explanation };
}
