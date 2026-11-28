// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api.js";
import type { Ctx } from "../src/ctx.js";
import { parseHash } from "../src/router.js";
import { renderRoute } from "../src/main.js";
import { confidenceCard, metricRow, opsBody, outcomeCard, panelCard, percent, renderOperations, systemCard, timelineList } from "../src/view-operations.js";
import type { ApexShadowView, Metric, ProgressPanel, RunProgress, TimelineItem } from "../src/types.js";

const M = (over: Partial<Metric>): Metric => ({ key: "k", label: "files stored", numerator: 3, denominator: 4, unit: "files", kind: "processing", source: "repo_snapshot_files", measurable: true, basis: "verified", ...over });
const noIssues = { errors: [], retries: [], expired_leases: [], lease_exhausted: 0, abstentions: [], refusals: { total: 0, quota: 0, by_code: {} }, blockers: [] };
const P = (over: Partial<ProgressPanel>): ProgressPanel => ({ id: "acquisition", title: "Repository acquisition and verification", state: "succeeded", state_basis: "step succeeded", availability: null, processing: [], coverage: [], counts: [], activity: [], issues: noIssues, notes: [], ...over });
const DOC: RunProgress = {
  version: "run-progress/1", generated_at: "2026-11-28T10:00:00.000Z",
  run: { id: "r1", workflow_type: "repository_research", status: "running", repository: "acme/usx-like", ref: "a".repeat(40), created_at: "2026-11-28T09:00:00Z", started_at: null, completed_at: null, snapshot_id: "s1", bounty_scope: { programme: "sherlock:1", in_scope_paths: 20 } },
  stages: [{ step_key: "acquire_repository", status: "succeeded", attempt: 1, elapsed_seconds: 12, lease_live: false, started_at: null, completed_at: null }, { step_key: "analyze_structure", status: "running", attempt: 1, elapsed_seconds: 4, lease_live: true, started_at: null, completed_at: null }],
  panels: [
    P({ id: "overall", title: "Overall run", state: "running", processing: [M({ key: "stages_succeeded", numerator: 1, denominator: 4, unit: "stages" })] }),
    P({ processing: [M({ numerator: 412, denominator: 412 })], coverage: [M({ key: "d2", kind: "coverage", numerator: null, denominator: null, measurable: false, note: "not verified by the API against GitHub" })] }),
    P({ id: "apex", title: "APEX exploration", state: "experimental", availability: { state: "experimental", reason: "experimental, off by default, not in the pipeline", evidence: "capability registry" } }),
    P({ id: "reproduction", title: "Reproduction", state: "unavailable", availability: { state: "unavailable", reason: "not installed here: forge 1.5.1 (AGENTSMITH_FORGE_BIN)", evidence: "capability availability" },
      counts: [M({ key: "reproductions", label: "reproductions recorded", numerator: 0, denominator: null, measurable: false })] }),
  ],
  confidence: { available: true, total: 5, distribution: [{ verdict: "refuted", count: 1 }, { verdict: "open", count: 3 }, { verdict: "supported_cross_family", count: 1 }], source: "dossier", note: "",
    corroboration: { same_family: M({ key: "same", kind: "confidence", numerator: 2, denominator: null, measurable: false }), cross_family: M({ key: "cross", kind: "confidence", numerator: 1, denominator: null, measurable: false }) } },
  outcome: { available: true, no_leads: false, note: "0 confirmed is the true count", counts: [M({ key: "confirmed", label: "confirmed", kind: "outcome", numerator: 0, denominator: null, measurable: false }), M({ key: "open", label: "open", kind: "outcome", numerator: 4, denominator: null, measurable: false })] },
};
afterEach(() => { document.body.replaceChildren(); });

describe("live operations view: honest numbers", () => {
  it("a percentage appears only for a measurable metric; otherwise the count and 'not measurable'", () => {
    expect(percent(M({}))).toBe(75);
    expect(percent(M({ numerator: 999, denominator: 1000 }))).toBe(99); // floored: an unfinished bar never reads 100%
    const unmeasurable = metricRow(M({ numerator: 7, denominator: null, measurable: false }));
    expect(unmeasurable.textContent).not.toMatch(/%/);
    expect(unmeasurable.textContent).toMatch(/7 files · not measurable/);
    expect(unmeasurable.querySelector(".meter")).toBeNull();
    const unrecorded = metricRow(M({ numerator: null, denominator: null, measurable: false }));
    expect(unrecorded.textContent).toMatch(/not recorded/); expect(unrecorded.textContent).not.toMatch(/%|\b0\b/);
    const measured = metricRow(M({}));
    expect(measured.textContent).toMatch(/75% 3 \/ 4 files/); expect(measured.textContent).toMatch(/remaining: 1 files/);
    expect(measured.querySelector(".meter-fill")!.getAttribute("style")).toMatch(/width: ?75%/);
  });

  it("a complete processing bar reads 'processed', never 'understood'; coverage is drawn differently and labelled", () => {
    const body = opsBody(DOC);
    const done = body.querySelector('[data-key="k"]')!;
    expect(done.textContent).toMatch(/100% 412 \/ 412 files · processed/);
    expect(body.textContent).not.toMatch(/(?<!not |never )understood/i);
    expect(body.querySelector(".meter-processing")).not.toBeNull();
    const cov = metricRow(M({ kind: "coverage" }));
    expect(cov.querySelector(".meter-coverage")).not.toBeNull(); expect(cov.querySelector(".meter-processing")).toBeNull();
    expect(cov.querySelector(".kind-tag")!.textContent).toBe("coverage");
  });

  it("unavailable and experimental stages show their reason, never 0%", () => {
    const body = opsBody(DOC);
    const repro = body.querySelector(".ops-reproduction")!;
    expect(repro.textContent).toMatch(/Unavailable: not installed here: forge/);
    expect(repro.textContent).not.toMatch(/0%/); expect(repro.querySelector(".meter")).toBeNull();
    const apex = body.querySelector(".ops-apex")!;
    expect(apex.textContent).toMatch(/Experimental: experimental, off by default, not in the pipeline/); expect(apex.textContent).not.toMatch(/%/);
  });

  it("worker-reported numbers are labelled so; API-derived counts are labelled verified", () => {
    expect(metricRow(M({ basis: "worker_reported" })).textContent).toMatch(/reported by the worker/);
    expect(metricRow(M({})).textContent).toMatch(/verified/);
  });

  it("'running' only with a live lease: an expired lease says so, and progress without a total is not measurable", () => {
    const stalled = panelCard(P({ state: "stalled", activity: [{ step_id: "x", step_key: "acquire_repository", status: "running", attempt: 1, started_at: "2026-11-28T09:00:00Z", completed_at: null, elapsed_seconds: 60, lease_owner: "w", lease_expires_at: "2026-11-28T09:01:00Z", lease_live: false, running_live: false, latest_progress: null, progress_records: 0 }] }));
    expect(stalled.textContent).toMatch(/Lease expired/); expect(stalled.textContent).toMatch(/lease EXPIRED/); expect(stalled.textContent).not.toMatch(/Running \(live lease\)/);
    const live = panelCard(P({ state: "running", activity: [{ step_id: "x", step_key: "acquire_repository", status: "running", attempt: 1, started_at: "2026-11-28T09:00:00Z", completed_at: null, elapsed_seconds: 5, lease_owner: "w", lease_expires_at: "2026-11-28T09:02:00Z", lease_live: true, running_live: true,
      latest_progress: { phase: "writing_manifest", done: 120, total: 431, unit: "manifest_rows", at: "2026-11-28T09:00:04Z", reported_by: "worker", via: "worker_api" }, progress_records: 3 }] }));
    expect(live.textContent).toMatch(/Running \(live lease\)/); expect(live.textContent).toMatch(/writing manifest 120 of 431 manifest rows/); expect(live.textContent).toMatch(/reported by the worker/);
  });

  it("confidence is a distribution of counts, never a single percentage; outcomes are counts and 0 confirmed is plain", () => {
    const c = confidenceCard(DOC);
    expect(c.textContent).not.toMatch(/%/);
    expect(c.querySelectorAll(".dist-seg")).toHaveLength(3);
    expect(c.textContent).toMatch(/refuted1/); expect(c.textContent).toMatch(/open3/);
    const o = outcomeCard(DOC);
    expect(o.textContent).not.toMatch(/%/);
    expect(o.querySelector(".outcome-tile")!.textContent).toBe("0confirmed");
    const none = outcomeCard({ ...DOC, outcome: { available: true, no_leads: true, note: "No leads. That is NOT evidence that the code is free of vulnerabilities.", counts: [] } });
    expect(none.textContent).toMatch(/NOT evidence/);
  });

  it("the timeline renders stored payloads on expansion and keeps rows open across refreshes", () => {
    const items: TimelineItem[] = [{ id: "audit:000000000007", at: "2026-11-28T09:00:04Z", source: "audit_event", category: "progress", action: "workflow_step.progress", actor: "worker-token:abc", step_key: "acquire_repository", step_id: "x", hypothesis_id: null, run_id: "r1",
      summary: "writing_manifest: 120 of 431 manifest_rows (reported by the worker)", reason: null, payload: { phase: "writing_manifest", done: 120 } }];
    const open = new Set<string>(["audit:000000000007"]);
    const el = timelineList(items, open);
    const d = el.querySelector("details")!;
    expect(d.open).toBe(true);
    expect(d.querySelector("pre")!.textContent).toContain('"done": 120');
    d.open = false; d.dispatchEvent(new Event("toggle")); expect(open.has("audit:000000000007")).toBe(false);
    expect(timelineList([], open).textContent).toMatch(/No events/);
  });

  it("the system view shows each component's state with its evidence", () => {
    const el = systemCard({ generated_at: "2026-11-28T10:00:00Z", rules: { operational: "used successfully" }, components: [{ id: "apex", label: "APEX exploration", state: "experimental", evidence: [{ source: "capability registry", detail: "no capability declared" }] }, { id: "source:hackenproof", label: "Source: HackenProof", state: "blocked", evidence: [{ source: "bounty_source_checks", detail: "last check failed: HTTP 403" }] }] });
    expect(el.textContent).toMatch(/APEX exploration.*no capability declared.*Experimental/);
    expect(el.textContent).toMatch(/HackenProof.*HTTP 403.*Blocked/);
  });

  it("the route loads the latest run by default and polls only the read endpoints", async () => {
    const calls: string[] = [];
    const ctx: Ctx = { go: vi.fn(), api: { post: (async () => ({})) as Api["post"], get: (async (path: string) => {
      calls.push(path);
      if (path === "/v1/research/projects") return { items: [{ id: "r1", workflow_type: "repository_research", status: "running", created_at: "2026-11-28T09:00:00Z", input: { value: "acme/usx-like" } }, { id: "r0", workflow_type: "link_or_idea_intake", status: "succeeded", created_at: "2026-11-27T09:00:00Z", input: { value: "x" } }], limit: 50, offset: 0, has_more: false };
      if (path.endsWith("/progress")) return DOC;
      if (path === "/v1/research/timeline") return { items: [], limit: 60, has_more: false, next: null, decisions: { available: false, note: "migration 0010 is not applied" }, sources: ["audit_events"] };
      if (path === "/v1/engine/components") return { generated_at: "2026-11-28T10:00:00Z", rules: {}, components: [] };
      throw new Error(`unexpected ${path}`);
    }) as Api["get"] } };
    const el = renderOperations(ctx, {}); document.body.append(el);
    await vi.waitFor(() => expect(el.textContent).toMatch(/Overall run/));
    await vi.waitFor(() => expect(el.textContent).toMatch(/0010/));
    expect(calls).toContain("/v1/research/runs/r1/progress");
    expect((el.querySelector("#ops-run") as HTMLSelectElement).value).toBe("r1");
    expect(el.querySelectorAll("#ops-run option")).toHaveLength(1); // only repository_research runs are offered
    expect(renderRoute(ctx, parseHash("#/operations?run=r1")).className).toContain("view-operations");
  });
});

describe("APEX panel: shadow results, never evidence", () => {
  const L = "APEX shadow: unvalidated, not evidence";
  const cap = <T>(items: T[]) => ({ items, total: items.length, truncated: 0 });
  const SHADOW: ApexShadowView = {
    label: L, measurement_only: true, status: "completed", records: 1, refusal: null, failure: null,
    record: { audit_event_id: "42", at: "2026-11-28T10:00:00Z", reported_by: "worker", via: "worker_api", report_sha256: "e".repeat(64), recorder: { checked: ["lease"], refused_worker_status: null } },
    provenance: { apex_version: "apex-shadow/1", engine_generator: "apex-state-explorer@0-prototype", strategy: "deep", snapshot_id: "s1", commit_sha: "9e972566deb59b4d2c499015c2557c5e5f236e3c", manifest_sha256: "d".repeat(64), repository: "scroll-tech/usx-contracts",
      approved_by: "owner", approved_commit: "9e972566deb59b4d2c499015c2557c5e5f236e3c", input_files: [{ path: "src/USX.sol", sha256: "a".repeat(64), bytes: 900 }], worker: { mode: "remote", build_commit: null }, compute_limits: {}, shadow_limits: {} },
    engine: { generator: "apex-state-explorer@0-prototype", strategy: "deep", options: {} }, cost: { transitions_requested: 45000, transitions_interpreted: 6700, wall_ms: 800, peak_rss_bytes: 1.3e8 },
    contracts: cap([{ contract: "TreasuryDiamond", file: "src/TreasuryDiamond.sol", status: "explored", reason: null, entry_points: { total: 4, completed: 3 }, statements: { total: 9, reached: 7 }, frontier_dropped: 0 }]),
    not_deployable: cap([{ contract: "IUSX", file: "src/interfaces/IUSX.sol", kind: "interface" }]),
    abstentions_by_feature: { "external-call": 1, other: 1 },
    abstentions: cap([{ contract: "StakedUSXOFT", function: "burnToBridge", feature: "external-call", file: "src/oft/StakedUSXOFT.sol", line: 26, at: "src/oft/StakedUSXOFT.sol:26", why: "a call to a non-actor", phase: "honest", located_by: "interpreter" },
      { contract: "USXOFT", function: "constructor", feature: "other", file: "src/oft/USXOFT.sol", line: 21, at: "src/oft/USXOFT.sol:21", why: "constructor parameters", phase: "deployment", located_by: "definition" }]),
    suppressions: { total: 3, by_kind: { "narrow-integer": 3 }, examples: cap([{ contract: "BridgedToken", candidate: "conservation:totalSupply=sum(balanceOf)", phase: "honest", breaking_function: "burnFrom", sequence: [{ actor: "owner0", call: "burnFrom(owner0, 1e18)", value: "0" }], approximations: [{ kind: "narrow-integer", at: "src/BridgedToken.sol:26", what: "uint8 write" }] }]) },
    withheld: cap([{ contract: "BridgedToken", candidate: "conservation:totalSupply=sum(balanceOf)", why: "only-suppressed-counterexamples", kinds: ["narrow-integer"] }]),
    candidates: cap([{ contract: "USX", id: "conservation:totalSupply=sum(balanceOf)", kind: "conservation", statement: "s", decision: "accepted", rule: "established", reason: "established: 340 transitions" },
      { contract: "StakedUSXOFT", id: "conservation:totalSupply=sum(balanceOf)", kind: "conservation", statement: "s", decision: "rejected", rule: "vacuous", reason: "never exercised by honest sequences: vacuous" }]),
    reclassified: cap([]),
    would_be_hypotheses: cap([{ contract: "MockAssetManager", label: "APEX-generated, unvalidated", claim: "MockAssetManager.sweep: the sequence owner0:deposit() -> owner0:sweep(1e18) violates the inferred invariant", candidate: "c", breaking_function: "sweep", minimised: [{ actor: "owner0", call: "deposit()", value: "1" }], counterexample: [] }]),
    overlaps: { summary: { same_line: 0, same_function: 1, same_file: 2 }, leads_considered: 4, note: "neither support nor contradiction", items: [], truncated: 0 },
    parse_problems: [], in_scope_paths_missing: [],
  };
  const metricsOf = [M({ key: "apex_contracts_explored", label: `${L}: deployable in-scope contracts explored`, kind: "coverage", numerator: 7, denominator: 14, unit: "contracts", basis: "worker_reported", note: L }),
    M({ key: "apex_abstentions", label: `${L}: abstentions (unsupported feature, with file:line)`, kind: "coverage", numerator: 2, denominator: null, measurable: false, unit: "abstentions", basis: "worker_reported", note: L })];

  it("shows coverage num/denom, abstentions by feature with file:line, suppressions, candidates, cost and provenance, all labelled", () => {
    const el = panelCard(P({ id: "apex", title: "APEX exploration (shadow, measurement only)", state: "recorded", availability: { state: "experimental", reason: `${L}. enabled for this run only`, evidence: "audit_events" }, coverage: [metricsOf[0]!], counts: [metricsOf[1]!], shadow: SHADOW }));
    const t = el.textContent!;
    expect(el.classList.contains("ops-apex-shadow")).toBe(true);
    expect(el.querySelector(".shadow-banner")!.textContent).toBe(L);
    expect(t).toMatch(/50% 7 \/ 14 contracts/); // coverage with an explicit numerator and denominator
    for (const row of el.querySelectorAll(".metric")) { expect(row.textContent).toContain(L); expect(row.textContent).toMatch(/reported by the worker/); }
    expect(t).toMatch(/StakedUSXOFT\.burnToBridge external-call src\/oft\/StakedUSXOFT\.sol:26/);
    expect(t).toMatch(/located at the definition/);
    expect(t).toMatch(/suppressed counterexamples 3 \(narrow-integer 3\) · 1 candidates withheld by the gate/);
    expect(t).toMatch(/candidate invariants rejected, with reasons \(1\).*vacuous never exercised by honest sequences/);
    expect(t).toMatch(/APEX-generated, unvalidated MockAssetManager\.sweep/);
    expect(t).toMatch(/not stored as hypotheses/);
    expect(t).toMatch(/apex-shadow\/1 · engine apex-state-explorer@0-prototype · strategy deep/);
    expect(t).toMatch(/approvedowner for commit 9e972566deb5/);
    expect(t).toMatch(/same line 0 · same function 1 · same file 2/);
    // every section heading carries the label; nothing reads as a finding or a confirmation
    for (const s of el.querySelectorAll(".shadow-list summary")) expect(s.textContent).toContain(L);
    expect(t).not.toMatch(/\bconfirmed\b|\bfinding found\b|\bvulnerab/i);
  });

  it("a refused or failed shadow says so, as a shadow outcome, never as a run failure", () => {
    const refused = panelCard(P({ id: "apex", state: "recorded", shadow: { ...SHADOW, status: "refused", refusal: { code: "not_the_approved_commit", reason: "the run is pinned to main" } } }));
    expect(refused.textContent).toMatch(/refused not_the_approved_commit: the run is pinned to main/);
    const failed = panelCard(P({ id: "apex", state: "recorded", shadow: { ...SHADOW, status: "failed", failure: { code: "wall_limit", message: "the analysis exceeded 330000 ms", wall_ms: 330000 } } }));
    expect(failed.textContent).toMatch(/shadow failure \(not a run failure\) wall_limit/);
  });

  it("a run without shadow output shows 'experimental, not enabled for this run' and no number", () => {
    const el = panelCard(P({ id: "apex", title: "APEX exploration", state: "experimental", availability: { state: "experimental", reason: "experimental, not enabled for this run", evidence: "workflow_steps: 0" } }));
    expect(el.textContent).toMatch(/Experimental: experimental, not enabled for this run/);
    expect(el.textContent).not.toMatch(/%/); expect(el.querySelector(".apex-shadow")).toBeNull(); expect(el.querySelector(".metric")).toBeNull();
  });
});
