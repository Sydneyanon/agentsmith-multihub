import { h } from "./dom.js";
import { badge, chip, empty, kv, loadInto, mono, panel } from "./components.js";
import { duration, exactTime, plural, relativeTime, shortHash } from "./format.js";
import { livePanel } from "./live.js";
import { link } from "./router.js";
import type { Ctx } from "./ctx.js";
import type { DiscoverySource, EngineStatus, Opportunity, Page, ProjectSummary, StepQueueRow } from "./types.js";
import { RUN_STATUS, type Tone, type Word, stepLabel, word } from "./vocab.js";
import { projectTitle } from "./view-home.js";

/**
 * The Control Room (CR1, docs/control-room-plan.md). Everything shown comes from GET /v1/engine/status and the existing read
 * endpoints, refreshed in place. Rules: "running" only with a live lease; recorded states carry absolute times; idle is said
 * plainly; leads are never called findings; the two pipelines are separate lanes; the data label comes from the server.
 */

export const ENGINE_STATE: Record<string, Word> = {
  idle: { label: "Idle", tone: "grey", hint: "Nothing is queued or running." },
  queued: { label: "Queued", tone: "amber", hint: "Work is waiting; nothing is running right now." },
  working: { label: "Working", tone: "cyan", hint: "A worker holds a live lease on a step." },
  attention: { label: "Needs attention", tone: "amber", hint: "See the reasons." },
};
export const DATA_KIND: Record<string, Word> = {
  production: { label: "Production data", tone: "green", hint: "The operator declares this database holds only real records; it is never seeded." },
  synthetic: { label: "SYNTHETIC DATA: nothing here is real research", tone: "red", hint: "A demonstration database written by a script." },
  test: { label: "Test database", tone: "amber", hint: "A disposable test database." },
  unlabelled: { label: "Data source not labelled", tone: "grey", hint: "The server was started without HUB_DATA_KIND, so it does not claim what this database holds." },
};

/** One plain sentence an operator can read on a phone. Built only from backend fields. */
export function engineSentence(s: EngineStatus): string {
  const workers = s.workers.connected.length + s.workers.live_lease_owners.filter((o) => !s.workers.connected.some((w) => w.worker_id === o)).length;
  const w = workers === 0 ? "No worker is connected" : `${plural(workers, "worker")} connected`;
  const t = s.queue.totals;
  if (s.engine.state === "idle") return `Engine idle. ${w}. Nothing is queued or running.`;
  if (s.engine.state === "working") return `${plural(t.running_live, "step")} running now (live lease). ${w}. ${t.queued} queued.`;
  if (s.engine.state === "queued") return `${plural(t.queued, "step")} queued, none running. ${w}.`;
  return `Needs attention. ${w}. ${t.running_live} running, ${t.queued} queued.`;
}

const laneTone = (kind: string): Tone => (kind === "structural" ? "cyan" : kind === "legacy" ? "violet" : "grey");

function stepRow(r: StepQueueRow): HTMLElement {
  const cells: Array<[number, string, Tone]> = [[r.queued, "queued", "amber"], [r.running_live, "running", "cyan"], [r.running_expired_lease, "lease expired", "red"], [r.awaiting_approval, "awaiting approval", "amber"], [r.failed, "failed", "red"], [r.succeeded, "completed", "green"]];
  return h("li", { class: "lane-step" }, h("span", { class: "lane-step-name" }, stepLabel(r.step_key)),
    h("span", { class: "lane-step-counts" }, ...cells.filter(([n]) => n > 0).map(([n, l, t]) => chip(`${n} ${l}`, t)),
      cells.every(([n]) => n === 0) ? h("span", { class: "muted small" }, "no records") : null,
      r.oldest_queued_age_seconds !== null && r.queued > 0 ? h("span", { class: "muted small" }, ` oldest ${duration(r.oldest_queued_age_seconds)}`) : null));
}

function lanes(s: EngineStatus, projects: ProjectSummary[]): HTMLElement {
  const known = new Map(s.queue.by_lane.map((l) => [l.workflow_type, l]));
  const types = [...new Set([...s.queue.by_lane.map((l) => l.workflow_type), ...s.runs.map((r) => r.workflow_type)])];
  if (types.length === 0) return empty("No research runs", "No project has been submitted to either pipeline. Runs appear here when intake creates them.", "POST /v1/intake");
  const simulated = s.data_kind === "synthetic";
  return h("div", { class: "lanes" }, ...types.sort((a, b) => (known.get(a)?.kind === "structural" ? -1 : known.get(b)?.kind === "structural" ? 1 : a.localeCompare(b))).map((type) => {
    const lane = known.get(type) ?? { workflow_type: type, label: s.runs.find((r) => r.workflow_type === type)?.lane === "structural" ? "Structural repository research (T-149)" : `Legacy intake (${type})`, kind: (s.runs.find((r) => r.workflow_type === type)?.lane ?? "legacy") as "structural" | "legacy" | "other", steps: [] };
    const counts = s.runs.filter((r) => r.workflow_type === type);
    const recent = projects.filter((p) => p.workflow_type === type).slice(0, 5);
    return h("section", { class: `lane lane-${lane.kind}` },
      h("header", { class: "lane-head" }, chip(lane.kind === "structural" ? "Structural" : lane.kind === "legacy" ? "Legacy" : "Other", laneTone(lane.kind)), h("strong", {}, lane.label), simulated ? chip("simulated", "red") : null),
      lane.kind === "legacy" ? h("p", { class: "muted small" }, "Template-hypothesis pipeline. Its retirement (T-149 S3) awaits approval; its output is kept apart from structural research.") : null,
      h("p", { class: "small" }, "Runs: ", ...counts.map((c) => chip(`${c.count} ${word(RUN_STATUS, c.status).label.toLowerCase()}`, word(RUN_STATUS, c.status).tone)), counts.length ? null : h("span", { class: "muted" }, "none")),
      lane.steps.length ? h("ul", { class: "lane-steps" }, ...lane.steps.map(stepRow)) : null,
      recent.length ? h("ul", { class: "rows" }, ...recent.map((p) => {
        const done = ["succeeded", "failed", "rejected", "cancelled"].includes(p.status);
        return h("li", {}, h("a", { class: "row-link", href: link("projects", p.id) },
          h("span", { class: "row-main" }, h("strong", {}, projectTitle(p)),
            h("span", { class: "muted small" }, done ? `historical · finished ${exactTime(p.completed_at)}` : `recorded step: ${p.progress.current_step ? stepLabel(p.progress.current_step) : "none"} (${p.progress.current_step_status ?? "—"}) · created ${relativeTime(p.created_at)}`)),
          badge(word(RUN_STATUS, p.status))));
      })) : null);
  }));
}

function workers(s: EngineStatus): HTMLElement {
  const rows = [
    ...s.workers.connected.map((w) => {
      const running = s.workers.running.filter((r) => r.worker === w.worker_id);
      return h("li", { class: "row-static" }, h("span", { class: "row-main" }, h("strong", {}, w.worker_id),
        h("span", { class: "muted small" }, `session connected · structural analysis ${w.structural_analysis ? "ON" : "off"} · ${running.length ? running.map((r) => `${stepLabel(r.step_key)} ${r.live ? "(live lease)" : "(lease EXPIRED)"}`).join(", ") : "no step leased: idle"}`)),
        badge(running.some((r) => r.live) ? { label: "Working", tone: "cyan", hint: "" } : { label: "Idle", tone: "grey", hint: "" }));
    }),
    ...s.workers.running.filter((r) => !s.workers.connected.some((w) => w.worker_id === r.worker)).map((r) => h("li", { class: "row-static" },
      h("span", { class: "row-main" }, h("strong", {}, r.worker), h("span", { class: "muted small" }, `${stepLabel(r.step_key)} · ${r.workflow_type} · lease ${r.live ? `live until ${exactTime(r.lease_expires_at)}` : `expired ${exactTime(r.lease_expires_at)}`}`)),
      badge(r.live ? { label: "Running", tone: "cyan", hint: "" } : { label: "Lease expired", tone: "red", hint: "No worker is renewing this step." }))),
  ];
  return h("div", {}, rows.length ? h("ul", { class: "rows" }, ...rows) : empty("No worker is connected", "No worker session is visible and no step is leased. Nothing will run until a worker is started (worker activation needs separate approval)."),
    h("details", {}, h("summary", { class: "small" }, "How presence is detected"), h("p", { class: "muted small" }, s.workers.presence_basis)));
}

function stages(s: EngineStatus): HTMLElement {
  const st = s.stages; const hyp = st.hypotheses;
  const items: Array<{ name: string; value: string; note: string; tone: Tone }> = [
    st.discovery.installed
      ? { name: "Discovery", value: `${st.discovery.sources} sources`, note: `${st.discovery.enabled_sources} enabled · ${Object.values(st.discovery.opportunities_by_state).reduce((a, b) => a + b, 0)} opportunities · last success ${relativeTime(st.discovery.last_success_at)}`, tone: "cyan" }
      : { name: "Discovery", value: "not installed", note: st.discovery.reason, tone: "grey" },
    { name: "Acquisition", value: `${st.acquisition.snapshots_sealed} sealed`, note: `commit-pinned snapshots · ${st.acquisition.snapshots_building} building`, tone: "cyan" },
    { name: "Protocol map (P1–P3)", value: `${st.protocol_mapping.stored_models} models`, note: `${st.protocol_mapping.schema}, stored per analysed snapshot`, tone: "cyan" },
    { name: "Hypotheses (leads)", value: String(hyp.total), note: `${hyp.by_status["unreviewed"] ?? 0} awaiting review · ${hyp.note}`, tone: "amber" },
    { name: "Validation", value: `${st.validation.evaluations} evaluations`, note: `${st.validation.blinded_reviews} blinded reviews · ${st.evidence_spans} evidence spans`, tone: "cyan" },
    { name: "Adjudication", value: "0 confirmed", note: `${st.adjudication.disclosed_adjudications} disclosed adjudications recorded · ${st.adjudication.note}`, tone: "grey" },
    { name: "Memory", value: "not built", note: st.memory.note, tone: "grey" },
  ];
  return h("ol", { class: "pipeline" }, ...items.map((i) => h("li", { class: `pipe-stage tone-${i.tone}` }, h("span", { class: "pipe-name" }, i.name), h("strong", { class: "pipe-value" }, i.value), h("span", { class: "pipe-note muted small" }, i.note))));
}

function lastActivity(s: EngineStatus): HTMLElement {
  const f = s.last.failure;
  return kv([
    ["Last run created", s.last.run ? h("span", {}, `${s.last.run.workflow_type} · ${word(RUN_STATUS, s.last.run.status).label} · `, h("time", { title: exactTime(s.last.run.created_at) }, relativeTime(s.last.run.created_at)), ` · by ${s.last.run.created_by}`) : "never"],
    ["Last successful step", s.last.step_success ? `${stepLabel(s.last.step_success.step_key)} (${s.last.step_success.workflow_type}) · ${exactTime(s.last.step_success.completed_at)}` : "never"],
    ["Last failure", f ? h("span", {}, `${stepLabel(f.step_key)} (${f.workflow_type}), attempt ${f.attempt}, ${exactTime(f.at)}: `, h("span", { class: "tone-red-text" }, f.error.message), f.error.retryable === null ? "" : f.error.retryable ? " (retryable)" : " (not retryable)") : "none recorded"],
  ]);
}

function buildSchema(s: EngineStatus): HTMLElement {
  const sc = s.schema;
  return kv([
    ["Build commit", s.build.commit ? mono(shortHash(s.build.commit, 12)) : h("span", { class: "muted" }, "unidentified (no build-info.json in this build)")],
    ["Image", s.build.image ? mono(s.build.image) : "—"], ["Built", s.build.built_at ? exactTime(s.build.built_at) : "—"],
    ["Migrations", !sc.ledger_readable ? h("span", { class: "tone-red-text" }, "the migration ledger is not readable by this database role") : `${sc.applied!.length} applied${sc.expected ? ` of ${sc.expected.length} shipped` : ""}`],
    ["Not applied", sc.missing && sc.missing.length ? h("span", { class: "tone-red-text" }, sc.missing.join(", ")) : sc.missing ? "none" : "unknown"],
    ["Unknown to this build", sc.unknown && sc.unknown.length ? sc.unknown.join(", ") : "none"],
    ["Engine status schema", s.version],
  ]);
}

function discoveryPanel(ctx: Ctx, s: EngineStatus): HTMLElement {
  if (!s.stages.discovery.installed) return empty("Discovery is not installed here", `${s.stages.discovery.reason}. Applying it is a separate approval (migration).`);
  const box = h("div", {});
  loadInto(box, () => Promise.all([ctx.api.get<{ sources: DiscoverySource[] }>("/v1/discovery/sources"), ctx.api.get<{ opportunities: Opportunity[] }>("/v1/discovery/opportunities", { limit: 10 })]), ([src, opp]) => h("div", { class: "stack" },
    src.sources.length === 0 ? empty("No discovery sources", "No source has been registered, so nothing is polled.") : h("ul", { class: "rows" }, ...src.sources.map((x) => h("li", { class: "row-static" },
      h("span", { class: "row-main" }, h("strong", {}, x.display_name), h("span", { class: "muted small" }, `${x.adapter} · every ${duration(x.min_interval_seconds)} · last attempt ${relativeTime(x.last_attempt_at)} · last success ${relativeTime(x.last_success_at)}${x.consecutive_failures ? ` · ${x.consecutive_failures} consecutive failures` : ""}`)),
      chip(x.enabled ? "enabled" : "disabled", x.enabled ? "cyan" : "grey")))),
    opp.opportunities.length === 0 ? empty("No opportunities", "Nothing has been discovered yet.") : h("ul", { class: "rows" }, ...opp.opportunities.map((o) => h("li", { class: "row-static" },
      h("span", { class: "row-main" }, h("strong", {}, o.title), h("span", { class: "muted small" }, `${o.platform} · priority ${o.priority_score}/100 (rule-based) · first seen ${exactTime(o.first_seen_at)}`)), chip(o.state)))),
    h("p", { class: "muted small" }, "Read only. This page never polls a source; only a worker does, and none is approved to.")));
  return box;
}

export function controlBody(ctx: Ctx, s: EngineStatus, projects: ProjectSummary[]): HTMLElement {
  if (!s?.engine || !s.stages) return empty("Engine status unrecognised", "The backend answered, but not in the engine-status/1 shape this page understands. Nothing is shown rather than a guess.");
  const state = word(ENGINE_STATE, s.engine.state);
  const kind = word(DATA_KIND, s.data_kind);
  return h("div", { class: "control-grid" },
    s.data_kind === "production" ? null : h("p", { class: `callout data-kind tone-${kind.tone}`, role: s.data_kind === "synthetic" ? "alert" : null }, kind.label, h("span", { class: "muted small" }, ` ${kind.hint}`)),
    panel("Engine", [
      h("div", { class: "engine-state" }, h("span", { class: `engine-badge tone-${state.tone}` }, state.label), h("p", { class: "engine-sentence" }, engineSentence(s))),
      s.engine.reasons.length ? h("ul", { class: "reasons" }, ...s.engine.reasons.map((r) => h("li", {}, r))) : null,
      h("p", { class: "muted small" }, s.data_kind === "production" ? chip(kind.label, kind.tone) : null, ` Queue order: ${s.queue.order_basis}.`),
    ], { class: "area-engine" }),
    panel("Workers", [workers(s)], { class: "area-workers" }),
    panel("Research stages", [stages(s), h("p", { class: "muted small" }, "A hypothesis is a lead to investigate. No confirmed finding is recorded anywhere in this system yet.")], { class: "area-stages" }),
    panel("Research lanes", [lanes(s, projects)], { class: "area-lanes", actions: [h("a", { class: "link", href: "#/operations" }, "Operations"), h("a", { class: "link", href: link("projects") }, "All projects")] }),
    panel("Last activity", [lastActivity(s)], { class: "area-last", actions: [h("a", { class: "link", href: link("activity") }, "Activity")] }),
    panel("Discovery", [discoveryPanel(ctx, s)], { class: "area-discovery" }),
    panel("Build and schema", [buildSchema(s)], { class: "area-build" }));
}

export function renderControl(ctx: Ctx): HTMLElement {
  const root = h("div", { class: "view view-control" });
  root.append(h("div", { class: "view-head" }, h("h1", {}, "Control Room"), h("a", { class: "btn ops-link", href: "#/operations" }, "Live operations ▸"), h("p", { class: "muted" }, "What the engine is doing now, read from the database on every refresh. Nothing here is sample or simulated data unless the banner says so.")),
    livePanel(() => Promise.all([ctx.api.get<EngineStatus>("/v1/engine/status"), ctx.api.get<Page<ProjectSummary>>("/v1/research/projects", { limit: 50 })]),
      ([s, p]) => controlBody(ctx, s, p?.items ?? []), { generatedAt: ([s]) => s?.generated_at ?? null }));
  return root;
}

