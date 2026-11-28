import { createHash } from "node:crypto";
import { posix } from "node:path";
import { canonicalJson } from "../research-state.js";
import { AcquisitionError } from "./errors.js";
import type { RepositorySource, TreeEntry } from "./github-source.js";
import { parseRepositoryName } from "./github-source.js";
import { escapeForReport } from "./paths.js";

/**
 * C3: the dependency set of a sealed parent snapshot, resolved WITHOUT ever changing that snapshot.
 *
 * - Git submodules: the path and URL come from `.gitmodules` (a stored, hash-verified file of the parent snapshot); the commit comes ONLY
 *   from the gitlink entry (mode 160000) of the pinned parent commit's tree. A submodule that `.gitmodules` declares but the tree does not
 *   pin is `unpinned` and is never fetched: no branch head is ever resolved. Each pinned submodule on an allowed host is acquired at
 *   exactly that commit through the SAME acquisition path as any repository (acquire.ts: the source's SSRF policy, tree verification,
 *   per-file git object ids, sealing), as a separate sealed snapshot of the same run, linked to its parent in its acquisition report.
 * - Remappings: `remappings.txt` and the `remappings` array of `foundry.toml`, each resolved to the parent snapshot, a dependency or a
 *   package; nothing is inferred.
 * - node_modules packages: recorded only as what the lockfile pins (version, resolved URL, integrity). They are never fetched: there is no
 *   package source on the allow-list and no storage for a non-git snapshot (db/drafts/c3-dependency-records). Unpinned packages are
 *   `unavailable`.
 *
 * Everything that could not be acquired is a recorded LIMITATION with a code and a reason; nothing is skipped silently. The dependency set
 * is a pure function of the parent commit (its tree and its stored configuration files) and of what the pinned commits contain, so the
 * same parent commit yields the same set and the same digest.
 */
export const DEPENDENCY_MANIFEST_SCHEMA = "agentsmith-dependency-manifest/1";
export const DEPENDENCY_RESOLVER = "agentsmith-dependency-resolver/1";
export const DEPENDENCY_STEP_KEY = "acquire_dependencies";
export const DEPENDENCY_ROLE = "dependency_acquirer";
/** The stage is created only for runs made with `dependencies`, and a worker claims it only with this switch (exactly "true"). */
export const DEPENDENCY_SWITCH = "DEPENDENCY_ACQUISITION_ENABLED";
export const CONFIG_FILES = [".gitmodules", "remappings.txt", "foundry.toml", "package.json", "package-lock.json"] as const;
export type ConfigFiles = Partial<Record<(typeof CONFIG_FILES)[number], string | null>>;

export type DependencyLimits = { maxDepth: number; maxDependencies: number; maxTotalStoredBytes: number; maxPackages: number };
export const DEFAULT_DEPENDENCY_LIMITS: Readonly<DependencyLimits> = Object.freeze({ maxDepth: 2, maxDependencies: 24, maxTotalStoredBytes: 96 * 1024 * 1024, maxPackages: 200 });

export type LimitationCode =
  | "unpinned" | "missing_url" | "disallowed_host" | "unavailable" | "too_large" | "nested_depth_exceeded" | "dependency_limit_reached"
  | "unrepresentable_path" | "package_not_acquired" | "package_unpinned" | "remapping_target_missing" | "config_unreadable";
export type DependencyStatus = "acquired" | Exclude<LimitationCode, "package_not_acquired" | "package_unpinned" | "remapping_target_missing" | "config_unreadable">;
export type Limitation = { code: LimitationCode; subject: string; reason: string; established_by: "resolver" | "acquisition" };

export type DependencyRecord = {
  kind: "git_submodule";
  /** path from the root of the ANALYSED snapshot (a nested submodule's path is below its parent's) */
  path: string; depth: number;
  parent: { repository: string; commit_sha: string; tree_sha: string; path_in_parent: string };
  declared_url: string | null; source_url: string | null; repository: string | null;
  pinned_commit: string | null;
  /** how the pin was established: always the gitlink of the parent commit's tree, or null when there is no pin */
  pin_established_by: "gitlink_in_parent_tree" | null;
  status: DependencyStatus; reason: string | null;
  tree_sha: string | null; manifest_sha256: string | null; file_count: number | null; stored_bytes: number | null; completeness: "complete" | "partial" | null;
  /** the sealed dependency snapshot in THIS run (run-specific: not part of the digest) */
  snapshot_id: string | null;
};
export type RemappingRecord = {
  context: string | null; prefix: string; target: string; declared_in: "remappings.txt" | "foundry.toml"; line: number;
  resolves_to: { kind: "parent_snapshot" } | { kind: "dependency"; path: string; status: DependencyStatus } | { kind: "package"; name: string } | { kind: "unresolved" };
  available: boolean;
};
export type PackageRecord = {
  name: string; declared_range: string | null; version: string | null; resolved: string | null; integrity: string | null;
  pin_established_by: "package-lock.json integrity" | null; status: "pinned_not_acquired" | "unavailable"; reason: string;
};
export type DependencyManifest = {
  schema: typeof DEPENDENCY_MANIFEST_SCHEMA; resolver: typeof DEPENDENCY_RESOLVER;
  parent: { repository: string; commit_sha: string; tree_sha: string; manifest_sha256: string };
  limits: DependencyLimits;
  dependencies: DependencyRecord[]; remappings: RemappingRecord[]; packages: PackageRecord[]; limitations: Limitation[];
  /** covers the parent identity, every dependency (source, pin, tree and file-manifest hashes, status), remappings, packages and limitation codes */
  digest: string;
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const byPath = <T extends { path: string }>(a: T, b: T) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
const esc = (s: string, n = 200) => escapeForReport(s, n);

// ------------------------------------------------------------------------------------------------------------ parsing (pure)
export type DeclaredSubmodule = { name: string; path: string | null; url: string | null };
export function parseGitmodulesFull(text: string): DeclaredSubmodule[] {
  const out: DeclaredSubmodule[] = []; let cur: DeclaredSubmodule | null = null;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[submodule\s+"([^"]*)"\]\s*$/.exec(line);
    if (section) { cur = { name: section[1]!, path: null, url: null }; out.push(cur); continue; }
    if (/^\s*\[/.test(line)) { cur = null; continue; }
    const kv = /^\s*(path|url)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv && cur) { if (kv[1] === "path") cur.path = kv[2]!.replace(/\/+$/, ""); else cur.url = kv[2]!; }
  }
  return out.slice(0, 500);
}

/**
 * The repository a submodule URL names, if it is on the ONE allowed host (github.com; the acquisition source talks to no other). An ssh or
 * git URL of github.com names the same repository and is fetched over the source's own HTTPS path. A relative URL is resolved against the
 * parent repository, as git does. Anything else is refused with the host named; it is never fetched.
 */
export function submoduleRepository(url: string, parentRepository: string): { ok: true; repository: string; sourceUrl: string } | { ok: false; reason: string } {
  const u = url.trim();
  let path: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(u))) { if (m[1]!.toLowerCase() !== "github.com") return { ok: false, reason: `host ${esc(m[1]!, 100)} is not on the acquisition allow-list (github.com only)` }; path = m[2]!; }
  else if ((m = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(u)) && !/^[A-Za-z]:[\\/]/.test(u)) { if (m[1]!.toLowerCase() !== "github.com") return { ok: false, reason: `host ${esc(m[1]!, 100)} is not on the acquisition allow-list (github.com only)` }; path = m[2]!; }
  else if (/^\.\.?\//.test(u)) { const joined = posix.normalize(posix.join("/", parentRepository, u)); if (joined.startsWith("/..")) return { ok: false, reason: "the relative URL leaves the hosting service's root" }; path = joined.replace(/^\/+/, ""); }
  else return { ok: false, reason: `the URL ${esc(u, 120)} is not a github.com repository URL` };
  const clean = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  try { const { owner, repo } = parseRepositoryName(clean); return { ok: true, repository: `${owner}/${repo}`, sourceUrl: `https://github.com/${owner}/${repo}` }; }
  catch { return { ok: false, reason: `the URL ${esc(u, 120)} does not name owner/repository on github.com` }; }
}

type RawRemap = { context: string | null; prefix: string; target: string; declared_in: RemappingRecord["declared_in"]; line: number };
const remapOf = (text: string, declared_in: RawRemap["declared_in"], line: number): RawRemap | null => {
  const m = /^(?:([^:=\s]+):)?([^=\s]+)=(\S+)$/.exec(text.trim());
  return m ? { context: m[1] ?? null, prefix: m[2]!, target: m[3]!.replace(/^\.\//, ""), declared_in, line } : null;
};
export function parseRemappingsTxt(text: string): { remappings: RawRemap[]; unreadable: number[] } {
  const remappings: RawRemap[] = []; const unreadable: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => { const t = raw.trim(); if (!t || t.startsWith("#")) return; const r = remapOf(t, "remappings.txt", i + 1); if (r) remappings.push(r); else unreadable.push(i + 1); });
  return { remappings, unreadable };
}
/** The `remappings = [ "a=b", ... ]` arrays of a foundry.toml (any profile). A minimal reader: strings of the array only, nothing evaluated. */
export function parseFoundryRemappings(text: string): { remappings: RawRemap[]; unreadable: number[] } {
  const remappings: RawRemap[] = []; const unreadable: number[] = [];
  const lines = text.split(/\r?\n/); let inside = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/(^|\s)#.*$/, "");
    if (!inside) { const m = /^\s*remappings\s*=\s*\[(.*)$/.exec(line); if (!m) continue; inside = true; line = m[1]!; }
    const end = line.indexOf("]"); const body = end === -1 ? line : line.slice(0, end);
    for (const s of body.matchAll(/"([^"]*)"|'([^']*)'/g)) { const r = remapOf(s[1] ?? s[2] ?? "", "foundry.toml", i + 1); if (r) remappings.push(r); else unreadable.push(i + 1); }
    if (end !== -1) inside = false;
  }
  return { remappings, unreadable };
}

export function parsePackages(packageJson: string | null | undefined, lock: string | null | undefined, max: number): { packages: PackageRecord[]; problems: string[] } {
  const problems: string[] = []; if (!packageJson) return { packages: [], problems };
  let pj: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try { pj = JSON.parse(packageJson) as typeof pj; } catch { return { packages: [], problems: ["package.json is not valid JSON"] }; }
  let locked: Record<string, { version?: unknown; resolved?: unknown; integrity?: unknown }> = {};
  if (lock) { try { locked = ((JSON.parse(lock) as { packages?: typeof locked }).packages) ?? {}; } catch { problems.push("package-lock.json is not valid JSON"); } }
  const declared = { ...(pj.devDependencies ?? {}), ...(pj.dependencies ?? {}) };
  const names = Object.keys(declared).filter((n) => /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(n)).sort();
  if (names.length > max) problems.push(`package.json declares ${names.length} packages; only the first ${max} are recorded`);
  const str = (v: unknown) => (typeof v === "string" && v.length <= 500 ? v : null);
  return { problems, packages: names.slice(0, max).map((name) => {
    const l = locked[`node_modules/${name}`]; const integrity = str(l?.integrity); const version = str(l?.version);
    const pinned = !!l && !!version && !!integrity && /^sha(512|384|256)-[A-Za-z0-9+/=]+$/.test(integrity);
    return { name, declared_range: str(declared[name]), version: pinned ? version : null, resolved: pinned ? str(l!.resolved) : null, integrity: pinned ? integrity : null,
      pin_established_by: pinned ? "package-lock.json integrity" as const : null, status: pinned ? "pinned_not_acquired" as const : "unavailable" as const,
      reason: pinned ? "pinned by the lockfile with an integrity hash, but not acquired: no package source is on the acquisition allow-list and no storage exists for a non-git snapshot (db/drafts/c3-dependency-records)"
        : lock ? "the lockfile does not pin this package with an integrity hash; it is never fetched" : "no package-lock.json in the snapshot: the package is unpinned and is never fetched" };
  }) };
}

// ------------------------------------------------------------------------------------------------------------ resolution
export type AcquiredDependency = { ok: true; snapshotId: string; treeSha: string; manifestSha256: string; fileCount: number; storedBytes: number; completeness: "complete" | "partial" };
export type DependencyFailure = { ok: false; code: "unavailable" | "too_large"; reason: string };
export type DependencyRequest = { repository: string; commitSha: string; path: string; depth: number; parent: DependencyRecord["parent"]; sourceUrl: string };
export type DependencyIo = {
  /** the tree of a pinned commit (the caller's own source: the worker's, or the API's when it re-derives the set) */
  tree(repository: string, commitSha: string): Promise<{ treeSha: string; entries: TreeEntry[] }>;
  /** the stored configuration files of a sealed snapshot of this run (the parent, or an acquired dependency) */
  configFiles(snapshotId: string): Promise<ConfigFiles>;
  /** acquire (or look up) the dependency at exactly `commitSha`; a definite refusal is a failure, a transient fault throws */
  acquire(dep: DependencyRequest): Promise<AcquiredDependency | DependencyFailure>;
};

/** Definite answers about a dependency become a recorded limitation; anything retryable propagates so the step is retried, not mis-recorded. */
export function failureOfAcquisition(error: unknown): DependencyFailure | null {
  if (!(error instanceof AcquisitionError) || error.retryable) return null;
  if (["repository_not_found", "repository_private", "commit_unavailable", "access_denied"].includes(error.code)) return { ok: false, code: "unavailable", reason: error.message.slice(0, 300) };
  if (["repository_too_large", "limit_exceeded", "tree_truncated"].includes(error.code)) return { ok: false, code: "too_large", reason: error.message.slice(0, 300) };
  return null;
}

export async function sourceTree(source: RepositorySource, repository: string, commitSha: string, signal?: AbortSignal): Promise<{ treeSha: string; entries: TreeEntry[] }> {
  const { owner, repo } = parseRepositoryName(repository);
  const commit = await source.resolveCommit(owner, repo, commitSha, signal);
  if (commit.commitSha !== commitSha) throw new AcquisitionError("commit_mismatch", `the source resolved ${commitSha} to another commit`);
  const tree = await source.getTree(owner, repo, commit.treeSha, signal);
  if (tree.truncated) throw new AcquisitionError("tree_truncated", "the hosting service truncated the tree listing, so the gitlinks cannot be established");
  if (tree.sha !== commit.treeSha) throw new AcquisitionError("commit_mismatch", "the tree returned is not the tree of the pinned commit");
  return { treeSha: commit.treeSha, entries: tree.entries };
}

export function dependencyDigest(m: Omit<DependencyManifest, "digest">): string {
  return sha256(canonicalJson({
    schema: m.schema, resolver: m.resolver, parent: m.parent, limits: m.limits,
    dependencies: m.dependencies.map((d) => [d.path, d.depth, d.parent.repository, d.parent.commit_sha, d.parent.path_in_parent, d.source_url, d.pinned_commit, d.pin_established_by, d.status, d.tree_sha, d.manifest_sha256, d.file_count, d.completeness]),
    remappings: m.remappings.map((r) => [r.context, r.prefix, r.target, r.declared_in, r.resolves_to, r.available]),
    packages: m.packages.map((p) => [p.name, p.declared_range, p.version, p.resolved, p.integrity, p.status]),
    limitations: m.limitations.map((l) => [l.code, l.subject]),
  }));
}

/**
 * Resolves the whole dependency set of a sealed parent snapshot. `io.acquire` is called once per pinned, allowed submodule, in path order,
 * breadth first; nested submodules are followed to `limits.maxDepth` and recorded as `nested_depth_exceeded` beyond it.
 */
export async function resolveDependencySet(io: DependencyIo, parent: { snapshotId: string; repository: string; commitSha: string; manifestSha256: string }, limitOverrides: Partial<DependencyLimits> = {}): Promise<DependencyManifest> {
  const limits: DependencyLimits = { ...DEFAULT_DEPENDENCY_LIMITS, ...limitOverrides };
  const dependencies: DependencyRecord[] = []; const limitations: Limitation[] = [];
  const limit = (code: LimitationCode, subject: string, reason: string, established_by: Limitation["established_by"] = "resolver") => { limitations.push({ code, subject: esc(subject), reason: reason.slice(0, 400), established_by }); };
  const root = await io.tree(parent.repository, parent.commitSha);
  const rootPaths = root.entries.filter((e) => e.type !== "tree").map((e) => e.path);
  const rootConfig = await io.configFiles(parent.snapshotId);

  type Level = { repository: string; commitSha: string; treeSha: string; entries: TreeEntry[]; gitmodules: string | null; prefix: string; depth: number };
  let queue: Level[] = [{ repository: parent.repository, commitSha: parent.commitSha, treeSha: root.treeSha, entries: root.entries, gitmodules: rootConfig[".gitmodules"] ?? null, prefix: "", depth: 0 }];
  let acquired = 0; let storedBytes = 0;
  while (queue.length) {
    const next: Level[] = [];
    for (const level of queue) {
      const declared = new Map<string, DeclaredSubmodule>();
      for (const d of level.gitmodules ? parseGitmodulesFull(level.gitmodules) : []) if (d.path) declared.set(d.path, d);
      const gitlinks = new Map(level.entries.filter((e) => e.type === "commit" && e.mode === "160000").map((e) => [e.path, e.sha]));
      const paths = [...new Set([...declared.keys(), ...gitlinks.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const local of paths) {
        const path = level.prefix ? `${level.prefix}/${local}` : local; const depth = level.depth + 1;
        const decl = declared.get(local); const pin = gitlinks.get(local) ?? null;
        const rec: DependencyRecord = {
          kind: "git_submodule", path: esc(path, 1024), depth, parent: { repository: level.repository, commit_sha: level.commitSha, tree_sha: level.treeSha, path_in_parent: esc(local, 1024) },
          declared_url: decl?.url ? esc(decl.url, 300) : null, source_url: null, repository: null, pinned_commit: pin, pin_established_by: pin ? "gitlink_in_parent_tree" : null,
          status: "acquired", reason: null, tree_sha: null, manifest_sha256: null, file_count: null, stored_bytes: null, completeness: null, snapshot_id: null,
        };
        dependencies.push(rec);
        const refuse = (status: Exclude<DependencyStatus, "acquired">, reason: string, by: Limitation["established_by"] = "resolver") => { rec.status = status; rec.reason = reason.slice(0, 400); limit(status, path, reason, by); };
        if (path !== esc(path, 1024) || /[\t\n\r]/.test(path)) { refuse("unrepresentable_path", "the submodule path cannot be recorded (control characters or too long)"); continue; }
        if (!pin) { refuse("unpinned", `.gitmodules declares this submodule, but the tree of ${level.repository}@${level.commitSha} has no gitlink at ${esc(local)}: there is no pinned commit, and a branch head is never fetched`); continue; }
        if (!decl?.url) { refuse("missing_url", `the tree pins ${pin} at this path, but .gitmodules of ${level.repository}@${level.commitSha} gives no URL for it, so its source is unknown`); continue; }
        const repo = submoduleRepository(decl.url, level.repository);
        if (!repo.ok) { refuse("disallowed_host", repo.reason); continue; }
        rec.source_url = repo.sourceUrl; rec.repository = repo.repository;
        if (depth > limits.maxDepth) { refuse("nested_depth_exceeded", `nested submodule at depth ${depth}; the limit is ${limits.maxDepth} (pinned at ${pin}, not fetched)`); continue; }
        if (acquired >= limits.maxDependencies) { refuse("dependency_limit_reached", `more than ${limits.maxDependencies} dependencies; this one (pinned at ${pin}) was not fetched`); continue; }
        if (storedBytes >= limits.maxTotalStoredBytes) { refuse("too_large", `the dependency set already holds ${storedBytes} bytes; the limit is ${limits.maxTotalStoredBytes}`); continue; }
        const got = await io.acquire({ repository: repo.repository, commitSha: pin, path, depth, parent: rec.parent, sourceUrl: repo.sourceUrl });
        if (!got.ok) { refuse(got.code, got.reason, "acquisition"); continue; }
        acquired += 1; storedBytes += got.storedBytes;
        Object.assign(rec, { tree_sha: got.treeSha, manifest_sha256: got.manifestSha256, file_count: got.fileCount, stored_bytes: got.storedBytes, completeness: got.completeness, snapshot_id: got.snapshotId });
        // nested submodules: the dependency's OWN pinned tree and its own stored .gitmodules
        const tree = await io.tree(repo.repository, pin);
        if (tree.treeSha !== got.treeSha) throw new AcquisitionError("commit_mismatch", `the tree of ${repo.repository}@${pin} differs from the acquired snapshot's`);
        if (tree.entries.some((e) => e.type === "commit")) next.push({ repository: repo.repository, commitSha: pin, treeSha: tree.treeSha, entries: tree.entries, gitmodules: (await io.configFiles(got.snapshotId))[".gitmodules"] ?? null, prefix: path, depth });
      }
    }
    queue = next;
  }
  dependencies.sort(byPath);

  // remappings, exactly as declared
  const raw: RawRemap[] = [];
  for (const [file, parse] of [["remappings.txt", parseRemappingsTxt], ["foundry.toml", parseFoundryRemappings]] as const) {
    const text = rootConfig[file]; if (!text) continue;
    const r = parse(text); raw.push(...r.remappings);
    if (r.unreadable.length) limit("config_unreadable", file, `${r.unreadable.length} remapping entr${r.unreadable.length === 1 ? "y" : "ies"} could not be read (line ${r.unreadable.slice(0, 10).join(", ")})`);
  }
  const pk = parsePackages(rootConfig["package.json"], rootConfig["package-lock.json"], limits.maxPackages);
  for (const p of pk.problems) limit("config_unreadable", "package.json", p);
  const packages = pk.packages; const pkgByName = new Map(packages.map((p) => [p.name, p]));
  const seen = new Set<string>(); const remappings: RemappingRecord[] = [];
  for (const r of raw.slice(0, 500)) {
    const key = `${r.context ?? ""}\u0000${r.prefix}`; if (seen.has(key)) continue; seen.add(key); // the first declaration wins (remappings.txt before foundry.toml)
    const target = r.target.replace(/\/+$/, "");
    const dep = dependencies.filter((d) => target === d.path || target.startsWith(`${d.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    const pkg = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(target)?.[1];
    let resolves_to: RemappingRecord["resolves_to"]; let available = false;
    if (dep) { resolves_to = { kind: "dependency", path: dep.path, status: dep.status }; available = dep.status === "acquired"; if (!available) limit("remapping_target_missing", `${r.prefix}=${r.target}`, `the remapping targets ${dep.path}, which is ${dep.status}`); }
    else if (pkg) {
      resolves_to = { kind: "package", name: pkg }; const p = pkgByName.get(pkg);
      limit(p?.status === "pinned_not_acquired" ? "package_not_acquired" : "package_unpinned", pkg, p ? p.reason : "the remapping targets a node_modules package that package.json does not declare; it is unpinned and never fetched");
    } else if (rootPaths.some((p) => p === target || p.startsWith(`${target}/`))) { resolves_to = { kind: "parent_snapshot" }; available = true; }
    else { resolves_to = { kind: "unresolved" }; limit("remapping_target_missing", `${r.prefix}=${r.target}`, "the remapping target is neither in the analysed snapshot nor under a dependency path"); }
    remappings.push({ context: r.context, prefix: esc(r.prefix, 300), target: esc(r.target, 500), declared_in: r.declared_in, line: r.line, resolves_to, available });
  }
  const body: Omit<DependencyManifest, "digest"> = { schema: DEPENDENCY_MANIFEST_SCHEMA, resolver: DEPENDENCY_RESOLVER,
    parent: { repository: parent.repository, commit_sha: parent.commitSha, tree_sha: root.treeSha, manifest_sha256: parent.manifestSha256 }, limits, dependencies, remappings, packages, limitations };
  return { ...body, digest: dependencyDigest(body) };
}

/** The remappings a compiler may be given: only those whose target is really there (the parent snapshot or an ACQUIRED dependency). */
export function usableRemappings(m: DependencyManifest): string[] {
  return m.remappings.filter((r) => r.available).map((r) => `${r.context ? `${r.context}:` : ""}${r.prefix}=${r.target}`);
}
