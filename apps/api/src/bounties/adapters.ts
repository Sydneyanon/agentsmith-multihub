import { createHash } from "node:crypto";
import { canonicalFromUrl, normaliseUrl } from "./canonical.js";
import { checkRobots, type HttpGet } from "./http.js";
import { amountsIn, tier } from "./money.js";
import { emptyOpportunity, type ExtractedOpportunity, type SourceFetchResult } from "./types.js";

/**
 * Source adapters. Adding a source means adding an adapter here and a row in bounty_sources; the pipeline (collect.ts) is unchanged.
 * An adapter only fetches and extracts. It never writes, never decides identity and never resolves conflicts.
 */
export type SourceAdapter = {
  key: string;
  /** Hosts this adapter may contact. A request elsewhere is a bug and is refused. */
  hosts: string[];
  /** Why it cannot run, when it is blocked by terms, robots or technology (checked by the pipeline before fetching anything). */
  blocked?: string;
  retrieve: (get: HttpGet, context: { robots: Map<string, string | null>; sleep: (ms: number) => Promise<void> }) => Promise<SourceFetchResult>;
};

const CHAINS = ["Ethereum", "ETH", "Arbitrum", "Optimism", "Base", "Polygon", "BSC", "BNB Chain", "Avalanche", "Solana", "Sui", "Aptos", "Near", "Cosmos", "Osmosis", "Starknet",
  "zkSync", "Linea", "Scroll", "Blast", "Mantle", "Gnosis", "Celo", "Moonbeam", "Fantom", "Sonic", "Berachain", "Hyperliquid", "HyperEVM", "TON", "Tron", "Bitcoin", "Rootstock",
  "Polkadot", "Kusama", "Cardano", "Algorand", "Stellar", "XRPL", "Injective", "Sei", "Kaia", "Mezo", "Unichain", "Katana", "Plasma", "Monad", "MegaETH", "Abstract", "Ink", "Mode", "Taiko", "Zora", "Metis", "Kava", "Flow", "Hedera", "Aurora", "Cronos", "Harmony", "Klaytn", "Movement", "Fuel", "Eclipse", "Bera", "Merlin", "Core", "Story", "Plume"];
const CHAIN_BY_LOWER = new Map(CHAINS.map((c) => [c.toLowerCase(), c === "ETH" ? "Ethereum" : c === "Bera" ? "Berachain" : c]));
const ASSET = /^(smart contracts?|websites?( (&|and) (apps|applications))?|web(sites)? and mobile|apps?|blockchain[ /]?dlt|blockchain|dlt|other|infrastructure|mobile|documentation)$/i;
const LANG = /^(solidity|vyper|rust|move|cairo|go|golang|typescript|javascript|c\+\+|python|huff|yul|clarity|noir|circom|zk|ink!?)$/i;

/** Splits a source's free tag list into chains, asset types and other technologies. Unknown tags stay as technologies, never dropped. */
export function classifyTags(tags: readonly string[]): { chains: string[]; assetTypes: string[]; technologies: string[] } {
  const chains = new Set<string>(); const assetTypes = new Set<string>(); const technologies = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim(); if (!t) continue;
    const chain = CHAIN_BY_LOWER.get(t.toLowerCase());
    if (chain) chains.add(chain); else if (ASSET.test(t)) assetTypes.add(t); else if (LANG.test(t)) technologies.add(t); else technologies.add(t);
  }
  return { chains: uniqCI([...chains]), assetTypes: uniqCI([...assetTypes]), technologies: uniqCI([...technologies]) };
}

/** Case-insensitive de-duplication that keeps the first spelling seen. */
export function uniqCI(values: readonly string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const v of values) { const k = v.trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push(v.trim()); } }
  return out;
}

const isoDate = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Community Bug Bounty Board: https://bug-bounty-board.vercel.app/programs.json (the board's own structured data file).

type BoardProgram = {
  p: string; id: string; name: string; org?: string | null; max?: number | null; cur?: string | null; url?: string | null; since?: string | null; upd?: string | null;
  kyc?: boolean | null; poc?: boolean | null; fee?: number | null; feeNote?: string | null; tags?: string[]; tiers?: Array<[string, string, string]>; desc?: string | null;
  findings?: number | null; extra?: string[]; featured?: boolean;
};
export const BOARD_URL = "https://bug-bounty-board.vercel.app/programs.json";
export const BOARD_PAGE = "https://bug-bounty-board.vercel.app/";

export function parseBoard(json: unknown): { generatedAt: string | null; declaredCounts: Record<string, number>; items: ExtractedOpportunity[]; problems: string[] } {
  const problems: string[] = [];
  const doc = json as { generatedAt?: unknown; sources?: unknown; programs?: unknown };
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.programs)) throw new Error("programs.json has no programs array");
  const items: ExtractedOpportunity[] = []; const seen = new Set<string>();
  for (const raw of doc.programs as BoardProgram[]) {
    if (!raw || typeof raw.p !== "string" || typeof raw.id !== "string" || typeof raw.name !== "string" || !raw.name.trim()) { problems.push(`skipped a listing without platform, id or name`); continue; }
    const ref = `${raw.p.toLowerCase()}:${raw.id}`;
    if (seen.has(ref)) { problems.push(`duplicate listing ${ref} in one file`); continue; }
    seen.add(ref);
    const o = emptyOpportunity(ref, (raw.org && raw.org.trim()) || raw.name.trim());
    o.programmeName = raw.name.trim();
    o.platform = raw.p.trim();
    o.officialUrl = raw.url ? normaliseUrl(raw.url) : null;
    if (raw.extra?.length) for (const x of raw.extra) { const u = typeof x === "string" && /^https?:\/\//.test(x) ? normaliseUrl(x) : null; if (u) o.otherUrls.push(u); }
    o.maxReward = typeof raw.max === "number" && raw.max > 0 ? raw.max : null;
    o.rewardCurrency = raw.cur?.trim() || null;
    o.rewardType = o.maxReward !== null ? "up_to" : null;
    o.tiers = (raw.tiers ?? []).filter((t) => Array.isArray(t) && t.length >= 3).map(([sev, asset, text]) => tier(String(sev), String(asset), String(text)));
    if (o.tiers.some((t) => /% of funds/i.test(t.text))) o.rewardType = "percentage_capped";
    const tags = classifyTags(raw.tags ?? []);
    const tierAssets = [...new Set(o.tiers.map((t) => t.asset).filter((a): a is string => !!a))];
    o.chains = tags.chains; o.technologies = tags.technologies; o.assetTypes = uniqCI([...tags.assetTypes, ...tierAssets]);
    o.kycRequired = typeof raw.kyc === "boolean" ? raw.kyc : null;
    o.pocRequired = typeof raw.poc === "boolean" ? raw.poc : null;
    o.submissionFee = typeof raw.fee === "number" && raw.fee > 0 ? { amount: raw.fee, note: raw.feeNote ?? null } : null;
    o.launchedAt = isoDate(raw.since); o.sourceUpdatedAt = isoDate(raw.upd);
    o.description = raw.desc ? raw.desc.slice(0, 600) : null;
    o.findingsCount = typeof raw.findings === "number" ? raw.findings : null;
    o.sourceTitle = raw.name.trim();
    if (o.maxReward === null) o.unresolved.push("maxReward");
    if (!o.officialUrl) o.unresolved.push("officialUrl");
    else if (!canonicalFromUrl(o.officialUrl)) problems.push(`${ref}: official URL ${o.officialUrl} is not a recognised platform programme URL`);
    items.push(o);
  }
  const declaredCounts: Record<string, number> = {};
  if (doc.sources && typeof doc.sources === "object") for (const [k, v] of Object.entries(doc.sources as Record<string, unknown>)) if (typeof v === "number") declaredCounts[k] = v;
  return { generatedAt: typeof doc.generatedAt === "string" ? doc.generatedAt : null, declaredCounts, items, problems };
}

export const communityBoard: SourceAdapter = {
  key: "community-board", hosts: ["bug-bounty-board.vercel.app"],
  async retrieve(get, ctx) {
    const robots = await checkRobots(get, BOARD_URL, ctx.robots);
    if (!robots.allowed) return { ok: false, httpStatus: null, error: `robots.txt: ${robots.reason}`, retryable: true, retryAfterSeconds: 3600 };
    const r = await get(BOARD_URL, { accept: "application/json", maxBytes: 8 * 1024 * 1024 });
    if (r.status === 429 || r.status >= 500) return { ok: false, httpStatus: r.status, error: `HTTP ${r.status}`, retryable: true, retryAfterSeconds: r.retryAfterSeconds };
    if (r.status !== 200) return { ok: false, httpStatus: r.status, error: `HTTP ${r.status}`, retryable: false, retryAfterSeconds: null };
    let parsed;
    try { parsed = parseBoard(JSON.parse(r.body)); } catch (e) { return { ok: false, httpStatus: r.status, error: `could not parse programs.json: ${(e as Error).message}`, retryable: false, retryAfterSeconds: null }; }
    const declared = Object.values(parsed.declaredCounts).reduce((a, b) => a + b, 0);
    const notes = [`board generatedAt ${parsed.generatedAt ?? "not stated"}`, ...parsed.problems.slice(0, 20)];
    if (declared && declared !== parsed.items.length) notes.push(`board declares ${declared} programmes; ${parsed.items.length} were usable`);
    return { ok: true, complete: parsed.items.length > 0, httpStatus: r.status, bytes: r.bytes, contentSha256: r.sha256, pages: 1, items: parsed.items, notes };
  },
};

// ---------------------------------------------------------------------------------------------------------------------------
// Sherlock: https://audits.sherlock.xyz/bug-bounties. The public page embeds its own listing data (React Server Components stream).

export const SHERLOCK_URL = "https://audits.sherlock.xyz/bug-bounties";

/** Reassembles the RSC flight data from the page's `self.__next_f.push([1,"..."])` chunks. */
export function rscFlight(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { out.push(JSON.parse(m[1]!) as string); } catch { /* a malformed chunk is skipped; the parse below fails loudly if data is missing */ }
  }
  return out.join("");
}

/** Text rows of the flight stream ("<id>:T<hex byte length>,<text>") referenced from data as "$<id>". */
function flightTexts(flight: string): Map<string, string> {
  const texts = new Map<string, string>(); const buf = Buffer.from(flight, "utf8");
  const re = /(?:^|\n)([0-9a-f]+):T([0-9a-f]+),/g; let m: RegExpExecArray | null;
  while ((m = re.exec(flight))) {
    const start = Buffer.byteLength(flight.slice(0, m.index + m[0].length), "utf8");
    texts.set(m[1]!, buf.subarray(start, start + parseInt(m[2]!, 16)).toString("utf8"));
  }
  return texts;
}

/** Extracts the JSON object that starts at `from` by bracket matching (strings respected). */
function jsonObjectAt(s: string, from: number): unknown {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = from; i < s.length; i += 1) {
    const c = s[i]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth += 1; else if (c === "}") { depth -= 1; if (depth === 0) return JSON.parse(s.slice(from, i + 1)); }
  }
  throw new Error("unterminated JSON object");
}

type SherlockItem = { id: number; title: string; description?: string; payout?: number | null; displayCurrency?: string | null; severities?: Array<{ severityName: string; depositAmount?: number | null }>;
  categories?: Array<{ name: string }>; lastUpdatedTimestamp?: number | null; isReady?: boolean };

/** Reward tiers from the programme's own markdown ("## Reward Amounts" / "### Critical" / "- $16,000,000 maximum payout"). */
export function sherlockTiers(markdown: string): ExtractedOpportunity["tiers"] {
  const section = /##\s*Reward Amounts([\s\S]*?)(?:\n##\s[^#]|$)/i.exec(markdown)?.[1] ?? "";
  const out: ExtractedOpportunity["tiers"] = [];
  for (const m of section.matchAll(/###\s*([^\n]+)\n([\s\S]*?)(?=\n###\s|$)/g)) {
    const text = m[2]!.split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean)[0] ?? "";
    if (text) out.push(tier(m[1]!.trim(), null, text.replace(/\*/g, "")));
  }
  return out;
}

export function parseSherlock(html: string): { items: ExtractedOpportunity[]; problems: string[] } {
  const flight = rscFlight(html);
  const keyAt = flight.indexOf('"queryKey":["bug-bounties","all"]');
  if (keyAt < 0) throw new Error("the page does not contain the bug-bounties listing data");
  const stateAt = flight.lastIndexOf('{"state":{"data":{"items":', keyAt);
  if (stateAt < 0) throw new Error("listing data has an unexpected shape");
  const state = jsonObjectAt(flight, stateAt) as { state: { data: { items: SherlockItem[] } } };
  const texts = flightTexts(flight); const problems: string[] = [];
  const items = state.state.data.items.flatMap((it): ExtractedOpportunity[] => {
    if (typeof it.id !== "number" || !it.title) { problems.push("skipped an item without id or title"); return []; }
    const o = emptyOpportunity(`sherlock:${it.id}`, it.title.trim());
    const md = typeof it.description === "string" ? (it.description.startsWith("$") ? texts.get(it.description.slice(1)) ?? "" : it.description) : "";
    o.programmeName = (/^#\s+(.+)$/m.exec(md)?.[1] ?? it.title).trim();
    o.platform = "Sherlock"; o.officialUrl = `https://audits.sherlock.xyz/bug-bounties/${it.id}`;
    o.maxReward = typeof it.payout === "number" && it.payout > 0 ? it.payout : null; o.rewardCurrency = it.displayCurrency ?? null; o.rewardType = o.maxReward !== null ? "up_to" : null;
    o.tiers = sherlockTiers(md);
    if (/discretionary/i.test(md) && o.tiers.some((t) => t.max === null)) o.rewardType = o.rewardType ?? "discretionary";
    const deposits = (it.severities ?? []).map((s) => s.depositAmount).filter((d): d is number => typeof d === "number" && d > 0);
    o.submissionFee = deposits.length ? { amount: Math.max(...deposits), note: "refundable stake per report" } : null;
    o.categories = (it.categories ?? []).map((c) => c.name).filter(Boolean);
    const chainHits = classifyTags((md.match(/\b[A-Z][A-Za-z]+\b/g) ?? []).filter((w) => CHAIN_BY_LOWER.has(w.toLowerCase()) && w !== "Base" && w !== "Core" && w !== "Flow" && w !== "Story")).chains;
    o.chains = [...new Set(chainHits)].slice(0, 12);
    if (/solidity|smart contract/i.test(md)) o.assetTypes.push("Smart contract");
    o.sourceUpdatedAt = typeof it.lastUpdatedTimestamp === "number" ? new Date(it.lastUpdatedTimestamp * 1000).toISOString().slice(0, 10) : null;
    o.description = md ? md.replace(/^#.*$/m, "").trim().split(/\n\s*\n/)[0]!.slice(0, 600) : null;
    o.sourceTitle = it.title;
    if (o.maxReward === null) o.unresolved.push("maxReward");
    return [o];
  });
  return { items, problems };
}

export const sherlock: SourceAdapter = {
  key: "sherlock", hosts: ["audits.sherlock.xyz"],
  async retrieve(get, ctx) {
    const robots = await checkRobots(get, SHERLOCK_URL, ctx.robots);
    if (!robots.allowed) return { ok: false, httpStatus: null, error: `robots.txt: ${robots.reason}`, retryable: true, retryAfterSeconds: 3600 };
    const r = await get(SHERLOCK_URL, { maxBytes: 8 * 1024 * 1024 });
    if (r.status === 429 || r.status >= 500) return { ok: false, httpStatus: r.status, error: `HTTP ${r.status}`, retryable: true, retryAfterSeconds: r.retryAfterSeconds };
    if (r.status !== 200) return { ok: false, httpStatus: r.status, error: `HTTP ${r.status}`, retryable: false, retryAfterSeconds: null };
    try {
      const { items, problems } = parseSherlock(r.body);
      return { ok: true, complete: items.length > 0, httpStatus: r.status, bytes: r.bytes, contentSha256: r.sha256, pages: 1, items, notes: problems };
    } catch (e) { return { ok: false, httpStatus: r.status, error: `page structure not recognised: ${(e as Error).message}`, retryable: false, retryAfterSeconds: null }; }
  },
};

// ---------------------------------------------------------------------------------------------------------------------------
// HackenProof: https://hackenproof.com/programs?page=N (server-rendered cards).

export const HACKENPROOF_URL = "https://hackenproof.com/programs";
const stripTags = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export function parseHackenproofPage(html: string): ExtractedOpportunity[] {
  const out: ExtractedOpportunity[] = [];
  for (const art of html.match(/<article\b[\s\S]*?<\/article>/g) ?? []) {
    const slug = /href="\/programs\/([a-z0-9][a-z0-9-]*)"/i.exec(art)?.[1];
    const name = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(art)?.[1];
    if (!slug || !name) continue;
    const title = stripTags(name);
    const o = emptyOpportunity(`hackenproof:${slug}`, title.replace(/\s+(smart contracts?|web( and mobile)?|web & mobile|bug bounty)$/i, "").trim() || title);
    o.programmeName = title; o.platform = "HackenProof"; o.officialUrl = `https://hackenproof.com/programs/${slug}`;
    const pairs = new Map<string, string>();
    for (const m of art.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) pairs.set(stripTags(m[1]!).replace(/:$/, "").toLowerCase(), stripTags(m[2]!));
    const upTo = pairs.get("up to");
    if (upTo) { const a = amountsIn(upTo); o.maxReward = a.length ? Math.max(...a) : null; o.rewardCurrency = a.length ? "USD" : null; o.rewardText = upTo; o.rewardType = a.length ? "up_to" : null; }
    o.launchedAt = isoDate(pairs.get("started date")); o.sourceUpdatedAt = isoDate(pairs.get("last updated"));
    const statusText = stripTags(/<span[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<span[^>]*aria-hidden="true"[^>]*><\/span>([\s\S]*?)<\/span>/i.exec(art)?.[1] ?? "").toLowerCase();
    o.statusClaim = /live|active|open/.test(statusText) ? "active" : /pause/.test(statusText) ? "paused" : /close|finish|ended/.test(statusText) ? "closed" : null;
    const desc = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(art)?.[1]; o.description = desc ? stripTags(desc).slice(0, 600) : null;
    const tags = [...art.matchAll(/<li[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/li>/g)].map((m) => stripTags(m[1]!)).filter(Boolean);
    const c = classifyTags(tags); o.chains = c.chains; o.assetTypes = c.assetTypes; o.technologies = c.technologies;
    if (/smart contract/i.test(title) || tags.some((t) => /smart contract/i.test(t))) o.assetTypes = uniqCI(["Smart contract", ...o.assetTypes]);
    o.sourceTitle = title;
    if (o.maxReward === null) o.unresolved.push("maxReward");
    out.push(o);
  }
  return out;
}

export const hackenproof: SourceAdapter = {
  key: "hackenproof", hosts: ["hackenproof.com"],
  async retrieve(get, ctx) {
    const robots = await checkRobots(get, HACKENPROOF_URL, ctx.robots);
    if (!robots.allowed) return { ok: false, httpStatus: null, error: `robots.txt: ${robots.reason}`, retryable: true, retryAfterSeconds: 3600 };
    const items: ExtractedOpportunity[] = []; const seen = new Set<string>(); let bytes = 0; let pages = 0; let complete = false; const shas: string[] = [];
    for (let page = 1; page <= 60; page += 1) {
      if (page > 1) await ctx.sleep(2000); // polite pacing between pages
      const r = await get(page === 1 ? HACKENPROOF_URL : `${HACKENPROOF_URL}?page=${page}`, { maxBytes: 4 * 1024 * 1024 });
      if (r.status === 429 || r.status >= 500) return { ok: false, httpStatus: r.status, error: `HTTP ${r.status} on page ${page}`, retryable: true, retryAfterSeconds: r.retryAfterSeconds };
      if (r.status !== 200) return { ok: false, httpStatus: r.status, error: `HTTP ${r.status} on page ${page}`, retryable: false, retryAfterSeconds: null };
      pages += 1; bytes += r.bytes; shas.push(r.sha256);
      const found = parseHackenproofPage(r.body).filter((o) => !seen.has(o.sourceRef));
      if (!found.length) { complete = page > 1 || items.length > 0; break; }
      for (const o of found) { seen.add(o.sourceRef); items.push(o); }
    }
    return { ok: true, complete, httpStatus: 200, bytes, contentSha256: createHash("sha256").update(shas.join(",")).digest("hex"), pages, items,
      notes: complete ? [] : ["pagination did not end within 60 pages; the listing is treated as incomplete, so nothing is marked delisted"] };
  },
};

// ---------------------------------------------------------------------------------------------------------------------------
// Blocked sources: registered so their state is visible, never fetched.

// ---------------------------------------------------------------------------------------------------------------------------
// Immunefi: https://immunefi.com/public-api/bounties.json — a public JSON feed of every programme. robots.txt is `Allow: /` and the
// response is `cache-control: public`. It carries official status, rewards, chains and the in-scope assets (GitHub/docs URLs), so it
// confirms programmes and gives verified repositories. It is DISABLED by default and the registry keeps it off pending an owner decision
// on whether Immunefi's Terms of Use permit reading this endpoint (see docs/source-access-decisions.md); enabling is an operator action.

export const IMMUNEFI_URL = "https://immunefi.com/public-api/bounties.json";
type ImmunefiAsset = { url?: string; type?: string };
type ImmunefiProgram = { slug?: string; project?: string; maxBounty?: number | null; rewardsToken?: string | null; ecosystem?: string[]; productType?: string[]; projectType?: string[];
  kyc?: boolean | null; isPaused?: boolean; inviteOnly?: boolean; launchDate?: string | null; updatedDate?: string | null; endDate?: string | null; assets?: ImmunefiAsset[]; githubUrl?: string | null; websiteUrl?: string | null };

export function parseImmunefi(json: unknown): { items: ExtractedOpportunity[]; problems: string[] } {
  if (!Array.isArray(json)) throw new Error("the public-api response is not a JSON array");
  const items: ExtractedOpportunity[] = []; const problems: string[] = []; const seen = new Set<string>();
  for (const raw of json as ImmunefiProgram[]) {
    if (!raw || typeof raw.slug !== "string" || !raw.slug) { problems.push("skipped a programme without a slug"); continue; }
    if (seen.has(raw.slug)) { problems.push(`duplicate slug ${raw.slug}`); continue; }
    seen.add(raw.slug);
    const o = emptyOpportunity(`immunefi:${raw.slug}`, (raw.project && String(raw.project).trim()) || raw.slug);
    o.programmeName = (raw.project && String(raw.project).trim()) || raw.slug;
    o.platform = "Immunefi";
    o.officialUrl = `https://immunefi.com/bug-bounty/${raw.slug}/information`;
    o.maxReward = typeof raw.maxBounty === "number" && raw.maxBounty > 0 ? raw.maxBounty : null;
    o.rewardCurrency = raw.rewardsToken ? String(raw.rewardsToken).split("/")[0]!.trim() : (o.maxReward !== null ? "USD" : null);
    o.rewardType = o.maxReward !== null ? "up_to" : null;
    o.chains = uniqCI((raw.ecosystem ?? []).map(String));
    const assetTypes = new Set<string>();
    const repos: string[] = [];
    for (const a of raw.assets ?? []) {
      if (a?.type === "smart_contract") assetTypes.add("Smart contract");
      else if (a?.type === "websites_and_applications" || a?.type === "web") assetTypes.add("Websites & apps");
      else if (a?.type === "blockchain_dlt") assetTypes.add("Blockchain/DLT");
      const u = a?.url && /^https?:\/\//.test(a.url) ? normaliseUrl(a.url) : null;
      if (u && /github\.com\//i.test(u)) repos.push(u);
    }
    o.assetTypes = [...assetTypes];
    o.technologies = uniqCI([...(raw.productType ?? []), ...(raw.projectType ?? [])].map(String));
    o.otherUrls = [...new Set(repos)].slice(0, 50);
    o.kycRequired = typeof raw.kyc === "boolean" ? raw.kyc : null;
    o.statusClaim = raw.isPaused ? "paused" : "active";
    o.launchedAt = raw.launchDate ? String(raw.launchDate).slice(0, 10) : null;
    o.sourceUpdatedAt = raw.updatedDate ? String(raw.updatedDate).slice(0, 10) : null;
    o.sourceTitle = o.programmeName;
    if (raw.inviteOnly) o.unresolved.push("inviteOnly");
    if (o.maxReward === null) o.unresolved.push("maxReward");
    items.push(o);
  }
  return { items, problems };
}

export const immunefi: SourceAdapter = {
  key: "immunefi", hosts: ["immunefi.com"],
  async retrieve(get, ctx) {
    const robots = await checkRobots(get, IMMUNEFI_URL, ctx.robots);
    if (!robots.allowed) return { ok: false, httpStatus: null, error: `robots.txt: ${robots.reason}`, retryable: true, retryAfterSeconds: 3600 };
    const r = await get(IMMUNEFI_URL, { accept: "application/json", maxBytes: 16 * 1024 * 1024 });
    if (r.status === 429 || r.status >= 500) return { ok: false, httpStatus: r.status, error: `HTTP ${r.status}`, retryable: true, retryAfterSeconds: r.retryAfterSeconds };
    if (r.status !== 200) return { ok: false, httpStatus: r.status, error: `HTTP ${r.status}`, retryable: false, retryAfterSeconds: null };
    try {
      const { items, problems } = parseImmunefi(JSON.parse(r.body));
      return { ok: true, complete: items.length > 0, httpStatus: r.status, bytes: r.bytes, contentSha256: r.sha256, pages: 1, items, notes: problems.slice(0, 20) };
    } catch (e) { return { ok: false, httpStatus: r.status, error: `could not parse the public-api response: ${(e as Error).message}`, retryable: false, retryAfterSeconds: null }; }
  },
};

const blocked = (key: string, reason: string): SourceAdapter => ({ key, hosts: [], blocked: reason, retrieve: async () => ({ ok: false, httpStatus: null, error: reason, retryable: false, retryAfterSeconds: null }) });
export const cantina = blocked("cantina", "Cantina's listing is built in the browser from /api/, which its robots.txt disallows; its listings arrive through the community board");

export const ADAPTERS: Record<string, SourceAdapter> = { "community-board": communityBoard, sherlock, hackenproof, immunefi, cantina };
