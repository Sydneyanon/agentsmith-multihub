import { createHash } from "node:crypto";
import { devProxyFetch } from "../net/dev-proxy-fetch.js";
import { createSafeFetch, SsrfError } from "../net/safe-fetch.js";
import { BountyError } from "./types.js";

/**
 * Outbound HTTP for bounty collection. Two transports:
 * - "guarded" (default, and the only one allowed in production): the SSRF-hardened fetcher. It resolves DNS itself, refuses
 *   private, loopback, link-local and metadata addresses, pins the connection to the checked address, re-checks every redirect hop
 *   and drops credentials across origins.
 * - "env-proxy" (development only): Node's fetch through the HTTPS_PROXY of a sandbox whose DNS is only reachable via its proxy.
 *   It is refused when NODE_ENV=production, and the URL-level checks below still apply.
 * Both cap the body size and the time taken, and never execute anything they download.
 */
export type HttpResponse = { status: number; finalUrl: string; contentType: string; body: string; bytes: number; sha256: string; retryAfterSeconds: number | null };
export type HttpGet = (url: string, options?: { accept?: string; maxBytes?: number; timeoutMs?: number }) => Promise<HttpResponse>;

export const DEFAULT_USER_AGENT = "bounty-collector/1.0 (public programme listings; one request per source per hour)";
export function userAgent(env: Record<string, string | undefined> = process.env): string {
  const ua = env.BOUNTY_USER_AGENT?.trim();
  return ua && /^[\x20-\x7e]{8,200}$/.test(ua) ? ua : DEFAULT_USER_AGENT;
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata(\.google\.internal)?|instance-data)$/i;
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;
/** URL-level safety, applied before any transport is used. The guarded transport additionally checks every resolved address. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BountyError("invalid_url", "not a valid URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BountyError("unsupported_protocol", `${url.protocol} URLs are not fetched`);
  if (url.username || url.password) throw new BountyError("credentials_in_url", "URLs with credentials are not fetched");
  const host = url.hostname.toLowerCase();
  if (IP_LITERAL.test(host)) throw new BountyError("ip_literal", "URLs naming an IP address directly are not fetched");
  if (PRIVATE_HOST.test(host) || !host.includes(".")) throw new BountyError("private_host", "local and internal host names are not fetched");
  if (url.port && url.port !== "443" && url.port !== "80") throw new BountyError("port_blocked", `port ${url.port} is not fetched`);
  if (raw.length > 2048) throw new BountyError("url_too_long", "URL longer than 2048 characters");
  return url;
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new BountyError("response_too_large", `response is ${declared} bytes; the limit is ${maxBytes}`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new BountyError("response_too_large", `response exceeded ${maxBytes} bytes`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function retryAfter(h: Headers): number | null {
  const v = h.get("retry-after"); if (!v) return null;
  const n = Number(v); if (Number.isFinite(n)) return Math.max(0, Math.min(86_400, n));
  const t = Date.parse(v); return Number.isFinite(t) ? Math.max(0, Math.min(86_400, Math.round((t - Date.now()) / 1000))) : null;
}

export function createHttpGet(env: Record<string, string | undefined> = process.env, options: { fetchImpl?: typeof fetch } = {}): HttpGet {
  const transport = env.BOUNTY_TRANSPORT ?? "guarded";
  if (transport !== "guarded" && transport !== "env-proxy" && !options.fetchImpl) throw new BountyError("bad_transport", `unknown BOUNTY_TRANSPORT ${transport}`);
  if (transport === "env-proxy" && env.NODE_ENV === "production") throw new BountyError("bad_transport", "the env-proxy transport is for development only and is refused in production");
  const ua = userAgent(env);
  const guarded = createSafeFetch({ maxRedirects: 3, connectTimeoutMs: 10_000, headersTimeoutMs: 20_000, idleTimeoutMs: 20_000 });
  const raw: typeof fetch = options.fetchImpl ?? (transport === "env-proxy" ? devProxyFetch(env) : (guarded as unknown as typeof fetch));
  return async (url, o = {}) => {
    assertPublicHttpUrl(url);
    const maxBytes = o.maxBytes ?? 4 * 1024 * 1024;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 30_000);
    try {
      let current = url; let response: Response | null = null;
      // Manual redirects (bounded, each hop re-checked) for every transport.
      for (let hop = 0; hop <= 3; hop += 1) {
        response = await raw(current, { headers: { "user-agent": ua, accept: o.accept ?? "text/html,application/json;q=0.9,*/*;q=0.5" }, redirect: "manual", signal: controller.signal });
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
          if (hop === 3) throw new BountyError("too_many_redirects", "more than 3 redirects");
          current = new URL(response.headers.get("location")!, current).toString();
          assertPublicHttpUrl(current);
          continue;
        }
        break;
      }
      const body = await readCapped(response!, maxBytes);
      return { status: response!.status, finalUrl: current, contentType: response!.headers.get("content-type") ?? "", body: body.toString("utf8"), bytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"), retryAfterSeconds: retryAfter(response!.headers) };
    } catch (error) {
      if (error instanceof BountyError) throw error;
      if (error instanceof SsrfError) throw new BountyError(`blocked_${error.code}`, error.message);
      if ((error as Error).name === "AbortError") throw new BountyError("timeout", "the request timed out");
      throw new BountyError("fetch_failed", (error as Error).message ?? String(error));
    } finally { clearTimeout(timer); }
  };
}

/** robots.txt per RFC 9309: a 4xx means no restrictions; 5xx or an unreachable file means "do not crawl". Longest match wins, Allow on a tie. */
export type RobotsDecision = { allowed: boolean; reason: string };
export function robotsAllows(robotsTxt: string, path: string, agentToken = "bounty-collector"): RobotsDecision {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }> }> = [];
  let current: (typeof groups)[number] | null = null; let lastWasAgent = false;
  for (const line of robotsTxt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(#.*)?$/.exec(line); if (!m) continue;
    const key = m[1]!.toLowerCase(); const value = m[2]!;
    if (key === "user-agent") { if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); } current.agents.push(value.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") { if (value === "" && key === "disallow") continue; current.rules.push({ allow: key === "allow", pattern: value }); }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agentToken.toLowerCase().startsWith(a)));
  const group = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = group.flatMap((g) => g.rules);
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const re = new RegExp("^" + r.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(path)) { const len = r.pattern.length; if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len }; }
  }
  return best ? { allowed: best.allow, reason: `${best.allow ? "Allow" : "Disallow"} rule of length ${best.len}` } : { allowed: true, reason: "no matching rule" };
}

export async function checkRobots(get: HttpGet, url: string, cache = new Map<string, string | null>()): Promise<RobotsDecision> {
  const u = new URL(url); const origin = u.origin;
  if (!cache.has(origin)) {
    try {
      const r = await get(`${origin}/robots.txt`, { accept: "text/plain", maxBytes: 512 * 1024, timeoutMs: 15_000 });
      cache.set(origin, r.status >= 200 && r.status < 300 ? r.body : r.status >= 400 && r.status < 500 ? "" : null);
    } catch { cache.set(origin, null); }
  }
  const txt = cache.get(origin);
  if (txt === null || txt === undefined) return { allowed: false, reason: "robots.txt could not be read (RFC 9309: treat as disallowed)" };
  return robotsAllows(txt, u.pathname + u.search);
}
