# R1: restricted worker role (prepared and tested; NOT applied to production)

Decision 2026-11-27: the worker must not run with the database-owner role. R1 is a separate, minimal change:
- the worker gets its own least-privilege database user;
- the API keeps its role and behaviour unchanged.

Nothing here has been applied to production. Each production step in section 5 needs explicit approval.

## 1. What production looks like (read-only checks, 2026-11-27)

| Fact | Value |
|---|---|
| PostgreSQL | 16.16 on Fly Managed Postgres, database `fly-db`, owned by `postgres` |
| API connection | session user `fly-user`, effective role `schema_admin`, which owns all 32 application tables and all 25 application functions (unchanged by R1) |
| Who can create roles | nobody available to us (`fly-user`, `schema_admin`, `writer` and `reader` all lack CREATEROLE). Users are created by Fly: `fly mpg users create --role schema_admin, writer or reader` |
| Fly `writer` | `pg_write_all_data`: INSERT, UPDATE and DELETE on all 32 tables. **Unacceptable**: it could delete the audit trail and rewrite the migration ledger |
| Fly `reader` | `pg_read_all_data`: SELECT only; no write, create or temp |
| PUBLIC | no rights on the database; SELECT on one **extension-owned** view, `pg_stat_monitor` (left untouched by R1); EXECUTE on the 25 application functions (revoked by R1) |
| Application functions | 25, owned by `schema_admin`, none with a pinned `search_path` (R1 pins them) |

## 2. Design

- **The worker's user:** `agentsmith_worker`, created by Fly with role `reader`. It inherits SELECT only; everything it can write is granted directly by `scripts/apply-runtime-grants.ts` from `db/runtime-grants.json`.
- **Membership rule:** the `reader` membership is tolerated only because it is named (`RUNTIME_ROLE_READONLY_MEMBERSHIPS=reader`) **and** proven read-only by `readOnlyRoleProblems()`:
  - no elevated attribute;
  - it inherits nothing but `pg_read_all_data`;
  - no INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER or REFERENCES on any relation;
  - no ownership, no CREATE in the schema, no TEMP.
  - The proof runs on the state the transaction leaves, so any failure rolls everything back.
  - `writer` always fails this test.
- **Belt and braces:** the startup check also fails if the role effectively holds DELETE, TRUNCATE, TRIGGER or REFERENCES on any relation, through any path.
- **Absent tables:** production has migrations 0001–0007 only. `RUNTIME_GRANTS_ALLOW_ABSENT=true` lists and skips manifest tables that do not exist (the four 0008 tables). A table that exists but is not in the manifest still fails.
- **Extension-owned objects** (pgcrypto's functions, `pg_stat_monitor`) are not the application's. The catalog check, the PUBLIC revocations and the startup check all leave them alone. A test reproduces the production view; without this fix the grants script fails on production.
- **Dry run:** `RUNTIME_GRANTS_DRY_RUN=true` does everything inside the transaction, prints every privilege the role gains or loses, then rolls back.
- **Worker** (`worker-main.ts`):
  - It connects with `WORKER_DATABASE_URL`; the API's `DATABASE_URL` is not touched.
  - With `HUB_REQUIRE_RESTRICTED_DB_ROLE=true` it checks its role **before claiming anything**. If the role is not least-privilege, it exits with code 78 and claims nothing.
  - `WORKER_ONLY_RUN_ID` restricts it to one run; `WORKER_EXIT_WHEN_RUN_DONE=true` makes it exit when that run finishes.
- **Run creation:** `create-run-main.ts` creates one `repository_research` run with analysis switched on. It runs only if the input's canonical SHA-256 equals the approved hash and no other run is pending.

## 3. Exact permissions of `agentsmith_worker` (measured on the production profile)

These were measured with `has_table_privilege` on a disposable database with exactly migrations 0001–0007 and Fly-shaped roles, after the real grants script ran.

| Table | Granted beyond `reader`'s SELECT | Why |
|---|---|---|
| `workflow_runs`, `workflow_steps` | INSERT, UPDATE | queue state (create the run, claim and lease steps, record results) |
| `repo_snapshots` | INSERT, UPDATE | create the snapshot, then seal it. Sealed rows are immutable by trigger |
| `hypotheses` | INSERT, UPDATE | UPDATE is needed only for the evidence guard's row lock. The `hypotheses_immutable` trigger rejects every real update |
| `ai_budget_reservations` | INSERT, UPDATE | budget gateway state (not used by this run; no AI calls) |
| `repo_snapshot_files`, `research_blobs`, `evidence_spans`, `hypothesis_evidence`, `hypothesis_evaluations`, `evaluation_evidence`, `hypothesis_events`, `hypothesis_reviews`, `audit_events`, `source_snapshots`, `model_usage_events` | INSERT only | append-only records |
| every other table, including `schema_migrations` and `research_blob_evictions` | nothing | SELECT only, through `reader` |

- **Never held on any table:** DELETE, TRUNCATE, TRIGGER, REFERENCES. The manifest loader refuses a manifest that grants them, and the startup check refuses a role that holds them.
- **Functions it may execute:** `verify_repo_snapshot`, `verify_evidence_span`, `repo_snapshot_manifest`, `research_span_check`, `research_split_lines` and `research_reviewer_saw_valid`, plus pgcrypto.
- **Explicitly denied:** `evict_research_blob`.
- **Attributes:** not superuser, no CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS; owns nothing; no CREATE in the schema; no TEMP.

## 4. Tests (local, disposable Postgres 16)

`apps/api/src/integration/r1-runtime-role.integration.test.ts` (9 tests) covers the production profile: 0001–0007 only, Fly-shaped `reader` and `writer` roles, a worker user created as a member of `reader`, and the `pg_stat_monitor` situation.

1. **Refusals:**
   - Without the absent-table flag, the script names the missing 0008 tables and applies nothing.
   - An un-named membership is refused.
   - A `writer` membership is refused even when named.
2. **Dry run:** it reports `+ workflow_steps:UPDATE` and the other changes, then leaves the privileges unchanged.
3. **API role unchanged:** after applying, the owner holds exactly the privileges it held before, and the monitoring view is still readable by PUBLIC.
4. **Startup check:** it passes for the worker only with the named read-only membership; it fails for the owner (owns relations) and for a `writer` user (inherits `pg_write_all_data`; holds DELETE).
   - **Negative control:** the `writer` user really can delete audit events.
5. **The whole approved chain runs as the worker role:**
   - create the run (same shape as the approved input; a local fixture commit, no network);
   - acquire; seal the snapshot; structural analysis; hypotheses; deterministic evaluations; dossier;
   - the run ends `succeeded`;
   - a second queued run is never claimed by the run-scoped worker.
6. **Every bypass of protected evidence is refused as the worker role,** and the evidence fingerprint is identical afterwards. The tables are checked to have rows first, so a no-op cannot pass. The attempts:
   - `ALTER TABLE … DISABLE TRIGGER` on three tables;
   - `SET session_replication_role = replica`;
   - UPDATE of a sealed snapshot, a hypothesis, an evaluation and an evidence span;
   - DELETE from hypotheses, evaluations, snapshot files, blobs, spans and the audit trail;
   - TRUNCATE;
   - writing `schema_migrations`;
   - `DROP TABLE`, `CREATE TABLE`, `CREATE TEMP TABLE` (shadowing);
   - replacing a guard function;
   - `evict_research_blob`;
   - `SET ROLE` to the owner, `ALTER ROLE` itself, `COPY … TO PROGRAM`;
   - granting itself DELETE (PostgreSQL only warns; the test checks that no privilege was gained);
   - switching to the `reader` role and writing.
7. **The worker process:**
   - Started with the owner URL and the restricted role required, it exits 78 and the queued step stays `queued` with attempt 0.
   - Started as the worker role, scoped to a finished run, it verifies its role, reports the scope and exits 0.

**Regression check:** with the extension fix reverted and the new test kept, 2 tests fail ("grants manifest does not match the database"). With the fix, all pass.

**Full verification of the production base plus the patch** (`837aeb9` plus `docs/release/r1-on-837aeb9.patch`): `npm run verify` exits 0.
- Unit tests: 863 passed.
- Integration tests: 270 passed as the owner and 270 as the restricted role.
- One earlier full run had one failure in the existing `structural-workflow` test ("lease lost during analysis"; its heartbeat is every 40 ms). It passed 3/3 alone and 2/2 in full restricted runs, so it is a timing flake under parallel load, not an R1 effect.

**On the working branch:** the same patch applies (one comment-only conflict resolved). `npm run verify` exits 0: 931 unit tests passed and 1 skipped; 319 integration tests passed as the owner and 319 as the restricted role.

## 5. Production steps (each needs approval; none done)

**Image:**
- `git worktree add --detach w 837aeb9 && git -C w am docs/release/r1-on-837aeb9.patch` must give tree `ac2a6d2274f3d820b592c50d0c45673175430ed8`. The patch's SHA-256 is `69e1dd44d5c0df4a53ec4edafcc9b6b359eba4d84b70ee98dd23016e01740a54`.
- Then `HUB_RELEASE_LAST_MIGRATION=0007 scripts/hub-image.sh` in that worktree. The image is pushed to the registry under a new tag; **no app release**, so the API machine keeps its v6 image.

**Database user:** `fly mpg users create <cluster> --username agentsmith_worker --role reader`. Best run by you, so the password never passes through this session.

**Secret:** set its connection string as the app secret `WORKER_DATABASE_URL` with `fly secrets set … --stage`.
- `--stage` restarts nothing; the API never reads this variable.

**Grants, dry run first:** a one-off machine on the R1 image runs `apply-runtime-grants.js` as the owner with:
- `RUNTIME_ROLE=agentsmith_worker`
- `RUNTIME_ROLE_READONLY_MEMBERSHIPS=reader`
- `RUNTIME_GRANTS_ALLOW_ABSENT=true`
- `RUNTIME_GRANTS_DRY_RUN=true`

Expected output:
- membership `reader` verified;
- 4 absent tables skipped;
- about 21 privileges added and 0 removed for the worker;
- "DRY RUN: rolled back".

Then the same command without the dry-run flag.

**What applying changes beyond the new user:**
- PUBLIC loses EXECUTE on the 25 application functions. The API is the owner, and triggers do not check EXECUTE, so nothing the API does changes.
- The 25 application functions get `search_path = public, pg_temp`. This only hardens name resolution; every object they use is in `public`.
- `REVOKE TEMPORARY … FROM PUBLIC` is a no-op: PUBLIC holds nothing on the database.
- `pg_stat_monitor` is untouched.

**Rollback:**
- `fly mpg users delete agentsmith_worker` and `fly secrets unset WORKER_DATABASE_URL`.
- Optionally `ALTER FUNCTION … RESET search_path` and `GRANT EXECUTE … TO PUBLIC` on the 25 functions.

No data or table changes in any step.
