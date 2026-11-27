/**
 * Deterministic programme identity from URLs. Two observations whose official URLs give the same canonical key describe the same
 * programme; that is the only automatic merge rule across sources. Anything weaker becomes a possible duplicate for review.
 */
type Rule = { platform: string; host: RegExp; path: RegExp };
const RULES: Rule[] = [
  { platform: "immunefi", host: /^(www\.)?immunefi\.com$/, path: /^\/(?:bug-bounty|bounty)\/([a-z0-9][a-z0-9-]*)(?:\/|$)/i },
  { platform: "cantina", host: /^(www\.)?(cantina\.xyz|cantina\.security)$/, path: /^\/bounties\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i },
  { platform: "sherlock", host: /^audits\.sherlock\.xyz$/, path: /^\/bug-bounties\/(\d+)(?:\/|$)/ },
  { platform: "hackenproof", host: /^(www\.)?hackenproof\.com$/, path: /^\/programs\/([a-z0-9][a-z0-9-]*)(?:\/|$)/i },
  { platform: "code4rena", host: /^(www\.)?code4rena\.com$/, path: /^\/bounties\/([a-z0-9][a-z0-9-]*)(?:\/|$)/i },
  { platform: "mantis", host: /^mantis\.inverse\.finance$/, path: /^\/bounties\/([a-z0-9-]+\/[a-z0-9-]+)(?:\/|$)/i },
  { platform: "codehawks", host: /^(www\.)?codehawks\.cyfrin\.io$/, path: /^\/c\/([a-z0-9-]+)(?:\/|$)/i },
];

export type CanonicalRef = { platform: string; programmeId: string; key: string };

export function canonicalFromUrl(raw: string | null | undefined): CanonicalRef | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  for (const r of RULES) {
    if (!r.host.test(host)) continue;
    const m = r.path.exec(url.pathname);
    if (m?.[1]) { const id = m[1].toLowerCase(); return { platform: r.platform, programmeId: id, key: `${r.platform}:${id}` }; }
  }
  return null;
}

export const PLATFORM_HOSTS: Record<string, string> = {
  immunefi: "immunefi.com", cantina: "cantina.xyz", sherlock: "audits.sherlock.xyz", hackenproof: "hackenproof.com", code4rena: "code4rena.com",
  mantis: "mantis.inverse.finance", codehawks: "codehawks.cyfrin.io",
};

/** "Uniswap Labs Bug Bounty" and "uniswap" give the same key; used for possible-duplicate detection, never to merge on its own. */
export function nameKey(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(bug ?bounty|bounty|program(me)?|protocol|labs?|finance|network|foundation|smart contracts?|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "-") || name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Strips tracking parameters and fragments so the same page is recognised however it was shared. */
export function normaliseUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_src$|s$|t$|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    if (u.hostname === "twitter.com" || u.hostname === "www.twitter.com" || u.hostname === "mobile.twitter.com" || u.hostname === "www.x.com" || u.hostname === "mobile.x.com") u.hostname = "x.com";
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch { return null; }
}
