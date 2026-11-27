import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcquisitionError } from "../acquisition/errors.js";
import type { RepositoryIdentity, ResolvedCommit } from "../acquisition/github-source.js";
import { promoteEligibleProgrammes } from "../bounties/promote.js";
import { monitorRepositories, type MonitorSource } from "../bounties/monitor.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

const sha = (c: string) => c.repeat(40).slice(0, 40);
const field = (value: unknown) => ({ value, source: "immunefi", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });
const resolved = (url: string, repos: string[]) => JSON.stringify({ projectName: field("Demo"), officialUrl: field(url), otherUrls: field(repos), maxReward: field(1_000_000), assetTypes: field(["Smart contract"]), chains: field(["Ethereum"]) });

// An injectable GitHub source: returns a scripted HEAD per repo, or throws a scripted error.
function fakeSource(heads: Record<string, string>, errors: Record<string, AcquisitionError> = {}, branch = "main"): MonitorSource {
  const id = (key: string): RepositoryIdentity => ({ repositoryId: 1, fullName: key, defaultBranch: branch, archived: false, fork: false });
  return {
    async getRepository(owner, repo) { const k = `${owner}/${repo}`; if (errors[k]) throw errors[k]; return id(k); },
    async resolveCommit(owner, repo) { const k = `${owner}/${repo}`; if (errors[k]) throw errors[k]; const c: ResolvedCommit = { commitSha: heads[k]!, treeSha: sha("t") }; return c; },
  };
}

describe.skipIf(skipIntegration)("repository monitor: the autonomous discover→research→rescan cycle over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  const seedEligible = async (key: string, repo: string) =>
    owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1,$2,$2,$3::jsonb,'active','official_confirmed')`,
      [`immunefi:${key}`, key, resolved(`https://immunefi.com/bug-bounty/${key}/information`, [`https://github.com/${repo}`])]);
  const stepOf = async (runId: string) => (await owner().query(`SELECT id FROM workflow_steps WHERE workflow_run_id = $1 LIMIT 1`, [runId])).rows[0].id as string;
  const seal = async (runId: string, repo: string, commit: string) => {
    const stepId = await stepOf(runId);
    await owner().query(`INSERT INTO repo_snapshots (workflow_run_id, produced_by_step_id, source_host, repository, commit_sha, ref_name, acquisition_report, file_count, total_bytes, manifest_sha256, sealed_at, sealed_by_step_id, created_at)
      VALUES ($1,$2,'github.com',$3,$4,'main','{}'::jsonb,1,100,$5,now(),$2,now())`, [runId, stepId, repo, commit, "b".repeat(64)]);
  };
  const runsFor = async (repo: string) => Number((await owner().query(`SELECT count(*) AS n FROM bounty_research_links WHERE repository = $1`, [repo])).rows[0].n);
  const distinctRuns = async (repo: string) => Number((await owner().query(`SELECT count(DISTINCT workflow_run_id) AS n FROM bounty_research_links WHERE repository = $1`, [repo])).rows[0].n);

  beforeEach(async () => { db = await migratedTestDatabase(); });
  afterEach(async () => { await db?.drop(); });

  it("discovers→maps→researches a programme, then a new commit auto-triggers an incremental rescan (no human step)", async () => {
    const repo = "acme/vault";
    // 1-6: discover an eligible programme and let the bridge map its repository and queue the first research run.
    await seedEligible("vault", repo);
    const promo = await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
    expect(promo.created).toBe(1);
    const r1 = (await owner().query(`SELECT workflow_run_id FROM bounty_research_links WHERE repository = $1`, [repo])).rows[0].workflow_run_id as string;
    // 7-13 (worker, simulated): the first run acquires + seals the repo at commit A.
    await seal(r1, repo, sha("a"));

    // The monitor sees a NEW head commit B and, with NO human action, queues an incremental rescan against B.
    const m1 = await monitorRepositories(db.pool, { source: fakeSource({ [repo]: sha("b") }) });
    expect(m1.checked).toBe(1);
    expect(m1.queued).toBe(1);
    expect(m1.checks[0]).toMatchObject({ outcome: "rescan_queued", headCommit: sha("b"), decision: "incremental" });
    expect(await distinctRuns(repo)).toBe(2); // a second run exists now
    const link = (await owner().query(`SELECT ref, reason FROM bounty_research_links WHERE repository = $1 AND ref = $2`, [repo, sha("b")])).rows[0];
    expect(link.ref).toBe(sha("b"));
    expect(link.reason).toMatch(/incremental rescan/);
    const mon = (await owner().query(`SELECT last_head_commit, last_outcome FROM repository_monitors WHERE repository = $1`, [repo])).rows[0];
    expect(mon).toMatchObject({ last_head_commit: sha("b"), last_outcome: "rescan_queued" });
    const chk = (await owner().query(`SELECT decision, base_commit, workflow_run_id FROM repository_monitor_checks WHERE repository = $1 AND outcome = 'rescan_queued'`, [repo])).rows[0];
    expect(chk).toMatchObject({ decision: "incremental", base_commit: sha("a") });
    expect(chk.workflow_run_id).toBeTruthy();

    // Idempotent: another pass at the same HEAD does not create a duplicate (the rescan is still queued).
    const m2 = await monitorRepositories(db.pool, { source: fakeSource({ [repo]: sha("b") }) });
    expect(m2.queued).toBe(0);
    expect(m2.checks[0]!.outcome).toBe("already_queued");
    expect(await distinctRuns(repo)).toBe(2);

    // Once the rescan run seals commit B, the monitor reports up_to_date and does nothing.
    const r2 = (await owner().query(`SELECT workflow_run_id FROM bounty_research_links WHERE repository = $1 AND ref = $2`, [repo, sha("b")])).rows[0].workflow_run_id as string;
    await seal(r2, repo, sha("b"));
    const m3 = await monitorRepositories(db.pool, { source: fakeSource({ [repo]: sha("b") }) });
    expect(m3.up_to_date).toBe(1);
    expect(m3.checks[0]!.outcome).toBe("up_to_date");
    expect(await distinctRuns(repo)).toBe(2); // still no new run
  });

  it("never marks a repository researched merely because HEAD was fetched (fetch != sealed)", async () => {
    const repo = "acme/app";
    await seedEligible("app", repo);
    await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
    // No snapshot sealed yet. The monitor fetches HEAD but a run is already queued (ref null from the bridge) -> it must not
    // claim up_to_date; the repo is not analysed.
    const m = await monitorRepositories(db.pool, { source: fakeSource({ [repo]: sha("a") }) });
    expect(m.checks[0]!.outcome).not.toBe("up_to_date");
    expect(m.up_to_date).toBe(0);
  });

  it("handles a deleted/inaccessible repository: marks it unavailable and stops monitoring it", async () => {
    const repo = "acme/gone";
    await seedEligible("gone", repo);
    await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
    const notFound = new AcquisitionError("repository_not_found", "the repository was not found", false);
    const m = await monitorRepositories(db.pool, { source: fakeSource({}, { [repo]: notFound }) });
    expect(m.unavailable).toBe(1);
    const mon = (await owner().query(`SELECT enabled, last_outcome FROM repository_monitors WHERE repository = $1`, [repo])).rows[0];
    expect(mon).toMatchObject({ enabled: false, last_outcome: "unavailable" });
    // A disabled monitor is skipped next pass.
    const m2 = await monitorRepositories(db.pool, { source: fakeSource({ [repo]: sha("a") }) });
    expect(m2.checked).toBe(0);
  });

  it("backs off on a transient/rate-limited failure and retries later, without queuing anything", async () => {
    const repo = "acme/flaky";
    await seedEligible("flaky", repo);
    await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
    const rate = new AcquisitionError("upstream_http", "HTTP 429 rate limited", true, 900);
    const now = new Date("2026-11-27T12:00:00Z");
    const m = await monitorRepositories(db.pool, { source: fakeSource({}, { [repo]: rate }), now: () => now });
    expect(m.errors).toBe(1);
    expect(m.queued).toBe(0);
    const mon = (await owner().query(`SELECT consecutive_failures, enabled, next_attempt_at FROM repository_monitors WHERE repository = $1`, [repo])).rows[0];
    expect(mon.consecutive_failures).toBe(1);
    expect(mon.enabled).toBe(true);
    expect(new Date(mon.next_attempt_at).getTime()).toBe(now.getTime() + 900_000); // honoured retry-after
    // Still within backoff: skipped next pass.
    const m2 = await monitorRepositories(db.pool, { source: fakeSource({ [repo]: sha("a") }), now: () => now });
    expect(m2.checked).toBe(0);
  });

  it("queues analysis on a rescan only when asked (--structural): otherwise a new commit is acquired but never analysed", async () => {
    const stepKeys = async (runId: string) => (await owner().query(`SELECT step_key FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence`, [runId])).rows.map((r) => r.step_key as string);
    for (const [repo, structural] of [["acme/plain", false], ["acme/analysed", true]] as const) {
      await seedEligible(repo.split("/")[1]!, repo);
      await promoteEligibleProgrammes(db.pool, { createdBy: "test" });
      const first = (await owner().query(`SELECT workflow_run_id FROM bounty_research_links WHERE repository = $1`, [repo])).rows[0].workflow_run_id as string;
      await seal(first, repo, sha("a"));
      const m = await monitorRepositories(db.pool, { source: fakeSource({ "acme/plain": sha("c"), "acme/analysed": sha("c") }) }, { structuralAnalysis: structural });
      const rescan = m.checks.find((c) => c.repository === repo)!.runId!;
      const keys = await stepKeys(rescan);
      expect(keys[0]).toBe("acquire_repository");
      if (structural) expect(keys).toEqual(expect.arrayContaining(["analyze_structure", "build_dossier"]));
      else expect(keys).toEqual(["acquire_repository"]);
    }
  });
});
