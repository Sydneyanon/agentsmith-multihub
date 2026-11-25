import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Constant-time comparison for the configured single-operator API bearer token. */
export function isValidBearerToken(header: string | undefined, configuredToken: string | undefined): boolean {
  if (!header || !configuredToken) return false;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  if (!match?.[1]) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(configuredToken, "utf8");
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

const TOKEN_SHAPE = /^[A-Za-z0-9._~+/-]+=*$/;

/**
 * A usable operator token is long, drawn from the characters the Authorization parser accepts, and visibly random.
 * This is a guard against placeholders such as "aaaa…" or "change-me-change-me…", not a proof of randomness: generate
 * one with `openssl rand -base64 48`. Returns the problem, or null when the token is acceptable.
 */
export function assessTokenStrength(token: string): string | null {
  if (token.length < 32) return "must be at least 32 characters";
  if (!TOKEN_SHAPE.test(token)) return "may only contain letters, digits and . _ ~ + / - (with optional trailing =)";
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) { const p = n / token.length; entropy -= p * Math.log2(p); }
  if (entropy < 3.2) return "looks repetitive (low character entropy); generate one with `openssl rand -base64 48`";
  // The failed-attempt limiter does not bound guessing (a correct guess is always accepted), so the token itself must be unguessable.
  if (counts.size < 12) return "uses too few distinct characters (needs at least 12); generate one with `openssl rand -base64 48`";
  for (let period = 1; period <= token.length / 2; period += 1) {
    if (token.length % period === 0 && token === token.slice(0, period).repeat(token.length / period)) return "is a repeated pattern; generate one with `openssl rand -base64 48`";
  }
  return null;
}

/** Sliding-window failure counter. Keyed per client and once globally, so rotating a spoofed client address does not lift the cap. */
export class AuthFailureLimiter {
  private readonly byKey = new Map<string, number[]>();
  private global: number[] = [];
  constructor(
    private readonly options: { perClientMax: number; globalMax: number; windowMs: number; maxKeys?: number; now?: () => number } =
      { perClientMax: 10, globalMax: 100, windowMs: 5 * 60_000 },
  ) {}

  private now(): number { return (this.options.now ?? Date.now)(); }
  private live(times: number[], now: number): number[] { return times.filter((t) => t > now - this.options.windowMs); }

  /** Seconds until a new attempt is allowed, or 0 when the client may try. */
  retryAfterSeconds(key: string): number {
    const now = this.now();
    this.global = this.live(this.global, now);
    const own = this.live(this.byKey.get(key) ?? [], now);
    const waits: number[] = [];
    if (own.length >= this.options.perClientMax) waits.push(own[own.length - this.options.perClientMax]! + this.options.windowMs - now);
    if (this.global.length >= this.options.globalMax) waits.push(this.global[this.global.length - this.options.globalMax]! + this.options.windowMs - now);
    return waits.length ? Math.max(1, Math.ceil(Math.max(...waits) / 1000)) : 0;
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.global = this.live(this.global, now);
    this.global.push(now);
    const own = this.live(this.byKey.get(key) ?? [], now);
    own.push(now);
    this.byKey.set(key, own);
    const maxKeys = this.options.maxKeys ?? 10_000;
    if (this.byKey.size > maxKeys) {
      for (const [k, times] of this.byKey) { if (this.live(times, now).length === 0) this.byKey.delete(k); }
      while (this.byKey.size > maxKeys) this.byKey.delete(this.byKey.keys().next().value as string);
    }
  }
}

/**
 * The complete list of requests that may be served without a token. Everything else — every /v1/ route, unknown paths, other
 * methods, odd spellings (`//v1`, `/V1`, encoded slashes, trailing slashes) — requires the bearer token. Matching is on the raw
 * path (query string removed) with exact equality, so a path the router might normalise into a protected handler is never public.
 */
const PUBLIC_EXACT = new Set(["/health/live", "/health/ready", "/", "/hub", "/hub/"]);
const PUBLIC_ASSET = /^\/hub\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const PUBLIC_ROUTE_DESCRIPTIONS = ["GET|HEAD /health/live", "GET|HEAD /health/ready", "GET|HEAD /", "GET|HEAD /hub", "GET|HEAD /hub/", "GET|HEAD /hub/assets/<file>"] as const;

/** Path part of a raw request URL (query string removed). */
export function rawPath(rawUrl: string): string {
  const q = rawUrl.indexOf("?");
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

export function isPublicRequest(method: string, rawUrl: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const path = rawPath(rawUrl);
  return PUBLIC_EXACT.has(path) || (PUBLIC_ASSET.test(path) && !path.includes(".."));
}

/**
 * Single-operator bearer protection, DEFAULT-DENY. It runs at `onRequest`, i.e. before routing-specific hooks, content-type
 * parsing, body reading and validation, so an unauthenticated client cannot make the server buffer or parse a body. Without a
 * configured token the API refuses (503) instead of running open; a missing or wrong token is 401. Repeated INVALID attempts from a
 * client are throttled with 429; a valid token is never throttled. The limiter is in memory and per process.
 */
export function registerBearerAuth(
  app: FastifyInstance, configuredToken: string | undefined, limiter: AuthFailureLimiter = new AuthFailureLimiter(),
  clientIdentity: (request: FastifyRequest) => string = (request) => `peer:${request.socket.remoteAddress ?? "unknown"}`,
): void {
  app.addHook("onRequest", async (request, reply) => {
    if (isPublicRequest(request.method, request.url)) return;
    if (!configuredToken) return reply.code(503).send({ error: "api_auth_not_configured" });
    // A valid token is always accepted: only INVALID attempts are throttled, so no amount of failed guessing — from any address,
    // including the operator's own — can lock the legitimate operator out.
    if (isValidBearerToken(request.headers.authorization, configuredToken)) return;
    const client = clientIdentity(request);
    const wait = limiter.retryAfterSeconds(client);
    if (wait > 0) return reply.code(429).header("retry-after", String(wait)).send({ error: "too_many_attempts", retry_after_seconds: wait });
    limiter.recordFailure(client);
    return reply.code(401).send({ error: "unauthorized" });
  });
}
