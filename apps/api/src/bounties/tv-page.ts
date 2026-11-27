/**
 * Server-rendered "TV board": a plain, no-JavaScript HTML page for a 10-foot display on an old smart-TV browser
 * (e.g. ~2016 Samsung Tizen / Chromium ~47). All data is baked in at render time and the page refreshes itself with a
 * <meta http-equiv="refresh">, so the TV needs no fetch/XHR, no ES modules and no modern CSS. Styling lives in the
 * external /hub/assets/tv.css (strict CSP: style-src 'self', so no inline <style>). It reads only the public feed, so it
 * carries nothing a token would gate.
 */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);
}

type Prog = {
  project?: unknown; programme?: unknown; platform?: unknown;
  max_reward?: unknown; currency?: unknown; status?: unknown;
  eligibility?: { tier?: unknown } | null;
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Compact money for a TV: $1.5M, $250K, $7,500. */
function reward(max: unknown, currency: unknown): { text: string; none: boolean } {
  const n = num(max);
  if (n === null || n <= 0) return { text: "—", none: true };
  const cur = String(currency ?? "USD").toUpperCase();
  const sym = cur === "USD" ? "$" : "";
  const suffix = cur === "USD" ? "" : ` ${cur}`;
  let body: string;
  if (n >= 1_000_000) body = `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  else if (n >= 1_000) body = `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  else body = n.toLocaleString("en-US");
  return { text: `${sym}${body}${suffix}`, none: false };
}

const TIER_LABEL: Record<string, string> = {
  eligible: "Eligible", needs_verification: "Verify", out_of_engine_scope: "Out of scope", ineligible: "—",
};

export interface TvRenderInput {
  programmes: Prog[];
  eligibility: Record<string, number>;
  sources: Array<{ enabled?: unknown }>;
  generatedAt: string;
  rows?: number;
}

export function renderTvPage(feed: Record<string, unknown>): string {
  const programmes = Array.isArray(feed.programmes) ? (feed.programmes as Prog[]) : [];
  const eligibility = (feed.eligibility as Record<string, number> | undefined) ?? {};
  const sources = Array.isArray(feed.sources) ? (feed.sources as Array<{ enabled?: unknown }>) : [];
  const rows = 14;

  const total = programmes.length;
  const eligible = num(eligibility.eligible) ?? 0;
  const needsVerification = num(eligibility.needs_verification) ?? 0;
  const liveSources = sources.filter((s) => s.enabled === true).length;

  // Lead with the biggest rewards, then anything else, so the board always looks full and compelling.
  const ranked = [...programmes].sort((a, b) => (num(b.max_reward) ?? -1) - (num(a.max_reward) ?? -1)).slice(0, rows);

  const generated = esc(new Date(String(feed.generated_at ?? Date.now())).toISOString().slice(11, 16));

  const body = ranked.length === 0
    ? `<p class="empty">No programmes to show yet.</p>`
    : `<table class="board"><thead><tr><th>Project</th><th>Platform</th><th>Max reward</th><th>Status</th></tr></thead><tbody>${
        ranked.map((p) => {
          const name = esc(p.project ?? p.programme ?? "—");
          const plat = esc(p.platform ?? "—");
          const r = reward(p.max_reward, p.currency);
          const tier = String(p.eligibility?.tier ?? "");
          const label = TIER_LABEL[tier] ?? esc(p.status ?? "—");
          const pillClass = tier === "eligible" ? "pill eligible" : tier === "needs_verification" ? "pill needs_verification" : "pill";
          return `<tr><td class="proj">${name}</td><td class="plat">${plat}</td>`
            + `<td class="reward${r.none ? " none" : ""}">${esc(r.text)}</td>`
            + `<td><span class="${pillClass}">${esc(label)}</span></td></tr>`;
        }).join("")
      }</tbody></table>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="90">
<meta name="robots" content="noindex, nofollow">
<title>AgentSmith — Bounty Board</title>
<link rel="stylesheet" href="/hub/assets/tv.css">
</head>
<body>
<div class="safe">
<header class="hd"><span class="logo">A</span><span class="brand">AgentSmith<b>MultiHub</b></span><span class="clock">${generated} UTC · live board</span></header>
<div class="stats">
<div class="stat"><span class="v">${esc(total)}</span><span class="l">Programmes</span></div>
<div class="stat"><span class="v">${esc(eligible)}</span><span class="l">Eligible</span></div>
<div class="stat amber"><span class="v">${esc(needsVerification)}</span><span class="l">Needs verify</span></div>
<div class="stat teal"><span class="v">${esc(liveSources)}</span><span class="l">Live sources</span></div>
</div>
${body}
<footer class="ft">AgentSmith MultiHub · public bounty intelligence · auto-refreshes every 90 s · figures from public programme listings</footer>
</div>
</body>
</html>`;
}
