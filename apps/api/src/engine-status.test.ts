import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { expectedMigrations, parseWorkerApplicationName, readBuildInfo, shapeError, workerApplicationName } from "./engine-status.js";
import { buildPoolConfig } from "./db-config.js";

describe("engine status (CR2) pure parts", () => {
  it("a worker session name round-trips, carries only the id and the switch, and fits Postgres's 63-byte limit", () => {
    const n = workerApplicationName("intake-2870320f99dd68", { STRUCTURAL_ANALYSIS_ENABLED: "true" });
    expect(n).toBe("agentsmith-worker/1 intake-2870320f99dd68 structural=1");
    expect(parseWorkerApplicationName(n)).toEqual({ worker_id: "intake-2870320f99dd68", structural_analysis: true });
    const long = workerApplicationName("x".repeat(200) + " with spaces", {});
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(63);
    expect(parseWorkerApplicationName(long)?.structural_analysis).toBe(false);
    expect(parseWorkerApplicationName("psql")).toBeNull();
  });
  it("the pool passes the session name to pg only when given", () => {
    const env = { DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db" };
    expect(buildPoolConfig(env, { max: 1, applicationName: "agentsmith-api/1" }).application_name).toBe("agentsmith-api/1");
    expect("application_name" in buildPoolConfig(env, { max: 1 })).toBe(false);
  });
  it("step errors are shaped: credentials, query strings, addresses, host:port and long opaque strings never pass", () => {
    const e = shapeError({ message: "fetch https://user:s3cret@api.example.com/repos/x?token=abc failed; connect ECONNREFUSED 10.1.2.3:5432 db.internal.example:6543 key=" + "A".repeat(40), retryable: true });
    expect(e.retryable).toBe(true);
    for (const leak of ["s3cret", "user:", "token=abc", "10.1.2.3", "6543", "A".repeat(40)]) expect(e.message).not.toContain(leak);
    expect(e.message).toContain("https://api.example.com/repos/x");
    expect(shapeError({ message: "x".repeat(500) }).message.length).toBeLessThanOrEqual(200);
    expect(shapeError(null)).toEqual({ message: "error recorded without a message", retryable: null });
  });
  it("build identity comes only from a validated build-info.json; a missing or malformed file says the build is unidentified", () => {
    const dir = mkdtempSync(join(tmpdir(), "bi-"));
    expect(readBuildInfo(join(dir, "none.json"))).toEqual({ commit: null, image: null, built_at: null, source: "none" });
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ commit: "a".repeat(40), image: "registry.fly.io/agentsmith-hub:hub-aaaaaaaaaaaa", built_at: "2026-11-26T10:00:00Z" }));
    expect(readBuildInfo(join(dir, "ok.json"))).toMatchObject({ commit: "a".repeat(40), source: "build-info.json" });
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ commit: "not a sha <script>", image: "x y", built_at: "yesterday" }));
    expect(readBuildInfo(join(dir, "bad.json"))).toMatchObject({ commit: null, image: null, built_at: null });
  });
  it("the shipped migration list is read from db/migrations", () => {
    const m = expectedMigrations();
    expect(m).toContain("0001_initial.sql"); expect(m).toContain("0008_discovery.sql");
  });
  it("without a database the endpoint is 503, and it always requires the token", async () => {
    const token = randomBytes(36).toString("base64url");
    const app = buildApp({ pool: undefined, apiBearerToken: token, hubAllowedHosts: [] });
    expect((await app.inject({ method: "GET", url: "/v1/engine/status" })).statusCode).toBe(401);
    const r = await app.inject({ method: "GET", url: "/v1/engine/status", headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(503); expect(r.json()).toEqual({ error: "database_not_configured" });
  });
});

describe("release readiness (A25 checklist)", () => {
  const read = (p: string) => require("node:fs").readFileSync(p, "utf8") as string;
  it("the release image build refuses to run without the last approved migration, drops later migrations and all drafts, and records both", () => {
    const s = read("scripts/hub-image.sh");
    expect(s).toMatch(/HUB_RELEASE_LAST_MIGRATION/);
    expect(s).toMatch(/set HUB_RELEASE_LAST_MIGRATION to the last migration approved for this release/);
    expect(s).toMatch(/rm -rf "\$WORK\/stage1\/db\/drafts"/);
    expect(s).toMatch(/"migrations_excluded":\[%s\]/);
    expect(read("scripts/hub-image-smoke.sh")).toMatch(/\[ ! -d "\$ROOTFS\/app\/db\/drafts" \]/);
  });
  it("discovery routes answer 503 discovery_not_installed (not 500) when migration 0008 is absent", async () => {
    const token = randomBytes(36).toString("base64url");
    const missing = Object.assign(new Error('relation "discovery_sources" does not exist'), { code: "42P01" });
    const pool = { query: async () => { throw missing; } } as never;
    const app = buildApp({ pool, apiBearerToken: token, hubAllowedHosts: [] });
    for (const url of ["/v1/discovery/sources", "/v1/discovery/opportunities", "/v1/discovery/opportunities/00000000-0000-4000-8000-000000000000"]) {
      const r = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      expect(r.statusCode, url).toBe(503); expect(r.json()).toEqual({ error: "discovery_not_installed" });
    }
  });
});
