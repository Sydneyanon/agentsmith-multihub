import { describe, expect, it } from "vitest";
import { acquisitionProgress, ProgressReporter, stepProgressSchema, type StepProgress } from "./step-progress.js";

describe("step progress: the worker-side throttle", () => {
  const harness = () => {
    let t = 0; const sent: StepProgress[] = [];
    const r = new ProgressReporter(async (_id, p) => { sent.push(p); }, "step-1", { intervalMs: 2000, now: () => t });
    return { r, sent, advance: (ms: number) => { t += ms; } };
  };

  it("sends every phase change, every completed phase, and at most one report per interval within a phase", async () => {
    const { r, sent, advance } = harness();
    r.report("planned", 0, 100, "files");
    r.report("writing_manifest", 0, 100, "manifest_rows"); // phase change: sent
    for (let i = 1; i < 50; i++) { advance(10); r.report("writing_manifest", i, 100, "manifest_rows"); } // 490 ms: all dropped
    advance(2000); r.report("writing_manifest", 60, 100, "manifest_rows"); // interval passed: sent
    advance(10); r.report("writing_manifest", 100, 100, "manifest_rows"); // completed: sent despite the interval
    await r.flush();
    expect(sent.map((p) => [p.phase, p.done])).toEqual([["planned", 0], ["writing_manifest", 0], ["writing_manifest", 60], ["writing_manifest", 100]]);
    expect(r.dropped).toBe(49);
  });

  it("never throws and never blocks: a failing sink is counted, the step goes on", async () => {
    const errors: unknown[] = [];
    const r = new ProgressReporter(async () => { throw new Error("api down"); }, "s", { onError: (e) => errors.push(e) });
    expect(() => r.report("planned", 0, 3, "files")).not.toThrow();
    await r.flush();
    expect(r.failed).toBe(1); expect(errors).toHaveLength(1);
    const silent = new ProgressReporter(undefined, "s"); silent.report("planned", 0, 1, "files"); await silent.flush(); expect(silent.sent).toBe(0);
  });

  it("a slow sink never holds the step beyond the flush timeout", async () => {
    const r = new ProgressReporter(() => new Promise(() => undefined), "s");
    r.report("planned", 0, 1, "files");
    const started = Date.now(); await r.flush(50); expect(Date.now() - started).toBeLessThan(1000);
  });

  it("the schema is strict: unknown units, negative counts, done above total and extra fields are refused", () => {
    expect(stepProgressSchema.safeParse({ phase: "planned", done: 1, total: 2, unit: "files" }).success).toBe(true);
    expect(stepProgressSchema.safeParse({ phase: "planned", done: 0, total: null, unit: "files" }).success).toBe(true);
    for (const bad of [{ phase: "planned", done: 3, total: 2, unit: "files" }, { phase: "planned", done: -1, total: 2, unit: "files" }, { phase: "Planned!", done: 0, total: 1, unit: "files" },
      { phase: "planned", done: 0, total: 1, unit: "percent" }, { phase: "planned", done: 0, total: 1, unit: "files", percent: 50 }, { phase: "planned", done: 0.5, total: 1, unit: "files" }]) {
      expect(stepProgressSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("maps acquisition events to progress; events without counts report no total (not measurable), never a guess", () => {
    expect(acquisitionProgress("resolved", { repository: "a/b" })).toEqual({ phase: "resolved_commit", done: 0, total: null, unit: "files" });
    expect(acquisitionProgress("planned", { entries: 40, candidates: 31 })).toEqual({ phase: "planned", done: 0, total: 31, unit: "files" });
    expect(acquisitionProgress("manifest_rows_added", { done: 500, total: 431 })).toEqual({ phase: "writing_manifest", done: 431, total: 431, unit: "manifest_rows" });
    expect(acquisitionProgress("blobs_stored", { done: 4, total: 9 })).toEqual({ phase: "storing_blobs", done: 4, total: 9, unit: "blobs" });
    expect(acquisitionProgress("planned", {})).toBeNull();
    expect(acquisitionProgress("something_else", { done: 1, total: 2 })).toBeNull();
  });
});
