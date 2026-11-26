import { createHash } from "node:crypto";
import { POLICY_V1, type PriorityPolicy } from "./policy.js";

/**
 * Transparent deterministic priority scoring v1 (T-051). Every point is a named contribution with its raw input, weight and reason;
 * the same inputs and policy always give the same score. It ranks; it does not predict. No probability is produced or implied.
 */
export type AuditClaim = {
  source: string; provenanceVerified: boolean; permittedUse: boolean;
  /** `commit-specific`: the report names the exact commit it reviewed; `claimed`: coverage is asserted without that */
  kind: "commit-specific" | "claimed"; commitSha: string | null; classesExamined: string[]; verifiedFindings: number;
};
export type ComponentCoverage = {
  id: string; contentSha256: string;
  /** content hashes of this component that AgentSmith has actually researched (version-aware) */
  researchedAtHashes: string[]; classesExamined: string[];
};
export type OpportunityInput = {
  id: string; title: string;
  maxRewardUsd: number | null; deadline: string | null; publishedAt: string | null; lastMaterialChangeAt: string | null;
  scopeVerified: boolean; eligibilityKnown: boolean; repositoryVerified: boolean;
  currentCommit: string | null; components: ComponentCoverage[]; audits: AuditClaim[];
  estimatedCostUnits: number | null; // relative research cost (e.g. analysed functions); null = unknown
};
export type Contribution = { feature: string; raw: string; weight: number; points: number; reason: string };
export type PriorityAssessment = {
  id: string; score: number; contributions: Contribution[]; flags: string[]; explorationCandidate: boolean;
  unexploredShare: number; policyVersion: string; inputsSha256: string;
};

const DAY = 86_400_000;
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const round = (x: number) => Math.round(x * 100) / 100 + 0; // + 0 normalises -0

export function scoreOpportunity(o: OpportunityInput, now: Date, policy: PriorityPolicy = POLICY_V1): PriorityAssessment {
  const w = policy.weights; const c: Contribution[] = []; const flags: string[] = [];
  const add = (feature: string, raw: string, weight: number, fraction: number, reason: string) => c.push({ feature, raw, weight, points: round(weight * fraction), reason });

  // economics
  if (o.maxRewardUsd === null) { flags.push("reward unknown"); add("reward", "unknown", w.reward, 0, "no reward information: contributes nothing (flagged, not guessed)"); }
  else add("reward", `$${o.maxRewardUsd}`, w.reward, clamp(Math.log10(1 + o.maxRewardUsd) / Math.log10(1 + policy.rewardScaleUsd)), "log-scaled maximum reward against the policy scale");
  if (o.deadline) { const days = (Date.parse(o.deadline) - now.getTime()) / DAY; if (days < 0) { flags.push("deadline passed"); add("deadline", `${Math.round(days)}d`, w.deadline, 0, "deadline has passed"); } else add("deadline", `${Math.round(days)}d left`, w.deadline, clamp(1 - days / 60), "sooner deadlines rank higher (time-sensitive)"); }
  else add("deadline", "none", w.deadline, 0, "no deadline (standing program)");

  // freshness: a bounded, decaying signal, never a guarantee
  const fresh = o.publishedAt ? Math.pow(0.5, Math.max(0, now.getTime() - Date.parse(o.publishedAt)) / DAY / policy.freshnessHalfLifeDays) : 0;
  add("freshness", o.publishedAt ?? "unknown", w.freshness, fresh, `newly published opportunities get attention that halves every ${policy.freshnessHalfLifeDays} days`);
  const change = o.lastMaterialChangeAt ? Math.pow(0.5, Math.max(0, now.getTime() - Date.parse(o.lastMaterialChangeAt)) / DAY / policy.freshnessHalfLifeDays) : 0;
  add("recent-change", o.lastMaterialChangeAt ?? "none", w.recentChange, change, "recent material change (commit, upgrade, new asset or integration) restores priority");

  // version-aware coverage: a component counts as researched only at its CURRENT content hash
  const total = o.components.length;
  const unexplored = total ? o.components.filter((k) => !k.researchedAtHashes.includes(k.contentSha256)).length : 0;
  const unexploredShare = total ? unexplored / total : 1;
  add("unexplored", total ? `${unexplored}/${total} components not researched at their current version` : "no component map yet", w.unexplored, unexploredShare, "unexplored or changed components are worth more research");
  // saturation: only components researched at their current version AND covered by evidence-backed, permitted, commit-specific audits
  const usable = o.audits.filter((a) => a.provenanceVerified && a.permittedUse);
  if (o.audits.length > usable.length) flags.push(`${o.audits.length - usable.length} audit claim(s) ignored: provenance or permitted use not established`);
  const commitAudit = usable.filter((a) => a.kind === "commit-specific" && a.commitSha !== null && a.commitSha === o.currentCommit);
  const researchedNow = total - unexplored;
  const saturation = total ? (researchedNow / total) * (commitAudit.length ? 1 : 0.5) : 0;
  add("saturation", `${researchedNow}/${total} researched at current version; ${commitAudit.length} commit-specific audit(s) of this commit; ${usable.length - commitAudit.length} other usable audit claim(s)`, -w.saturationPenalty, saturation,
    "saturation lowers priority only for components researched at their current version; audits count fully only for the exact commit and never saturate the whole project by themselves");

  add("scope-verified", String(o.scopeVerified), w.scopeVerified, o.scopeVerified ? 1 : 0, "verified scope makes research actionable");
  if (!o.scopeVerified) flags.push("scope unverified");
  add("eligibility-known", String(o.eligibilityKnown), w.eligibilityKnown, o.eligibilityKnown ? 1 : 0, "known eligibility terms");
  if (!o.repositoryVerified) flags.push("repository not verified as official");
  if (o.estimatedCostUnits === null) { flags.push("cost unknown"); add("cost", "unknown", -w.costPenalty, 0, "cost unknown: no penalty applied (flagged)"); }
  else add("cost", `${o.estimatedCostUnits} units`, -w.costPenalty, clamp(Math.log10(1 + o.estimatedCostUnits) / 5), "larger estimated research cost lowers priority");
  add("uncertainty", `${flags.length} flag(s)`, -w.uncertaintyPenalty, clamp(flags.length / 4), "each open uncertainty lowers rank a little; it is shown, not hidden");

  const raw = c.reduce((s, x) => s + x.points, 0);
  const max = Object.entries(w).filter(([k]) => !/Penalty$/.test(k)).reduce((s, [, v]) => s + v, 0);
  const score = round(clamp(raw / max) * 100);
  const inputsSha256 = createHash("sha256").update(JSON.stringify({ o, now: now.toISOString(), policy })).digest("hex");
  return { id: o.id, score, contributions: c, flags, explorationCandidate: unexploredShare >= 0.5 || total === 0, unexploredShare: round(unexploredShare), policyVersion: policy.version, inputsSha256 };
}

/** Deterministic, seeded pseudo-random generator (mulberry32) so exploration picks are reproducible from the logged seed. */
function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export type Allocation = { id: string; mode: "exploit" | "explore"; score: number; reason: string };
/** Splits `slots` into exploitation (top scores) and exploration (seeded draw among exploration candidates not already chosen). */
export function allocate(assessments: readonly PriorityAssessment[], slots: number, seed: number, policy: PriorityPolicy = POLICY_V1): { allocations: Allocation[]; exploreSlots: number; seed: number; policyVersion: string } {
  const exploreSlots = Math.min(Math.round(slots * policy.explorationShare), slots); const exploitSlots = slots - exploreSlots;
  const ranked = [...assessments].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const out: Allocation[] = ranked.slice(0, exploitSlots).map((a, i) => ({ id: a.id, mode: "exploit" as const, score: a.score, reason: `rank ${i + 1} by score` }));
  const chosen = new Set(out.map((x) => x.id)); const pool = ranked.filter((a) => !chosen.has(a.id) && a.explorationCandidate);
  const r = rng(seed);
  for (let i = 0; i < exploreSlots && pool.length; i++) {
    const k = Math.floor(r() * pool.length); const a = pool.splice(k, 1)[0]!;
    out.push({ id: a.id, mode: "explore", score: a.score, reason: `exploration draw ${i + 1} (seed ${seed}) among ${pool.length + 1} low-coverage candidates` });
  }
  // if there were not enough exploration candidates, the remaining slots fall back to the next best scores, and say so
  for (const a of ranked) { if (out.length >= slots) break; if (!out.some((x) => x.id === a.id)) out.push({ id: a.id, mode: "exploit", score: a.score, reason: "exploration pool exhausted: next best score" }); }
  return { allocations: out, exploreSlots, seed, policyVersion: policy.version };
}
