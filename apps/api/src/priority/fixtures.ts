import type { OpportunityInput } from "./score.js";

/** Synthetic opportunities for T-051 (no real program data). Each isolates one property the policy must have. */
export const NOW = new Date("2026-11-26T00:00:00Z");
const comp = (id: string, hash: string, researched: string[] = []) => ({ id, contentSha256: hash, researchedAtHashes: researched, classesExamined: researched.length ? ["reentrancy", "access-control"] : [] });
const base = (id: string, over: Partial<OpportunityInput> = {}): OpportunityInput => ({
  id, title: id, maxRewardUsd: 50_000, deadline: null, publishedAt: "2026-06-01T00:00:00Z", lastMaterialChangeAt: null, scopeVerified: true, eligibilityKnown: true,
  repositoryVerified: true, currentCommit: "c".repeat(40), components: [comp("A", "h1"), comp("B", "h2")], audits: [], estimatedCostUnits: 200, ...over,
});

export const FIXTURES = {
  fresh: base("fresh", { publishedAt: "2026-11-24T00:00:00Z" }),
  stale: base("stale", { publishedAt: "2025-01-01T00:00:00Z" }),
  saturated: base("saturated", { publishedAt: "2025-01-01T00:00:00Z", components: [comp("A", "h1", ["h1"]), comp("B", "h2", ["h2"])],
    audits: [{ source: "audit-x", provenanceVerified: true, permittedUse: true, kind: "commit-specific", commitSha: "c".repeat(40), classesExamined: ["all"], verifiedFindings: 3 }] }),
  // same project after a new commit changed component B: only B becomes unexplored again, and recent change restores priority
  recovered: base("recovered", { publishedAt: "2025-01-01T00:00:00Z", lastMaterialChangeAt: "2026-11-25T00:00:00Z", currentCommit: "d".repeat(40),
    components: [comp("A", "h1", ["h1"]), comp("B", "h2-new", ["h2"])],
    audits: [{ source: "audit-x", provenanceVerified: true, permittedUse: true, kind: "commit-specific", commitSha: "c".repeat(40), classesExamined: ["all"], verifiedFindings: 3 }] }),
  // a heavily audited project where only one of four components was audited at this commit and none researched by us
  partlyAudited: base("partly-audited", { publishedAt: "2025-01-01T00:00:00Z", components: [comp("A", "h1"), comp("B", "h2"), comp("C", "h3"), comp("D", "h4")],
    audits: [{ source: "audit-y", provenanceVerified: true, permittedUse: true, kind: "commit-specific", commitSha: "c".repeat(40), classesExamined: ["reentrancy"], verifiedFindings: 0 }] }),
  // audit claims without provenance or permitted use must be ignored and flagged
  claimedOnly: base("claimed-only", { publishedAt: "2025-01-01T00:00:00Z", audits: [{ source: "marketing page", provenanceVerified: false, permittedUse: false, kind: "claimed", commitSha: null, classesExamined: ["all"], verifiedFindings: 0 }] }),
  unknowns: base("unknowns", { maxRewardUsd: null, estimatedCostUnits: null, scopeVerified: false, eligibilityKnown: false, repositoryVerified: false }),
  highReward: base("high-reward", { maxRewardUsd: 1_000_000, publishedAt: "2025-01-01T00:00:00Z" }),
};
