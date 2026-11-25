import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AuthFailureLimiter, registerBearerAuth } from "./auth.js";
import { registerIntakeRoutes } from "./intake.js";

const token = randomBytes(36).toString("base64url");

/** The real intake route (its body is JSON-parsed by Fastify) behind the real auth hook. */
function build() {
  const app = Fastify({ logger: false });
  registerBearerAuth(app, token, new AuthFailureLimiter({ perClientMax: 1000, globalMax: 100000, windowMs: 60_000 }));
  registerIntakeRoutes(app, undefined);
  app.get("/health/live", async () => ({ ok: true }));
  return app;
}
const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
const make = () => { const a = build(); apps.push(a); return a; };

describe("authentication happens before the request body is read or parsed", () => {
  it("unauthenticated malformed JSON gets 401, not a parser error", async () => {
    const res = await make().inject({ method: "POST", url: "/v1/intake", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("JSON");
  });
  it("an unauthenticated oversized body gets 401, not 413 (the body is never buffered)", async () => {
    const res = await make().inject({ method: "POST", url: "/v1/intake", headers: { "content-type": "application/json" }, payload: JSON.stringify({ kind: "url", value: "x".repeat(2 * 1024 * 1024) }) });
    expect(res.statusCode).toBe(401);
  });
  it("an unsupported content type is rejected as unauthenticated first", async () => {
    const res = await make().inject({ method: "POST", url: "/v1/intake", headers: { "content-type": "application/x-evil" }, payload: "x" });
    expect(res.statusCode).toBe(401);
  });
  it("with the right token, malformed JSON is still a 400 (the parser runs after auth)", async () => {
    const res = await make().inject({ method: "POST", url: "/v1/intake", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, payload: "{not json" });
    expect(res.statusCode).toBe(400);
  });
});

describe("default-deny: only an explicit allow-list is reachable without a token", () => {
  const denied = [
    "/v1/intake", "/v1/anything", "/V1/intake", "//v1/intake", "/v1%2Fintake", "/%76%31/intake", "/v1/intake?x=1", "/v1/./intake",
    "/anything", "/admin", "/.env", "/hub/assets/../../v1/x", "/hub/assets/%2e%2e%2fx", "/hub/other", "/health", "/health/live/", "/health/live%2F",
    "/health/ready/x", "/HEALTH/LIVE", "/hub//", "/hub/assets/", "/hub/assets/a/b",
  ];
  for (const url of denied) {
    it(`401 without a token: ${url}`, async () => {
      const res = await make().inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    });
  }
  it("health stays public", async () => {
    expect((await make().inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await make().inject({ method: "GET", url: "/health/live?probe=1" })).statusCode).toBe(200);
  });
  it("a valid token still reaches handlers, and unknown routes are then an ordinary 404", async () => {
    const res = await make().inject({ method: "GET", url: "/nope", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(404);
  });
  it("non-GET methods on public paths are not public", async () => {
    expect((await make().inject({ method: "POST", url: "/health/live" })).statusCode).toBe(401);
    expect((await make().inject({ method: "DELETE", url: "/health/live" })).statusCode).toBe(401);
  });
});

describe("no configured token", () => {
  it("refuses protected requests with 503 instead of running open; public paths still work", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerBearerAuth(app, undefined);
    registerIntakeRoutes(app, undefined);
    app.get("/health/live", async () => ({ ok: true }));
    expect((await app.inject({ method: "POST", url: "/v1/intake", payload: {} })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/anything", headers: { authorization: "Bearer whatever" } })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  });
});
