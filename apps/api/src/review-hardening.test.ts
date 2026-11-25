import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { AuthFailureLimiter, assessTokenStrength } from "./auth.js";

const token = randomBytes(36).toString("base64url");
const roomy = () => new AuthFailureLimiter({ perClientMax: 1e6, globalMax: 1e6, windowMs: 60_000 });

describe("operator token quality (independent review: the limiter cannot bound guessing, so entropy must)", () => {
  it("rejects long but low-variety tokens that the old heuristic accepted", () => {
    for (const weak of ["abcdefghij".repeat(4), "password1234".repeat(3), "0123456789abcdef".repeat(3), "aA1bB2cC3dD4".repeat(4)]) {
      expect(assessTokenStrength(weak), weak).not.toBeNull();
    }
  });
  it("rejects a non-repeating token drawn from a small alphabet, by distinct-character count", () => {
    let x = 12345; const alphabet = "abcdefghijk"; // 11 symbols, each exactly 4 times, shuffled: entropy log2(11) = 3.46, so only the distinct-character rule can catch it
    const chars = [...alphabet.repeat(4)];
    for (let i = chars.length - 1; i > 0; i -= 1) { x = (x * 1103515245 + 12345) & 0x7fffffff; const j = x % (i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
    const weak = chars.join("");
    expect(new Set(weak).size).toBeLessThan(12);
    expect(assessTokenStrength(weak)).toMatch(/distinct/);
  });
  it("still accepts generated tokens (openssl rand -base64 48, 36 random bytes in base64url)", () => {
    expect(assessTokenStrength(token)).toBeNull();
    expect(assessTokenStrength(randomBytes(48).toString("base64"))).toBeNull();
  });
});

describe("host guard stays stricter than the public matcher, deliberately", () => {
  it("a query string on /health/live is public (no token) on the right Host but earns no Host exemption", async () => {
    const app = buildApp({ pool: undefined, apiBearerToken: token, hubAllowedHosts: ["hub.example.org"], limiter: roomy() });
    expect((await app.inject({ method: "GET", url: "/health/live?probe=1", headers: { host: "hub.example.org" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health/live", headers: { host: "172.19.5.2:8080" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health/live?probe=1", headers: { host: "172.19.5.2:8080" } })).statusCode).toBe(421);
    await app.close();
  });
});

describe("internal error details are never sent to clients", () => {
  it("a 500 carries a generic body, while 4xx keep their messages", async () => {
    const app = buildApp({ pool: undefined, apiBearerToken: token, hubAllowedHosts: [], limiter: roomy() });
    app.get("/v1/boom", async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:5432"); });
    const res = await app.inject({ method: "GET", url: "/v1/boom", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/ECONNREFUSED|10\.1\.2\.3/);
    expect(res.json()).toEqual({ error: "internal_error" });
    const bad = await app.inject({ method: "POST", url: "/v1/intake", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: "{nope" });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});

describe("/health/ready cannot be used to hammer (or keep awake) the database", () => {
  const fakePool = () => ({ query: vi.fn().mockResolvedValue({ rows: [{}] }), end: vi.fn().mockResolvedValue(undefined) });
  it("answers repeated probes from a short-lived cache", async () => {
    const pool = fakePool();
    const app = buildApp({ pool: pool as never, apiBearerToken: token, hubAllowedHosts: [], limiter: roomy(), readinessCacheMs: 60_000 });
    for (let i = 0; i < 20; i += 1) expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it("does not cache when the cache is disabled, and reports a failing database as not ready without details", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:5432")), end: vi.fn().mockResolvedValue(undefined) };
    const app = buildApp({ pool: pool as never, apiBearerToken: token, hubAllowedHosts: [], limiter: roomy(), readinessCacheMs: 0 });
    const a = await app.inject({ method: "GET", url: "/health/ready" });
    await app.inject({ method: "GET", url: "/health/ready" });
    expect(a.statusCode).toBe(503);
    expect(a.body).not.toMatch(/ECONNREFUSED|10\.1\.2\.3/);
    expect(pool.query).toHaveBeenCalledTimes(2);
    await app.close();
  });
});

describe("production startup warns about missing host restriction", () => {
  it("server.ts logs a warning when NODE_ENV is production and HUB_ALLOWED_HOSTS is empty", () => {
    const src = readFileSync(join(__dirname, "server.ts"), "utf8");
    expect(src).toMatch(/config\.environment === "production" && config\.hubAllowedHosts\.length === 0/);
    expect(src).toMatch(/HUB_ALLOWED_HOSTS is not set/);
  });
});
