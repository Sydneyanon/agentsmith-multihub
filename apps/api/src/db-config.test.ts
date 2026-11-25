import { describe, expect, it } from "vitest";
import { buildPoolConfig } from "./db-config.js";

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
