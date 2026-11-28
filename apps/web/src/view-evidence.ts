import { h } from "./dom.js";
import { badge, chip, codeBlock, empty, errorState, kv, loadInto, mono, pagerBar, panel } from "./components.js";
import { exactTime, shortHash } from "./format.js";
import { link, linkWith } from "./router.js";
import type { Ctx } from "./ctx.js";
import type { EvidenceDetail, EvidenceRow, Page } from "./types.js";
import { HYPOTHESIS_STATUS, word } from "./vocab.js";

export function renderEvidence(ctx: Ctx, id: string | undefined, query: Record<string, string>): HTMLElement {
  return id ? renderSpan(ctx, id) : renderList(ctx, query);
}

function renderList(ctx: Ctx, query: Record<string, string>): HTMLElement {
  const root = h("div", { class: "view" });
  const body = h("div", {});
  const offset = Number(query["offset"] ?? 0) || 0;
  const { snapshot, run, path } = query;
  root.append(h("div", { class: "view-head" }, h("h1", {}, "Evidence"), h("p", { class: "muted" }, "Line ranges in a pinned snapshot, checked against the stored bytes when they are inserted.")), body);
  loadInto(body, () => ctx.api.get<Page<EvidenceRow>>("/v1/research/evidence", { snapshot, run, path, offset, limit: 25 }), (page) => {
    if (page.items.length === 0) return empty("No evidence spans", "No span has been recorded. Spans are created together with hypotheses by the analysis tasks (5.5).", "Task 5.5");
    return h("div", {}, h("ul", { class: "rows" }, ...page.items.map((e) => h("li", {}, h("a", { class: "row-link", href: link("evidence", e.id) },
      h("span", { class: "row-main" }, h("strong", { class: "mono" }, `${e.path}:${e.line_start}-${e.line_end}`), h("span", { class: "muted small" }, `${e.repository} @ ${shortHash(e.commit_sha, 8)}`)),
      chip(`${e.cited_by_hypotheses} hypotheses`, e.cited_by_hypotheses ? "amber" : "grey"), chip(`${e.cited_by_evaluations} evaluations`, "grey"))))),
      pagerBar({ hasMore: page.has_more, offset: page.offset, limit: page.limit, go: (o) => ctx.go(linkWith("#/evidence", { snapshot, run, path, offset: o ? String(o) : undefined })) }));
  });
  return root;
}

function renderSpan(ctx: Ctx, id: string): HTMLElement {
  const root = h("div", { class: "view" });
  const body = h("div", {});
  root.append(h("p", {}, h("a", { class: "link", href: link("evidence") }, "← Evidence")), body);
  loadInto(body, () => ctx.api.get<EvidenceDetail>(`/v1/research/evidence/${id}`, { context: 4 }), (d) => {
    const s = d.span;
    const lines = [...(d.context?.before ?? []).map((l) => ({ no: l.line, text: l.text, mark: false })),
      ...(d.resolution.ok ? d.resolution.text.split(/\r\n|\r|\n/).map((text, i) => ({ no: s.line_start + i, text, mark: true })) : []),
      ...(d.context?.after ?? []).map((l) => ({ no: l.line, text: l.text, mark: false }))];
    return h("div", { class: "stack" },
      h("div", { class: "view-head" }, h("h1", { class: "mono" }, `${s.path}:${s.line_start}-${s.line_end}`)),
      panel("Excerpt", [d.resolution.ok ? codeBlock(lines) : h("p", { class: "callout callout-warn" }, `Does not resolve against stored bytes: ${d.resolution.reason}.`)]),
      panel("Record", [kv([["Snapshot", h("a", { class: "link", href: linkWith(link("repository", s.snapshot_id), { path: s.path }) }, `${s.repository} @ ${shortHash(s.commit_sha, 12)}`)], ["Blob", mono(shortHash(s.blob_sha256, 16))], ["Excerpt hash", mono(shortHash(s.excerpt_sha256, 16))],
        ["Recorded", exactTime(s.created_at)], ["Database verification", h("pre", { class: "json" }, JSON.stringify(d.verification, null, 2))]])]),
      panel("Cited by", [d.cited_by.hypotheses.length + d.cited_by.evaluations.length === 0 ? empty("Not cited", "No hypothesis or evaluation cites this span.") : h("ul", { class: "rows" },
        ...d.cited_by.hypotheses.map((x) => h("li", {}, h("a", { class: "row-link", href: link("hypotheses", x.id) }, h("span", { class: "row-main" }, h("strong", {}, x.claim), h("span", { class: "muted small" }, `${x.family} · ${x.role}`)), badge(word(HYPOTHESIS_STATUS, x.status))))),
        ...d.cited_by.evaluations.map((x) => h("li", {}, h("a", { class: "row-link", href: link("hypotheses", x.hypothesis_id) }, h("span", { class: "row-main" }, h("strong", {}, `Evaluation ${x.evaluator_id}`), h("span", { class: "muted small" }, x.outcome)), chip("automated rule", "cyan")))))]));
  });
  void errorState;
  return root;
}
