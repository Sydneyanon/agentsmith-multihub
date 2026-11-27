import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositoryResearchRun } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { buildDossier, renderDossierMarkdown } from "../analysis/solidity/pipeline.js";
import { ANALYZER_VERSION } from "../analysis/solidity/keys.js";
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
  let db: TestDatabase; const fixtures: GitFixture[] = []; let n = 900;
  const owner = () => db.ownerPool ?? db.pool;
  const corpus = join(repoRoot, "eval", "dev", "contracts");
  const devFiles = () => readdirSync(corpus).sort().map((f) => ({ path: `contracts/${f}`, content: readFileSync(join(corpus, f), "utf8") }));
  beforeAll(async () => { db = await migratedTestDatabase(); });
  afterAll(async () => { for (const f of fixtures) f.cleanup(); await db?.drop(); });

  /** Seed one eligible programme with a verified mapping, bridge it, run the real worker on that one run, return run + dossier. */
  async function research(repo: string, files: Array<{ path: string; content: string }>) {
    const fx = buildGitFixture(files, { owner: "acme", repo }); fixtures.push(fx); n += 1;
    const resolved = { projectName: field(repo), officialUrl: field(`https://audits.sherlock.xyz/bug-bounties/${n}`), maxReward: field(250_000), chains: field(["Ethereum"]), technologies: field(["Solidity"]) };
    const prog = (await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification)
      VALUES ($1, $2, $2, $3::jsonb, 'active', 'official_confirmed') RETURNING id`, [`sherlock:${n}`, repo, JSON.stringify(resolved)])).rows[0].id as string;
    await owner().query(`INSERT INTO bounty_repository_mappings (bounty_program_id, repository, source_url, evidence, discovery_method, verification_status, confidence, default_branch, repository_github_id, last_seen_at)
      VALUES ($1, $2, $3, $4, 'official_page', 'official_documentation', 'high', 'main', $5, now())`, [prog, `acme/${repo}`, `https://audits.sherlock.xyz/bug-bounties/${n}`, `https://github.com/acme/${repo}`, n]);
    const promo = await promoteEligibleProgrammes(db.pool, { createdBy: "bridge@test", structuralAnalysis: true, maxNewRuns: 1 });
    expect(promo.created).toBe(1);
    const runId = (await owner().query(`SELECT workflow_run_id FROM bounty_research_links WHERE repository = $1`, [`acme/${repo}`])).rows[0].workflow_run_id as string;
    const saved = { s: process.env.STRUCTURAL_ANALYSIS_ENABLED, e: process.env.ENGINE_LOOP_ENABLED };
    process.env.STRUCTURAL_ANALYSIS_ENABLED = "true"; delete process.env.ENGINE_LOOP_ENABLED; // the bridge path needs only this switch
    const ac = new AbortController();
    const loop = runIntakeWorker(db.pool, "first-run-worker", ac.signal, { onlyRunId: runId, pollMs: 50, source: new FakeSource(fx) });
    let steps: Array<{ step_key: string; status: string }> = []; let maxRunning = 0;
    try {
      for (let i = 0; i < 1200; i++) {
        maxRunning = Math.max(maxRunning, Number((await owner().query(`SELECT count(*) AS n FROM workflow_steps WHERE status = 'running'`)).rows[0].n)); // across ALL runs
        steps = (await owner().query(`SELECT step_key, status FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence`, [runId])).rows;
        if (steps.every((x) => x.status === "succeeded") || steps.some((x) => x.status === "failed")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      ac.abort(); await loop.catch(() => undefined);
      if (saved.s === undefined) delete process.env.STRUCTURAL_ANALYSIS_ENABLED; else process.env.STRUCTURAL_ANALYSIS_ENABLED = saved.s;
      if (saved.e !== undefined) process.env.ENGINE_LOOP_ENABLED = saved.e;
    }
    const snap = (await owner().query(`SELECT id, commit_sha, sealed_at FROM repo_snapshots WHERE workflow_run_id = $1`, [runId])).rows[0];
    const d = snap ? await buildDossier(db.pool, new ResearchStore(db.pool), snap.id) : null;
    return { fx, steps, snap, d, runId, maxRunning };
  }

  it("creates one run automatically and completes it into a verified, COMPLETE dossier with no model calls", async () => {
    const { fx, steps, snap, d } = await research("bounty-target", devFiles());
    expect(steps.map((x) => `${x.step_key}:${x.status}`)).toEqual(["acquire_repository:succeeded", "analyze_structure:succeeded", "challenge_leads:succeeded", "build_dossier:succeeded"]);
    expect(snap.commit_sha).toBe(fx.commitSha); expect(snap.sealed_at).not.toBeNull(); // pinned to the exact commit, sealed
    expect(d!.snapshot.verified).toBe(true);
    expect(d!.coverage).toMatchObject({ status: "complete", problems: [] });
    expect(d!.coverage.solidity_files).toBe(devFiles().length);
    expect(d!.entries.length).toBeGreaterThan(0);
    expect(d!.entries.every((e) => e.evidence.length > 0 && e.evidence.every((x) => x.verified))).toBe(true);
    const md = renderDossierMarkdown(d!); // an undecided independent check is never presented as absence
    const undecided = d!.entries.filter((e) => !e.evaluations.length || e.evaluations.some((v) => v.outcome === "inconclusive")).length;
    expect(undecided).toBeGreaterThan(0);
    expect(md.split("That is NOT evidence that the issue is absent").length - 1).toBe(undecided);
    expect(renderDossierMarkdown(d!)).toMatch(/\*\*Analysis coverage: COMPLETE\*\*/);
    // every dossier names the analyzer that produced it; a source checkout has no build-info.json, so the commit is "not recorded", never guessed
    expect(d!.analyzer).toEqual({ version: ANALYZER_VERSION, build_commit: null, image: null });
    expect(renderDossierMarkdown(d!)).toContain(`Analyzer: ${ANALYZER_VERSION}; build commit not recorded.`);
    expect((await owner().query(`SELECT count(*)::int AS n FROM model_usage_events`)).rows[0].n).toBe(0);
  });

  it("marks a dossier PARTIAL, listing the problem, when part of the snapshot could not be analysed", async () => {
    const { d } = await research("half-parsed", [...devFiles(), { path: "contracts/Broken.sol", content: "pragma solidity ^0.8.20;\ncontract Broken { function f( external { }\n" }]);
    expect(d!.coverage.status).toBe("partial");
    expect(d!.coverage.problems.join(" ")).toMatch(/Broken\.sol/);
    expect(renderDossierMarkdown(d!)).toMatch(/\*\*Analysis coverage: PARTIAL\*\*[\s\S]*NOT a complete investigation/);
  });

  it("marks a repository without Solidity NOT ANALYSABLE instead of reporting a clean result", async () => {
    const { steps, d } = await research("rust-only", [{ path: "src/lib.rs", content: "pub fn f() {}\n" }, { path: "README.md", content: "# x\n" }]);
    expect(steps.every((x) => x.status === "succeeded")).toBe(true);
    expect(d!.coverage).toMatchObject({ status: "not_analysable", solidity_files: 0 });
    expect(d!.entries).toEqual([]);
    expect(renderDossierMarkdown(d!)).toContain("No leads were generated. That is NOT evidence that the code is free of vulnerabilities");
    expect(renderDossierMarkdown(d!)).toMatch(/NOT ANALYSABLE[\s\S]*NOT a complete investigation/);
  });

  it("the scoped worker touches only its assigned run, one step at a time, even with other claimable research queued", async () => {
    // Decoys: two other queued research runs whose steps this worker's step keys COULD claim if it were not scoped.
    const decoys = [await createRepositoryResearchRun(db.pool, { repository: "acme/decoy-one", ref: "main" }, "operator", { structuralAnalysis: true }),
      await createRepositoryResearchRun(db.pool, { repository: "acme/decoy-two", ref: "main" }, "operator", { structuralAnalysis: true })];
    const { steps, runId, maxRunning } = await research("scoped-target", devFiles());
    expect(steps.every((x) => x.status === "succeeded")).toBe(true);
    expect(maxRunning).toBeLessThanOrEqual(1);                                      // concurrency one, observed across all runs
    for (const d of decoys) {
      const rows = (await owner().query(`SELECT status, attempt FROM workflow_steps WHERE workflow_run_id = $1`, [d.runId])).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status === "queued" && r.attempt === 0)).toBe(true); // never claimed, never attempted
      expect((await owner().query(`SELECT count(*)::int AS n FROM repo_snapshots WHERE workflow_run_id = $1`, [d.runId])).rows[0].n).toBe(0);
    }
    expect(runId).not.toBe(decoys[0]!.runId);
  });
});

