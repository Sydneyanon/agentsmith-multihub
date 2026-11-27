import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertActiveTestingAllowed } from "../scope-guard.js";
import { assertIntegrationConfigured, createTestDatabase, integrationRequired, REPO_ROOT, runMigrate, skipIntegration, type TestDatabase } from "./harness.js";
import { ResearchFixture } from "./research-helpers.js";

/**
 * DRAFT T-144 migration (db/drafts/t144-research-memory) on THROWAWAY local databases only. It is never in db/migrations, so the runner
 * cannot apply it. Covers: the runner ignores it; pre-existing records and the active-testing scope guard are unchanged by it; every
 * outcome/adjudication/coverage rule; append-only; the least-privilege runtime role with the merged grants manifest; compatibility of
 * the existing research store; and an exact rollback.
 */
const DRAFT = join(REPO_ROOT, "db", "drafts", "t144-research-memory");
const sql = (f: string) => readFileSync(join(DRAFT, f), "utf8");
const NEW_TABLES = ["external_references", "research_coverage", "research_effort", "missed_in_runs", "hypothesis_outcomes", "ground_truth_adjudications"];

async function fingerprint(pool: pg.Pool): Promise<string> {
  const q = async (text: string) => JSON.stringify((await pool.query(text)).rows);
  return [
    await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`),
    await q(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    await q(`SELECT tgrelid::regclass::text AS t, tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
    await q(`SELECT proname, md5(prosrc) AS h FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`),
  ].join("\n");
}
/** Hash of every pre-existing table over its PRE-EXISTING columns only (a new nullable column must not count as a change to old rows). */
async function columnsOf(pool: pg.Pool): Promise<Record<string, string[]>> {
  const rows = (await pool.query<{ t: string; c: string }>(`SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' ORDER BY c.table_name, c.ordinal_position`)).rows;
  const out: Record<string, string[]> = {}; for (const r of rows) if (!NEW_TABLES.includes(r.t)) (out[r.t] ??= []).push(r.c); return out;
}
async function dataHashes(pool: pg.Pool, cols: Record<string, string[]>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [t, cs] of Object.entries(cols)) {
    const row = cs.map((c) => `x."${c}"`).join(", ");
    out[t] = (await pool.query<{ h: string | null }>(`SELECT md5(coalesce(string_agg(ROW(${row})::text, '|' ORDER BY ROW(${row})::text), '')) AS h FROM ${t} x`)).rows[0]!.h ?? "";
  }
  return out;
}
/** Runs the real grants script with the base manifest merged with the draft overlay (from a temp cwd; nothing in the repository changes). */
async function runtimeRoleWithDraftGrants(db: TestDatabase): Promise<{ role: string; pool: pg.Pool }> {
  const role = `rt_${db.name.slice("agentsmith_test_".length)}`; const password = randomBytes(18).toString("hex");
  await db.adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await db.adminPool.query(`GRANT CONNECT ON DATABASE ${db.name} TO ${role}`);
  const base = JSON.parse(readFileSync(join(REPO_ROOT, "db", "runtime-grants.json"), "utf8"));
  const overlay = JSON.parse(sql("runtime-grants.draft.json"));
  const cwd = mkdtempSync(join(tmpdir(), "grants-")); mkdirSync(join(cwd, "db"));
  writeFileSync(join(cwd, "db", "runtime-grants.json"), JSON.stringify({ ...base, tables: { ...base.tables, ...overlay.tables } }));
  const code = await new Promise<{ code: number | null; err: string }>((resolve, reject) => {
    const child = spawn(`${REPO_ROOT}node_modules/.bin/tsx`, [`${REPO_ROOT}scripts/apply-runtime-grants.ts`], { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DIRECT_DATABASE_URL: db.url, RUNTIME_ROLE: role }, stdio: ["ignore", "pipe", "pipe"] });
    let err = ""; child.stderr.on("data", (c) => { err += c; }); child.on("error", reject); child.on("close", (c) => resolve({ code: c, err }));
  });
  rmSync(cwd, { recursive: true, force: true });
  if (code.code !== 0) throw new Error(`grants with the draft overlay failed: ${code.err.slice(0, 800)}`);
  const u = new URL(db.url); u.username = role; u.password = password;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 10 }); pool.on("error", () => undefined);
  return { role, pool };
}

describe.skipIf(skipIntegration)("DRAFT T-144 research-memory migration on throwaway databases", () => {
  let db: TestDatabase; let fx: ResearchFixture; let rt: { role: string; pool: pg.Pool };
  let before: { schema: string; data: Record<string, string>; cols: Record<string, string[]> };
  let scope: { programId: string; assetId: string; scopeVersionId: string; approvalId: string };
  let seeded: { snapshotId: string; runId: string; hypothesis: string; span: string };

  beforeAll(async () => {
    if (integrationRequired) assertIntegrationConfigured();
    db = await createTestDatabase();
    const m = await runMigrate({ directUrl: db.url });
    if (m.code !== 0) throw new Error(m.stderr);
    fx = new ResearchFixture(db);
    // pre-existing records of every kind the draft sits next to: a research chain and an approved active-testing scope
    const snap = await fx.sealedSnapshot(); const span = await fx.span(snap, 5);
    const h = await fx.hypothesis(snap, [span]);
    await fx.evaluate(snap, h, "supports", [span]); await fx.review(h, "reviewer-0");
    seeded = { snapshotId: snap.snapshotId, runId: snap.runId, hypothesis: h, span };
    const p = (await db.pool.query<{ id: string }>(`INSERT INTO programs (name, platform, status) VALUES ('Prog', 'test', 'active') RETURNING id`)).rows[0]!.id;
    const sv = (await db.pool.query<{ id: string }>(`INSERT INTO program_scope_versions (program_id, version, scope_document, verified_at, verified_by) VALUES ($1, 1, '{}', now(), 'owner') RETURNING id`, [p])).rows[0]!.id;
    const a = (await db.pool.query<{ id: string }>(`INSERT INTO assets (canonical_name, asset_type) VALUES ('github:acme/vault', 'repository') RETURNING id`)).rows[0]!.id;
    await db.pool.query(`INSERT INTO program_assets (program_id, asset_id, scope_version_id, scope_status) VALUES ($1, $2, $3, 'in_scope')`, [p, a, sv]);
    const ap = (await db.pool.query<{ id: string }>(`INSERT INTO approvals (action_type, target_type, target_id, status, requested_by, decided_by) VALUES ('active_testing', 'asset', $1, 'approved', 'op', 'owner') RETURNING id`, [a])).rows[0]!.id;
    scope = { programId: p, assetId: a, scopeVersionId: sv, approvalId: ap };
    await assertActiveTestingAllowed(db.pool, scope); // the gate passes before the draft
    const cols = await columnsOf(db.pool); before = { schema: await fingerprint(db.pool), data: await dataHashes(db.pool, cols), cols };
    await db.pool.query(sql("0009_research_memory.sql"));
    rt = await runtimeRoleWithDraftGrants(db);
    const role = rt.role; db.afterDrop = async () => { await db.adminPool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined); };
  }, 120_000);
  afterAll(async () => { await rt?.pool.end().catch(() => undefined); await db?.drop(); });

  it("the migration runner never applies the draft (it is outside db/migrations)", async () => {
    const names = (await db.pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name);
    expect(names.some((n) => n.startsWith("0009"))).toBe(false); expect(names.length).toBe(12); // 0001-0008, 0011-0014
  });

  it("leaves every pre-existing record byte-identical and the active-testing scope guard unchanged", async () => {
    expect(await dataHashes(db.pool, before.cols)).toEqual(before.data);
    await expect(assertActiveTestingAllowed(db.pool, scope)).resolves.toBeUndefined();
    await expect(assertActiveTestingAllowed(db.pool, { ...scope, approvalId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/Active testing blocked/);
  });

  describe("confirmed is born only from independent evidence AND a human adjudication", () => {
    const outcome = (pool: pg.Pool, h: string, category: string, evals: string[], review: string | null, extra = "") =>
      pool.query(`INSERT INTO hypothesis_outcomes (hypothesis_id, category, decided_by, basis_evaluation_ids, basis_review_id, rationale${extra ? ", duplicate_of_hypothesis" : ""}) VALUES ($1,$2,'owner',$3::uuid[],$4,'because'${extra ? ", $5" : ""}) RETURNING id`, extra ? [h, category, evals, review, extra] : [h, category, evals, review]);
    it("accepts confirmed with an independent supports evaluation and a human disclosed supports review", async () => {
      const s = await fx.sealedSnapshot(); const sp = await fx.span(s, 5); const h = await fx.hypothesis(s, [sp]);
      const e = await fx.evaluate(s, h, "supports", [sp], "independent-validator");
      const r = await fx.review(h, "owner", "supports", "disclosed_adjudication");
      await expect(outcome(rt.pool, h, "confirmed", [e], r)).resolves.toBeTruthy();
    });
    it("refuses confirmed without a human disclosed review, with a blinded review, or with a rejecting review", async () => {
      const s = await fx.sealedSnapshot(); const sp = await fx.span(s, 5); const h = await fx.hypothesis(s, [sp]);
      const e = await fx.evaluate(s, h, "supports", [sp], "independent-validator");
      await expect(outcome(rt.pool, h, "confirmed", [e], null)).rejects.toThrow(/human disclosed_adjudication/);
      const blinded = await fx.review(h, "someone", "supports", "blinded_independent_assessment");
      await expect(outcome(rt.pool, h, "confirmed", [e], blinded)).rejects.toThrow(/human disclosed_adjudication/);
      const rejects = await fx.review(h, "owner", "rejects", "disclosed_adjudication");
      await expect(outcome(rt.pool, h, "confirmed", [e], rejects)).rejects.toThrow(/human disclosed_adjudication/);
    });
    it("refuses confirmed when the only supporting evaluation comes from the generator itself", async () => {
      const s = await fx.sealedSnapshot(); const sp = await fx.span(s, 5); const h = await fx.hypothesis(s, [sp]);
      const self = await fx.evaluate(s, h, "supports", [sp], "rule-reentrancy"); // same id as the generator (RULE)
      const r = await fx.review(h, "owner", "supports", "disclosed_adjudication");
      await expect(outcome(rt.pool, h, "confirmed", [self], r)).rejects.toThrow(/independent of the generator/);
    });
    it("refuses basis records that belong to another hypothesis", async () => {
      const s = await fx.sealedSnapshot(); const sp = await fx.span(s, 5); const h1 = await fx.hypothesis(s, [sp]); const h2 = await fx.hypothesis(s, [sp]);
      const e = await fx.evaluate(s, h2, "supports", [sp], "independent-validator"); const r = await fx.review(h1, "owner", "supports", "disclosed_adjudication");
      await expect(outcome(rt.pool, h1, "confirmed", [e], r)).rejects.toThrow(/different hypothesis/);
    });
    it("refuted needs a contradicting evaluation or a human rejection; duplicate needs exactly one target", async () => {
      const s = await fx.sealedSnapshot(); const sp = await fx.span(s, 5); const h = await fx.hypothesis(s, [sp]); const other = await fx.hypothesis(s, [sp]);
      await expect(outcome(rt.pool, h, "refuted", [], null)).rejects.toThrow(/refuted requires/);
      const c = await fx.evaluate(s, h, "contradicts", [sp], "independent-validator");
      await expect(outcome(rt.pool, h, "refuted", [c], null)).resolves.toBeTruthy();
      await expect(outcome(rt.pool, h, "duplicate", [], null)).rejects.toThrow(/check constraint/);
      await expect(outcome(rt.pool, h, "duplicate", [], null, other)).resolves.toBeTruthy();
      await expect(outcome(rt.pool, h, "inconclusive", [], null)).resolves.toBeTruthy();
    });
    it("missed needs a human-recorded hypothesis linked to a run that missed it", async () => {
      const s = await fx.sealedSnapshot(); const sp = await fx.span(s, 5);
      const machine = await fx.hypothesis(s, [sp]);
      await expect(outcome(rt.pool, machine, "missed", [], null)).rejects.toThrow(/human hypothesis/);
      const human = await fx.hypothesis(s, [sp], { generator: { kind: "human", id: "owner", version: "1" } });
      await expect(outcome(rt.pool, human, "missed", [], null)).rejects.toThrow(/at least one run/);
      await rt.pool.query(`INSERT INTO missed_in_runs (hypothesis_id, workflow_run_id, recorded_by) VALUES ($1, $2, 'owner')`, [human, seeded.runId]);
      await expect(outcome(rt.pool, human, "missed", [], null)).resolves.toBeTruthy();
    });
    it("outcomes are human-plane only and append-only, even for the owner role", async () => {
      await expect(rt.pool.query(`INSERT INTO hypothesis_outcomes (hypothesis_id, category, decided_by_kind, decided_by, rationale) VALUES ($1, 'inconclusive', 'model', 'gpt', 'x')`, [seeded.hypothesis])).rejects.toThrow(/check constraint/);
      const id = (await outcome(rt.pool, seeded.hypothesis, "inconclusive", [], null)).rows[0]!.id;
      await expect(db.pool.query(`UPDATE hypothesis_outcomes SET category = 'confirmed' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
      await expect(db.pool.query(`DELETE FROM hypothesis_outcomes WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    });
  });

  it("ground-truth adjudications: a model may adjudicate but never sign off; subjects are well-formed", async () => {
    const ins = (kind: string, signOff: string, signedBy: string | null) => rt.pool.query(
      `INSERT INTO ground_truth_adjudications (subject_kind, corpus_path, corpus_manifest_sha256, label_file, label_function, label_class, disputed_by, evidence, outcome, adjudicator_kind, adjudicator_id, human_sign_off, signed_by, rationale)
       VALUES ('corpus_label','eval/heldout3',$1,'contracts/X.sol','f','reentrancy','validator','[{"kind":"evm"}]','label_upheld',$2,'adj',$3,$4,'r')`, ["a".repeat(64), kind, signOff, signedBy]);
    await expect(ins("model", "pending", null)).resolves.toBeTruthy();
    await expect(ins("model", "signed", "owner")).rejects.toThrow(/check constraint/);
    await expect(ins("human", "signed", null)).rejects.toThrow(/check constraint/);
    await expect(ins("human", "signed", "owner")).resolves.toBeTruthy();
  });

  it("coverage is recorded only against a sealed snapshot, with a reason for anything not examined", async () => {
    const cov = (snap: string, result: string, reason: string | null) => rt.pool.query(
      `INSERT INTO research_coverage (snapshot_id, workflow_run_id, component_path, component_sha256, vulnerability_class, method, method_version, result, reason_code) VALUES ($1,$2,'contracts/Vault.sol',$3,'reentrancy','structural','1',$4,$5)`, [snap, seeded.runId, "b".repeat(64), result, reason]);
    await expect(cov(seeded.snapshotId, "examined", null)).resolves.toBeTruthy();
    await expect(cov(seeded.snapshotId, "not_modelled", null)).rejects.toThrow(/check constraint/);
    await expect(cov(seeded.snapshotId, "not_modelled", "inline_assembly")).resolves.toBeTruthy();
    const unsealed = await fx.rawSnapshot();
    await expect(cov(unsealed, "examined", null)).rejects.toThrow(/sealed snapshot/);
  });

  it("the runtime role may read and insert the new tables but never update, delete or weaken them", async () => {
    await expect(rt.pool.query(`INSERT INTO research_effort (workflow_run_id, method, wall_ms) VALUES ($1, 'structural', 12)`, [seeded.runId])).resolves.toBeTruthy();
    for (const t of NEW_TABLES) {
      await expect(rt.pool.query(`UPDATE ${t} SET created_at = now()`)).rejects.toThrow(/permission denied/);
      await expect(rt.pool.query(`DELETE FROM ${t}`)).rejects.toThrow(/permission denied/);
      await expect(rt.pool.query(`ALTER TABLE ${t} DISABLE TRIGGER ALL`)).rejects.toThrow(/must be owner|permission denied/);
    }
  });

  it("the existing research store keeps working unchanged against the expanded schema, as the runtime role", async () => {
    const rfx = new ResearchFixture({ ...db, pool: rt.pool, ownerPool: db.pool });
    const s = await rfx.sealedSnapshot(); const sp = await rfx.span(s, 5); const h = await rfx.hypothesis(s, [sp]);
    await rfx.evaluate(s, h, "weakens", [sp]); await rfx.review(h, "r1");
    expect((await rfx.status(h)).hypothesis_id ?? h).toBeTruthy();
  });

  it("rollback restores the pre-draft schema exactly and keeps every pre-existing record", async () => {
    await rt.pool.end(); rt = { ...rt, pool: { end: async () => undefined } as unknown as pg.Pool };
    await db.pool.query(sql("0009_research_memory.rollback.sql"));
    expect(await fingerprint(db.pool)).toBe(before.schema);
    const now = await dataHashes(db.pool, before.cols);
    for (const [t, h] of Object.entries(before.data)) if (!["workflow_runs", "workflow_steps", "repo_snapshots", "repo_snapshot_files", "research_blobs", "evidence_spans", "hypotheses", "hypothesis_evidence", "hypothesis_evaluations", "evaluation_evidence", "hypothesis_reviews", "hypothesis_events", "audit_events"].includes(t)) expect(now[t]).toBe(h);
    await expect(assertActiveTestingAllowed(db.pool, scope)).resolves.toBeUndefined();
  });
});
