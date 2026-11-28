import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BoundedCompute, ComputeBusyError, ComputeLimitError } from "./bounded-compute.js";
import { buildStructuralMap, computeChallenge, computeStructuralAnalysis, type ComputedStructure, type PlannedEvaluation, type StoredHypothesis } from "./pipeline.js";

/**
 * D1/D3: the API's own analysis and validators run in a bounded child process. The child computes exactly what the in-process code
 * computes, and every limit (input size, CPU, wall time, heap, concurrency) refuses cleanly with a typed error.
 */
const corpus = join(__dirname, "..", "..", "..", "..", "..", "eval", "dev", "contracts");
const sources = readdirSync(corpus).sort().map((f) => ({ path: `contracts/${f}`, text: readFileSync(join(corpus, f), "utf8") }));

describe("bounded compute (the API's analysis runner)", () => {
  it("computes exactly the in-process structural analysis and validator plan", async () => {
    const c = new BoundedCompute();
    const a = await c.run<{ structure: ComputedStructure; map: unknown }>("analyze", { sources });
    expect(a.result.structure).toEqual(JSON.parse(JSON.stringify(computeStructuralAnalysis(sources))));
    expect(a.result.map).toEqual(JSON.parse(JSON.stringify(buildStructuralMap(sources))));
    const stored: StoredHypothesis[] = a.result.structure.findings.map((f, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, finding: f, spanIds: ["00000000-0000-4000-8000-ffffffffffff"] }));
    const ch = await c.run<{ planned: PlannedEvaluation[] }>("challenge", { sources, stored });
    expect(ch.result.planned).toEqual(JSON.parse(JSON.stringify(computeChallenge(sources, stored))));
    expect(ch.result.planned.length).toBe(stored.length);
    expect(a.wallMs).toBeGreaterThan(0);
  }, 60_000);

  it("refuses an input over the size limit before starting anything", async () => {
    const e = await new BoundedCompute({ maxInputBytes: 1000 }).run("analyze", { sources }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ComputeLimitError); expect((e as ComputeLimitError).code).toBe("input_too_large");
  });

  it("kills the child on the CPU-time limit and on the wall-time limit", async () => {
    const cpu = await new BoundedCompute({ cpuMs: 1 }).run("analyze", { sources }).catch((x: unknown) => x);
    expect(cpu).toBeInstanceOf(ComputeLimitError); expect((cpu as ComputeLimitError).code).toBe("cpu_limit");
    const wall = await new BoundedCompute({ wallMs: 20 }).run("analyze", { sources }).catch((x: unknown) => x);
    expect(wall).toBeInstanceOf(ComputeLimitError); expect((wall as ComputeLimitError).code).toBe("wall_limit");
  }, 60_000);

  it("bounds the child's heap and its answer size", async () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ path: `c/${i}.sol`, text: sources.map((s) => s.text).join("\n") }));
    const heap = await new BoundedCompute({ maxHeapMb: 16, wallMs: 60_000, cpuMs: 60_000 }).run("analyze", { sources: big }).catch((x: unknown) => x);
    expect(heap).toBeInstanceOf(ComputeLimitError); expect(["memory_limit", "compute_failed"]).toContain((heap as ComputeLimitError).code);
    const out = await new BoundedCompute({ maxOutputBytes: 100 }).run("analyze", { sources }).catch((x: unknown) => x);
    expect(out).toBeInstanceOf(ComputeLimitError); expect((out as ComputeLimitError).code).toBe("output_too_large");
  }, 120_000);

  it("caps concurrency: a request that cannot start in time is refused as busy (retryable), never queued without bound", async () => {
    const c = new BoundedCompute({ maxConcurrent: 1, queueMs: 10 });
    const first = c.run("analyze", { sources });
    const second = await c.run("analyze", { sources }).catch((x: unknown) => x);
    expect(second).toBeInstanceOf(ComputeBusyError);
    await first;
  }, 60_000);

  it("gives the child a minimal environment (no database URL, no token, no secrets)", () => {
    const src = readFileSync(join(__dirname, "bounded-compute.ts"), "utf8");
    expect(src).toMatch(/env: \{ PATH: "\/usr\/bin:\/bin", NODE_ENV: process\.env\.NODE_ENV \?\? "production" \}/);
  });
});
