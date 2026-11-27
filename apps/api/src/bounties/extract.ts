import { rscFlight } from "./adapters.js";
import { canonicalFromUrl, nameKey, normaliseUrl } from "./canonical.js";
import { amountsIn } from "./money.js";
import { emptyOpportunity, type ExtractedOpportunity } from "./types.js";

/**
 * Deterministic extraction of bounty opportunities from free text (a web page, an X post or thread, a pasted roundup).
 * One input can give several opportunities. Something becomes an opportunity only when it has a bounty-platform programme link,
 * or a bounty keyword together with a stated reward and a name. Unrelated text gives nothing. No AI call is made.
 */
export type Link = { href: string; text: string };
export type TextDocument = { text: string; links: Link[]; baseUrl: string | null; author: string | null; publishedAt: string | null; title: string | null };

const BOUNTY_WORD = /\b(bug ?bount(y|ies)|bounty|bounties|reward|payout|up to|max(imum)? (reward|payout)|whitehat|white-hat|security program(me)?|audit contest)\b/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const BARE_PLATFORM = /\b((?:www\.)?(?:immunefi\.com|cantina\.xyz|audits\.sherlock\.xyz|hackenproof\.com|code4rena\.com|mantis\.inverse\.finance)\/[^\s<>"')\]]+)/gi;
/** Phrases that are never a project name. */
const GENERIC_NAME = /^(up to|max(imum)?|rewards?|paid|total|pool|prize|bount(y|ies)|bug bount(y|ies)|submissions?|critical|high|medium|low|severity|top|new|this week|weekly|today|program(me)?s?|details|apply|scope|in scope)\b/i;
const SECURITY_PATH = /(security|bug-?bounty|bounty|responsible-disclosure|vulnerability-disclosure|whitehat)/i;

/** Plain text and links from HTML. Scripts, styles and comments are removed; nothing is executed. */
export function htmlToDocument(html: string, baseUrl: string): { text: string; links: Link[]; title: string | null } {
  const noScript = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const links: Link[] = [];
  for (const m of noScript.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (m[2] ?? m[3] ?? "").trim(); if (!href || href.startsWith("#") || /^(javascript|mailto|data):/i.test(href)) continue;
    try { links.push({ href: new URL(href, baseUrl).toString(), text: decode(m[4]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() }); } catch { /* unparseable href */ }
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(noScript)?.[1];
  const visible = decode(noScript.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|li|p|h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  // Pages built by JavaScript carry their content as data, not markup: read it too (nothing is executed).
  const embedded = embeddedData(html, baseUrl);
  const seen = new Set(links.map((l) => l.href));
  for (const l of embedded.links) if (!seen.has(l.href)) { seen.add(l.href); links.push(l); }
  const text = embedded.lines.length ? `${visible}\n${embedded.lines.join("\n")}` : visible;
  return { text, links, title: title ? decode(title).trim().slice(0, 300) : embedded.title };
}

const NAME_KEY = /^(name|title|project|projectName|project_name|programName|program_name|programmeName|displayName|org|organization)$/;
const URL_KEY = /^(url|href|link|website|programUrl|program_url|bountyUrl|bounty_url|canonicalUrl)$/i;
const REWARD_KEY = /(bounty|reward|payout|prize)/i;

/**
 * Text and links that a page carries as data: meta descriptions, JSON-LD, Next.js page data (__NEXT_DATA__ and the React Server
 * Components stream) and other <script type="application/json"> blocks. JSON is parsed, never evaluated. A record with a name and a
 * link or a stated reward becomes one line ("<name>: reward up to $<n> <url>"); a reward is read only from a field whose own name says
 * bounty, reward, payout or prize. Bounded: at most 20,000 values walked and 2,000 lines.
 */
export function embeddedData(html: string, baseUrl: string): { lines: string[]; links: Link[]; title: string | null } {
  const lines: string[] = []; const links: Link[] = []; let title: string | null = null;
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!key || !content) continue;
    if (key === "og:title" || key === "twitter:title") title ??= decode(content).slice(0, 300);
    if (key === "og:description" || key === "twitter:description" || key === "description") lines.push(decode(content).slice(0, 1000));
  }
  const blobs: unknown[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? ""; const body = (m[2] ?? "").trim();
    if (!body || !/type\s*=\s*["']application\/(ld\+)?json["']/i.test(attrs)) continue;
    try { blobs.push(JSON.parse(body)); } catch { /* not JSON */ }
  }
  const flight = rscFlight(html);
  if (flight) {
    for (const row of flight.split("\n")) {
      const rest = row.slice(row.indexOf(":") + 1);
      if (/^[[{]/.test(rest)) { try { blobs.push(JSON.parse(rest)); } catch { /* partial row */ } }
    }
  }
  let budget = 20_000;
  const asUrl = (v: unknown): string | null => {
    if (typeof v !== "string" || v.length > 600) return null;
    if (!/^https?:\/\//.test(v) && !v.startsWith("/")) return null;
    try { const u = new URL(v, baseUrl); return /^https?:$/.test(u.protocol) ? u.toString() : null; } catch { return null; }
  };
  const walk = (v: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > 40 || lines.length >= 2000) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const entries = Object.entries(o);
    const name = entries.find(([k, x]) => NAME_KEY.test(k) && typeof x === "string" && x.trim().length >= 2 && x.length <= 120)?.[1] as string | undefined;
    const url = entries.map(([k, x]) => (URL_KEY.test(k) ? asUrl(x) : null)).find((x): x is string => !!x);
    const reward = entries.find(([k, x]) => REWARD_KEY.test(k) && typeof x === "number" && x > 0 && Number.isFinite(x))?.[1] as number | undefined;
    for (const [, x] of entries) {
      const u = typeof x === "string" && /^https?:\/\//.test(x) ? asUrl(x) : null;
      if (u) links.push({ href: u, text: name && u === url ? name : "" });
    }
    if (name && (url || reward !== undefined)) lines.push(`${name.trim()}${reward !== undefined ? `: reward up to $${reward.toLocaleString("en-US")}` : ""}${url ? ` ${url}` : ""}`);
    for (const [, x] of entries) if (x && typeof x === "object") walk(x, depth + 1);
  };
  for (const b of blobs) walk(b, 0);
  return { lines, links: links.slice(0, 5000), title };
}

export function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

/** Splits a post or page into candidate segments: lines, then numbered or bulleted items within long lines. */
export function segments(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const parts = line.split(/(?=(?:^|\s)(?:\d{1,2}[.)]|[•▪◦●►▶→✅🔹🔸🟢🔥💰👉]|-\s)\s+)/u).map((p) => p.trim()).filter(Boolean);
    out.push(...(parts.length > 1 ? parts : [line.trim()]).filter(Boolean));
  }
  return out;
}

/** A display name from a segment: an @handle, or the leading words before a separator, without emoji, bullets, URLs or amounts. */
export function nameFrom(segment: string, link?: Link): string | null {
  const fromLink = link?.text && !/^https?:|\.(com|xyz|io)\b|^(here|link|apply|details|program(me)?)$/i.test(link.text) ? link.text : null;
  const candidate = fromLink ?? segment;
  const handle = /@([A-Za-z0-9_]{2,30})/.exec(candidate)?.[1];
  const cleaned = candidate.replace(URL_IN_TEXT, " ").replace(BARE_PLATFORM, " ").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/^\s*(?:\d{1,2}[.)]|[•▪◦●►▶→-])\s*/u, "")
    .split(/\s(?:[—–|:]|-\s|\(|up to|max(?:imum)?|pays?|offering|with|on (?:immunefi|cantina|sherlock|hackenproof|code4rena))\s?|\$|\bUSD\b/i)[0]!
    .replace(/\b(new|live|launched?|bug ?bounty|bounty|program(me)?|is|now|alert|just|has|a|an|the)\b/gi, " ").replace(/[^\p{L}\p{N} .&'_-]/gu, " ").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 5).join(" ");
  if (words.length >= 2 && /\p{L}/u.test(words) && !GENERIC_NAME.test(words)) return words;
  return handle ?? null;
}

const cleanAnchor = (t: string) => t.replace(/^(triaged by|hosted on|via)\s+\S+\s*/i, "").replace(/\s+/g, " ").trim();

function linkAround(segment: string, links: Link[]): Link | undefined {
  return links.find((l) => l.text && l.text.length > 1 && segment.includes(l.text));
}

/**
 * `page` (a fetched web page's URL) switches to page mode: one opportunity per linked programme; otherwise, when the page itself is a
 * single programme or security page (bounty wording and a stated reward), exactly one opportunity for the page. Line-by-line
 * "name + amount" extraction is for posts and pasted text only: on real web pages it turns card fragments into fake programmes.
 */
export function extractOpportunities(doc: TextDocument, refPrefix: string, opts: { page?: string } = {}): { items: ExtractedOpportunity[]; ignoredSegments: number; unresolvedLinks: string[]; pageNote?: string } {
  const items: ExtractedOpportunity[] = []; const byKey = new Map<string, ExtractedOpportunity>(); const unresolvedLinks: string[] = [];
  const segs = segments(doc.text); let n = 0;
  const add = (o: ExtractedOpportunity, key: string) => { if (byKey.has(key)) return byKey.get(key)!; byKey.set(key, o); items.push(o); return o; };
  const attribution = (o: ExtractedOpportunity) => { o.sourceAuthor = doc.author; o.publishedAt = doc.publishedAt; o.sourceTitle = doc.title; return o; };

  // 1. Every bounty-platform programme link is one opportunity (anchors first, then URLs written in the text).
  const urlsInText = [...doc.text.matchAll(URL_IN_TEXT)].map((m) => m[0]).concat([...doc.text.matchAll(BARE_PLATFORM)].map((m) => `https://${m[1]}`));
  const allLinks: Link[] = [...doc.links, ...urlsInText.map((u) => ({ href: u, text: "" }))];
  for (const l of allLinks) {
    if (/…$|\.\.\.$/.test(l.text) && /^https:\/\/t\.co\//.test(l.href)) { unresolvedLinks.push(`${l.text} (${l.href})`); }
    const url = normaliseUrl(l.href.replace(/[.,;:!?]+$/, "")); const c = canonicalFromUrl(url) ?? (l.text ? canonicalFromUrl(normaliseUrl(`https://${l.text.replace(/^https?:\/\//, "").replace(/…$/, "")}`)) : null);
    if (!c) continue;
    const seg = segs.find((s) => (l.text && s.includes(l.text)) || s.includes(l.href) || (url && s.includes(url.replace(/^https:\/\//, "")))) ?? "";
    // Several anchors often point at one programme (logo, title, "details"); the shortest real name among them is the title.
    const anchorName = allLinks.filter((x) => x.text && canonicalFromUrl(normaliseUrl(x.href))?.key === c.key).map((x) => cleanAnchor(x.text))
      .filter((t) => t.length >= 2 && t.length <= 60 && /\p{L}/u.test(t) && !/[/]|\.(com|xyz|io)\b|^(here|link|apply|details|view|program(me)?|learn more|read more|submit( a)?( report| bug)?|report( a)? (bug|vulnerability)|open|visit|go|more|scope|rewards?)$/i.test(t) && !GENERIC_NAME.test(t)).sort((a, b) => a.length - b.length)[0];
    const name = anchorName ?? nameFrom(seg) ?? (c.platform === "immunefi" || c.platform === "hackenproof" ? c.programmeId.replace(/-/g, " ") : null) ?? c.key;
    const o = add(attribution(emptyOpportunity(`${refPrefix}#${c.key}`, titleCase(name))), c.key);
    o.officialUrl = url && canonicalFromUrl(url)?.key === c.key ? url.split(/[?#]/)[0]! : `https://${platformHost(c.platform)}/${c.platform === "sherlock" ? "bug-bounties" : c.platform === "hackenproof" ? "programs" : c.platform === "immunefi" ? "bug-bounty" : "bounties"}/${c.programmeId}`;
    o.platform = platformName(c.platform);
    const amounts = seg ? amountsIn(seg) : [];
    if (amounts.length && o.maxReward === null) { o.maxReward = Math.max(...amounts); o.rewardCurrency = "USD"; o.rewardType = /up to|max/i.test(seg) ? "up_to" : "fixed"; o.rewardText = seg.slice(0, 200); }
  }

  // 2. Segments that announce a bounty with an amount and a name, but no platform link. Skipped for HTML pages that link programmes
  //    directly: their card text (descriptions, "Up to: $250,000") belongs to the linked programmes, not to new ones.
  //    On such pages a line is still accepted when it says "bug bounty" and links a project security page itself.
  const pageKey = opts.page ? canonicalFromUrl(normaliseUrl(opts.page))?.key ?? null : null;
  const structuredPage = !!opts.page || doc.links.some((l) => canonicalFromUrl(normaliseUrl(l.href)));
  const ownSecurityLink = (seg: string) => /bug ?bount/i.test(seg) && [...seg.matchAll(URL_IN_TEXT)].some((m) => SECURITY_PATH.test(m[0]) && !canonicalFromUrl(normaliseUrl(m[0])));
  for (const seg of structuredPage ? segs.filter(ownSecurityLink) : segs) {
    if (!BOUNTY_WORD.test(seg)) { n += 1; continue; }
    const amounts = amountsIn(seg);
    const hasPlatform = items.some((o) => o.rewardText === seg.slice(0, 200)) || [...seg.matchAll(URL_IN_TEXT)].some((m) => canonicalFromUrl(normaliseUrl(m[0])));
    if (hasPlatform || !amounts.length) { if (!hasPlatform) n += 1; continue; }
    const link = linkAround(seg, doc.links);
    const name = nameFrom(seg, link); if (!name) { n += 1; continue; }
    const key = `name:${nameKey(name)}`;
    const o = add(attribution(emptyOpportunity(`${refPrefix}#${key}`, titleCase(name))), key);
    o.maxReward = Math.max(...amounts); o.rewardCurrency = "USD"; o.rewardType = /up to|max/i.test(seg) ? "up_to" : "fixed"; o.rewardText = seg.slice(0, 200);
    const pageLink = [...seg.matchAll(URL_IN_TEXT)].map((m) => normaliseUrl(m[0])).find((u): u is string => !!u && SECURITY_PATH.test(u));
    if (pageLink) o.officialUrl = pageLink; else o.unresolved.push("officialUrl");
    o.unresolved.push("platform");
  }
  // 3. Page mode: a programme page names itself (its own links such as "Report a bug" are not other programmes), and a single
  //    project security page with no programme links is one opportunity, named from its title.
  let pageNote: string | undefined;
  if (opts.page) {
    const own = pageKey ? items.find((o) => canonicalFromUrl(o.officialUrl)?.key === pageKey) : undefined;
    const titleName = cleanTitle(doc.title);
    if (own && titleName) own.projectName = titleName;
    const others = items.filter((o) => o !== own);
    if (!items.length) {
      const bountyish = /bug ?bount|security program|vulnerability disclosure|responsible disclosure|whitehat/i.test(`${doc.title ?? ""}\n${doc.text.slice(0, 20000)}`);
      const sentences = doc.text.split(/(?<=[.!?])\s+|\n/).filter((x) => /(bount|reward|payout|up to|maximum|max\.?)/i.test(x));
      const amounts = sentences.flatMap((x) => amountsIn(x).map((a) => ({ a, x })));
      if (bountyish && titleName) {
        const top = amounts.sort((p, q) => q.a - p.a)[0];
        const o = add(attribution(emptyOpportunity(`${refPrefix}#page`, titleName)), `page:${opts.page}`);
        o.officialUrl = normaliseUrl(opts.page); o.platform = pageKey ? platformName(pageKey.split(":")[0]!) : null;
        if (top) { o.maxReward = top.a; o.rewardCurrency = "USD"; o.rewardType = /up to|max/i.test(top.x) ? "up_to" : "fixed"; o.rewardText = top.x.trim().slice(0, 200); }
        o.unresolved.push("platform");
      } else if (bountyish) pageNote = "the page mentions a bug bounty but carries no programme data in its HTML (it is probably loaded by the browser from an API); paste the visible text to import it";
    }
    void others;
  }
  for (const o of items) if (o.maxReward === null && !o.unresolved.includes("maxReward")) o.unresolved.push("maxReward");
  return { items, ignoredSegments: n, unresolvedLinks: [...new Set(unresolvedLinks)], ...(pageNote ? { pageNote } : {}) };
}

/** "RedStone Smart Contracts: Program Info | HackenProof" -> "RedStone Smart Contracts"; "Usual Labs Bug Bounty - Sherlock" -> "Usual Labs". */
export function cleanTitle(title: string | null): string | null {
  if (!title) return null;
  const first = title.split(/\s[|–—-]\s|\s·\s/)[0]!;
  const t = first.replace(/:\s*(program info|overview|details|scope|rewards?)$/i, "").replace(/\b(bug ?bounty( program(me)?)?|security program(me)?|program(me)? info)\b/gi, " ").replace(/\s+/g, " ").trim();
  return t.length >= 2 && /\p{L}/u.test(t) && !GENERIC_NAME.test(t) ? t.slice(0, 120) : null;
}

const titleCase = (s: string) => (/[A-Z]/.test(s) ? s : s.replace(/\b\p{L}/gu, (c) => c.toUpperCase()));
function platformName(p: string): string { return ({ immunefi: "Immunefi", cantina: "Cantina", sherlock: "Sherlock", hackenproof: "HackenProof", code4rena: "Code4rena", mantis: "Mantis", codehawks: "CodeHawks" } as Record<string, string>)[p] ?? p; }
function platformHost(p: string): string { return ({ immunefi: "immunefi.com", cantina: "cantina.xyz", sherlock: "audits.sherlock.xyz", hackenproof: "hackenproof.com", code4rena: "code4rena.com", mantis: "mantis.inverse.finance", codehawks: "codehawks.cyfrin.io" } as Record<string, string>)[p] ?? p; }

// ---------------------------------------------------------------------------------------------------------------------------
// X

export type XUrl = { kind: "x_post"; handle: string; statusId: string; url: string } | { kind: "x_profile"; handle: string; url: string };
const RESERVED = new Set(["home", "explore", "search", "i", "settings", "messages", "notifications", "compose", "intent", "share", "hashtag", "login", "signup", "tos", "privacy"]);
export function classifyXUrl(raw: string): XUrl | null {
  const u = normaliseUrl(raw); if (!u) return null;
  const url = new URL(u); if (url.hostname !== "x.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (!parts.length || RESERVED.has(parts[0]!.toLowerCase()) || !/^[A-Za-z0-9_]{1,15}$/.test(parts[0]!)) return null;
  if (parts[1] === "status" && /^\d{5,25}$/.test(parts[2] ?? "")) return { kind: "x_post", handle: parts[0]!, statusId: parts[2]!, url: `https://x.com/${parts[0]}/status/${parts[2]}` };
  if (parts.length === 1) return { kind: "x_profile", handle: parts[0]!, url: `https://x.com/${parts[0]}` };
  return null;
}

/** The documented oEmbed response for one post: the post's text and links are in `html`, the author in `author_name`/`author_url`. */
export function parseOembed(json: unknown, postUrl: string): TextDocument {
  const o = json as { html?: unknown; author_name?: unknown; author_url?: unknown };
  if (!o || typeof o.html !== "string") throw new Error("the oEmbed response has no post HTML");
  const html = o.html;
  const para = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? "";
  const links: Link[] = [...para.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: decode(m[1]!), text: decode(m[2]!.replace(/<[^>]+>/g, "")).trim() }));
  const text = decode(para.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
  const dateText = [...html.matchAll(/<a\b[^>]*>([A-Z][a-z]+ \d{1,2}, \d{4})<\/a>/g)].at(-1)?.[1];
  const published = dateText && Number.isFinite(Date.parse(dateText)) ? new Date(Date.parse(`${dateText} UTC`)).toISOString().slice(0, 10) : null;
  const handle = typeof o.author_url === "string" ? /x\.com\/([A-Za-z0-9_]+)|twitter\.com\/([A-Za-z0-9_]+)/.exec(o.author_url)?.slice(1).find(Boolean) : undefined;
  return { text, links, baseUrl: postUrl, author: `${typeof o.author_name === "string" ? o.author_name : "unknown"}${handle ? ` (@${handle})` : ""}`, publishedAt: published, title: null };
}
