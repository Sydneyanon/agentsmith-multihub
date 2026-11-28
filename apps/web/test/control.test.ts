// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api.js";
import { ApiError } from "../src/api.js";
import { controlBody, engineSentence, renderControl } from "../src/view-control.js";
import { livePanel } from "../src/live.js";
import { architectureBody } from "../src/view-architecture.js";
import type { EngineStatus, ProjectSummary } from "../src/types.js";
import type { Ctx } from "../src/ctx.js";

const IDLE: EngineStatus = {
  version: "engine-status/1", generated_at: "2026-11-26T10:00:00.000Z", data_kind: "production",
  build: { commit: "a".repeat(40), image: "registry.fly.io/agentsmith-hub:hub-aaaaaaaaaaaa", built_at: "2026-11-26T09:00:00Z", source: "build-info.json" },
  schema: { ledger_readable: true, applied: ["0001_initial.sql"], expected: ["0001_initial.sql", "0008_discovery.sql"], missing: ["0008_discovery.sql"], unknown: [], discovery_installed: false },
  engine: { state: "idle", reasons: [] },
  workers: { connected: [], live_lease_owners: [], presence_basis: "basis", running: [] },
  queue: { totals: { queued: 0, running_live: 0, running_expired_lease: 0, failed_24h: 0 }, order_basis: "claim order (oldest first); no priority engine runs in this deployment", by_lane: [] },
  runs: [], last: { run: null, step_success: null, failure: null },
  stages: {
    discovery: { installed: false, reason: "migration 0008 (discovery) is not applied in this database" },
    acquisition: { snapshots_sealed: 0, snapshots_building: 0 }, protocol_mapping: { stored_models: 0, schema: "protocol-model/3 (P1–P3)" },
    hypotheses: { total: 0, by_status: {}, note: "hypotheses are leads, not findings" }, evidence_spans: 0,
    validation: { evaluations: 0, blinded_reviews: 0 }, adjudication: { disclosed_adjudications: 0, human_confirmed_findings: null, note: "no human-review API" },
    memory: { installed: true, built: false, note: "experience memory is not built" },
  },
};
const project = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: "p1", workflow_type: "repository_research", status: "succeeded", created_at: "2026-11-20T10:00:00Z", started_at: null, completed_at: "2026-11-20T11:00:00Z",
  input: { kind: "repository", value: "acme/vault", source: "operator" }, progress: { steps_total: 4, steps_succeeded: 4, steps_failed: 0, current_step: null, current_step_status: null },
  snapshots: { total: 1, sealed: 1 }, hypotheses: { total: 2, by_status: {} }, evaluations: 0, reviews: 0, ...over,
});
const ctx = (handler: (path: string) => unknown = () => ({})): Ctx => ({ api: { get: (async (p: string) => { const r = handler(p); if (r instanceof Error) throw r; return r; }) as Api["get"], post: (async () => ({})) as Api["post"] }, go: vi.fn() });
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe("Control Room (CR1)", () => {
  it("idle is said plainly: no fabricated activity, no lanes, no worker; leads are never findings", () => {
    const el = controlBody(ctx(), IDLE, []);
    expect(engineSentence(IDLE)).toBe("Engine idle. No worker is connected. Nothing is queued or running.");
    expect(el.textContent).toContain("Engine idle. No worker is connected.");
    expect(el.textContent).toContain("No research runs");
    expect(el.textContent).toContain("No worker is connected");
    expect(el.textContent).toContain("Discovery is not installed here");
    expect(el.textContent).toContain("0008_discovery.sql"); // shipped but not applied is shown
    expect(el.textContent).toContain("No confirmed finding is recorded");
    expect(el.textContent).not.toMatch(/\bverified\b|\bconfirmed vulnerabilit/i);
    expect(el.querySelector(".data-kind")).toBeNull(); // production: a small chip, no banner
  });

  it("synthetic data carries a permanent alert banner, and lanes are marked simulated", () => {
    const s: EngineStatus = { ...IDLE, data_kind: "synthetic", runs: [{ workflow_type: "repository_research", lane: "structural", status: "succeeded", count: 1, last_created_at: "2026-11-20T10:00:00Z" }] };
    const el = controlBody(ctx(), s, [project({})]);
    expect(el.querySelector(".data-kind")!.getAttribute("role")).toBe("alert");
    expect(el.querySelector(".data-kind")!.textContent).toMatch(/SYNTHETIC DATA/);
    expect(el.querySelector(".lane")!.textContent).toContain("simulated");
  });

  it("an expired lease is never shown as running; a connected idle worker is shown idle with its switch", () => {
    const s: EngineStatus = { ...IDLE, engine: { state: "attention", reasons: ["1 running step(s) have an expired lease: no worker is renewing them"] },
      workers: { connected: [{ worker_id: "intake-a", structural_analysis: true, connections: 1 }], live_lease_owners: [], presence_basis: "b",
        running: [{ worker: "intake-gone", workflow_type: "repository_research", step_key: "analyze_structure", live: false, lease_expires_at: "2026-11-26T09:00:00Z" }] },
      queue: { ...IDLE.queue, totals: { queued: 0, running_live: 0, running_expired_lease: 1, failed_24h: 0 } } };
    const el = controlBody(ctx(), s, []);
    const workers = el.querySelector(".area-workers")!.textContent!;
    expect(workers).toContain("intake-a"); expect(workers).toContain("structural analysis ON"); expect(workers).toContain("no step leased: idle");
    expect(workers).toContain("Lease expired"); expect(workers).not.toMatch(/Running/);
    expect(el.textContent).toContain("expired lease");
  });

  it("structural and legacy research are separate lanes; finished runs are marked historical with an absolute time", () => {
    const s: EngineStatus = { ...IDLE, engine: { state: "working", reasons: [] },
      queue: { ...IDLE.queue, totals: { queued: 1, running_live: 1, running_expired_lease: 0, failed_24h: 0 }, by_lane: [
        { workflow_type: "link_or_idea_intake", label: "Legacy intake (link_or_idea_intake)", kind: "legacy", steps: [{ step_key: "identify_project", queued: 1, running_live: 0, running_expired_lease: 0, awaiting_approval: 0, succeeded: 0, failed: 0, failed_24h: 0, oldest_queued_age_seconds: 30 }] },
        { workflow_type: "repository_research", label: "Structural repository research (T-149)", kind: "structural", steps: [{ step_key: "analyze_structure", queued: 0, running_live: 1, running_expired_lease: 0, awaiting_approval: 0, succeeded: 2, failed: 0, failed_24h: 0, oldest_queued_age_seconds: null }] }] },
      runs: [{ workflow_type: "repository_research", lane: "structural", status: "succeeded", count: 1, last_created_at: "x" }, { workflow_type: "link_or_idea_intake", lane: "legacy", status: "running", count: 1, last_created_at: "x" }] };
    const el = controlBody(ctx(), s, [project({}), project({ id: "p2", workflow_type: "link_or_idea_intake", status: "running", completed_at: null, progress: { steps_total: 8, steps_succeeded: 1, steps_failed: 0, current_step: "identify_project", current_step_status: "queued" } })]);
    const lanes = [...el.querySelectorAll(".lane")];
    expect(lanes.map((l) => l.className)).toEqual(["lane lane-structural", "lane lane-legacy"]); // structural first
    expect(lanes[0]!.textContent).toContain("historical · finished 2026-11-20 11:00:00 UTC");
    expect(lanes[0]!.textContent).toContain("1 running");
    expect(lanes[1]!.textContent).toContain("retirement (T-149 S3) awaits approval");
    expect(engineSentence(s)).toBe("1 step running now (live lease). No worker is connected. 1 queued.");
  });

  it("refreshes in place; a failed refresh keeps the last view but says it is stale, never live", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));
    let n = 0;
    const load = vi.fn(async () => { n += 1; if (n === 3) throw new ApiError(0, "network_error"); return { generated_at: `2026-11-26T10:00:${String(n).padStart(2, "0")}Z`, n }; });
    const el = livePanel(load, (d) => document.createTextNode(`render ${d.n}`), { intervalMs: 1000, generatedAt: (d) => d.generated_at });
    document.body.append(el);
    await vi.waitFor(() => expect(el.textContent).toContain("render 1"));
    expect(el.querySelector(".freshness")!.className).toContain("is-live");
    await vi.advanceTimersByTimeAsync(1000); await vi.waitFor(() => expect(el.textContent).toContain("render 2"));
    await vi.advanceTimersByTimeAsync(1000); await vi.waitFor(() => expect(el.textContent).toContain("Stale since"));
    expect(el.textContent).toContain("render 2"); expect(el.textContent).toContain("Last refresh failed: Cannot reach the backend");
    expect(el.querySelector(".freshness")!.className).toContain("is-stale");
    el.remove(); const calls = load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(load.mock.calls.length).toBeLessThanOrEqual(calls + 1); // stops once removed from the page
  });

  it("loads only the engine status and the project list (no write, no discovery poll when discovery is absent)", async () => {
    const calls: string[] = [];
    const c = ctx((p) => { calls.push(p); return p === "/v1/engine/status" ? IDLE : { items: [], limit: 50, offset: 0, has_more: false }; });
    const el = renderControl(c); document.body.append(el);
    await vi.waitFor(() => expect(el.textContent).toContain("Engine idle"));
    expect(calls.sort()).toEqual(["/v1/engine/status", "/v1/research/projects"]);
  });

  it("the P1–P3 architecture view says when no model exists, and labels open writes as facts, not findings", () => {
    expect(architectureBody({ available: false, reason: "no protocol model is recorded for this snapshot's analysis step" }).textContent).toContain("No protocol model for this snapshot");
    const el = architectureBody({ available: true, model_sha256: "b".repeat(64), builder: "protocol-model/3 solidity-p3/2", unknowns: [], components: [{
      id: "Factory", kind: "contract", file: "F.sol", lines: "1-20", content_sha256: "c", state_roles: [],
      authority: { roles: [], open_authority_writes: ["Factory.retire() writes owner with no caller-side check @ F.sol:9"], callee_side_checks: [], factory_paths: [], proxy: [], initialisers: [], assumptions: [], unresolved: [] },
      entry_points: [{ fn: "Factory.retire()", guarded: false, writes: ["owner"], external_calls: [], unresolved_calls: [] }] }] });
    expect(el.textContent).toContain("1 open authority writes (facts of the code, not findings)");
    expect(el.textContent).toContain("no caller-side check");
  });
});
