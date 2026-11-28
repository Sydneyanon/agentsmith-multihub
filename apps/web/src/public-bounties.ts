import { clear, h, mount, type Child } from "./dom.js";

/**
 * Public bounty intelligence dashboard (/bounties/). Reads only GET /public/bounties.json; it has no token and no write path.
 * Every label reflects what the backend recorded: "confirmed" appears only for records an official platform listing confirmed
 * within 48 hours, and community or social reports are labelled as reports. Nothing is computed here except filtering and sorting.
 */
export type Programme = {
  id: string; key: string | null; project: string; programme: string | null; platform: string | null; official_url: string | null;
  max_reward: number | null; currency: string | null; reward_type: string | null; reward_source: string | null; reward_conflicts: number;
  tiers: Array<{ severity: string; asset: string | null; min: number | null; max: number | null }>;
  chains: string[]; asset_types: string[]; technologies: string[]; categories: string[]; kyc: boolean | null; fee: { amount: number; note: string | null } | null;
  launched: string | null; source_updated: string | null; status: string; status_basis: string; verification: string; priority: number | null;
  components: Record<string, { score: number | null; why: string }> | null; explanation: string[] | null;
  first_seen: string; last_checked: string | null; last_verified: string | null; updated: string; sources: Array<{ source: string; url: string | null; listed: boolean }>;
  eligibility?: { tier: string; engineSuitable: boolean; confirmable: string; reasons: string[] };
};
export type Feed = { generated_at: string; scoring_version: string; overview: Record<string, unknown>; eligibility?: Record<string, number>; programmes: Programme[];
  sources: Array<{ key: string; name: string; kind: string; enabled: boolean; access_status: string; access_note: string; last_success_at: string | null; programmes: number; last_outcome: string | null }> };
export type Filters = { q: string; chain: string; tech: string; source: string; status: string; verification: string; eligibility: string; minReward: number; sort: string; includeRecovery: boolean };
export const DEFAULT_FILTERS: Filters = { q: "", chain: "", tech: "", source: "", status: "", verification: "", eligibility: "", minReward: 0, sort: "priority", includeRecovery: false };

export const ELIGIBILITY: Record<string, { label: string; tone: string; hint: string }> = {
  eligible: { label: "Eligible to hunt", tone: "ok", hint: "Officially confirmed, smart-contract scoped, reward stated. A human still verifies the exact repository and scope before any investigation." },
  needs_verification: { label: "Candidate · needs verification", tone: "waiting", hint: "Smart-contract scoped with a stated reward, but not yet confirmed on an official source by AgentSmith." },
  out_of_engine_scope: { label: "Out of engine scope", tone: "seen", hint: "A real bounty, but not smart-contract work this engine analyses (web/app only, or no recognised official URL)." },
  ineligible: { label: "Not a vuln bounty", tone: "seen", hint: "A recovery/forensics bounty, or no reward stated." },
};
export const VERIFICATION: Record<string, { label: string; tone: string; hint: string }> = {
  official_confirmed: { label: "Official · confirmed", tone: "ok", hint: "Listed on its official platform; AgentSmith confirmed the listing within the last 48 hours." },
  official_stale: { label: "Official · check stale", tone: "waiting", hint: "Listed on its official platform, but the last confirmation is older than 48 hours." },
  conflicting: { label: "Sources disagree", tone: "flagged", hint: "Sources give different values for a material field (usually the reward). The official value is shown." },
  community_reported: { label: "Community report", tone: "queued", hint: "Reported by the community bounty board. Not confirmed on an official source by AgentSmith." },
  social_reported: { label: "X post only", tone: "stalled", hint: "Known only from a social-media post." },
  unverified: { label: "Unverified", tone: "seen", hint: "No source confirms it." },
};
export const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: "Active", tone: "ok" }, reported_active: { label: "Listed (community)", tone: "waiting" }, paused: { label: "Paused", tone: "stalled" }, closed: { label: "Closed", tone: "seen" },
  no_longer_listed: { label: "No longer listed", tone: "seen" }, unknown: { label: "Unknown", tone: "seen" }, requires_verification: { label: "Needs verification", tone: "flagged" },
};
export const SOURCE_NAME: Record<string, string> = { "community-board": "Community board", sherlock: "Sherlock", hackenproof: "HackenProof", immunefi: "Immunefi", cantina: "Cantina", x: "X", "web-import": "Imported page" };
const RECOVERY = /\b(post-incident|forensics|hack (bounty|recovery)|recovery (bounty|program)|bounty hunt|stolen funds|exploiter)\b/i;
export const isRecovery = (p: Programme) => RECOVERY.test(`${p.project} ${p.programme ?? ""}`);

export function money(n: number | null, currency: string | null): string {
  if (n === null) return "not stated";
  const s = n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k` : String(n);
  const usd = !currency || /^(USD|USDC|USDT|DAI)\b/i.test(currency);
  return usd ? `$${s}${currency && currency.toUpperCase() !== "USD" ? ` ${currency}` : ""}` : `${s} ${currency}`;
}
export function when(iso: string | null, now = new Date()): string {
  if (!iso) return "—";
  const d = (now.getTime() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return "—";
  if (d < 90) return "just now"; if (d < 5400) return `${Math.round(d / 60)} min ago`; if (d < 129600) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

/** Filtering and sorting, pure so it can be tested without a browser. */
export function applyFilters(list: readonly Programme[], f: Filters): Programme[] {
  const q = f.q.trim().toLowerCase();
  const out = list.filter((p) => {
    if (!f.includeRecovery && isRecovery(p)) return false;
    if (q && !`${p.project} ${p.programme ?? ""} ${p.key ?? ""} ${p.platform ?? ""}`.toLowerCase().includes(q)) return false;
    if (f.chain && !p.chains.some((c) => c.toLowerCase() === f.chain.toLowerCase())) return false;
    if (f.tech && ![...p.technologies, ...p.asset_types, ...p.categories].some((t) => t.toLowerCase().includes(f.tech.toLowerCase()))) return false;
    if (f.source && !(p.sources.some((s) => s.source === f.source) || (p.platform ?? "").toLowerCase() === f.source.toLowerCase())) return false;
    if (f.status && p.status !== f.status) return false;
    if (f.verification === "needs" ? p.verification === "official_confirmed" : f.verification && p.verification !== f.verification) return false;
    if (f.eligibility && (p.eligibility?.tier ?? "") !== f.eligibility) return false;
    if (f.minReward > 0 && (p.max_reward === null || p.max_reward < f.minReward)) return false;
    return true;
  });
  const by: Record<string, (a: Programme, b: Programme) => number> = {
    priority: (a, b) => (b.priority ?? -1) - (a.priority ?? -1) || (b.max_reward ?? -1) - (a.max_reward ?? -1),
    reward: (a, b) => (b.max_reward ?? -1) - (a.max_reward ?? -1) || (b.priority ?? -1) - (a.priority ?? -1),
    discovered: (a, b) => b.first_seen.localeCompare(a.first_seen),
    updated: (a, b) => b.updated.localeCompare(a.updated),
    completeness: (a, b) => (b.components?.completeness?.score ?? -1) - (a.components?.completeness?.score ?? -1) || (b.priority ?? -1) - (a.priority ?? -1),
  };
  return out.sort((a, b) => (by[f.sort] ?? by.priority!)(a, b) || a.project.localeCompare(b.project));
}

const chip = (text: string, tone: string, title?: string) => h("span", { class: `chip k-${tone}`, ...(title ? { title } : {}) }, text);
const ext = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow" }, text);

function card(p: Programme, open: (p: Programme) => void): HTMLElement {
  const v = VERIFICATION[p.verification] ?? { label: p.verification, tone: "seen", hint: "unrecognised" };
  const s = STATUS[p.status] ?? { label: p.status, tone: "seen" };
  return h("article", { class: "bcard", tabindex: "0", role: "button", "aria-label": `${p.project}: details`, onclick: () => open(p), onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === "Enter") open(p); } },
    h("div", { class: "bcard-top" },
      h("div", { class: "bcard-name" }, h("strong", {}, p.project), p.programme && p.programme !== p.project ? h("span", { class: "muted" }, ` · ${p.programme}`) : null),
      h("div", { class: "bcard-reward", title: p.reward_source ? `stated by ${SOURCE_NAME[p.reward_source] ?? p.reward_source}` : "" }, p.max_reward === null ? h("span", { class: "muted" }, "reward not stated") : `up to ${money(p.max_reward, p.currency)}`)),
    h("div", { class: "bcard-meta" }, p.eligibility ? chip((ELIGIBILITY[p.eligibility.tier] ?? { label: p.eligibility.tier }).label, (ELIGIBILITY[p.eligibility.tier] ?? { tone: "seen" }).tone, (ELIGIBILITY[p.eligibility.tier] ?? { hint: "" }).hint) : null, chip(s.label, s.tone), chip(v.label, v.tone, v.hint), p.platform ? chip(p.platform, "seen") : null, p.reward_conflicts ? chip("reward disputed", "flagged", "Another source states a different reward") : null),
    h("div", { class: "bcard-tags" }, [...p.chains.slice(0, 5), ...p.asset_types.slice(0, 3)].join(" · ") || h("span", { class: "muted" }, "scope not stated")),
    h("div", { class: "bcard-foot" }, h("span", { class: "prio", title: "Opportunity priority (0–100): see the detail for how it is calculated" }, p.priority === null ? "priority —" : `priority ${p.priority.toFixed(0)}`),
      h("span", { class: "muted" }, `checked ${when(p.last_checked)} · ${p.sources.length} source${p.sources.length === 1 ? "" : "s"}`)));
}

function detail(p: Programme, close: () => void): HTMLElement {
  const v = VERIFICATION[p.verification] ?? { label: p.verification, tone: "seen", hint: "unrecognised" };
  const rows: Array<[string, Child]> = [
    ["Reward", p.max_reward === null ? "not stated by any source" : `up to ${money(p.max_reward, p.currency)}${p.reward_type ? ` (${p.reward_type.replace(/_/g, " ")})` : ""}${p.reward_source ? ` · stated by ${SOURCE_NAME[p.reward_source] ?? p.reward_source}` : ""}`],
    ["Status", `${(STATUS[p.status] ?? { label: p.status }).label}: ${p.status_basis}`],
    ["Verification", `${v.label}: ${v.hint}`],
    ["Chains", p.chains.join(", ") || "not stated"], ["Scope", [...p.asset_types, ...p.categories].join(", ") || "not stated"], ["Technologies", p.technologies.join(", ") || "not stated"],
    ["KYC", p.kyc === null ? "not stated" : p.kyc ? "required" : "not required"], ["Submission fee", p.fee ? `${p.fee.amount}${p.fee.note ? ` (${p.fee.note})` : ""}` : "none stated"],
    ["Launched", p.launched ?? "—"], ["Source last updated", p.source_updated ?? "—"], ["First seen by AgentSmith", p.first_seen.slice(0, 10)], ["Last checked", p.last_checked ? `${p.last_checked.slice(0, 16).replace("T", " ")} UTC` : "—"],
  ];
  return h("div", { class: "overlay", role: "dialog", "aria-modal": "true", "aria-label": `${p.project} details`, onclick: (e: Event) => { if (e.target === e.currentTarget) close(); } },
    h("div", { class: "panel detail" },
      h("div", { class: "h2" }, p.project.toUpperCase(), h("button", { class: "close", type: "button", onclick: close, "aria-label": "Close" }, "✕")),
      p.programme && p.programme !== p.project ? h("p", { class: "muted" }, p.programme) : null,
      h("p", {}, p.official_url ? ext(p.official_url, `Official programme page${p.platform ? ` on ${p.platform}` : ""} ↗`) : h("span", { class: "muted" }, "No official link known yet")),
      h("dl", { class: "kv" }, ...rows.flatMap(([k, val]) => [h("dt", {}, k), h("dd", {}, val)])),
      p.tiers.length ? h("div", {}, h("div", { class: "h3" }, "REWARD TIERS (AS STATED)"), h("table", { class: "tiers" }, h("tbody", {}, ...p.tiers.map((t) =>
        h("tr", {}, h("td", {}, t.severity), h("td", { class: "muted" }, t.asset ?? ""), h("td", {}, t.max === null ? "see programme" : t.min !== null && t.min !== t.max ? `${money(t.min, p.currency)} – ${money(t.max, p.currency)}` : money(t.max, p.currency))))))) : null,
      h("div", { class: "h3" }, "SOURCES"),
      h("ul", { class: "srcs" }, ...p.sources.map((s) => h("li", {}, `${SOURCE_NAME[s.source] ?? s.source}${s.listed ? "" : " (no longer lists it)"}`, s.url ? " · " : null, s.url ? ext(s.url, "link ↗") : null))),
      h("div", { class: "h3" }, `WHY THIS PRIORITY (${p.priority === null ? "not computed" : p.priority.toFixed(1)})`),
      h("ul", { class: "why" }, ...(p.explanation ?? []).map((x) => h("li", {}, x))),
      h("p", { class: "muted small" }, "Priority ranks how attractive, credible, suitable, complete and fresh the listed information is. It is not a probability of finding a bug or of being paid.")));
}

function select(label: string, value: string, options: Array<[string, string]>, on: (v: string) => void): HTMLElement {
  const el = h("select", { "aria-label": label, onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }, ...options.map(([v, t]) => h("option", { value: v, ...(v === value ? { selected: true } : {}) }, t)));
  return h("label", { class: "fld" }, h("span", {}, label), el);
}

export function render(root: HTMLElement, feed: Feed, filters: Filters, setFilters: (f: Filters) => void, open: (p: Programme | null) => void, selected: Programme | null): void {
  const o = feed.overview as Record<string, number | { source_key: string; last_success_at: string } | null>;
  const last = o.last_successful_collection as { source_key: string; last_success_at: string } | null;
  const shown = applyFilters(feed.programmes, filters);
  const facet = (get: (p: Programme) => string[]) => [...new Set(feed.programmes.flatMap(get))].filter(Boolean).sort((a, b) => a.localeCompare(b));
  const stat = (label: string, value: unknown, kind: string, title = "") => h("div", { class: `stat t-${kind}`, title }, h("div", { class: "v" }, String(value ?? 0)), h("div", { class: "l" }, label));
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const search = h("input", { type: "search", placeholder: "Search project, programme or platform", value: filters.q, "aria-label": "Search", oninput: (e: Event) => set({ q: (e.target as HTMLInputElement).value }) });
  mount(root,
    h("header", { class: "top" },
      h("div", {}, h("div", { class: "title" }, "BOUNTY INTELLIGENCE"), h("div", { class: "sub" }, `Public bug bounty programmes collected from ${feed.sources.filter((s) => s.last_success_at).map((s) => SOURCE_NAME[s.key] ?? s.name).join(", ") || "no source yet"} · last collection ${last ? when(last.last_success_at) : "never"}`)),
      h("a", { class: "btn-import", href: "/hub/#/bounties/import", title: "Operators only: opens the private hub, which asks for the access token" }, "+ Add bounty / Import URL")),
    h("section", { class: "stats" },
      stat("collected leads", o.total, "waiting"),
      stat("eligible to hunt", (feed.eligibility?.eligible ?? 0), "ok", "Officially confirmed, smart-contract scoped, reward stated"),
      stat("candidates (need verification)", (feed.eligibility?.needs_verification ?? 0), "queued", "Smart-contract scoped with a reward, not yet officially confirmed by AgentSmith"),
      stat("engine-suitable", (feed.eligibility?.engine_suitable ?? 0), "waiting", "Smart-contract scope and a recognised official URL"),
      stat("officially confirmed", o.officially_confirmed, "ok"),
      stat("new (7 days)", o.new_7d, "running"), stat("need verification", o.needs_verification, "flagged")),
    h("section", { class: "panel filters", "aria-label": "Search and filters" },
      search,
      h("div", { class: "row" },
        select("Sort", filters.sort, [["priority", "Opportunity priority"], ["reward", "Highest reward"], ["discovered", "Recently discovered"], ["updated", "Recently updated"], ["completeness", "Most complete"]], (v) => set({ sort: v })),
        select("Status", filters.status, [["", "Any status"], ...Object.entries(STATUS).map(([k, v]) => [k, v.label] as [string, string])], (v) => set({ status: v })),
        select("Verification", filters.verification, [["", "Any"], ["needs", "Needs verification"], ...Object.entries(VERIFICATION).map(([k, v]) => [k, v.label] as [string, string])], (v) => set({ verification: v })),
        select("Hunting eligibility", filters.eligibility, [["", "Any"], ...Object.entries(ELIGIBILITY).map(([k, v]) => [k, v.label] as [string, string])], (v) => set({ eligibility: v })),
        select("Chain", filters.chain, [["", "Any chain"], ...facet((p) => p.chains).map((c) => [c, c] as [string, string])], (v) => set({ chain: v })),
        select("Technology / scope", filters.tech, [["", "Any"], ...facet((p) => [...p.asset_types, ...p.technologies, ...p.categories]).slice(0, 80).map((c) => [c, c] as [string, string])], (v) => set({ tech: v })),
        select("Source / platform", filters.source, [["", "Any"], ...facet((p) => [...p.sources.map((s) => s.source), ...(p.platform ? [p.platform] : [])]).map((c) => [c, SOURCE_NAME[c] ?? c] as [string, string])], (v) => set({ source: v })),
        select("Min. reward", String(filters.minReward), [["0", "Any"], ["10000", "$10k+"], ["50000", "$50k+"], ["100000", "$100k+"], ["500000", "$500k+"], ["1000000", "$1M+"]], (v) => set({ minReward: Number(v) })),
        h("label", { class: "fld chk" }, h("input", { type: "checkbox", ...(filters.includeRecovery ? { checked: true } : {}), onchange: (e: Event) => set({ includeRecovery: (e.target as HTMLInputElement).checked }) }), h("span", {}, "include recovery / forensics bounties")))),
    h("div", { class: "count", role: "status" }, `${shown.length} of ${feed.programmes.length} shown`),
    shown.length ? h("section", { class: "grid" }, ...shown.slice(0, 300).map((p) => card(p, open)))
      : h("div", { class: "panel empty" }, feed.programmes.length ? "No opportunity matches these filters." : "No opportunities have been collected yet. The collector has not completed a run against this database."),
    shown.length > 300 ? h("p", { class: "muted" }, `Showing the first 300; narrow the filters to see the rest.`) : null,
    h("section", { class: "panel" }, h("div", { class: "h2" }, "SOURCES"),
      h("table", { class: "srctable" }, h("tbody", {}, ...feed.sources.filter((s) => s.kind !== "operator" && s.kind !== "manual").map((s) => h("tr", {},
        h("td", {}, SOURCE_NAME[s.key] ?? s.name),
        h("td", {}, chip(s.access_status.replace(/_/g, " "), s.access_status === "permitted" ? "ok" : s.access_status.startsWith("blocked") ? "seen" : "waiting", s.access_note)),
        h("td", {}, s.enabled ? (s.last_success_at ? `collected ${when(s.last_success_at)}` : "not collected yet") : "not collected automatically"),
        h("td", { class: "muted" }, `${s.programmes} programmes`)))))),
    h("footer", { class: "foot muted" }, `Programme information only, from public listings. Rewards and scope are as the sources state them; nothing is estimated. Feed generated ${feed.generated_at.slice(0, 16).replace("T", " ")} UTC · ${feed.scoring_version}`),
    selected ? detail(selected, () => open(null)) : null);
  if (document.activeElement === document.body && filters.q) { search.focus(); (search as HTMLInputElement).setSelectionRange(filters.q.length, filters.q.length); }
}

export async function boot(root: HTMLElement, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<void> {
  clear(root); root.append(h("p", { class: "boot" }, "Loading bounty intelligence…"));
  let feed: Feed;
  try {
    const r = await fetchImpl("/public/bounties.json", { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) throw new Error(`the feed answered HTTP ${r.status}`);
    feed = (await r.json()) as Feed;
  } catch (e) {
    mount(root, h("div", { class: "panel empty", role: "alert" }, `The bounty feed could not be loaded: ${(e as Error).message}. Nothing is shown rather than stale or invented data.`));
    return;
  }
  let filters: Filters = { ...DEFAULT_FILTERS }; let selected: Programme | null = null;
  try { const saved = JSON.parse(sessionStorage.getItem("bounty.filters") ?? "null") as Partial<Filters> | null; if (saved) filters = { ...filters, ...saved }; } catch { /* storage unavailable */ }
  const draw = () => render(root, feed, filters, (f) => { filters = f; try { sessionStorage.setItem("bounty.filters", JSON.stringify(f)); } catch { /* ignore */ } draw(); }, (p) => { selected = p; draw(); }, selected);
  draw();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selected) { selected = null; draw(); } });
}

const mountPoint = typeof document !== "undefined" ? document.getElementById("bounty-app") : null;
if (mountPoint) void boot(mountPoint);
