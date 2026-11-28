import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, type TestDatabase } from "./harness.js";

/** Draft migrations, in order. They live outside db/migrations, so the runner never applies them; tests apply them to THROWAWAY databases. */
export const DRAFTS = [
  { dir: "t144-research-memory", file: "0009_research_memory.sql" },
  { dir: "a29-engine-loop", file: "0010_engine_loop.sql" },
] as const;

/** Applies the drafts as the owner and, in restricted mode, grants the runtime role exactly what each draft's overlay lists. */
export async function applyDrafts(db: TestDatabase): Promise<void> {
  for (const d of DRAFTS) {
    const dir = join(REPO_ROOT, "db", "drafts", d.dir);
    await db.ownerPool.query(readFileSync(join(dir, d.file), "utf8"));
    if (!db.runtimeRole) continue;
    const overlay = JSON.parse(readFileSync(join(dir, "runtime-grants.draft.json"), "utf8")) as { tables: Record<string, string[]> };
    for (const [table, privileges] of Object.entries(overlay.tables)) {
      if (!privileges.every((p) => p === "SELECT" || p === "INSERT")) throw new Error(`draft overlay grants more than SELECT/INSERT on ${table}`);
      await db.ownerPool.query(`GRANT ${privileges.join(", ")} ON ${table} TO ${db.runtimeRole}`);
    }
  }
}

/**
 * The R3 draft (db/drafts/r3-evaluator-independence), on top of the T-144 draft. Kept OUT of DRAFTS so the existing draft-dependent
 * suites keep testing the drafts as they are; its own test applies it (with and without A29) and checks its rollback.
 */
export const R3_DRAFT = { dir: "r3-evaluator-independence", file: "0015_evaluator_independence.sql", rollback: "0015_evaluator_independence.rollback.sql" } as const;
export async function applyR3Draft(db: TestDatabase): Promise<void> {
  const dir = join(REPO_ROOT, "db", "drafts", R3_DRAFT.dir);
  await db.ownerPool.query(readFileSync(join(dir, R3_DRAFT.file), "utf8"));
  if (!db.runtimeRole) return;
  const overlay = JSON.parse(readFileSync(join(dir, "runtime-grants.draft.json"), "utf8")) as { tables: Record<string, string[]> };
  for (const [table, privileges] of Object.entries(overlay.tables)) {
    if (!privileges.every((p) => p === "SELECT")) throw new Error(`the R3 overlay grants more than SELECT on ${table}`);
    await db.ownerPool.query(`GRANT SELECT ON ${table} TO ${db.runtimeRole}`);
  }
}
