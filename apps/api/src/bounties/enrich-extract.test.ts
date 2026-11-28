import { describe, it, expect } from "vitest";
import { extractRepositoryReferences } from "./enrich-extract.js";
import { SHERLOCK_DETAIL_11, SHERLOCK_DETAIL_NOREPO, HACKENPROOF_QUANTOVA } from "./testing/fixtures.js";

describe("extractRepositoryReferences on representative programme pages", () => {
  it("finds the in-scope repositories on a Sherlock-style page and flags the auditor repo", () => {
    const refs = extractRepositoryReferences(SHERLOCK_DETAIL_11());
    const repos = refs.map((r) => r.repository);
    expect(repos).toContain("napierfi/v1-pool");
    expect(repos).toContain("napier-lab/v1-pool");
    const auditor = refs.find((r) => r.repository === "mixbytes/audits_public");
    expect(auditor?.auditor).toBe(true);                 // auditor/report repo is flagged, not a target
    expect(refs.find((r) => r.repository === "napierfi/v1-pool")?.auditor).toBe(false);
    expect(refs.every((r) => r.evidence.length > 0)).toBe(true);
  });
  it("finds the in-scope repositories on a HackenProof-style page", () => {
    const repos = extractRepositoryReferences(HACKENPROOF_QUANTOVA()).map((r) => r.repository);
    expect(repos).toContain("quantova/q-crypto");
    expect(repos).toContain("quantova/q-oracle");
    expect(repos.every((r) => r.startsWith("quantova/"))).toBe(true); // all under the project's own org
  });
  it("returns nothing when a programme has no repository in scope (not every programme has one)", () => {
    expect(extractRepositoryReferences(SHERLOCK_DETAIL_NOREPO())).toEqual([]);
  });
  it("normalises deep links (issues/tree/blob) to the repository root and dedupes", () => {
    const refs = extractRepositoryReferences("see https://github.com/acme/vault/issues/3 and https://github.com/acme/vault/tree/main/src and https://github.com/acme/vault");
    expect(refs.map((r) => r.repository)).toEqual(["acme/vault"]);
  });
});
