import { createHash } from "node:crypto";
import { posix } from "node:path";
import { ResearchConflictError, manifestSha256, type ResearchStore, type SnapshotFileInput, type StepLease } from "../research-state.js";
import { AcquisitionError } from "./errors.js";
import { GitBlobHasher, gitBlobSha1 } from "./git-hash.js";
import type { RepositorySource } from "./github-source.js";
import { assertSafeRef, parseRepositoryName } from "./github-source.js";
import { resolveLimits, type AcquisitionLimits } from "./limits.js";
import { escapeForReport, isTraversalShaped, parseLfsPointer } from "./paths.js";
import { buildPlan, type Plan, type PlanItem, type SkipReason } from "./plan.js";
import { gunzipLimited, readTar, type CompressedStats } from "./tar-reader.js";

export const ACQUISITION_REPORT_VERSION = 1;
export const ACQUISITION_TOOL = { name: "agentsmith-repository-acquisition", version: "5.2.0" } as const;

export type AcquireRequest = {
  /** "owner/name" on github.com. */
  repository: string;
  /** Branch, tag or commit; absent means the default branch. Resolved once to a commit SHA; only the SHA is used afterwards. */
  ref?: string;
  /** Paths (and everything below them) recorded as `excluded_by_policy` instead of stored. */
  excludePathPrefixes?: readonly string[];
  /** What to do when a path cannot be a manifest row. Default "fail". "seal_partial" seals and states `completeness: partial`. */
  onUnrepresentable?: "fail" | "seal_partial";
  limits?: Partial<AcquisitionLimits>;
};

/** The part of ResearchStore the acquisition uses; tests substitute an in-memory recorder to prove failures write nothing. */
export type AcquisitionStore = Pick<ResearchStore, "findSnapshot" | "createSnapshot" | "putBlob" | "addSnapshotFiles" | "sealSnapshot" | "verifySnapshot">;

export type AcquireDeps = {
  store: AcquisitionStore;
  source: RepositorySource;
  now?: () => Date;
  signal?: AbortSignal;
  progress?: (event: string, fields?: Record<string, unknown>) => void;
};

export type AcquisitionResult = {
  snapshotId: string; repository: string; commitSha: string; treeSha: string; manifestSha256: string;
  fileCount: number; storedFiles: number; storedBytes: number; skipped: Record<string, number>;
  completeness: "complete" | "partial"; reused: "new" | "resumed" | "sealed";
};

type Collected = { sha256: string; content?: Buffer };

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const mismatch = (message: string, details: Record<string, unknown> = {}) => new AcquisitionError("archive_tree_mismatch", message, false, undefined, details);

/** Streams the archive once, verifying every entry against the tree and hashing it. Nothing is written to disk. */
async function readArchive(
  deps: AcquireDeps, owner: string, repo: string, commitSha: string, plan: Plan, limits: AcquisitionLimits, signal: AbortSignal,
): Promise<{ collected: Map<string, Collected>; stats: CompressedStats & { entries: number; directories: number; topDirectory: string }; symlinkTargets: Map<string, string> }> {
  const expected = new Map<string, { item: PlanItem | null; kind: "file" | "symlink"; gitSha: string; size: number }>();
  for (const item of plan.items) if (item.kind !== "submodule") expected.set(item.path, { item, kind: item.kind, gitSha: item.gitSha, size: item.size });
  for (const u of plan.unrepresentable) if (u.kind !== "submodule") expected.set(u.path, { item: null, kind: u.kind, gitSha: u.gitSha, size: u.size });

  const collected = new Map<string, Collected>();
  const symlinkTargets = new Map<string, string>();
  const seen = new Set<string>();
  let top: string | null = null;
  let globalComment: string | null = null;
  let directories = 0;

  const relativePath = (full: string): string => {
    if (isTraversalShaped(full)) throw new AcquisitionError("archive_malformed", `the archive contains an unsafe path (${escapeForReport(full, 120)})`);
    const slash = full.indexOf("/");
    const first = slash === -1 ? full : full.slice(0, slash);
    if (top === null) top = first;
    else if (first !== top) throw new AcquisitionError("archive_malformed", `an entry lies outside the archive's single top-level directory (${escapeForReport(full, 120)})`);
    return slash === -1 ? "" : full.slice(slash + 1);
  };

  const archive = await deps.source.openArchive(owner, repo, commitSha, signal);
  const stats: CompressedStats = { compressed: 0, uncompressed: 0, sha256: createHash("sha256") };
  const result = await readTar(gunzipLimited(archive.body, limits, stats, signal), { maxUncompressedBytes: limits.maxUncompressedBytes, maxEntries: limits.maxTarEntries }, {
    onGlobalComment: (comment) => {
      // Checked the moment it is read: an archive made from another commit is refused before any of its content is processed.
      if (comment !== commitSha) throw new AcquisitionError("commit_mismatch", "the archive was made from a different commit than the one resolved", false, undefined, { archive_says: escapeForReport(comment, 60) });
      globalComment = comment;
    },
    onEntry: (entry) => {
      const rel = relativePath(entry.path);
      if (entry.kind === "directory") { directories += 1; return null; }
      if (rel === "") throw new AcquisitionError("archive_malformed", "a file or link is named like the top-level directory");
      if (seen.has(rel)) throw new AcquisitionError("archive_malformed", `the archive lists ${escapeForReport(rel, 120)} twice`);
      seen.add(rel);
      const want = expected.get(rel);
      if (!want) throw mismatch(`the archive has an entry the tree does not list: ${escapeForReport(rel, 120)}`, { kind: "extra_entry", path: escapeForReport(rel, 200) });
      if (entry.kind === "symlink") {
        if (want.kind !== "symlink") throw mismatch(`the archive has a symbolic link where the tree has a ${want.kind}: ${escapeForReport(rel, 120)}`, { kind: "type_differs" });
        const target = Buffer.from(entry.linkTarget!, "utf8");
        if (target.length !== want.size || gitBlobSha1(target) !== want.gitSha) throw mismatch(`a symbolic link target differs from the git object: ${escapeForReport(rel, 120)}`, { kind: "content_differs" });
        symlinkTargets.set(rel, entry.linkTarget!);
        collected.set(rel, { sha256: sha256(target) });
        return null;
      }
      if (want.kind !== "file") throw mismatch(`the archive has a file where the tree has a ${want.kind}: ${escapeForReport(rel, 120)}`, { kind: "type_differs" });
      if (entry.size !== want.size) throw mismatch(`a file's size differs from the tree: ${escapeForReport(rel, 120)} (${entry.size} versus ${want.size})`, { kind: "size_differs" });
      const keep = want.item !== null && want.item.plannedSkip === null;
      const gitHasher = new GitBlobHasher(want.size);
      const hasher = createHash("sha256");
      const parts: Buffer[] = [];
      return {
        write(chunk) { gitHasher.update(chunk); hasher.update(chunk); if (keep) parts.push(Buffer.from(chunk)); },
        end() {
          if (gitHasher.finish() !== want.gitSha) throw mismatch(`a file's content does not match its git object id: ${escapeForReport(rel, 120)}`, { kind: "content_differs" });
          collected.set(rel, { sha256: hasher.digest("hex"), ...(keep ? { content: Buffer.concat(parts) } : {}) });
        },
      };
    },
  });

  if (globalComment === null) throw new AcquisitionError("commit_mismatch", "the archive does not state which commit it was made from");
  const missing = [...expected.keys()].filter((p) => !seen.has(p));
  if (missing.length) throw mismatch(`${missing.length} entries listed by the tree are missing from the archive`, { kind: "missing_entries", examples: missing.slice(0, 20).map((p) => escapeForReport(p, 200)), total: missing.length });
  return { collected, stats: { ...stats, entries: result.entries, directories, topDirectory: top ?? "" }, symlinkTargets };
}

const escapesRoot = (path: string, target: string): boolean => target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target) || posix.normalize(posix.join(posix.dirname(path), target)).startsWith("..");

function parseGitmodules(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let path: string | null = null; let url: string | null = null;
  const flush = () => { if (path && url) out.set(path, url); path = null; url = null; };
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[submodule\s+"[^"]*"\]\s*$/.exec(line);
    if (section) { flush(); continue; }
    const kv = /^\s*(path|url)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv) { if (kv[1] === "path") path = kv[2]!; else url = kv[2]!; }
  }
  flush();
  return out;
}

const BATCH = 500;
const BLOB_CONCURRENCY = 4;

export async function acquireRepository(deps: AcquireDeps, lease: StepLease, request: AcquireRequest): Promise<AcquisitionResult> {
  const limits = resolveLimits(request.limits);
  const { owner, repo } = parseRepositoryName(request.repository);
  if (request.ref !== undefined) assertSafeRef(request.ref);
  const onUnrepresentable = request.onUnrepresentable ?? "fail";
  const exclude = (request.excludePathPrefixes ?? []).map(String);
  if (exclude.length > 100 || exclude.some((p) => p.length > 1024 || p.includes("\u0000"))) throw new AcquisitionError("invalid_reference", "excludePathPrefixes is too long or malformed");
  const now = deps.now ?? (() => new Date());
  const progress = deps.progress ?? (() => undefined);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.maxWallClockMs);
  const onParentAbort = () => controller.abort();
  deps.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (deps.signal?.aborted) controller.abort();
  const signal = controller.signal;
  try {
    // 1. Resolve once. After this only the commit SHA is used, so a moving ref cannot change what is acquired.
    const identity = await deps.source.getRepository(owner, repo, signal);
    const commit = await deps.source.resolveCommit(owner, repo, request.ref, signal);
    const repository = identity.fullName;
    progress("resolved", { repository, commit: commit.commitSha });

    // 2. A sealed snapshot of this commit in this run is already the answer.
    const existing = await deps.store.findSnapshot(lease, repository, commit.commitSha);
    if (existing?.sealed) {
      const verification = await deps.store.verifySnapshot(existing.id);
      if (verification.ok !== true) throw new AcquisitionError("verification_failed", "the sealed snapshot no longer verifies", false, undefined, { verification });
      progress("already_sealed", { snapshot: existing.id });
      const report = existing.report as { counts?: { stored?: number; skipped_by_reason?: Record<string, number> }; completeness?: { status?: string } };
      return {
        snapshotId: existing.id, repository, commitSha: commit.commitSha, treeSha: commit.treeSha, manifestSha256: existing.manifestSha256!, fileCount: existing.fileCount ?? 0,
        storedFiles: report.counts?.stored ?? 0, storedBytes: existing.totalBytes ?? 0, skipped: report.counts?.skipped_by_reason ?? {},
        completeness: report.completeness?.status === "partial" ? "partial" : "complete", reused: "sealed",
      };
    }

    // 3. Identity and completeness reference: the git tree of the commit.
    const tree = await deps.source.getTree(owner, repo, commit.treeSha, signal);
    if (tree.truncated) throw new AcquisitionError("tree_truncated", "the hosting service truncated the tree listing, so completeness cannot be established");
    if (tree.sha !== commit.treeSha) throw new AcquisitionError("commit_mismatch", "the tree returned is not the tree of the resolved commit");
    const plan = buildPlan(tree.entries, { limits, excludePathPrefixes: exclude });
    if (plan.unrepresentable.length > 0 && onUnrepresentable === "fail") {
      throw new AcquisitionError("unrepresentable_paths", `${plan.unrepresentable.length} paths cannot be recorded in a manifest (tab, newline, carriage return, or too long)`, false, undefined, {
        total: plan.unrepresentable.length, examples: plan.unrepresentable.slice(0, 20).map((u) => ({ path: escapeForReport(u.path, 200), reason: u.reason })),
      });
    }
    progress("planned", { entries: plan.treeEntries, candidates: plan.items.length });

    // 4. Stream and verify the archive. No database write has happened yet.
    const { collected, stats, symlinkTargets } = await readArchive(deps, owner, repo, commit.commitSha, plan, limits, signal);
    progress("archive_verified", { entries: stats.entries, bytes: stats.uncompressed });

    // 5. Final decisions from content, then the manifest.
    const rows: SnapshotFileInput[] = [];
    const blobs = new Map<string, Buffer>();
    const skipped: Record<string, number> = {};
    const lfsPointers: Array<{ path: string; oid: string; size: number }> = [];
    let storedBytes = 0; let storedFiles = 0;
    let gitmodulesText: string | null = null;
    const skip = (reason: SkipReason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
    for (const item of plan.items) {
      if (item.kind === "submodule") { rows.push({ path: item.path, classification: item.classification, sizeBytes: 0, skipReason: "submodule" }); skip("submodule"); continue; }
      if (item.kind === "symlink") { rows.push({ path: item.path, classification: item.classification, sizeBytes: item.size, skipReason: "symlink", gitBlobSha: item.gitSha }); skip("symlink"); continue; }
      const data = collected.get(item.path)!;
      let reason: SkipReason | null = item.plannedSkip;
      if (reason === null) {
        const content = data.content!;
        if (content.includes(0)) reason = "binary";
        else { try { new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { reason = "unreadable_encoding"; } }
      }
      if (reason) { rows.push({ path: item.path, classification: item.classification, sizeBytes: item.size, skipReason: reason, gitBlobSha: item.gitSha }); skip(reason); continue; }
      const content = data.content!;
      if (sha256(content) !== data.sha256) throw new AcquisitionError("verification_failed", `content changed between hashing and storing: ${escapeForReport(item.path, 120)}`);
      blobs.set(data.sha256, content);
      rows.push({ path: item.path, classification: item.classification, sizeBytes: item.size, blobSha256: data.sha256, gitBlobSha: item.gitSha });
      storedBytes += item.size; storedFiles += 1;
      const lfs = parseLfsPointer(content);
      if (lfs) lfsPointers.push({ path: item.path, ...lfs });
      if (item.path === ".gitmodules") gitmodulesText = content.toString("utf8");
    }
    const manifestHash = manifestSha256(rows.map((r) => ({ path: r.path, blobSha256: "blobSha256" in r ? r.blobSha256 : null, skipReason: "skipReason" in r ? r.skipReason : null })));
    const moduleUrls = gitmodulesText ? parseGitmodules(gitmodulesText) : new Map<string, string>();

    const symlinks = plan.items.filter((i) => i.kind === "symlink");
    const submodules = plan.items.filter((i) => i.kind === "submodule");
    const report: Record<string, unknown> = {
      report_version: ACQUISITION_REPORT_VERSION, tool: ACQUISITION_TOOL,
      source: {
        host: "github.com", repository_id: identity.repositoryId, full_name: repository, default_branch: identity.defaultBranch, requested_ref: request.ref ?? null,
        commit_sha: commit.commitSha, tree_sha: commit.treeSha, archive_comment_matches_commit: true,
      },
      acquired_at: now().toISOString(),
      archive: { sha256: stats.sha256.digest("hex"), compressed_bytes: stats.compressed, uncompressed_bytes: stats.uncompressed, entries: stats.entries, directories: stats.directories, top_level_directory: escapeForReport(stats.topDirectory, 200) },
      limits, options: { exclude_path_prefixes: exclude, on_unrepresentable: onUnrepresentable },
      completeness: {
        status: plan.unrepresentable.length ? "partial" : "complete",
        unrepresentable_total: plan.unrepresentable.length,
        unrepresentable: plan.unrepresentable.slice(0, 200).map((u) => ({ path: escapeForReport(u.path, 200), reason: u.reason, kind: u.kind, git_sha: u.gitSha, size: u.size })),
      },
      counts: { tree_entries: plan.treeEntries, manifest_rows: rows.length, stored: storedFiles, stored_bytes: storedBytes, skipped_by_reason: skipped, lfs_pointers: lfsPointers.length, symlinks: symlinks.length, submodules: submodules.length, case_collisions: plan.caseCollisions },
      symlinks: symlinks.slice(0, 500).map((i) => { const target = symlinkTargets.get(i.path)!; return { path: escapeForReport(i.path, 200), target: escapeForReport(target, 300), target_bytes: Buffer.byteLength(target), escapes_root: escapesRoot(i.path, target) }; }),
      submodules: submodules.slice(0, 500).map((i) => ({ path: escapeForReport(i.path, 200), commit_sha: i.gitSha, url: moduleUrls.has(i.path) ? escapeForReport(moduleUrls.get(i.path)!, 300) : null, url_source: moduleUrls.has(i.path) ? ".gitmodules" : null })),
      lfs_pointers: lfsPointers.slice(0, 500).map((p) => ({ path: escapeForReport(p.path, 200), oid: p.oid, size: p.size })),
      verification: { method: "every file's git object id, size and presence checked against the commit's git tree; archive commit id checked", manifest_sha256: manifestHash },
    };

    // 6. Database writes. A retry of a building snapshot reuses its stored report, and the fresh content must reproduce its manifest.
    let reused: AcquisitionResult["reused"] = "new";
    if (existing) {
      const recorded = (existing.report as { verification?: { manifest_sha256?: string } }).verification?.manifest_sha256;
      if (recorded !== manifestHash) throw new AcquisitionError("snapshot_conflict", "a building snapshot of this commit exists and the freshly acquired content produces a different manifest", false, undefined, { recorded, fresh: manifestHash });
      Object.assign(report, existing.report);
      reused = "resumed";
    }
    let snapshotId: string;
    try {
      snapshotId = await deps.store.createSnapshot(lease, { repository, commitSha: commit.commitSha, ...(request.ref !== undefined ? { refName: request.ref } : {}), acquisitionReport: report });
      const queue = [...blobs.values()];
      progress("blobs_stored", { done: 0, total: queue.length });
      for (let i = 0; i < queue.length; i += BLOB_CONCURRENCY) {
        await Promise.all(queue.slice(i, i + BLOB_CONCURRENCY).map((content) => deps.store.putBlob(lease, content)));
        progress("blobs_stored", { done: Math.min(queue.length, i + BLOB_CONCURRENCY), total: queue.length });
      }
      progress("manifest_rows_added", { done: 0, total: rows.length });
      for (let i = 0; i < rows.length; i += BATCH) {
        await deps.store.addSnapshotFiles(lease, snapshotId, rows.slice(i, i + BATCH));
        progress("manifest_rows_added", { done: Math.min(rows.length, i + BATCH), total: rows.length });
      }
    } catch (error) {
      if (error instanceof ResearchConflictError) throw new AcquisitionError("snapshot_conflict", error.message, false, undefined, { entity: error.entity, differing: error.differing });
      throw error;
    }
    const seal = await deps.store.sealSnapshot(lease, snapshotId);
    if (seal.manifestSha256 !== manifestHash || seal.fileCount !== rows.length || seal.totalBytes !== storedBytes) {
      throw new AcquisitionError("verification_failed", "the sealed manifest differs from the one computed from the verified archive", false, undefined, { sealed: seal, expected: { manifestHash, files: rows.length, bytes: storedBytes } });
    }
    const verification = await deps.store.verifySnapshot(snapshotId);
    if (verification.ok !== true) throw new AcquisitionError("verification_failed", "the sealed snapshot does not verify", false, undefined, { verification });
    progress("sealed", { snapshot: snapshotId, files: rows.length });
    return {
      snapshotId, repository, commitSha: commit.commitSha, treeSha: commit.treeSha, manifestSha256: manifestHash, fileCount: rows.length, storedFiles, storedBytes, skipped,
      completeness: plan.unrepresentable.length ? "partial" : "complete", reused,
    };
  } catch (error) {
    if (signal.aborted && !(error instanceof AcquisitionError)) {
      throw new AcquisitionError("timeout", deps.signal?.aborted ? "the acquisition was cancelled" : `the acquisition exceeded ${limits.maxWallClockMs} ms`, true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onParentAbort);
  }
}
