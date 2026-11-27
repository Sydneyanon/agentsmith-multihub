/**
 * Repository intelligence (task 6): cross-run knowledge about which repositories and commits have already been analysed, and what
 * changed between two analysed commits. The audit found that `findSnapshot` is per-run only — there was no way to ask "has this
 * repository+commit ever been sealed by ANY run?" or "which files changed since the last analysed commit?". These read-only queries
 * fill that gap over the existing, immutable repo_snapshots / repo_snapshot_files tables. They add no table and change no data.
 *
 * Used by the discovery->research bridge to avoid re-dispatching already-analysed code, and by incremental rescanning to target only
 * the files a new commit changed rather than repeating the whole research process.
 */
import type { Pool } from "pg";

export type AnalysedCommit = {
  snapshotId: string;
  runId: string;
  commitSha: string;
  refName: string | null;
  sealedAt: string;
  manifestSha256: string | null;
  fileCount: number | null;
};

const SELECT_SEALED =
  `SELECT id AS "snapshotId", workflow_run_id AS "runId", commit_sha AS "commitSha", ref_name AS "refName",
          to_char(sealed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sealedAt",
          manifest_sha256 AS "manifestSha256", file_count AS "fileCount"
     FROM repo_snapshots WHERE repository = $1 AND sealed_at IS NOT NULL`;

/** Every sealed snapshot for a repository, across all runs, newest first. */
export async function analysedCommits(pool: Pool, repository: string): Promise<AnalysedCommit[]> {
  const { rows } = await pool.query<AnalysedCommit>(`${SELECT_SEALED} ORDER BY sealed_at DESC`, [repository]);
  return rows;
}

/** Whether this exact (repository, commit) has been sealed by any run. */
export async function hasAnalysedCommit(pool: Pool, repository: string, commitSha: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM repo_snapshots WHERE repository = $1 AND commit_sha = $2 AND sealed_at IS NOT NULL LIMIT 1`, [repository, commitSha]);
  return rows.length > 0;
}

/** The most recently sealed snapshot for a repository (the baseline for an incremental rescan), or null if never analysed. */
export async function latestSealedSnapshot(pool: Pool, repository: string): Promise<AnalysedCommit | null> {
  const { rows } = await pool.query<AnalysedCommit>(`${SELECT_SEALED} ORDER BY sealed_at DESC LIMIT 1`, [repository]);
  return rows[0] ?? null;
}

export type FileChange = { path: string; change: "added" | "removed" | "modified" };

/**
 * The files that differ between two sealed snapshots, by git blob identity. `added`/`removed`/`modified` relative to base->head.
 * This is what an incremental rescan analyses, instead of repeating the whole repository. Both snapshots must be sealed and have
 * their file manifests; an empty result means the two commits are identical in content.
 */
export async function changedFilesBetween(pool: Pool, baseSnapshotId: string, headSnapshotId: string): Promise<FileChange[]> {
  const { rows } = await pool.query<FileChange>(
    `SELECT path,
            CASE WHEN b.git_blob_sha IS NULL THEN 'added'
                 WHEN h.git_blob_sha IS NULL THEN 'removed'
                 ELSE 'modified' END AS change
       FROM (SELECT path, git_blob_sha FROM repo_snapshot_files WHERE snapshot_id = $1) b
       FULL OUTER JOIN (SELECT path, git_blob_sha FROM repo_snapshot_files WHERE snapshot_id = $2) h USING (path)
      WHERE b.git_blob_sha IS DISTINCT FROM h.git_blob_sha
      ORDER BY path`,
    [baseSnapshotId, headSnapshotId]);
  return rows;
}

/** A compact summary of a repository's analysis history, for the bridge and the dashboard. */
export type RepositoryIntel = {
  repository: string;
  analysed: boolean;
  sealedCommits: number;
  latest: AnalysedCommit | null;
};

export async function repositoryIntel(pool: Pool, repository: string): Promise<RepositoryIntel> {
  const commits = await analysedCommits(pool, repository);
  return { repository, analysed: commits.length > 0, sealedCommits: commits.length, latest: commits[0] ?? null };
}

export type ResearchPlan = {
  decision: "already_analysed" | "incremental" | "full";
  baseSnapshotId: string | null;
  baseCommit: string | null;
  reason: string;
};

/**
 * Decide how to research a repository at a given head commit, so a new commit triggers analysis of what changed rather than repeating
 * the whole process (task 6):
 * - already_analysed: this exact commit was sealed before — nothing to do.
 * - full: the repository has never been analysed — do a first full pass.
 * - incremental: the repository was analysed at an earlier commit — analyse the files changed since that baseline (via
 *   changedFilesBetween once the new snapshot is sealed).
 * This is the pure decision a repository monitor makes; it fetches nothing itself.
 */
export async function planRepositoryResearch(pool: Pool, repository: string, headCommit: string): Promise<ResearchPlan> {
  if (await hasAnalysedCommit(pool, repository, headCommit)) {
    return { decision: "already_analysed", baseSnapshotId: null, baseCommit: headCommit, reason: "this commit has already been sealed and analysed" };
  }
  const base = await latestSealedSnapshot(pool, repository);
  if (!base) return { decision: "full", baseSnapshotId: null, baseCommit: null, reason: "repository has never been analysed; do a first full pass" };
  return { decision: "incremental", baseSnapshotId: base.snapshotId, baseCommit: base.commitSha, reason: `new commit since ${base.commitSha.slice(0, 12)}; analyse files changed against that baseline` };
}
