import { h } from "./dom.js";
import { badge, donut, empty, loadInto, mono, panel, pipelineChart, progressBar, statCard, stepper } from "./components.js";
import { duration, exactTime, plural, relativeTime, shortHash, hostOf } from "./format.js";
import { link } from "./router.js";
import type { Ctx } from "./ctx.js";
import type { ActivityPage, Overview, Page, ProjectDetail, ProjectSummary } from "./types.js";
import { AUTOMATION, HEALTH, HYPOTHESIS_STATUS, RUN_STATUS, STEP_STATUS, stageStates, stepLabel, word } from "./vocab.js";

const ACTIVE = ["queued", "running", "awaiting_approval"];
const STATUS_ORDER = Object.keys(HYPOTHESIS_STATUS);

export function projectTitle(p: { input: ProjectSummary["input"] }): string {
  const value = p.input.value ?? "(no input)";
  return p.input.kind === "url" ? hostOf(value) + (value.length > 40 ? " …" : "") : value.length > 70 ? `${value.slice(0, 70)}…` : value;
}

export function renderHome(ctx: Ctx): HTMLElement {
  const root = h("div", { class: "view view-home" });
  const overviewBox = h("div", {});
  root.append(
    h("div", { class: "view-head home-head" },
      h("div", { class: "home-head-text" },
        h("h1", {}, "Research Home"),
        h("p", { class: "muted" }, "Investigate smart contracts, discover risks, and produce evidence-backed security research. Every count here is live from the backend — nothing is sample data.")),
      h("a", { class: "btn btn-primary new-inv", href: link("projects") }, h("span", { "aria-hidden": "true" }, "＋"), "New investigation")),
    overviewBox);
  loadInto(overviewBox, () => Promise.all([
    ctx.api.get<Overview>("/v1/research/overview"),
    ctx.api.get<Page<ProjectSummary>>("/v1/research/projects", { limit: 12 }),
    ctx.api.get<ActivityPage>("/v1/research/activity", { limit: 6 }),
  ]), ([overview, projects, activity]) => homeBody(ctx, overview, projects.items, activity));
  return root;
}

/** One investigation row: title, a real subtitle (kind + current step), status badge and workflow progress. */
function investigationRow(p: ProjectSummary, onSelect: (id: string) => void, selectedId: string | null): HTMLElement {
  const sub = p.progress.current_step ? stepLabel(p.progress.current_step) : `${p.input.kind ?? "?"} · ${relativeTime(p.created_at)}`;
  return h("li", {},
    h("button", { class: `inv-item row-btn${selectedId === p.id ? " is-selected" : ""}`, type: "button", "data-id": p.id, onclick: () => onSelect(p.id) },
      h("span", { class: "row-main" }, h("strong", {}, projectTitle(p)), h("span", { class: "muted small" }, sub)),
      badge(word(RUN_STATUS, p.status)),
      progressBar(p.progress.steps_succeeded, p.progress.steps_total, "workflow steps")));
}

function homeBody(ctx: Ctx, o: Overview, projects: ProjectSummary[], activity: ActivityPage): HTMLElement {
  const active = ACTIVE.reduce((n, k) => n + (o.projects.by_status[k] ?? 0), 0);
  const awaiting = o.research.hypotheses.by_status["unreviewed"] ?? 0;
  const health = word(HEALTH, o.pipeline.health.state);

  const stats = h("div", { class: "stats" },
    statCard("Active investigations", active, `${o.projects.total} total`, "cyan", "◉"),
    statCard("Hypotheses", o.research.hypotheses.total, o.research.hypotheses.total ? `${o.research.evaluations} evaluations` : "none registered yet", "violet", "✦"),
    statCard("Under review", awaiting, "awaiting a blinded review", "amber", "◷"),
    statCard("Findings", 0, `0 confirmed · ${o.research.evidence_spans} evidence spans`, "green", "❖"));

  // Featured investigation (right): prefer the most active one so the detail panel shows live progress.
  const featured = projects.find((p) => p.status === "running") ?? projects.find((p) => ACTIVE.includes(p.status)) ?? projects[0];
  let selectedId: string | null = featured?.id ?? null;
  const detailBox = h("div", { class: "project-detail" });
  const invListBox = h("ul", { class: "rows inv-list" });
  const select = (id: string) => {
    selectedId = id;
    for (const b of invListBox.querySelectorAll(".inv-item")) b.classList.toggle("is-selected", b.getAttribute("data-id") === id);
    loadInto(detailBox, () => ctx.api.get<ProjectDetail>(`/v1/research/projects/${id}`), (d) => projectPane(d));
  };

  // Active investigations (left): real projects, or an honest empty state.
  const invList = projects.length === 0
    ? empty("No investigations yet", "An investigation starts when a lead is submitted through intake. They appear here with live stage progress.", "POST /v1/intake")
    : (() => { for (const p of projects) invListBox.append(investigationRow(p, select, selectedId)); return invListBox; })();
  if (featured) select(featured.id); else detailBox.append(empty("Select an investigation", "Pick an investigation on the left to see its stage pipeline, current activity and what runs next."));

  const hyp = o.research.hypotheses;
  const recent = activity.items.length === 0
    ? empty("No activity yet", "Workflow and research events appear here as they are recorded, newest first.")
    : h("ul", { class: "feed feed-activity" }, ...activity.items.map((a) => {
        const au = word(AUTOMATION, a.automation);
        return h("li", {},
          h("span", { class: `feed-dot tone-${au.tone}`, "aria-hidden": "true" }),
          h("span", { class: "feed-text" }, a.action.replace(/_/g, " "), h("span", { class: "muted" }, ` · ${a.entity_type}${a.step_key ? ` · ${stepLabel(a.step_key)}` : ""}`)),
          h("time", { class: "muted small", title: exactTime(a.at) }, relativeTime(a.at)));
      }));

  // Investigation pipeline: real step counts per stage, as vertical stacked columns.
  const stepRows = Object.entries(o.pipeline.steps_by_key_and_status).map(([key, counts]) => ({ label: stepLabel(key), counts }));
  const p = o.pipeline;

  const engineStrip = h("section", { class: "panel engine-strip area-engine" },
    h("div", { class: "panel-body engine-strip-body" },
      h("div", { class: "engine-id" }, badge(health), h("span", { class: "muted small" }, health.hint)),
      h("dl", { class: "engine-metrics" },
        metric("Queued steps", String(p.steps_queued)),
        metric("Running steps", String(p.steps_running)),
        metric("Live workers", String(p.live_lease_owners)),
        metric("Active investigations", String(active)),
        metric("Awaiting review", String(awaiting))),
      p.health.reasons.length ? h("ul", { class: "reasons" }, ...p.health.reasons.map((r) => h("li", {}, r))) : null));

  return h("div", { class: "home-grid" }, stats,
    panel("Active investigations", [invList], { class: "area-invlist", actions: [h("a", { class: "link", href: link("projects") }, "View all →")] }),
    panel("Investigation detail", [detailBox], { class: "area-featured" }),
    panel("Recent research activity", [recent], { class: "area-activity", actions: [h("a", { class: "link", href: link("activity") }, "View log →")] }),
    panel("Hypotheses overview", [hyp.total === 0 ? empty("No hypotheses", "Hypotheses are registered by the analysis tasks through the research store.", "Task 5.5") : donut(hyp.by_status, STATUS_ORDER, { value: String(hyp.total), label: "total" })], { class: "area-donut" }),
    panel("Investigation pipeline", [stepRows.length === 0 ? empty("No pipeline steps", "Steps appear once an investigation has been submitted.") : pipelineChart(stepRows, Object.keys(STEP_STATUS), (k) => word(STEP_STATUS, k).tone)], { class: "area-pipeline" }),
    engineStrip);
}

function metric(label: string, value: string): HTMLElement {
  return h("div", { class: "engine-metric" }, h("dt", {}, label), h("dd", {}, value));
}

/** The selected investigation: the seven Design 2 stage slots driven by real records, then current and next workflow steps. */
export function projectPane(d: ProjectDetail): HTMLElement {
  const running = d.steps.find((s) => s.status === "running");
  const next = d.steps.find((s) => s.status === "queued");
  const slots = stageStates(d);
  const activeProject = d.status === "running" || d.status === "queued" || d.status === "awaiting_approval";
  const currentIdx = activeProject ? slots.findIndex((s) => s.state === "none" && !s.notBuilt) : -1;
  const stepped = slots.map((s, i) => ({ ...s, current: i === currentIdx }));
  const pct = d.progress.steps_total > 0 ? Math.round((d.progress.steps_succeeded / d.progress.steps_total) * 100) : 0;
  return h("div", { class: "featured" },
    h("div", { class: "pane-title" },
      h("div", { class: "stack-sm" }, h("h3", {}, projectTitle(d)), h("span", { class: "muted small" }, `${d.input.kind ?? "?"} · source ${d.input.source ?? "?"} · created ${relativeTime(d.created_at)}`)),
      badge(word(RUN_STATUS, d.status))),
    stepper(stepped),
    h("div", { class: "two-col featured-cards" },
      h("div", { class: "mini-card" }, h("h4", {}, "Current activity"),
        running ? h("div", { class: "stack-sm" }, h("p", {}, stepLabel(running.step_key), " ", badge(word(STEP_STATUS, running.status)), running.lease_live ? "" : h("span", { class: "tone-amber small" }, " lease expired")), progressBar(d.progress.steps_succeeded, d.progress.steps_total, `steps · ${pct}%`)) : h("p", { class: "muted" }, "No step is running.")),
      h("div", { class: "mini-card" }, h("h4", {}, "Next up"), next ? h("p", {}, stepLabel(next.step_key)) : h("p", { class: "muted" }, "No step is queued."))),
    h("p", {}, h("a", { class: "link", href: link("projects", d.id) }, `Open investigation (${plural(d.steps.length, "step")}) →`)),
    d.snapshot_records[0] ? h("p", { class: "muted small" }, `Pinned snapshot ${d.snapshot_records[0].repository} @ `, mono(shortHash(d.snapshot_records[0].commit_sha, 12))) : null);
}
