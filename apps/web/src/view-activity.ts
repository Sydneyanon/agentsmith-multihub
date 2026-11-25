import { h } from "./dom.js";
import { chip, empty, errorState, loading, panel } from "./components.js";
import { exactTime, relativeTime } from "./format.js";
import { link, linkWith } from "./router.js";
import type { Ctx } from "./ctx.js";
import type { ActivityItem, ActivityPage } from "./types.js";
import { AUTOMATION, stepLabel, word } from "./vocab.js";

function itemLink(a: ActivityItem): string | null {
  if (a.hypothesis_id) return link("hypotheses", a.hypothesis_id);
  if (a.run_id) return link("projects", a.run_id);
  return null;
}

export function renderActivity(ctx: Ctx, query: Record<string, string>): HTMLElement {
  const root = h("div", { class: "view" });
  const automation = query["automation"];
  const list = h("ul", { class: "feed feed-full" });
  const foot = h("div", { class: "pager" });
  let basis = "";
  const note = h("p", { class: "muted small" });
  const filters = h("div", { class: "chips" }, ...[undefined, "automated", "model", "human"].map((a) => h("a", { class: `chip-link${a === automation ? " is-active" : ""}`, href: linkWith("#/activity", { automation: a }), "aria-current": a === automation ? "true" : null }, a ? word(AUTOMATION, a).label : "All")));
  root.append(h("div", { class: "view-head" }, h("h1", {}, "Activity"), h("p", { class: "muted" }, "Research events and workflow audit events, newest first. The label says who acted: a rule or worker, a model, or a person.")), filters, panel("Timeline", [list, foot, note]));
  let next: ActivityPage["next"] = null;
  let total = 0;
  const load = () => {
    foot.replaceChildren(loading());
    ctx.api.get<ActivityPage>("/v1/research/activity", { automation, limit: 50, before: next?.before, before_id: next?.before_id }).then((page) => {
      basis = page.automation_basis; note.textContent = basis;
      for (const a of page.items) {
        const w = word(AUTOMATION, a.automation); const href = itemLink(a);
        list.append(h("li", {}, chip(w.label, w.tone), h("span", { class: "feed-text" }, href ? h("a", { class: "link", href }, a.action.replace(/_/g, " ")) : a.action.replace(/_/g, " "),
          h("span", { class: "muted" }, ` · ${a.entity_type}${a.step_key ? ` · ${stepLabel(a.step_key)}` : ""} · ${a.actor_id}`), a.reason ? h("span", { class: "muted small" }, ` — ${a.reason}`) : null),
          h("time", { class: "muted small", title: exactTime(a.at) }, relativeTime(a.at))));
      }
      total += page.items.length;
      next = page.next;
      foot.replaceChildren(...(total === 0 ? [empty("No activity", automation ? "No events of that kind." : "No events have been recorded yet.")] : []),
        ...(page.has_more ? [h("button", { class: "btn", type: "button", onclick: load }, "Load older")] : total ? [h("span", { class: "muted small" }, "End of timeline")] : []));
    }, (error: unknown) => foot.replaceChildren(errorState(error, load)));
  };
  load();
  return root;
}
