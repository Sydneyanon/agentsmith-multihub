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
