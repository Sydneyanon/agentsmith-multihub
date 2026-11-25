import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

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
 * Single-operator bearer protection for every /v1/ route. Without a configured token the API refuses (503) instead of
 * running open; a missing or wrong token is 401. Repeated failures lock the client out with 429 (checked before the token is
 * compared, so a lockout also hides whether a guess was right). The limiter is in memory and per process: with several
 * instances each keeps its own counts. Shared by the server and the tests so they cannot drift apart.
 */
export function registerBearerAuth(app: FastifyInstance, configuredToken: string | undefined, limiter: AuthFailureLimiter = new AuthFailureLimiter()): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    if (!configuredToken) return reply.code(503).send({ error: "api_auth_not_configured" });
    const wait = limiter.retryAfterSeconds(request.ip);
    if (wait > 0) return reply.code(429).header("retry-after", String(wait)).send({ error: "too_many_attempts", retry_after_seconds: wait });
    if (!isValidBearerToken(request.headers.authorization, configuredToken)) {
      limiter.recordFailure(request.ip);
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
}
