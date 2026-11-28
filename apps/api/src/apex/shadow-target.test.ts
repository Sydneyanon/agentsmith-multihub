import { describe, expect, it } from "vitest";
import { ApexShadowRefused, APEX_SHADOW_TARGET as T, apexShadowEligibility, assertApexShadowRequestAllowed } from "./shadow-target.js";
import { usxScope } from "./testing/usx-like.js";

const approval = { approved_by: "owner@example", approved_commit: T.commit, approved_at: "2026-11-28T00:00:00Z", basis: "test" };
const run = (over: Partial<{ repository: unknown; ref: unknown; approval: unknown; scope: unknown }> = {}) => ({ repository: T.repository, ref: T.commit, approval, scope: usxScope(), ...over });
const code = (e: ReturnType<typeof apexShadowEligibility>) => (e.ok ? "ok" : e.code);

describe("APEX shadow: only the approved run, only its official scope, only its sealed commit", () => {
  it("the target is exactly the recorded USX scope: 20 paths, sherlock:273, the pinned commit and the page hash", () => {
    expect(T.inScopePaths).toHaveLength(20);
    expect([...T.inScopePaths].sort()).toEqual([...T.inScopePaths]);
    expect(T).toMatchObject({ programme: "sherlock:273", repository: "scroll-tech/usx-contracts", commit: "9e972566deb59b4d2c499015c2557c5e5f236e3c", evidenceSha256: "1cdc83533cb8e55f89b57ae3d643cc8b16e1bdd5ea7d6b64492cbf83c19170b3" });
  });

  it("accepts the approved run, with its sealed snapshot of the pinned commit", () => {
    expect(code(apexShadowEligibility(run()))).toBe("ok");
    expect(code(apexShadowEligibility(run({ repository: "Scroll-Tech/USX-Contracts" }), { commitSha: T.commit, sealed: true }))).toBe("ok");
  });

  it("refuses, with a recorded reason, a wrong commit, repository, programme, scope or evidence, a missing approval and the wrong snapshot", () => {
    const other = "1".repeat(40);
    expect(code(apexShadowEligibility(run({ ref: other })))).toBe("not_the_approved_commit");
    expect(code(apexShadowEligibility(run({ ref: "main" })))).toBe("not_the_approved_commit");
    expect(code(apexShadowEligibility(run({ repository: "acme/vault" })))).toBe("not_the_approved_repository");
    expect(code(apexShadowEligibility(run({ approval: undefined })))).toBe("not_requested");
    expect(code(apexShadowEligibility(run({ approval: { ...approval, approved_by: " " } })))).toBe("not_requested");
    expect(code(apexShadowEligibility(run({ approval: { ...approval, approved_commit: other } })))).toBe("approval_commit_mismatch");
    expect(code(apexShadowEligibility(run({ scope: undefined })))).toBe("no_bounty_scope");
    expect(code(apexShadowEligibility(run({ scope: usxScope({ programme: "sherlock:274" }) })))).toBe("not_the_approved_programme");
    expect(code(apexShadowEligibility(run({ scope: usxScope({ in_scope_paths: T.inScopePaths.slice(1) }) })))).toBe("scope_paths_differ");
    expect(code(apexShadowEligibility(run({ scope: usxScope({ in_scope_paths: [...T.inScopePaths, "src/cloak/USXRebalancer.sol"] }) })))).toBe("scope_paths_differ");
    expect(code(apexShadowEligibility(run({ scope: usxScope({ in_scope_paths: [...T.inScopePaths.slice(1), "src/cloak/USXRebalancer.sol"] }) })))).toBe("scope_paths_differ");
    expect(code(apexShadowEligibility(run({ scope: usxScope({ evidence_sha256: "c".repeat(64) }) })))).toBe("scope_evidence_differs");
    expect(code(apexShadowEligibility(run(), { commitSha: other, sealed: true }))).toBe("snapshot_commit_differs");
    expect(code(apexShadowEligibility(run(), { commitSha: T.commit, sealed: false }))).toBe("snapshot_not_sealed");
    const e = apexShadowEligibility(run({ scope: usxScope({ in_scope_paths: T.inScopePaths.slice(1) }) }));
    expect(e.ok ? "" : e.reason).toMatch(/missing 1: src\/BridgedToken\.sol/);
  });

  it("run creation refuses the flag on any other target, and without structural analysis or an approver", () => {
    const ok = { structuralAnalysis: true, bountyScope: usxScope(), approvedBy: "owner@example" };
    expect(() => assertApexShadowRequestAllowed({ repository: T.repository, ref: T.commit }, ok)).not.toThrow();
    const refused = (input: { repository: string; ref?: string }, o: Partial<typeof ok>) => { try { assertApexShadowRequestAllowed(input, { ...ok, ...o }); return "accepted"; } catch (e) { return e instanceof ApexShadowRefused ? e.code : "other"; } };
    expect(refused({ repository: "acme/vault", ref: T.commit }, {})).toBe("not_the_approved_repository");
    expect(refused({ repository: T.repository }, {})).toBe("not_the_approved_commit");
    expect(refused({ repository: T.repository, ref: T.commit }, { structuralAnalysis: false })).toBe("structural_analysis_required");
    expect(refused({ repository: T.repository, ref: T.commit }, { approvedBy: "" })).toBe("not_requested");
    expect(refused({ repository: T.repository, ref: T.commit }, { bountyScope: usxScope({ in_scope_paths: ["src/USX.sol"] }) })).toBe("scope_paths_differ");
  });
});
