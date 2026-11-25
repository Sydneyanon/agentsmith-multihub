import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  REPO_ROOT, assertIntegrationConfigured, createTestDatabase, runMigrate, skipIntegration, type TestDatabase,
} from "./harness.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const realMigrations = readdirSync(join(REPO_ROOT, "db", "migrations")).filter((name) => name.endsWith(".sql")).sort();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A scratch working directory containing db/migrations (the runner reads process.cwd()/db/migrations). */
function scratch(files: Record<string, string> | "copy-real"): string {
  const root = mkdtempSync(join(tmpdir(), "agentsmith-migrations-"));
  const dir = join(root, "db", "migrations");
  mkdirSync(dir, { recursive: true });
  if (files === "copy-real") cpSync(join(REPO_ROOT, "db", "migrations"), dir, { recursive: true });
  else for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return root;
}

describe.skipIf(skipIntegration)("migration runner protections against real Postgres", () => {
  const databases: TestDatabase[] = [];
  const scratchDirs: string[] = [];
  const fresh = async () => { const db = await createTestDatabase(); databases.push(db); return db; };
  const scratchDir = (files: Parameters<typeof scratch>[0]) => { const dir = scratch(files); scratchDirs.push(dir); return dir; };
  const ledger = async (db: TestDatabase) =>
    (await db.pool.query<{ name: string; checksum: string; applied_at: Date }>("SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name")).rows;
  const tableExists = async (db: TestDatabase, table: string) =>
    (await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1", [table])).rowCount === 1;

  beforeAll(() => { assertIntegrationConfigured(); });
  afterEach(async () => {
    while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });
  afterAll(async () => { for (const db of databases) await db.drop(); });

  it("applies every repository migration once, recording a SHA-256 checksum for each", async () => {
    const db = await fresh();
    const result = await runMigrate({ directUrl: db.url });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.match(/^Applied /gm)).toHaveLength(realMigrations.length);
    const rows = await ledger(db);
    expect(rows.map((row) => row.name)).toEqual(realMigrations);
    for (const row of rows) expect(row.checksum).toBe(sha(readFileSync(join(REPO_ROOT, "db", "migrations", row.name), "utf8")));
    for (const table of ["workflow_runs", "workflow_steps", "source_snapshots", "ai_budget_reservations", "ai_model_prices", "hunt_gate_results"]) {
      expect(await tableExists(db, table), table).toBe(true);
    }
  });

  it("is idempotent: a second run applies nothing and leaves the ledger untouched", async () => {
    const db = await fresh();
    await runMigrate({ directUrl: db.url });
    const before = await ledger(db);
    const again = await runMigrate({ directUrl: db.url });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).not.toMatch(/Applied /);
    expect(await ledger(db)).toEqual(before);
  });

  it("refuses to run when an applied migration file has changed, and applies nothing after it", async () => {
    const db = await fresh();
    const cwd = scratchDir("copy-real");
    expect((await runMigrate({ directUrl: db.url, cwd })).code).toBe(0);
    const before = await ledger(db);
    const tampered = join(cwd, "db", "migrations", realMigrations[2]!);
    writeFileSync(tampered, `${readFileSync(tampered, "utf8")}\n-- edited after being applied\n`);
    writeFileSync(join(cwd, "db", "migrations", "0099_must_not_run.sql"), "CREATE TABLE must_not_run (id int);");
    const result = await runMigrate({ directUrl: db.url, cwd });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`Applied migration ${realMigrations[2]} has changed`);
    expect(await ledger(db)).toEqual(before);
    expect(await tableExists(db, "must_not_run")).toBe(false);
  });

  it("serializes concurrent runners with the advisory lock: each migration applies exactly once", async () => {
    const db = await fresh();
    const results = await Promise.all([1, 2, 3, 4].map(() => runMigrate({ directUrl: db.url })));
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    const applied = results.flatMap((result) => result.stdout.match(/^Applied \S+/gm) ?? []);
    expect(applied.sort()).toEqual(realMigrations.map((name) => `Applied ${name}`).sort());
    expect((await ledger(db)).map((row) => row.name)).toEqual(realMigrations);
  });

  it("rolls a failing migration back completely, keeps earlier ones, and recovers once fixed", async () => {
    const db = await fresh();
    const cwd = scratchDir({
      "0001_ok.sql": "CREATE TABLE t_ok (id int);",
      "0002_bad.sql": "CREATE TABLE t_partial (id int); SELECT 1/0;",
    });
    const failed = await runMigrate({ directUrl: db.url, cwd });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toMatch(/division by zero/);
    expect((await ledger(db)).map((row) => row.name)).toEqual(["0001_ok.sql"]);
    expect(await tableExists(db, "t_ok")).toBe(true);
    expect(await tableExists(db, "t_partial")).toBe(false);

    writeFileSync(join(cwd, "db", "migrations", "0002_bad.sql"), "CREATE TABLE t_partial (id int);");
    const fixed = await runMigrate({ directUrl: db.url, cwd });
    expect(fixed.code, fixed.stderr).toBe(0);
    expect((await ledger(db)).map((row) => row.name)).toEqual(["0001_ok.sql", "0002_bad.sql"]);
    expect(await tableExists(db, "t_partial")).toBe(true);
  });

  describe("URL selection and connection safety at the migration entry point", () => {
    it("migrates the DIRECT_DATABASE_URL database and never touches DATABASE_URL", async () => {
      const target = await fresh();
      const decoy = await fresh(); // a valid, reachable database in DATABASE_URL that must stay untouched
      const result = await runMigrate({ directUrl: target.url, extraEnv: { DATABASE_URL: decoy.url } });
      expect(result.code, result.stderr).toBe(0);
      expect((await ledger(target)).map((row) => row.name)).toEqual(realMigrations);
      expect((await decoy.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0]!.n).toBe(0);
    });

    it("fails closed without DIRECT_DATABASE_URL, even when a valid DATABASE_URL is present", async () => {
      const app = await fresh();
      const result = await runMigrate({ extraEnv: { DATABASE_URL: app.url } });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("DIRECT_DATABASE_URL is required");
      expect((await app.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'")).rowCount).toBe(0);
    });

    it("treats a blank DIRECT_DATABASE_URL as missing", async () => {
      const app = await fresh();
      for (const blank of ["", "   "]) {
        const result = await runMigrate({ directUrl: blank, extraEnv: { DATABASE_URL: app.url } });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("DIRECT_DATABASE_URL is required");
      }
      expect((await app.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'")).rowCount).toBe(0);
    });

    it("refuses a non-loopback direct host before connecting, without echoing credentials", async () => {
      const result = await runMigrate({ directUrl: "postgres://admin:topsecretpw@direct.mycluster.invalid:5432/prod" });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('Refusing to migrate non-loopback host "direct.mycluster.invalid"');
      expect(result.stderr).not.toContain("topsecretpw");
      expect(result.stderr).not.toMatch(/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/); // it never tried to connect
    });

    it("refuses when the confirmation names a different host", async () => {
      const result = await runMigrate({
        directUrl: "postgres://u@direct.mycluster.invalid/prod", extraEnv: { MIGRATE_CONFIRM_REMOTE_HOST: "other.mycluster.invalid" },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Refusing to migrate");
      expect(result.stderr).not.toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo/);
    });

    it("checks the confirmation against the DIRECT host, not the application URL's host", async () => {
      const result = await runMigrate({
        directUrl: "postgres://u@direct.mycluster.invalid/prod",
        extraEnv: { DATABASE_URL: "postgres://u@pooled.mycluster.invalid/prod", MIGRATE_CONFIRM_REMOTE_HOST: "pooled.mycluster.invalid" },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('Refusing to migrate non-loopback host "direct.mycluster.invalid"');
    });

    it("lets an exactly confirmed direct host through the guard (it then fails only because the host does not exist)", async () => {
      const result = await runMigrate({
        directUrl: "postgres://u@direct.mycluster.invalid/prod", extraEnv: { MIGRATE_CONFIRM_REMOTE_HOST: "direct.mycluster.invalid" },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).not.toContain("Refusing to migrate");
      expect(result.stderr).toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo|ETIMEDOUT|ECONNREFUSED/);
    });

    it("never falls back to ambient PG* settings when the direct URL has no host", async () => {
      const db = await fresh();
      const url = new URL(db.url);
      const result = await runMigrate({
        directUrl: `postgres:///${db.name}`,
        extraEnv: { PGHOST: url.hostname, PGPORT: url.port, PGUSER: url.username },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/no host|not parseable/);
      expect((await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'")).rowCount).toBe(0);
    });

    it("warns visibly when TLS verification has been explicitly disabled for a remote direct host", async () => {
      const result = await runMigrate({
        directUrl: "postgres://u@direct.mycluster.invalid/prod",
        extraEnv: { MIGRATE_CONFIRM_REMOTE_HOST: "direct.mycluster.invalid", DATABASE_SSL_VERIFY: "false" },
      });
      expect(result.stderr).toContain("TLS certificate verification is DISABLED");
      expect(result.stderr).toContain("DIRECT_DATABASE_URL");
    });
  });
});
