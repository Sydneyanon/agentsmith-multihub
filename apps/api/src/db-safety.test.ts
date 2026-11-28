import { describe, expect, it } from "vitest";
import {
  UnsafeDatabaseTargetError, assertDisposableTestDatabaseUrl, assertLoopbackDatabaseUrl, assertMigrationTarget, parseDatabaseTarget,
} from "./db-safety.js";

const refused = (fn: () => unknown, pattern: RegExp) => expect(fn).toThrow(pattern);

describe("loopback database guard", () => {
  it("accepts loopback hosts only", () => {
    for (const url of ["postgres://u@localhost:5432/db", "postgresql://u:p@127.0.0.1:54340/postgres", "postgres://u@[::1]:5432/db", "postgres://u@LOCALHOST/db"]) {
      expect(() => assertLoopbackDatabaseUrl(url), url).not.toThrow();
    }
  });

  it("refuses hosted, internal, lookalike and private-network hosts", () => {
    const hosts = [
      "ep-cool-123.ap-southeast-2.aws.neon.tech", "agentsmith-multihub.flycast", "agentsmith-db.internal", "db.fly.dev",
      "mydb.abc.rds.amazonaws.com", "localhost.evil.com", "127.0.0.1.nip.io", "10.0.0.5", "192.168.1.9", "0.0.0.0", "[fd00::1]",
    ];
    for (const host of hosts) refused(() => assertLoopbackDatabaseUrl(`postgres://u:p@${host}:5432/db`), /non-loopback database host/);
  });

  it("is not fooled by credentials, ports or userinfo that look like loopback", () => {
    refused(() => assertLoopbackDatabaseUrl("postgres://127.0.0.1@evil.example.com/db"), /evil\.example\.com/);
    refused(() => assertLoopbackDatabaseUrl("postgres://localhost:5432@evil.example.com/db"), /evil\.example\.com/);
    refused(() => assertLoopbackDatabaseUrl("postgres://u@evil.example.com:5432/localhost"), /evil\.example\.com/);
  });

  it("fails closed on missing, malformed, wrong-scheme or hostless URLs (no ambient PG* fallback)", () => {
    refused(() => assertLoopbackDatabaseUrl(undefined), /required/);
    refused(() => assertLoopbackDatabaseUrl(""), /required/);
    refused(() => assertLoopbackDatabaseUrl("not a url"), /not parseable/);
    refused(() => assertLoopbackDatabaseUrl("mysql://u@127.0.0.1/db"), /scheme/);
    refused(() => assertLoopbackDatabaseUrl("postgres:///db"), /no host/);
    refused(() => assertLoopbackDatabaseUrl("postgres://u@/db"), /not parseable|no host/);
  });

  it("refuses URL parameters that could override the host", () => {
    for (const key of ["host", "hostaddr", "service"]) {
      refused(() => assertLoopbackDatabaseUrl(`postgres://u@127.0.0.1/db?${key}=db.example.com`), /could override the host/);
    }
  });

  it("never echoes credentials in an error", () => {
    try {
      assertLoopbackDatabaseUrl("postgres://admin:s3cretpass@db.example.com:5432/prod");
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeDatabaseTargetError);
      expect((error as Error).message).not.toContain("s3cretpass");
      expect((error as Error).message).not.toContain("admin");
    }
  });
});

describe("disposable test database guard", () => {
  it("accepts only per-run agentsmith_test_<12 hex> database names on loopback", () => {
    expect(() => assertDisposableTestDatabaseUrl("postgres://u@127.0.0.1:5432/agentsmith_test_0123456789ab")).not.toThrow();
    for (const name of ["postgres", "agentsmith", "agentsmith_demo", "agentsmith_test_", "agentsmith_test_XYZ", "agentsmith_test_0123456789abc", "production"]) {
      refused(() => assertDisposableTestDatabaseUrl(`postgres://u@127.0.0.1:5432/${name}`), /named agentsmith_test_/);
    }
    refused(() => assertDisposableTestDatabaseUrl("postgres://u@db.example.com/agentsmith_test_0123456789ab"), /non-loopback/);
  });
});

describe("migration target guard", () => {
  it("allows loopback and refuses everything else unless the exact host is confirmed", () => {
    expect(() => assertMigrationTarget("postgres://u@127.0.0.1/db", undefined)).not.toThrow();
    refused(() => assertMigrationTarget("postgres://u@db.example.com/db", undefined), /MIGRATE_CONFIRM_REMOTE_HOST/);
    refused(() => assertMigrationTarget("postgres://u@db.example.com/db", "other.example.com"), /MIGRATE_CONFIRM_REMOTE_HOST/);
    refused(() => assertMigrationTarget("postgres://u@db.example.com/db", ""), /MIGRATE_CONFIRM_REMOTE_HOST/);
    expect(() => assertMigrationTarget("postgres://u@db.example.com/db", "DB.example.com")).not.toThrow();
  });

  it("still rejects missing or hostless URLs even with a confirmation", () => {
    refused(() => assertMigrationTarget(undefined, "x"), /required/);
    refused(() => assertMigrationTarget("postgres:///db", "x"), /no host/);
  });
});

describe("parseDatabaseTarget", () => {
  it("extracts host, port and database without credentials", () => {
    expect(parseDatabaseTarget("postgres://u:p@localhost:5433/mydb")).toEqual({ host: "localhost", port: "5433", database: "mydb" });
  });
});
