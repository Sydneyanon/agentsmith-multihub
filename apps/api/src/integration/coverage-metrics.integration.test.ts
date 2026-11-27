import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coverageMetrics } from "../bounties/queries.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

const field = (value: unknown) => ({ value, source: "immunefi", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });
const resolved = (url: string, repos: string[]) => JSON.stringify({ projectName: field("D"), officialUrl: field(url), otherUrls: field(repos), maxReward: field(1_000_000), assetTypes: field(["Smart contract"]), chains: field(["Ethereum"]) });

describe.skipIf(skipIntegration)("coverage metrics over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  const prog = (key: string, repo: string, ver = "official_confirmed") =>
    owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1,$2,$2,$3::jsonb,'active',$4)`,
      [`immunefi:${key}`, key, resolved(`https://immunefi.com/bug-bounty/${key}/information`, [`https://github.com/${repo}`]), ver]);
  const sealRepo = async (repo: string) => {
    const runId = (await owner().query(`INSERT INTO workflow_runs (workflow_type, status, correlation_id, input, created_by) VALUES ('repository_research','succeeded', gen_random_uuid(), '{}'::jsonb, 'x') RETURNING id`)).rows[0].id as string;
    const stepId = (await owner().query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, status, attempt, input) VALUES ($1,'acquire_repository',0,'worker','succeeded',1,'{}'::jsonb) RETURNING id`, [runId])).rows[0].id as string;
    await owner().query(`INSERT INTO repo_snapshots (workflow_run_id, produced_by_step_id, source_host, repository, commit_sha, ref_name, acquisition_report, file_count, total_bytes, manifest_sha256, sealed_at, sealed_by_step_id, created_at)
      VALUES ($1,$2,'github.com',$3,$4,'main','{}'::jsonb,1,100,$5,now(),$2,now())`, [runId, stepId, repo, "a".repeat(40), "b".repeat(64)]);
  };

  beforeAll(async () => {
    db = await migratedTestDatabase();
    await prog("researched", "acme/done");     // eligible, repo sealed -> researched
    await prog("awaiting", "acme/todo");        // eligible, repo not sealed -> awaiting
    await prog("lead", "acme/lead", "community_reported"); // not eligible
    await sealRepo("acme/done");
    // a monitor row with a pending rescan, and a monitor-created run
    await owner().query(`INSERT INTO repository_monitors (repository, last_outcome, last_head_commit) VALUES ('acme/done','rescan_queued',$1)`, ["c".repeat(40)]);
    await owner().query(`INSERT INTO workflow_runs (workflow_type, status, correlation_id, input, created_by) VALUES ('repository_research','queued', gen_random_uuid(), '{}'::jsonb, 'repo-monitor')`);
  });
  afterAll(async () => { await db?.drop(); });

  it("measures discovery vs eligibility vs actual research from the tables, not estimates", async () => {
    const m = await coverageMetrics(db.pool) as any;
    expect(m.programmes).toMatchObject({ discovered: 3, eligible: 2, with_repositories: 3, researched: 1, awaiting_research: 1 });
    expect(m.repositories).toMatchObject({ eligible: 2, analysed: 1, tracked: 1, pending_rescan: 1 });
    expect(m.rescans.queued).toBe(1);
    expect(m.coverage_pct.researched_of_eligible).toBe(50);
    expect(m.coverage_pct.eligible_of_discovered).toBeCloseTo(66.7, 1);
  });
});
