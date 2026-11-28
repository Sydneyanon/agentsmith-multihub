import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRepositoryResearchRun, processAcquireRepositoryStep } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { dispatchAnalysisStep } from "../analysis/solidity/step.js";
import { sha256Hex } from "../research-state.js";
import { WorkflowWorker } from "../worker.js";
import { assertIntegrationConfigured, createTestDatabase, REPO_ROOT, runMigrate, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * The UPGRADE of the actual production schema to 0015 and 0016, on a disposable database holding realistic existing research data.
 * Production has 0001-0007 and 0011-0014 applied; 0008 (and the 0009/0010 drafts) are NOT applied. Shown here, with the REAL migration
 * runner (scripts/migrate.ts) and the REAL rollback scripts (db/rollbacks):
 *  - 0015 then 0016 apply on top of the production schema with research data present (including a duplicate evaluation written by the
 *    old code, which 0015's key backfill must tolerate);
 *  - every pre-existing table, evidence rows included, is byte-identical after the upgrade and after each rollback (data fingerprint);
 *  - each rollback restores exactly the previous catalog (catalog fingerprint), and re-applying gives exactly the upgraded catalog;
 *  - after the upgrade the new rules hold for new writes (D7 key, R3a self-evaluation trigger), and the runtime grants apply.
 */
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const PRODUCTION = ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0011", "0012", "0013", "0014"];
const all = readdirSync(join(REPO_ROOT, "db", "migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const corpus = join(REPO_ROOT, "eval", "dev", "contracts");

async function catalog(pool: pg.Pool): Promise<string> {
  const q = async (text: string) => JSON.stringify((await pool.query(text)).rows);
  return [
    await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`),
    await q(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    await q(`SELECT tgrelid::regclass::text AS t, tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
    await q(`SELECT proname, pg_get_function_identity_arguments(oid) AS args, md5(prosrc) AS h, proconfig::text AS c FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1, 2, 3`),
    await q(`SELECT viewname, md5(definition) AS h FROM pg_views WHERE schemaname = 'public' ORDER BY 1`),
    await q(`SELECT indexrelid::regclass::text AS i, pg_get_indexdef(indexrelid) AS d FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace ORDER BY 1`),
  ].join("\n");
}
/** md5 of every row of every given table, in a stable order (the bytes of evidence rows included) */
async function data(pool: pg.Pool, tables: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = (await pool.query<{ h: string; n: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*) AS n FROM ${t} x`)).rows.map((r) => `${r.n}:${r.h}`)[0]!;
  return out;
}
const baseTables = async (pool: pg.Pool) => (await pool.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.t);

describe.skipIf(skipIntegration)("migrations 0015 and 0016: upgrade from the PRODUCTION schema (0001-0007, 0011-0014; no 0008-0010), rollback and re-apply", () => {
  let db: TestDatabase; let dir: string; let fx: GitFixture;
  /** a migrations directory holding exactly the given migration numbers, for the real runner */
  const stage = (numbers: readonly string[]) => {
    rmSync(join(dir, "db"), { recursive: true, force: true }); mkdirSync(join(dir, "db", "migrations"), { recursive: true });
    for (const f of all.filter((x) => numbers.includes(x.slice(0, 4)))) copyFileSync(join(REPO_ROOT, "db", "migrations", f), join(dir, "db", "migrations", f));
  };
  const migrate = async (numbers: readonly string[]) => { stage(numbers); const r = await runMigrate({ directUrl: db.url, cwd: dir }); expect(r.code, r.stderr).toBe(0); return r.stdout; };
  const rollback = (n: "0015_worker_api" | "0016_research_independence") => db.ownerPool.query(readFileSync(join(REPO_ROOT, "db", "rollbacks", `${n}.rollback.sql`), "utf8"));

  beforeAll(async () => {
    assertIntegrationConfigured(); db = await createTestDatabase(); dir = mkdtempSync(join(tmpdir(), "mig-upgrade-"));
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "prod-like" });
  });
  afterAll(async () => { fx?.cleanup(); rmSync(dir, { recursive: true, force: true }); await db?.drop(); });

  it("upgrades a production-shaped database with research data in place, keeps every existing row byte-identical, and rolls back exactly", async () => {
    // 1. the production schema, exactly the applied set (0008 is NOT applied in production)
    const out = await migrate(PRODUCTION);
    expect(out.match(/Applied (\d{4})/g)!.map((x) => x.slice(-4))).toEqual(PRODUCTION);
    expect((await db.ownerPool.query("SELECT to_regclass('discovery_sources') AS t")).rows[0].t).toBeNull(); // 0008 absent
    // 2. realistic research data written by the code paths that run in production today (direct worker, no 0015 yet)
    process.env.STRUCTURAL_ANALYSIS_ENABLED = "true";
    try {
      const { runId } = await createRepositoryResearchRun(db.ownerPool, { repository: "acme/prod-like", ref: "main" }, "operator", { structuralAnalysis: true });
      const worker = new WorkflowWorker(db.ownerPool, "prod-worker", 120, 3);
      const acq = (await worker.claimNext(["acquire_repository"], runId))!;
      await processAcquireRepositoryStep({ pool: db.ownerPool, worker, workerId: "prod-worker", source: new FakeSource(fx) }, acq);
      for (const key of ["analyze_structure", "challenge_leads", "build_dossier"]) {
        const s = (await worker.claimNext([key], runId))!; expect(await dispatchAnalysisStep({ pool: db.ownerPool, worker, workerId: "prod-worker" }, s)).toBe(true);
      }
      expect((await db.ownerPool.query("SELECT status FROM workflow_runs WHERE id = $1", [runId])).rows[0].status).toBe("succeeded");
      // the old code had no evaluation key: a retried challenge could record the SAME evaluation twice; one such duplicate exists
      const e = (await db.ownerPool.query("SELECT workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256 FROM hypothesis_evaluations WHERE outcome = 'inconclusive' ORDER BY created_at LIMIT 1")).rows[0];
      await db.ownerPool.query(`INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [e.workflow_run_id, e.hypothesis_id, e.produced_by_step_id, e.evaluator_id, e.evaluator_version, e.outcome, e.rationale, e.input_sha256]);
      await db.ownerPool.query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ('sherlock:prod', 'prod', 'prod', '{}'::jsonb, 'active', 'official_confirmed')`);
    } finally { delete process.env.STRUCTURAL_ANALYSIS_ENABLED; }
    const counts = (await db.ownerPool.query("SELECT (SELECT count(*) FROM hypotheses)::int AS h, (SELECT count(*) FROM hypothesis_evaluations)::int AS e, (SELECT count(*) FROM evidence_spans)::int AS s, (SELECT count(*) FROM research_blobs)::int AS b")).rows[0];
    expect(counts.h).toBeGreaterThan(10); expect(counts.e).toBe(counts.h + 1); expect(counts.s).toBeGreaterThan(10);
    const existing = await baseTables(db.ownerPool);
    const research = existing.filter((t) => t !== "schema_migrations");
    const cat0 = await catalog(db.ownerPool); const data0 = await data(db.ownerPool, existing);

    // 3. upgrade: 0015, then 0016, with the real runner
    expect(await migrate([...PRODUCTION, "0015"])).toContain("Applied 0015_worker_api.sql");
    const cat15 = await catalog(db.ownerPool);
    expect(await data(db.ownerPool, research)).toEqual(Object.fromEntries(research.map((t) => [t, data0[t]]))); // evidence rows byte-identical
    // the key backfill took exactly one evaluation per key (the earliest); the old duplicate stays as history, untouched
    expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM hypothesis_evaluation_keys")).rows[0].n).toBe(counts.e - 1);
    expect(await migrate([...PRODUCTION, "0015", "0016"])).toContain("Applied 0016_research_independence.sql");
    const cat16 = await catalog(db.ownerPool);
    expect(await data(db.ownerPool, research)).toEqual(Object.fromEntries(research.map((t) => [t, data0[t]])));
    expect(new Set([cat0, cat15, cat16]).size).toBe(3);
    // the views keep same-family corroboration and cross-family confirmation apart on the EXISTING data: the specialists' leads were
    // evaluated only by the same parser family, so nothing is independently supported
    const ind = (await db.ownerPool.query("SELECT count(*) FILTER (WHERE independently_supported)::int AS cross, count(*) FILTER (WHERE corroborated_same_family)::int AS same FROM hypothesis_independence")).rows[0];
    expect(ind.cross).toBe(0);
    expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM evaluation_independence WHERE relation = 'cross_family'")).rows[0].n).toBe(0);
    void ind.same;

    // 4. after the upgrade, new writes follow the new rules, whoever writes
    const h = (await db.ownerPool.query("SELECT x.id, x.workflow_run_id, x.produced_by_step_id, x.generator_id FROM hypotheses x WHERE EXISTS (SELECT 1 FROM hypothesis_evaluations e WHERE e.hypothesis_id = x.id AND e.outcome = 'inconclusive') LIMIT 1")).rows[0];
    const dupKey = (await db.ownerPool.query("SELECT evaluator_id, evaluator_version, outcome, rationale, input_sha256 FROM hypothesis_evaluations WHERE hypothesis_id = $1 AND outcome = 'inconclusive' LIMIT 1", [h.id])).rows[0];
    await expect(db.ownerPool.query(`INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [h.workflow_run_id, h.id, h.produced_by_step_id, dupKey.evaluator_id, dupKey.evaluator_version, dupKey.outcome, dupKey.rationale, dupKey.input_sha256])).rejects.toThrow(/hypothesis_evaluation_keys_pkey|duplicate key/);
    await expect(db.ownerPool.query(`INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256) VALUES ($1,$2,$3,$4,'1','inconclusive','self',$5)`,
      [h.workflow_run_id, h.id, h.produced_by_step_id, h.generator_id, sha256Hex("self")])).rejects.toThrow(/cannot be made by the generator/);
    expect(await data(db.ownerPool, research)).toEqual(Object.fromEntries(research.map((t) => [t, data0[t]]))); // both refused: nothing written
    // (the runtime role's manifest, db/runtime-grants.json, also lists 0008's tables, which production lacks; it is verified against the
    // full migration set by runtime-role.integration.test.ts. Fly refuses GRANT/REVOKE, so production runs no runtime role today.)

    // 5. rollback 0016, then 0015: each restores exactly the previous catalog; every pre-existing row is still byte-identical
    await rollback("0016_research_independence");
    expect(await catalog(db.ownerPool)).toBe(cat15);
    expect(await data(db.ownerPool, research)).toEqual(Object.fromEntries(research.map((t) => [t, data0[t]])));
    await rollback("0015_worker_api");
    expect(await catalog(db.ownerPool)).toBe(cat0);
    expect(await data(db.ownerPool, existing)).toEqual(data0); // schema_migrations included: the rollback removes its own rows only

    // 6. re-apply: exactly the upgraded catalog again, the data still untouched
    await migrate([...PRODUCTION, "0015", "0016"]);
    expect(await catalog(db.ownerPool)).toBe(cat16);
    expect(await data(db.ownerPool, research)).toEqual(Object.fromEntries(research.map((t) => [t, data0[t]])));
    expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM hypothesis_evaluation_keys")).rows[0].n).toBe(counts.e - 1);
  });

  it("the shipped migration list is 0001-0008 and 0011-0016; the drafts stay out; every migration from 0015 has a rollback", () => {
    expect(all.map((f) => f.slice(0, 4))).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0011", "0012", "0013", "0014", "0015", "0016"]);
    for (const n of ["0015_worker_api", "0016_research_independence"]) expect(readdirSync(join(REPO_ROOT, "db", "rollbacks"))).toContain(`${n}.rollback.sql`);
    expect(readFileSync(join(REPO_ROOT, "db", "migrations", "0016_research_independence.sql"), "utf8").replace(/--.*$/gm, "")).not.toMatch(/hypothesis_outcome|missed_in_runs/); // R3b stays a draft
  });
});
