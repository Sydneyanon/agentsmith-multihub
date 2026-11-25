import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessConnectedRole, enforceRuntimeRole, loadManifest, manifestCatalogProblems, TABLE_PRIVILEGES } from "../db-roles.js";
import { REPO_ROOT, createRuntimeRole, createTestDatabase, runMigrate, runScript, skipIntegration, type TestDatabase } from "./harness.js";

const manifest = loadManifest(join(REPO_ROOT, "db", "runtime-grants.json"));
/** `TEST_ROLE_UNDER_TEST=owner` points every check at the owner role: this is how production runs today, and the suite must fail for it. */
const asOwner = process.env.TEST_ROLE_UNDER_TEST === "owner";

describe.skipIf(skipIntegration)("least-privilege runtime role (real Postgres)", () => {
  let db: TestDatabase; let rt: pg.Pool; let role: string; let ownerName: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    const migrated = await runMigrate({ directUrl: db.url });
    if (migrated.code !== 0) throw new Error(`migrate failed: ${migrated.stderr.slice(0, 300)}`);
    const created = await createRuntimeRole(db);
    role = created.role;
    rt = asOwner ? db.pool : created.pool;
    if (asOwner) { await created.pool.end(); role = (await db.pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u; }
    ownerName = (await db.pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
    db.afterDrop = async () => { if (!asOwner) await db.adminPool.query(`DROP ROLE IF EXISTS ${created.role}`).catch(() => undefined); };
  });
  afterAll(async () => { if (rt !== db.pool) await rt.end().catch(() => undefined); await db?.drop(); });

  const denied = (sql: string) => expect(rt.query(sql), sql).rejects.toThrow(/permission denied|must be owner|must be superuser|cannot|not permitted|insufficient/i);

  describe("the grants manifest", () => {
    it("accounts for every table, view and non-trigger function in the migrated schema (and nothing that does not exist)", async () => {
      expect(await manifestCatalogProblems(db.pool, manifest)).toEqual([]);
    });
    it("is refused if it grants DELETE, TRUNCATE, TRIGGER or REFERENCES", () => {
      expect(Object.values(manifest.tables).flat().filter((p) => ["DELETE", "TRUNCATE", "TRIGGER", "REFERENCES"].includes(p))).toEqual([]);
    });
    it("fails the apply script when a table is missing from the manifest, and changes nothing", async () => {
      await db.pool.query("CREATE TABLE unlisted_probe (id int)");
      const r = await runScript("scripts/apply-runtime-grants.ts", { DIRECT_DATABASE_URL: db.url, RUNTIME_ROLE: role });
      await db.pool.query("DROP TABLE unlisted_probe");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("unlisted_probe");
    });
    it("refuses to use a role with elevated attributes as the runtime role", async () => {
      const bad = `${role}_elev`;
      await db.adminPool.query(`CREATE ROLE ${bad} LOGIN CREATEDB`);
      try {
        const r = await runScript("scripts/apply-runtime-grants.ts", { DIRECT_DATABASE_URL: db.url, RUNTIME_ROLE: bad });
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain("elevated attributes");
      } finally { await db.adminPool.query(`DROP ROLE ${bad}`); }
    });
    it("removes CREATE on the schema that PUBLIC holds (the default on PostgreSQL 14 and older)", async () => {
      await db.pool.query("GRANT CREATE ON SCHEMA public TO PUBLIC");
      expect((await rt.query<{ h: boolean }>("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS h")).rows[0]!.h).toBe(true);
      const r = await runScript("scripts/apply-runtime-grants.ts", { DIRECT_DATABASE_URL: db.url, RUNTIME_ROLE: role });
      expect(r.code, r.stderr).toBe(0);
      expect((await rt.query<{ h: boolean }>("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS h")).rows[0]!.h).toBe(false);
    });
    it("is idempotent", async () => {
      for (let i = 0; i < 2; i += 1) {
        const r = await runScript("scripts/apply-runtime-grants.ts", { DIRECT_DATABASE_URL: db.url, RUNTIME_ROLE: role });
        expect(r.code, r.stderr).toBe(0);
      }
    });
  });

  describe("the role itself", () => {
    it("has no elevated attributes, owns nothing, cannot create objects, and is a member of no other role", async () => {
      const a = await assessConnectedRole(rt);
      expect(a.problems).toEqual([]);
      expect(a.ok).toBe(true);
    });
    it("the assessment itself flags superuser-like attributes, so it cannot silently pass a powerful role", async () => {
      const probe = `${role}_probe`;
      await db.adminPool.query(`CREATE ROLE ${probe} LOGIN PASSWORD 'p' CREATEROLE CREATEDB`);
      await db.adminPool.query(`GRANT CONNECT ON DATABASE ${db.name} TO ${probe}`);
      const u = new URL(db.url); u.username = probe; u.password = "p";
      const pool = new pg.Pool({ connectionString: u.toString(), max: 1 });
      try {
        const a = await assessConnectedRole(pool);
        expect(a.ok).toBe(false);
        expect(a.problems.join(" ")).toMatch(/CREATEROLE/);
        expect(a.problems.join(" ")).toMatch(/CREATEDB/);
      } finally { await pool.end(); await db.adminPool.query(`REVOKE CONNECT ON DATABASE ${db.name} FROM ${probe}`); await db.adminPool.query(`DROP ROLE ${probe}`); }
    });
    it("holds exactly the manifest's table and view privileges, and no others", async () => {
      for (const [table, privs] of Object.entries(manifest.tables)) {
        for (const priv of TABLE_PRIVILEGES) {
          const has = (await rt.query<{ h: boolean }>("SELECT has_table_privilege(current_user, $1, $2) AS h", [`public.${table}`, priv])).rows[0]!.h;
          expect(has, `${table} ${priv}`).toBe(privs.includes(priv));
        }
      }
    });
    it("may execute exactly the manifest's functions (not the blob-eviction function)", async () => {
      const fns = (await rt.query<{ sig: string; name: string }>(
        "SELECT p.proname AS name, p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prorettype <> 'trigger'::regtype AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')")).rows; // extension (pgcrypto) functions are pure, superuser-owned and PUBLIC-executable by design
      expect(fns.length).toBeGreaterThan(0);
      for (const f of fns) {
        const has = (await rt.query<{ h: boolean }>("SELECT has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') AS h", [f.sig])).rows[0]!.h;
        expect(has, f.sig).toBe(manifest.functions_executable.includes(f.name));
      }
    });
    it("can use sequences but not set them", async () => {
      const seqs = (await rt.query<{ s: string }>("SELECT c.relname AS s FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'")).rows;
      expect(seqs.length).toBeGreaterThan(0);
      for (const { s } of seqs) {
        expect((await rt.query<{ h: boolean }>("SELECT has_sequence_privilege(current_user, $1, 'UPDATE') AS h", [`public.${s}`])).rows[0]!.h, s).toBe(false);
      }
    });
    it("cannot create in the database", async () => {
      expect((await rt.query<{ h: boolean }>("SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS h")).rows[0]!.h).toBe(false);
    });
  });

  describe("everything that could weaken the append-only protections is refused", () => {
    let before: { triggers: string; functions: string };
    const snapshot = async () => ({
      triggers: JSON.stringify((await db.pool.query("SELECT c.relname, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal ORDER BY 1,2")).rows),
      functions: JSON.stringify((await db.pool.query("SELECT p.proname, md5(pg_get_functiondef(p.oid)) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1")).rows),
    });
    beforeAll(async () => { before = await snapshot(); });

    const tablesWithTriggers = async () => (await db.pool.query<{ t: string }>("SELECT DISTINCT c.relname AS t FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid WHERE NOT tg.tgisinternal")).rows.map((r) => r.t);

    it("disabling triggers, on every table that has one", async () => {
      const tables = await tablesWithTriggers();
      expect(tables.length).toBeGreaterThan(10);
      for (const t of tables) { await denied(`ALTER TABLE ${t} DISABLE TRIGGER ALL`); await denied(`ALTER TABLE ${t} DISABLE TRIGGER USER`); }
    });
    it("bypassing triggers by session setting", async () => { await denied("SET session_replication_role = replica"); });
    it("dropping or replacing triggers and their functions", async () => {
      await denied("DROP TRIGGER research_blobs_immutable ON research_blobs");
      await denied("CREATE OR REPLACE FUNCTION research_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
      await denied("DROP FUNCTION research_reject_mutation() CASCADE");
    });
    it("changing structure: ALTER, DROP, CREATE, TRUNCATE", async () => {
      await denied("ALTER TABLE audit_events ADD COLUMN x int");
      await denied("DROP TABLE audit_events");
      await denied("CREATE TABLE evil (id int)");
      await denied("CREATE FUNCTION evil() RETURNS int LANGUAGE sql AS 'select 1'");
      await denied("CREATE SCHEMA evil");
      await denied("DROP SCHEMA public CASCADE");
      const baseTables = (await db.pool.query<{ t: string }>("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")).rows.map((r) => r.t);
      expect(baseTables.length).toBeGreaterThan(25);
      for (const t of baseTables) await denied(`TRUNCATE ${t}`);
    });
    it("deleting or rewriting append-only data, with and without the eviction setting", async () => {
      for (const t of ["audit_events", "model_usage_events", "hypotheses", "hypothesis_events", "evidence_spans", "repo_snapshots", "source_snapshots", "research_blob_evictions", "schema_migrations"]) {
        await denied(`DELETE FROM ${t}`);
      }
      await denied("UPDATE audit_events SET action = 'x'");
      await denied("UPDATE schema_migrations SET checksum = 'x'");
      await rt.query("SELECT set_config('agentsmith.blob_eviction', 'on', false)");
      await denied("DELETE FROM research_blobs");
      await denied("UPDATE research_blobs SET size_bytes = 1");
      await rt.query("RESET agentsmith.blob_eviction");
    });
    it("the blob-eviction function and role switching", async () => {
      await denied("SELECT evict_research_blob('0000000000000000000000000000000000000000000000000000000000000000', 'x', 'x')");
      await denied(`SET ROLE ${ownerName}`);
      await denied("CREATE ROLE evil LOGIN");
      await denied("CREATE EXTENSION IF NOT EXISTS hstore");
      await denied("COPY audit_events TO PROGRAM 'true'");
    });
    it("leaves every trigger enabled and every function definition byte-identical", async () => {
      const after = await snapshot();
      expect(after.triggers).toBe(before.triggers);
      expect(after.functions).toBe(before.functions);
      expect(JSON.parse(after.triggers).every((t: { tgenabled: string }) => t.tgenabled === "O")).toBe(true);
    });
  });

  describe("legitimate operations still work as the runtime role", () => {
    it("inserts audit events, reads them back, and uses the verification functions", async () => {
      const run = await rt.query<{ id: string }>("INSERT INTO workflow_runs (workflow_type, status, input) VALUES ('link_or_idea_intake','queued','{}'::jsonb) RETURNING id");
      expect(run.rows[0]!.id).toBeTruthy();
      await rt.query("UPDATE workflow_runs SET status = 'running' WHERE id = $1", [run.rows[0]!.id]);
      expect((await rt.query("SELECT count(*)::int AS n FROM workflow_runs")).rows[0]!.n).toBeGreaterThan(0);
      expect((await rt.query("SELECT research_split_lines('a\nb') AS l")).rows[0]!.l).toEqual(["a", "b"]);
      expect((await rt.query("SELECT count(*)::int AS n FROM research_storage_stats")).rows[0]!.n).toBe(1);
    });
  });

  describe("startup guard", () => {
    it("accepts the runtime role", async () => {
      const warnings: string[] = [];
      const r = await enforceRuntimeRole(rt, { require: true, warn: (m) => warnings.push(m) });
      expect(r.ok).toBe(true);
      expect(warnings).toEqual([]);
    });
    it("refuses the owner role when required, and warns (naming the problem) when not", async () => {
      await expect(enforceRuntimeRole(db.ownerPool, { require: true, warn: () => undefined })).rejects.toThrow(/not least-privilege/);
      const warnings: string[] = [];
      await enforceRuntimeRole(db.ownerPool, { require: false, warn: (m) => warnings.push(m) });
      expect(warnings.join(" ")).toMatch(/owns \d+ relation/);
    });
  });
});
