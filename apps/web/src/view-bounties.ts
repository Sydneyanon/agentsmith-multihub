import { clear, h, type Child } from "./dom.js";
import { ApiError } from "./api.js";
import { chip, empty, errorState, kv, loadInto, panel, statCard } from "./components.js";
import type { Ctx } from "./ctx.js";
import { link } from "./router.js";
import { exactTime, relativeTime } from "./format.js";

/**
 * Bounty intelligence, operator side (bearer-protected). Import a URL or pasted text, see exactly what the import did, watch
 * collection health per source, review possible duplicates, and correct a record. The public, read-only view is /bounties/.
 */
type Report = { importId: string; status: string; urlKind: string; retrieved: boolean; retrieval: string; discovered: number; added: number; matched: number; updated: number; needsVerification: number;
  items: Array<{ programId: string; project: string; outcome: string; matchBasis: string; verification: string; status: string; maxReward: unknown; officialUrl: unknown }>; limitations: string[]; unresolvedLinks: string[]; ignoredSegments: number };
type Source = { source_key: string; display_name: string; kind: string; enabled: boolean; access_status: string; access_note: string; collection_method: string; last_success_at: string | null; last_attempt_at: string | null;
  last_error: string | null; consecutive_failures: number; next_attempt_at: string | null; observations: number; listed: number; programs_shown: number;
  last_check: { outcome: string; started_at: string; listings_extracted: number; programs_added: number; programs_updated: number; observations_unchanged: number; duplicates_matched: number; needs_verification: number; delisted: number; error: string | null; http_status: number | null; pages: number } | null };

const TABS: Array<[string, string]> = [["import", "Add bounty / Import URL"], ["health", "Collection health"], ["coverage", "Research coverage"], ["lifecycle", "Programme lifecycle"], ["duplicates", "Possible duplicates"], ["records", "Records"]];

/** Ordered ladder + side states, with labels and tones. Mirrors apps/api/src/bounties/lifecycle.ts (kept in sync by the counts test). */
const LIFECYCLE: Array<[string, string, string]> = [
  ["discovered", "Discovered", "grey"], ["officially_verified", "Officially verified", "cyan"], ["scope_retrieved", "Scope retrieved", "cyan"],
  ["smart_contract_target_confirmed", "SC target confirmed", "cyan"], ["reward_confirmed", "Reward confirmed", "cyan"], ["eligible_for_research", "Eligible for research", "green"],
  ["queued_for_scan", "Queued for scan", "amber"], ["scanning", "Scanning", "cyan"], ["scanned", "Scanned", "violet"],
  ["finding_under_review", "Finding under review", "amber"], ["completed", "Completed", "green"],
];
const LIFECYCLE_SIDE: Array<[string, string, string]> = [
  ["needs_verification", "Needs verification", "amber"], ["out_of_engine_scope", "Out of engine scope", "grey"], ["ineligible", "Not a vuln bounty", "grey"],
  ["paused", "Paused", "grey"], ["unavailable", "Unavailable", "grey"], ["source_restricted", "Source restricted", "grey"],
];
const toneOf = (s: string) => (s === "succeeded" || s === "fetched" || s === "official_confirmed" || s === "active" || s === "added" ? "green" : s === "failed" || s === "conflicting" ? "red" : s === "blocked" || s.startsWith("skipped") || s === "partial" ? "amber" : "grey");

export function renderBounties(ctx: Ctx, sub: string | undefined, id: string | undefined, query: Record<string, string>): HTMLElement {
  const tab = TABS.some(([k]) => k === sub) ? sub! : "import";
  const body = h("div", {});
  const view = h("div", { class: "view" },
    h("div", { class: "view-head" }, h("h1", {}, "Bounty intelligence"), h("p", { class: "muted" }, "Collection of public bug bounty programmes. Separate from the research engine: nothing here starts research or touches a target. ",
      h("a", { href: "/bounties/", class: "link" }, "Open the public dashboard ↗"))),
    h("nav", { class: "toolbar", "aria-label": "Bounty sections" }, ...TABS.map(([k, label]) => h("a", { class: `btn${k === tab ? " btn-primary" : ""}`, href: link("bounties", k), "aria-current": k === tab ? "page" : null }, label))),
    body);
  if (tab === "import") body.append(importTab(ctx));
  else if (tab === "health") body.append(healthTab(ctx));
  else if (tab === "coverage") body.append(coverageTab(ctx));
  else if (tab === "lifecycle") body.append(lifecycleTab(ctx));
  else if (tab === "duplicates") body.append(duplicatesTab(ctx));
  else body.append(id ? recordDetail(ctx, id) : recordsTab(ctx, query));
  return view;
}

function reportView(r: Report): HTMLElement {
  return h("div", { class: "import-report", role: "status" },
    h("p", {}, chip(r.status.toUpperCase(), toneOf(r.status) as never), " ", r.retrieved ? `Retrieved: ${r.retrieval}.` : `Not retrieved: ${r.retrieval || "see below"}.`),
    h("div", { class: "stats" }, statCard("discovered", r.discovered, "opportunities found in this input"), statCard("added", r.added, "new records", "green"), statCard("matched", r.matched, "already known", "cyan"),
      statCard("updated", r.updated, "changed records", "violet"), statCard("need verification", r.needsVerification, "not officially confirmed", "amber")),
    r.limitations.length ? h("ul", { class: "callout callout-warn" }, ...r.limitations.map((l) => h("li", {}, l))) : null,
    r.items.length ? h("table", { class: "table" }, h("thead", {}, h("tr", {}, ...["Project", "Outcome", "Matched by", "Verification", "Status", "Max reward"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...r.items.map((i) => h("tr", {}, h("td", {}, h("a", { class: "link", href: link("bounties", "records", i.programId) }, i.project)), h("td", {}, chip(i.outcome, toneOf(i.outcome) as never)),
        h("td", {}, i.matchBasis.replace(/_/g, " ")), h("td", {}, i.verification.replace(/_/g, " ")), h("td", {}, i.status.replace(/_/g, " ")), h("td", {}, i.maxReward === null ? "not stated" : String(i.maxReward)))))) : null);
}

function importTab(ctx: Ctx): HTMLElement {
  const url = h("input", { id: "imp-url", type: "url", placeholder: "https://… (programme page, roundup, community listing or X post/profile)", autocomplete: "off" });
  const text = h("textarea", { id: "imp-text", rows: 6, placeholder: "Optional: paste the text of an X post or thread, or of a page that cannot be fetched. It is imported with the URL above as its source." });
  const thread = h("input", { id: "imp-thread", type: "checkbox" });
  const out = h("div", {}); const history = h("div", {});
  const button = h("button", { class: "btn btn-primary", type: "submit" }, "Import");
  const loadHistory = () => loadInto(history, () => ctx.api.get<{ imports: Array<{ id: string; submitted_url: string | null; url_kind: string; submitted_at: string; status: string; report: Report }> }>("/v1/bounties/imports"),
    (d) => d.imports.length ? h("table", { class: "table" }, h("thead", {}, h("tr", {}, ...["Submitted", "URL / text", "Kind", "Result", "Found / added"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...d.imports.map((i) => h("tr", {}, h("td", { title: exactTime(i.submitted_at) }, relativeTime(i.submitted_at)), h("td", { class: "mono" }, (i.submitted_url ?? "(pasted text)").slice(0, 90)),
        h("td", {}, i.url_kind.replace(/_/g, " ")), h("td", {}, chip(i.status, toneOf(i.status) as never)), h("td", {}, `${i.report?.discovered ?? 0} / ${i.report?.added ?? 0}`))))) : empty("No imports yet", "Imports you submit appear here with what each one found."));
  const form = h("form", { class: "form", onsubmit: (e: Event) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (url.value.trim()) body.url = url.value.trim();
    if (text.value.trim()) body.text = text.value.trim();
    if (thread.checked) body.kind = "x_thread";
    if (!body.url && !body.text) { clear(out); out.append(h("p", { class: "callout callout-warn", role: "alert" }, "Give a URL, pasted text, or both.")); return; }
    button.setAttribute("disabled", ""); clear(out); out.append(h("p", { class: "muted", role: "status" }, "Importing… (fetching at most one page, honouring robots.txt)"));
    ctx.api.post<Report>("/v1/bounties/imports", body).then((r) => { clear(out); out.append(reportView(r)); loadHistory(); },
      (err: unknown) => { clear(out); const b = err instanceof ApiError ? err.body as Report | { error: string; message?: string } | undefined : undefined;
        if (b && "importId" in b) out.append(reportView(b)); else out.append(b && "message" in b && b.message ? h("p", { class: "callout callout-warn", role: "alert" }, `${b.error}: ${b.message}`) : errorState(err)); loadHistory(); })
      .finally(() => button.removeAttribute("disabled"));
  } },
    h("label", { for: "imp-url" }, "URL"), url, h("label", { for: "imp-text" }, "Pasted text (optional)"), text,
    h("label", { class: "muted small" }, thread, " The pasted text is a thread (several posts)"),
    h("p", { class: "muted small" }, "Paste any link: a programme page, a project security page, a roundup, a community listing or an X post. Pages built by JavaScript are read from the data they carry. If a page cannot be read (login, robots.txt under the default policy, X threads and profiles), the report says why: paste its text with the URL. Immunefi pages are never fetched (their terms); their programmes are recorded from the URL and enriched from the community board."),
    button);
  loadHistory();
  return h("div", {}, panel("Add bounty / Import URL", [form, out]), panel("Recent imports", [history]));
}

function healthTab(ctx: Ctx): HTMLElement {
  const box = h("div", {}); const out = h("div", {});
  const load = () => loadInto(box, () => ctx.api.get<{ sources: Source[]; runs: Array<{ id: string; trigger: string; started_at: string; finished_at: string | null; status: string }> }>("/v1/bounties/health"), (d) => h("div", {},
    h("table", { class: "table" }, h("thead", {}, h("tr", {}, ...["Source", "Access", "Collected", "Last check", "Extracted / added / updated / unchanged", "Delisted", "Shown", "Error / next attempt"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...d.sources.map((s) => h("tr", {},
        h("td", { title: s.collection_method }, s.display_name), h("td", { title: s.access_note }, chip(`${s.access_status.replace(/_/g, " ")}${s.enabled ? "" : " · off"}`, (s.access_status === "permitted" && s.enabled ? "green" : s.access_status.startsWith("blocked") ? "grey" : "amber") as never)),
        h("td", { title: exactTime(s.last_success_at) }, s.last_success_at ? relativeTime(s.last_success_at) : "never"),
        h("td", {}, s.last_check ? chip(s.last_check.outcome, toneOf(s.last_check.outcome) as never) : "—"),
        h("td", {}, s.last_check ? `${s.last_check.listings_extracted} / ${s.last_check.programs_added} / ${s.last_check.programs_updated} / ${s.last_check.observations_unchanged}` : "—"),
        h("td", {}, s.last_check ? String(s.last_check.delisted) : "—"), h("td", {}, String(s.programs_shown)),
        h("td", { class: "small" }, s.last_error ?? (s.next_attempt_at ? `next ${relativeTime(s.next_attempt_at)}` : ""), s.consecutive_failures ? ` (${s.consecutive_failures} failures)` : null))))),
    h("h3", {}, "Recent runs"),
    d.runs.length ? h("table", { class: "table" }, h("tbody", {}, ...d.runs.map((r) => h("tr", {}, h("td", { title: exactTime(r.started_at) }, relativeTime(r.started_at)), h("td", {}, r.trigger), h("td", {}, chip(r.status, toneOf(r.status) as never)),
      h("td", { class: "muted small" }, r.finished_at ? `${Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000)} s` : "running"))))) : empty("No collection run yet", "Run one below, or wait for the schedule.")));
  const run = h("button", { class: "btn btn-primary", type: "button", onclick: () => {
    run.setAttribute("disabled", ""); clear(out); out.append(h("p", { class: "muted", role: "status" }, "Collecting from every enabled source…"));
    ctx.api.post<{ status: string; checks: Array<{ source: string; outcome: string; listings: number; added: number; error: string | null }> }>("/v1/bounties/collect", {}).then((r) => {
      clear(out); out.append(h("p", {}, chip(r.status, toneOf(r.status) as never), " ", r.checks.map((c) => `${c.source}: ${c.outcome}${c.listings ? ` (${c.listings} listings, ${c.added} new)` : ""}`).join(" · "))); load();
    }, (e: unknown) => { clear(out); out.append(errorState(e)); }).finally(() => run.removeAttribute("disabled"));
  } }, "Collect now");
  load();
  return panel("Collection health", [h("p", { class: "muted small" }, "Configured is not fetched; fetched is not saved; saved is not shown. Each column below is counted separately."), box, h("div", { class: "toolbar" }, run), out]);
}

type Coverage = { programmes: Record<string, number>; repositories: Record<string, number>; rescans: Record<string, number>; failures: Record<string, number>; coverage_pct: Record<string, number | null> };
function coverageTab(ctx: Ctx): HTMLElement {
  const box = h("div", {});
  loadInto(box, () => ctx.api.get<Coverage>("/v1/bounties/coverage"), (c) => {
    const pc = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v}%`);
    return h("div", { class: "stack" },
      h("div", { class: "stats" },
        statCard("discovered", c.programmes.discovered ?? 0, "programmes collected", "grey"),
        statCard("eligible", c.programmes.eligible ?? 0, `${pc(c.coverage_pct.eligible_of_discovered)} of discovered`, "green"),
        statCard("researched", c.programmes.researched ?? 0, `${pc(c.coverage_pct.researched_of_eligible)} of eligible`, "cyan"),
        statCard("awaiting research", c.programmes.awaiting_research ?? 0, "eligible, not yet analysed", "amber")),
      panel("Repositories", [kv([
        ["Eligible-programme repositories", String(c.repositories.eligible ?? 0)],
        ["Analysed (sealed snapshot)", `${c.repositories.analysed ?? 0} (${pc(c.coverage_pct.repos_analysed_of_eligible)})`],
        ["Tracked by the monitor", String(c.repositories.tracked ?? 0)],
        ["Pending rescan (new commit seen)", String(c.repositories.pending_rescan ?? 0)],
        ["Unavailable (deleted / inaccessible)", String(c.repositories.unavailable ?? 0)]])]),
      panel("Incremental rescans", [kv([
        ["Queued", String(c.rescans.queued ?? 0)], ["Running", String(c.rescans.running ?? 0)],
        ["Completed", String(c.rescans.completed ?? 0)], ["Failed", String(c.rescans.failed ?? 0)]])]),
      panel("Failures", [kv([
        ["Research runs failed", String(c.failures.research_runs_failed ?? 0)],
        ["Monitor errors (7 days)", String(c.failures.monitor_errors_7d ?? 0)]])]),
      h("p", { class: "muted small" }, "Every number is measured from the database — not an estimate. “Researched” means a sealed snapshot exists for a programme’s repository; a fetch or a queued run never counts. Findings live in the research overview."));
  });
  return box;
}

function lifecycleTab(ctx: Ctx): HTMLElement {
  const box = h("div", {});
  loadInto(box, () => ctx.api.get<{ total: number; counts: Record<string, number> }>("/v1/bounties/lifecycle"), (d) => {
    const n = (k: string) => d.counts[k] ?? 0;
    const ladder = h("ol", { class: "rows lifecycle-ladder" }, ...LIFECYCLE.map(([k, label, tone]) =>
      h("li", { class: "row-static" }, h("span", { class: "row-main" }, h("strong", {}, label)), chip(String(n(k)), n(k) > 0 ? (tone as never) : "grey"))));
    const side = h("ul", { class: "chips" }, ...LIFECYCLE_SIDE.map(([k, label, tone]) => h("li", {}, chip(`${label}: ${n(k)}`, tone as never))));
    return h("div", { class: "stack" },
      panel("Research pipeline ladder", [
        h("p", { class: "muted small" }, "Each programme sits at exactly one state. These are evidence-based: discovery is not eligibility, and a programme only advances when the records support it. ",
          "Scan states appear once the discovery→research bridge is deployed and the worker runs."),
        ladder], { class: "" }),
      panel("Off the research path", [side], { class: "" }),
      h("p", { class: "muted small" }, `Total programmes: ${d.total}.`));
  });
  return box;
}

function duplicatesTab(ctx: Ctx): HTMLElement {
  const box = h("div", {});
  const load = () => loadInto(box, () => ctx.api.get<{ candidates: Array<{ id: string; reason: string; a_id: string; a_name: string; a_key: string | null; b_id: string; b_name: string; b_key: string | null }> }>("/v1/bounties/duplicates"),
    (d) => d.candidates.length ? h("table", { class: "table" }, h("tbody", {}, ...d.candidates.map((c) => {
      const act = (decision: "merge" | "reject") => () => { ctx.api.post(`/v1/bounties/duplicates/${c.id}/${decision}`, {}).then(load, (e: unknown) => { clear(box); box.append(errorState(e, load)); }); };
      return h("tr", {}, h("td", {}, h("a", { class: "link", href: link("bounties", "records", c.a_id) }, c.a_name), h("div", { class: "muted small mono" }, c.a_key ?? "no platform link")),
        h("td", {}, h("a", { class: "link", href: link("bounties", "records", c.b_id) }, c.b_name), h("div", { class: "muted small mono" }, c.b_key ?? "no platform link")),
        h("td", { class: "small" }, c.reason), h("td", {}, h("button", { class: "btn", type: "button", onclick: act("merge") }, "Merge"), " ", h("button", { class: "btn btn-quiet", type: "button", onclick: act("reject") }, "Not the same")));
    }))) : empty("No open possible duplicates", "Records with the same project name on different platforms appear here for a decision. Nothing is merged automatically except identical platform programme URLs."));
  load();
  return panel("Possible duplicates", [box]);
}

function recordsTab(ctx: Ctx, query: Record<string, string>): HTMLElement {
  const box = h("div", {});
  const q = h("input", { type: "search", placeholder: "Search", value: query.q ?? "" });
  const load = () => loadInto(box, () => ctx.api.get<{ total: number; items: Array<{ id: string; project_name: string; canonical_key: string | null; verification: string; status: string; reward: string | null; priority: string | null }> }>("/v1/bounties", { q: q.value || undefined, sort: "priority", limit: 100 }),
    (d) => d.items.length ? h("table", { class: "table" }, h("thead", {}, h("tr", {}, ...["Project", "Key", "Status", "Verification", "Max reward", "Priority"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...d.items.map((r) => h("tr", {}, h("td", {}, h("a", { class: "link", href: link("bounties", "records", r.id) }, r.project_name)), h("td", { class: "mono small" }, r.canonical_key ?? "—"),
        h("td", {}, r.status.replace(/_/g, " ")), h("td", {}, chip(r.verification.replace(/_/g, " "), toneOf(r.verification) as never)), h("td", {}, r.reward ?? "not stated"), h("td", {}, r.priority ?? "—"))))) : empty("No records", "Nothing matches, or nothing has been collected yet."));
  load();
  return panel("Records", [h("form", { class: "toolbar", onsubmit: (e: Event) => { e.preventDefault(); load(); } }, q, h("button", { class: "btn", type: "submit" }, "Search")), box]);
}

function recordDetail(ctx: Ctx, id: string): HTMLElement {
  const box = h("div", {});
  type Detail = { id: string; project_name: string; canonical_key: string | null; status: string; status_basis: string; verification: string; resolved: Record<string, { value: unknown; source: string; conflicts: Array<{ value: unknown; source: string }> }>;
    explanation: string[] | null; observations: Array<{ source_key: string; display_name: string; source_url: string | null; source_author: string | null; match_basis: string; extraction_method: string; listed: boolean; first_observed_at: string; last_observed_at: string }>;
    changes: Array<{ field: string; old_value: unknown; new_value: unknown; source_key: string | null; changed_at: string }>; merged_into?: string };
  const load = () => loadInto(box, () => ctx.api.get<Detail>(`/v1/bounties/${encodeURIComponent(id)}`), (d) => {
    if (d.merged_into) return h("p", {}, "This record was merged into ", h("a", { class: "link", href: link("bounties", "records", d.merged_into) }, "another record"), ".");
    const field = h("select", {}, ...["maxReward", "rewardCurrency", "officialUrl", "projectName", "programmeName", "chains", "assetTypes", "kycRequired", "statusClaim"].map((f) => h("option", { value: f }, f)));
    const value = h("input", { type: "text", placeholder: "new value (numbers as numbers; lists comma-separated; true/false)" });
    const note = h("input", { type: "text", placeholder: "what the correction is based on (required)" });
    const msg = h("div", {});
    const parse = (f: string, v: string): unknown => f === "maxReward" ? Number(v) : f === "kycRequired" ? v === "true" : f === "chains" || f === "assetTypes" ? v.split(",").map((x) => x.trim()).filter(Boolean) : v;
    const rows: Array<[string, Child]> = Object.entries(d.resolved).filter(([k]) => k !== "description").map(([k, v]) => [k, h("span", {}, JSON.stringify(v.value).slice(0, 200), h("span", { class: "muted small" }, ` · ${v.source}`),
      v.conflicts.length ? h("span", { class: "tone-red-text small" }, ` · conflicts: ${v.conflicts.map((c) => `${JSON.stringify(c.value).slice(0, 60)} (${c.source})`).join("; ")}`) : null)]);
    return h("div", {},
      h("h2", {}, d.project_name), h("p", {}, chip(d.status.replace(/_/g, " "), toneOf(d.status) as never), " ", chip(d.verification.replace(/_/g, " "), toneOf(d.verification) as never), " ", h("span", { class: "muted" }, d.status_basis)),
      kv(rows),
      panel("Sources", [h("table", { class: "table" }, h("tbody", {}, ...d.observations.map((o) => h("tr", {}, h("td", {}, o.display_name), h("td", { class: "small" }, o.source_url ? h("a", { class: "link", href: o.source_url, target: "_blank", rel: "noopener noreferrer" }, o.source_url.slice(0, 70)) : "—"),
        h("td", { class: "small" }, o.source_author ?? ""), h("td", { class: "small" }, `matched by ${o.match_basis.replace(/_/g, " ")}`), h("td", { class: "small" }, o.listed ? `seen ${relativeTime(o.last_observed_at)}` : "no longer listed")))))]),
      panel("Why this priority", [h("ul", {}, ...(d.explanation ?? []).map((x) => h("li", {}, x)))]),
      panel("Change history", [d.changes.length ? h("table", { class: "table" }, h("tbody", {}, ...d.changes.map((c) => h("tr", {}, h("td", { title: exactTime(c.changed_at) }, relativeTime(c.changed_at)), h("td", {}, c.field),
        h("td", { class: "small mono" }, `${JSON.stringify(c.old_value)?.slice(0, 60)} → ${JSON.stringify(c.new_value)?.slice(0, 60)}`), h("td", { class: "small" }, c.source_key ?? ""))))) : empty("No changes", "")]),
      panel("Correct this record", [h("form", { class: "form", onsubmit: (e: Event) => {
        e.preventDefault();
        ctx.api.post(`/v1/bounties/${encodeURIComponent(id)}/corrections`, { field: field.value, value: parse(field.value, value.value), note: note.value }).then(load,
          (err: unknown) => { clear(msg); const b = err instanceof ApiError ? err.body as { error?: string; message?: string } : undefined; msg.append(h("p", { class: "callout callout-warn", role: "alert" }, b?.message ?? b?.error ?? "Correction failed")); });
      } }, field, value, note, h("button", { class: "btn", type: "submit" }, "Save correction"), msg),
      h("p", { class: "muted small" }, "A correction is recorded as an operator source with your note; the original source values stay visible as conflicts.")]));
  });
  load();
  return h("div", {}, h("p", {}, h("a", { class: "link", href: link("bounties", "records") }, "← Records")), box);
}
