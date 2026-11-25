import { h } from "./dom.js";
import { badge, chip, donut, empty, kv, loadInto, mono, panel, progressBar, stackedBars, statCard, stepper } from "./components.js";
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
  root.append(h("div", { class: "view-head" }, h("h1", {}, "Research Home"), h("p", { class: "muted" }, "Live counts from the research-state backend. Nothing on this page is sample data.")), overviewBox);
  loadInto(overviewBox, () => Promise.all([
    ctx.api.get<Overview>("/v1/research/overview"),
    ctx.api.get<Page<ProjectSummary>>("/v1/research/projects", { limit: 12 }),
    ctx.api.get<ActivityPage>("/v1/research/activity", { limit: 8 }),
  ]), ([overview, projects, activity]) => homeBody(ctx, overview, projects.items, activity));
  return root;
}

function homeBody(ctx: Ctx, o: Overview, projects: ProjectSummary[], activity: ActivityPage): HTMLElement {
  const active = ACTIVE.reduce((n, k) => n + (o.projects.by_status[k] ?? 0), 0);
  const awaiting = o.research.hypotheses.by_status["unreviewed"] ?? 0;
  const health = word(HEALTH, o.pipeline.health.state);
  const stats = h("div", { class: "stats" },
    statCard("Active projects", active, `${o.projects.total} total`, "cyan"),
    statCard("Hypotheses", o.research.hypotheses.total, o.research.hypotheses.total ? `${o.research.evaluations} evaluations` : "none registered yet", "cyan"),
    statCard("Awaiting review", awaiting, "status: unreviewed", "amber"),
    statCard("Evidence spans", o.research.evidence_spans, `${o.research.snapshots.sealed} sealed snapshot${o.research.snapshots.sealed === 1 ? "" : "s"}`, "green"));

  const detailBox = h("div", { class: "project-detail" });
  const select = (id: string) => loadInto(detailBox, () => ctx.api.get<ProjectDetail>(`/v1/research/projects/${id}`), (d) => projectPane(d));
  const list = projects.length === 0
    ? empty("No projects yet", "A project is created when a lead is submitted through intake. Create one from the Projects page.", "POST /v1/intake")
    : h("ul", { class: "rows" }, ...projects.map((p) => h("li", {},
      h("button", { class: "row-btn", type: "button", onclick: () => select(p.id) },
        h("span", { class: "row-main" }, h("strong", {}, projectTitle(p)), h("span", { class: "muted small" }, `${p.input.kind ?? "?"} · ${relativeTime(p.created_at)}`)),
        badge(word(RUN_STATUS, p.status)), progressBar(p.progress.steps_succeeded, p.progress.steps_total, "workflow steps")))));
  if (projects[0]) select(projects[0].id); else detailBox.append(empty("Select a project", "Project detail and its stage records appear here."));

  const hyp = o.research.hypotheses;
  const recent = activity.items.length === 0
    ? empty("No activity yet", "Workflow and research events appear here as they are recorded.")
    : h("ul", { class: "feed" }, ...activity.items.map((a) => h("li", {}, chip(word(AUTOMATION, a.automation).label, word(AUTOMATION, a.automation).tone),
      h("span", { class: "feed-text" }, a.action.replace(/_/g, " "), h("span", { class: "muted" }, ` · ${a.entity_type}${a.step_key ? ` · ${stepLabel(a.step_key)}` : ""}`)), h("time", { class: "muted small", title: exactTime(a.at) }, relativeTime(a.at)))));

  const stepRows = Object.entries(o.pipeline.steps_by_key_and_status).map(([key, counts]) => ({ label: stepLabel(key), counts }));
  const p = o.pipeline;
  return h("div", { class: "home-grid" }, stats,
    panel("Projects", [list], { class: "area-projects", actions: [h("a", { class: "link", href: link("projects") }, "All projects")] }),
    panel("Project detail", [detailBox], { class: "area-detail" }),
    panel("Recent activity", [recent], { class: "area-activity", actions: [h("a", { class: "link", href: link("activity") }, "View all")] }),
    panel("Hypotheses by status", [hyp.total === 0 ? empty("No hypotheses", "Hypotheses are registered by the analysis tasks (5.5) through the research store.", "Task 5.5") : donut(hyp.by_status, STATUS_ORDER, { value: String(hyp.total), label: "hypotheses" })], { class: "area-donut" }),
    panel("Workflow steps by status", [stepRows.length === 0 ? empty("No workflow steps", "Steps appear once a project has been submitted.") : stackedBars(stepRows, Object.keys(STEP_STATUS), (k) => word(STEP_STATUS, k).tone)], { class: "area-bars" }),
    panel("System health", [
      h("div", { class: "health" }, badge(health), h("span", { class: "muted small" }, health.hint)),
      p.health.reasons.length ? h("ul", { class: "reasons" }, ...p.health.reasons.map((r) => h("li", {}, r))) : null,
      kv([["Queued steps", String(p.steps_queued)], ["Running steps", String(p.steps_running)], ["Live lease owners", String(p.live_lease_owners)],
        ["Failed (24 h / 7 d)", `${p.failed_steps_24h} / ${p.failed_steps_7d}`], ["Oldest queued", duration(p.oldest_queued_age_seconds)], ["Last step success", relativeTime(p.last_step_success_at)],
        ["Research blobs", o.storage ? String(o.storage["blobs"] ?? 0) : "—"]]),
      h("p", { class: "muted small" }, `Computed by the backend at ${exactTime(o.generated_at)}.`)], { class: "area-health" }));
}

/** The selected project: the seven Design 2 stage slots driven by real records, then current and next workflow steps. */
export function projectPane(d: ProjectDetail): HTMLElement {
  const running = d.steps.find((s) => s.status === "running");
  const next = d.steps.find((s) => s.status === "queued");
  const slots = stageStates(d);
  return h("div", {},
    h("div", { class: "pane-title" }, h("h3", {}, projectTitle(d)), badge(word(RUN_STATUS, d.status))),
    h("p", { class: "muted small" }, `${d.input.kind ?? "?"} · source ${d.input.source ?? "?"} · created ${relativeTime(d.created_at)}`),
    stepper(slots),
    h("div", { class: "two-col" },
      h("div", {}, h("h4", {}, "Current activity"), running ? h("p", {}, stepLabel(running.step_key), " ", badge(word(STEP_STATUS, running.status)), running.lease_live ? "" : h("span", { class: "tone-amber small" }, " lease expired")) : h("p", { class: "muted" }, "No step is running.")),
      h("div", {}, h("h4", {}, "Next up"), next ? h("p", {}, stepLabel(next.step_key)) : h("p", { class: "muted" }, "No step is queued."))),
    h("p", {}, h("a", { class: "link", href: link("projects", d.id) }, `Open project (${plural(d.steps.length, "step")})`)),
    d.snapshot_records[0] ? h("p", { class: "muted small" }, `Pinned snapshot ${d.snapshot_records[0].repository} @ `, mono(shortHash(d.snapshot_records[0].commit_sha, 12))) : null);
}
