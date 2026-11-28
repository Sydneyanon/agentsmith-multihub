import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrichmentMetrics, coverageMetrics } from "../bounties/queries.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

const field = (v: unknown) => ({ value: v, source: "sherlock", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });
const resolved = (url: string) => JSON.stringify({ projectName: field("D"), officialUrl: field(url), otherUrls: field([]), maxReward: field(1_000_000), assetTypes: field(["Smart contract"]), chains: field(["Ethereum"]) });

describe.skipIf(skipIntegration)("enrichment metrics over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  beforeAll(async () => {
    db = await migratedTestDatabase();
    const p = async (k: string) => (await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1,$2,$2,$3::jsonb,'active','official_confirmed') RETURNING id`, [`sherlock:${k}`, k, resolved(`https://audits.sherlock.xyz/bug-bounties/${k}`)])).rows[0].id as string;
    const a = await p("201"); const b = await p("202");
    const map = (pid: string, repo: string, status: string, seen: string | null) => owner().query(`INSERT INTO bounty_repository_mappings (bounty_program_id, repository, source_url, discovery_method, verification_status, confidence, last_checked_at, last_seen_at) VALUES ($1,$2,'u','official_page',$3,'high', now(), $4)`, [pid, repo, status, seen]);
    await map(a, "acme/one", "official_documentation", "2026-11-27T10:00:00Z");
    await map(a, "acme/two", "official_documentation", "2026-11-27T09:00:00Z"); // older -> scope changed
    await map(a, "acme/aud", "rejected", null);
    await map(b, "acme/ghost", "unavailable", null);
  });
  afterAll(async () => { await db?.drop(); });

  it("counts mappings by status, mapped programmes, and scope changes", async () => {
    const e = await enrichmentMetrics(db.pool) as any;
    expect(e.available).toBe(true);
    expect(e.by_status).toMatchObject({ official_documentation: 2, rejected: 1, unavailable: 1 });
    expect(e.programmes_mapped).toBe(1);        // only programme a has verified repos
    expect(e.repositories_verified).toBe(2);
    expect(e.research_ready).toBe(2);
    expect(e.scope_changed).toBe(1);            // acme/two last_seen older than latest check
  });

  it("coverage counts a verified-mapped programme as having a repository", async () => {
    const c = await coverageMetrics(db.pool) as any;
    expect(c.programmes.with_repositories).toBe(1);               // programme a has a verified mapping
    expect(c.programmes.awaiting_repository_discovery).toBe(1);   // programme b has none verified
  });
});
