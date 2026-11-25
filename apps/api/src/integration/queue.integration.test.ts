import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LeaseLostError } from "../step-errors.js";
import { WorkflowWorker } from "../worker.js";
import {
  assertIntegrationConfigured, auditCount, expireLease, migratedTestDatabase, runRow, seedRun, skipIntegration, stepRow,
  type TestDatabase,
} from "./harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

describe.skipIf(skipIntegration)("workflow queue against real Postgres", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await migratedTestDatabase();
  });
  afterAll(async () => { await db?.drop(); });

  const worker = (id = "w1", maxAttempts = 3) => new WorkflowWorker(db.pool, id, 30, maxAttempts);

  describe("claiming", () => {
    it("claims steps strictly in sequence and only after prior steps succeed", async () => {
      const { runId, stepIds } = await seedRun(db.pool, ["order_a", "order_b", "order_c"]);
      const w = worker();
      const first = await w.claimNext(["order_a", "order_b", "order_c"]);
      expect(first).toMatchObject({ id: stepIds[0], sequence: 0, attempt: 1, workflow_run_id: runId });
      expect(await w.claimNext(["order_a", "order_b", "order_c"])).toBeNull(); // step 1 is blocked behind running step 0
      await w.complete(stepIds[0]!, { ok: true });
      const second = await w.claimNext(["order_a", "order_b", "order_c"]);
      expect(second?.id).toBe(stepIds[1]);
      expect((await runRow(db.pool, runId)).status).toBe("running");
    });

    it("marks the run succeeded only when every step has succeeded, with audit events", async () => {
      const { runId, stepIds } = await seedRun(db.pool, ["done_a", "done_b"]);
      const w = worker();
      for (const id of stepIds) {
        const step = await w.claimNext(["done_a", "done_b"]);
        expect(step?.id).toBe(id);
        expect((await runRow(db.pool, runId)).status).toBe("running");
        await w.complete(id, { finished: id });
      }
      const run = await runRow(db.pool, runId);
      expect(run.status).toBe("succeeded");
      expect(run.completed_at).not.toBeNull();
      for (const id of stepIds) {
        expect(await auditCount(db.pool, id, "workflow_step.claimed")).toBe(1);
        expect(await auditCount(db.pool, id, "workflow_step.succeeded")).toBe(1);
      }
    });

    it("honours the step-key allowlist and never claims for an empty allowlist", async () => {
      const { stepIds } = await seedRun(db.pool, ["allow_only_me"]);
      const w = worker();
      expect(await w.claimNext(["something_else"])).toBeNull();
      expect(await w.claimNext([])).toBeNull();
      expect((await stepRow(db.pool, stepIds[0]!)).status).toBe("queued");
      expect((await w.claimNext(["allow_only_me"]))?.id).toBe(stepIds[0]);
    });

    it("does not claim steps of cancelled or failed runs", async () => {
      const cancelled = await seedRun(db.pool, ["skip_cancelled"], "cancelled");
      const failed = await seedRun(db.pool, ["skip_failed"], "failed");
      const w = worker();
      expect(await w.claimNext(["skip_cancelled", "skip_failed"])).toBeNull();
      expect((await stepRow(db.pool, cancelled.stepIds[0]!)).status).toBe("queued");
      expect((await stepRow(db.pool, failed.stepIds[0]!)).status).toBe("queued");
    });

    it("never hands the same step to two concurrent claimers (SKIP LOCKED)", async () => {
      const keys = ["concurrent_step"];
      const ids = new Set<string>();
      for (let i = 0; i < 12; i += 1) ids.add((await seedRun(db.pool, keys)).stepIds[0]!);
      const workers = [worker("cw1"), worker("cw2"), worker("cw3")];
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => workers[i % 3]!.claimNext(keys)));
      const claimed = results.filter((step) => step !== null).map((step) => step!.id);
      expect(claimed).toHaveLength(12);
      expect(new Set(claimed).size).toBe(12);
      for (const id of ids) {
        const row = await stepRow(db.pool, id);
        expect(row.attempt).toBe(1);
        expect(row.status).toBe("running");
      }
    });
  });

  describe("leases", () => {
    it("lets only the current owner heartbeat and complete", async () => {
      const { stepIds } = await seedRun(db.pool, ["lease_owner"]);
      const owner = worker("owner");
      const other = worker("intruder");
      await owner.claimNext(["lease_owner"]);
      expect(await owner.heartbeat(stepIds[0]!)).toBe(true);
      expect(await other.heartbeat(stepIds[0]!)).toBe(false);
      await expect(other.complete(stepIds[0]!)).rejects.toBeInstanceOf(LeaseLostError);
      await expect(other.fail(stepIds[0]!, "nope", true)).rejects.toBeInstanceOf(LeaseLostError);
      expect((await stepRow(db.pool, stepIds[0]!)).lease_owner).toBe("owner");
    });

    it("refuses heartbeat and completion after the lease expired, and lets another worker reclaim it", async () => {
      const { stepIds } = await seedRun(db.pool, ["lease_expiry"]);
      const first = worker("slow");
      await first.claimNext(["lease_expiry"]);
      await expireLease(db.pool, stepIds[0]!);
      expect(await first.heartbeat(stepIds[0]!)).toBe(false);
      await expect(first.complete(stepIds[0]!)).rejects.toBeInstanceOf(LeaseLostError);
      const reclaimed = await worker("fast").claimNext(["lease_expiry"]);
      expect(reclaimed).toMatchObject({ id: stepIds[0], attempt: 2 });
      expect((await stepRow(db.pool, stepIds[0]!)).lease_owner).toBe("fast");
    });

    it("does not claim a step that has used all its attempts", async () => {
      const { stepIds } = await seedRun(db.pool, ["attempts_used"]);
      await db.pool.query("UPDATE workflow_steps SET attempt = 3 WHERE id = $1", [stepIds[0]]);
      expect(await worker().claimNext(["attempts_used"])).toBeNull();
    });
  });

  describe("failure, retry and the attempt ceiling", () => {
    it("re-queues a retryable failure below the ceiling and keeps the run alive", async () => {
      const { runId, stepIds } = await seedRun(db.pool, ["retry_requeue"]);
      const w = worker();
      await w.claimNext(["retry_requeue"]);
      await w.fail(stepIds[0]!, "GitHub API returned HTTP 503", true);
      const step = await stepRow(db.pool, stepIds[0]!);
      expect(step).toMatchObject({ status: "queued", attempt: 1, lease_owner: null, lease_expires_at: null, completed_at: null });
      expect(step.error).toEqual({ message: "GitHub API returned HTTP 503", retryable: true });
      expect((await runRow(db.pool, runId)).status).toBe("running");
      expect(await auditCount(db.pool, stepIds[0]!, "workflow_step.failed")).toBe(1);
    });

    it("walks attempts 1, 2, 3 and then fails the step and the run terminally", async () => {
      const { runId, stepIds } = await seedRun(db.pool, ["retry_ceiling"]);
      const w = worker();
      for (const attempt of [1, 2, 3]) {
        const claimed = await w.claimNext(["retry_ceiling"]);
        expect(claimed).toMatchObject({ id: stepIds[0], attempt });
        await w.fail(stepIds[0]!, `transient ${attempt}`, true);
      }
      const step = await stepRow(db.pool, stepIds[0]!);
      expect(step).toMatchObject({ status: "failed", attempt: 3, lease_owner: null });
      expect(step.completed_at).not.toBeNull();
      expect(step.error).toEqual({ message: "transient 3", retryable: true });
      const run = await runRow(db.pool, runId);
      expect(run.status).toBe("failed");
      expect(run.completed_at).not.toBeNull();
      expect(await auditCount(db.pool, stepIds[0]!, "workflow_step.failed")).toBe(3);
      expect(await w.claimNext(["retry_ceiling"])).toBeNull(); // terminal: nothing left to claim
    });

    it("fails permanently on the first attempt when the failure is not retryable", async () => {
      const { runId, stepIds } = await seedRun(db.pool, ["retry_permanent"]);
      const w = worker();
      await w.claimNext(["retry_permanent"]);
      await w.fail(stepIds[0]!, "evidence hash mismatch", false);
      expect(await stepRow(db.pool, stepIds[0]!)).toMatchObject({ status: "failed", attempt: 1 });
      expect((await runRow(db.pool, runId)).status).toBe("failed");
    });

    it("honours a configured ceiling other than three", async () => {
      const { stepIds } = await seedRun(db.pool, ["retry_ceiling_one"]);
      const w = worker("w-one", 1);
      await w.claimNext(["retry_ceiling_one"]);
      await w.fail(stepIds[0]!, "transient", true);
      expect((await stepRow(db.pool, stepIds[0]!)).status).toBe("failed");
    });

    it("truncates a very long failure reason to the stored limit", async () => {
      const { stepIds } = await seedRun(db.pool, ["retry_long_reason"]);
      const w = worker();
      await w.claimNext(["retry_long_reason"]);
      await w.fail(stepIds[0]!, "x".repeat(5_000), false);
      expect(((await stepRow(db.pool, stepIds[0]!)).error as { message: string }).message).toHaveLength(2_000);
    });
  });

  describe("lease reaper", () => {
    it("fails an abandoned step that has used all attempts, fails its run and audits it", async () => {
      const { runId, stepIds } = await seedRun(db.pool, ["reap_exhausted"]);
      const w = worker("reaper");
      await w.claimNext(["reap_exhausted"]);
      await db.pool.query("UPDATE workflow_steps SET attempt = 3 WHERE id = $1", [stepIds[0]]);
      await expireLease(db.pool, stepIds[0]!);
      expect(await w.reapExhaustedLeases()).toBeGreaterThanOrEqual(1);
      const step = await stepRow(db.pool, stepIds[0]!);
      expect(step).toMatchObject({ status: "failed", lease_owner: null });
      expect((step.error as { message: string; retryable: boolean })).toMatchObject({ message: "Worker lease expired after maximum attempts", retryable: false });
      expect((await runRow(db.pool, runId)).status).toBe("failed");
      expect(await auditCount(db.pool, stepIds[0]!, "workflow_step.lease_exhausted")).toBe(1);
    });

    it("leaves expired steps with attempts remaining, and live leases, for reclaim", async () => {
      const remaining = await seedRun(db.pool, ["reap_remaining"]);
      const live = await seedRun(db.pool, ["reap_live"]);
      const w = worker("reaper2");
      await w.claimNext(["reap_remaining"]);
      await w.claimNext(["reap_live"]);
      await expireLease(db.pool, remaining.stepIds[0]!); // attempt 1 of 3, expired
      await w.reapExhaustedLeases();
      expect((await stepRow(db.pool, remaining.stepIds[0]!)).status).toBe("running");
      expect((await stepRow(db.pool, live.stepIds[0]!)).status).toBe("running");
      expect((await runRow(db.pool, remaining.runId)).status).toBe("running");
      expect((await worker("next").claimNext(["reap_remaining"]))?.attempt).toBe(2);
    });
  });

  describe("source snapshots", () => {
    const content = { repository: "acme/vault", files: [{ path: "A.sol", content: "contract A {}" }] };
    const sha = createHash("sha256").update(JSON.stringify(content)).digest("hex");

    it("persists evidence under the lease with a SHA-256 of the serialized content, and deduplicates", async () => {
      const { runId, stepIds } = await seedRun(db.pool, ["snap_persist"]);
      const w = worker();
      await w.claimNext(["snap_persist"]);
      const first = await w.persistSourceSnapshot(stepIds[0]!, { sourceUri: "https://api.github.com/x", sourceKind: "test", content });
      const again = await w.persistSourceSnapshot(stepIds[0]!, { sourceUri: "https://api.github.com/x", sourceKind: "test", content });
      expect(first.contentSha256).toBe(sha);
      expect(again.id).toBe(first.id);
      const rows = await db.pool.query("SELECT * FROM source_snapshots WHERE workflow_run_id = $1", [runId]);
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]).toMatchObject({ content_sha256: sha, workflow_step_id: stepIds[0], source_kind: "test" });
      const other = await w.persistSourceSnapshot(stepIds[0]!, { sourceUri: "https://api.github.com/x", sourceKind: "test", content: { ...content, extra: 1 } });
      expect(other.id).not.toBe(first.id);
    });

    it("refuses to persist evidence without a current lease", async () => {
      const { runId, stepIds } = await seedRun(db.pool, ["snap_lease"]);
      const w = worker("snap-owner");
      await w.claimNext(["snap_lease"]);
      await expect(worker("snap-intruder").persistSourceSnapshot(stepIds[0]!, { sourceUri: "u", sourceKind: "k", content })).rejects.toBeInstanceOf(LeaseLostError);
      await expireLease(db.pool, stepIds[0]!);
      await expect(w.persistSourceSnapshot(stepIds[0]!, { sourceUri: "u", sourceKind: "k", content })).rejects.toBeInstanceOf(LeaseLostError);
      expect((await db.pool.query("SELECT 1 FROM source_snapshots WHERE workflow_run_id = $1", [runId])).rowCount).toBe(0);
    });

    it("rejects UPDATE and DELETE of a persisted snapshot at the database level", async () => {
      const { runId, stepIds } = await seedRun(db.pool, ["snap_immutable"]);
      const w = worker();
      await w.claimNext(["snap_immutable"]);
      const saved = await w.persistSourceSnapshot(stepIds[0]!, { sourceUri: "u", sourceKind: "k", content });
      await expect(db.pool.query("UPDATE source_snapshots SET source_kind = 'x' WHERE id = $1", [saved.id])).rejects.toThrow(/immutable/);
      await expect(db.pool.query("UPDATE source_snapshots SET content_sha256 = $2 WHERE id = $1", [saved.id, "0".repeat(64)])).rejects.toThrow(/immutable/);
      await expect(db.pool.query("DELETE FROM source_snapshots WHERE id = $1", [saved.id])).rejects.toThrow(/immutable/);
      expect((await db.pool.query("SELECT content_sha256 FROM source_snapshots WHERE workflow_run_id = $1", [runId])).rows[0]!.content_sha256).toBe(sha);
    });
  });
});
