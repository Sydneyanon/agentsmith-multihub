import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { LeaseLostError, StepError } from "./step-errors.js";
import { abortableSleep, runWorkerLoop, type WorkerLoopDeps } from "./worker-loop.js";
import { attachPoolErrorHandler } from "./worker-runtime.js";
import type { ClaimedStep } from "./worker.js";

const mk = (attempt = 1, id = "step-1"): ClaimedStep => ({
  id, workflow_run_id: "run-1", step_key: "identify_project", sequence: 1, role: "researcher",
  attempt, input: {}, correlation_id: "corr-1",
});

type Script = {
  claims: Array<ClaimedStep | null | Error>;
  executes?: Array<void | Error>;
  fails?: Array<void | Error>;
  reap?: Array<void | Error>;
  maxAttempts?: number;
};

function harness(script: Script) {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> | undefined }> = [];
  let claimIndex = 0;
  const calls = { claim: 0, execute: [] as string[], fail: [] as Array<{ id: string; reason: string; retryable: boolean }> };
  const queues = { executes: [...(script.executes ?? [])], fails: [...(script.fails ?? [])], reap: [...(script.reap ?? [])] };
  const deps: WorkerLoopDeps = {
    maxAttempts: script.maxAttempts ?? 3,
    reapExhaustedLeases: async () => {
      const next = queues.reap.shift();
      if (next instanceof Error) throw next;
      return 0;
    },
    claimNext: async () => {
      calls.claim += 1;
      if (claimIndex >= script.claims.length) { controller.abort(); return null; }
      const next = script.claims[claimIndex++];
      if (next instanceof Error) throw next;
      return next ?? null;
    },
    execute: async (step) => {
      calls.execute.push(step.id);
      const next = queues.executes.shift();
      if (next instanceof Error) throw next;
    },
    fail: async (id, reason, retryable) => {
      calls.fail.push({ id, reason, retryable });
      const next = queues.fails.shift();
      if (next instanceof Error) throw next;
    },
  };
  const options = {
    pollMs: 7, infraBackoffBaseMs: 1_000, infraBackoffMaxMs: 8_000, retryBackoffBaseMs: 5_000, retryBackoffMaxMs: 40_000,
    failRecordAttempts: 3, failRecordBackoffMs: 100,
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => { logs.push({ level, message, fields }); },
  };
  return { controller, sleeps, logs, calls, deps, options, run: () => runWorkerLoop(deps, controller.signal, options) };
}
const dbDown = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });

describe("worker loop: infrastructure errors", () => {
  it("survives claim failures, backs off exponentially and recovers to process work", async () => {
    const h = harness({ claims: [dbDown(), dbDown(), dbDown(), mk()] });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.calls.execute).toEqual(["step-1"]);
    expect(h.sleeps.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
    expect(h.logs.filter((l) => l.message === "worker_infrastructure_error")).toHaveLength(3);
    expect(h.calls.fail).toHaveLength(0);
  });

  it("caps the infrastructure backoff and resets it after a successful claim", async () => {
    const h = harness({ claims: [dbDown(), dbDown(), dbDown(), dbDown(), dbDown(), null, dbDown()] });
    await h.run();
    expect(h.sleeps.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    expect(h.sleeps[5]).toBe(7); // idle poll after a successful (empty) claim
    expect(h.sleeps[6]).toBe(1_000); // counter reset
  });

  it("survives a reap failure without claiming that cycle", async () => {
    const h = harness({ claims: [mk()], reap: [dbDown()] });
    await h.run();
    expect(h.calls.claim).toBe(2); // first cycle skipped claim; second claimed and the third ended the run
    expect(h.calls.execute).toEqual(["step-1"]);
    expect(h.sleeps[0]).toBe(1_000);
  });
});

describe("worker loop: step failure and retry policy", () => {
  it("re-queues a transient failure with the original message plus attempt context, then backs off", async () => {
    const h = harness({ claims: [mk(1)], executes: [new StepError("GitHub API returned HTTP 503", true)] });
    await h.run();
    expect(h.calls.fail).toEqual([{
      id: "step-1", retryable: true,
      reason: "GitHub API returned HTTP 503 [transient failure, will retry: attempt 1 of 3]",
    }]);
    expect(h.sleeps[0]).toBe(5_000);
  });

  it("backs off exponentially across attempts and honours a longer Retry-After hint", async () => {
    const h = harness({ claims: [mk(2), mk(3, "step-2")], executes: [new StepError("x", true), new StepError("y", true, 60)], maxAttempts: 5 });
    await h.run();
    expect(h.sleeps[0]).toBe(10_000);
    expect(h.sleeps[1]).toBe(60_000);
  });

  it("recovers: the same step fails transiently, is reclaimed, and then succeeds", async () => {
    const h = harness({ claims: [mk(1), mk(2)], executes: [new StepError("blip", true), undefined] });
    await h.run();
    expect(h.calls.execute).toEqual(["step-1", "step-1"]);
    expect(h.calls.fail).toHaveLength(1);
    expect(h.calls.fail[0]?.retryable).toBe(true);
  });

  it("reports the retry limit instead of silently failing, and does not back off", async () => {
    const h = harness({ claims: [mk(3)], executes: [new StepError("GitHub API returned HTTP 502", true)] });
    await h.run();
    expect(h.calls.fail[0]).toMatchObject({ id: "step-1", retryable: true });
    expect(h.calls.fail[0]?.reason).toBe("GitHub API returned HTTP 502 [transient failure, retry limit reached: attempt 3 of 3]");
    expect(h.sleeps).toEqual([7]); // only the idle poll; no retry backoff
    const entry = h.logs.find((l) => l.message === "step_failed");
    expect(entry?.level).toBe("error");
    expect(entry?.fields).toMatchObject({ limitReached: true, retryable: true, attempt: 3, maxAttempts: 3 });
  });

  it("fails permanently, with the message unchanged, for non-transient errors", async () => {
    const h = harness({ claims: [mk(1)], executes: [new Error("Referenced source snapshot is missing or its content hash does not match workflow evidence")] });
    await h.run();
    expect(h.calls.fail).toEqual([{
      id: "step-1", retryable: false,
      reason: "Referenced source snapshot is missing or its content hash does not match workflow evidence",
    }]);
    expect(h.sleeps).toEqual([7]);
  });

  it("treats an unclassified error as permanent", async () => {
    const h = harness({ claims: [mk(1)], executes: [new Error("something unexpected")] });
    await h.run();
    expect(h.calls.fail[0]).toMatchObject({ retryable: false, reason: "something unexpected" });
  });

  it("does not fail or crash when the lease was lost during execution", async () => {
    const h = harness({ claims: [mk(1), mk(1, "step-2")], executes: [new LeaseLostError("Step lease lost"), undefined] });
    await h.run();
    expect(h.calls.fail).toHaveLength(0);
    expect(h.calls.execute).toEqual(["step-1", "step-2"]);
    expect(h.logs.some((l) => l.message === "step_lease_lost")).toBe(true);
  });
});

describe("worker loop: recording failures when the database is unhealthy", () => {
  it("retries recording a failure and succeeds once the database recovers", async () => {
    const h = harness({ claims: [mk(1)], executes: [new Error("bad data")], fails: [dbDown(), dbDown(), undefined] });
    await h.run();
    expect(h.calls.fail).toHaveLength(3);
    expect(h.sleeps.slice(0, 2)).toEqual([100, 200]);
    expect(h.logs.some((l) => l.message === "step_failure_unrecorded_lease_expiry_will_recover")).toBe(false);
  });

  it("gives up after its attempts without crashing and leaves recovery to lease expiry", async () => {
    const h = harness({ claims: [mk(1), mk(1, "step-2")], executes: [new Error("bad"), undefined], fails: [dbDown(), dbDown(), dbDown()] });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.calls.fail).toHaveLength(3);
    expect(h.logs.some((l) => l.message === "step_failure_unrecorded_lease_expiry_will_recover")).toBe(true);
    expect(h.calls.execute).toEqual(["step-1", "step-2"]); // the loop kept working
  });

  it("stops retrying the record when the lease is already lost", async () => {
    const h = harness({ claims: [mk(1)], executes: [new Error("bad")], fails: [new LeaseLostError("Step lease lost or step is not owned by this worker")] });
    await h.run();
    expect(h.calls.fail).toHaveLength(1);
  });
});

describe("worker loop: shutdown", () => {
  it("never claims when already aborted", async () => {
    const h = harness({ claims: [mk()] });
    h.controller.abort();
    await h.run();
    expect(h.calls.claim).toBe(0);
  });

  it("finishes the in-flight step, then stops without claiming another", async () => {
    const h = harness({ claims: [mk(1), mk(1, "step-2")] });
    const execute = h.deps.execute;
    h.deps.execute = async (step) => { h.controller.abort(); await execute(step); };
    await h.run();
    expect(h.calls.execute).toEqual(["step-1"]);
    expect(h.calls.claim).toBe(1);
  });

  it("stops retrying to record a failure once shutdown is requested", async () => {
    const h = harness({ claims: [mk(1)], executes: [new Error("bad")], fails: [dbDown(), dbDown(), dbDown()] });
    const fail = h.deps.fail;
    h.deps.fail = async (...args) => { h.controller.abort(); await fail(...args); };
    await h.run();
    expect(h.calls.fail).toHaveLength(1);
  });

  it("abortableSleep resolves immediately on abort and when already aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await pending;
    await abortableSleep(60_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("pool error handler", () => {
  it("absorbs idle connection errors that would otherwise crash the process", () => {
    const pool = new Pool({ connectionString: "postgres://demo@127.0.0.1:1/none" });
    expect(() => pool.emit("error", new Error("boom"))).toThrow("boom");
    const log = vi.fn();
    attachPoolErrorHandler(pool, log);
    expect(() => pool.emit("error", new Error("Connection terminated"))).not.toThrow();
    expect(log).toHaveBeenCalledWith("error", "idle_database_connection_error", { error: "Connection terminated" });
  });
});
