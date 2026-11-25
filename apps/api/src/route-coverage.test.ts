import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { AuthFailureLimiter, PUBLIC_ROUTE_DESCRIPTIONS, isPublicRequest } from "./auth.js";

const token = randomBytes(36).toString("base64url");

describe("every registered route is either explicitly public or requires the token", () => {
  const routes: Array<{ method: string; url: string }> = [];
  const app = buildApp({ pool: undefined, apiBearerToken: token, hubAllowedHosts: [], limiter: new AuthFailureLimiter({ perClientMax: 1e6, globalMax: 1e6, windowMs: 60_000 }), onRouteRegistered: (r) => routes.push(r) });

  it("registers a non-trivial route set", () => { expect(routes.length).toBeGreaterThan(15); });

  it("unauthenticated requests to each route are 401 unless the route is on the public allow-list", async () => {
    const concrete = (url: string) => url.replace(/:[A-Za-z_]+/g, "x1").replace(/\*/g, "x");
    const publicSeen: string[] = [];
    for (const r of routes) {
      if (r.method === "HEAD" || r.method === "OPTIONS") continue;
      const url = concrete(r.url);
      const res = await app.inject({ method: r.method as "GET", url });
      if (isPublicRequest(r.method, url)) { publicSeen.push(`${r.method} ${r.url}`); expect(res.statusCode, `${r.method} ${url}`).not.toBe(401); }
      else expect(res.statusCode, `${r.method} ${url} must require authentication`).toBe(401);
    }
    // The set of public routes is exactly the documented allow-list — adding one is a deliberate, reviewed change.
    expect(publicSeen.sort()).toEqual(["GET /", "GET /health/live", "GET /health/ready", "GET /hub", "GET /hub/", "GET /hub/assets/:name"].sort());
    expect(PUBLIC_ROUTE_DESCRIPTIONS.length).toBe(6);
  });

  it("an unauthenticated client cannot reach any /v1 route by mangling the path", async () => {
    for (const url of ["/v1/research/overview", "//v1/research/overview", "/V1/research/overview", "/v1/research/overview/", "/v1%2Fresearch/overview"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });
});
