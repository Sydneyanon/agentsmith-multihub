# Production-readiness checklist: Phase 5.0 discovery (migration 0008, API, worker, source activation, rollback)

Status 2026-11-26: **nothing here has been done.** Each step needs the owner's explicit approval. Steps are ordered; do not skip ahead.

## Fly Managed Postgres role facts (from Fly's own page, https://fly.io/docs/mpg/cluster-configuration/, read 2026-11-26)
- MPG users have one of three roles: **Schema Admin** (default for `fly-user`; DDL, all data, "closest to a Superuser"; cannot create databases or do other superuser actions), **Writer** (read/write/delete data, connect to any database; cannot change structure, create schemas, functions or temporary tables, **or alter database permissions or roles**), **Reader** (SELECT only).
- Creating a role is not among Schema Admin's documented abilities, and Writer cannot alter roles. So a hand-made `agentsmith_runtime` role created with `CREATE ROLE` by `schema_admin` is **not documented as possible**; the documented route is creating a user with the **Writer** role through Fly (dashboard/flyctl; this is a credential change and needs approval).
- Consequences for our design (`docs/db-roles.md`), all UNVERIFIED until tested on a disposable cluster:
  1. `scripts/apply-runtime-grants.ts` refuses roles that are members of another role. An MPG Writer user may get its rights through group membership, in which case the guard would refuse it (fail closed) and the script would need a reviewed change, not a bypass.
  2. A Writer has DELETE and UPDATE on **every** table, including `discovery_sources.enabled`. Row-level append-only triggers still stop UPDATE/DELETE on the evidence tables, but nothing stops a Writer from enabling a source or editing mutable tables. That is weaker than the manifest-based role. Whether `schema_admin` (the table owner) can REVOKE from the Writer is unknown.
  3. TRUNCATE is not blocked by the row triggers. Whether Writer holds TRUNCATE is not documented. Adding BEFORE TRUNCATE guards on append-only tables is a cheap compensating control (not yet done; no migration currently references TRUNCATE).
- How to settle it without touching production: create a **throwaway** MPG cluster (costs money, needs approval), create a Writer user, and run the role guard and grants script against it. Alternative: ask Fly support. Until then R1 stays open.

## Ordered steps
| # | Step | Gate / evidence needed | Rollback |
|---|---|---|---|
| 0 | Independent review of PR #20 finished, findings fixed | reviewer report + re-run verify and mutation | n/a |
| 1 | Live GitHub shape check from a permitted environment (one read-only GET, no token) | recorded status, timestamp, field validation vs zod schema | n/a |
| 2 | Decide role strategy (Writer user vs custom role) after a disposable-cluster test | role guard passes against the real role layout | n/a |
| 3 | Add BEFORE TRUNCATE guards (if Writer holds TRUNCATE) and re-review | migration test | not yet applied |
| 4 | Back up / confirm point-in-time recovery of the production database | owner confirms backup exists | n/a |
| 5 | Apply migration 0008 (additive: 4 tables, 2 triggers, 1 function) with `DIRECT_DATABASE_URL`, together with the image containing the matching code | approval; release image built from the reviewed commit; image smoke on the exact release commit (see note) | no table drop is needed: with no source enabled the tables are inert; down path is DROP of the four tables and function in reverse order, written and tested before applying |
| 6 | Deploy API image (discovery routes are bearer-protected; nothing fetches unless a human calls check or a worker runs) | owner approval, post-deploy checks as Release 1 | `fly deploy --image <previous digest>` (previous digest recorded in the release plan) |
| 7 | Apply runtime grants for discovery tables (`db/runtime-grants.json`) to the chosen runtime role | role guard + restricted-role integration run | re-apply previous manifest |
| 8 | Worker: second process group, no public ports, `DISCOVERY_ENABLED` unset, egress only to api.github.com / codeload.github.com, runtime role only | Fly billing resolved (trial stops machines after 5 min); minimum cost stated by owner from Fly pricing | scale the worker group to 0 |
| 9 | Create one source (disabled), review its config, then enable it | owner approval per source | `POST .../disable`; with `DISCOVERY_ENABLED` unset nothing runs anyway |
| 10 | Set `DISCOVERY_ENABLED=true` on the worker | owner approval | unset it |
| 11 | First human approval of one candidate (queues one passive acquisition run) | owner picks the repository | dismiss/stop the run; no active testing is possible in this phase |

Note on step 5: the migration count in image smoke checks and CI is currently 8 files (0001-0008); the "8" is the number of migration files, 0008 included. Re-run the image smoke on the exact release commit.

## What stays off throughout
X monitoring (not approved), platform-site adapters (terms unverified), Task 5.3, any active testing, any paid service not approved above.
