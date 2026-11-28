import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRepositoryResearchRun, processAcquireRepositoryStep, ACQUIRE_STEP_KEY } from "../acquisition/step.js";
import { inputSha256 } from "../acquisition/create-run-main.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { ANALYSIS_STEP_KEYS } from "../analysis/solidity/keys.js";
import { dispatchAnalysisStep } from "../analysis/solidity/step.js";
import { assessConnectedRole } from "../db-roles.js";
import { WorkflowWorker } from "../worker.js";
import { workerSettings } from "../worker-settings.js";
import { assertIntegrationConfigured, createTestDatabase, REPO_ROOT, runMigrate, runScript, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * R1 in the production profile, on a disposable database:
 * - exactly migrations 0001-0007 (what production has; 0008 is not applied);
 * - roles shaped like Fly Managed Postgres: a provider `reader` role (pg_read_all_data) and `writer` role (pg_write_all_data), and the
 *   worker's login user created as a member of `reader`, as `fly mpg users create --role reader` does;
 * - the real grants script, the real research pipeline (acquisition, sealing, structural analysis, hypotheses, evaluations, dossier)
 *   executed AS the worker role, and the evidence-bypass attempts executed AS the worker role.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
const corpus = join(REPO_ROOT, "eval", "dev", "contracts");
const APPROVED_INPUT = { repository: "OpenZeppelin/ethernaut", ref: "d05643a40aa98c45d66247c69ffceab8f44dd8cb", excludePathPrefixes: ["client", "contracts/out", "contracts/test", "contracts/src/attacks"] };

describe.skipIf(skipIntegration)("R1: restricted worker role in the production profile (real Postgres)", () => {
  let db: TestDatabase; let fx: GitFixture; let migDir: string;
  const hex = randomBytes(4).toString("hex");
  const reader = `fly_reader_${hex}`; const writer = `fly_writer_${hex}`; const workerRole = `agentsmith_worker_${hex}`; const writerUser = `writer_user_${hex}`;
  const password = randomBytes(18).toString("hex");
  let workerPool: pg.Pool; let workerUrl: string;
  const roleUrl = (role: string) => { const u = new URL(db.url); u.username = role; u.password = password; return u.toString(); };
  const grants = (env: Record<string, string>) => runScript("scripts/apply-runtime-grants.ts", { DIRECT_DATABASE_URL: db.url, ...env });

  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await createTestDatabase();
    migDir = mkdtempSync(join(tmpdir(), "r1-migrations-")); mkdirSync(join(migDir, "db", "migrations"), { recursive: true });
    for (const f of readdirSync(join(REPO_ROOT, "db", "migrations")).filter((n) => /^000[1-7]_/.test(n))) copyFileSync(join(REPO_ROOT, "db", "migrations", f), join(migDir, "db", "migrations", f));
    const m = await runMigrate({ directUrl: db.url, cwd: migDir });
    if (m.code !== 0) throw new Error(m.stderr);
    // Production has an extension-owned monitoring view in public that PUBLIC can read (pg_stat_monitor on Fly Managed Postgres,
    // found by the read-only production check). Reproduce it: a view that belongs to an extension, with SELECT granted to PUBLIC.
    await db.pool.query("CREATE VIEW pg_stat_monitor AS SELECT 1 AS probe");
    await db.pool.query("GRANT SELECT ON pg_stat_monitor TO PUBLIC");
    await db.pool.query("ALTER EXTENSION pgcrypto ADD VIEW pg_stat_monitor");
    for (const sql of [
      `CREATE ROLE ${reader} NOLOGIN`, `GRANT pg_read_all_data TO ${reader}`,
      `CREATE ROLE ${writer} NOLOGIN`, `GRANT pg_read_all_data TO ${writer}`, `GRANT pg_write_all_data TO ${writer}`,
      `CREATE ROLE ${workerRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${reader}`,
      `CREATE ROLE ${writerUser} LOGIN PASSWORD '${password}' IN ROLE ${writer}`,
      `GRANT CONNECT ON DATABASE ${db.name} TO ${workerRole}, ${writerUser}`,
    ]) await db.adminPool.query(sql);
    workerUrl = roleUrl(workerRole);
    workerPool = new pg.Pool({ connectionString: workerUrl, max: 10 }); workerPool.on("error", () => undefined);
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "OpenZeppelin", repo: "ethernaut" });
  });
  afterAll(async () => {
    fx?.cleanup(); await workerPool?.end().catch(() => undefined);
    if (db) { await db.drop(); }
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    for (const r of [workerRole, writerUser, reader, writer]) await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
    await admin.end(); rmSync(migDir, { recursive: true, force: true });
  });

  describe("the grants script refuses anything unsafe or unexpected", () => {
    it("without RUNTIME_GRANTS_ALLOW_ABSENT, the missing 0008 tables are reported and nothing is applied", async () => {
      const r = await grants({ RUNTIME_ROLE: workerRole, RUNTIME_ROLE_READONLY_MEMBERSHIPS: reader });
      expect(r.code).toBe(1); expect(r.stderr).toMatch(/manifest names table discovery_sources which does not exist/);
    });
    it("the provider membership is refused unless named, and a writer membership is refused even when named", async () => {
      const r1 = await grants({ RUNTIME_ROLE: workerRole, RUNTIME_GRANTS_ALLOW_ABSENT: "true" });
      expect(r1.code).toBe(1); expect(r1.stderr).toMatch(new RegExp(`is a member of ${reader}`));
      const r2 = await grants({ RUNTIME_ROLE: writerUser, RUNTIME_ROLE_READONLY_MEMBERSHIPS: writer, RUNTIME_GRANTS_ALLOW_ABSENT: "true" });
      expect(r2.code).toBe(1); expect(r2.stderr).toMatch(/not read-only: .*inherits pg_write_all_data.*can INSERT\/UPDATE\/DELETE/);
    });
    it("a dry run reports the change and leaves every privilege as it was", async () => {
      const r = await grants({ RUNTIME_ROLE: workerRole, RUNTIME_ROLE_READONLY_MEMBERSHIPS: reader, RUNTIME_GRANTS_ALLOW_ABSENT: "true", RUNTIME_GRANTS_DRY_RUN: "true" });
      expect(r.code).toBe(0); expect(r.stdout).toMatch(/DRY RUN: rolled back; nothing was changed/); expect(r.stdout).toMatch(/\+ workflow_steps:UPDATE/);
      expect((await db.pool.query("SELECT has_table_privilege($1, 'workflow_steps', 'UPDATE') AS u", [workerRole])).rows[0].u).toBe(false);
    });
  });

  describe("applied", () => {
    let ownerBefore: string[];
    const ownerPrivileges = async () => (await db.adminPool.query<{ x: string }>(
      `SELECT c.relname || ':' || p AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) p
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND has_table_privilege(current_user, c.oid, p) ORDER BY 1`)).rows.map((r) => r.x);
    beforeAll(async () => {
      ownerBefore = await ownerPrivileges();
      const r = await grants({ RUNTIME_ROLE: workerRole, RUNTIME_ROLE_READONLY_MEMBERSHIPS: reader, RUNTIME_GRANTS_ALLOW_ABSENT: "true" });
      if (r.code !== 0) throw new Error(r.stderr);
      expect(r.stdout).toMatch(new RegExp(`membership ${reader} tolerated: verified read-only`));
      expect(r.stdout).toMatch(/skipped \(not present in this database/);
    });

    it("the owner (the API's role) keeps exactly the privileges it had, and the extension's monitoring view is left as it was", async () => {
      expect(await ownerPrivileges()).toEqual(ownerBefore);
      expect((await db.pool.query("SELECT has_table_privilege('public', 'pg_stat_monitor', 'SELECT') AS s")).rows[0].s).toBe(true);
    });

    it("the startup check passes for the worker role only with the named read-only membership, and fails for the owner", async () => {
      expect(await assessConnectedRole(workerPool, "public", [reader])).toEqual({ ok: true, problems: [] });
      expect((await assessConnectedRole(workerPool)).problems).toEqual([`role is a member of: ${reader}`]);
      // Negative control: a user created with Fly's `writer` role fails the check even if its membership is named...
      const writerPool = new pg.Pool({ connectionString: roleUrl(writerUser), max: 1 });
      try {
        const w = await assessConnectedRole(writerPool, "public", [writer]);
        expect(w.ok).toBe(false); expect(w.problems.join(" ")).toMatch(/inherits pg_write_all_data/); expect(w.problems.join(" ")).toMatch(/role holds DELETE on \d+ relation/);
        // ...and really could destroy what the worker role cannot touch (deleting the audit trail, which is append-only by privilege only).
        await db.pool.query("INSERT INTO audit_events (actor, action, entity_type, entity_id, reason) VALUES ('r1-test', 'probe', 'probe', 'probe', 'negative control')");
        expect((await writerPool.query("DELETE FROM audit_events WHERE actor = 'r1-test'")).rowCount).toBe(1);
      } finally { await writerPool.end(); }
      const owner = await assessConnectedRole(db.pool);
      expect(owner.ok).toBe(false); expect(owner.problems.join(" ")).toMatch(/owns \d+ relation/);
    });

    it("the worker role runs the whole approved chain: create the run, acquire, seal, analyse, hypothesise, evaluate, build the dossier", async () => {
      expect(inputSha256(APPROVED_INPUT)).toBe("ec58efb2ff321ca0ba8a7043484b2d1f22631199e360461b5c9c8f73cfdc22a4");
      const other = await createRepositoryResearchRun(db.pool, { repository: "someone/else", ref: "main" }); // must never be touched
      // Same shape as the approved input; the commit is the local fixture's (no network in tests).
      const { runId } = await createRepositoryResearchRun(workerPool, { ...APPROVED_INPUT, ref: fx.commitSha }, "operator", { structuralAnalysis: true });
      const worker = new WorkflowWorker(workerPool, "r1-worker", 120, 3);
      const acq = (await worker.claimNext([ACQUIRE_STEP_KEY], runId))!;
      expect(acq.workflow_run_id).toBe(runId);
      await processAcquireRepositoryStep({ pool: workerPool, worker, workerId: "r1-worker", source: new FakeSource(fx) }, acq);
      for (const key of ANALYSIS_STEP_KEYS) {
        const s = (await worker.claimNext([key], runId))!; expect(s.step_key).toBe(key);
        expect(await dispatchAnalysisStep({ pool: workerPool, worker, workerId: "r1-worker", heartbeatMs: 40 }, s)).toBe(true);
      }
      expect(await worker.claimNext([ACQUIRE_STEP_KEY], runId)).toBeNull();
      const run = (await workerPool.query("SELECT status FROM workflow_runs WHERE id = $1", [runId])).rows[0];
      expect(run.status).toBe("succeeded");
      const n = async (sql: string) => Number((await workerPool.query(sql)).rows[0].n);
      expect(await n("SELECT count(*) n FROM repo_snapshots WHERE sealed_at IS NOT NULL")).toBe(1);
      expect(await n("SELECT count(*) n FROM hypotheses")).toBeGreaterThan(5);
      expect(await n("SELECT count(*) n FROM hypothesis_evaluations")).toBeGreaterThan(5);
      expect((await db.pool.query("SELECT status FROM workflow_steps WHERE workflow_run_id = $1", [other.runId])).rows[0].status).toBe("queued");
    });

    it("as the worker role, every way to modify or bypass protected evidence is refused, and the evidence is unchanged afterwards", async () => {
      const fingerprint = async () => (await db.pool.query<{ h: string }>(
        `SELECT md5(string_agg(t, '|' ORDER BY t)) AS h FROM (
           SELECT 'snap:' || row_to_json(s)::text AS t FROM repo_snapshots s UNION ALL SELECT 'file:' || row_to_json(f)::text FROM repo_snapshot_files f
           UNION ALL SELECT 'hyp:' || row_to_json(h)::text FROM hypotheses h UNION ALL SELECT 'eval:' || row_to_json(e)::text FROM hypothesis_evaluations e
           UNION ALL SELECT 'span:' || row_to_json(x)::text FROM evidence_spans x UNION ALL SELECT 'blob:' || content_sha256 FROM research_blobs
           UNION ALL SELECT 'audit:' || row_to_json(a)::text FROM audit_events a UNION ALL SELECT 'mig:' || name || checksum FROM schema_migrations) q`)).rows[0]!.h;
      for (const t of ["repo_snapshots", "repo_snapshot_files", "hypotheses", "hypothesis_evaluations", "evidence_spans", "research_blobs", "audit_events"]) {
        expect(Number((await db.pool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n), `${t} must have rows, or an UPDATE could "succeed" by changing nothing`).toBeGreaterThan(0);
      }
      const before = await fingerprint();
      const owner = (await db.pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
      const attempts: Array<[string, RegExp]> = [
        ["ALTER TABLE repo_snapshots DISABLE TRIGGER ALL", /must be owner/],
        ["ALTER TABLE hypotheses DISABLE TRIGGER USER", /must be owner/],
        ["ALTER TABLE hypothesis_evaluations DISABLE TRIGGER USER", /must be owner/],
        ["SET session_replication_role = replica", /permission denied/],
        ["UPDATE repo_snapshots SET commit_sha = repeat('0', 40)", /./],
        ["UPDATE hypotheses SET claim = 'rewritten'", /./],
        ["UPDATE hypothesis_evaluations SET rationale = 'rewritten'", /permission denied/],
        ["UPDATE evidence_spans SET line_start = line_start", /permission denied/],
        ["DELETE FROM hypotheses", /permission denied/],
        ["DELETE FROM hypothesis_evaluations", /permission denied/],
        ["DELETE FROM repo_snapshot_files", /permission denied/],
        ["DELETE FROM research_blobs", /permission denied/],
        ["DELETE FROM evidence_spans", /permission denied/],
        ["DELETE FROM audit_events", /permission denied/],
        ["TRUNCATE hypotheses", /permission denied/],
        ["TRUNCATE audit_events", /permission denied/],
        ["INSERT INTO schema_migrations (name, checksum) VALUES ('9999_x.sql', 'x')", /permission denied/],
        ["UPDATE schema_migrations SET checksum = 'x'", /permission denied/],
        ["DROP TABLE hypotheses", /must be owner/],
        ["CREATE TABLE r1_probe (x int)", /permission denied/],
        ["CREATE TEMP TABLE research_blobs (content_sha256 text)", /permission denied/],
        ["CREATE OR REPLACE FUNCTION research_split_lines(t text) RETURNS text[] LANGUAGE sql AS 'SELECT ARRAY[]::text[]'", /must be owner|permission denied/],
        ["SELECT evict_research_blob(content_sha256, 'r1 probe', 'worker') FROM research_blobs LIMIT 1", /permission denied/],
        [`SET ROLE ${owner}`, /permission denied/],
        [`ALTER ROLE ${workerRole} CREATEROLE`, /permission denied/],
        ["COPY hypotheses TO PROGRAM 'cat'", /permission denied|must be superuser|pg_execute_server_program/],
      ];
      const outcomes: string[] = [];
      for (const [sql, expected] of attempts) {
        const c = await workerPool.connect();
        try { await c.query(sql); outcomes.push(`ALLOWED: ${sql}`); }
        catch (e) { const msg = (e as Error).message; if (!expected.test(msg)) outcomes.push(`unexpected error for ${sql}: ${msg}`); }
        finally { c.release(); }
      }
      expect(outcomes).toEqual([]);
      // PostgreSQL answers a GRANT by a non-owner with a WARNING ("no privileges were granted"), not an error: check the effect.
      await workerPool.query(`GRANT DELETE, TRUNCATE, TRIGGER ON hypotheses TO ${workerRole}`).catch(() => undefined);
      expect((await db.pool.query("SELECT has_table_privilege($1, 'hypotheses', 'DELETE') OR has_table_privilege($1, 'hypotheses', 'TRUNCATE') OR has_table_privilege($1, 'hypotheses', 'TRIGGER') AS any", [workerRole])).rows[0].any).toBe(false);
      // Membership does not open a back door: switching to the provider read role still cannot write.
      const c = await workerPool.connect();
      try { await c.query(`SET ROLE ${reader}`); await expect(c.query("INSERT INTO audit_events (actor, action, entity_type, entity_id, reason) VALUES ('x','x','x', gen_random_uuid(), 'x')")).rejects.toThrow(/permission denied/); }
      finally { await c.query("RESET ROLE").catch(() => undefined); c.release(); }
      expect(await fingerprint()).toBe(before);
    });

    it("the worker process refuses to start as the owner when the restricted role is required, and claims nothing", async () => {
      const { runId } = await createRepositoryResearchRun(db.pool, { repository: "x/y", ref: "main" });
      const run = (env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(`${REPO_ROOT}node_modules/.bin/tsx`, [`${REPO_ROOT}apps/api/src/worker-main.ts`], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
        let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
        child.on("close", (code) => resolve({ code, out }));
      });
      const refused = await run({ WORKER_DATABASE_URL: db.url, HUB_REQUIRE_RESTRICTED_DB_ROLE: "true", WORKER_ONLY_RUN_ID: runId, WORKER_EXIT_WHEN_RUN_DONE: "true" });
      expect(refused.code).toBe(78); expect(refused.out).toMatch(/worker_role_not_least_privilege/);
      expect((await db.pool.query("SELECT status, attempt FROM workflow_steps WHERE workflow_run_id = $1", [runId])).rows[0]).toEqual({ status: "queued", attempt: 0 });
      // As the restricted role, scoped to a run that is already finished: verified, scoped, exits cleanly without claiming anything.
      await db.pool.query("UPDATE workflow_steps SET status = 'cancelled' WHERE workflow_run_id = $1", [runId]);
      await db.pool.query("UPDATE workflow_runs SET status = 'cancelled' WHERE id = $1", [runId]);
      const ok = await run({ WORKER_DATABASE_URL: workerUrl, HUB_REQUIRE_RESTRICTED_DB_ROLE: "true", RUNTIME_ROLE_READONLY_MEMBERSHIPS: reader, WORKER_ONLY_RUN_ID: runId, WORKER_EXIT_WHEN_RUN_DONE: "true", STRUCTURAL_ANALYSIS_ENABLED: "true" });
      expect(ok.code).toBe(0);
      expect(ok.out).toMatch(/worker_role_verified/); expect(ok.out).toMatch(/worker_scoped_to_run/); expect(ok.out).toMatch(/scoped_run_finished_exiting/);
    });
  });
});

describe("worker settings", () => {
  it("parses R1 settings strictly", () => {
    expect(workerSettings({ DATABASE_URL: "postgres://x" })).toEqual({ urlVariable: "DATABASE_URL", requireRestrictedRole: false, onlyRunId: null, exitWhenRunDone: false });
    expect(workerSettings({ DATABASE_URL: "a", WORKER_DATABASE_URL: "b", HUB_REQUIRE_RESTRICTED_DB_ROLE: "true", WORKER_ONLY_RUN_ID: "11111111-1111-1111-1111-111111111111", WORKER_EXIT_WHEN_RUN_DONE: "true" }))
      .toEqual({ urlVariable: "WORKER_DATABASE_URL", requireRestrictedRole: true, onlyRunId: "11111111-1111-1111-1111-111111111111", exitWhenRunDone: true });
    expect(workerSettings({ DATABASE_URL: "a", HUB_REQUIRE_RESTRICTED_DB_ROLE: "TRUE" }).requireRestrictedRole).toBe(false);
    expect(() => workerSettings({})).toThrow(/is required/);
    expect(() => workerSettings({ DATABASE_URL: "a", WORKER_ONLY_RUN_ID: "nope" })).toThrow(/UUID/);
    expect(() => workerSettings({ DATABASE_URL: "a", WORKER_EXIT_WHEN_RUN_DONE: "true" })).toThrow(/needs WORKER_ONLY_RUN_ID/);
  });
});
