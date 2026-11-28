import { describe, expect, it } from "vitest";
import { LeaseLostError } from "../step-errors.js";
import type { ClaimedStep } from "../worker.js";
import { computeApexShadow } from "./shadow.js";
import { processApexShadowStep, type ShadowSink, type ShadowStepContext } from "./shadow-step.js";
import { shadowReportSchema, ShadowRecordRefused, type ShadowReport } from "./shadow-record.js";
import { APEX_SHADOW_TARGET as T } from "./shadow-target.js";
import { usxLikeSources, usxScope } from "./testing/usx-like.js";

/**
 * The shadow step's isolation, without a database: whatever APEX does (throw, time out, run out of memory, return garbage), the step records
 * a shadow FAILURE and completes; only a lost lease propagates. The limit cases use the REAL bounded child (bounded-compute.ts).
 */
const SNAP = { snapshotId: "00000000-0000-4000-8000-0000000000aa", commitSha: T.commit, manifestSha256: "d".repeat(64), repository: T.repository };
const approval = { approved_by: "owner@example", approved_commit: T.commit, approved_at: "2026-11-28T00:00:00Z", basis: "test" };
const stepOf = (input: Record<string, unknown> = {}): ClaimedStep => ({ id: "00000000-0000-4000-8000-0000000000bb", workflow_run_id: "00000000-0000-4000-8000-0000000000cc", step_key: "apex_shadow", sequence: 4, role: "shadow_explorer", attempt: 1,
  input: { scope: "repository_research", mode: "measurement_only", repository: T.repository, ref: T.commit, approval, bounty_scope: usxScope(), ...input }, correlation_id: "00000000-0000-4000-8000-0000000000dd" });

function harness(over: Partial<ShadowStepContext> = {}, sinkOver: Partial<ShadowSink> = {}) {
  const recorded: ShadowReport[] = []; const completed: Array<{ sha: string | null; unrecorded?: unknown }> = []; const reads: string[] = [];
  const ctx: ShadowStepContext = {
    worker: { heartbeat: async () => true }, workerId: "w1", mode: "direct",
    reads: { sealedSnapshot: async () => SNAP, snapshotSources: async (id) => { reads.push(id); return usxLikeSources(); } },
    sink: { record: async (_s, r) => { expect(shadowReportSchema.safeParse(r).success).toBe(true); recorded.push(r); return { report_sha256: "e".repeat(64) }; }, complete: async (_s, sha, unrecorded) => { completed.push({ sha, ...(unrecorded ? { unrecorded } : {}) }); }, ...sinkOver },
    ...over,
  };
  return { ctx, recorded, completed, reads };
}

describe("the apex_shadow step: refusals, failures and isolation", () => {
  it("runs APEX in the bounded child on the in-scope files only and records a completed, schema-valid report with its provenance", async () => {
    const h = harness();
    let passed: string[] = [];
    h.ctx.compute = async (payload) => { passed = payload.sources.map((s) => s.path); return { result: computeApexShadow({ sources: payload.sources, inScopePaths: payload.in_scope_paths }), wallMs: 1, cpuMs: 1 }; };
    await processApexShadowStep(h.ctx, stepOf());
    expect(passed.sort()).toEqual([...T.inScopePaths].sort()); // out-of-scope files of the snapshot never reach APEX
    expect(h.recorded).toHaveLength(1); expect(h.completed).toEqual([{ sha: "e".repeat(64) }]);
    const r = h.recorded[0]!;
    expect(r.status).toBe("completed");
    expect(r.provenance).toMatchObject({ apex_version: "apex-shadow/1", strategy: "deep", snapshot_id: SNAP.snapshotId, commit_sha: T.commit, manifest_sha256: SNAP.manifestSha256, approved_by: "owner@example", approved_commit: T.commit, worker: { mode: "direct" } });
    expect(r.provenance.input_files.map((f) => f.path).sort()).toEqual([...T.inScopePaths].sort());
  }, 120_000);

  it("the REAL bounded child: a completed report end to end (task apex_shadow)", async () => {
    const h = harness();
    await processApexShadowStep(h.ctx, stepOf());
    expect(h.recorded[0]!.status).toBe("completed");
    expect(h.recorded[0]!.result!.contracts.length).toBeGreaterThan(0);
    expect(h.recorded[0]!.observed!.wall_ms).toBeGreaterThan(0);
  }, 180_000);

  it("refuses with a recorded reason: wrong commit, wrong scope, another snapshot commit, no sealed snapshot; APEX never runs", async () => {
    for (const [input, reads, expected] of [
      [{ ref: "1".repeat(40) }, null, "not_the_approved_commit"],
      [{ bounty_scope: usxScope({ in_scope_paths: ["src/USX.sol"] }) }, null, "scope_paths_differ"],
      [{}, { sealedSnapshot: async () => ({ ...SNAP, commitSha: "2".repeat(40) }) }, "snapshot_commit_differs"],
      [{}, { sealedSnapshot: async () => { throw new Error("the snapshot is not sealed and verified"); } }, "snapshot_not_sealed"],
    ] as const) {
      const h = harness(reads ? { reads: { ...harness().ctx.reads, ...reads } } : {});
      h.ctx.compute = async () => { throw new Error("APEX must not run for a refused run"); };
      await processApexShadowStep(h.ctx, stepOf(input as Record<string, unknown>));
      expect(h.recorded.map((r) => [r.status, r.refusal?.code]), expected).toEqual([["refused", expected]]);
      expect(h.reads).toEqual([]); // not even the sources are read
      expect(h.completed).toHaveLength(1);
    }
  });

  it("the run's own record wins over the step's copy (direct mode): a run edited after creation is refused", async () => {
    const h = harness({ runInput: { value: T.repository, ref: "3".repeat(40), apex_shadow: approval, bounty_scope: usxScope() } });
    await processApexShadowStep(h.ctx, stepOf());
    expect(h.recorded[0]).toMatchObject({ status: "refused", refusal: { code: "not_the_approved_commit" } });
  });

  it("a throwing APEX, a wall-time kill, a memory kill and an invalid result are recorded shadow failures; the step completes", async () => {
    const throwing = harness({ compute: async () => { throw new Error("boom inside APEX"); } });
    await processApexShadowStep(throwing.ctx, stepOf());
    expect(throwing.recorded[0]).toMatchObject({ status: "failed", failure: { code: "error", message: "boom inside APEX" } });
    const invalid = harness({ compute: async () => ({ result: { not: "a shadow result" }, wallMs: 1, cpuMs: 1 }) });
    await processApexShadowStep(invalid.ctx, stepOf());
    expect(invalid.recorded[0]).toMatchObject({ status: "failed", failure: { code: "invalid_result" } });
    const wall = harness({ computeLimits: { wallMs: 50 } });
    await processApexShadowStep(wall.ctx, stepOf());
    expect(wall.recorded[0]).toMatchObject({ status: "failed", failure: { code: "wall_limit" } });
    const memory = harness({ computeLimits: { maxHeapMb: 16 } });
    await processApexShadowStep(memory.ctx, stepOf());
    expect(memory.recorded[0]!.status).toBe("failed");
    expect(["memory_limit", "compute_failed"]).toContain(memory.recorded[0]!.failure!.code); // the heap kill is reported as such where V8 says so
    const cpu = harness({ computeLimits: { cpuMs: 50 } });
    await processApexShadowStep(cpu.ctx, stepOf());
    expect(cpu.recorded[0]).toMatchObject({ status: "failed" });
    expect(["cpu_limit", "wall_limit", "compute_failed"]).toContain(cpu.recorded[0]!.failure!.code);
    for (const h of [throwing, invalid, wall, memory, cpu]) { expect(h.completed).toHaveLength(1); expect(h.recorded[0]!.result).toBeNull(); }
  }, 180_000);

  it("a report that cannot be recorded is replaced by a recorded failure; if nothing can be recorded the step still completes and says why", async () => {
    let calls = 0;
    const once = harness({ compute: async () => { throw new Error("x"); } }, { record: async (_s, r) => { calls += 1; if (calls === 1) throw new ShadowRecordRefused(413, "storage_quota_exceeded", "quota"); return { report_sha256: "f".repeat(64) } as never; } });
    await processApexShadowStep(once.ctx, stepOf());
    expect(once.completed).toEqual([{ sha: "f".repeat(64) }]);
    const never = harness({ compute: async () => { throw new Error("x"); } }, { record: async () => { throw new ShadowRecordRefused(422, "shadow_report_rejected", "nope"); } });
    await processApexShadowStep(never.ctx, stepOf());
    expect(never.completed).toHaveLength(1);
    expect(never.completed[0]).toMatchObject({ sha: null, unrecorded: { code: "shadow_report_rejected" } });
  });

  it("only a lost lease propagates (the step is retried like any other step)", async () => {
    const lost = harness({ compute: async () => { throw new Error("x"); } }, { record: async () => { throw new ShadowRecordRefused(409, "lease_not_held", "lease"); } });
    await expect(processApexShadowStep(lost.ctx, stepOf())).rejects.toBeInstanceOf(LeaseLostError);
    const beat = harness({ worker: { heartbeat: async () => false }, heartbeatMs: 5, compute: async () => { await new Promise((r) => setTimeout(r, 40)); throw new Error("x"); } });
    await expect(processApexShadowStep(beat.ctx, stepOf())).rejects.toBeInstanceOf(LeaseLostError);
    expect(beat.recorded).toEqual([]);
  });
});
