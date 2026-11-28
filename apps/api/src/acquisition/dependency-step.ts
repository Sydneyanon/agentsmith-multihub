import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canonicalJson, sha256Hex, type ResearchStore } from "../research-state.js";
import type { ResearchReads, SealedSnapshotRef, StepLifecyclePort } from "../research-port.js";
import { LeaseLostError } from "../step-errors.js";
import type { ClaimedStep } from "../worker.js";
import { acquireRepository, type AcquisitionStore } from "./acquire.js";
import { CONFIG_FILES, DEFAULT_DEPENDENCY_LIMITS, DEPENDENCY_MANIFEST_SCHEMA, DEPENDENCY_ROLE, DEPENDENCY_STEP_KEY, dependencyDigest, failureOfAcquisition, resolveDependencySet, sourceTree,
  type AcquiredDependency, type ConfigFiles, type DependencyFailure, type DependencyLimits, type DependencyManifest, type DependencyRequest } from "./dependencies.js";
import type { RepositorySource } from "./github-source.js";

/**
 * The OPTIONAL `acquire_dependencies` stage of a `repository_research` run, directly after `acquire_repository`. It exists only in runs
 * created with `dependencies`, and a worker claims it only with DEPENDENCY_ACQUISITION_ENABLED=true. It never touches the analysed
 * snapshot: each dependency becomes its OWN sealed snapshot of the same run (the existing unique key is run + repository + commit), linked
 * to its parent by `dependency_of` in its acquisition report, and the whole set is recorded as one dependency manifest (a content-addressed
 * blob and this step's output). Hypotheses are only ever generated on the analysed snapshot, so dependencies stay outside the bounty
 * scope classification unless a scope names them.
 */
export const DEPENDENCY_SCOPE = "repository_research";
export const dependencyStepInput = (limits: Partial<DependencyLimits> = {}) => ({ scope: DEPENDENCY_SCOPE, resolver: "git_submodules+remappings", limits: { ...DEFAULT_DEPENDENCY_LIMITS, ...limits } });
const limitsSchema = z.object({ maxDepth: z.number().int().min(0).max(4), maxDependencies: z.number().int().min(0).max(64), maxTotalStoredBytes: z.number().int().min(0).max(256 * 1024 * 1024), maxPackages: z.number().int().min(0).max(1000) }).strict();
export const dependencyStepInputSchema = z.object({ scope: z.literal(DEPENDENCY_SCOPE), resolver: z.string().max(100), limits: limitsSchema }).strict();
type Env = Record<string, string | undefined>;
export const dependencyStepClaimable = (env: Env): boolean => env["DEPENDENCY_ACQUISITION_ENABLED"] === "true";

export async function insertDependencyStep(client: Pick<PoolClient, "query">, run: { id: string; correlationId: string }, sequence: number, createdBy: string): Promise<void> {
  await client.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, $3, $4, $5::jsonb)`, [run.id, DEPENDENCY_STEP_KEY, sequence, DEPENDENCY_ROLE, JSON.stringify(dependencyStepInput())]);
  await client.query(
    `INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason, payload)
     VALUES ($1, 'repository_research.dependencies_requested', 'workflow_run', $2, $3, 'Dependency acquisition requested: submodules at the commits the parent tree pins, as separate sealed snapshots (passive reading of public repositories)', $4::jsonb)`,
    [createdBy, run.id, run.correlationId, JSON.stringify({ limits: DEFAULT_DEPENDENCY_LIMITS, passive_only: true })]);
}

/** The stored configuration files of a SEALED snapshot (only the five names the resolver reads; never anything else). */
export async function snapshotConfigFiles(db: Pick<Pool, "query">, snapshotId: string): Promise<ConfigFiles> {
  const rows = (await db.query<{ path: string; text: string }>(
    `SELECT f.path, convert_from(b.content, 'UTF8') AS text FROM repo_snapshot_files f JOIN repo_snapshots s ON s.id = f.snapshot_id JOIN research_blobs b ON b.content_sha256 = f.blob_sha256
      WHERE f.snapshot_id = $1 AND s.sealed_at IS NOT NULL AND f.path = ANY($2::text[])`, [snapshotId, [...CONFIG_FILES]])).rows;
  const out: ConfigFiles = {}; for (const n of CONFIG_FILES) out[n] = rows.find((r) => r.path === n)?.text ?? null;
  return out;
}

const passive = { execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false } as const;
export function dependencyStepOutput(snap: SealedSnapshotRef, m: DependencyManifest, blobSha256: string | null): Record<string, unknown> {
  const acquired = m.dependencies.filter((d) => d.status === "acquired");
  return {
    status: "dependencies_resolved", snapshot_id: snap.snapshotId, repository: snap.repository, commit_sha: snap.commitSha, manifest_sha256: snap.manifestSha256,
    dependency_manifest_digest: m.digest, dependency_manifest_blob_sha256: blobSha256,
    counts: { declared: m.dependencies.length, acquired: acquired.length, not_acquired: m.dependencies.length - acquired.length, remappings: m.remappings.length, remappings_available: m.remappings.filter((r) => r.available).length, packages: m.packages.length, limitations: m.limitations.length },
    limitations: m.limitations, manifest: m, ...passive,
  };
}

export type DependencyStepContext = {
  worker: Pick<StepLifecyclePort, "heartbeat" | "complete">; workerId: string; source: RepositorySource; heartbeatMs?: number;
  store: AcquisitionStore; reads: Pick<ResearchReads, "sealedSnapshot" | "snapshotConfigFiles">;
  /** the remote worker completes with only the digest and the failures it observed; the API re-derives the manifest itself */
  completion?: (snap: SealedSnapshotRef, manifest: DependencyManifest) => Record<string, unknown>;
};

/** One dependency through the EXISTING acquisition path, at exactly the pinned commit. */
export async function acquirePinnedDependency(deps: { store: AcquisitionStore; source: RepositorySource; signal?: AbortSignal }, lease: { stepId: string; workerId: string }, parent: SealedSnapshotRef, dep: DependencyRequest): Promise<AcquiredDependency | DependencyFailure> {
  try {
    const r = await acquireRepository({ store: deps.store, source: deps.source, ...(deps.signal ? { signal: deps.signal } : {}) }, lease, {
      repository: dep.repository, ref: dep.commitSha, onUnrepresentable: "seal_partial",
      dependencyOf: { root_repository: parent.repository, root_commit_sha: parent.commitSha, root_manifest_sha256: parent.manifestSha256, path: dep.path, depth: dep.depth, parent_repository: dep.parent.repository, parent_commit_sha: dep.parent.commit_sha, parent_tree_sha: dep.parent.tree_sha,
        path_in_parent: dep.parent.path_in_parent, pinned_commit: dep.commitSha, pin_established_by: "gitlink_in_parent_tree", source_url: dep.sourceUrl },
    });
    // the source may only ever answer with the pinned commit: anything else is refused, never recorded as the dependency
    if (r.commitSha !== dep.commitSha) return { ok: false, code: "unavailable", reason: `the source answered ${r.commitSha} for the pinned commit ${dep.commitSha}` };
    return { ok: true, snapshotId: r.snapshotId, treeSha: r.treeSha, manifestSha256: r.manifestSha256, fileCount: r.fileCount, storedBytes: r.storedBytes, completeness: r.completeness };
  } catch (error) {
    const f = failureOfAcquisition(error); if (f) return f;
    throw error;
  }
}

export async function processAcquireDependenciesStep(ctx: DependencyStepContext, step: ClaimedStep): Promise<void> {
  const input = dependencyStepInputSchema.safeParse(step.input);
  if (!input.success) throw new Error(`the dependency step input is invalid: ${input.error.issues[0]?.message ?? "unknown"}`);
  const controller = new AbortController(); let lost = false;
  const beat = setInterval(() => { ctx.worker.heartbeat(step.id).then((alive) => { if (!alive) { lost = true; controller.abort(); } }, () => undefined); }, ctx.heartbeatMs ?? 30_000);
  try {
    const snap = await ctx.reads.sealedSnapshot(step.workflow_run_id);
    const lease = { stepId: step.id, workerId: ctx.workerId };
    const manifest = await resolveDependencySet({
      tree: (repository, commitSha) => sourceTree(ctx.source, repository, commitSha, controller.signal),
      configFiles: (snapshotId) => ctx.reads.snapshotConfigFiles(snapshotId),
      acquire: (dep) => acquirePinnedDependency({ store: ctx.store, source: ctx.source, signal: controller.signal }, lease, snap, dep),
    }, snap, input.data.limits);
    if (ctx.completion) { await ctx.worker.complete(step.id, ctx.completion(snap, manifest)); return; }
    const blob = await (ctx.store as Pick<ResearchStore, "putBlob">).putBlob(lease, Buffer.from(canonicalJson(manifest), "utf8"));
    await ctx.worker.complete(step.id, dependencyStepOutput(snap, manifest, blob.sha256));
  } catch (error) {
    if (lost) throw new LeaseLostError("the step lease was lost during dependency acquisition");
    throw error;
  } finally { clearInterval(beat); }
}

export type RunDependencies = { exists: boolean; manifest: DependencyManifest | null; derived_by: "api" | "worker" | null };
/** The run's recorded dependency manifest (re-checked against its digest), or `exists: false` when the run has no dependency stage. */
export async function dependencyManifestOfRun(db: Pick<Pool, "query">, runId: string): Promise<RunDependencies> {
  const row = (await db.query<{ status: string; output: { manifest?: DependencyManifest; dependency_manifest_digest?: string; derived_by?: string } | null }>(
    "SELECT status, output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [runId, DEPENDENCY_STEP_KEY])).rows[0];
  if (!row) return { exists: false, manifest: null, derived_by: null };
  const m = row.status === "succeeded" ? row.output?.manifest ?? null : null;
  if (!m) return { exists: true, manifest: null, derived_by: null };
  const { digest, ...body } = m;
  if (m.schema !== DEPENDENCY_MANIFEST_SCHEMA || dependencyDigest(body) !== digest || digest !== row.output?.dependency_manifest_digest) throw new Error("the recorded dependency manifest does not match its digest; refusing to use it");
  return { exists: true, manifest: m, derived_by: row.output?.derived_by === "api" ? "api" : "worker" };
}

/** What the shared model and the tools need of the run's dependencies: the manifest and, per acquired dependency path, its file paths. */
export async function dependencyContextOfRun(db: Pick<Pool, "query">, runId: string): Promise<{ manifest: DependencyManifest; files: Record<string, string[]> } | null> {
  const d = await dependencyManifestOfRun(db, runId);
  if (!d.manifest) return null;
  const files: Record<string, string[]> = {};
  for (const dep of d.manifest.dependencies) if (dep.status === "acquired" && dep.snapshot_id) {
    files[dep.path] = (await db.query<{ path: string }>(`SELECT path FROM repo_snapshot_files WHERE snapshot_id = $1 AND workflow_run_id = $2 AND blob_sha256 IS NOT NULL ORDER BY path COLLATE "C"`, [dep.snapshot_id, runId])).rows.map((r) => r.path);
  }
  return { manifest: d.manifest, files };
}

/** The Solidity files of the ACQUIRED dependencies, each under its dependency path, for a compiler's private working directory. */
export async function dependencySolidityFilesOfRun(db: Pick<Pool, "query">, runId: string): Promise<Array<{ path: string; content: Buffer }>> {
  const d = await dependencyManifestOfRun(db, runId); const out: Array<{ path: string; content: Buffer }> = []; const seen = new Set<string>();
  for (const dep of d.manifest?.dependencies ?? []) if (dep.status === "acquired" && dep.snapshot_id) {
    const rows = (await db.query<{ path: string; content: Buffer }>(
      `SELECT f.path, b.content FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.snapshot_id = $1 AND f.workflow_run_id = $2 AND f.path LIKE '%.sol' ORDER BY f.path COLLATE "C"`, [dep.snapshot_id, runId])).rows;
    for (const r of rows) { const path = `${dep.path}/${r.path}`; if (!seen.has(path)) { seen.add(path); out.push({ path, content: r.content }); } }
  }
  return out;
}
export const manifestBlob = (m: DependencyManifest): { bytes: Buffer; sha256: string } => { const bytes = Buffer.from(canonicalJson(m), "utf8"); return { bytes, sha256: sha256Hex(bytes) }; };
