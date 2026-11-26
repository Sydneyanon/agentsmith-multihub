/**
 * First genuine PASSIVE research run: acquire a public repository at a pinned commit, analyse its Solidity, challenge the leads, build the dossier.
 *
 * Usage (on a machine that can reach api.github.com and codeload.github.com; needs a LOCAL disposable Postgres, see TEST_DATABASE_URL below):
 *   TEST_DATABASE_URL=postgres://agentsmith_test:...@127.0.0.1:5432/postgres npx tsx scripts/live-research-run.ts <owner/repo> [ref] [outDir]
 *   npx tsx scripts/live-research-run.ts fixture:eval/dev ...           # offline rehearsal on a local fixture, no network
 *   npx tsx scripts/live-research-run.ts clone:<dir>@<owner/repo> <commitSha> [outDir]   # a public repository already cloned read-only (no hooks, no submodules);
 *        the archive and tree are produced by `git archive` / `git ls-tree` from the PINNED commit, verified against git object ids; the GitHub API is not used
 *
 * What it does: reads the repository over the GitHub API and archive endpoint (read only, unauthenticated unless GITHUB_TOKEN is set), pins the commit,
 * stores it in a THROWAWAY database that is dropped at the end, and writes dossier.md / dossier.json / run-report.json to outDir.
 * What it never does: execute any code from the repository, install anything, write outside outDir, contact the project, test anything actively,
 * touch the production database, or submit anything. A repository you did not approve must not be run.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { GitFixture } from "../apps/api/src/acquisition/testing/git-fixture.js";
import type { TreeEntry } from "../apps/api/src/acquisition/github-source.js";
import { join } from "node:path";
import { acquireRepository } from "../apps/api/src/acquisition/acquire.js";
import { GitHubSource, type RepositorySource } from "../apps/api/src/acquisition/github-source.js";
import { FakeSource } from "../apps/api/src/acquisition/testing/fake-source.js";
import { buildGitFixture } from "../apps/api/src/acquisition/testing/git-fixture.js";
import { buildDossier, renderDossierMarkdown, runChallenge, runStructuralAnalysis } from "../apps/api/src/analysis/solidity/pipeline.js";
import { assertIntegrationConfigured, migratedTestDatabase, seedRun } from "../apps/api/src/integration/harness.js";
import { ResearchStore } from "../apps/api/src/research-state.js";
import { WorkflowWorker } from "../apps/api/src/worker.js";

const [target, ref = "HEAD", outDir = "research-run-output"] = process.argv.slice(2);
if (!target) { console.error("usage: live-research-run.ts <owner/repo | fixture:<dir>> [ref] [outDir]"); process.exit(2); }

/** Wrap an existing read-only clone as a repository source pinned to `commitSha`; refuses if the clone's HEAD is not that commit. */
function sourceFromClone(dir: string, owner: string, repo: string, commitSha: string): GitFixture {
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 512 * 1024 * 1024 });
  const head = git("rev-parse", "HEAD").toString().trim();
  if (head !== commitSha) throw new Error(`clone HEAD ${head} is not the pinned commit ${commitSha}`);
  const treeSha = git("rev-parse", `${commitSha}^{tree}`).toString().trim();
  const prefix = `${owner}-${repo}-${commitSha.slice(0, 7)}`;
  const tarball = git("archive", "--format=tar", `--prefix=${prefix}/`, commitSha);
  const treeEntries: TreeEntry[] = [];
  for (const record of git("ls-tree", "-r", "-t", "-z", "--long", commitSha).toString("utf8").split("\0")) {
    if (!record) continue; const tab = record.indexOf("\t"); const [mode, type, sha, size] = record.slice(0, tab).split(/\s+/);
    treeEntries.push({ path: record.slice(tab + 1), mode: mode!, type: type as TreeEntry["type"], sha: sha!, ...(type === "blob" ? { size: Number(size) } : {}) });
  }
  return { owner, repo, commitSha, treeSha, prefix, tarGz: gzipSync(tarball), tarball, treeEntries, files: [], cleanup: () => {} };
}

async function main(): Promise<void> {
  assertIntegrationConfigured();
  let source: RepositorySource; let repository = target!; let cleanup = () => {};
  if (target!.startsWith("fixture:")) {
    const dir = join(target!.slice("fixture:".length), "contracts");
    const fx = buildGitFixture(readdirSync(dir).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(dir, n), "utf8") })), { owner: "local", repo: "fixture" });
    source = new FakeSource(fx); repository = "local/fixture"; cleanup = () => fx.cleanup();
  } else if (target!.startsWith("clone:")) {
    const [dir, full] = target!.slice("clone:".length).split("@"); const [owner, repo] = (full ?? "").split("/");
    if (!dir || !owner || !repo || !/^[0-9a-f]{40}$/.test(ref)) throw new Error("clone mode needs clone:<dir>@<owner/repo> and a full 40-hex commit SHA as the ref");
    source = new FakeSource(sourceFromClone(dir, owner, repo, ref)); repository = `${owner}/${repo}`;
    console.log(`PASSIVE analysis of ${repository} at pinned commit ${ref} from a read-only clone (archive and tree produced by git from that commit; GitHub API not used); nothing from the repository is executed.`);
  } else {
    console.log(`PASSIVE read of ${target} at ${ref}: hosts api.github.com and codeload.github.com only; nothing from the repository is executed.`);
    source = new GitHubSource({ ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}) });
  }
  const db = await migratedTestDatabase(); const t0 = Date.now();
  try {
    const store = new ResearchStore(db.pool);
    const { runId } = await seedRun(db.ownerPool, ["acquire_repository", "analyze_structure", "challenge_leads"]);
    const worker = new WorkflowWorker(db.pool, "live-run", 600, 3);
    const lease = async (k: string) => { const s = await worker.claimNext([k]); if (!s) throw new Error(`cannot claim ${k}`); return { stepId: s.id, workerId: "live-run" }; };
    const l1 = await lease("acquire_repository");
    const acq = await acquireRepository({ store, source, progress: (e, f) => console.log(`acquisition ${e}`, f ?? "") }, l1, { repository, ...(ref === "HEAD" ? {} : { ref }) });
    await worker.complete(l1.stepId, { status: "sealed" });
    console.log(`sealed snapshot ${acq.snapshotId}: ${acq.fileCount} files, commit ${acq.commitSha}, completeness ${acq.completeness}`);
    const l2 = await lease("analyze_structure"); const analysis = await runStructuralAnalysis(db.pool, store, l2, acq.snapshotId);
    await worker.complete(l2.stepId, { status: "analyzed", hypotheses: analysis.stored.length, protocol_model_sha256: analysis.protocolModel.sha256, protocol_model_stored: analysis.protocolModel.stored });
    const l3 = await lease("challenge_leads"); await runChallenge(db.pool, store, l3, acq.snapshotId, analysis.stored); await worker.complete(l3.stepId, { status: "challenged" });
    const dossier = await buildDossier(db.pool, store, acq.snapshotId);
    mkdirSync(outDir!, { recursive: true });
    writeFileSync(join(outDir!, "dossier.json"), JSON.stringify(dossier, null, 2)); writeFileSync(join(outDir!, "dossier.md"), renderDossierMarkdown(dossier));
    const report = { repository, ref, commit_sha: acq.commitSha, manifest_sha256: acq.manifestSha256, files: acq.fileCount, completeness: acq.completeness, contracts: analysis.contracts, functions: analysis.functions, leads: analysis.stored.length,
      parse_problems: analysis.problems, dossier_content_sha256: dossier.content_sha256, seconds: Math.round((Date.now() - t0) / 1000), passive_only: true, note: "Leads are unverified; no human review is recorded." };
    writeFileSync(join(outDir!, "run-report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { await db.drop(); cleanup(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
