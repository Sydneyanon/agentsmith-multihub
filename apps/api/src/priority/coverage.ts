/**
 * Research coverage and audit saturation (T-052), on fixtures only. Pure functions: no database, no network, no learned values.
 *
 * Coverage is recorded per COMPONENT at a CONTENT HASH, never per project or per repository:
 *  - a component counts as covered only for the vulnerability classes examined at its current content hash; changed code is never covered;
 *  - a third-party audit counts only when its provenance and permitted use are established, only for the components it names, and only
 *    while each named component still has the content hash it had at the audited commit; a "claimed" audit (no commit-specific evidence)
 *    is discounted, and an audit is never proof of saturation (owner policy, 2026-11-26);
 *  - the project figure is a weighted mean of its components, so one heavily audited contract lowers only its own share.
 *
 * This module does not change scoring policy v1 (`score.ts`), which stays the frozen deterministic baseline. Feeding these figures into
 * a future policy is a recorded, versioned decision (design document section 10).
 */

export type CoverageMethod = "structural" | "execution" | "manual-review";
export type ComponentSnapshot = {
  /** stable component identity (e.g. `path#Contract`) */
  id: string;
  /** hash of the component's current content */
  contentSha256: string;
  /** relative size used for weighting (e.g. number of externally reachable functions); must be > 0 */
  weight: number;
};
/** One piece of AgentSmith research on a component at a given content hash. */
export type CoverageRecord = { componentId: string; contentSha256: string; commitSha: string; classesExamined: string[]; method: CoverageMethod; recordedAt: string };
/** A third-party audit, as an evidence-backed claim. `componentHashes` maps each component the report names to its hash at the audited commit. */
export type AuditEvidence = {
  source: string; provenanceVerified: boolean; permittedUse: boolean;
  kind: "commit-specific" | "claimed"; commitSha: string | null;
  componentHashes: Record<string, string>;
  classesExamined: string[]; verifiedFindings: number;
};
export type CoveragePolicy = { version: string; claimedAuditDiscount: number; commitAuditReliability: number };
export const COVERAGE_POLICY_V1: CoveragePolicy = {
  version: "coverage-policy/1",
  // A claimed audit (coverage asserted, no commit-specific evidence) counts for a quarter of what it claims; a commit-specific audit at the
  // unchanged component counts at 0.8, not 1.0, because an audit is never proof that nothing remains. Both are reviewed, named values.
  claimedAuditDiscount: 0.25,
  commitAuditReliability: 0.8,
};

export type ComponentAssessment = {
  id: string; weight: number;
  status: "researched-at-current-version" | "changed-since-research" | "never-researched";
  /** classes examined by AgentSmith at the current content hash */
  classesCoveredNow: string[];
  ownCoverage: number; auditCoverage: number; saturation: number;
  reasons: string[];
};
export type ProjectCoverage = {
  policyVersion: string; classes: string[]; components: ComponentAssessment[];
  /** weighted mean saturation over components (0..1) */
  saturation: number;
  /** weight share of components with no usable coverage at their current version (0..1) */
  unexploredShare: number;
  /** components whose code changed since we last researched them: these are where priority should recover */
  changedSinceResearch: string[];
  ignoredAudits: string[];
};

const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0;

export function assessCoverage(
  components: readonly ComponentSnapshot[], records: readonly CoverageRecord[], audits: readonly AuditEvidence[],
  classes: readonly string[], policy: CoveragePolicy = COVERAGE_POLICY_V1,
): ProjectCoverage {
  if (!classes.length) throw new Error("coverage needs the list of vulnerability classes it is measured against");
  for (const c of components) if (!(c.weight > 0)) throw new Error(`component ${c.id} has a non-positive weight`);
  const ignoredAudits = audits.filter((a) => !(a.provenanceVerified && a.permittedUse)).map((a) => `${a.source}: provenance or permitted use not established (ignored)`);
  const usable = audits.filter((a) => a.provenanceVerified && a.permittedUse);
  const classSet = new Set(classes);
  const frac = (examined: Iterable<string>) => { const s = new Set<string>(); for (const k of examined) { if (k === "all") return 1; if (classSet.has(k)) s.add(k); } return s.size / classSet.size; };

  const out: ComponentAssessment[] = components.map((c) => {
    const mine = records.filter((r) => r.componentId === c.id);
    const atNow = mine.filter((r) => r.contentSha256 === c.contentSha256);
    const classesCoveredNow = [...new Set(atNow.flatMap((r) => r.classesExamined))].filter((k) => classSet.has(k)).sort();
    const status = atNow.length ? "researched-at-current-version" : mine.length ? "changed-since-research" : "never-researched";
    const reasons: string[] = [];
    if (status === "changed-since-research") reasons.push("researched before, but the code changed since: not covered");
    const ownCoverage = frac(classesCoveredNow);
    if (atNow.length) reasons.push(`researched at the current version for ${classesCoveredNow.length}/${classSet.size} classes`);

    let auditCoverage = 0;
    for (const a of usable) {
      const hashAtAudit = a.componentHashes[c.id];
      if (hashAtAudit === undefined) continue; // the report does not name this component: it says nothing about it
      if (hashAtAudit !== c.contentSha256) { reasons.push(`${a.source}: audited an earlier version of this component (changed since): not counted`); continue; }
      const factor = a.kind === "commit-specific" && a.commitSha ? policy.commitAuditReliability : policy.claimedAuditDiscount;
      const v = frac(a.classesExamined) * factor;
      reasons.push(`${a.source}: ${a.kind} audit of this exact version, ${r3(frac(a.classesExamined))} of classes, counted at ${factor}`);
      auditCoverage = Math.max(auditCoverage, v);
    }
    // coverage sources are not added together (that would double-count the same classes); the stronger one stands
    const saturation = Math.max(ownCoverage, auditCoverage);
    if (status === "never-researched" && auditCoverage === 0) reasons.push("no usable coverage at the current version");
    return { id: c.id, weight: c.weight, status, classesCoveredNow, ownCoverage: r3(ownCoverage), auditCoverage: r3(auditCoverage), saturation: r3(saturation), reasons };
  });

  const total = out.reduce((s, c) => s + c.weight, 0);
  return {
    policyVersion: policy.version, classes: [...classes],
    components: out,
    saturation: total ? r3(out.reduce((s, c) => s + c.weight * c.saturation, 0) / total) : 0,
    unexploredShare: total ? r3(out.filter((c) => c.saturation === 0).reduce((s, c) => s + c.weight, 0) / total) : 1,
    changedSinceResearch: out.filter((c) => c.status === "changed-since-research").map((c) => c.id),
    ignoredAudits,
  };
}
