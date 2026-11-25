import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { AuthFailureLimiter } from "./auth.js";

const token = randomBytes(36).toString("base64url");
const apps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

type Opts = { perClientMax?: number; globalMax?: number; trustedProxyCidrs?: string[] };
function build(o: Opts = {}) {
  let t = 1_000_000;
  const app = buildApp({
    pool: undefined, apiBearerToken: token, hubAllowedHosts: [],
    limiter: new AuthFailureLimiter({ perClientMax: o.perClientMax ?? 3, globalMax: o.globalMax ?? 100, windowMs: 60_000, now: () => t }),
    ...(o.trustedProxyCidrs ? { trustedProxyCidrs: o.trustedProxyCidrs } : {}),
  });
  apps.push(app);
  return { app, advance: (ms: number) => { t += ms; } };
}
const call = (app: ReturnType<typeof build>["app"], opts: { auth?: string; remoteAddress?: string; headers?: Record<string, string> } = {}) =>
  app.inject({ method: "GET", url: "/v1/research/overview", remoteAddress: opts.remoteAddress ?? "10.9.9.9", headers: { ...(opts.auth ? { authorization: opts.auth } : {}), ...opts.headers } });
const good = `Bearer ${token}`;

describe("a valid operator token is never locked out", () => {
  it("still succeeds after the client has exhausted its failed-attempt budget", async () => {
    const { app } = build();
    for (let i = 0; i < 6; i += 1) await call(app, { auth: "Bearer wrong" });
    expect((await call(app, { auth: "Bearer wrong" })).statusCode).toBe(429);
    expect((await call(app, { auth: good })).statusCode).not.toBe(429);
    expect((await call(app, { auth: good })).statusCode).not.toBe(401);
  });
  it("still succeeds while the GLOBAL failure cap is exhausted by an attacker", async () => {
    const { app } = build({ perClientMax: 1000, globalMax: 5 });
    for (let i = 0; i < 8; i += 1) await call(app, { auth: "Bearer wrong", remoteAddress: `203.0.113.${i + 1}` });
    expect((await call(app, { auth: "Bearer wrong", remoteAddress: "198.51.100.1" })).statusCode).toBe(429);
    const ok = await call(app, { auth: good, remoteAddress: "192.0.2.77" });
    expect(ok.statusCode).not.toBe(429);
    expect(ok.statusCode).not.toBe(401);
  });
  it("an attacker sharing the operator's address cannot lock the operator out", async () => {
    const { app } = build();
    for (let i = 0; i < 20; i += 1) await call(app, { auth: "Bearer guess" + i, remoteAddress: "192.0.2.10" });
    const ok = await call(app, { auth: good, remoteAddress: "192.0.2.10" });
    expect([401, 429]).not.toContain(ok.statusCode);
  });
});

describe("invalid attempts are still throttled", () => {
  it("answers 429 with Retry-After (and no token material) to invalid attempts once over budget, and recovers", async () => {
    const { app, advance } = build();
    for (let i = 0; i < 3; i += 1) expect((await call(app, { auth: "Bearer wrong" })).statusCode).toBe(401);
    const locked = await call(app, { auth: "Bearer wrong" });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect(locked.body).not.toContain(token);
    advance(61_000);
    expect((await call(app, { auth: "Bearer wrong" })).statusCode).toBe(401);
  });
  it("requests without credentials count as failures; public paths do not", async () => {
    const { app } = build();
    for (let i = 0; i < 10; i += 1) await app.inject({ method: "GET", url: "/health/live", remoteAddress: "10.9.9.9" });
    for (let i = 0; i < 3; i += 1) expect((await call(app)).statusCode).toBe(401);
    expect((await call(app)).statusCode).toBe(429);
  });
  it("attempts made while locked out do not extend the lockout indefinitely", async () => {
    const { app, advance } = build();
    for (let i = 0; i < 3; i += 1) await call(app, { auth: "Bearer wrong" });
    for (let i = 0; i < 50; i += 1) await call(app, { auth: "Bearer wrong" });
    advance(61_000);
    expect((await call(app, { auth: "Bearer wrong" })).statusCode).toBe(401);
  });
});

describe("client identity is not taken from spoofable headers", () => {
  const rotating = async (extra: (i: number) => Record<string, string>, opts: Opts = {}) => {
    const { app } = build(opts);
    let last = 0;
    for (let i = 0; i < 6; i += 1) last = (await call(app, { auth: "Bearer wrong", headers: extra(i) })).statusCode;
    return last;
  };
  it("a rotating X-Forwarded-For does not give an attacker a fresh budget each time", async () => {
    expect(await rotating((i) => ({ "x-forwarded-for": `203.0.113.${i + 1}` }))).toBe(429);
  });
  it("neither does a spoofed Fly-Client-IP or Forwarded header from an untrusted peer", async () => {
    expect(await rotating((i) => ({ "fly-client-ip": `203.0.113.${i + 1}` }))).toBe(429);
    expect(await rotating((i) => ({ forwarded: `for=203.0.113.${i + 1}` }))).toBe(429);
  });
  it("a spoofed header cannot make an attacker's failures count against someone else", async () => {
    const { app } = build();
    for (let i = 0; i < 6; i += 1) await call(app, { auth: "Bearer wrong", headers: { "x-forwarded-for": "192.0.2.200" } });
    // the victim's own address was never charged
    expect((await call(app, { auth: "Bearer wrong", remoteAddress: "192.0.2.200" })).statusCode).toBe(401);
  });
});

describe("a configured trusted proxy may supply Fly-Client-IP — and only it", () => {
  const cidrs = ["172.19.0.0/16", "fdaa::/16"];
  it("uses Fly-Client-IP when the socket peer is inside a trusted CIDR", async () => {
    const { app } = build({ trustedProxyCidrs: cidrs });
    for (let i = 0; i < 3; i += 1) await call(app, { auth: "Bearer wrong", remoteAddress: "172.19.5.233", headers: { "fly-client-ip": "198.51.100.7" } });
    expect((await call(app, { auth: "Bearer wrong", remoteAddress: "172.19.5.233", headers: { "fly-client-ip": "198.51.100.7" } })).statusCode).toBe(429);
    // a different real client behind the same gateway keeps its own budget
    expect((await call(app, { auth: "Bearer wrong", remoteAddress: "172.19.5.233", headers: { "fly-client-ip": "198.51.100.8" } })).statusCode).toBe(401);
  });
  it("supports IPv6 gateways and IPv4-mapped peers", async () => {
    const { app } = build({ trustedProxyCidrs: cidrs });
    for (let i = 0; i < 3; i += 1) await call(app, { auth: "Bearer wrong", remoteAddress: "fdaa:11e:350:a7b::2", headers: { "fly-client-ip": "198.51.100.7" } });
    expect((await call(app, { auth: "Bearer wrong", remoteAddress: "::ffff:172.19.5.233", headers: { "fly-client-ip": "198.51.100.7" } })).statusCode).toBe(429);
  });
  it("ignores Fly-Client-IP from a peer outside the trusted CIDRs and ignores X-Forwarded-For even from a trusted peer", async () => {
    const { app } = build({ trustedProxyCidrs: cidrs });
    for (let i = 0; i < 6; i += 1) await call(app, { auth: "Bearer wrong", remoteAddress: "10.9.9.9", headers: { "fly-client-ip": `198.51.100.${i + 1}` } });
    expect((await call(app, { auth: "Bearer wrong", remoteAddress: "10.9.9.9", headers: { "fly-client-ip": "198.51.100.99" } })).statusCode).toBe(429);
    const second = build({ trustedProxyCidrs: cidrs });
    for (let i = 0; i < 6; i += 1) await call(second.app, { auth: "Bearer wrong", remoteAddress: "172.19.5.233", headers: { "x-forwarded-for": `198.51.100.${i + 1}` } });
    expect((await call(second.app, { auth: "Bearer wrong", remoteAddress: "172.19.5.233", headers: { "x-forwarded-for": "198.51.100.99" } })).statusCode).toBe(429);
  });
  it("falls back to the peer when the header is absent, repeated, or not a single valid address", async () => {
    for (const bad of ["", "not-an-ip", "1.2.3.4, 5.6.7.8", "999.1.1.1", "198.51.100.7 "]) {
      const { app } = build({ trustedProxyCidrs: cidrs });
      let last = 0;
      for (let i = 0; i < 6; i += 1) last = (await call(app, { auth: "Bearer wrong", remoteAddress: "172.19.5.233", headers: { "fly-client-ip": bad || " " } })).statusCode;
      expect(last, JSON.stringify(bad)).toBe(429);
    }
  });
  it("rotating malformed header values from a trusted peer do not mint fresh budgets", async () => {
    const { app } = build({ trustedProxyCidrs: cidrs });
    let last = 0;
    for (let i = 0; i < 6; i += 1) last = (await call(app, { auth: "Bearer wrong", remoteAddress: "172.19.5.233", headers: { "fly-client-ip": `junk-${i}` } })).statusCode;
    expect(last).toBe(429);
  });
  it("trusts nothing by default", async () => {
    const { app } = build();
    for (let i = 0; i < 6; i += 1) await call(app, { auth: "Bearer wrong", remoteAddress: "172.19.5.233", headers: { "fly-client-ip": `198.51.100.${i + 1}` } });
    expect((await call(app, { auth: "Bearer wrong", remoteAddress: "172.19.5.233", headers: { "fly-client-ip": "198.51.100.77" } })).statusCode).toBe(429);
  });
});

describe("request.ip reflects the real peer, not a client-supplied header", () => {
  it("ignores X-Forwarded-For for the address the application sees and logs", async () => {
    const app = buildApp({ pool: undefined, apiBearerToken: token, hubAllowedHosts: [] });
    apps.push(app);
    app.get("/v1/probe-ip", async (request) => ({ ip: request.ip }));
    const res = await app.inject({ method: "GET", url: "/v1/probe-ip", remoteAddress: "10.9.9.9", headers: { authorization: good, "x-forwarded-for": "203.0.113.5, 198.51.100.1" } });
    expect(res.json()).toEqual({ ip: "10.9.9.9" });
  });
});
