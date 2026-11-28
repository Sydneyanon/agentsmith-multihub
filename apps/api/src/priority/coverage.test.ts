import { describe, expect, it } from "vitest";
import { assessCoverage, COVERAGE_POLICY_V1, type AuditEvidence, type ComponentSnapshot, type CoverageRecord } from "./coverage.js";

const CLASSES = ["reentrancy", "access-control", "initializer", "delegatecall"];
const C = (id: string, hash: string, weight = 1): ComponentSnapshot => ({ id, contentSha256: hash, weight });
const R = (componentId: string, contentSha256: string, classesExamined: string[]): CoverageRecord => ({ componentId, contentSha256, commitSha: "a".repeat(40), classesExamined, method: "structural", recordedAt: "2026-11-01T00:00:00Z" });
const audit = (over: Partial<AuditEvidence> = {}): AuditEvidence => ({ source: "audit-firm", provenanceVerified: true, permittedUse: true, kind: "commit-specific", commitSha: "a".repeat(40), componentHashes: {}, classesExamined: ["all"], verifiedFindings: 2, ...over });

describe("research coverage and audit saturation (T-052, fixtures)", () => {
  it("an unchanged component researched for every class is saturated, with reasons", () => {
    const p = assessCoverage([C("Vault", "h1")], [R("Vault", "h1", CLASSES)], [], CLASSES);
    expect(p.components[0]).toMatchObject({ status: "researched-at-current-version", ownCoverage: 1, saturation: 1 });
    expect(p.saturation).toBe(1); expect(p.unexploredShare).toBe(0);
    expect(p.components[0]!.reasons.join(" ")).toMatch(/current version for 4\/4 classes/);
  });

  it("changed code is never treated as covered, by our research or by an audit of the earlier version", () => {
    const p = assessCoverage([C("Vault", "h1-new")], [R("Vault", "h1", CLASSES)], [audit({ componentHashes: { Vault: "h1" } })], CLASSES);
    expect(p.components[0]).toMatchObject({ status: "changed-since-research", ownCoverage: 0, auditCoverage: 0, saturation: 0 });
    expect(p.changedSinceResearch).toEqual(["Vault"]); expect(p.unexploredShare).toBe(1);
  });

  it("one heavily audited contract does not lower the whole project: saturation is weighted by component", () => {
    const comps = [C("Core", "h1", 1), C("Router", "h2", 1), C("Oracle", "h3", 1), C("Bridge", "h4", 1)];
    const p = assessCoverage(comps, [], [audit({ componentHashes: { Core: "h1" } })], CLASSES);
    expect(p.components.find((c) => c.id === "Core")!.saturation).toBe(COVERAGE_POLICY_V1.commitAuditReliability);
    for (const id of ["Router", "Oracle", "Bridge"]) expect(p.components.find((c) => c.id === id)!.saturation).toBe(0);
    expect(p.saturation).toBe(0.2); // 0.8 on one of four equal components
    expect(p.unexploredShare).toBe(0.75);
  });

  it("an audit is never proof of saturation: even a full commit-specific audit counts below our own complete research", () => {
    const p = assessCoverage([C("Vault", "h1")], [], [audit({ componentHashes: { Vault: "h1" } })], CLASSES);
    expect(p.components[0]!.saturation).toBeLessThan(1);
  });

  it("unverified audit claims are discounted (claimed) or ignored (no provenance or no permitted use), and say so", () => {
    const comps = [C("Vault", "h1")];
    const claimed = assessCoverage(comps, [], [audit({ kind: "claimed", commitSha: null, componentHashes: { Vault: "h1" } })], CLASSES);
    expect(claimed.components[0]!.auditCoverage).toBe(COVERAGE_POLICY_V1.claimedAuditDiscount);
    const noProvenance = assessCoverage(comps, [], [audit({ provenanceVerified: false, componentHashes: { Vault: "h1" } })], CLASSES);
    expect(noProvenance.components[0]!.auditCoverage).toBe(0); expect(noProvenance.ignoredAudits[0]).toMatch(/provenance or permitted use/);
    const notPermitted = assessCoverage(comps, [], [audit({ permittedUse: false, componentHashes: { Vault: "h1" } })], CLASSES);
    expect(notPermitted.components[0]!.auditCoverage).toBe(0);
  });

  it("an audit says nothing about components it does not name", () => {
    const p = assessCoverage([C("Vault", "h1"), C("Router", "h2")], [], [audit({ componentHashes: { Vault: "h1" } })], CLASSES);
    expect(p.components.find((c) => c.id === "Router")!.auditCoverage).toBe(0);
  });

  it("coverage is per class: partial research leaves the rest of the classes open, and sources are not added together", () => {
    const p = assessCoverage([C("Vault", "h1")], [R("Vault", "h1", ["reentrancy"])], [audit({ kind: "claimed", commitSha: null, componentHashes: { Vault: "h1" }, classesExamined: ["reentrancy"] })], CLASSES);
    expect(p.components[0]).toMatchObject({ ownCoverage: 0.25, auditCoverage: 0.063, saturation: 0.25 });
  });

  it("ignores classes outside the measured set and rejects malformed inputs", () => {
    const p = assessCoverage([C("Vault", "h1")], [R("Vault", "h1", ["gas-griefing"])], [], CLASSES);
    expect(p.components[0]!.ownCoverage).toBe(0);
    expect(() => assessCoverage([C("Vault", "h1", 0)], [], [], CLASSES)).toThrow(/non-positive weight/);
    expect(() => assessCoverage([C("Vault", "h1")], [], [], [])).toThrow(/list of vulnerability classes/);
  });

  it("is deterministic", () => {
    const args = [[C("A", "1"), C("B", "2", 3)], [R("A", "1", ["reentrancy"])], [audit({ componentHashes: { B: "2" } })], CLASSES] as const;
    expect(assessCoverage(...args)).toEqual(assessCoverage(...args));
  });
});
