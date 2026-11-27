import { cpSync, mkdtempSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adjudicate, buildPrompt, parseVerdict, selectCandidates, ADJUDICATION_TASK, type Candidate } from "./adjudicate.js";
import { checkLabels, classifyExtraFindings, metrics, runBenchmark, verifyArchivedVersions, verifyManifest, type FindingRow, type Label } from "./benchmark.js";
import { analyzeSources } from "../../apps/api/src/analysis/solidity/specialists.js";
import { buildModelView, stripComments } from "./model-view.js";
import { loadCorpus } from "../run-eval.js";
import { MODEL_ROUTING } from "../../apps/api/src/ai-budget.js";

const repoRoot = resolve(__dirname, "..", "..");
const benchB = join(repoRoot, "eval", "benchmark-b");
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

describe("benchmark runner", () => {
  it("computes precision, recall and false-positive rate, with null for empty denominators", () => {
    expect(metrics({ tp: 3, fp: 1, fn: 1, tn: 3 })).toMatchObject({ precision: 0.75, recall: 0.75, falsePositiveRate: 0.25 });
    expect(metrics({ tp: 0, fp: 0, fn: 2, tn: 2 })).toMatchObject({ precision: null, recall: 0, falsePositiveRate: 0 });
  });

  it("runs benchmark-b v3 completely: manifest OK, labels intact, recall 0 on all eight classes, no false positives", () => {
    const r = runBenchmark({ contractsDir: join(benchB, "contracts"), repoRoot });
    expect(r.complete).toBe(true);
    expect(r.benchmark).toMatchObject({ name: "benchmark-b", version: 3 });
    expect(r.benchmark.manifest.ok).toBe(true);
    expect(r.labels).toMatchObject({ total: 16, vulnerable: 8, secure: 8 });
    expect(Object.keys(r.deterministic.perClass)).toHaveLength(8);
    for (const c of Object.values(r.deterministic.perClass)) expect(c).toMatchObject({ tp: 0, fp: 0, fn: 1, tn: 1, recall: 0, falsePositiveRate: 0 });
    expect(r.deterministic.collisions).toHaveLength(0);
    expect(r.deterministic.unscoredFindings).toHaveLength(0);
    expect(r.deterministic.reproducibleAcrossFileOrder).toBe(true);
    expect(r.exposure).toBe("blind");
    expect(r.ai.usedInDeterministicResult).toBe(false);
  });

  it("marks a tampered corpus incomplete and names the altered file", () => {
    const dir = mkdtempSync(join(tmpdir(), "benchb-")); tmp.push(dir);
    cpSync(benchB, dir, { recursive: true });
    appendFileSync(join(dir, "contracts", "SalePhaseBad.sol"), "\n// tampered\n");
    expect(verifyManifest(dir)).toMatchObject({ ok: false, mismatches: ["contracts/SalePhaseBad.sol"] });
    const r = runBenchmark({ contractsDir: join(dir, "contracts"), repoRoot });
    expect(r.complete).toBe(false);
    expect(r.failures.join(" ")).toMatch(/manifest mismatch: contracts\/SalePhaseBad\.sol/);
  });

  it("keeps every archived version of benchmark-b intact, and catches an amendment that alters a frozen file", () => {
    expect(verifyArchivedVersions(benchB)).toEqual({ versions: ["v1", "v2"], ok: true, problems: [] });
    const dir = mkdtempSync(join(tmpdir(), "benchb-v-")); tmp.push(dir);
    cpSync(benchB, dir, { recursive: true });
    appendFileSync(join(dir, "contracts", "AccountingSaleGood.sol"), "\n// altered\n");
    const r = verifyArchivedVersions(dir);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(["v1: contracts/AccountingSaleGood.sol altered or missing", "v2: contracts/AccountingSaleGood.sol altered or missing"]);
  });

  it("checks label lines against the source: inside the function, inside an internal callee, or a problem", () => {
    const text = ["contract C {", "  function a() external { _h(); }", "  function _h() internal {", "    x = 1;", "  }", "  constructor() {", "    y = 2;", "  }", "}"].join("\n");
    const sources = [{ path: "contracts/C.sol", text }];
    const { index } = analyzeSources(sources);
    const L = (fn: string, line: number): Label => ({ file: "contracts/C.sol", contract: "C", function: fn, class: "x", vulnerable: true, line });
    const ok = checkLabels([L("a", 2), L("a", 4), L("constructor", 7)], sources, index);
    expect(ok.ok).toBe(true);
    expect(ok.viaInternalCall).toEqual(["contracts/C.sol:4 C.a -> _h"]);
    const bad = checkLabels([L("a", 9), L("missing", 2)], sources, index);
    expect(bad.ok).toBe(false);
    expect(bad.problems).toHaveLength(2);
  });

  it("separates detector collisions (labelled function, other class) from unscored findings (unlabelled function)", () => {
    const labels: Label[] = [{ file: "f", contract: "C", function: "claim", class: "cross-contract", vulnerable: true, line: 5 }];
    const row = (fn: string, cls: string): FindingRow => ({ file: "f", contract: "C", function: fn, class: cls, line: 5, claim: "c" });
    const r = classifyExtraFindings([row("claim", "reentrancy"), row("claim", "cross-contract"), row("other", "access-control")], labels);
    expect(r.collisions.map((x) => x.class)).toEqual(["reentrancy"]);
    expect(r.unscored.map((x) => x.function)).toEqual(["other"]);
  });
});

describe("AI adjudication (no network, stub gateway)", () => {
  const finding: FindingRow = { file: "contracts/V.sol", contract: "V", function: "withdraw", class: "reentrancy", line: 3, claim: "external call before state update" };
  const cand = (n: number): Candidate[] => Array.from({ length: n }, () => ({ reason: "unscored", finding }));
  const view = buildModelView([{ path: "contracts/V.sol", text: "contract V {\n function withdraw() external {\n  (bool ok,) = msg.sender.call{value: 1}(\"\");\n }\n}" }]);
  const stub = (results: Array<unknown>) => {
    const calls: unknown[] = [];
    const gateway = { execute: async (input: unknown) => { calls.push(input); const r = results.shift(); if (r instanceof Error) throw r; return r; } };
    const pool = { query: async () => ({ rows: [{ input_tokens: 120, output_tokens: 40 }] }) };
    return { calls, ctx: { mode: "gateway" as const, gateway: gateway as never, adapter: { provider: "fake", model: "m", generate: async () => ({ text: "", inputTokens: 0, outputTokens: 0 }) }, pool: pool as never, workflowRunId: "run" } };
  };

  it("routes adjudication to the configured independent-challenge task (tier3)", () => {
    expect(ADJUDICATION_TASK).toBe("independent_challenge");
    expect(MODEL_ROUTING[ADJUDICATION_TASK]).toBe("tier3");
  });

  it("builds a blind prompt for every benchmark-b label: no note, class, BUG marker, Bad/Good name or original identifier", () => {
    const { sources, labels } = loadCorpus(join(benchB, "contracts")) as { sources: Array<{ path: string; text: string }>; labels: Label[] };
    const v = buildModelView(sources);
    for (const l of labels) {
      const probe: FindingRow = { file: l.file, contract: l.contract, function: l.function, class: "probe", line: l.line, claim: `${l.contract}.${l.function} in ${l.file} does something` };
      const p = buildPrompt(probe, v); const all = p.system + "\n" + p.user;
      for (const leak of [l.note!, l.class, "BUG", l.contract, l.file, "Bad", "Good", "secure variant"]) expect(all, `${l.file} leaks ${leak}`).not.toContain(leak);
      expect(p.user).toContain(`line ${l.line}`);
    }
  });

  it("strips comments without moving any line, and leaves string literals alone", () => {
    const src = 'a = 1; // BUG here\n/* multi\n line */ b = "x // not a comment";\n/// natspec\nc();';
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).not.toMatch(/BUG|multi|natspec/);
    expect(out).toContain('"x // not a comment"');
  });

  it("parses only the requested JSON verdict", () => {
    expect(parseVerdict('x {"verdict":"real","severity":"high","rationale":"r"} y')).toEqual({ verdict: "real", severity: "high", rationale: "r" });
    expect(parseVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseVerdict("no json")).toBeNull();
  });

  it("records every candidate unavailable when no model is configured, spending nothing", async () => {
    const r = await adjudicate(cand(2), view, { mode: "unavailable", reason: "no_model_adapter_configured" });
    expect(r.results.map((x) => x.status)).toEqual(["unavailable", "unavailable"]);
    expect(r.spentUsd).toBe(0);
  });

  it("records completed and unparseable results with cost and tokens, and never retries", async () => {
    const { calls, ctx } = stub([
      { status: "completed", text: '{"verdict":"not_real","severity":"none","rationale":"guarded"}', costUsd: 0.0021, tier: "tier3", reservationId: "r1" },
      { status: "completed", text: "I think it is fine", costUsd: 0.001, tier: "tier3", reservationId: "r2" },
    ]);
    const r = await adjudicate(cand(2), view, ctx);
    expect(calls).toHaveLength(2);
    expect(r.results[0]).toMatchObject({ status: "completed", verdict: "not_real", costUsd: 0.0021, inputTokens: 120, outputTokens: 40, reservationId: "r1" });
    expect(r.results[1]).toMatchObject({ status: "unparseable", verdict: null });
    expect(r.spentUsd).toBeCloseTo(0.0031, 8);
  });

  it("stops at a gateway block and records the rest unavailable with the same reason", async () => {
    const { calls, ctx } = stub([{ status: "blocked", reason: "monthly_cap_exceeded", tier: "tier3" }]);
    const r = await adjudicate(cand(3), view, ctx);
    expect(calls).toHaveLength(1);
    expect(r.results.map((x) => x.detail)).toEqual(Array(3).fill("gateway_blocked:monthly_cap_exceeded"));
  });

  it("stops after a provider error (no further reservations are burned)", async () => {
    const { calls, ctx } = stub([new Error("provider_request_timeout")]);
    const r = await adjudicate(cand(3), view, ctx);
    expect(calls).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ status: "failed", detail: "provider_request_timeout" });
    expect(r.results.slice(1).every((x) => x.status === "unavailable" && x.detail!.startsWith("halted_after_provider_error"))).toBe(true);
  });

  it("honours the per-pass call limit", async () => {
    const ok = { status: "completed", text: '{"verdict":"uncertain","severity":"low","rationale":"r"}', costUsd: 0.001, tier: "tier3", reservationId: "r" };
    const { calls, ctx } = stub([ok, ok, ok]);
    const r = await adjudicate(cand(3), view, { ...ctx, maxCalls: 2 });
    expect(calls).toHaveLength(2);
    expect(r.results[2]).toMatchObject({ status: "unavailable", detail: "call_limit_2_reached" });
  });

  it("selects collisions, unscored findings and label-contradicting findings as candidates", () => {
    const r = runBenchmark({ contractsDir: join(benchB, "contracts"), repoRoot });
    expect(selectCandidates(r)).toEqual([]); // benchmark-b produces no findings at all
    const fake = { ...r, deterministic: { ...r.deterministic, collisions: [finding], unscoredFindings: [finding], falsePositives: ["contracts/V.sol:3 withdraw (reentrancy) flagged at line 3"] }, findingsDetail: [finding] };
    expect(selectCandidates(fake).map((c) => c.reason)).toEqual(["collision", "unscored", "false_positive_vs_label"]);
  });
});
