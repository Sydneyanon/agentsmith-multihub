import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryIdentity } from "../acquisition/github-source.js";
import { enrichProgramme } from "../bounties/enrich.js";
import { promoteEligibleProgrammes } from "../bounties/promote.js";
import { fakeHttp, type Route } from "../bounties/testing/fixtures.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

// The complete path: discover → (no repo) → enrich → verify → store → bridge queues a run → repo intelligence prevents duplicate
// research → scope change handled → inferred repos never auto-researched. GitHub HEAD and the page fetch are injected (fixtures).
const field = (value: unknown) => ({ value, source: "sherlock", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });
const resolvedWith = (url: string) => JSON.stringify({ projectName: field("D"), officialUrl: field(url), otherUrls: field([]), maxReward: field(1_000_000), assetTypes: field(["Smart contract"]), chains: field(["Ethereum"]) });
const fakeGithub = (notFound = new Set<string>()) => ({
  async getRepository(owner: string, repo: string): Promise<RepositoryIdentity> {
    const k = `${owner}/${repo}`; if (notFound.has(k)) { const { AcquisitionError } = await import("../acquisition/errors.js"); throw new AcquisitionError("repository_not_found", "nf", false); }
    return { repositoryId: 1, fullName: k, defaultBranch: "main", archived: false, fork: false };
  },
});
const page = (id: number, repoUrls: string[]): Record<string, Route> => ({
  "https://audits.sherlock.xyz/robots.txt": { body: "User-Agent: *\n", contentType: "text/plain" },
  [`https://audits.sherlock.xyz/bug-bounties/${id}`]: { body: `<h2>Scope</h2>${repoUrls.map((u) => `<a href="${u}">repo</a>`).join(" ")}` },
});

describe.skipIf(skipIntegration)("enrichment → research: the complete autonomous path over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  const prog = async (id: number) => (await owner().query(
    `INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1,$2,$2,$3::jsonb,'active','official_confirmed') RETURNING id`,
    [`sherlock:${id}`, `P${id}`, resolvedWith(`https://audits.sherlock.xyz/bug-bounties/${id}`)])).rows[0].id as string;
  const linksFor = async (repo: string) => Number((await owner().query("SELECT count(*) AS n FROM bounty_research_links WHERE repository=$1", [repo])).rows[0].n);
  const distinctRuns = async (repo: string) => Number((await owner().query("SELECT count(DISTINCT workflow_run_id) AS n FROM bounty_research_links WHERE repository=$1", [repo])).rows[0].n);
  const sealRepo = async (runId: string, repo: string, commit: string) => {
    const stepId = (await owner().query("SELECT id FROM workflow_steps WHERE workflow_run_id=$1 LIMIT 1", [runId])).rows[0].id as string;
    await owner().query(`INSERT INTO repo_snapshots (workflow_run_id, produced_by_step_id, source_host, repository, commit_sha, ref_name, acquisition_report, file_count, total_bytes, manifest_sha256, sealed_at, sealed_by_step_id, created_at)
      VALUES ($1,$2,'github.com',$3,$4,'main','{}'::jsonb,1,100,$5,now(),$2,now())`, [runId, stepId, repo, commit, "b".repeat(64)]);
  };

  beforeEach(async () => { db = await migratedTestDatabase(); });
  afterEach(async () => { await db?.drop(); });

  it("A–E: eligible-but-unmapped programme is enriched, verified, stored, then auto-queued for research", async () => {
    const p1 = await prog(11);
    // A: eligible but no repository -> the bridge creates nothing.
    expect((await promoteEligibleProgrammes(db.pool, { createdBy: "t" })).created).toBe(0);
    // B–D: enrichment discovers + verifies + stores a repository with provenance.
    const e = await enrichProgramme(db.pool, { get: fakeHttp(page(11, ["https://github.com/napierfi/v1-pool"])), github: fakeGithub() }, p1);
    expect(e.outcome).toBe("enriched"); expect(e.verified).toBe(1);
    const m = (await owner().query("SELECT verification_status, default_branch, source_url, evidence FROM bounty_repository_mappings WHERE bounty_program_id=$1", [p1])).rows[0];
    expect(m).toMatchObject({ verification_status: "official_documentation", default_branch: "main", source_url: "https://audits.sherlock.xyz/bug-bounties/11" });
    expect(m.evidence.length).toBeGreaterThan(0);
    // E: now the bridge automatically queues a research run for the verified repository.
    const promo = await promoteEligibleProgrammes(db.pool, { createdBy: "t" });
    expect(promo.created).toBe(1);
    expect(await linksFor("napierfi/v1-pool")).toBe(1);
  });

  it("F: a second programme enriched to the same repository reuses the existing run (no duplicate research)", async () => {
    const p1 = await prog(11); const p2 = await prog(12);
    for (const [p, id] of [[p1, 11], [p2, 12]] as const) await enrichProgramme(db.pool, { get: fakeHttp(page(id, ["https://github.com/acme/shared"])), github: fakeGithub() }, p);
    const promo = await promoteEligibleProgrammes(db.pool, { createdBy: "t" });
    expect(promo.created).toBe(1);   // one run for the shared repo
    expect(promo.reused).toBe(1);    // the second programme reused it
    expect(await distinctRuns("acme/shared")).toBe(1);
    expect(await linksFor("acme/shared")).toBe(2); // both programmes linked
  });

  it("F2: a repo already analysed by a prior run is reused, not re-dispatched", async () => {
    const p1 = await prog(11);
    // a prior run already sealed acme/known
    const runId = (await owner().query(`INSERT INTO workflow_runs (workflow_type, status, correlation_id, input, created_by) VALUES ('repository_research','succeeded', gen_random_uuid(), '{}'::jsonb, 'manual') RETURNING id`)).rows[0].id as string;
    await owner().query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, status, attempt, input) VALUES ($1,'acquire_repository',0,'worker','succeeded',1,'{}'::jsonb)`, [runId]);
    await sealRepo(runId, "acme/known", "a".repeat(40));
    await enrichProgramme(db.pool, { get: fakeHttp(page(11, ["https://github.com/acme/known"])), github: fakeGithub() }, p1);
    const promo = await promoteEligibleProgrammes(db.pool, { createdBy: "t" });
    expect(promo.created).toBe(0); expect(promo.reused).toBe(1);
    expect(await distinctRuns("acme/known")).toBe(1);
  });

  it("G: a programme scope change is detected and the new repository enters research", async () => {
    const p1 = await prog(11); const t1 = new Date("2026-11-27T10:00:00Z"); const t2 = new Date("2026-11-27T11:00:00Z");
    await enrichProgramme(db.pool, { get: fakeHttp(page(11, ["https://github.com/acme/old"])), github: fakeGithub(), now: () => t1 }, p1);
    await promoteEligibleProgrammes(db.pool, { createdBy: "t" });
    expect(await linksFor("acme/old")).toBe(1);
    const e2 = await enrichProgramme(db.pool, { get: fakeHttp(page(11, ["https://github.com/acme/new"])), github: fakeGithub(), now: () => t2 }, p1);
    expect(e2.dropped).toBe(1);   // acme/old gone from the page
    const promo = await promoteEligibleProgrammes(db.pool, { createdBy: "t" });
    expect(promo.created).toBe(1);
    expect(await linksFor("acme/new")).toBe(1);   // the new repo is now researched
  });

  it("H: an inferred/unverified mapping is never promoted to research automatically", async () => {
    const p1 = await prog(11);
    await owner().query(`INSERT INTO bounty_repository_mappings (bounty_program_id, repository, source_url, discovery_method, verification_status, confidence) VALUES ($1,'acme/guess','https://audits.sherlock.xyz/bug-bounties/11','followed_doc','inferred_unverified','low')`, [p1]);
    const promo = await promoteEligibleProgrammes(db.pool, { createdBy: "t" });
    expect(promo.created).toBe(0);                 // inferred repo does not enter research
    expect(await linksFor("acme/guess")).toBe(0);
  });
});
