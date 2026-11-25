import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { HUB_HSTS, registerHubStatic } from "./hub-static.js";

const read = (name: string) => readFileSync(join(process.cwd(), name), "utf8");
const appName = (toml: string) => /^app = "([^"]+)"/m.exec(toml)?.[1];

describe("production hub Fly config (prepared, not deployed)", () => {
  const hub = read("fly.hub.toml");
  it("names its own app, never the pre-existing or the staging app", () => {
    expect(appName(hub)).toBe("agentsmith-hub");
    expect(appName(hub)).not.toBe(appName(read("fly.toml")));
    expect(appName(hub)).not.toBe(appName(read("fly.staging.toml")));
  });
  it("runs only the app process group, over HTTPS, with a liveness-only check", () => {
    expect(hub).toMatch(/\[processes\]\s+app = "npm start"\s*\n/);
    expect(hub.replace(/#.*$/gm, "")).not.toMatch(/worker/);
    expect(hub).toMatch(/force_https = true/);
    expect(hub).toMatch(/path = "\/health\/live"/);
    expect(hub).not.toMatch(/path = "\/health\/ready"/);
    expect(hub).toMatch(/internal_port = 8080/);
    expect(hub).toMatch(/PORT = "8080"/);
  });
  it("contains no secret values or database URLs", () => {
    const code = hub.replace(/#.*$/gm, "");
    expect(code).not.toMatch(/API_BEARER_TOKEN|DATABASE_URL\s*=|postgres(ql)?:\/\//i);
    expect(code).not.toMatch(/[A-Za-z0-9+/_-]{40,}/);
  });
  it("binds the app to its one permanent hostname, with no wildcard", () => {
    const code = hub.replace(/#.*$/gm, "");
    expect(code).toMatch(/HUB_ALLOWED_HOSTS = "hub\.agentsmithdesk\.xyz"/);
    expect(code).not.toMatch(/HUB_ALLOWED_HOSTS = "[^"]*[*,]/);
  });
  it("sets production mode, which switches HSTS on", () => {
    expect(hub).toMatch(/NODE_ENV = "production"/);
  });
});

describe("hub static HSTS", () => {
  const build = async (hsts: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "hub-hsts-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>");
    const app = Fastify({ logger: false });
    registerHubStatic(app, { assetsDir: dir, hsts });
    await app.ready();
    return { app, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };
  it("sends Strict-Transport-Security when enabled, scoped to the hub host only", async () => {
    const { app, cleanup } = await build(true);
    const res = await app.inject({ method: "GET", url: "/hub/" });
    expect(res.headers["strict-transport-security"]).toBe(HUB_HSTS);
    expect(HUB_HSTS).not.toMatch(/includeSubDomains|preload/i);
    await app.close(); cleanup();
  });
  it("sends nothing when disabled (local http)", async () => {
    const { app, cleanup } = await build(false);
    expect((await app.inject({ method: "GET", url: "/hub/" })).headers["strict-transport-security"]).toBeUndefined();
    await app.close(); cleanup();
  });
});

import { parseAllowedHosts, registerHostGuard } from "./host-guard.js";
describe("host allow-list", () => {
  const build = (hosts: string[]) => {
    const app = Fastify({ logger: false });
    registerHostGuard(app, hosts);
    app.get("/hub/", async () => ({ ok: true }));
    app.get("/v1/x", async () => ({ ok: true }));
    app.get("/health/live", async () => ({ ok: true }));
    app.get("/health/ready", async () => ({ ok: true }));
    return app;
  };
  const get = (app: ReturnType<typeof build>, url: string, host?: string) => app.inject({ method: "GET", url, ...(host ? { headers: { host } } : {}) });

  it("serves the intended hostname, with or without a port, in any letter case", async () => {
    const app = build(["hub.agentsmithdesk.xyz"]);
    for (const host of ["hub.agentsmithdesk.xyz", "HUB.AgentSmithDesk.XYZ", "hub.agentsmithdesk.xyz:443"]) expect((await get(app, "/hub/", host)).statusCode, host).toBe(200);
    await app.close();
  });
  it("refuses every other host with 421 before any route runs, including look-alikes", async () => {
    const app = build(["hub.agentsmithdesk.xyz"]);
    for (const host of ["agentsmith-hub.fly.dev", "hunt.agentsmithdesk.xyz", "agentsmithdesk.xyz", "evilhub.agentsmithdesk.xyz", "hub.agentsmithdesk.xyz.evil.example", "localhost"]) {
      for (const url of ["/hub/", "/v1/x"]) expect((await get(app, url, host)).statusCode, `${host}${url}`).toBe(421);
    }
    await app.close();
  });
  it("exempts only the two health endpoints, which the platform calls with its own host", async () => {
    const app = build(["hub.agentsmithdesk.xyz"]);
    for (const url of ["/health/live", "/health/ready"]) expect((await get(app, url, "10.0.0.5:8080")).statusCode).toBe(200);
    expect((await get(app, "/health/live?x=1", "10.0.0.5:8080")).statusCode).toBe(421);
    await app.close();
  });
  it("restricts nothing when no list is configured", async () => {
    const app = build([]);
    expect((await get(app, "/hub/", "anything.example")).statusCode).toBe(200);
    await app.close();
  });
  it("parses and validates the setting", () => {
    expect(parseAllowedHosts(undefined)).toEqual({ hosts: [] });
    expect(parseAllowedHosts(" Hub.AgentSmithDesk.xyz , hub.agentsmithdesk.xyz ")).toEqual({ hosts: ["hub.agentsmithdesk.xyz"] });
    for (const bad of ["*.agentsmithdesk.xyz", "https://hub.agentsmithdesk.xyz", "hub.agentsmithdesk.xyz:443", "hub.agentsmithdesk.xyz/x", "localhost", "a b.example"]) {
      expect(parseAllowedHosts(bad), bad).toHaveProperty("error");
    }
  });
});
