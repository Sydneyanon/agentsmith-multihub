import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildPoolConfig, selectMigrationUrl } from "./db-config.js";

const local = "postgres://u@127.0.0.1:5432/agentsmith";
const remote = "postgres://u:p@direct.mycluster.flympg.net/fly-db";

describe("buildPoolConfig", () => {
  it("uses safe defaults for a loopback development database (no TLS)", () => {
    const config = buildPoolConfig({ DATABASE_URL: local }, { max: 5 });
    expect(config).toMatchObject({ connectionString: local, max: 5, connectionTimeoutMillis: 3_000, idleTimeoutMillis: 30_000, maxLifetimeSeconds: 600 });
    expect(config.ssl).toBeUndefined();
  });

  it("turns TLS on, with certificate verification, in production", () => {
    expect(buildPoolConfig({ DATABASE_URL: local, NODE_ENV: "production" }, { max: 3 }).ssl).toEqual({ rejectUnauthorized: true });
  });

  it("turns TLS on for any non-loopback host even outside production (for example a migration run)", () => {
    expect(buildPoolConfig({ DATABASE_URL: remote }, { max: 1 }).ssl).toEqual({ rejectUnauthorized: true });
  });

  it("allows verification to be disabled only by an explicit DATABASE_SSL_VERIFY=false", () => {
    expect(buildPoolConfig({ DATABASE_URL: remote, DATABASE_SSL_VERIFY: "false" }, { max: 1 }).ssl).toEqual({ rejectUnauthorized: false });
    expect(buildPoolConfig({ DATABASE_URL: remote, DATABASE_SSL_VERIFY: "true" }, { max: 1 }).ssl).toEqual({ rejectUnauthorized: true });
    expect(buildPoolConfig({ DATABASE_URL: remote, DATABASE_SSL_VERIFY: "" }, { max: 1 }).ssl).toEqual({ rejectUnauthorized: true });
    expect(() => buildPoolConfig({ DATABASE_URL: remote, DATABASE_SSL_VERIFY: "0" }, { max: 1 })).toThrow(/DATABASE_SSL_VERIFY/);
    expect(() => buildPoolConfig({ DATABASE_URL: remote, DATABASE_SSL_VERIFY: "no" }, { max: 1 })).toThrow(/DATABASE_SSL_VERIFY/);
  });

  it("never disables verification for a loopback database that does not use TLS at all", () => {
    expect(buildPoolConfig({ DATABASE_URL: local, DATABASE_SSL_VERIFY: "false" }, { max: 1 }).ssl).toBeUndefined();
  });

  it("reads and bounds the connect timeout so a paused database can wake", () => {
    expect(buildPoolConfig({ DATABASE_URL: remote, DATABASE_CONNECT_TIMEOUT_MS: "30000" }, { max: 1 }).connectionTimeoutMillis).toBe(30_000);
    expect(buildPoolConfig({ DATABASE_URL: remote }, { max: 1, defaultConnectTimeoutMs: 5_000 }).connectionTimeoutMillis).toBe(5_000);
    for (const bad of ["abc", "999", "60001", "-5", "1.5", "NaN"]) {
      expect(() => buildPoolConfig({ DATABASE_URL: remote, DATABASE_CONNECT_TIMEOUT_MS: bad }, { max: 1 }), bad).toThrow(/DATABASE_CONNECT_TIMEOUT_MS/);
    }
  });

  it("fails closed without a usable database URL instead of using ambient settings", () => {
    expect(() => buildPoolConfig({}, { max: 1 })).toThrow(/required/);
    expect(() => buildPoolConfig({ DATABASE_URL: "postgres:///db" }, { max: 1 })).toThrow(/no host/);
    expect(() => buildPoolConfig({ DATABASE_URL: "postgres://u@x.example.com/db?host=other.example.com" }, { max: 1 })).toThrow(/override the host/);
  });

  it("never puts credentials in an error message", () => {
    expect.assertions(2);
    try { buildPoolConfig({ DATABASE_URL: "mysql://admin:topsecretpw@h/db" }, { max: 1 }); } catch (error) {
      expect((error as Error).message).not.toContain("topsecretpw");
      expect((error as Error).message).not.toContain("admin");
    }
  });
});

describe("which URL each component uses", () => {
  const env = { DATABASE_URL: "postgres://u:p@pooled.mycluster.flympg.net/db", DIRECT_DATABASE_URL: "postgres://u:p@direct.mycluster.flympg.net/db" };

  it("builds the application pool from DATABASE_URL by default", () => {
    expect(buildPoolConfig(env, { max: 5 }).connectionString).toBe(env.DATABASE_URL);
  });

  it("builds the migration pool from DIRECT_DATABASE_URL only when asked", () => {
    expect(buildPoolConfig(env, { max: 1, urlVariable: "DIRECT_DATABASE_URL" }).connectionString).toBe(env.DIRECT_DATABASE_URL);
  });

  it("does not fall back from one variable to the other", () => {
    expect(() => buildPoolConfig({ DATABASE_URL: env.DATABASE_URL }, { max: 1, urlVariable: "DIRECT_DATABASE_URL" })).toThrow(/required/);
    expect(() => buildPoolConfig({ DIRECT_DATABASE_URL: env.DIRECT_DATABASE_URL }, { max: 1 })).toThrow(/required/);
  });

  it("selects the migration URL from DIRECT_DATABASE_URL and ignores DATABASE_URL", () => {
    expect(selectMigrationUrl(env)).toBe(env.DIRECT_DATABASE_URL);
    expect(selectMigrationUrl({ ...env, DATABASE_URL: "postgres://u@127.0.0.1/other" })).toBe(env.DIRECT_DATABASE_URL);
  });

  it("refuses to select a migration URL when DIRECT_DATABASE_URL is missing or blank, whatever DATABASE_URL holds", () => {
    for (const direct of [undefined, "", "  "]) {
      expect(() => selectMigrationUrl({ DATABASE_URL: env.DATABASE_URL, DIRECT_DATABASE_URL: direct })).toThrow(/DIRECT_DATABASE_URL is required/);
    }
    expect(() => selectMigrationUrl({ DATABASE_URL: env.DATABASE_URL })).toThrow(/not used as a fallback/);
  });

  it("keeps the migration runner source free of any DATABASE_URL read", () => {
    const source = readFileSync(new URL("../../../scripts/migrate.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/env\.DATABASE_URL|env\["DATABASE_URL"\]|urlVariable: "DATABASE_URL"/);
    expect(source).toContain("selectMigrationUrl(process.env)");
    expect(source).toContain('urlVariable: "DIRECT_DATABASE_URL"');
  });
});

describe("TLS verification stays on unless explicitly overridden", () => {
  const remote = "postgres://u:p@direct.mycluster.flympg.net/fly-db";

  it("is enabled by default and never warns when enabled", () => {
    const warn = vi.fn();
    expect(buildPoolConfig({ DATABASE_URL: remote }, { max: 1, onWarning: warn }).ssl).toEqual({ rejectUnauthorized: true });
    expect(buildPoolConfig({ DATABASE_URL: remote, DATABASE_SSL_VERIFY: "true" }, { max: 1, onWarning: warn }).ssl).toEqual({ rejectUnauthorized: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns, naming the variable and host but no credentials, when the override disables verification", () => {
    const warn = vi.fn();
    const config = buildPoolConfig({ DIRECT_DATABASE_URL: remote, DATABASE_SSL_VERIFY: "false" }, { max: 1, urlVariable: "DIRECT_DATABASE_URL", onWarning: warn });
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain("DISABLED");
    expect(message).toContain("DIRECT_DATABASE_URL");
    expect(message).toContain("direct.mycluster.flympg.net");
    expect(message).not.toContain("u:p");
  });

  it("does not warn for a loopback database, where there is no TLS to disable", () => {
    const warn = vi.fn();
    buildPoolConfig({ DATABASE_URL: "postgres://u@127.0.0.1/db", DATABASE_SSL_VERIFY: "false" }, { max: 1, onWarning: warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
