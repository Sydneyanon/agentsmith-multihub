import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analysedCommits, changedFilesBetween, hasAnalysedCommit, latestSealedSnapshot, repositoryIntel } from "../bounties/repo-intel.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

const sha40 = (c: string) => c.repeat(40).slice(0, 40);
const sha64 = (c: string) => c.repeat(64).slice(0, 64);

describe.skipIf(skipIntegration)("repository intelligence over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  const run = async (): Promise<{ runId: string; stepId: string }> => {
    const runId = (await owner().query(
      `INSERT INTO workflow_runs (workflow_type, status, correlation_id, input, created_by) VALUES ('repository_research','succeeded', gen_random_uuid(), '{}'::jsonb, 'test') RETURNING id`)).rows[0].id as string;
    const stepId = (await owner().query(
      `INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, status, attempt, input) VALUES ($1, 'acquire_repository', 0, 'worker', 'succeeded', 1, '{}'::jsonb) RETURNING id`, [runId])).rows[0].id as string;
    return { runId, stepId };
  };
  const sealedSnapshot = async (r: { runId: string; stepId: string }, repo: string, commit: string, when: string) => (await owner().query(
    `INSERT INTO repo_snapshots (workflow_run_id, produced_by_step_id, source_host, repository, commit_sha, ref_name, acquisition_report, file_count, total_bytes, manifest_sha256, sealed_at, sealed_by_step_id, created_at)
     VALUES ($1, $2, 'github.com', $3, $4, 'main', '{}'::jsonb, 3, 300, $5, $6::timestamptz, $2, $6::timestamptz) RETURNING id`,
    [r.runId, r.stepId, repo, commit, sha64(commit.slice(0, 1) || "a"), when])).rows[0].id as string;
  const buildingSnapshot = async (r: { runId: string; stepId: string }, repo: string, commit: string) => (await owner().query(
    `INSERT INTO repo_snapshots (workflow_run_id, produced_by_step_id, source_host, repository, commit_sha, ref_name, acquisition_report)
     VALUES ($1, $2, 'github.com', $3, $4, 'main', '{}'::jsonb) RETURNING id`, [r.runId, r.stepId, repo, commit])).rows[0].id as string;
  const addFile = async (snapshotId: string, r: { runId: string; stepId: string }, path: string, gitBlob: string) => owner().query(
    `INSERT INTO repo_snapshot_files (snapshot_id, workflow_run_id, produced_by_step_id, path, git_blob_sha, size_bytes, classification, skip_reason) VALUES ($1,$2,$3,$4,$5,100,'source','excluded_by_policy')`,
    [snapshotId, r.runId, r.stepId, path, sha40(gitBlob)]);

  beforeAll(async () => { db = await migratedTestDatabase(); });
  afterAll(async () => { await db?.drop(); });

  it("finds every sealed commit for a repository across runs, newest first", async () => {
    const repo = "acme/alpha";
    const r1 = await run(); await sealedSnapshot(r1, repo, sha40("a"), "2026-11-20T00:00:00Z");
    const r2 = await run(); await sealedSnapshot(r2, repo, sha40("b"), "2026-11-25T00:00:00Z");
    const commits = await analysedCommits(db.pool, repo);
    expect(commits.map((c) => c.commitSha)).toEqual([sha40("b"), sha40("a")]); // newest first
    expect(commits.every((c) => c.runId)).toBe(true);
    expect(await hasAnalysedCommit(db.pool, repo, sha40("a"))).toBe(true);
    expect(await hasAnalysedCommit(db.pool, repo, sha40("c"))).toBe(false);
    const latest = await latestSealedSnapshot(db.pool, repo);
    expect(latest?.commitSha).toBe(sha40("b"));
    const intel = await repositoryIntel(db.pool, repo);
    expect(intel).toMatchObject({ analysed: true, sealedCommits: 2 });
    expect(intel.latest?.commitSha).toBe(sha40("b"));
  });

  it("a never-analysed repository reports nothing", async () => {
    expect(await analysedCommits(db.pool, "acme/unknown")).toEqual([]);
    expect(await hasAnalysedCommit(db.pool, "acme/unknown", sha40("a"))).toBe(false);
    expect(await latestSealedSnapshot(db.pool, "acme/unknown")).toBeNull();
    expect(await repositoryIntel(db.pool, "acme/unknown")).toMatchObject({ analysed: false, sealedCommits: 0, latest: null });
  });

  it("detects added, removed and modified files between two commits (incremental rescan target)", async () => {
    const repo = "acme/beta";
    const r1 = await run(); const base = await buildingSnapshot(r1, repo, sha40("1"));
    await addFile(base, r1, "src/Vault.sol", "1"); await addFile(base, r1, "src/Token.sol", "2"); await addFile(base, r1, "README.md", "3");
    const r2 = await run(); const head = await buildingSnapshot(r2, repo, sha40("2"));
    await addFile(head, r2, "src/Vault.sol", "9");   // modified (git blob changed)
    await addFile(head, r2, "README.md", "3");        // unchanged
    await addFile(head, r2, "src/Oracle.sol", "4");   // added
    // src/Token.sol removed
    const changes = await changedFilesBetween(db.pool, base, head);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.change]));
    expect(byPath).toEqual({ "src/Vault.sol": "modified", "src/Token.sol": "removed", "src/Oracle.sol": "added" });
    expect(changes.some((c) => c.path === "README.md")).toBe(false); // unchanged files are excluded
  });
});
