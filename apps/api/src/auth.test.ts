import { describe, expect, it } from "vitest";
import { isValidBearerToken } from "./auth.js";

describe("API bearer authentication", () => {
  const token = "a".repeat(48);

  it("accepts the exact configured bearer token", () => {
    expect(isValidBearerToken(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects missing, malformed and incorrect tokens", () => {
    expect(isValidBearerToken(undefined, token)).toBe(false);
    expect(isValidBearerToken("Basic abc", token)).toBe(false);
    expect(isValidBearerToken(`Bearer ${"b".repeat(48)}`, token)).toBe(false);
    expect(isValidBearerToken(`Bearer ${token}`, undefined)).toBe(false);
  });
});

import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { AuthFailureLimiter, assessTokenStrength, registerBearerAuth } from "./auth.js";

describe("operator token strength", () => {
  it("accepts generated tokens", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(assessTokenStrength(randomBytes(48).toString("base64"))).toBeNull();
      expect(assessTokenStrength(randomBytes(32).toString("hex"))).toBeNull();
      expect(assessTokenStrength(randomBytes(36).toString("base64url"))).toBeNull();
    }
  });
  it.each([
    ["short", "abc123XYZ"],
    ["one character short of the minimum, otherwise random", randomBytes(24).toString("base64url").slice(0, 31)],
    ["many distinct characters but dominated by one", `${"a".repeat(40)}bcdefghijk`],
    ["one repeated character", "a".repeat(48)],
    ["a repeated phrase", "change-me-".repeat(5)],
    ["two alternating characters", "ab".repeat(24)],
    ["characters the header parser rejects", `${randomBytes(30).toString("base64url")} !@#$%^&*()`],
  ])("rejects %s", (_name, token) => {
    expect(assessTokenStrength(token)).not.toBeNull();
  });
});

describe("failed-authentication limiter", () => {
  const options = (now: () => number) => ({ perClientMax: 3, globalMax: 5, windowMs: 60_000, now });
  it("locks a client out after the allowed failures and releases it when the window passes", () => {
    let t = 1_000_000;
    const limiter = new AuthFailureLimiter(options(() => t));
    for (let i = 0; i < 3; i += 1) { expect(limiter.retryAfterSeconds("a")).toBe(0); limiter.recordFailure("a"); t += 1_000; }
    expect(limiter.retryAfterSeconds("a")).toBeGreaterThan(0);
    expect(limiter.retryAfterSeconds("b")).toBe(0);
    t += 60_000;
    expect(limiter.retryAfterSeconds("a")).toBe(0);
  });
  it("caps total failures across clients, so rotating addresses does not help", () => {
    let t = 0;
    const limiter = new AuthFailureLimiter(options(() => t));
    for (let i = 0; i < 5; i += 1) limiter.recordFailure(`client-${i}`);
    expect(limiter.retryAfterSeconds("brand-new-client")).toBeGreaterThan(0);
  });
  it("bounds memory under many distinct clients", () => {
    let t = 0;
    const limiter = new AuthFailureLimiter({ ...options(() => t), perClientMax: 1000, globalMax: 1_000_000, maxKeys: 50 });
    for (let i = 0; i < 500; i += 1) { limiter.recordFailure(`c${i}`); t += 1; }
    expect((limiter as unknown as { byKey: Map<string, unknown> }).byKey.size).toBeLessThanOrEqual(50);
  });
});

describe("bearer hook with lockout", () => {
  const token = randomBytes(36).toString("base64url");
  const build = (now: () => number) => {
    const app = Fastify({ logger: false });
    registerBearerAuth(app, token, new AuthFailureLimiter({ perClientMax: 3, globalMax: 100, windowMs: 60_000, now }));
    app.get("/v1/x", async () => ({ ok: true }));
    app.get("/health/live", async () => ({ ok: true }));
    return app;
  };
  const get = (app: ReturnType<typeof build>, authorization?: string) => app.inject({ method: "GET", url: "/v1/x", ...(authorization ? { headers: { authorization } } : {}) });

  it("answers 429 with Retry-After to repeated INVALID attempts, never to the correct token, then recovers", async () => {
    let t = 5_000_000;
    const app = build(() => t);
    for (let i = 0; i < 3; i += 1) expect((await get(app, "Bearer wrong")).statusCode).toBe(401);
    const locked = await get(app, "Bearer wrong");
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect(locked.body).not.toContain(token);
    expect((await get(app, `Bearer ${token}`)).statusCode).toBe(200); // the operator is never locked out
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    t += 61_000;
    expect((await get(app, `Bearer ${token}`)).statusCode).toBe(200);
    await app.close();
  });
  it("does not count successful requests against the limit", async () => {
    const app = build(() => 0);
    for (let i = 0; i < 20; i += 1) expect((await get(app, `Bearer ${token}`)).statusCode).toBe(200);
    await app.close();
  });
  it("counts a request with no credentials as a failure", async () => {
    const app = build(() => 0);
    for (let i = 0; i < 3; i += 1) expect((await get(app)).statusCode).toBe(401);
    expect((await get(app)).statusCode).toBe(429);
    await app.close();
  });
});

import { afterEach, vi } from "vitest";
describe("startup configuration refuses a weak operator token", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const load = async (token: string | undefined) => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    if (token === undefined) vi.stubEnv("API_BEARER_TOKEN", ""); else vi.stubEnv("API_BEARER_TOKEN", token);
    return import("./config.js");
  };
  it("accepts a generated token and an unset token (the API then answers 503 on /v1)", async () => {
    const good = randomBytes(48).toString("base64");
    expect((await load(good)).config.apiBearerToken).toBe(good);
    expect((await load(undefined)).config.apiBearerToken).toBeUndefined();
  });
  it("throws a clear message for a placeholder or short token", async () => {
    await expect(load("a".repeat(48))).rejects.toThrow(/API_BEARER_TOKEN .*(repetitive|entropy)/i);
    await expect(load("short")).rejects.toThrow(/API_BEARER_TOKEN must be at least 32/);
  });
});

describe("startup configuration validates the hub host list", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const load = async (hosts: string) => { vi.resetModules(); vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("API_BEARER_TOKEN", ""); vi.stubEnv("HUB_ALLOWED_HOSTS", hosts); return import("./config.js"); };
  it("accepts the permanent hostname and exposes it as a list", async () => {
    expect((await load("hub.agentsmithdesk.xyz")).config.hubAllowedHosts).toEqual(["hub.agentsmithdesk.xyz"]);
  });
  it("refuses wildcards and malformed entries", async () => {
    await expect(load("*.agentsmithdesk.xyz")).rejects.toThrow(/HUB_ALLOWED_HOSTS/);
    await expect(load("https://hub.agentsmithdesk.xyz")).rejects.toThrow(/HUB_ALLOWED_HOSTS/);
  });
});
