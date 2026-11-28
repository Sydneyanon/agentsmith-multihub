import { h } from "./dom.js";
import { badge, chip, empty, errorState, loadInto, loading, mono, panel } from "./components.js";
import { duration, exactTime, relativeTime, shortHash } from "./format.js";
import { livePanel } from "./live.js";
import { link, linkWith } from "./router.js";
import type { Ctx } from "./ctx.js";
import type { Metric, Page, ProgressPanel, ProjectSummary, RunProgress, StepActivity, SystemComponents, TimelineItem, TimelinePage } from "./types.js";
import { RUN_STATUS, type Tone, type Word, word } from "./vocab.js";

/**
 * Live operations (docs/research-runs/live-operations-dashboard-spec.md). Every number on this page comes from
 * GET /v1/research/runs/:id/progress, /v1/research/timeline and /v1/engine/components, which compute it from stored records.
 * Rules kept here: a percentage is shown ONLY for a measurable metric (recorded numerator and denominator); otherwise the count and the
 * words "not measurable". The four kinds of number look different: processing is a solid bar, coverage a hatched bar labelled
 * "coverage", confidence a distribution of counts (never one %), outcomes plain counts. A finished stage reads "processed", never
 * "understood". "Running" needs a live lease. Worker-reported numbers are labelled so; API-derived counts are labelled verified.
 */

export const PANEL_STATE: Record<string, Word> = {
  not_started: { label: "Not started", tone: "grey", hint: "Queued; no worker has claimed it." },
  queued: { label: "Queued (retry)", tone: "amber", hint: "Re-queued after a failed attempt." },
  running: { label: "Running (live lease)", tone: "cyan", hint: "A worker holds a live lease on this step now." },
  stalled: { label: "Lease expired", tone: "red", hint: "Marked running, but no worker is renewing its lease." },
  succeeded: { label: "Processed", tone: "green", hint: "The stage finished. Processed is not understood: see coverage." },
  failed: { label: "Failed", tone: "red", hint: "The step failed; see errors." },
  not_in_run: { label: "Not in this run", tone: "grey", hint: "This run was created without this stage." },
  recorded: { label: "Records", tone: "grey", hint: "Shown from stored records." },
  unavailable: { label: "Unavailable", tone: "red", hint: "Not available here; see the reason." },
  experimental: { label: "Experimental", tone: "violet", hint: "In code, off by default, not in the pipeline." },
};
export const COMPONENT_STATE: Record<string, Word> = {
  operational: { label: "Operational", tone: "green", hint: "Used successfully, with a recorded event." },
  available: { label: "Available", tone: "cyan", hint: "Deployed and assignable, not yet used successfully." },
  experimental: { label: "Experimental", tone: "violet", hint: "In code, off by default." },
  unavailable: { label: "Unavailable", tone: "red", hint: "The probe or schema check fails here." },
  blocked: { label: "Blocked", tone: "amber", hint: "A recorded blocker." },
};
const VERDICT: Record<string, { label: string; tone: Tone }> = {
  refuted: { label: "refuted", tone: "grey" }, weakened: { label: "weakened", tone: "amber" }, open: { label: "open", tone: "amber" },
  supported_unknown_family: { label: "supported, family unknown", tone: "violet" }, corroborated_same_family: { label: "corroborated, same family", tone: "cyan" },
  supported_cross_family: { label: "supported, cross-family", tone: "green" }, reviewed: { label: "reviewed", tone: "grey" }, withdrawn: { label: "withdrawn", tone: "grey" },
};
const KIND_TONE: Record<string, Tone> = { processing: "green", coverage: "cyan", confidence: "violet", outcome: "amber" };

/** A percentage only for a measurable metric; floored so an unfinished bar never reads 100%. */
export function percent(m: Metric): number | null {
  if (!m.measurable || m.numerator === null || m.denominator === null || m.denominator <= 0) return null;
  return m.numerator >= m.denominator ? 100 : Math.floor((m.numerator / m.denominator) * 100);
}
const basisBadge = (m: Metric) => m.basis === "worker_reported"
  ? chip("reported by the worker", "amber") : chip("verified", "green");

export function metricRow(m: Metric): HTMLElement {
  const pct = percent(m);
  const kind = h("span", { class: `kind-tag kind-${m.kind}` }, m.kind);
  const value = pct !== null
    ? h("span", { class: "metric-value" }, h("strong", {}, `${pct}%`), ` ${m.numerator} / ${m.denominator} ${m.unit}`, m.kind === "processing" && pct === 100 ? h("span", { class: "muted" }, " · processed") : null)
    : h("span", { class: "metric-value" }, h("strong", {}, m.numerator === null ? "not recorded" : `${m.numerator} ${m.unit}`), m.kind === "outcome" && m.denominator !== null ? ` of ${m.denominator}` : "", h("span", { class: "not-measurable" }, m.denominator === null || !m.measurable ? " · not measurable" : ""));
  const bar = pct !== null && (m.kind === "processing" || m.kind === "coverage")
    ? h("div", { class: `meter meter-${m.kind}`, role: "progressbar", "aria-valuemin": 0, "aria-valuemax": m.denominator!, "aria-valuenow": m.numerator!, "aria-label": `${m.label}: ${m.numerator} of ${m.denominator} ${m.unit}` },
      h("span", { class: "meter-fill", style: `width:${pct}%` }))
    : null;
  const remaining = pct !== null && m.kind === "processing" && m.numerator! < m.denominator! ? h("span", { class: "muted small" }, `remaining: ${m.denominator! - m.numerator!} ${m.unit}`) : null;
  return h("div", { class: `metric metric-${m.kind}${pct === null ? " is-unmeasurable" : ""}`, "data-key": m.key },
    h("div", { class: "metric-head" }, kind, h("span", { class: "metric-label" }, m.label), basisBadge(m)),
    bar, h("div", { class: "metric-line" }, value, remaining),
    m.note ? h("p", { class: "muted small metric-note" }, m.note) : null,
    h("p", { class: "metric-source small" }, "source: ", m.source));
}

function activityLine(a: StepActivity): HTMLElement {
  const p = a.latest_progress;
  const lease = a.status === "running" ? (a.lease_live ? `live lease held by ${a.lease_owner} until ${exactTime(a.lease_expires_at)}` : `lease EXPIRED at ${exactTime(a.lease_expires_at)}: not running`) : null;
  return h("div", { class: "activity" },
    h("p", { class: "small" }, h("strong", {}, a.step_key), ` · ${a.status}`, a.attempt > 1 ? ` · attempt ${a.attempt}` : "", a.elapsed_seconds !== null ? ` · ${a.status === "running" ? "running for" : "took"} ${duration(a.elapsed_seconds)}` : "", lease ? ` · ${lease}` : ""),
    p ? h("p", { class: "small" }, "latest progress: ", h("strong", {}, p.phase.replace(/_/g, " ")), ` ${p.done}${p.total === null ? "" : ` of ${p.total}`} ${p.unit.replace(/_/g, " ")} · `, chip("reported by the worker", "amber"), ` · ${relativeTime(p.at)} (${exactTime(p.at)}) · ${a.progress_records} progress records`)
      : a.status === "running" ? h("p", { class: "small muted" }, `running since ${exactTime(a.started_at)}; no progress reported, so progress is not measurable`) : null);
}

function issuesBlock(p: ProgressPanel): HTMLElement | null {
  const i = p.issues; const rows: HTMLElement[] = [];
  for (const e of i.errors) rows.push(h("li", { class: "issue issue-error" }, chip("error", "red"), ` ${e.step_key}${e.attempt !== null ? ` attempt ${e.attempt}` : ""}: ${e.message}${e.retryable === null ? "" : e.retryable ? " (retryable)" : " (not retryable)"}`, h("span", { class: "muted small" }, ` · ${exactTime(e.at)} · ${e.source}`)));
  for (const r of i.retries) rows.push(h("li", { class: "issue" }, chip("retry", "amber"), ` ${r.step_key} is on attempt ${r.attempt}`));
  for (const x of i.expired_leases) rows.push(h("li", { class: "issue issue-error" }, chip("expired lease", "red"), ` ${x.step_key} (owner ${x.lease_owner ?? "none"}) expired ${exactTime(x.lease_expired_at)}`));
  if (i.lease_exhausted) rows.push(h("li", { class: "issue issue-error" }, chip("lease exhausted", "red"), ` ${i.lease_exhausted} lease-exhaustion events`));
  for (const a of i.abstentions) rows.push(h("li", { class: "issue" }, chip("abstention", "violet"), ` ${a.code}: ${a.detail}`, h("span", { class: "muted small" }, ` · ${a.source}`)));
  if (i.refusals.total) rows.push(h("li", { class: "issue" }, chip("worker-API refusals", "amber"), ` ${i.refusals.total} (${Object.entries(i.refusals.by_code).map(([k, v]) => `${k} ${v}`).join(", ")})${i.refusals.quota ? `; ${i.refusals.quota} quota refusals` : ""}`));
  for (const b of i.blockers) rows.push(h("li", { class: "issue issue-blocker" }, chip("blocker", "amber"), ` ${b.text}`, h("span", { class: "muted small" }, ` · ${b.source}`)));
  return rows.length ? h("ul", { class: "issues" }, ...rows) : null;
}

export function panelCard(p: ProgressPanel): HTMLElement {
  const st = word(PANEL_STATE, p.state);
  const blocked = p.availability && (p.availability.state === "unavailable" || p.availability.state === "experimental");
  const body: Array<Node | null> = [
    h("p", { class: "muted small" }, p.state_basis),
    blocked ? h("p", { class: `callout availability tone-${p.availability!.state === "unavailable" ? "red" : "violet"}` }, h("strong", {}, p.availability!.state === "unavailable" ? "Unavailable" : "Experimental"), `: ${p.availability!.reason}`, h("span", { class: "muted small" }, ` (evidence: ${p.availability!.evidence})`)) : null,
    ...p.activity.map(activityLine),
    ...p.processing.map(metricRow), ...p.coverage.map(metricRow),
    p.counts.length ? h("div", { class: "counts" }, ...p.counts.map(metricRow)) : null,
    p.capabilities?.length ? h("ul", { class: "rows caps" }, ...p.capabilities.map((c) => h("li", { class: "row-static" },
      h("span", { class: "row-main" }, h("strong", {}, `${c.id}@${c.version}`), h("span", { class: "muted small" }, `${c.kind} · ${c.reason || c.state}${c.in_run ? "" : " · not in this run"} · environment: ${c.environment} · ${c.source}`)),
      chip(c.state.replace(/_/g, " "), c.state === "completed" ? "green" : c.state === "unavailable" ? "red" : c.state === "abstained" ? "violet" : "grey")))) : null,
    issuesBlock(p),
    p.notes.length ? h("ul", { class: "notes muted small" }, ...p.notes.map((n) => h("li", {}, n))) : null,
    !blocked && !p.processing.length && !p.coverage.length && !p.counts.length && !p.activity.length && !p.capabilities?.length ? h("p", { class: "muted small" }, "No records for this stage in this run.") : null,
  ];
  return panel(p.title, body.filter((x): x is Node => x !== null), { class: `ops-panel ops-${p.id} state-${p.state}`, actions: [badge(st)] });
}

function stagesStrip(r: RunProgress): HTMLElement {
  return h("ol", { class: "ops-stages" }, ...r.stages.map((s) => {
    const label = s.status === "running" ? (s.lease_live ? "running" : "lease expired") : s.status === "succeeded" ? "processed" : s.status;
    return h("li", { class: `ops-stage stage-${s.status}${s.status === "running" && !s.lease_live ? " stage-stalled" : ""}` }, h("span", { class: "ops-stage-name" }, s.step_key.replace(/_/g, " ")),
      h("span", { class: "small" }, label), h("span", { class: "muted small" }, s.elapsed_seconds === null ? "not started" : duration(s.elapsed_seconds)));
  }));
}

export function confidenceCard(r: RunProgress): HTMLElement {
  const c = r.confidence;
  if (!c.available) return panel("Confidence", [empty("No assessment to show", c.reason)], { class: "ops-panel ops-confidence" });
  const total = c.total;
  const segs = c.distribution.filter((d) => d.count > 0);
  return panel("Confidence", [
    h("p", { class: "muted small" }, `${total} leads by their assessment. A distribution of counts, never a single percentage. Source: ${c.source}.`),
    total ? h("div", { class: "dist-bar", role: "img", "aria-label": segs.map((d) => `${d.count} ${VERDICT[d.verdict]?.label ?? d.verdict}`).join(", ") },
      ...segs.map((d) => h("span", { class: `dist-seg tone-${VERDICT[d.verdict]?.tone ?? "grey"}`, style: `flex-grow:${d.count}`, title: `${VERDICT[d.verdict]?.label ?? d.verdict}: ${d.count}` }))) : null,
    h("ul", { class: "legend dist-legend" }, ...c.distribution.map((d) => h("li", {}, h("span", { class: `swatch tone-${VERDICT[d.verdict]?.tone ?? "grey"}` }), h("span", {}, VERDICT[d.verdict]?.label ?? d.verdict), h("strong", {}, String(d.count))))),
    h("div", { class: "counts" }, metricRow(c.corroboration.same_family), metricRow(c.corroboration.cross_family)),
  ].filter((x) => x !== null) as HTMLElement[], { class: "ops-panel ops-confidence" });
}

export function outcomeCard(r: RunProgress): HTMLElement {
  const o = r.outcome;
  if (!o.available) return panel("Outcome", [empty("No outcome to show", o.reason)], { class: "ops-panel ops-outcome" });
  return panel("Outcome", [
    h("div", { class: "outcome-tiles" }, ...o.counts.map((m) => h("div", { class: `outcome-tile tone-${m.key === "confirmed" ? "grey" : m.key === "refuted" ? "grey" : "amber"}`, title: m.source },
      h("strong", { class: "outcome-n" }, m.numerator === null ? "—" : String(m.numerator)), h("span", { class: "small" }, m.label)))),
    h("p", { class: o.no_leads ? "callout callout-warn" : "muted small" }, o.note),
    h("p", { class: "metric-source small" }, "Counts only; sources: ", o.counts.map((m) => `${m.key}: ${m.source}`).join("; ")),
  ], { class: "ops-panel ops-outcome" });
}

export function systemCard(s: SystemComponents): HTMLElement {
  return panel("System", [
    h("p", { class: "muted small" }, `Component states from recorded events, capability probes and schema checks (server time ${exactTime(s.generated_at)}). Nothing is hardcoded.`),
    h("ul", { class: "rows system-rows" }, ...s.components.map((c) => h("li", { class: "row-static" },
      h("span", { class: "row-main" }, h("strong", {}, c.label), ...c.evidence.map((e) => h("span", { class: "muted small" }, `${e.source}: ${e.detail}${e.at ? ` (${exactTime(e.at)})` : ""}`))),
      badge(word(COMPONENT_STATE, c.state))))),
    h("details", {}, h("summary", { class: "small" }, "State rules"), h("ul", { class: "muted small" }, ...Object.entries(s.rules).map(([k, v]) => h("li", {}, `${k}: ${v}`)))),
  ], { class: "ops-panel ops-system" });
}

function payloadText(v: unknown): string { try { return JSON.stringify(v, null, 2) ?? "null"; } catch { return String(v); } }
const CATEGORY_TONE: Record<string, Tone> = { progress: "amber", step_lifecycle: "cyan", worker_api: "violet", worker_token: "violet", hypothesis: "green", run: "grey", other: "grey" };

/** The expandable timeline. Rows stay open across live refreshes (the set of open ids is kept by the caller). */
export function timelineList(items: TimelineItem[], open: Set<string>): HTMLElement {
  if (!items.length) return empty("No events", "No audit or hypothesis event is recorded for this run yet.");
  return h("ol", { class: "timeline-list" }, ...items.map((it) => {
    const d = h("details", { class: `tl-item tl-${it.category}`, "data-id": it.id, open: open.has(it.id),
      ontoggle: () => { if (d.open) open.add(it.id); else open.delete(it.id); } },
      h("summary", {}, h("time", { class: "muted small", title: exactTime(it.at) }, exactTime(it.at).slice(11)), " ", chip(it.category.replace(/_/g, " "), CATEGORY_TONE[it.category] ?? "grey"), " ",
        h("span", { class: "tl-summary" }, it.summary), it.step_key ? h("span", { class: "muted small" }, ` · ${it.step_key}`) : null),
      h("div", { class: "tl-body small" },
        h("p", { class: "muted" }, `${it.action} · ${it.source} · actor ${it.actor} · ${exactTime(it.at)}`), it.reason ? h("p", {}, it.reason) : null,
        h("pre", { class: "json" }, payloadText(it.payload))));
    return h("li", {}, d);
  }));
}

export function opsBody(r: RunProgress): HTMLElement {
  if (!r?.panels) return empty("Progress unrecognised", "The backend answered, but not in the run-progress/1 shape. Nothing is shown rather than a guess.");
  const st = word(RUN_STATUS, r.run.status);
  const [overall, ...rest] = r.panels;
  return h("div", { class: "ops-grid" },
    h("section", { class: "ops-run" },
      h("p", {}, h("strong", {}, r.run.repository ?? r.run.id), r.run.ref ? h("span", { class: "muted" }, ` @ ${shortHash(r.run.ref, 12)}`) : null, " ", badge(st),
        r.run.bounty_scope ? chip(`scope ${r.run.bounty_scope.programme}: ${r.run.bounty_scope.in_scope_paths} paths`, "cyan") : null),
      h("p", { class: "muted small" }, `run ${r.run.id} · created ${exactTime(r.run.created_at)}${r.run.completed_at ? ` · finished ${exactTime(r.run.completed_at)}` : ""}`, r.run.snapshot_id ? h("span", {}, " · ", h("a", { class: "link", href: link("repository", r.run.snapshot_id) }, "snapshot")) : null, " · ", h("a", { class: "link", href: link("projects", r.run.id) }, "project")),
      h("ul", { class: "ops-legend" }, h("li", {}, h("span", { class: "kind-tag kind-processing" }, "processing"), " work done (processed, never understood)"),
        h("li", {}, h("span", { class: "kind-tag kind-coverage" }, "coverage"), " what should be examined, was"), h("li", {}, h("span", { class: "kind-tag kind-confidence" }, "confidence"), " a distribution, never one %"),
        h("li", {}, h("span", { class: "kind-tag kind-outcome" }, "outcome"), " counts only"), h("li", {}, chip("verified", "green"), " counted by the API from its records"), h("li", {}, chip("reported by the worker", "amber"), " taken as reported"))),
    overall ? h("div", { class: "ops-overall" }, panelCard(overall), stagesStrip(r)) : null,
    ...rest.map(panelCard),
    confidenceCard(r), outcomeCard(r));
}

function runSelector(ctx: Ctx, current: string | undefined): HTMLElement {
  const box = h("div", { class: "ops-select" });
  loadInto(box, () => ctx.api.get<Page<ProjectSummary>>("/v1/research/projects", { limit: 50 }), (page) => {
    const runs = (page?.items ?? []).filter((p) => p.workflow_type === "repository_research");
    if (!runs.length) return empty("No research runs", "No repository_research run is recorded, so there is no progress to show.", "POST /v1/intake or the targeted promotion");
    const sel = h("select", { id: "ops-run", "aria-label": "Research run", onchange: () => ctx.go(linkWith("#/operations", { run: sel.value })) },
      ...runs.map((p, i) => h("option", { value: p.id, selected: (current ?? runs[0]!.id) === p.id }, `${p.input.value ?? p.id} · ${p.status}${i === 0 ? " · latest" : ""} · ${exactTime(p.created_at)}`))) as HTMLSelectElement;
    return h("label", { class: "small muted", for: "ops-run" }, "Run ", sel);
  });
  return box;
}

export function renderOperations(ctx: Ctx, query: Record<string, string>): HTMLElement {
  const root = h("div", { class: "view view-operations" });
  root.append(h("div", { class: "view-head" }, h("h1", {}, "Operations"), h("a", { class: "link small", href: "#/control" }, "Control Room"),
    h("p", { class: "muted" }, "Live progress of one research run. Every number names its source; where no denominator is recorded the page says \"not measurable\" and shows the count.")));
  const main = h("div", { class: "stack" });
  root.append(runSelector(ctx, query["run"]), main);
  const start = (runId: string) => {
    const open = new Set<string>();
    main.replaceChildren(
      livePanel(() => ctx.api.get<RunProgress>(`/v1/research/runs/${runId}/progress`), (r) => opsBody(r), { generatedAt: (r) => r?.generated_at ?? null }),
      timelinePanel(ctx, runId, open),
      livePanel(() => ctx.api.get<SystemComponents>("/v1/engine/components"), (s) => s?.components ? systemCard(s) : empty("System view unrecognised", "Unexpected response shape."), { generatedAt: (s) => s?.generated_at ?? null }));
  };
  if (query["run"]) start(query["run"]);
  else {
    main.append(loading("Finding the latest run"));
    ctx.api.get<Page<ProjectSummary>>("/v1/research/projects", { limit: 50 }).then((page) => {
      const latest = (page?.items ?? []).find((p) => p.workflow_type === "repository_research");
      if (latest) start(latest.id); else main.replaceChildren();
    }, (error: unknown) => main.replaceChildren(errorState(error)));
  }
  return root;
}

function timelinePanel(ctx: Ctx, runId: string, open: Set<string>): HTMLElement {
  const older: TimelineItem[] = []; let cursor: TimelinePage["next"] = null; let olderLoaded = false;
  const more = h("div", { class: "pager" });
  const live = livePanel(() => ctx.api.get<TimelinePage>("/v1/research/timeline", { run: runId, limit: 60 }), (t) => {
    if (!t?.items) return empty("Timeline unrecognised", "Unexpected response shape.");
    if (!olderLoaded) cursor = t.next;
    const seen = new Set(t.items.map((i) => i.id));
    const btn = h("button", { class: "btn", type: "button", onclick: () => {
      if (!cursor) return;
      ctx.api.get<TimelinePage>("/v1/research/timeline", { run: runId, limit: 60, before: cursor.before, before_id: cursor.before_id }).then((p) => {
        olderLoaded = true; older.push(...p.items); cursor = p.next;
        list.replaceWith(list = timelineList([...t.items, ...older.filter((x) => !seen.has(x.id))], open));
        if (!cursor) btn.remove();
      }, (error: unknown) => more.replaceChildren(errorState(error)));
    } }, "Load older");
    let list = timelineList([...t.items, ...older.filter((x) => !seen.has(x.id))], open);
    more.replaceChildren(...(cursor ? [btn] : []));
    return h("div", { class: "stack-sm" },
      h("p", { class: "muted small" }, `Merged, newest first, from ${t.sources.join("; ")}. Tap a row to see its stored payload (secrets removed).`),
      h("p", { class: "small muted" }, t.decisions.note), list, more);
  });
  return panel("Live timeline", [live], { class: "ops-panel ops-timeline" });
}
