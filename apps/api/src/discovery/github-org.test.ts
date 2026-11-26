import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orgReposUrl, parseOrgRepos } from "./github-org.js";
import { scoreOpportunity } from "./priority.js";
import { DiscoveryError, githubOrgConfigSchema } from "./types.js";

const config = githubOrgConfigSchema.parse({ org: "code-423n4", platform: "code4rena", requireDatePrefix: true });
const repo = (over: Record<string, unknown> = {}) => ({
  id: 1, name: "2026-11-vaultcore", full_name: "code-423n4/2026-11-vaultcore", html_url: "https://github.com/code-423n4/2026-11-vaultcore",
  description: "Code4rena audit contest: VaultCore", archived: false, fork: false, private: false,
  created_at: "2026-11-20T10:00:00Z", pushed_at: "2026-11-25T10:00:00Z", topics: ["audit"], ...over,
});

describe("github_org_repos adapter (documented GET /orgs/{org}/repos shape)", () => {
  it("builds one fixed URL on api.github.com from a validated organisation name", () => {
    expect(orgReposUrl(config)).toBe("https://api.github.com/orgs/code-423n4/repos?type=public&sort=created&direction=desc&per_page=100");
  });
  it("never trusts the link in the payload: a repository whose html_url is not https://github.com/<full_name> is skipped", () => {
    expect(parseOrgRepos([repo({ html_url: "javascript:alert(1)" }), repo({ name: "2026-11-b", full_name: "code-423n4/2026-11-b", html_url: "https://evil.example/code-423n4/2026-11-b" })], config).items).toHaveLength(0);
  });
  it("strips NUL characters from source text, which jsonb cannot store", () => {
    const { items } = parseOrgRepos([repo({ description: "bad\u0000text", topics: ["a\u0000b"] })], config);
    expect(JSON.stringify(items[0]!.details)).not.toContain("\\u0000");
    expect(items[0]!.details).toMatchObject({ description: "badtext", topics: ["ab"] });
  });
  it("normalises a contest repository into an opportunity with a high-confidence candidate and provenance fields", () => {
    const { items, seen } = parseOrgRepos([repo()], config);
    expect(seen).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ canonicalKey: "github:code-423n4/2026-11-vaultcore", platform: "code4rena", title: "2026-11-vaultcore", closed: false, sourceUrl: "https://github.com/code-423n4/2026-11-vaultcore" });
    expect(items[0]!.repositoryCandidates).toEqual([expect.objectContaining({ repository: "code-423n4/2026-11-vaultcore", confidence: "high" })]);
    expect(items[0]!.details).toMatchObject({ archived: false, description: "Code4rena audit contest: VaultCore" });
  });
  it("tolerates nullable fields the API is documented to return", () => {
    const { items } = parseOrgRepos([repo({ description: null, pushed_at: null, topics: undefined })], config);
    expect(items[0]!.details).toMatchObject({ description: null, topics: [] });
  });
  it("skips forks, private repositories, other owners, names without the date prefix, and repositories the key rules would refuse", () => {
    const { items } = parseOrgRepos([
      repo({ name: "2026-11-fork", full_name: "code-423n4/2026-11-fork", fork: true }),
      repo({ name: "2026-11-private", full_name: "code-423n4/2026-11-private", private: true }),
      repo({ name: "2026-11-other", full_name: "someone-else/2026-11-other" }),
      repo({ name: "docs", full_name: "code-423n4/docs" }),
      repo({ name: "2026-13-badmonth", full_name: "code-423n4/2026-13-badmonth" }),
      repo({ name: "2026-10-ok", full_name: "code-423n4/2026-10-ok", html_url: "https://github.com/code-423n4/2026-10-ok" }),
    ], config);
    expect(items.map((i) => i.title)).toEqual(["2026-10-ok"]);
  });
  it("honours the name prefix (case-insensitive) and the item cap", () => {
    const c = githubOrgConfigSchema.parse({ org: "sherlock-audit", platform: "sherlock", namePrefix: "2026-", maxItems: 2 });
    const many = Array.from({ length: 5 }, (_, i) => repo({ name: `2026-0${i + 1}-p${i}`, full_name: `sherlock-audit/2026-0${i + 1}-p${i}`, html_url: `https://github.com/sherlock-audit/2026-0${i + 1}-p${i}` }));
    expect(parseOrgRepos(many, c).items).toHaveLength(2);
    expect(parseOrgRepos([repo({ name: "X-1", full_name: "sherlock-audit/X-1" })], c).items).toHaveLength(0);
  });
  it("marks archived repositories as closed", () => {
    expect(parseOrgRepos([repo({ archived: true })], config).items[0]!.closed).toBe(true);
  });
  it("rejects a body that is not the documented shape (fails closed, no guessing)", () => {
    for (const body of [{ message: "Not Found" }, "x", null, [{ name: 1 }], Array.from({ length: 201 }, () => repo())]) {
      expect(() => parseOrgRepos(body, config)).toThrow(DiscoveryError);
    }
  });
});

describe("adapter configuration is validated strictly (it is operator input)", () => {
  it("refuses organisation names that could alter the URL, unknown keys, and out-of-range numbers", () => {
    for (const org of ["a/b", "a b", "a?x=1", "-bad", "a..", "x".repeat(40), "", "a#b", "../x", "%2e%2e"]) {
      expect(githubOrgConfigSchema.safeParse({ org, platform: "p1" }).success, org).toBe(false);
    }
    expect(githubOrgConfigSchema.safeParse({ org: "ok", platform: "BAD PLATFORM" }).success).toBe(false);
    expect(githubOrgConfigSchema.safeParse({ org: "ok", platform: "okp", extra: 1 }).success).toBe(false);
    expect(githubOrgConfigSchema.safeParse({ org: "ok", platform: "okp", maxItems: 101 }).success).toBe(false);
    expect(githubOrgConfigSchema.safeParse({ org: "ok", platform: "okp", namePrefix: "a/b" }).success).toBe(false);
  });
});

describe("priority scoring is deterministic and explains itself", () => {
  const now = new Date("2026-11-26T00:00:00Z");
  const base = { closed: false, repositoryCandidates: [{ repository: "a/b", signal: "s", confidence: "high" as const }], details: { description: "Audit contest" }, createdAt: "2026-11-24T00:00:00Z" };
  it("fresh contest with a candidate scores highest, with reasons", () => {
    const r = scoreOpportunity(base, now);
    expect(r.score).toBe(90);
    expect(r.reasons.join(" ")).toMatch(/candidate repository.*last 7 days.*audit/);
  });
  it("older items score lower, closed items score zero, and the score is capped", () => {
    expect(scoreOpportunity({ ...base, createdAt: "2026-11-01T00:00:00Z" }, now).score).toBe(70);
    expect(scoreOpportunity({ ...base, createdAt: "2025-01-01T00:00:00Z" }, now).score).toBe(50);
    expect(scoreOpportunity({ ...base, closed: true }, now)).toEqual({ score: 0, reasons: ["closed or archived at the source"] });
    expect(scoreOpportunity({ ...base, repositoryCandidates: [], createdAt: null, details: {} }, now).score).toBe(0);
  });
});

describe("discovery stays off unless explicitly switched on", () => {
  it("the worker schedules monitoring only when DISCOVERY_ENABLED is exactly 'true', and the module has no other network entry point", () => {
    const worker = readFileSync(join(__dirname, "..", "worker-runtime.ts"), "utf8");
    expect(worker).toMatch(/process\.env\.DISCOVERY_ENABLED === "true"\s*\n?\s*\? setInterval/);
    for (const f of ["monitor.ts", "store.ts", "api.ts", "step.ts", "github-org.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8").replace(/\/\/.*$/gm, "").replace(/typeof fetch/g, "");
      expect(src, f).not.toMatch(/(^|[^\w.])fetch\s*\(|https?\.request|net\.connect|child_process/);
    }
    expect(readFileSync(join(__dirname, "monitor.ts"), "utf8")).toMatch(/options\.fetcher \?\? outboundFetch/);
  });
});
