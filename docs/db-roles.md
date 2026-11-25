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

`db/runtime-grants.json` is the single reviewable list (INSERT on 16 tables, UPDATE on 4 mutable tables plus row-lock-only `hypotheses`, SELECT on read tables/views, no access to `schema_migrations`). `scripts/apply-runtime-grants.ts` (run as the owner, `DIRECT_DATABASE_URL` + `RUNTIME_ROLE`) revokes everything the role holds then grants exactly the manifest; it also removes `CREATE` on the schema from `PUBLIC` and `EXECUTE` on application functions from `PUBLIC`. It creates no role and sets no password. It refuses to run if the manifest and database disagree (a new table without a manifest entry fails closed) or if the role has elevated attributes.

Notes on specific grants:
- `hypotheses` has UPDATE only because `hypothesis_evidence_guard()` runs `SELECT … FOR UPDATE` on it as the invoking role. Real updates are rejected by the `hypotheses_immutable` trigger, which the runtime role cannot disable.
- `audit_events` has no trigger; it is append-only **by privilege** (SELECT, INSERT only).
- pgcrypto's functions are superuser-owned and PUBLIC-executable by design (pure computation); they cannot be revoked by the owner role and are excluded from the function check.

## Verification (all local, disposable loopback Postgres)
- `runtime-role.integration.test.ts`: manifest ↔ catalog, exact privilege matrix, role attributes, 20+ denied attack statements (disable triggers on every trigger-bearing table, `session_replication_role`, replace guard functions, `DROP`/`ALTER`/`CREATE`/`TRUNCATE`, `DELETE`/`UPDATE` with and without the eviction GUC, evict function, `SET ROLE`, `CREATE ROLE`, `COPY … PROGRAM`), triggers and function bodies byte-identical afterwards, idempotent apply, drift and elevated-role refusal, and the startup guard.
- `TEST_RUNTIME_ROLE=1 npm run test:integration` (`test:integration:restricted`): the entire existing integration suite — queue, worker loop, acquisition, research API, research state — runs with the code under test connected as the runtime role; trigger probes and eviction fixtures use the owner connection.
- Pointing the role checks at the owner (`TEST_ROLE_UNDER_TEST=owner`, i.e. production today) fails 13 of 20 tests.
- Mutations: `scripts/mutations/db-roles.json`.

## Application changes
`HUB_REQUIRE_RESTRICTED_DB_ROLE` (default `false`). In production the server inspects its own role at startup: with `false` it logs a warning naming the problems; with `true` it refuses to start.

## Rollout runbook — NOT executed; each step needs separate approval
1. Confirm whether the Fly Managed Postgres user can `CREATE ROLE` (**unknown**). If not, create the role through the provider's own mechanism and pass its name as `RUNTIME_ROLE`. Do not guess.
2. As the owner: `CREATE ROLE agentsmith_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT CONNECT ON DATABASE <db> TO agentsmith_app;` (password never printed or committed).
3. `DIRECT_DATABASE_URL=… RUNTIME_ROLE=agentsmith_app npx tsx scripts/apply-runtime-grants.ts`. Re-run after every migration that adds a table or function (the script fails until the manifest is updated).
4. Deploy the code (still `schema_admin` in `DATABASE_URL`; the startup warning appears). Then set `DATABASE_URL` to the runtime role (Fly secret) and redeploy; verify `/health/ready`, dashboard and an intake.
5. Set `HUB_REQUIRE_RESTRICTED_DB_ROLE=true`.
6. **Rollback:** set `DATABASE_URL` back to the owner URL (previous secret) and redeploy; `REVOKE` is not required. No data or schema is changed by any step above.

## Limitations
- The owner role can still bypass the triggers (and run migrations). This change protects against compromise of the **application**, not of the owner credential; keep `DIRECT_DATABASE_URL` out of the runtime environment.
- Not exercised on Fly Managed Postgres; PostgreSQL major version and `CREATEROLE` availability there are unverified. Local runs used the local PostgreSQL 16.
- The startup check is wired in `server.ts` (module-level, not unit-tested); the check itself is tested.
- The worker entry point (`worker-main.ts`) does not run the startup check yet.
