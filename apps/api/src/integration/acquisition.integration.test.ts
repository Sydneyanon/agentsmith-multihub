import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireRepository, type AcquireRequest, type AcquisitionStore } from "../acquisition/acquire.js";
import { AcquisitionError } from "../acquisition/errors.js";
import { manifestPathProblem } from "../acquisition/paths.js";
import { DEFAULT_LIMITS } from "../acquisition/limits.js";
import { ACQUIRE_STEP_KEY, REPOSITORY_RESEARCH_WORKFLOW, createRepositoryResearchRun, processAcquireRepositoryStep } from "../acquisition/step.js";
import { MAIN_FILES } from "../acquisition/testing/fixtures.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type FixtureFile, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { synthGz } from "../acquisition/testing/synth-archive.js";
import { registerBearerAuth } from "../auth.js";
import { ResearchStore, type StepLease } from "../research-state.js";
import { registerResearchRoutes } from "../research-api.js";
import { classifyStepError, LeaseLostError } from "../step-errors.js";
import { WorkflowWorker } from "../worker.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";
import { ResearchFixture } from "./research-helpers.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const TOKEN = randomBytes(36).toString("base64url");
const REQUEST: AcquireRequest = { repository: "acme/vault", ref: "main" };

/** Wraps the real store and fails the Nth call of one method, to simulate a crash at a chosen point. */
function crashing(real: ResearchStore, method: "putBlob" | "addSnapshotFiles" | "sealSnapshot", onCall: number): AcquisitionStore {
  let calls = 0;
  const wrapped = {
    findSnapshot: real.findSnapshot.bind(real), createSnapshot: real.createSnapshot.bind(real), putBlob: real.putBlob.bind(real),
    addSnapshotFiles: real.addSnapshotFiles.bind(real), sealSnapshot: real.sealSnapshot.bind(real), verifySnapshot: real.verifySnapshot.bind(real),
  } as Record<string, (...args: never[]) => Promise<unknown>>;
  const original = wrapped[method]!;
  wrapped[method] = (async (...args: never[]) => { calls += 1; if (calls === onCall) throw new Error(`simulated crash in ${method} (call ${calls})`); return original(...args); }) as never;
  return wrapped as unknown as AcquisitionStore;
}

describe.skipIf(skipIntegration)("repository acquisition over real Postgres", () => {
  let db: TestDatabase; let fx: ResearchFixture; let main: GitFixture; let store: ResearchStore;
  const count = async (sql: string, params: unknown[] = []) => Number((await db.pool.query<{ n: string }>(sql, params)).rows[0]!.n);
  const acquire = (lease: StepLease, source: FakeSource, st: AcquisitionStore = store, req: AcquireRequest = REQUEST) =>
    acquireRepository({ store: st, source, now: () => new Date("2026-01-02T03:04:05Z") }, lease, req);

  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await migratedTestDatabase(); fx = new ResearchFixture(db); store = new ResearchStore(db.pool);
    main = buildGitFixture(MAIN_FILES);
  });
  afterAll(async () => { main?.cleanup(); await db?.drop(); });

  describe("sealing a real snapshot", () => {
    let result: Awaited<ReturnType<typeof acquire>>; let lease: StepLease; let runId: string;
    beforeAll(async () => { const s = await fx.step(); lease = s.lease; runId = s.runId; result = await acquire(lease, new FakeSource(main)); });

    it("creates one sealed snapshot pinned to the commit, inside the producing run, in the existing 5.1 tables", async () => {
      const snap = (await db.pool.query("SELECT * FROM repo_snapshots WHERE id = $1", [result.snapshotId])).rows[0];
      expect(snap).toMatchObject({ workflow_run_id: runId, produced_by_step_id: lease.stepId, sealed_by_step_id: lease.stepId, source_host: "github.com", repository: "acme/vault", commit_sha: main.commitSha, ref_name: "main", manifest_sha256: result.manifestSha256 });
      expect(snap.sealed_at).not.toBeNull();
      expect(snap.file_count).toBe(result.fileCount);
      expect(Number(snap.total_bytes)).toBe(result.storedBytes);
      expect(snap.acquisition_report.source.commit_sha).toBe(main.commitSha);
      expect(snap.acquisition_report.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
    it("the database's own verification passes: manifest recomputed, every blob re-hashed", async () => {
      expect(await store.verifySnapshot(result.snapshotId)).toMatchObject({ ok: true, sealed: true, manifest_matches: true, evicted_blobs: 0, hash_mismatches: 0 });
    });
    it("every file of the git tree is a manifest row with its git object id, and nothing is silently dropped", async () => {
      const rows = (await db.pool.query("SELECT path, git_blob_sha, size_bytes, skip_reason, blob_sha256, classification FROM repo_snapshot_files WHERE snapshot_id = $1", [result.snapshotId])).rows;
      const tree = main.treeEntries.filter((e) => e.type !== "tree");
      expect(rows).toHaveLength(tree.length);
      for (const e of tree) {
        const row = rows.find((r) => r.path === e.path)!;
        if (e.type === "blob") expect(row.git_blob_sha, e.path).toBe(e.sha);
        expect((row.blob_sha256 === null) === (row.skip_reason !== null), e.path).toBe(true);
      }
      const reasons = Object.fromEntries(rows.filter((r) => r.skip_reason).map((r) => [r.path, r.skip_reason]));
      expect(reasons).toMatchObject({ "big.txt": "oversize", "image.bin": "binary", "latin1.txt": "unreadable_encoding", link: "symlink", "evil-link": "symlink", "deps/lib": "submodule" });
      expect(rows.every((r) => r.classification)).toBe(true);
    });
    it("stored bytes are exactly the repository's bytes (content addressed) and resolve as evidence", async () => {
      const row = (await db.pool.query("SELECT blob_sha256 FROM repo_snapshot_files WHERE snapshot_id = $1 AND path = 'contracts/Vault.sol'", [result.snapshotId])).rows[0];
      const blob = (await db.pool.query("SELECT content FROM research_blobs WHERE content_sha256 = $1", [row.blob_sha256])).rows[0];
      expect(Buffer.from(blob.content).toString("utf8")).toBe((MAIN_FILES[0] as { content: string }).content);
      const spanId = await store.createEvidenceSpan(lease, { snapshotId: result.snapshotId, path: "contracts/Vault.sol", lineStart: 3, lineEnd: 4 });
      expect(await store.resolveSpan(spanId)).toMatchObject({ ok: true, text: "contract Vault {\n  function withdraw() external {}" });
    });
    it("a sealed snapshot cannot be changed, extended or deleted", async () => {
      await expect(store.addSnapshotFiles(lease, result.snapshotId, [{ path: "new.sol", classification: "source", sizeBytes: 0, skipReason: "excluded_by_policy" }])).rejects.toThrow(/sealed/);
      await expect(db.ownerPool.query("UPDATE repo_snapshot_files SET size_bytes = 1 WHERE snapshot_id = $1", [result.snapshotId])).rejects.toThrow();
      await expect(db.ownerPool.query("DELETE FROM repo_snapshot_files WHERE snapshot_id = $1", [result.snapshotId])).rejects.toThrow();
      await expect(db.ownerPool.query("DELETE FROM repo_snapshots WHERE id = $1", [result.snapshotId])).rejects.toThrow();
      await expect(db.ownerPool.query("UPDATE repo_snapshots SET commit_sha = $2 WHERE id = $1", [result.snapshotId, "f".repeat(40)])).rejects.toThrow();
    });
    it("running it again in the same run changes nothing and says so", async () => {
      const before = { rows: await count("SELECT count(*) n FROM repo_snapshot_files"), blobs: await count("SELECT count(*) n FROM research_blobs"), snaps: await count("SELECT count(*) n FROM repo_snapshots") };
      const source = new FakeSource(main);
      const again = await acquire(lease, source);
      expect(again).toMatchObject({ snapshotId: result.snapshotId, manifestSha256: result.manifestSha256, reused: "sealed" });
      expect(source.calls.some((c) => c.startsWith("archive"))).toBe(false);   // a sealed snapshot is not downloaded again
      expect(await count("SELECT count(*) n FROM repo_snapshot_files")).toBe(before.rows);
      expect(await count("SELECT count(*) n FROM research_blobs")).toBe(before.blobs);
      expect(await count("SELECT count(*) n FROM repo_snapshots")).toBe(before.snaps);
    });
    it("two runs acquiring the same commit get separate snapshots with the same manifest, sharing the stored blobs", async () => {
      const blobsBefore = await count("SELECT count(*) n FROM research_blobs");
      const other = await fx.step();
      const second = await acquire(other.lease, new FakeSource(main));
      expect(second.snapshotId).not.toBe(result.snapshotId);
      expect(second.manifestSha256).toBe(result.manifestSha256);
      expect(await count("SELECT count(*) n FROM research_blobs")).toBe(blobsBefore);
      expect(await store.verifySnapshot(second.snapshotId)).toMatchObject({ ok: true });
    });
    it("is visible through the existing dashboard API: snapshot, manifest, file text and surface", async () => {
      const app: FastifyInstance = Fastify({ logger: false });
      registerBearerAuth(app, TOKEN); registerResearchRoutes(app, db.pool); await app.ready();
      const get = async (url: string) => JSON.parse((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } })).body);
      const snap = await get(`/v1/research/snapshots/${result.snapshotId}?verify=1`);
      expect(snap).toMatchObject({ sealed: true, commit_sha: main.commitSha, repository: "acme/vault", verification: { ok: true } });
      expect(snap.files.skip_reasons).toMatchObject({ oversize: 1, binary: 1, symlink: 3, submodule: 1 });
      const file = await get(`/v1/research/snapshots/${result.snapshotId}/file?path=${encodeURIComponent("contracts/Vault.sol")}`);
      expect(file.text).toContain("contract Vault");
      expect((await get(`/v1/research/snapshots/${result.snapshotId}/surface`)).files.length).toBe(result.fileCount);
      await app.close();
    });
  });

  describe("interrupted acquisition leaves nothing misleading, and the retry resumes it", () => {
    const stateOf = async (id: string) => (await db.pool.query("SELECT sealed_at, manifest_sha256 FROM repo_snapshots WHERE id = $1", [id])).rows[0];
    const rowCount = (id: string) => count("SELECT count(*) n FROM repo_snapshot_files WHERE snapshot_id = $1", [id]);

    it("a crash while storing blobs leaves an unsealed (building) snapshot with no rows; the retry completes the same snapshot", async () => {
      const { lease } = await fx.step();
      const source = new FakeSource(main);
      await expect(acquire(lease, source, crashing(store, "putBlob", 3))).rejects.toThrow(/simulated crash/);
      const [snap] = (await db.pool.query("SELECT id FROM repo_snapshots WHERE workflow_run_id = (SELECT workflow_run_id FROM workflow_steps WHERE id = $1)", [lease.stepId])).rows;
      expect((await stateOf(snap.id)).sealed_at).toBeNull();                    // it says "building", never "sealed"
      expect(await rowCount(snap.id)).toBe(0);
      expect(await store.verifySnapshot(snap.id)).toMatchObject({ ok: false, sealed: false });
      const resumed = await acquire(lease, new FakeSource(main));
      expect(resumed).toMatchObject({ snapshotId: snap.id, reused: "resumed" });
      expect(await store.verifySnapshot(snap.id)).toMatchObject({ ok: true, sealed: true });
    });
    it("a crash after the manifest was written but before sealing leaves it unsealed; the retry seals it", async () => {
      const { lease } = await fx.step();
      await expect(acquire(lease, new FakeSource(main), crashing(store, "sealSnapshot", 1))).rejects.toThrow(/simulated crash/);
      const snap = (await db.pool.query("SELECT id, sealed_at FROM repo_snapshots WHERE workflow_run_id = (SELECT workflow_run_id FROM workflow_steps WHERE id = $1)", [lease.stepId])).rows[0];
      expect(snap.sealed_at).toBeNull();
      expect(await rowCount(snap.id)).toBeGreaterThan(0);
      const done = await acquire(lease, new FakeSource(main));
      expect(done).toMatchObject({ snapshotId: snap.id, reused: "resumed" });
      expect((await stateOf(snap.id)).manifest_sha256).toBe(done.manifestSha256);
    });
    it("a crash part-way through a large manifest (a batch boundary) resumes without duplicating or losing rows", async () => {
      const many: FixtureFile[] = Array.from({ length: 1_300 }, (_, i) => ({ path: `src/f${String(i).padStart(4, "0")}.sol`, content: `contract C${i} {}\n` }));
      const big = buildGitFixture(many, { repo: "wide" });
      try {
        const { lease } = await fx.step();
        const req = { repository: "acme/wide", ref: "main" };
        await expect(acquire(lease, new FakeSource(big), crashing(store, "addSnapshotFiles", 2), req)).rejects.toThrow(/simulated crash/);
        const snap = (await db.pool.query("SELECT id FROM repo_snapshots WHERE workflow_run_id = (SELECT workflow_run_id FROM workflow_steps WHERE id = $1)", [lease.stepId])).rows[0];
        expect(await rowCount(snap.id)).toBe(500);                                // exactly the first batch was committed
        const done = await acquire(lease, new FakeSource(big), store, req);
        expect(done).toMatchObject({ snapshotId: snap.id, fileCount: 1_300, reused: "resumed" });
        expect(await rowCount(snap.id)).toBe(1_300);
        expect(await store.verifySnapshot(snap.id)).toMatchObject({ ok: true });
        const clean = await acquire((await fx.step()).lease, new FakeSource(big), store, req);
        expect(clean.manifestSha256).toBe(done.manifestSha256);                   // resumed and uninterrupted runs agree exactly
      } finally { big.cleanup(); }
    });
    it("a validation failure writes no snapshot row at all (rows cannot be deleted, so none may be started)", async () => {
      const { lease, runId } = await fx.step();
      const source = new FakeSource(main); source.tarGz = synthGz(main, { replace: { "contracts/Token.sol": Buffer.from("pragma solidity ^0.8.20;\ncontract EVIL {}\n") } });
      await expect(acquire(lease, source)).rejects.toMatchObject({ code: "archive_tree_mismatch" });
      expect(await count("SELECT count(*) n FROM repo_snapshots WHERE workflow_run_id = $1", [runId])).toBe(0);
      expect(await count("SELECT count(*) n FROM repo_snapshot_files WHERE workflow_run_id = $1", [runId])).toBe(0);
    });
    it("a retry that would produce a different manifest for a building snapshot is refused, and changes nothing", async () => {
      const { lease, runId } = await fx.step();
      await expect(acquire(lease, new FakeSource(main), crashing(store, "sealSnapshot", 1))).rejects.toThrow(/simulated crash/);
      const different = buildGitFixture(MAIN_FILES.map((f) => (f.path === "README.md" ? { path: f.path, content: "# changed\n" } : f)));
      try {
        const source = new FakeSource(different);
        source.commitSha = main.commitSha; source.treeSha = main.treeSha; source.refs = { main: main.commitSha, HEAD: main.commitSha };   // the hosting service claims the same commit
        source.tarGz = synthGz(different, { comment: main.commitSha });
        const before = await rowCount((await db.pool.query("SELECT id FROM repo_snapshots WHERE workflow_run_id = $1", [runId])).rows[0].id);
        await expect(acquire(lease, source)).rejects.toMatchObject({ code: "snapshot_conflict" });
        expect(await rowCount((await db.pool.query("SELECT id FROM repo_snapshots WHERE workflow_run_id = $1", [runId])).rows[0].id)).toBe(before);
      } finally { different.cleanup(); }
    });
    it("a retry whose content is a SUPERSET of the building snapshot is refused too (it must not seal under a stale recorded manifest)", async () => {
      const { lease, runId } = await fx.step();
      await expect(acquire(lease, new FakeSource(main), crashing(store, "sealSnapshot", 1))).rejects.toThrow(/simulated crash/);
      const bigger = buildGitFixture([...MAIN_FILES, { path: "extra/New.sol", content: "contract New {}\n" }]);
      try {
        const source = new FakeSource(bigger);
        source.commitSha = main.commitSha; source.treeSha = main.treeSha; source.refs = { main: main.commitSha, HEAD: main.commitSha };
        source.tarGz = synthGz(bigger, { comment: main.commitSha });
        const id = (await db.pool.query("SELECT id FROM repo_snapshots WHERE workflow_run_id = $1", [runId])).rows[0].id;
        const before = await rowCount(id);
        await expect(acquire(lease, source)).rejects.toMatchObject({ code: "snapshot_conflict" });
        expect(await rowCount(id)).toBe(before);                                   // no extra row was added
        expect((await stateOf(id)).sealed_at).toBeNull();
      } finally { bigger.cleanup(); }
    });
    it("a retry that names a different ref for the same commit is a conflict, not a silent merge", async () => {
      const { lease } = await fx.step();
      await expect(acquire(lease, new FakeSource(main), crashing(store, "sealSnapshot", 1))).rejects.toThrow(/simulated crash/);
      const source = new FakeSource(main); source.refs["release"] = main.commitSha;
      await expect(acquire(lease, source, store, { repository: "acme/vault", ref: "release" })).rejects.toMatchObject({ code: "snapshot_conflict" });
    });
  });

  describe("the 5.1 retry rule for snapshot reports compares values, not key order", () => {
    it("a retry carrying the same report with its keys in another order is the same snapshot; a changed value is a conflict", async () => {
      const { lease } = await fx.step();
      const commitSha = fx.commit();
      const report = { zeta: 1, alpha: { nested: [1, 2], b: "x" }, mid: true };
      const id = await store.createSnapshot(lease, { repository: "acme/order", commitSha, acquisitionReport: report });
      const reordered = { mid: true, alpha: { b: "x", nested: [1, 2] }, zeta: 1 };
      expect(await store.createSnapshot(lease, { repository: "acme/order", commitSha, acquisitionReport: reordered })).toBe(id);
      await expect(store.createSnapshot(lease, { repository: "acme/order", commitSha, acquisitionReport: { ...reordered, zeta: 2 } })).rejects.toThrow(/acquisition report/);
    });
  });

  describe("leases", () => {
    it("a worker that lost its lease before the writes cannot create anything", async () => {
      const { lease, runId } = await fx.step();
      const source = new FakeSource(main);
      const original = source.openArchive.bind(source);
      source.openArchive = async (...args) => { await db.ownerPool.query("UPDATE workflow_steps SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [lease.stepId]); return original(...args); };
      await expect(acquire(lease, source)).rejects.toBeInstanceOf(LeaseLostError);
      expect(await count("SELECT count(*) n FROM repo_snapshots WHERE workflow_run_id = $1", [runId])).toBe(0);
    });
  });

  describe("as a workflow step run by the existing worker", () => {
    it("creates a passive run, claims it, acquires, records pointers only, and completes the run", async () => {
      const { runId, stepId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vault", ref: "main" }, "owner");
      const run = (await db.pool.query("SELECT workflow_type, status, input FROM workflow_runs WHERE id = $1", [runId])).rows[0];
      expect(run).toMatchObject({ workflow_type: REPOSITORY_RESEARCH_WORKFLOW, status: "queued" });
      expect(run.input).toMatchObject({ kind: "repository", value: "acme/vault", execution_mode: "passive_only", authorization_status: "unverified" });
      const worker = new WorkflowWorker(db.pool, "acq-worker", 30, 3);
      const step = await worker.claimNext([ACQUIRE_STEP_KEY]);
      expect(step).toMatchObject({ id: stepId, step_key: ACQUIRE_STEP_KEY, role: "repository_acquirer" });
      await processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "acq-worker", source: new FakeSource(main), heartbeatMs: 25 }, step!);
      const done = (await db.pool.query("SELECT status, output FROM workflow_steps WHERE id = $1", [stepId])).rows[0];
      expect(done.status).toBe("succeeded");
      expect(done.output).toMatchObject({ status: "snapshot_sealed", commit_sha: main.commitSha, completeness: "complete", reused: "new", execution_mode: "passive_only", active_testing_allowed: false });
      expect(done.output.snapshot_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(done.output)).not.toMatch(/pragma solidity|contract Vault/);   // pointers and counts only
      expect((await db.pool.query("SELECT status FROM workflow_runs WHERE id = $1", [runId])).rows[0].status).toBe("succeeded");
      expect(await count("SELECT count(*) n FROM audit_events WHERE entity_id = $1 AND action = 'repository_research.created'", [runId])).toBe(1);
    });
    it("classifies failures for the worker loop: content problems are permanent, network and rate limits are retryable", async () => {
      const cases: Array<[string, (s: FakeSource) => void, "permanent" | "retryable"]> = [
        ["a tampered archive", (s) => { s.tarGz = synthGz(main, { comment: "e".repeat(40) }); }, "permanent"],
        ["a network failure", (s) => { s.archiveError = new AcquisitionError("network", "reset", true); }, "retryable"],
        ["a rate limit", (s) => { s.archiveError = new AcquisitionError("upstream_http", "HTTP 429", true, 30); }, "retryable"],
      ];
      for (const [name, tamper, kind] of cases) {
        const { stepId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vault", ref: "main" });
        const worker = new WorkflowWorker(db.pool, "acq-worker-2", 30, 3);
        const step = (await worker.claimNext([ACQUIRE_STEP_KEY]))!;
        expect(step.id).toBe(stepId);
        const source = new FakeSource(main); tamper(source);
        const error = await processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "acq-worker-2", source }, step).then(() => null, (e) => e);
        expect(classifyStepError(error).kind, name).toBe(kind);
        await worker.fail(stepId, "test cleanup", false);
      }
    });
    it("losing the lease during a long acquisition aborts it and reports a lost lease, not a failure", async () => {
      const { stepId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vault", ref: "main" });
      const worker = new WorkflowWorker(db.pool, "acq-worker-3", 30, 3);
      const step = (await worker.claimNext([ACQUIRE_STEP_KEY]))!;
      const source = new FakeSource(main); source.hang = true;
      const running = processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "acq-worker-3", source, heartbeatMs: 30 }, step);
      setTimeout(() => { void db.ownerPool.query("UPDATE workflow_steps SET lease_owner = 'someone-else' WHERE id = $1", [stepId]); }, 80);
      await expect(running).rejects.toBeInstanceOf(LeaseLostError);
      expect(classifyStepError(await running.catch((e) => e)).kind).toBe("lease_lost");
    });
    it("rejects malformed step input before touching the network", async () => {
      const worker = new WorkflowWorker(db.pool, "acq-worker-4", 30, 3);
      const source = new FakeSource(main);
      const error = await processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "acq-worker-4", source }, { id: "x", workflow_run_id: "y", step_key: ACQUIRE_STEP_KEY, sequence: 0, role: "r", attempt: 1, input: { repository: "acme/vault", surprise: true }, correlation_id: "c" }).then(() => null, (e) => e);
      expect(error).toBeInstanceOf(AcquisitionError); expect(source.calls).toEqual([]);
      await expect(createRepositoryResearchRun(db.pool, { repository: "../etc" })).rejects.toThrow();
    });
  });

  describe("path rules agree with the database's own constraint", () => {
    const candidates = ["a.sol", "a/b/c.sol", "with space.sol", "ünï/コード.sol", "back\\slash", ".hidden", "😀.sol", "a".repeat(1024), "a".repeat(1025), "", "/abs", "a/../b", "./a", "a//b", "a/", ".", "..",
      "a\tb", "a\nb", "a\rb", "a\u0000b", "a\ud800b", "trailing ", " leading", "a/./b", "..x", "x..", "a\u2028b", "a\u0085b"];
    /**
     * Stricter than the database on purpose.
     * "a/": a trailing slash names a directory, which a git tree never lists as a file.
     * "a\ud800b": a lone surrogate is silently rewritten to U+FFFD by the pg driver, so the database would store a DIFFERENT path
     * than the one given; refusing it keeps the manifest from recording an altered name.
     */
    const STRICTER_THAN_DATABASE = new Set(["a/", "a\ud800b"]);
    it("never treats as recordable a path the database would refuse, and differs only where it is deliberately stricter", async () => {
      const { lease } = await fx.step();
      const snapshotId = await store.createSnapshot(lease, { repository: "acme/paths", commitSha: fx.commit() });
      const stricter: string[] = [];
      for (const path of candidates) {
        const problem = manifestPathProblem(path, DEFAULT_LIMITS);
        const accepted = await store.addSnapshotFiles(lease, snapshotId, [{ path, classification: "other", sizeBytes: 0, skipReason: "excluded_by_policy" }]).then(() => true, () => false);
        if (problem === null) expect(accepted, `${JSON.stringify(path)} is recordable by our rules, so the database must accept it`).toBe(true);
        if (problem !== null && accepted) stricter.push(path);
      }
      expect(new Set(stricter)).toEqual(STRICTER_THAN_DATABASE);
    });
  });

  it("adds no migration and no table of its own: it uses the Task 5.1 schema as it is (0001-0007 are unchanged; later migrations belong to later phases)", () => {
    const migrations = readdirSync(join(process.cwd(), "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(migrations.slice(0, 7).map((f) => f.slice(0, 4))).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007"]);
    expect(migrations[6]).toBe("0007_research_state.sql");
    // Added after 5.2: 5.0's discovery (0008) and Workstream A's bounty collection (0011); neither creates an acquisition table.
    expect(migrations).toEqual([...migrations.slice(0, 7), "0008_discovery.sql", "0011_bounty_intelligence.sql"]);
  });
});
