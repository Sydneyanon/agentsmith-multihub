import { describe, it, expect } from "vitest";
import { githubRepoFromUrl, resolveProgrammeRepositories } from "./repo-resolve.js";
import type { Resolution } from "./resolve.js";

describe("githubRepoFromUrl", () => {
  it("drops a sentence-ending full stop that a page left on the URL (found live on a HackenProof programme page)", () => {
    expect(githubRepoFromUrl("https://github.com/smardex-dev/smart-contracts.")).toBe("smardex-dev/smart-contracts");
    expect(githubRepoFromUrl("https://github.com/acme/vault.git.")).toBe("acme/vault");
    expect(githubRepoFromUrl("https://github.com/acme/my.repo")).toBe("acme/my.repo"); // inner dots are part of real names
  });
  it("extracts owner/name and lowercases, stripping .git and deep paths", () => {
    expect(githubRepoFromUrl("https://github.com/Compound-Finance/compound-protocol")).toBe("compound-finance/compound-protocol");
    expect(githubRepoFromUrl("https://github.com/aave/aave-v3-core.git")).toBe("aave/aave-v3-core");
    expect(githubRepoFromUrl("https://github.com/Uniswap/v3-core/tree/main/contracts")).toBe("uniswap/v3-core");
    expect(githubRepoFromUrl("http://www.github.com/a/b")).toBe("a/b");
  });
  it("rejects non-repo, non-github, and malformed URLs", () => {
    expect(githubRepoFromUrl("https://immunefi.com/bug-bounty/compound/information")).toBeNull();
    expect(githubRepoFromUrl("https://github.com/orgs/foo")).toBeNull();      // reserved owner
    expect(githubRepoFromUrl("https://github.com/onlyowner")).toBeNull();      // no repo segment
    expect(githubRepoFromUrl("not a url")).toBeNull();
    expect(githubRepoFromUrl("https://gitlab.com/a/b")).toBeNull();
  });
});

describe("resolveProgrammeRepositories", () => {
  const field = (value: unknown) => ({ value, source: "s", authority: 1, observedAt: "2026-01-01T00:00:00Z", conflicts: [] });
  it("collects unique repos from officialUrl + otherUrls, in first-seen order", () => {
    const resolved = {
      officialUrl: field("https://immunefi.com/bug-bounty/compound/information"),
      otherUrls: field(["https://github.com/compound-finance/compound-protocol", "https://github.com/compound-finance/compound-protocol/tree/main", "https://github.com/compound-finance/comet"]),
    } as unknown as Resolution["resolved"];
    const r = resolveProgrammeRepositories(resolved);
    expect(r.repositories).toEqual(["compound-finance/compound-protocol", "compound-finance/comet"]);
    expect(r.officialUrl).toContain("immunefi.com");
    expect(r.sources["compound-finance/comet"]).toContain("github.com");
  });
  it("returns no repositories when none are GitHub URLs", () => {
    const resolved = { officialUrl: field("https://immunefi.com/bug-bounty/x/information"), otherUrls: field(["https://x.com/foo"]) } as unknown as Resolution["resolved"];
    expect(resolveProgrammeRepositories(resolved).repositories).toEqual([]);
  });
  it("tolerates a missing/empty resolved record", () => {
    expect(resolveProgrammeRepositories(undefined).repositories).toEqual([]);
    expect(resolveProgrammeRepositories({} as Resolution["resolved"]).repositories).toEqual([]);
  });
});
