import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcquisitionError } from "../acquisition/errors.js";
import type { RepositoryIdentity } from "../acquisition/github-source.js";
import { enrichProgramme, verifiedRepositoriesFor } from "../bounties/enrich.js";
import { fakeHttp, SHERLOCK_DETAIL_11, SHERLOCK_DETAIL_NOREPO, HACKENPROOF_QUANTOVA, type Route } from "../bounties/testing/fixtures.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

const field = (value: unknown) => ({ value, source: "sherlock", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });
const resolvedWith = (url: string) => JSON.stringify({ projectName: field("D"), officialUrl: field(url), otherUrls: field([]), maxReward: field(1_000_000), assetTypes: field(["Smart contract"]), chains: field(["Ethereum"]) });

// A GitHub source that confirms any repo except a configured not-found set.
function fakeGithub(notFound: Set<string> = new Set(), archived: Set<string> = new Set()) {
  return {
    async getRepository(owner: string, repo: string): Promise<RepositoryIdentity> {
      const k = `${owner}/${repo}`;
      if (notFound.has(k)) throw new AcquisitionError("repository_not_found", "not found", false);
      return { repositoryId: 42, fullName: k, defaultBranch: "main", archived: archived.has(k), fork: false };
    },
  };
}
const sherlockRoutes = (id: number, body: string): Record<string, Route> => ({
  "https://audits.sherlock.xyz/robots.txt": { body: "User-Agent: *\n", contentType: "text/plain" },
  [`https://audits.sherlock.xyz/bug-bounties/${id}`]: { body },
});

describe.skipIf(skipIntegration)("programme -> repository enrichment over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  const prog = async (url: string) => (await owner().query(
    `INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1,$2,$2,$3::jsonb,'active','official_confirmed') RETURNING id`,
    [`k:${url}`, "P", resolvedWith(url)])).rows[0].id as string;
  const mappings = async (id: string) => (await owner().query("SELECT repository, verification_status, confidence, discovery_method, source_url, default_branch, note FROM bounty_repository_mappings WHERE bounty_program_id = $1 ORDER BY repository", [id])).rows;

  beforeEach(async () => { db = await migratedTestDatabase(); });
  afterEach(async () => { await db?.drop(); });

  it("extracts, verifies and stores in-scope repositories with provenance; auditor repos are rejected", async () => {
    const id = await prog("https://audits.sherlock.xyz/bug-bounties/11");
    const r = await enrichProgramme(db.pool, { get: fakeHttp(sherlockRoutes(11, SHERLOCK_DETAIL_11())), github: fakeGithub() }, id);
    expect(r.outcome).toBe("enriched");
    expect(r.verified).toBeGreaterThanOrEqual(2);
    const m = await mappings(id);
    const verified = m.filter((x) => x.verification_status === "official_documentation").map((x) => x.repository);
    expect(verified).toContain("napierfi/v1-pool");
    expect(m.find((x) => x.repository === "mixbytes/audits_public")?.verification_status).toBe("rejected");
    const nap = m.find((x) => x.repository === "napierfi/v1-pool")!;
    expect(nap).toMatchObject({ confidence: "high", discovery_method: "official_page", default_branch: "main", source_url: "https://audits.sherlock.xyz/bug-bounties/11" });
    // Only documentation-confirmed repos may enter research.
    expect(await verifiedRepositoriesFor(db.pool, id)).toContain("napierfi/v1-pool");
    expect(await verifiedRepositoriesFor(db.pool, id)).not.toContain("mixbytes/audits_public");
  });

  it("verifies HackenProof in-scope repositories", async () => {
    const id = await prog("https://hackenproof.com/programs/quantova");
    const r = await enrichProgramme(db.pool, { get: fakeHttp({ "https://hackenproof.com/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" }, "https://hackenproof.com/programs/quantova": { body: HACKENPROOF_QUANTOVA() } }), github: fakeGithub() }, id);
    expect(r.outcome).toBe("enriched");
    expect(await verifiedRepositoriesFor(db.pool, id)).toContain("quantova/q-crypto");
  });

  it("records a repository GitHub cannot confirm as unavailable, never as research-ready", async () => {
    const id = await prog("https://audits.sherlock.xyz/bug-bounties/7");
    const body = "scope: https://github.com/acme/real and https://github.com/acme/ghost";
    await enrichProgramme(db.pool, { get: fakeHttp(sherlockRoutes(7, body)), github: fakeGithub(new Set(["acme/ghost"])) }, id);
    const m = await mappings(id);
    expect(m.find((x) => x.repository === "acme/real")?.verification_status).toBe("official_documentation");
    expect(m.find((x) => x.repository === "acme/ghost")?.verification_status).toBe("unavailable");
    expect(await verifiedRepositoriesFor(db.pool, id)).toEqual(["acme/real"]); // ghost excluded
  });

  it("reports verification_deferred (never 'enriched') when GitHub refuses, and records no mapping it could not confirm", async () => {
    const id = await prog("https://audits.sherlock.xyz/bug-bounties/8");
    const body = "scope: https://github.com/acme/limited";
    const limited = { async getRepository(): Promise<never> { throw new AcquisitionError("upstream_http", "GitHub API rate limit exceeded (HTTP 403)"); } };
    const r = await enrichProgramme(db.pool, { get: fakeHttp(sherlockRoutes(8, body)), github: limited }, id);
    expect(r).toMatchObject({ outcome: "verification_deferred", verified: 0, deferred: 1 });
    expect(r.error).toMatch(/acme\/limited: .*rate limit/);
    expect(await mappings(id)).toEqual([]);              // nothing recorded: it is retried next pass
    expect(await verifiedRepositoriesFor(db.pool, id)).toEqual([]);
  });

  it("reports no_repositories for a programme whose page lists none", async () => {
    const id = await prog("https://audits.sherlock.xyz/bug-bounties/100");
    const r = await enrichProgramme(db.pool, { get: fakeHttp(sherlockRoutes(100, SHERLOCK_DETAIL_NOREPO())), github: fakeGithub() }, id);
    expect(r.outcome).toBe("no_repositories");
    expect(await mappings(id)).toEqual([]);
  });

  it("respects robots.txt: a disallowed page is not fetched or mapped", async () => {
    const id = await prog("https://audits.sherlock.xyz/bug-bounties/9");
    const routes: Record<string, Route> = { "https://audits.sherlock.xyz/robots.txt": { body: "User-agent: *\nDisallow: /bug-bounties/\n", contentType: "text/plain" }, "https://audits.sherlock.xyz/bug-bounties/9": { body: "github.com/acme/x" } };
    const r = await enrichProgramme(db.pool, { get: fakeHttp(routes), github: fakeGithub() }, id);
    expect(r.outcome).toBe("robots_disallowed");
    expect(await mappings(id)).toEqual([]);
  });

  it("skips a programme on a non-enrichable source (e.g. Immunefi)", async () => {
    const id = await prog("https://immunefi.com/bug-bounty/foo/information");
    const r = await enrichProgramme(db.pool, { get: fakeHttp({}), github: fakeGithub() }, id);
    expect(r.outcome).toBe("skipped_source");
  });

  it("detects a scope change: a repository dropped from the page is flagged, a new one is added", async () => {
    const id = await prog("https://audits.sherlock.xyz/bug-bounties/5");
    const t1 = new Date("2026-11-27T10:00:00Z"); const t2 = new Date("2026-11-27T11:00:00Z");
    await enrichProgramme(db.pool, { get: fakeHttp(sherlockRoutes(5, "https://github.com/acme/x https://github.com/acme/y")), github: fakeGithub(), now: () => t1 }, id);
    const r2 = await enrichProgramme(db.pool, { get: fakeHttp(sherlockRoutes(5, "https://github.com/acme/x https://github.com/acme/z")), github: fakeGithub(), now: () => t2 }, id);
    expect(r2.dropped).toBe(1); // acme/y no longer on the page
    const m = await mappings(id);
    expect(m.map((x) => x.repository)).toEqual(["acme/x", "acme/y", "acme/z"]); // y kept for provenance
    expect(await verifiedRepositoriesFor(db.pool, id)).toContain("acme/z");
  });
});
