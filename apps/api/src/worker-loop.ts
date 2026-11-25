import type { ClaimedStep } from "./worker.js";
import { classifyStepError } from "./step-errors.js";

export type LogFn = (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export const defaultLog: LogFn = (level, message, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
};

/** Resolves after ms, or immediately when the signal aborts. */
export const abortableSleep: SleepFn = (ms, signal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  }
  signal.addEventListener("abort", done, { once: true });
});

export type WorkerLoopDeps = {
  reapExhaustedLeases(): Promise<number>;
  claimNext(): Promise<ClaimedStep | null>;
  fail(stepId: string, reason: string, retryable: boolean): Promise<void>;
  execute(step: ClaimedStep): Promise<void>;
  maxAttempts: number;
};

export type WorkerLoopOptions = {
  pollMs?: number;
  infraBackoffBaseMs?: number;
  infraBackoffMaxMs?: number;
  retryBackoffBaseMs?: number;
  retryBackoffMaxMs?: number;
  failRecordAttempts?: number;
  failRecordBackoffMs?: number;
  sleep?: SleepFn;
  log?: LogFn;
};

const exponential = (base: number, max: number, n: number) => Math.min(max, base * 2 ** Math.max(0, n - 1));

/**
 * Poll, claim and execute steps until the signal aborts.
 *
 * - Database failures in reap/claim never crash the loop: it backs off and retries.
 * - A step failure is classified. Transient failures are re-queued through
 *   fail(..., retryable=true) (the SQL enforces the attempt ceiling and marks the
 *   run failed at the limit); permanent and unclassified failures are terminal.
 * - If a failure cannot be recorded (DB down), the lease is left to expire so the
 *   step is reclaimed and the attempt counter still advances. The worker never
 *   marks a step failed without recording it, and never crashes trying.
 * - Shutdown: the in-flight step finishes; no new step is claimed after abort.
 */
export async function runWorkerLoop(deps: WorkerLoopDeps, signal: AbortSignal, options: WorkerLoopOptions = {}): Promise<void> {
  const pollMs = options.pollMs ?? 2_000;
  const infraBase = options.infraBackoffBaseMs ?? 1_000;
  const infraMax = options.infraBackoffMaxMs ?? 30_000;
  const retryBase = options.retryBackoffBaseMs ?? 5_000;
  const retryMax = options.retryBackoffMaxMs ?? 120_000;
  const recordAttempts = options.failRecordAttempts ?? 3;
  const recordBackoff = options.failRecordBackoffMs ?? 500;
  const sleep = options.sleep ?? abortableSleep;
  const log = options.log ?? defaultLog;
  let infraFailures = 0;

  async function recordFailure(step: ClaimedStep, reason: string, retryable: boolean): Promise<boolean> {
    for (let attempt = 1; attempt <= recordAttempts; attempt += 1) {
      try {
        await deps.fail(step.id, reason, retryable);
        return true;
      } catch (error) {
        if (classifyStepError(error).kind === "lease_lost") {
          log("warn", "step_failure_not_recorded_lease_lost", { stepId: step.id });
          return false;
        }
        log("error", "step_failure_record_error", {
          stepId: step.id, attempt, of: recordAttempts, error: error instanceof Error ? error.message : String(error),
        });
        if (signal.aborted || attempt === recordAttempts) break;
        await sleep(recordBackoff * 2 ** (attempt - 1), signal);
      }
    }
    log("error", "step_failure_unrecorded_lease_expiry_will_recover", { stepId: step.id });
    return false;
  }

  while (!signal.aborted) {
    let step: ClaimedStep | null;
    try {
      await deps.reapExhaustedLeases();
      step = await deps.claimNext();
      infraFailures = 0;
    } catch (error) {
      infraFailures += 1;
      const delay = exponential(infraBase, infraMax, infraFailures);
      log("error", "worker_infrastructure_error", {
        consecutiveFailures: infraFailures, retryInMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay, signal);
      continue;
    }
    if (!step) {
      await sleep(pollMs, signal);
      continue;
    }

    try {
      await deps.execute(step);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown intake step error";
      const failure = classifyStepError(error);
      if (failure.kind === "lease_lost") {
        log("warn", "step_lease_lost", { stepId: step.id, stepKey: step.step_key, message });
        continue;
      }
      const retryable = failure.kind === "retryable";
      const limitReached = retryable && step.attempt >= deps.maxAttempts;
      const reason = !retryable ? message
        : limitReached ? `${message} [transient failure, retry limit reached: attempt ${step.attempt} of ${deps.maxAttempts}]`
          : `${message} [transient failure, will retry: attempt ${step.attempt} of ${deps.maxAttempts}]`;
      log(retryable && !limitReached ? "warn" : "error", "step_failed", {
        stepId: step.id, stepKey: step.step_key, attempt: step.attempt, maxAttempts: deps.maxAttempts,
        category: failure.category, retryable, limitReached, message,
      });
      await recordFailure(step, reason, retryable);
      if (retryable && !limitReached) {
        const hinted = failure.retryAfterSeconds !== undefined ? failure.retryAfterSeconds * 1_000 : 0;
        await sleep(Math.max(exponential(retryBase, retryMax, step.attempt), hinted), signal);
      }
    }
  }
}
