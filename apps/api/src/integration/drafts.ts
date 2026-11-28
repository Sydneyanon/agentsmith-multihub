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
 * The R3b draft (db/drafts/r3b-outcome-independence): the T-144 'confirmed' rule tightened to cross-family. It needs 0016 (a migration)
 * and the T-144 draft, so it is applied on top of applyDrafts(). It grants nothing of its own (0016's grants cover what it reads).
 */
export const R3B_DRAFT = { dir: "r3b-outcome-independence", file: "r3b_outcome_independence.sql", rollback: "r3b_outcome_independence.rollback.sql" } as const;
export async function applyR3bDraft(db: TestDatabase): Promise<void> {
  await db.ownerPool.query(readFileSync(join(REPO_ROOT, "db", "drafts", R3B_DRAFT.dir, R3B_DRAFT.file), "utf8"));
}
