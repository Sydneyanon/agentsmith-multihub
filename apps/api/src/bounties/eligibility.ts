import { canonicalFromUrl } from "./canonical.js";
import { INCIDENT_RECOVERY } from "./rank.js";
import type { Resolution } from "./resolve.js";

/**
 * The distinction the dashboard must make honest: a collected lead is not a programme AgentSmith can hunt. This classifies a
 * resolved programme into one tier, deterministically, from what the sources actually state. It never invents official verification:
 * only a programme an official source confirmed (verification === "official_confirmed") can reach "eligible". AgentSmith hunts
 * Solidity/EVM only, so a web/app-only programme is out of this engine's scope however attractive its reward.
 *
 * Tiers (worst to best):
 * - ineligible: a recovery/forensics bounty (pays for recovering funds, not for reporting a vulnerability), or no stated reward.
 * - out_of_engine_scope: a real bounty, but not smart-contract/blockchain work this engine can analyse.
 * - needs_verification: engine-suitable and reward-bearing, but NOT officially confirmed by AgentSmith (a community/social report).
 *   This is the candidate pool. It becomes "eligible" only after official confirmation.
 * - eligible: officially confirmed, engine-suitable, reward-bearing. A human still verifies the exact repository and scope before any
 *   investigation (the engine's verify -> select gate); "eligible" means it has cleared the data bar, not that work may start.
 */
export type EligibilityTier = "eligible" | "needs_verification" | "out_of_engine_scope" | "ineligible";
export type Eligibility = {
  tier: EligibilityTier;
  engineSuitable: boolean;      // smart-contract/blockchain scope AND a recognised official platform URL
  confirmable: "automated" | "manual_only" | "already_official";
  reasons: string[];
};

const SMART_CONTRACT = /smart ?contract|solidity|evm|defi|blockchain|dlt|protocol|move|rust|cairo|vyper|zk|yul|huff/i;
const WEB_ONLY = /^(web|websites?( ?& ?apps)?|apps?|mobile|websites and applications|web and mobile|api)$/i;
/** Platforms whose official listing AgentSmith is permitted to read (robots allow; no automated-access ban). */
const AUTO_CONFIRMABLE = new Set(["sherlock", "hackenproof", "code4rena", "codehawks"]);

function val(r: Resolution, k: string): unknown { return r.resolved[k]?.value; }
function arr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : []; }

export function classifyEligibility(r: Resolution): Eligibility {
  const reasons: string[] = [];
  const title = `${String(val(r, "projectName") ?? "")} ${String(val(r, "programmeName") ?? "")}`;
  const maxReward = val(r, "maxReward");
  const officialUrl = val(r, "officialUrl") as string | undefined;
  const canonical = canonicalFromUrl(officialUrl);
  const platform = canonical?.platform ?? null;
  const scopeWords = [...arr(val(r, "assetTypes")), ...arr(val(r, "categories")), ...arr(val(r, "technologies"))];
  const chains = arr(val(r, "chains"));
  const smartContract = scopeWords.some((a) => SMART_CONTRACT.test(a)) || chains.length > 0;
  const webOnly = scopeWords.length > 0 && scopeWords.every((a) => WEB_ONLY.test(a.trim())) && chains.length === 0;
  const engineSuitable = smartContract && !!canonical;

  const confirmable: Eligibility["confirmable"] = r.verification === "official_confirmed" ? "already_official"
    : platform && AUTO_CONFIRMABLE.has(platform) ? "automated" : "manual_only";
  if (confirmable === "automated") reasons.push(`official status is confirmable on ${platform} (a source AgentSmith may read)`);
  if (confirmable === "manual_only" && platform) reasons.push(`${platform} is not read automatically (terms/robots); official status needs a human check or a one-off operator import`);

  if (INCIDENT_RECOVERY.test(title)) { reasons.push("a recovery/forensics bounty: pays for recovering funds or identifying an attacker, not for reporting a vulnerability"); return { tier: "ineligible", engineSuitable: false, confirmable, reasons }; }
  if (maxReward === undefined || maxReward === null) { reasons.push("no reward is stated by any source"); return { tier: "ineligible", engineSuitable, confirmable, reasons }; }
  if (!canonical) { reasons.push("no recognised official programme URL, so no repository can be found yet"); return { tier: "out_of_engine_scope", engineSuitable: false, confirmable, reasons }; }
  if (webOnly) { reasons.push("web/app scope only; this engine analyses smart contracts"); return { tier: "out_of_engine_scope", engineSuitable: false, confirmable, reasons }; }
  if (!smartContract) { reasons.push("no smart-contract or blockchain scope is stated"); return { tier: "out_of_engine_scope", engineSuitable: false, confirmable, reasons }; }

  if (r.verification === "official_confirmed") { reasons.push("officially confirmed, smart-contract scoped, reward stated: a human still verifies the exact repository and scope before any investigation"); return { tier: "eligible", engineSuitable, confirmable, reasons }; }
  reasons.push("smart-contract scoped with a stated reward, but not yet confirmed on an official source by AgentSmith");
  return { tier: "needs_verification", engineSuitable, confirmable, reasons };
}

/** The honest headline counts for a set of resolutions. */
export function eligibilitySummary(tiers: readonly Eligibility[]): Record<string, number> {
  const s = { total: tiers.length, eligible: 0, needs_verification: 0, out_of_engine_scope: 0, ineligible: 0, engine_suitable: 0, auto_confirmable: 0, manual_only: 0 };
  for (const t of tiers) {
    s[t.tier] += 1;
    if (t.engineSuitable) s.engine_suitable += 1;
    if (t.tier !== "eligible" && t.tier !== "ineligible" && t.engineSuitable) { if (t.confirmable === "automated") s.auto_confirmable += 1; else if (t.confirmable === "manual_only") s.manual_only += 1; }
  }
  return s;
}
