# DRAFT migration: T-144 shared research memory

- **Status:** draft only. The owner approved the T-144 **design** (A4) on 2026-11-26. **Applying** this to any non-throwaway database is a
  separate approval (A4b).
- **Why here:** the migration runner reads only `db/migrations/`, so nothing in this directory can be applied by accident.
- **Tests:** `apps/api/src/integration/research-memory-draft.integration.test.ts` applies it to throwaway local databases. It covers the
  owner and restricted runtime roles, existing records, the scope guard, the rules, append-only, rollback and compatibility.
- **To promote it (after A4b):**
  1. Move `0009_research_memory.sql` into `db/migrations/` under the next free number.
  2. Merge `runtime-grants.draft.json` into `db/runtime-grants.json`.
  3. Delete this directory.
