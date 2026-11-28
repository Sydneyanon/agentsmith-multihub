import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { buildDossier, renderDossierMarkdown } from "../analysis/solidity/pipeline.js";
import { promoteEligibleProgrammes, type PromoteTarget } from "../bounties/promote.js";
import { ResearchStore } from "../research-state.js";
import { runIntakeWorker } from "../worker-runtime.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * The first-run path for a SPECIFIC programme: a targeted promotion (one programme, one of its verified repositories, one exact
 * commit, the official scope) -> the real worker runtime -> a dossier in which every lead is labelled in or out of bounty scope.
 * Transport is a real git repository built locally from the controlled dev corpus; no network, no third-party code.
 */
const repoRoot = join(__dirname, "..", "..", "..", "..");
const field = (value: unknown) => ({ value, source: "sherlock", authority: 10, observedAt: "2026-11-28T00:00:00Z", conflicts: [] });
const SHA = "a".repeat(64);

describe.skipIf(skipIntegration)("targeted, commit-pinned, bounty-scoped promotion -> dossier", () => {
  let db: TestDatabase; const fixtures: GitFixture[] = []; let n = 7000;
  const owner = () => db.ownerPool ?? db.pool;
  const corpus = join(repoRoot, "eval", "dev", "contracts");
  const sol = readdirSync(corpus).sort();
  // in-scope sources under src/, the same contracts again under test/ (out of scope), so leads arise on both sides
  const files = () => [...sol.map((f) => ({ path: `src/${f}`, content: readFileSync(join(corpus, f), "utf8") })), ...sol.slice(0, 3).map((f) => ({ path: `test/${f}`, content: readFileSync(join(corpus, f), "utf8") }))];
  const inScope = () => sol.map((f) => `src/${f}`);
  beforeAll(async () => { db = await migratedTestDatabase(); });
  afterAll(async () => { for (const f of fixtures) f.cleanup(); await db?.drop(); });

  async function seed(repo: string, opts: { verification?: string } = {}) {
    const fx = buildGitFixture(files(), { owner: "acme", repo }); fixtures.push(fx); n += 1;
    const resolved = { projectName: field(repo), officialUrl: field(`https://audits.sherlock.xyz/bug-bounties/${n}`), maxReward: field(100_000), chains: field(["Ethereum"]), technologies: field(["Solidity"]) };
    const key = `sherlock:${n}`;
    const prog = (await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1, $2, $2, $3::jsonb, 'active', $4) RETURNING id`,
      [key, repo, JSON.stringify(resolved), opts.verification ?? "official_confirmed"])).rows[0].id as string;
    await owner().query(`INSERT INTO bounty_repository_mappings (bounty_program_id, repository, source_url, evidence, discovery_method, verification_status, confidence, default_branch, repository_github_id, last_seen_at)
      VALUES ($1, $2, $3, $4, 'official_page', 'official_documentation', 'high', 'main', $5, now())`, [prog, `acme/${repo}`, `https://audits.sherlock.xyz/bug-bounties/${n}`, `https://github.com/acme/${repo}`, n]);
    return { fx, key };
  }

  async function runWorker(runId: string, fx: GitFixture) {
    const saved = process.env.STRUCTURAL_ANALYSIS_ENABLED; process.env.STRUCTURAL_ANALYSIS_ENABLED = "true";
    const ac = new AbortController();
    const loop = runIntakeWorker(db.pool, "targeted-worker", ac.signal, { onlyRunId: runId, pollMs: 50, source: new FakeSource(fx) });
    try {
      for (let i = 0; i < 1200; i++) {
        const steps = (await owner().query(`SELECT status FROM workflow_steps WHERE workflow_run_id = $1`, [runId])).rows as Array<{ status: string }>;
        if (steps.every((x) => x.status === "succeeded") || steps.some((x) => x.status === "failed")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally { ac.abort(); await loop.catch(() => undefined); if (saved === undefined) delete process.env.STRUCTURAL_ANALYSIS_ENABLED; else process.env.STRUCTURAL_ANALYSIS_ENABLED = saved; }
  }

  it("creates exactly one run for the named programme, repository and commit, carrying the scope; the dossier labels every lead", async () => {
    const decoy = await seed("decoy-programme"); // another eligible programme: a targeted promotion must not touch it
    const { fx, key } = await seed("usx-like");
    const scope = { programme: key, in_scope_paths: inScope(), evidence: "docs/research-runs/usx-scope-evidence.md", evidence_sha256: SHA };
    const r = await promoteEligibleProgrammes(db.pool, { structuralAnalysis: true, maxNewRuns: 1, target: { programme: key, repository: "acme/usx-like", commit: fx.commitSha, bountyScope: scope } });
    expect(r).toMatchObject({ eligible_programmes: 1, repositories_considered: 1, created: 1 });
    const runId = r.actions[0]!.workflowRunId!;
    const link = (await owner().query(`SELECT ref, repository FROM bounty_research_links WHERE workflow_run_id = $1`, [runId])).rows;
    expect(link).toEqual([{ ref: fx.commitSha, repository: "acme/usx-like" }]);
    const run = (await owner().query(`SELECT input FROM workflow_runs WHERE id = $1`, [runId])).rows[0].input;
    expect(run.ref).toBe(fx.commitSha);
    expect(run.bounty_scope).toEqual({ ...scope, in_scope_paths: [...scope.in_scope_paths].sort() });
    expect((await owner().query(`SELECT count(*)::int AS n FROM bounty_research_links l JOIN bounty_programs p ON p.id = l.bounty_program_id WHERE p.canonical_key = $1`, [decoy.key])).rows[0].n).toBe(0);

    await runWorker(runId, fx);
    const snap = (await owner().query(`SELECT id, commit_sha FROM repo_snapshots WHERE workflow_run_id = $1`, [runId])).rows[0];
    expect(snap.commit_sha).toBe(fx.commitSha); // pinned to the exact commit requested
    const d = await buildDossier(db.pool, new ResearchStore(db.pool), snap.id);
    expect(d.entries.length).toBeGreaterThan(0);
    expect(d.entries.every((e) => e.scope_status === "in_scope" || e.scope_status === "out_of_scope")).toBe(true);
    for (const e of d.entries) {
      const at = (e.evidence.find((x) => x.role === "primary") ?? e.evidence[0])!.path;
      expect(e.scope_status).toBe(at.startsWith("src/") ? "in_scope" : "out_of_scope");
    }
    expect(d.bounty_scope).toMatchObject({ programme: key, in_scope_files: sol.length });
    expect(d.bounty_scope!.out_of_scope_leads).toBeGreaterThan(0); // the test/ copies produce leads that must be labelled out of scope
    expect(d.bounty_scope!.in_scope_leads + d.bounty_scope!.out_of_scope_leads).toBe(d.entries.length);
    const md = renderDossierMarkdown(d);
    expect(md).toContain(`**Bounty scope:** ${key}`);
    expect(md).toContain("OUT OF BOUNTY SCOPE: not an eligible finding");
    expect(d.limitations.join(" ")).toMatch(/only leads whose primary location is in scope can be eligible/);
  });

  it("refuses anything it would otherwise have to infer: an unverified repository, a short commit, an ineligible programme, a mismatched scope", async () => {
    const { fx, key } = await seed("refusals");
    const go = (target: PromoteTarget) => promoteEligibleProgrammes(db.pool, { structuralAnalysis: true, maxNewRuns: 1, target });
    await expect(go({ programme: key, repository: "acme/not-this-programmes-repo", commit: fx.commitSha })).rejects.toThrow(/refusing to infer an association/);
    await expect(go({ programme: key, repository: "acme/refusals", commit: fx.commitSha.slice(0, 7) })).rejects.toThrow(/full 40-character commit/);
    await expect(go({ programme: "sherlock:does-not-exist", repository: "acme/refusals", commit: fx.commitSha })).rejects.toThrow(/does not exist/);
    await expect(go({ programme: key, repository: "acme/refusals", commit: fx.commitSha, bountyScope: { programme: "sherlock:other", in_scope_paths: ["src/A.sol"], evidence: "x", evidence_sha256: SHA } })).rejects.toThrow(/different programme/);
    const community = await seed("community-only", { verification: "community_reported" });
    await expect(go({ programme: community.key, repository: "acme/community-only", commit: community.fx.commitSha })).rejects.toThrow(/not eligible/);
    expect((await owner().query(`SELECT count(*)::int AS n FROM workflow_runs WHERE input->>'value' IN ('acme/refusals', 'acme/community-only')`)).rows[0].n).toBe(0);
  });

  it("a pinned promotion never reuses a run that analysed the repository at another commit", async () => {
    const { fx, key } = await seed("reuse-guard");
    const first = await promoteEligibleProgrammes(db.pool, { structuralAnalysis: true, maxNewRuns: 100 }); // untargeted: default branch, ref null (other test programmes may also be promoted)
    const untargeted = first.actions.find((a) => a.repository === "acme/reuse-guard" && a.action === "created")!.workflowRunId!;
    await runWorker(untargeted, fx);
    const pinned = await promoteEligibleProgrammes(db.pool, { structuralAnalysis: true, maxNewRuns: 1, target: { programme: key, repository: "acme/reuse-guard", commit: fx.commitSha } });
    expect(pinned.actions[0]).toMatchObject({ action: "created", ref: fx.commitSha });
    expect(pinned.actions[0]!.workflowRunId).not.toBe(untargeted);
  });
});
