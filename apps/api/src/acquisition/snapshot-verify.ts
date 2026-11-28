import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { canonicalJson } from "../research-state.js";
import { AcquisitionError } from "./errors.js";
import { gitBlobSha1 } from "./git-hash.js";
import { parseRepositoryName, type RepositorySource } from "./github-source.js";
import { resolveLimits } from "./limits.js";
import { buildPlan, type PlanItem } from "./plan.js";

/**
 * Option D, D2: before the API seals a snapshot that a worker uploaded, it verifies the snapshot against GitHub ITSELF, through its own
 * authenticated read-only source, and recomputes every hash on the server:
 *  - the commit: the snapshot's commit must equal the pinned ref when the ref is a 40-hex commit, and the commit the API resolved for the
 *    queued ref otherwise (a ref that moved since acquisition is refused; the step is retried and re-acquires);
 *  - the tree: the API fetches the commit's recursive tree (a truncated tree is refused) and recomputes the acquisition PLAN from it with
 *    the step's own options (buildPlan is a pure function of the tree), so the manifest must list EXACTLY the plan's paths: a path that is
 *    not in the tree, or that the plan excludes (unrepresentable), or a missing path, is refused;
 *  - every row: its classification and size equal the plan's; its git blob id equals the tree's; a STORED file's bytes (read back from the
 *    database) hash to that git blob id (gitBlobSha1, recomputed here); a skip decided from the tree alone (symlink, submodule, excluded,
 *    oversize, byte budget) must be exactly the plan's decision; a skip decided from content (binary, encoding) cannot be checked without
 *    the bytes, so it is accepted only for files the analysis never reads (not *.sol) and is recorded as UNVERIFIED.
 * A network failure is a retryable refusal, never an acceptance. The result is stored as evidence (snapshot_verifications + a blob).
 */
export type ManifestRow = { path: string; blob_sha256: string | null; git_blob_sha: string | null; size_bytes: number; classification: string; skip_reason: string | null };
export type FileResult = { path: string; expected_git_sha: string | null; observed_git_sha: string | null; result: "content_matched" | "skip_verified" | "skip_unverified" };
export type SnapshotVerification = {
  requestedRef: string | null; resolvedCommit: string; treeSha: string; completeness: "complete" | "partial";
  files: FileResult[]; manifestFingerprint: string; resultBlob: Buffer; fileBlobs: Buffer[];
  counts: { total: number; matched: number; skipsVerified: number; skipsUnverified: number };
};
export class SnapshotVerificationError extends Error {
  constructor(readonly retryable: boolean, readonly code: string, message: string, readonly problems: string[] = []) { super(message); this.name = "SnapshotVerificationError"; }
}

const CONTENT_SKIPS = new Set(["binary", "unreadable_encoding"]);
export const manifestFingerprint = (rows: readonly ManifestRow[]) => createHash("sha256").update(canonicalJson([...rows].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map((r) => [r.path, r.blob_sha256, r.git_blob_sha, Number(r.size_bytes), r.classification, r.skip_reason]))).digest("hex");

export async function manifestRows(db: Pick<Pool, "query">, snapshotId: string): Promise<ManifestRow[]> {
  return (await db.query<ManifestRow>("SELECT path, blob_sha256, git_blob_sha, size_bytes, classification, skip_reason FROM repo_snapshot_files WHERE snapshot_id = $1 ORDER BY path COLLATE \"C\"", [snapshotId])).rows
    .map((r) => ({ ...r, size_bytes: Number(r.size_bytes) }));
}

export async function verifySnapshotAgainstGitHub(db: Pick<Pool, "query">, source: RepositorySource, snapshot: { id: string; commitSha: string },
  input: { repository: string; ref?: string | undefined; excludePathPrefixes?: readonly string[] | undefined; onUnrepresentable?: "fail" | "seal_partial" | undefined }, signal?: AbortSignal): Promise<SnapshotVerification> {
  const { owner, repo } = parseRepositoryName(input.repository);
  const remote = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    try { return await f(); } catch (error) {
      // anything the network or GitHub did is a retryable refusal; a definite answer about the content (not found) is permanent
      const permanent = error instanceof AcquisitionError && !error.retryable && ["repository_not_found", "commit_unavailable", "repository_private", "invalid_reference"].includes(error.code);
      throw new SnapshotVerificationError(!permanent, permanent ? "github_refused" : "github_unavailable", `GitHub ${what} failed during verification: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    }
  };
  const commit = await remote("commit resolution", () => source.resolveCommit(owner, repo, input.ref, signal));
  const pinned = input.ref && /^[0-9a-f]{40}$/.test(input.ref) ? input.ref : null;
  if (pinned && snapshot.commitSha !== pinned) throw new SnapshotVerificationError(false, "commit_not_pinned", `the snapshot is of commit ${snapshot.commitSha}, but the step pins ${pinned}`);
  if (commit.commitSha !== snapshot.commitSha) throw new SnapshotVerificationError(false, "commit_mismatch", `the snapshot is of commit ${snapshot.commitSha}; GitHub resolves ${input.ref ?? "the default branch"} to ${commit.commitSha}`);
  const tree = await remote("tree fetch", () => source.getTree(owner, repo, commit.treeSha, signal));
  if (tree.truncated) throw new SnapshotVerificationError(true, "tree_truncated", "GitHub truncated the tree listing; the snapshot cannot be verified");
  if (tree.sha !== commit.treeSha) throw new SnapshotVerificationError(false, "tree_mismatch", "the tree GitHub returned is not the resolved commit's tree");
  const plan = buildPlan(tree.entries, { limits: resolveLimits(), excludePathPrefixes: input.excludePathPrefixes ?? [] });
  if (plan.unrepresentable.length && (input.onUnrepresentable ?? "fail") === "fail") throw new SnapshotVerificationError(false, "unrepresentable_paths", `${plan.unrepresentable.length} tree paths cannot be manifest rows and the step does not allow a partial snapshot`);

  const rows = await manifestRows(db, snapshot.id);
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const planned = new Map<string, PlanItem>(plan.items.map((i) => [i.path, i]));
  const inTree = new Set(tree.entries.filter((e) => e.type !== "tree").map((e) => e.path));
  const problems: string[] = []; const files: FileResult[] = [];
  for (const r of rows) {
    if (planned.has(r.path)) continue;
    problems.push(inTree.has(r.path) ? `${JSON.stringify(r.path)} is excluded by the acquisition plan (unrepresentable) and may not be uploaded` : `${JSON.stringify(r.path)} is not in the GitHub tree at commit ${commit.commitSha}`);
  }
  for (const item of plan.items) if (!byPath.has(item.path)) problems.push(`${JSON.stringify(item.path)} is in the GitHub tree but missing from the manifest`);
  const stored = rows.filter((r) => planned.has(r.path) && r.blob_sha256);
  // the stored bytes are read back in small batches and only their git blob ids are kept (memory stays bounded by one batch)
  const contents = new Map<string, { gitSha: string; length: number }>();
  for (let i = 0; i < stored.length; i += 64) {
    const batch = [...new Set(stored.slice(i, i + 64).map((r) => r.blob_sha256!))];
    for (const b of (await db.query<{ content_sha256: string; content: Buffer }>("SELECT content_sha256, content FROM research_blobs WHERE content_sha256 = ANY($1::text[])", [batch])).rows) contents.set(b.content_sha256, { gitSha: gitBlobSha1(b.content), length: b.content.length });
  }
  let matched = 0, skipsVerified = 0, skipsUnverified = 0;
  for (const r of rows) {
    const item = planned.get(r.path); if (!item) continue;
    const bad = (why: string) => problems.push(`${JSON.stringify(r.path)}: ${why}`);
    if (r.classification !== item.classification) { bad(`classification ${r.classification}, the plan says ${item.classification}`); continue; }
    const expectedSize = item.kind === "submodule" ? 0 : item.size;
    if (r.size_bytes !== expectedSize) { bad(`size ${r.size_bytes}, the tree says ${expectedSize}`); continue; }
    if (item.kind !== "submodule" && r.git_blob_sha !== item.gitSha) { bad(`git blob id ${r.git_blob_sha ?? "missing"}, the tree says ${item.gitSha}`); continue; }
    if (item.kind === "submodule" && r.git_blob_sha !== null) { bad("a submodule row carries a git blob id"); continue; }
    if (r.blob_sha256) {
      if (item.plannedSkip !== null) { bad(`stored, but the plan skips it (${item.plannedSkip})`); continue; }
      const content = contents.get(r.blob_sha256);
      if (!content) { bad("its blob is not stored"); continue; }
      const observed = content.gitSha;
      if (observed !== item.gitSha || content.length !== item.size) { bad(`its stored bytes hash to git blob ${observed}, the tree says ${item.gitSha}`); continue; }
      matched += 1; files.push({ path: r.path, expected_git_sha: item.gitSha, observed_git_sha: observed, result: "content_matched" }); continue;
    }
    if (item.plannedSkip !== null) {
      if (r.skip_reason !== item.plannedSkip) { bad(`skipped as ${r.skip_reason}, the plan decides ${item.plannedSkip}`); continue; }
      skipsVerified += 1; files.push({ path: r.path, expected_git_sha: item.kind === "submodule" ? null : item.gitSha, observed_git_sha: null, result: "skip_verified" }); continue;
    }
    if (!r.skip_reason || !CONTENT_SKIPS.has(r.skip_reason)) { bad(`skipped as ${r.skip_reason}, which the plan does not decide`); continue; }
    if (r.path.endsWith(".sol")) { bad(`a Solidity source skipped as ${r.skip_reason}: the analysis reads it, so the API refuses a skip it cannot verify`); continue; }
    skipsUnverified += 1; files.push({ path: r.path, expected_git_sha: item.gitSha, observed_git_sha: null, result: "skip_unverified" });
  }
  if (problems.length) throw new SnapshotVerificationError(false, "snapshot_mismatch", `the snapshot does not match GitHub at commit ${commit.commitSha}: ${problems.length} problem(s)`, problems.slice(0, 20));
  const completeness = plan.unrepresentable.length ? "partial" : "complete";
  // per-file results as compact rows [path, expected git id, observed git id, result], in chunks that each fit one research blob
  const compact = files.map((f) => [f.path, f.expected_git_sha, f.observed_git_sha, f.result]);
  const chunks: Buffer[] = []; let cur: unknown[] = []; let size = 2;
  for (const row of compact) {
    const n = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (cur.length && size + n > CHUNK_BYTES) { chunks.push(Buffer.from(canonicalJson({ schema: "agentsmith-snapshot-verification-files/1", rows: cur }), "utf8")); cur = []; size = 2; }
    cur.push(row); size += n;
  }
  if (cur.length || !chunks.length) chunks.push(Buffer.from(canonicalJson({ schema: "agentsmith-snapshot-verification-files/1", rows: cur }), "utf8"));
  const doc = { schema: "agentsmith-snapshot-verification/1", verifier: "api-github", snapshot_id: snapshot.id, repository: input.repository, requested_ref: input.ref ?? null,
    resolved_commit: commit.commitSha, tree_sha: tree.sha, completeness, counts: { total: rows.length, matched, skips_verified: skipsVerified, skips_unverified: skipsUnverified },
    file_chunks: chunks.map((c) => createHash("sha256").update(c).digest("hex")), columns: ["path", "expected_git_sha", "observed_git_sha", "result"] };
  return { requestedRef: input.ref ?? null, resolvedCommit: commit.commitSha, treeSha: tree.sha, completeness, files, manifestFingerprint: manifestFingerprint(rows),
    resultBlob: Buffer.from(canonicalJson(doc), "utf8"), fileBlobs: chunks, counts: { total: rows.length, matched, skipsVerified, skipsUnverified } };
}
const CHUNK_BYTES = 900_000;
