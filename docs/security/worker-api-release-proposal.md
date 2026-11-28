# Release proposal: option D with D1–D7 (NOT approved; for the owner)

`deploy/release.json` is deliberately unchanged: the owner approves releases. This is what a release candidate would add.

## Migrations

| | today (`deploy/release.json` candidate) | proposed |
|---|---|---|
| shipped | 0001–0007, 0011, 0012, 0013, 0014 | 0001–0007, 0011, 0012, 0013, 0014, **0015, 0016** |
| image build | `HUB_RELEASE_LAST_MIGRATION=0007 HUB_RELEASE_EXTRA_MIGRATIONS=0011,0012,0013,0014` | `HUB_RELEASE_LAST_MIGRATION=0007 HUB_RELEASE_EXTRA_MIGRATIONS=0011,0012,0013,0014,0015,0016` |
| excluded | 0008 and every draft | 0008 and every draft (0009, 0010, R3b) |

`candidate.migrations` in `deploy/release.json` would gain `"0015"` and `"0016"` in the same commit as the new candidate, once approved.

- **0015 `worker_api`**: seven new tables and one new trigger on `hypothesis_evaluations` (records each evaluation's key; refuses a
  duplicate key). Expand-only: no existing row changes; existing evaluations are indexed (earliest per key; an older duplicate stays).
- **0016 `research_independence`** (R3a): one seeded append-only table, one function, one trigger on `hypothesis_evaluations` (refuses
  an evaluation by the claim's own generator), two views. Expand-only.
- **Rollback**: `db/rollbacks/0016_research_independence.rollback.sql`, then `db/rollbacks/0015_worker_api.rollback.sql`. Rehearsed on a
  production-shaped disposable database with research data (`migrations-0015-0016.integration.test.ts`): data fingerprints of every
  pre-existing table identical after upgrade, after each rollback and after re-apply; catalogs identical after each rollback.
- **Code compatibility**: the store and the dossier detect 0015 (`to_regclass`) and behave as before without it, so the API and the
  direct worker can be deployed before the migration; the worker API itself needs 0015.

## Steps (each needs the owner's approval; none was performed)

1. Build the candidate image with the parameters above; smoke test; record the digest.
2. Apply 0015 and 0016 to production (`scripts/migrate.ts` with `MIGRATE_CONFIRM_REMOTE_HOST`).
3. Deploy the API with `WORKER_API_ENABLED=true`, `WORKER_API_HOST=fly-local-6pn`, a read-only `GITHUB_TOKEN` (D2), the private
   port in no `[[services]]` block.
4. Mint a run-scoped token (`worker-token-main.js mint`, output redirected into the worker's token file, never a terminal) and start one
   worker machine with `WORKER_STORE=api`, `WORKER_API_URL`, `WORKER_API_TOKEN_FILE` and no database URL. Decide first how the token
   file reaches the machine (see `worker-api-operations.md`: a Fly secret is an environment variable, which the worker refuses).

## Decisions the owner needs to make

- the API starting its own analysis child process (D1/D3 CPU limits), a change to "the image starts no process";
- the token delivery mechanism on Fly (file, not environment);
- whether the optional Slither stage may run on a remote worker (its leads are worker-reported).
