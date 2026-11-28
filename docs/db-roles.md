# Database roles: owner vs runtime (review finding 4)

## The problem
Production's `DATABASE_URL` and `DIRECT_DATABASE_URL` both use `schema_admin`, which **owns every table**. The application therefore ran with authority to `ALTER TABLE … DISABLE TRIGGER`, drop or replace the guard functions, `TRUNCATE`, set `session_replication_role = replica` (superuser only, not an owner power) or call `evict_research_blob()`. A single SQL-injection or code-execution bug in the app (or the future worker) could silently turn off the Task 5.1 append-only protections. In particular the blob guard is only "closed" by a session variable that any session can set, so it protects nothing against a role that can `DELETE`.

## The design
Two roles:

| | owner / migration role (`schema_admin`) | runtime role (e.g. `agentsmith_app`) |
|---|---|---|
| Used by | `scripts/migrate.ts`, `scripts/apply-runtime-grants.ts`, operator-run eviction | API and worker (`DATABASE_URL`) |
| Owns objects | yes | **no** |
| Attributes | as today | no SUPERUSER/CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS, member of no role |
| DDL, TRIGGER, TRUNCATE, DELETE, REFERENCES | yes | **never** (the manifest loader refuses to load a manifest granting them) |
| DML | all | only what `db/runtime-grants.json` lists |
| `evict_research_blob()` | yes | **no** |

`db/runtime-grants.json` is the single reviewable list (INSERT on 20 tables, UPDATE on 6 mutable tables plus row-lock-only `hypotheses`, SELECT on read tables/views, no access to `schema_migrations`). `scripts/apply-runtime-grants.ts` (run as the owner, `DIRECT_DATABASE_URL` + `RUNTIME_ROLE`) revokes everything the role holds then grants exactly the manifest; it also removes `CREATE` on the schema from `PUBLIC` and `EXECUTE` on application functions from `PUBLIC`. It creates no role and sets no password. It refuses to run if the manifest and database disagree (a new table without a manifest entry fails closed) or if the role has elevated attributes.

Notes on specific grants:
- `hypotheses` has UPDATE only because `hypothesis_evidence_guard()` runs `SELECT … FOR UPDATE` on it as the invoking role. Real updates are rejected by the `hypotheses_immutable` trigger, which the runtime role cannot disable.
- `audit_events` has no trigger; it is append-only **by privilege** (SELECT, INSERT only).
- pgcrypto's functions are superuser-owned and PUBLIC-executable by design (pure computation); they cannot be revoked by the owner role and are excluded from the function check.

## Verification (all local, disposable loopback Postgres)
- `runtime-role.integration.test.ts`: manifest ↔ catalog, exact privilege matrix, role attributes, 20+ denied attack statements (disable triggers on every trigger-bearing table, `session_replication_role`, replace guard functions, `DROP`/`ALTER`/`CREATE`/`TRUNCATE`, `DELETE`/`UPDATE` with and without the eviction GUC, evict function, `SET ROLE`, `CREATE ROLE`, `COPY … PROGRAM`), triggers and function bodies byte-identical afterwards, idempotent apply, drift and elevated-role refusal, and the startup guard.
- `TEST_RUNTIME_ROLE=1 npm run test:integration` (`test:integration:restricted`): the entire existing integration suite — queue, worker loop, acquisition, research API, research state — runs with the code under test connected as the runtime role; trigger probes and eviction fixtures use the owner connection.
- Pointing the role checks at the owner (`TEST_ROLE_UNDER_TEST=owner`, i.e. production today) fails 17 of 27 tests.
- Mutations: `scripts/mutations/db-roles.json`.

## Application changes
`HUB_REQUIRE_RESTRICTED_DB_ROLE` (default `false`). In production the server inspects its own role **after it is already listening** (never awaited; found in the stack review: the first version ran the check before `listen`, so an unreachable or paused database made the process exit at boot, which the previous release did not do). A failed check is retried (6 attempts, 15 s apart); with `false` a bad role or an unverifiable role is logged as a warning; with `true` a bad role is fatal immediately and a role that cannot be verified after the attempts is fatal (fail closed).

## Rollout runbook — NOT executed; each step needs separate approval
1. Confirm whether the Fly Managed Postgres user can `CREATE ROLE` (**unknown**). If not, create the role through the provider's own mechanism and pass its name as `RUNTIME_ROLE`. Do not guess.
2. As the owner: `CREATE ROLE agentsmith_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT CONNECT ON DATABASE <db> TO agentsmith_app;` (password never printed or committed).
3. `DIRECT_DATABASE_URL=… RUNTIME_ROLE=agentsmith_app node dist/scripts/apply-runtime-grants.js` (also `npm run db:grants`; the image ships the compiled script, not `tsx`; from a source checkout `npx tsx scripts/apply-runtime-grants.ts` is equivalent). Re-run after every migration that adds a table or function (the script fails until the manifest is updated).
4. Deploy the code (still `schema_admin` in `DATABASE_URL`; the startup warning appears). Then set `DATABASE_URL` to the runtime role (Fly secret) and redeploy; verify `/health/ready`, dashboard and an intake.
5. Set `HUB_REQUIRE_RESTRICTED_DB_ROLE=true`.
6. **Rollback:** set `DATABASE_URL` back to the owner URL (previous secret) and redeploy; `REVOKE` is not required. No data or schema is changed by any step above.

## Limitations
- The owner role can still bypass the triggers (and run migrations). This change protects against compromise of the **application**, not of the owner credential; keep `DIRECT_DATABASE_URL` out of the runtime environment.
- Not exercised on Fly Managed Postgres; PostgreSQL major version and `CREATEROLE` availability there are unverified. Local runs used the local PostgreSQL 16.
- The startup wiring in `server.ts` (module-level) is covered by a source-order test, not an executed boot test.
- The worker entry point (`worker-main.ts`) does not run the startup check yet.

## Changes from the independent review (2026-11-25)
An independent reviewer (a fresh agent, not the author) read the PR #14 code and ran probes as the restricted role. Findings and what changed:

1. **Blocker: temp-schema shadowing.** The guard functions from migration 0007 run as the calling role with an unpinned `search_path`, and `PUBLIC` holds `TEMPORARY` on the database. A temp table named like a real one (`research_blobs`, `repo_snapshots`, `hypothesis_evidence`) is searched first, so the runtime role could make the guards validate forged data and insert rows that cannot be removed (reproduced for evidence spans, sealed-snapshot files and hypotheses without primary evidence). **Fixed in two layers by `apply-runtime-grants`:** `TEMPORARY` (and `CREATE`) on the database is revoked from `PUBLIC` and from the role, and every application function gets `SET search_path = public, pg_temp` (function configuration only; bodies and migration checksums are unchanged, so the schema stays at seven migrations). The startup guard now also reports a role that can create temp tables. Tests: temp creation denied; every function pinned; the shadowing probe fails to change `research_span_check` even when `TEMP` is granted back.
2. **`PUBLIC` table grants and memberships.** The script now also revokes table and sequence privileges from `PUBLIC`, and refuses a role that is `pg_*`, owns any object in the schema, or is a member of any role; the guard reports `PUBLIC` privileges. Tests for each.
3. **AI budget gateway** had no integration test: added (reserve, settle, failed-charged, blocked paths; fake adapter, no network, no spend), run as owner and as the restricted role.
4. **Startup guard (PR #17):** each failed attempt is now logged; idle pool errors are handled; the fatal exit is capped at 5 s.

Residual risks the review identified and this change does not remove:
- Row and table locks: UPDATE on `workflow_*`, `repo_snapshots`, `ai_budget_reservations`, `hypotheses` allows `LOCK TABLE`, and the gateway's advisory lock key is callable by any session, so a compromised app can stall the database (availability, not integrity). Role-level `statement_timeout` / `idle_in_transaction_session_timeout` could be set by the owner but the role can override them per session.
- Large objects (`lo_create`) and sequence burning remain possible.
- **Fly Managed Postgres (docs.fly.io, read 2026-11-25):** users are created with `fly mpg users create --role schema_admin|writer|reader`; the privileges behind `writer`/`reader` are not documented and the default user is `fly-user`. Before the rollout, create the login this way (start with `reader`), then check: not a member of any provider role (the script and guard refuse membership), owns nothing, `TEMPORARY` is revocable (the database owner may not be `schema_admin`; the script warns if it cannot revoke), and `default privileges` do not re-grant on new tables. If any check fails the design is **not usable as written** on that platform and `HUB_REQUIRE_RESTRICTED_DB_ROLE` must stay `false`.
- **`HUB_REQUIRE_RESTRICTED_DB_ROLE=true` can crash-loop:** if the database stays unreachable for more than the guard's window (6 attempts, about 75 to 95 s) the process exits 1 and Fly restarts it. The Developer plan pauses after 15 minutes without connections and wakes on the next connection; the wake time is unmeasured. Enable the flag only after the switch is proven (stage 4), and keep it `false` until then.
- Developer plan: 20 direct connections shared by everything (API pool max 5, plus any worker and migrations).

