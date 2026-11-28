import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lifecycleOverview } from "../bounties/queries.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

const field = (value: unknown) => ({ value, source: "immunefi", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });
const resolved = (url: string, repos: string[], reward: number | null) => JSON.stringify({
  projectName: field("Demo"), officialUrl: field(url), otherUrls: field(repos),
  maxReward: reward === null ? field(undefined) : field(reward), assetTypes: field(["Smart contract"]), chains: field(["Ethereum"]),
});

describe.skipIf(skipIntegration)("programme lifecycle overview over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  const prog = async (o: { key: string; url: string; repos: string[]; reward?: number | null; verification?: string; status?: string }) =>
    (await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1,$2,$2,$3::jsonb,$4,$5) RETURNING id`,
      [o.key, o.key, resolved(o.url, o.repos, o.reward === undefined ? 1_000_000 : o.reward), o.status ?? "active", o.verification ?? "official_confirmed"])).rows[0].id as string;

  beforeAll(async () => {
    db = await migratedTestDatabase();
    // eligible, repo resolved, no run -> eligible_for_research
    await prog({ key: "immunefi:a", url: "https://immunefi.com/bug-bounty/a/information", repos: ["https://github.com/a/one"] });
    // eligible, repo resolved, with a queued run link -> queued_for_scan
    const withRun = await prog({ key: "immunefi:b", url: "https://immunefi.com/bug-bounty/b/information", repos: ["https://github.com/b/two"] });
    const runId = (await owner().query(`INSERT INTO workflow_runs (workflow_type, status, correlation_id, input, created_by) VALUES ('repository_research','queued', gen_random_uuid(), '{}'::jsonb, 't') RETURNING id`)).rows[0].id as string;
    await owner().query(`INSERT INTO bounty_research_links (bounty_program_id, repository, ref, workflow_run_id, reason, created_by) VALUES ($1,'b/two',NULL,$2,'r','t')`, [withRun, runId]);
    // engine-suitable but community-reported -> needs_verification
    await prog({ key: "immunefi:c", url: "https://immunefi.com/bug-bounty/c/information", repos: ["https://github.com/c/three"], verification: "community_reported" });
    // official but no repo resolved -> officially_verified
    await prog({ key: "immunefi:d", url: "https://immunefi.com/bug-bounty/d/information", repos: [] });
    // paused -> paused (side state wins)
    await prog({ key: "immunefi:e", url: "https://immunefi.com/bug-bounty/e/information", repos: ["https://github.com/e/five"], status: "paused" });
    // no reward -> ineligible
    await prog({ key: "immunefi:f", url: "https://immunefi.com/bug-bounty/f/information", repos: ["https://github.com/f/six"], reward: null });
  });
  afterAll(async () => { await db?.drop(); });

  it("counts every programme at exactly one lifecycle state", async () => {
    const o = await lifecycleOverview(db.pool);
    expect(o.total).toBe(6);
    expect(o.counts.eligible_for_research).toBe(1);
    expect(o.counts.queued_for_scan).toBe(1);
    expect(o.counts.needs_verification).toBe(1);
    expect(o.counts.officially_verified).toBe(1);
    expect(o.counts.paused).toBe(1);
    expect(o.counts.ineligible).toBe(1);
    const sum = Object.values(o.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(o.total); // partition: nothing double-counted or dropped
  });

  it("exposes the ordered ladder for the dashboard", async () => {
    const o = await lifecycleOverview(db.pool);
    expect(o.ladder[0]).toBe("discovered");
    expect(o.ladder[o.ladder.length - 1]).toBe("completed");
    expect(o.ladder).toContain("eligible_for_research");
  });
});
