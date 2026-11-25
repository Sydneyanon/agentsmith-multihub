import { clear, h } from "./dom.js";
import { ApiError, describeError } from "./api.js";
import { badge, chip, empty, kv, loadInto, mono, pagerBar, panel, progressBar, stepper } from "./components.js";
import { bytes, exactTime, relativeTime, shortHash } from "./format.js";
import { link, linkWith } from "./router.js";
import type { Ctx } from "./ctx.js";
import type { Page, ProjectDetail, ProjectSummary } from "./types.js";
import { HYPOTHESIS_STATUS, RUN_STATUS, STEP_STATUS, stageStates, stepLabel, word } from "./vocab.js";
import { projectTitle } from "./view-home.js";

export function renderProjects(ctx: Ctx, id: string | undefined, query: Record<string, string>): HTMLElement {
  return id ? renderProject(ctx, id) : renderProjectList(ctx, query);
}

function intakeForm(ctx: Ctx): HTMLElement {
  const message = h("p", { class: "muted small", role: "status" });
  const kind = h("select", { id: "intake-kind", name: "kind" }, h("option", { value: "url" }, "URL"), h("option", { value: "idea" }, "Idea"));
  const value = h("input", { id: "intake-value", name: "value", type: "text", required: true, minlength: 3, maxlength: 4000, placeholder: "https://… or a short description" });
  const notes = h("textarea", { id: "intake-notes", name: "notes", rows: 2, maxlength: 8000, placeholder: "Optional notes" });
  const form = h("form", { class: "form", onsubmit: (event: Event) => {
    event.preventDefault();
    message.textContent = "Submitting…";
    const body: Record<string, string> = { kind: kind.value, value: value.value.trim(), source: "user" };
    if (notes.value.trim()) body["notes"] = notes.value.trim();
    ctx.api.post<{ workflow_run_id?: string; id?: string }>("/v1/intake", body).then((res) => {
      const runId = res.id ?? res.workflow_run_id;
      if (runId) ctx.go(link("projects", runId)); else { message.textContent = "Submitted."; ctx.go(link("projects")); }
    }, (error: unknown) => {
      message.textContent = error instanceof ApiError && error.code === "invalid_intake" ? "The backend rejected that input (check length and URL scheme)." : error instanceof ApiError && error.code === "url_must_use_http_or_https" ? "URLs must start with http:// or https://." : `${describeError(error).title}: ${describeError(error).detail}`;
    });
  } },
    h("label", { for: "intake-kind" }, "Lead type"), kind, h("label", { for: "intake-value" }, "Lead"), value, h("label", { for: "intake-notes" }, "Notes"), notes,
    h("p", { class: "muted small" }, "Creates a project through the existing intake endpoint. The current pipeline is passive: it records what it reads and does not test anything."),
    h("button", { class: "btn btn-primary", type: "submit" }, "Create project"), message);
  return form;
}

function renderProjectList(ctx: Ctx, query: Record<string, string>): HTMLElement {
  const root = h("div", { class: "view" });
  const body = h("div", {});
  const offset = Number(query["offset"] ?? 0) || 0;
  const status = query["status"];
  const filters = h("div", { class: "chips" }, ...[undefined, "queued", "running", "succeeded", "failed"].map((s) => {
    const active = s === status;
    return h("a", { class: `chip-link${active ? " is-active" : ""}`, href: linkWith("#/projects", { status: s }), "aria-current": active ? "true" : null }, s ? word(RUN_STATUS, s).label : "All");
  }));
  root.append(h("div", { class: "view-head" }, h("h1", {}, "Projects"), h("p", { class: "muted" }, "One project is one intake run.")),
    h("div", { class: "split" }, h("div", { class: "split-main" }, filters, body), panel("New project", [intakeForm(ctx)], { class: "split-side" })));
  loadInto(body, () => ctx.api.get<Page<ProjectSummary>>("/v1/research/projects", { status, offset, limit: 25 }), (page) => {
    if (page.items.length === 0) return empty(status ? "No projects with that status" : "No projects yet", "Create one with the form, or via POST /v1/intake.", "POST /v1/intake");
    return h("div", {}, h("ul", { class: "rows" }, ...page.items.map((p) => h("li", {}, h("a", { class: "row-link", href: link("projects", p.id) },
      h("span", { class: "row-main" }, h("strong", {}, projectTitle(p)), h("span", { class: "muted small" }, `${p.input.kind ?? "?"} · ${relativeTime(p.created_at)} · ${p.hypotheses.total} hypotheses · ${p.snapshots.total} snapshots`)),
      badge(word(RUN_STATUS, p.status)), progressBar(p.progress.steps_succeeded, p.progress.steps_total, "workflow steps"))))),
      pagerBar({ hasMore: page.has_more, offset: page.offset, limit: page.limit, go: (o) => ctx.go(linkWith("#/projects", { status, offset: o ? String(o) : undefined })) }));
  });
  return root;
}

function renderProject(ctx: Ctx, id: string): HTMLElement {
  const root = h("div", { class: "view" });
  const body = h("div", {});
  root.append(h("p", {}, h("a", { class: "link", href: link("projects") }, "← Projects")), body);
  loadInto(body, () => ctx.api.get<ProjectDetail>(`/v1/research/projects/${id}`), (d) => {
    const sealed = d.snapshots.filter((s) => s.sealed_at !== null).length;
    const slots = stageStates({ snapshots: { sealed }, hypotheses: d.hypotheses, evaluations: d.evaluations, reviews: d.reviews });
    const steps = h("table", { class: "table" }, h("thead", {}, h("tr", {}, ...["#", "Step", "Role", "Status", "Attempt", "Finished"].map((t) => h("th", { scope: "col" }, t)))),
      h("tbody", {}, ...d.steps.map((s) => h("tr", {}, h("td", {}, String(s.sequence)), h("td", {}, stepLabel(s.step_key)), h("td", { class: "muted" }, s.role),
        h("td", {}, badge(word(STEP_STATUS, s.status)), s.status === "running" && !s.lease_live ? chip("lease expired", "amber") : null, s.error ? h("div", { class: "small tone-red-text" }, s.error) : null),
        h("td", {}, String(s.attempt)), h("td", { class: "muted small" }, relativeTime(s.completed_at))))));
    const snaps = d.snapshots.length === 0
      ? empty("No repository snapshots", "Repository acquisition does not exist yet. Snapshots are created by Task 5.2.", "Task 5.2")
      : h("ul", { class: "rows" }, ...d.snapshots.map((s) => h("li", {}, h("a", { class: "row-link", href: link("repository", s.id) },
        h("span", { class: "row-main" }, h("strong", {}, s.repository), h("span", { class: "muted small" }, `commit ${shortHash(s.commit_sha, 12)} · ${s.file_count ?? "?"} files · ${bytes(s.total_bytes === null ? null : Number(s.total_bytes))}`)),
        chip(s.sealed_at ? "sealed" : "building", s.sealed_at ? "green" : "amber")))));
    const hyp = d.hypotheses.total === 0
      ? empty("No hypotheses", "None have been registered for this project.", "Task 5.5")
      : h("div", {}, h("ul", { class: "chips" }, ...Object.entries(d.hypotheses.by_status).map(([k, n]) => badge(word(HYPOTHESIS_STATUS, k), `· ${n}`))),
        h("a", { class: "link", href: linkWith("#/hypotheses", { run: d.id }) }, "Open hypotheses"));
    const legacy = h("div", {}, h("p", { class: "callout" }, d.legacy.note),
      d.legacy.evidence_snapshots.length ? h("ul", { class: "rows" }, ...d.legacy.evidence_snapshots.map((e) => h("li", { class: "row-static" }, h("span", { class: "row-main" }, h("strong", {}, e.source_kind), h("span", { class: "muted small" }, e.source_uri)), mono(shortHash(e.content_sha256))))) : h("p", { class: "muted" }, "No source snapshots were captured."),
      d.legacy.leads.length ? h("details", {}, h("summary", {}, `${d.legacy.leads.length} regex leads`), h("pre", { class: "json" }, JSON.stringify(d.legacy.leads.slice(0, 50), null, 2))) : null,
      d.legacy.brief ? h("details", {}, h("summary", {}, "Legacy research brief"), h("pre", { class: "json" }, JSON.stringify(d.legacy.brief, null, 2))) : h("p", { class: "muted" }, "No brief has been prepared."));
    return h("div", { class: "stack" },
      h("div", { class: "view-head" }, h("h1", {}, projectTitle(d)), badge(word(RUN_STATUS, d.status))),
      panel("Stage records", [stepper(slots)]),
      panel("Overview", [kv([["Lead", d.input.value ?? "—"], ["Type", d.input.kind ?? "—"], ["Source", d.input.source ?? "—"], ["Created", exactTime(d.created_at)], ["Created by", d.created_by ?? "—"], ["Notes", d.notes ?? "—"], ["Run id", mono(d.id)]])]),
      panel("Workflow steps", [progressBar(d.progress.steps_succeeded, d.progress.steps_total, "succeeded"), steps]),
      panel("Repository snapshots", [snaps]), panel("Hypotheses", [hyp]),
      panel("Legacy passive pipeline output", [legacy]));
  });
  void clear;
  return root;
}
