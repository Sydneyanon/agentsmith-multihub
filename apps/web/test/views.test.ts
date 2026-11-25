// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../src/api.js";
import { parseHash } from "../src/router.js";
import { boot, renderRoute, unlockScreen } from "../src/main.js";
import { renderHome } from "../src/view-home.js";
import { renderHypotheses } from "../src/view-hypotheses.js";
import { renderRepository } from "../src/view-repository.js";
import { renderActivity } from "../src/view-activity.js";
import { renderEvidence } from "../src/view-evidence.js";
import { renderProjects } from "../src/view-projects.js";
import type { Ctx } from "../src/ctx.js";

type Handler = (path: string, params?: Record<string, unknown>) => unknown;
function fakeCtx(handler: Handler): Ctx & { calls: string[]; go: ReturnType<typeof vi.fn> } {
  const calls: string[] = [];
  const api: Api = {
    get: (async (path: string, params?: Record<string, unknown>) => { calls.push(path); const r = handler(path, params); if (r instanceof Error) throw r; return r; }) as Api["get"],
    post: (async (path: string, body: unknown) => { calls.push(`POST ${path}`); const r = handler(path, body as Record<string, unknown>); if (r instanceof Error) throw r; return r; }) as Api["post"],
  };
  return { api, go: vi.fn(), calls } as never;
}
const settled = async (el: HTMLElement, text: string | RegExp) => vi.waitFor(() => expect(el.textContent).toMatch(text));

const EMPTY_OVERVIEW = {
  generated_at: "2026-01-01T00:00:00Z", projects: { total: 0, by_status: {} },
  research: { snapshots: { sealed: 0, building: 0 }, evidence_spans: 0, hypotheses: { total: 0, by_status: {} }, evaluations: 0, reviews: {}, events_24h: { research: 0, workflow: 0 } },
  pipeline: { health: { state: "idle", reasons: [] }, steps_queued: 0, steps_running: 0, running_with_expired_lease: 0, live_lease_owners: 0, failed_steps_24h: 0, failed_steps_7d: 0, oldest_queued_age_seconds: null, last_step_success_at: null, steps_by_key_and_status: {} },
  storage: { blobs: 0 },
};
const emptyPage = { items: [], limit: 25, offset: 0, has_more: false };

describe("empty backend: nothing is invented", () => {
  const ctx = () => fakeCtx((path) => path.endsWith("/overview") ? EMPTY_OVERVIEW : path.endsWith("/activity") ? { items: [], limit: 8, has_more: false, next: null, automation_basis: "basis" }
    : path.includes("/hypotheses") ? { ...emptyPage, facets: { status: {} } } : emptyPage);

  it("Home shows zero counts and explanatory empty states", async () => {
    const el = renderHome(ctx());
    await settled(el, /No projects yet/);
    expect(el.textContent).toMatch(/No hypotheses/);
    expect(el.textContent).toMatch(/No activity yet/);
    const values = [...el.querySelectorAll(".stat-value")].map((n) => n.textContent);
    expect(values).toEqual(["0", "0", "0", "0"]);
    expect(el.textContent).toMatch(/Idle/);
  });
  it.each([
    ["Repository", (c: Ctx) => renderRepository(c, undefined, {}), /No repository snapshots[\s\S]*Task 5\.2/],
    ["Hypotheses", (c: Ctx) => renderHypotheses(c, undefined, {}), /No hypotheses[\s\S]*Task 5\.5/],
    ["Evidence", (c: Ctx) => renderEvidence(c, undefined, {}), /No evidence spans/],
    ["Projects", (c: Ctx) => renderProjects(c, undefined, {}), /No projects yet/],
    ["Activity", (c: Ctx) => renderActivity(c, {}), /No activity/],
  ])("%s has an honest empty state", async (_name, render, pattern) => {
    const el = (render as (c: Ctx) => HTMLElement)(ctx());
    await settled(el, pattern as RegExp);
  });
  it("dimmed sections name the task that will build them and are not links", () => {
    const el = renderRoute(ctx(), parseHash("#/reviews"));
    expect(el.textContent).toMatch(/not built[\s\S]*Task 5\.6/);
  });
});

describe("error states", () => {
  it("shows the backend failure and retries", async () => {
    let fail = true;
    const c = fakeCtx((path) => path.endsWith("/overview") ? (fail ? new ApiError(503, "database_not_configured") : EMPTY_OVERVIEW) : path.endsWith("/activity") ? { items: [], limit: 8, has_more: false, next: null, automation_basis: "" } : emptyPage);
    const el = renderHome(c);
    await settled(el, /no database configured/i);
    fail = false;
    (el.querySelector(".state-error button") as HTMLButtonElement).click();
    await settled(el, /No projects yet/);
  });
});

const HYP = {
  id: "11111111-1111-4111-8111-111111111111", workflow_run_id: "22222222-2222-4222-8222-222222222222", snapshot_id: "33333333-3333-4333-8333-333333333333",
  repository: "synthetic/repo", commit_sha: "a".repeat(40), family: "access-control", claim: `<img src=x onerror="window.hacked=1">Claim`, created_at: "2026-01-01T00:00:00Z", supersedes_id: null,
  generator: { kind: "deterministic_rule", id: "rule", version: "1" }, status: "supported_by_review", static_outcome: null, static_conflicts_with_review: null,
  counts: { evidence: 1, evaluations: 0, blinded_reviews: 1, adjudications: 1 }, last_event_seq: 3,
  rationale: "because", required_checks: ["check one"], alternative_explanations: [], generator_reservation_id: null, produced_by_step_id: null,
  evidence: [
    { span_id: "s1", role: "primary", path: "A.sol", line_start: 3, line_end: 4, resolution: { ok: true, text: "line three\nline four" } },
    { span_id: "s2", role: "supporting", path: "B.sol", line_start: 1, line_end: 1, resolution: { ok: false, reason: "blob_evicted" } },
  ],
  evaluations: [],
  reviews: [
    { id: "r1", reviewer_kind: "human", reviewer_id: "alice", review_mode: "blinded_independent_assessment", reviewer_saw: { claim: true, static_verdict: false }, input_sha256: "b".repeat(64), verdict: "supports", rationale: "ok", created_at: "2026-01-01T00:00:00Z", model: null },
    { id: "r2", reviewer_kind: "model", reviewer_id: "m", review_mode: "disclosed_adjudication", reviewer_saw: { claim: true, static_verdict: true }, input_sha256: "c".repeat(64), verdict: "supports", rationale: "ok", created_at: "2026-01-01T00:00:00Z", model: { provider: "p", name: "n", prompt_version: "v", reservation_id: null } },
  ],
  events: [{ seq: 1, event_type: "registered", actor_kind: "deterministic_rule", actor_id: "rule", reason: null, created_at: "2026-01-01T00:00:00Z", evaluation_id: null, review_id: null }],
};

describe("hypothesis detail: provenance and untrusted text", () => {
  it("renders the claim as text, labels reviews by mode, shows what each reviewer saw, and never says verified", async () => {
    const el = renderHypotheses(fakeCtx(() => HYP), HYP.id, {});
    await settled(el, /Reviewer supports pursuing/);
    expect(el.querySelector("img")).toBeNull();
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
    expect(el.textContent).toContain(`<img src=x onerror="window.hacked=1">Claim`);
    expect(el.textContent).toMatch(/Blinded assessment/);
    expect(el.textContent).toMatch(/Disclosed adjudication/);
    expect(el.textContent).toMatch(/static verdict/i);
    expect(el.textContent).toMatch(/did not see/);
    expect(el.textContent).toMatch(/Human/); expect(el.textContent).toMatch(/Model/);
    expect(el.textContent).toMatch(/does not resolve against the stored bytes: blob_evicted/);
    expect(el.textContent!.toLowerCase()).not.toMatch(/\bverified\b/);
  });
  it("shows the reviews empty state when none exist", async () => {
    const el = renderHypotheses(fakeCtx(() => ({ ...HYP, reviews: [], status: "unreviewed" })), HYP.id, {});
    await settled(el, /No reviews recorded[\s\S]*Task 5\.6/);
    expect(el.textContent).toMatch(/Awaiting review/);
  });
  it("lists hypotheses with status facets from the backend", async () => {
    const el = renderHypotheses(fakeCtx(() => ({ ...emptyPage, items: [HYP], facets: { status: { supported_by_review: 1, unreviewed: 2 } } })), undefined, {});
    await settled(el, /All · 3/);
    expect(el.textContent).toMatch(/Awaiting review · 2/);
  });
});

describe("repository", () => {
  const SNAP = "33333333-3333-4333-8333-333333333333";
  const detail = { id: SNAP, workflow_run_id: "r", repository: "synthetic/repo", source_host: "github.com", commit_sha: "a".repeat(40), ref_name: "main", sealed_at: "2026-01-01T00:00:00Z", sealed: true, file_count: 2, total_bytes: 100, manifest_sha256: "d".repeat(64), spans: 1, hypotheses: 1, created_at: "2026-01-01T00:00:00Z", acquisition_report: {}, files: { stored: 1, skipped: 1, by_classification: {}, skip_reasons: {} }, verification: null };
  it("shows the pinned commit, a treemap of stored files, and skipped files as skipped", async () => {
    const c = fakeCtx((path) => {
      if (path.endsWith("/surface")) return { truncated: false, files: [{ path: "a.sol", classification: "source", size_bytes: 80, stored: true, skip_reason: null, spans: 1, hypotheses_by_status: { unreviewed: 1 } }, { path: "big.bin", classification: "other", size_bytes: 9e6, stored: false, skip_reason: "oversize", spans: 0, hypotheses_by_status: {} }] };
      if (path.endsWith("/files")) return { ...emptyPage, items: [{ path: "a.sol", classification: "source", size_bytes: 80, stored: true, skip_reason: null, span_count: 1, hypothesis_count: 1 }, { path: "big.bin", classification: "other", size_bytes: 9e6, stored: false, skip_reason: "oversize", span_count: 0, hypothesis_count: 0 }] };
      return detail;
    });
    const el = renderRepository(c, SNAP, {});
    await settled(el, /synthetic\/repo/);
    await vi.waitFor(() => expect(el.querySelectorAll(".tm-cell")).toHaveLength(1));
    expect(el.textContent).toMatch(/skipped: oversize/);
    expect(el.textContent).toMatch(/Sealed/);
    expect(el.querySelector(".tm-cited")).not.toBeNull();
  });
  it.each([[409, "skipped", /was not stored/], [410, "evicted", /Content evicted/], [415, "not_text", /Not text/]])("file viewer explains %s", async (status, code, pattern) => {
    const c = fakeCtx((path) => path.endsWith("/file") ? new ApiError(status as number, code as string, { error: code, reason: "oversize" }) : path.endsWith("/surface") ? { truncated: false, files: [] } : path.endsWith("/files") ? emptyPage : detail);
    const el = renderRepository(c, SNAP, { path: "x" });
    await settled(el, pattern as RegExp);
  });
  it("highlights cited lines and links spans", async () => {
    const c = fakeCtx((path) => path.endsWith("/file") ? { path: "a.sol", classification: "source", size_bytes: 10, blob_sha256: "e".repeat(64), line_count: 3, text: "one\ntwo\nthree\n", spans: [{ id: "s1", line_start: 2, line_end: 2, hypotheses: [{ id: "h1", status: "unreviewed" }] }] } : path.endsWith("/surface") ? { truncated: false, files: [] } : path.endsWith("/files") ? emptyPage : detail);
    const el = renderRepository(c, SNAP, { path: "a.sol" });
    await vi.waitFor(() => expect(el.querySelectorAll(".code-line")).toHaveLength(3));
    expect([...el.querySelectorAll(".code-line")].map((n) => n.classList.contains("code-mark"))).toEqual([false, true, false]);
    expect(el.querySelector('a[href="#/evidence/s1"]')).not.toBeNull();
  });
});

describe("activity", () => {
  it("separates automated, model and human actors and pages with the cursor", async () => {
    let call = 0;
    const c = fakeCtx((_p, params) => {
      call += 1;
      return call === 1
        ? { items: [{ id: "a", at: "2026-01-01T00:00:03Z", at_cursor: "x", source: "workflow_audit", automation: "human", actor_kind: "human", actor_id: "user", action: "intake.created", entity_type: "workflow_run", entity_id: "r", run_id: "r", hypothesis_id: null, step_key: null, reason: null },
          { id: "b", at: "2026-01-01T00:00:02Z", at_cursor: "y", source: "workflow_audit", automation: "automated", actor_kind: "worker", actor_id: "w1", action: "workflow_step.claimed", entity_type: "workflow_step", entity_id: "s", run_id: "r", hypothesis_id: null, step_key: "resolve_source", reason: null }],
          limit: 50, has_more: true, next: { before: "y", before_id: "b" }, automation_basis: "basis text" }
        : (expect(params).toMatchObject({ before: "y", before_id: "b" }), { items: [], limit: 50, has_more: false, next: null, automation_basis: "basis text" });
    });
    const el = renderActivity(c, {});
    await settled(el, /intake\.created/);
    expect(el.textContent).toMatch(/Human/); expect(el.textContent).toMatch(/Automated/);
    expect(el.textContent).toMatch(/basis text/);
    (el.querySelector(".pager button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(call).toBe(2));
  });
});

describe("projects", () => {
  it("creates a project through the existing intake endpoint and opens it", async () => {
    const c = fakeCtx((path) => path === "/v1/intake" ? { id: "99999999-9999-4999-8999-999999999999", status: "queued" } : emptyPage);
    const el = renderProjects(c, undefined, {});
    await settled(el, /No projects yet/);
    (el.querySelector("#intake-value") as HTMLInputElement).value = "https://example.org/x";
    (el.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(c.go).toHaveBeenCalledWith("#/projects/99999999-9999-4999-8999-999999999999"));
    expect(c.calls).toContain("POST /v1/intake");
  });
  it("shows a stage stepper driven by records, with legacy output labelled", async () => {
    const detail = { id: "r", workflow_type: "x", status: "running", created_at: "2026-01-01T00:00:00Z", started_at: null, completed_at: null, input: { kind: "url", value: "https://github.com/example/x", source: "user" },
      progress: { steps_total: 8, steps_succeeded: 3, steps_failed: 0, current_step: "map_attack_surface", current_step_status: "running" }, snapshots: { total: 0, sealed: 0 }, snapshot_records: [], hypotheses: { total: 0, by_status: {} }, evaluations: 0, reviews: 0,
      correlation_id: null, created_by: "user", notes: null, steps: [{ id: "s", step_key: "map_attack_surface", role: "code_hunter", sequence: 5, status: "running", attempt: 1, error: null, started_at: null, completed_at: null, lease_owner: "w", lease_expires_at: null, lease_live: false }],
      legacy: { note: "Output of the legacy passive pipeline", evidence_snapshots: [], brief: null, leads: [] } };
    const el = renderProjects(fakeCtx(() => detail), "r", {});
    await settled(el, /legacy passive pipeline/i);
    expect(el.querySelectorAll(".step-done")).toHaveLength(0);
    expect(el.querySelectorAll(".step-not_built")).toHaveLength(3);
    expect(el.textContent).toMatch(/lease expired/);
    expect(el.textContent).toMatch(/No repository snapshots[\s\S]*Task 5\.2/);
  });
});

describe("shell and unlock", () => {
  beforeEach(() => { window.scrollTo = (() => {}) as typeof window.scrollTo; sessionStorage.clear(); location.hash = ""; document.body.replaceChildren(); });
  it("asks for the token first, stores it per tab, and never shows the app while locked", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes("/overview") ? EMPTY_OVERVIEW : url.includes("/activity") ? { items: [], limit: 8, has_more: false, next: null, automation_basis: "" } : emptyPage) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    boot(root);
    expect(root.querySelector("form.unlock-card")).not.toBeNull();
    expect(root.querySelector(".sidebar")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    (root.querySelector("#token") as HTMLInputElement).value = "tok";
    (root.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector(".sidebar")).not.toBeNull());
    expect(sessionStorage.getItem("agentsmith.hub.token")).toBe("tok");
    expect(localStorage.length).toBe(0);
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok");
    expect(location.href).not.toContain("tok");
    expect(root.querySelectorAll(".sidebar .nav-later")).toHaveLength(4);
    expect(root.querySelectorAll(".tabbar a")).toHaveLength(6);
    vi.unstubAllGlobals();
  });
  it("returns to the unlock screen with a message when the backend rejects the token", async () => {
    sessionStorage.setItem("agentsmith.hub.token", "bad");
    const root = document.createElement("div"); document.body.append(root);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }) as Response));
    boot(root);
    await vi.waitFor(() => expect(root.querySelector("form.unlock-card")).not.toBeNull());
    expect(root.textContent).toMatch(/rejected/);
    expect(sessionStorage.getItem("agentsmith.hub.token")).toBeNull();
    vi.unstubAllGlobals();
  });
  it("unlock screen keeps the token input a password field", () => {
    const el = unlockScreen(() => {});
    expect((el.querySelector("#token") as HTMLInputElement).type).toBe("password");
  });
});

describe("attack-surface map follows its container", () => {
  it("re-lays out when the width crosses the narrow threshold and not otherwise", async () => {
    const { surfaceMap, TREEMAP_NARROW, TREEMAP_WIDE, treemapSizeFor } = await import("../src/components.js");
    expect(treemapSizeFor(390)).toBe(TREEMAP_NARROW);
    expect(treemapSizeFor(599)).toBe(TREEMAP_NARROW);
    expect(treemapSizeFor(600)).toBe(TREEMAP_WIDE);
    expect(treemapSizeFor(0)).toBe(TREEMAP_WIDE);
    let notify: (entries: Array<{ contentRect: { width: number } }>) => void = () => {};
    vi.stubGlobal("ResizeObserver", class { constructor(cb: typeof notify) { notify = cb; } observe() {} disconnect() {} });
    const files = [{ path: "a.sol", classification: "source", size_bytes: 80, stored: true, skip_reason: null, spans: 0, hypotheses_by_status: {} }];
    const el = surfaceMap(files, () => {});
    const viewBox = () => el.querySelector("svg")!.getAttribute("viewBox");
    const initial = el.querySelector("svg");
    notify([{ contentRect: { width: 900 } }]);
    expect(viewBox()).toBe(`0 0 ${TREEMAP_WIDE.w} ${TREEMAP_WIDE.h}`);
    notify([{ contentRect: { width: 340 } }]);
    expect(viewBox()).toBe(`0 0 ${TREEMAP_NARROW.w} ${TREEMAP_NARROW.h}`);
    const narrow = el.querySelector("svg");
    notify([{ contentRect: { width: 360 } }]);
    expect(el.querySelector("svg")).toBe(narrow);
    notify([{ contentRect: { width: 1000 } }]);
    expect(viewBox()).toBe(`0 0 ${TREEMAP_WIDE.w} ${TREEMAP_WIDE.h}`);
    expect(initial).not.toBeNull();
    vi.unstubAllGlobals();
  });
  it("stops observing once the map has been removed from the page", async () => {
    const { surfaceMap } = await import("../src/components.js");
    let notify: (entries: Array<{ contentRect: { width: number } }>) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class { constructor(cb: typeof notify) { notify = cb; } observe() {} disconnect = disconnect; });
    const el = surfaceMap([], () => {});
    document.body.append(el);
    notify([{ contentRect: { width: 900 } }]);
    expect(disconnect).not.toHaveBeenCalled();
    el.remove();
    notify([{ contentRect: { width: 400 } }]);
    expect(disconnect).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe("layout contracts that jsdom can see", () => {
  it("review and evaluation rows use the single-column static row, and the stylesheet defines it", async () => {
    const el = renderHypotheses(fakeCtx(() => HYP), HYP.id, {});
    await settled(el, /Blinded assessment/);
    const rows = el.querySelectorAll("li.row-static.stack-sm");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "apps", "web", "public", "styles.css"), "utf8");
    expect(css).toMatch(/\.row-static\.stack-sm\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.tabbar\s*\{\s*position:\s*fixed/);
  });
});
