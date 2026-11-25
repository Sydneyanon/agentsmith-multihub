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

## Tests: unit versus real Postgres
- `npm test` runs the unit tests. They use a mocked database and say nothing about SQL behaviour.
- `npm run test:integration` runs real-Postgres tests (queue SQL, retry ceiling, reaper, snapshot immutability, the worker loop over the real queue, and the migration runner's checksum, advisory-lock, rollback and connection-safety protections). It needs `TEST_DATABASE_URL` pointing at a **loopback** Postgres server and exits 2 without it. Each test file creates its own `agentsmith_test_<hex>` database and drops it afterwards; non-loopback hosts are refused before any connection (`apps/api/src/db-safety.ts`). Use a disposable local server, never a shared or hosted database.
- `npm run verify` reports the integration step as SKIPPED when `TEST_DATABASE_URL` is unset.

## Build-only image check (not run yet)
`fly deploy --build-only --remote-only --app <staging-app>` builds the image on Fly's builder without releasing it. It needs a Fly credential and network access, so it is a separate, approved step. Nothing in this repository runs it.
