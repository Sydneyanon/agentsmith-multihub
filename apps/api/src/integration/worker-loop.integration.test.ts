import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StepError } from "../step-errors.js";
import { runWorkerLoop, type LogFn } from "../worker-loop.js";
import { WorkflowWorker } from "../worker.js";
import {
  assertIntegrationConfigured, auditCount, migratedTestDatabase, runRow, seedRun, skipIntegration, stepRow, type TestDatabase,
} from "./harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

describe.skipIf(skipIntegration)("worker loop over the real queue SQL", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await migratedTestDatabase();
  });
  afterAll(async () => { await db?.drop(); });

  /** Drive the real loop and the real WorkflowWorker until the queue for these keys is empty. */
  async function drive(keys: string[], execute: (worker: WorkflowWorker, step: Awaited<ReturnType<WorkflowWorker["claimNext"]>> & object) => Promise<void>) {
    const worker = new WorkflowWorker(db.pool, "loop-worker", 30, 3);
    const controller = new AbortController();
    const logs: Array<{ level: string; message: string }> = [];
    const sleeps: number[] = [];
    const log: LogFn = (level, message) => { logs.push({ level, message }); };
    await runWorkerLoop({
      maxAttempts: worker.maxAttempts,
      reapExhaustedLeases: () => worker.reapExhaustedLeases(),
      claimNext: async () => {
        const step = await worker.claimNext(keys);
        if (!step) controller.abort();
        return step;
      },
      fail: (id, reason, retryable) => worker.fail(id, reason, retryable),
      execute: (step) => execute(worker, step),
    }, controller.signal, { sleep: async (ms) => { sleeps.push(ms); }, log, pollMs: 0 });
    return { logs, sleeps };
  }

  it("retries a transient failure through the real queue and then completes the run", async () => {
    const keys = ["loop_recover_a", "loop_recover_b"];
    const { runId, stepIds } = await seedRun(db.pool, keys);
    let calls = 0;
    const { sleeps } = await drive(keys, async (worker, step) => {
      calls += 1;
      if (step.step_key === "loop_recover_a" && step.attempt < 3) throw new StepError("GitHub API returned HTTP 503", true);
      await worker.complete(step.id, { ok: true });
    });
    expect(calls).toBe(4); // A fails twice, succeeds on attempt 3, then B succeeds
    expect(await stepRow(db.pool, stepIds[0]!)).toMatchObject({ status: "succeeded", attempt: 3 });
    expect(await stepRow(db.pool, stepIds[1]!)).toMatchObject({ status: "succeeded", attempt: 1 });
    expect((await runRow(db.pool, runId)).status).toBe("succeeded");
    expect(await auditCount(db.pool, stepIds[0]!, "workflow_step.claimed")).toBe(3);
    expect(await auditCount(db.pool, stepIds[0]!, "workflow_step.failed")).toBe(2);
    expect(sleeps).toEqual(expect.arrayContaining([5_000, 10_000])); // exponential retry backoff between attempts
  });

  it("ends a persistently transient failure at the ceiling with the limit stated, and fails the run", async () => {
    const keys = ["loop_ceiling"];
    const { runId, stepIds } = await seedRun(db.pool, keys);
    await drive(keys, async () => { throw new StepError("GitHub API returned HTTP 502", true); });
    const step = await stepRow(db.pool, stepIds[0]!);
    expect(step).toMatchObject({ status: "failed", attempt: 3 });
    expect((step.error as { message: string; retryable: boolean }).message).toBe(
      "GitHub API returned HTTP 502 [transient failure, retry limit reached: attempt 3 of 3]",
    );
    expect((await runRow(db.pool, runId)).status).toBe("failed");
    expect(await auditCount(db.pool, stepIds[0]!, "workflow_step.failed")).toBe(3);
  });

  it("fails a permanent error on the first attempt with its message unchanged", async () => {
    const keys = ["loop_permanent"];
    const { runId, stepIds } = await seedRun(db.pool, keys);
    await drive(keys, async () => { throw new Error("Referenced source snapshot is missing or its content hash does not match workflow evidence"); });
    const step = await stepRow(db.pool, stepIds[0]!);
    expect(step).toMatchObject({ status: "failed", attempt: 1 });
    expect(step.error).toEqual({ message: "Referenced source snapshot is missing or its content hash does not match workflow evidence", retryable: false });
    expect((await runRow(db.pool, runId)).status).toBe("failed");
  });

  it("keeps working after the database terminates every connection mid-run", async () => {
    const keys = ["loop_backend_kill"];
    const a = await seedRun(db.pool, keys);
    const b = await seedRun(db.pool, keys);
    let killed = false;
    let terminated = 0;
    const { logs } = await drive(keys, async (worker, step) => {
      if (!killed) {
        killed = true;
        // Only non-superuser backends: a superuser-owned backend on this database (an autovacuum worker, typically just after the server
        // restarts) cannot be terminated by the test login, and PostgreSQL then refuses the WHOLE statement ("permission denied to
        // terminate process"), so nothing was killed and the test failed intermittently. Every connection the worker and the API hold
        // belongs to a non-superuser role, so this still terminates all of them; the count below proves it did.
        const r = await db.adminPool.query<{ ok: boolean }>(
          `SELECT pg_terminate_backend(a.pid) AS ok FROM pg_stat_activity a JOIN pg_roles r ON r.oid = a.usesysid
            WHERE a.datname = $1 AND a.pid <> pg_backend_pid() AND NOT r.rolsuper`, [db.name],
        );
        terminated = r.rows.filter((row) => row.ok).length;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await worker.complete(step.id, { ok: true });
    });
    expect(terminated).toBeGreaterThan(0);
    expect((await runRow(db.pool, a.runId)).status).toBe("succeeded");
    expect((await runRow(db.pool, b.runId)).status).toBe("succeeded");
    expect(logs.filter((entry) => entry.message === "step_failed" && entry.level === "error")).toHaveLength(0);
  });
});
