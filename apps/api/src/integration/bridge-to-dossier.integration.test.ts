import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { buildDossier } from "../analysis/solidity/pipeline.js";
import { promoteEligibleProgrammes } from "../bounties/promote.js";
import { ResearchStore } from "../research-state.js";
import { runIntakeWorker } from "../worker-runtime.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * The production research path end to end, through the REAL worker runtime (runIntakeWorker and its step dispatcher), not
 * steps driven by hand: an officially confirmed programme with a verified repository mapping -> the bridge (--structural) ->
 * the worker (STRUCTURAL_ANALYSIS_ENABLED only, scoped to the one run) -> commit-pinned acquisition and sealing -> structural
 * analysis -> challenge -> an evidence-verified dossier. The only substitution is transport: the repository source serves a real
 * git repository built locally from a controlled corpus (eval/dev), so no third-party code and no network are involved.
 */
const repoRoot = join(__dirname, "..", "..", "..", "..");
const field = (value: unknown) => ({ value, source: "sherlock", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });

describe.skipIf(skipIntegration)("bridge -> worker runtime -> dossier (the first-research-run path)", () => {
  let db: TestDatabase; let fx: GitFixture;
  const owner = () => db.ownerPool ?? db.pool;
  beforeAll(async () => {
    db = await migratedTestDatabase();
    const corpus = join(repoRoot, "eval", "dev", "contracts");
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "bounty-target" });
  });
  afterAll(async () => { fx?.cleanup(); await db?.drop(); });

  it("creates one run automatically and completes it into a verified dossier with no model calls", async () => {
    const resolved = { projectName: field("Acme"), officialUrl: field("https://audits.sherlock.xyz/bug-bounties/901"), maxReward: field(250_000), chains: field(["Ethereum"]), technologies: field(["Solidity"]) };
    const prog = (await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification)
      VALUES ('sherlock:901', 'Acme', 'acme', $1::jsonb, 'active', 'official_confirmed') RETURNING id`, [JSON.stringify(resolved)])).rows[0].id as string;
    await owner().query(`INSERT INTO bounty_repository_mappings (bounty_program_id, repository, source_url, evidence, discovery_method, verification_status, confidence, default_branch, repository_github_id, last_seen_at)
      VALUES ($1, 'acme/bounty-target', 'https://audits.sherlock.xyz/bug-bounties/901', 'https://github.com/acme/bounty-target', 'official_page', 'official_documentation', 'high', 'main', 4242, now())`, [prog]);

    const promo = await promoteEligibleProgrammes(db.pool, { createdBy: "bridge@test", structuralAnalysis: true, maxNewRuns: 1 });
    expect(promo).toMatchObject({ eligible_programmes: 1, created: 1 });
    const runId = (await owner().query(`SELECT workflow_run_id FROM bounty_research_links WHERE repository = 'acme/bounty-target'`)).rows[0].workflow_run_id as string;

    const saved = { s: process.env.STRUCTURAL_ANALYSIS_ENABLED, e: process.env.ENGINE_LOOP_ENABLED };
    process.env.STRUCTURAL_ANALYSIS_ENABLED = "true"; delete process.env.ENGINE_LOOP_ENABLED; // the bridge path needs only this switch
    const ac = new AbortController();
    const loop = runIntakeWorker(db.pool, "first-run-worker", ac.signal, { onlyRunId: runId, pollMs: 50, source: new FakeSource(fx) });
    let steps: Array<{ step_key: string; status: string }> = [];
    try {
      for (let i = 0; i < 1200; i++) {
        steps = (await owner().query(`SELECT step_key, status FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence`, [runId])).rows;
        if (steps.every((s) => s.status === "succeeded") || steps.some((s) => s.status === "failed")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      ac.abort(); await loop.catch(() => undefined);
      if (saved.s === undefined) delete process.env.STRUCTURAL_ANALYSIS_ENABLED; else process.env.STRUCTURAL_ANALYSIS_ENABLED = saved.s;
      if (saved.e !== undefined) process.env.ENGINE_LOOP_ENABLED = saved.e;
    }
    expect(steps.map((s) => `${s.step_key}:${s.status}`)).toEqual(["acquire_repository:succeeded", "analyze_structure:succeeded", "challenge_leads:succeeded", "build_dossier:succeeded"]);

    const snap = (await owner().query(`SELECT id, commit_sha, manifest_sha256, sealed_at FROM repo_snapshots WHERE workflow_run_id = $1`, [runId])).rows[0];
    expect(snap.commit_sha).toBe(fx.commitSha);           // pinned to the exact commit
    expect(snap.sealed_at).not.toBeNull();
    const d = await buildDossier(db.pool, new ResearchStore(db.pool), snap.id);
    expect(d.snapshot.verified).toBe(true);
    expect(d.entries.length).toBeGreaterThan(0);
    expect(d.entries.every((e) => e.evidence.length > 0 && e.evidence.every((x) => x.verified))).toBe(true);
    expect((await owner().query(`SELECT count(*)::int AS n FROM model_usage_events`)).rows[0].n).toBe(0);
  });
});
