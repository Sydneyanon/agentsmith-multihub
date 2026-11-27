import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDrafts } from "./drafts.js";
import { assertIntegrationConfigured, migratedTestDatabase, REPO_ROOT, runMigrate, skipIntegration, type TestDatabase } from "./harness.js";

/** The A29 draft on THROWAWAY databases: the runner ignores it, and its rollback restores the catalog exactly (0001-0008 + T-144 draft). */
const DIR = join(REPO_ROOT, "db", "drafts", "a29-engine-loop");
async function catalog(pool: pg.Pool): Promise<string> {
  const q = async (text: string) => JSON.stringify((await pool.query(text)).rows);
  return [
    await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`),
    await q(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    await q(`SELECT tgrelid::regclass::text AS t, tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
    await q(`SELECT proname, md5(prosrc) AS h FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`),
  ].join("\n");
}

describe.skipIf(skipIntegration)("A29 draft migration (research loop records)", () => {
  let db: TestDatabase;
  beforeAll(async () => { assertIntegrationConfigured(); db = await migratedTestDatabase(); });
  afterAll(async () => { await db?.drop(); });

  it("is not applied by the migration runner", async () => {
    expect((await runMigrate({ directUrl: db.url })).code).toBe(0);
    expect((await db.ownerPool.query("SELECT to_regclass('research_decisions') AS t")).rows[0].t).toBeNull();
  });

  it("applies on top of the T-144 draft and rolls back to exactly the previous catalog", async () => {
    await db.ownerPool.query(readFileSync(join(REPO_ROOT, "db", "drafts", "t144-research-memory", "0009_research_memory.sql"), "utf8"));
    const before = await catalog(db.ownerPool);
    await db.ownerPool.query(readFileSync(join(DIR, "0010_engine_loop.sql"), "utf8"));
    expect(await catalog(db.ownerPool)).not.toBe(before);
    await db.ownerPool.query(readFileSync(join(DIR, "0010_engine_loop.rollback.sql"), "utf8"));
    expect(await catalog(db.ownerPool)).toBe(before);
  });

  it("the grants overlay is append-only (SELECT and INSERT only) and covers every new table", () => {
    const overlay = JSON.parse(readFileSync(join(DIR, "runtime-grants.draft.json"), "utf8")) as { tables: Record<string, string[]> };
    const created = [...readFileSync(join(DIR, "0010_engine_loop.sql"), "utf8").matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]).sort();
    expect(Object.keys(overlay.tables).sort()).toEqual(created);
    for (const p of Object.values(overlay.tables)) expect(p).toEqual(["SELECT", "INSERT"]);
  });

  it("applyDrafts is usable for the loop tests (sanity)", async () => {
    const fresh = await migratedTestDatabase();
    try { await applyDrafts(fresh); expect((await fresh.pool.query("SELECT count(*)::int n FROM research_decisions")).rows[0].n).toBe(0); }
    finally { await fresh.drop(); }
  });
});
