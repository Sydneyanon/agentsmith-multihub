import { h } from "./dom.js";
import { badge, chip, codeBlock, empty, kv, loadInto, mono, pagerBar, panel } from "./components.js";
import { exactTime, relativeTime, shortHash } from "./format.js";
import { link, linkWith } from "./router.js";
import type { Ctx } from "./ctx.js";
import type { HypothesisDetail, HypothesisSummary, Page, Resolution } from "./types.js";
import { AUTOMATION, HYPOTHESIS_STATUS, REVIEW_MODE, word } from "./vocab.js";

type HypothesisPage = Page<HypothesisSummary> & { facets: { status: Record<string, number> } };

export function renderHypotheses(ctx: Ctx, id: string | undefined, query: Record<string, string>): HTMLElement {
  return id ? renderHypothesis(ctx, id) : renderList(ctx, query);
}

function renderList(ctx: Ctx, query: Record<string, string>): HTMLElement {
  const root = h("div", { class: "view" });
  const body = h("div", {});
  const offset = Number(query["offset"] ?? 0) || 0;
  const { status, run, snapshot } = query;
  root.append(h("div", { class: "view-head" }, h("h1", {}, "Hypotheses"), h("p", { class: "muted" }, "Immutable claims with typed provenance. Status is derived by the backend from the evaluations and reviews recorded; the client does not compute it.")), body);
  loadInto(body, () => ctx.api.get<HypothesisPage>("/v1/research/hypotheses", { status, run, snapshot, offset, limit: 25 }), (page) => {
    const total = Object.values(page.facets.status).reduce((a, b) => a + b, 0);
    const chips = h("div", { class: "chips" }, h("a", { class: `chip-link${status ? "" : " is-active"}`, href: linkWith("#/hypotheses", { run, snapshot }) }, `All · ${total}`),
      ...Object.entries(page.facets.status).map(([k, n]) => h("a", { class: `chip-link${status === k ? " is-active" : ""}`, href: linkWith("#/hypotheses", { status: k, run, snapshot }), title: word(HYPOTHESIS_STATUS, k).hint }, `${word(HYPOTHESIS_STATUS, k).label} · ${n}`)));
    if (page.items.length === 0) return h("div", {}, chips, empty(total === 0 ? "No hypotheses" : "None with that status", total === 0 ? "No hypothesis has been registered. They are created by the analysis tasks (5.5) through the research store; nothing is shown until then." : "Choose another status.", total === 0 ? "Task 5.5" : undefined));
    return h("div", {}, chips, h("ul", { class: "rows" }, ...page.items.map((x) => h("li", {}, h("a", { class: "row-link", href: link("hypotheses", x.id) },
      h("span", { class: "row-main" }, h("strong", {}, x.claim), h("span", { class: "muted small" }, `${x.family} · ${x.repository} @ ${shortHash(x.commit_sha, 8)} · ${x.counts.evidence} evidence · ${x.counts.evaluations} evaluations · ${x.counts.blinded_reviews + x.counts.adjudications} reviews`)),
      badge(word(HYPOTHESIS_STATUS, x.status)))))),
      pagerBar({ hasMore: page.has_more, offset: page.offset, limit: page.limit, go: (o) => ctx.go(linkWith("#/hypotheses", { status, run, snapshot, offset: o ? String(o) : undefined })) }));
  });
  return root;
}

function resolutionBlock(r: Resolution, start: number): HTMLElement {
  if (!r.ok) return h("p", { class: "callout callout-warn" }, `This span does not resolve against the stored bytes: ${r.reason}. It is shown as unresolved, not as evidence.`);
  const lines = r.text.split(/\r\n|\r|\n/);
  return codeBlock(lines.map((text, i) => ({ no: start + i, text, mark: true })));
}

function sawMatrix(saw: unknown): HTMLElement {
  if (saw && typeof saw === "object" && !Array.isArray(saw)) {
    return h("ul", { class: "saw" }, ...Object.entries(saw as Record<string, unknown>).map(([k, v]) => h("li", {}, chip(v === true ? "saw" : v === false ? "did not see" : String(v), v === true ? "amber" : "grey"), ` ${k.replace(/_/g, " ")}`)));
  }
  return h("pre", { class: "json" }, JSON.stringify(saw, null, 2));
}

function renderHypothesis(ctx: Ctx, id: string): HTMLElement {
  const root = h("div", { class: "view" });
  const body = h("div", {});
  root.append(h("p", {}, h("a", { class: "link", href: link("hypotheses") }, "← Hypotheses")), body);
  loadInto(body, () => ctx.api.get<HypothesisDetail>(`/v1/research/hypotheses/${id}`), (d) => {
    const w = word(HYPOTHESIS_STATUS, d.status);
    const gen = word(AUTOMATION, d.generator.kind === "model" ? "model" : d.generator.kind === "human" ? "human" : "automated");
    const evidence = d.evidence.length === 0 ? empty("No evidence spans", "This hypothesis cites no code.") : h("div", {}, ...d.evidence.map((e) => h("div", { class: "evidence-item" },
      h("p", {}, chip(e.role, e.role === "primary" ? "cyan" : "grey"), " ", mono(`${e.path}:${e.line_start}-${e.line_end}`), " ", h("a", { class: "link", href: link("evidence", e.span_id) }, "open span")), resolutionBlock(e.resolution, e.line_start))));
    const evals = d.evaluations.length === 0 ? h("p", { class: "muted" }, "No deterministic evaluation has been recorded.") : h("ul", { class: "rows" }, ...d.evaluations.map((e) => h("li", { class: "row-static stack-sm" },
      h("div", {}, chip("Automated rule", "cyan"), " ", mono(`${e.evaluator_id}@${e.evaluator_version}`), " → ", h("strong", {}, e.outcome)), h("p", {}, e.rationale), h("p", { class: "muted small" }, `input ${shortHash(e.input_sha256)} · ${exactTime(e.created_at)} · ${e.span_ids.length} spans`))));
    const reviews = d.reviews.length === 0 ? empty("No reviews recorded", "No blinded assessment or adjudication has been recorded. Recording reviews is built in Task 5.6; this view only displays them.", "Task 5.6") : h("ul", { class: "rows" }, ...d.reviews.map((r) => {
      const mode = word(REVIEW_MODE, r.review_mode);
      return h("li", { class: "row-static stack-sm" }, h("div", {}, badge(mode), " ", chip(r.reviewer_kind === "model" ? "Model" : r.reviewer_kind === "human" ? "Human" : r.reviewer_kind, r.reviewer_kind === "human" ? "amber" : "violet"), " verdict: ", h("strong", {}, r.verdict)),
        h("p", { class: "muted small" }, mode.hint), h("p", {}, r.rationale),
        h("div", {}, h("strong", { class: "small" }, "What the reviewer saw"), sawMatrix(r.reviewer_saw)),
        h("p", { class: "muted small" }, `${r.reviewer_id} · input ${shortHash(r.input_sha256)} · ${exactTime(r.created_at)}`),
        r.model ? h("p", { class: "muted small" }, `model ${r.model.provider ?? "?"}/${r.model.name ?? "?"} · prompt ${r.model.prompt_version ?? "?"}`) : null);
    }));
    const events = h("ol", { class: "timeline" }, ...d.events.map((e) => h("li", {}, chip(e.event_type.replace(/_/g, " "), "grey"), " ", chip(word(AUTOMATION, e.actor_kind === "deterministic_rule" ? "automated" : e.actor_kind).label, word(AUTOMATION, e.actor_kind === "deterministic_rule" ? "automated" : e.actor_kind).tone), " ",
      h("span", { class: "muted small" }, `${e.actor_id ?? ""} · ${relativeTime(e.created_at)}`), e.reason ? h("p", {}, e.reason) : null)));
    return h("div", { class: "stack" },
      h("div", { class: "view-head" }, h("h1", {}, d.claim), badge(w)),
      h("p", { class: "muted" }, w.hint, d.static_conflicts_with_review ? " A static check and a review conflict." : ""),
      panel("Provenance", [kv([["Family", d.family], ["Generator", h("span", {}, chip(gen.label, gen.tone), ` ${d.generator.id}@${d.generator.version}`)], ["Snapshot", h("a", { class: "link", href: link("repository", d.snapshot_id) }, `${d.repository} @ ${shortHash(d.commit_sha, 12)}`)],
        ["Project", h("a", { class: "link", href: link("projects", d.workflow_run_id) }, "open project")], ["Registered", exactTime(d.created_at)], ["Supersedes", d.supersedes_id ? h("a", { class: "link", href: link("hypotheses", d.supersedes_id) }, "earlier hypothesis") : "—"]])]),
      panel("Rationale", [h("p", {}, d.rationale), h("h4", {}, "Required checks"), listOf(d.required_checks), h("h4", {}, "Alternative explanations"), listOf(d.alternative_explanations)]),
      panel("Evidence (resolved from stored bytes)", [evidence]),
      panel("Static evaluations", [evals]), panel("Reviews", [reviews]), panel("Event history", [d.events.length ? events : h("p", { class: "muted" }, "No events.")]));
  });
  return root;
}

function listOf(value: unknown): HTMLElement {
  if (Array.isArray(value) && value.length) return h("ul", {}, ...value.map((v) => h("li", {}, typeof v === "string" ? v : JSON.stringify(v))));
  return h("p", { class: "muted" }, "None recorded.");
}
