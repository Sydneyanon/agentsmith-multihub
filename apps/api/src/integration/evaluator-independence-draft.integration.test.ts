import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDrafts, applyR3Draft, DRAFTS, R3_DRAFT } from "./drafts.js";
import { assertIntegrationConfigured, migratedTestDatabase, REPO_ROOT, runMigrate, skipIntegration, type TestDatabase } from "./harness.js";
import { ResearchFixture } from "./research-helpers.js";
import { IndependenceError, type GeneratorIdentity } from "../research-state.js";

/**
 * Foundation B (enforced generator/evaluator independence), on THROWAWAY databases only. Code: ResearchStore.recordEvaluation refuses an
 * evaluation by the claim's own generator. Database (R3 draft): the same rule as a trigger, analysis families, and the T-144 'confirmed'
 * rule tightened from "different evaluator id" to "different analysis family". Runs as the owner and as the restricted runtime role.
 */
const DIR = join(REPO_ROOT, "db", "drafts", R3_DRAFT.dir);
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");
async function catalog(pool: pg.Pool): Promise<string> {
  const q = async (text: string) => JSON.stringify((await pool.query(text)).rows);
  return [
    await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`),
    await q(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    await q(`SELECT tgrelid::regclass::text AS t, tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
    await q(`SELECT proname, pg_get_function_identity_arguments(oid) AS args, md5(prosrc) AS h, proconfig::text AS c FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1, 2, 3`),
    await q(`SELECT viewname, md5(definition) AS h FROM pg_views WHERE schemaname = 'public' ORDER BY 1`),
  ].join("\n");
}
const SPECIALISTS: GeneratorIdentity = { kind: "deterministic_rule", id: "solidity-structural-specialists", version: "1" };
const SLITHER: GeneratorIdentity = { kind: "deterministic_rule", id: "slither", version: "0.11.3" };

describe.skipIf(skipIntegration)("code: an evaluation by the claim's own generator is refused (0007 only, no draft)", () => {
  let db: TestDatabase; let fx: ResearchFixture;
  beforeAll(async () => { assertIntegrationConfigured(); db = await migratedTestDatabase(); fx = new ResearchFixture(db); });
  afterAll(async () => { await db?.drop(); });

  it("recordEvaluation refuses evaluator = generator for every outcome, and records nothing", async () => {
    const s = await fx.sealedSnapshot(); const sp = await fx.span(s, 5);
    const h = await fx.hypothesis(s, [sp], { generator: SPECIALISTS });
    for (const outcome of ["supports", "weakens", "contradicts", "inconclusive"] as const) {
      await expect(fx.evaluate(s, h, outcome, outcome === "inconclusive" ? [] : [sp], SPECIALISTS.id)).rejects.toBeInstanceOf(IndependenceError);
    }
    expect(Number((await db.ownerPool.query("SELECT count(*) n FROM hypothesis_evaluations WHERE hypothesis_id = $1", [h])).rows[0].n)).toBe(0);
    // a different evaluator, and the explicit abstention, are recorded as before
    await fx.evaluate(s, h, "supports", [sp], "execution-challenge-access-control");
    await fx.evaluate(s, h, "inconclusive", [], "no-independent-validator");
    expect(Number((await db.ownerPool.query("SELECT count(*) n FROM hypothesis_evaluations WHERE hypothesis_id = $1", [h])).rows[0].n)).toBe(2);
  });
});

describe.skipIf(skipIntegration)("DRAFT R3 evaluator-independence migration on throwaway databases", () => {
  let db: TestDatabase; let fx: ResearchFixture;
  beforeAll(async () => { assertIntegrationConfigured(); db = await migratedTestDatabase(); await applyDrafts(db); fx = new ResearchFixture(db); });
  afterAll(async () => { await db?.drop(); });

  /** a sealed snapshot, one span, and a hypothesis by `generator`, with a human disclosed adjudication supporting it */
  async function adjudicated(generator: GeneratorIdentity) {
    const s = await fx.sealedSnapshot(); const sp = await fx.span(s, 5);
    const h = await fx.hypothesis(s, [sp], { generator });
    const review = await fx.review(h, "owner-test", "supports", "disclosed_adjudication");
    return { s, sp, h, review };
  }
  const confirm = (h: string, evaluationIds: string[], review: string) => db.pool.query(
    "INSERT INTO hypothesis_outcomes (hypothesis_id, category, decided_by, basis_evaluation_ids, basis_review_id, rationale) VALUES ($1,'confirmed','owner-test',$2::uuid[],$3,'adjudicated')", [h, evaluationIds, review]);

  it("is not applied by the migration runner", async () => {
    const fresh = await migratedTestDatabase();
    try {
      expect((await runMigrate({ directUrl: fresh.url })).code).toBe(0);
      expect((await fresh.ownerPool.query("SELECT to_regclass('analysis_identities') AS t")).rows[0].t).toBeNull();
    } finally { await fresh.drop(); }
  });

  it("BEFORE the draft, a same-family 'supports' satisfies T-144 'confirmed' and the database accepts an evaluation by the generator", async () => {
    const a = await adjudicated(SPECIALISTS);
    const same = await fx.evaluate(a.s, a.h, "supports", [a.sp], "execution-challenge-access-control");
    await expect(confirm(a.h, [same], a.review)).resolves.toBeTruthy(); // the gap R3 closes: agreement within one parser substrate
    const run = (await db.ownerPool.query("SELECT workflow_run_id, produced_by_step_id FROM hypotheses WHERE id = $1", [a.h])).rows[0];
    await expect(db.ownerPool.query(`INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256)
      VALUES ($1,$2,$3,'solidity-structural-specialists','1','inconclusive','self',$4)`, [run.workflow_run_id, a.h, run.produced_by_step_id, "b".repeat(64)])).resolves.toBeTruthy();
  });

  it("applies on top of T-144 + A29, and its rollback restores exactly the previous catalog", async () => {
    const fresh = await migratedTestDatabase();
    try {
      await applyDrafts(fresh); const before = await catalog(fresh.ownerPool);
      await fresh.ownerPool.query(sql(R3_DRAFT.file)); expect(await catalog(fresh.ownerPool)).not.toBe(before);
      await fresh.ownerPool.query(sql(R3_DRAFT.rollback)); expect(await catalog(fresh.ownerPool)).toBe(before);
    } finally { await fresh.drop(); }
  });

  it("applies on top of T-144 alone (A29 not required), and rolls back exactly", async () => {
    const fresh = await migratedTestDatabase();
    try {
      await fresh.ownerPool.query(readFileSync(join(REPO_ROOT, "db", "drafts", DRAFTS[0].dir, DRAFTS[0].file), "utf8"));
      const before = await catalog(fresh.ownerPool);
      await fresh.ownerPool.query(sql(R3_DRAFT.file)); await fresh.ownerPool.query(sql(R3_DRAFT.rollback));
      expect(await catalog(fresh.ownerPool)).toBe(before);
    } finally { await fresh.drop(); }
  });

  describe("with the draft applied", () => {
    beforeAll(async () => { await applyR3Draft(db); });

    it("the database refuses an evaluation by the generator of its hypothesis, even when written past the store", async () => {
      const a = await adjudicated(SPECIALISTS);
      const run = (await db.ownerPool.query("SELECT workflow_run_id, produced_by_step_id FROM hypotheses WHERE id = $1", [a.h])).rows[0];
      await expect(db.ownerPool.query(`INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256)
        VALUES ($1,$2,$3,'solidity-structural-specialists','1','inconclusive','self',$4)`, [run.workflow_run_id, a.h, run.produced_by_step_id, "c".repeat(64)])).rejects.toThrow(/cannot be made by the generator of its hypothesis/);
      await fx.evaluate(a.s, a.h, "inconclusive", [], "no-independent-validator"); // an abstention by another id stays allowed
    });

    it("labels each evaluation cross-family, same-family, unknown-family or abstention", async () => {
      const spec = await adjudicated(SPECIALISTS); const sl = await adjudicated(SLITHER);
      const e1 = await fx.evaluate(spec.s, spec.h, "supports", [spec.sp], "execution-challenge-access-control");
      const e2 = await fx.evaluate(spec.s, spec.h, "supports", [spec.sp], "foundry-forge");
      const e3 = await fx.evaluate(sl.s, sl.h, "supports", [sl.sp], "reentrancy-execution-validator");
      const e4 = await fx.evaluate(spec.s, spec.h, "supports", [spec.sp], "an-unregistered-checker");
      const e5 = await fx.evaluate(spec.s, spec.h, "inconclusive", [], "no-independent-validator");
      const rel = new Map((await db.pool.query<{ evaluation_id: string; relation: string; generator_family: string | null; evaluator_family: string | null }>(
        "SELECT evaluation_id, relation, generator_family, evaluator_family FROM evaluation_independence WHERE evaluation_id = ANY($1::uuid[])", [[e1, e2, e3, e4, e5]])).rows.map((r) => [r.evaluation_id, r]));
      expect(rel.get(e1)).toMatchObject({ relation: "same_family", generator_family: "agentsmith-solidity-parser", evaluator_family: "agentsmith-solidity-parser" });
      expect(rel.get(e2)).toMatchObject({ relation: "cross_family", evaluator_family: "evm-execution" });
      expect(rel.get(e3)).toMatchObject({ relation: "cross_family", generator_family: "slither-ir" });
      expect(rel.get(e4)).toMatchObject({ relation: "unknown_family", evaluator_family: null });
      expect(rel.get(e5)).toMatchObject({ relation: "abstention" });
      const ind = (await db.pool.query("SELECT * FROM hypothesis_independence WHERE hypothesis_id = $1", [spec.h])).rows[0];
      expect(ind).toMatchObject({ generator_family: "agentsmith-solidity-parser", cross_family_supports: 1, same_family_supports: 1, unknown_family_supports: 1, independently_supported: true });
    });

    it("'confirmed' needs a CROSS-family supports: same-family or unknown-family agreement is refused; Foundry on a specialist lead is accepted", async () => {
      const a = await adjudicated(SPECIALISTS);
      const same = await fx.evaluate(a.s, a.h, "supports", [a.sp], "reentrancy-execution-validator");
      const unknown = await fx.evaluate(a.s, a.h, "supports", [a.sp], "an-unregistered-checker");
      await expect(confirm(a.h, [same], a.review)).rejects.toThrow(/different analysis family than the generator/);
      await expect(confirm(a.h, [same, unknown], a.review)).rejects.toThrow(/different analysis family/);
      const forge = await fx.evaluate(a.s, a.h, "supports", [a.sp], "foundry-forge");
      await expect(confirm(a.h, [same, forge], a.review)).resolves.toBeTruthy();
      // a validator from the parser family IS independent of Slither (slither-ir)
      const b = await adjudicated(SLITHER);
      await expect(confirm(b.h, [await fx.evaluate(b.s, b.h, "supports", [b.sp], "execution-challenge-access-control")], b.review)).resolves.toBeTruthy();
      // a human generator's claim (a missed finding) can be confirmed by any listed evaluator
      const c = await adjudicated({ kind: "human", id: "owner-test", version: "1" });
      await expect(confirm(c.h, [await fx.evaluate(c.s, c.h, "supports", [c.sp], "execution-challenge-access-control")], c.review)).resolves.toBeTruthy();
    });

    it("the other T-144 rules are unchanged: refuted still rests on a contradicts evaluation or a human rejection", async () => {
      const a = await adjudicated(SPECIALISTS);
      const w = await fx.evaluate(a.s, a.h, "weakens", [a.sp], "execution-challenge-access-control");
      const refute = (ids: string[]) => db.pool.query("INSERT INTO hypothesis_outcomes (hypothesis_id, category, decided_by, basis_evaluation_ids, rationale) VALUES ($1,'refuted','owner-test',$2::uuid[],'refuted')", [a.h, ids]);
      await expect(refute([w])).rejects.toThrow(/refuted requires a contradicts evaluation or a human rejects review/);
      await expect(refute([await fx.evaluate(a.s, a.h, "contradicts", [a.sp], "execution-challenge-access-control")])).resolves.toBeTruthy();
    });

    it("the seeded identities are append-only", async () => {
      await expect(db.ownerPool.query("UPDATE analysis_identities SET analysis_family = 'evm-execution' WHERE actor_id = 'reentrancy-execution-validator'")).rejects.toThrow();
      await expect(db.ownerPool.query("DELETE FROM analysis_identities WHERE actor_id = 'foundry-forge'")).rejects.toThrow();
    });
  });

  it("the grants overlay is read-only and covers the new table and both views", () => {
    const overlay = JSON.parse(sql("runtime-grants.draft.json")) as { tables: Record<string, string[]> };
    const created = [...sql(R3_DRAFT.file).matchAll(/CREATE (?:TABLE|VIEW) (\w+)/g)].map((m) => m[1]).sort();
    expect(Object.keys(overlay.tables).sort()).toEqual(created);
    for (const p of Object.values(overlay.tables)) expect(p).toEqual(["SELECT"]);
  });
});
