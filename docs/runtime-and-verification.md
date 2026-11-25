# Runtime layout and local verification

## Process groups
One image runs two process groups (`fly.toml` `[processes]`):

| Group | Command | Notes |
|---|---|---|
| `app` | `npm start` (`node dist/apps/api/src/server.js`) | the only group exposed over HTTP; liveness check on `/health/live` |
| `worker` | `npm run worker:intake` (`node dist/apps/api/src/worker-main.js`) | no HTTP service; runs from compiled JavaScript, so the runtime image needs no `tsx` |

`npm run worker:intake:dev` runs the worker through `tsx` for local development only. `tsx` is a dev dependency and is not in the runtime image (`npm ci --omit=dev`). Machine counts per group are set at deploy time, not in `fly.toml`.

`fly.toml` names the existing app. **Always pass an explicit `--app <name>`** and use a separate staging app; never deploy this file without it. No `release_command` is configured on purpose: migrations are a separate, explicitly approved step (`docs/database-migrations.md`), not something every deploy runs automatically.

## `npm run verify`
Runs, locally and without GitHub Actions: lockfile consistency (`npm ci --dry-run`), typecheck, tests and build, then prints PASS / FAIL / SKIPPED per check and exits non-zero on any failure.

- `npm run verify -- --docker` also attempts a real `docker build`. With no reachable Docker daemon it reports SKIPPED, never PASS.
- It is a local run. It does not replace independent CI, and it says nothing about a deployment.

## Database client settings
All pools (API, worker, migration runner) are built by `buildPoolConfig` (`apps/api/src/db-config.ts`):
- `DATABASE_CONNECT_TIMEOUT_MS` (default 3000, allowed 1000-60000). `fly.toml` sets 30000 because a Fly Managed Postgres **Developer** cluster auto-pauses after 15 minutes idle and takes about 15-25 s to wake.
- TLS is used in production and for any non-loopback host, **with certificate verification on**. Fly's documentation says SSL is enabled for Managed Postgres but not which CA signs it, so verification is untested until the first staging connection. `DATABASE_SSL_VERIFY=false` exists only as a last-resort, security-reducing override: it is never set automatically, a loud warning is logged whenever it is in effect, and it must not be used during setup without the owner's explicit approval. A failed verification is reported, not worked around.
- Connections are recycled after 10 minutes and idle ones after 30 s, per Fly's guidance to stay under the proxy's drain timeout.
- Developer-plan limits to plan around: up to 20 connections shared by all clients (API pool 5, worker pool 3, migration 1), 1 GB growing to 5 GB, one backup a day kept for one day (take your own `pg_dump` of anything that matters).
- The API and worker use `DATABASE_URL`. Migrations use **only** `DIRECT_DATABASE_URL` (no fallback to `DATABASE_URL`), and because the host is not loopback they need `MIGRATE_CONFIRM_REMOTE_HOST=<that exact host>`; they are still a separate, explicitly approved step. See `docs/fly-staging-runbook.md` for the order of operations.

## Tests: unit versus real Postgres
- `npm test` runs the unit tests. They use a mocked database and say nothing about SQL behaviour.
- `npm run test:integration` runs real-Postgres tests (queue SQL, retry ceiling, reaper, snapshot immutability, the worker loop over the real queue, and the migration runner's checksum, advisory-lock, rollback and connection-safety protections). It needs `TEST_DATABASE_URL` pointing at a **loopback** Postgres server and exits 2 without it. Each test file creates its own `agentsmith_test_<hex>` database and drops it afterwards; non-loopback hosts are refused before any connection (`apps/api/src/db-safety.ts`). Use a disposable local server, never a shared or hosted database.
- `npm run verify` reports the integration step as SKIPPED when `TEST_DATABASE_URL` is unset.

## Build-only image check (not run yet)
`fly deploy --build-only --remote-only --app <staging-app>` builds the image on Fly's builder without releasing it. It needs a Fly credential and network access, so it is a separate, approved step. Nothing in this repository runs it.
