import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promoteEligibleProgrammes } from "../bounties/promote.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

// Exercises the discovery -> research bridge end to end on real Postgres: an eligible programme becomes a repository_research run
// (via the production createRepositoryResearchRunIn) with a provenance link, de-duplicated and idempotent. No model is ever called.
const field = (value: unknown) => ({ value, source: "immunefi", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });

function resolved(officialUrl: string, repos: string[], reward: number | null) {
  return JSON.stringify({
    projectName: field("Demo"), officialUrl: field(officialUrl), otherUrls: field(repos),
    maxReward: reward === null ? field(undefined) : field(reward), assetTypes: field(["Smart contract"]), chains: field(["Ethereum"]),
  });
}

describe.skipIf(skipIntegration)("bounty -> research bridge over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  const seed = async (opts: { project: string; key: string; url: string; repos: string[]; reward?: number | null; verification?: string; status?: string }) =>
    (await owner().query(
      `INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`,
      [opts.key, opts.project, opts.project.toLowerCase(), resolved(opts.url, opts.repos, opts.reward ?? 1_000_000), opts.status ?? "active", opts.verification ?? "official_confirmed"])).rows[0].id as string;
  const links = async () => Number((await owner().query("SELECT count(*) AS n FROM bounty_research_links")).rows[0].n);
  const runs = async () => Number((await owner().query("SELECT count(*) AS n FROM workflow_runs WHERE workflow_type = 'repository_research'")).rows[0].n);

  beforeEach(async () => {
    if (db) await db.drop();
    db = await migratedTestDatabase();
  });
  afterAll(async () => { await db?.drop(); });

  it("promotes an eligible programme into a repository_research run with a provenance link", async () => {
    await seed({ project: "Compound", key: "immunefi:compound", url: "https://immunefi.com/bug-bounty/compound/information", repos: ["https://github.com/compound-finance/compound-protocol"] });
    const r = await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
    expect(r.eligible_programmes).toBe(1);
    expect(r.created).toBe(1);
    expect(await runs()).toBe(1);
    expect(await links()).toBe(1);
    const link = (await owner().query("SELECT repository, reason FROM bounty_research_links")).rows[0];
    expect(link.repository).toBe("compound-finance/compound-protocol");
  });

  it("is idempotent: a second pass creates nothing and reports already_linked", async () => {
    await seed({ project: "Compound", key: "immunefi:compound", url: "https://immunefi.com/bug-bounty/compound/information", repos: ["https://github.com/compound-finance/compound-protocol"] });
    await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
    const again = await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
    expect(again.created).toBe(0);
    expect(again.already_linked).toBe(1);
    expect(await runs()).toBe(1);
  });

  it("reuses an existing run when a second programme points at the same repository (no re-analysis)", async () => {
    await seed({ project: "Compound", key: "immunefi:compound", url: "https://immunefi.com/bug-bounty/compound/information", repos: ["https://github.com/compound-finance/compound-protocol"] });
    await seed({ project: "CompoundMirror", key: "sherlock:99", url: "https://audits.sherlock.xyz/bug-bounties/99", repos: ["https://github.com/compound-finance/compound-protocol"] });
    const r = await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
    expect(r.eligible_programmes).toBe(2);
    expect(r.created).toBe(1);   // only one run for the shared repo
    expect(r.reused).toBe(1);    // the second programme reused it
    expect(await runs()).toBe(1);
    expect(await links()).toBe(2); // both programmes have provenance links
  });

  it("never promotes a non-eligible (community-reported) programme", async () => {
    await seed({ project: "Rumour", key: "immunefi:rumour", url: "https://immunefi.com/bug-bounty/rumour/information", repos: ["https://github.com/rumour/contracts"], verification: "community_reported" });
    const r = await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
    expect(r.eligible_programmes).toBe(0);
    expect(r.created).toBe(0);
    expect(await runs()).toBe(0);
  });

  it("dryRun resolves and decides but creates nothing", async () => {
    await seed({ project: "Compound", key: "immunefi:compound", url: "https://immunefi.com/bug-bounty/compound/information", repos: ["https://github.com/compound-finance/compound-protocol"] });
    const r = await promoteEligibleProgrammes(db.pool, { createdBy: "test", dryRun: true });
    expect(r.skipped_dry_run).toBe(1);
    expect(r.created).toBe(0);
    expect(await runs()).toBe(0);
    expect(await links()).toBe(0);
  });

  it("respects the new-run cap", async () => {
    await seed({ project: "A", key: "immunefi:a", url: "https://immunefi.com/bug-bounty/a/information", repos: ["https://github.com/a/one"] });
    await seed({ project: "B", key: "immunefi:b", url: "https://immunefi.com/bug-bounty/b/information", repos: ["https://github.com/b/two"] });
    const r = await promoteEligibleProgrammes(db.pool, { createdBy: "test", maxNewRuns: 1 });
    expect(r.created).toBe(1);
    expect(r.skipped_cap).toBe(1);
    expect(await runs()).toBe(1);
  });
});
