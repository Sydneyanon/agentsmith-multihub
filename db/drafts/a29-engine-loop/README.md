# DRAFT migration: A29 research-loop records

- **Status:** draft only, written 2026-11-27 for the research-loop vertical slice (`docs/research-loop.md`). It implements the A28 design
  (`docs/research-decision-records.md`), with the deviations listed there, plus the minimal 0008 additions the loop needs, aligned with
  T-040. **Applying it to any non-throwaway database is A29.** It requires the T-144 draft (A4b) first.
- **Why here:** the migration runner reads only `db/migrations/`, so nothing in this directory can be applied by accident, and the
  release image build removes `db/drafts`.
- **Tests:** `apps/api/src/integration/engine-loop-draft.integration.test.ts` (the runner ignores it; exact rollback; grants overlay is
  append-only and complete) and `engine-loop.integration.test.ts` (the whole loop, as owner and as the restricted runtime role).
- **To promote it (after A4b and A29):** promote T-144 first; move `0010_engine_loop.sql` into `db/migrations/` under the next free
  number; merge `runtime-grants.draft.json` into `db/runtime-grants.json`; delete this directory.
