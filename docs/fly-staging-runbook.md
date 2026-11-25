# Fly staging runbook (staging only)

Scope: one staging app (`agentsmith-multihub-staging`) and one new Managed Postgres cluster. **Never** the existing production app, any production database, the public Hunt site, DNS or the public status feed. No step below runs without the owner's explicit approval, migrations are never automatic (`fly.toml` has no `release_command`), and `DATABASE_SSL_VERIFY=false` is never used without asking. Always pass `--app agentsmith-multihub-staging` together with a staging config file; `fly.toml` itself names the existing app and is never used here.

Status: **nothing here has been executed.** Commands marked (verify) have not been exercised against Fly.

## Order of operations
Staging has its own config files, generated from `fly.toml` by `npm run staging:configs` and checked by tests so they cannot drift: `fly.staging-bootstrap.toml` (app process group only) and `fly.staging.toml` (app and worker). Both name the staging app. Never run a staging command with `fly.toml`.

Why two releases: Fly's documentation says `fly deploy` "creates and starts at least one Machine for each process group in `fly.toml`", and that a later deploy which adds a group "spins up at least one new Machine to run each new process". The worker exits immediately without a database, so scaling it to zero *after* the first deploy is too late. The first release therefore defines no worker group at all, and the worker arrives in a later release once the database is attached and migrated. (`--process-groups` is deliberately not relied on: the documentation does not say it stops other groups' Machines being created on a first deploy.)

1. **Prepare (owner, Fly website).** Create the empty app and an app-scoped deploy token (48 h). Add the secret `API_BEARER_TOKEN` (32+ random characters). Do not create the database yet.
2. **Builder check.** Test that Fly's remote builder is reachable from the session (build-only) (verify). If it is not, stop and report.
3. **First release: app only, no database.** `fly deploy --config fly.staging-bootstrap.toml --app agentsmith-multihub-staging --ha=false` (verify). `--ha=false` avoids the default spare Machine (Fly's `--ha` defaults to true). Checkpoint, all required:
   - the release succeeded;
   - `fly status --app agentsmith-multihub-staging` shows exactly one `app` Machine, healthy, and **no `worker` Machine**;
   - `/health/live` is 200 and `/health/ready` is 503 (`database_not_configured`).
4. **Create the Managed Postgres cluster (owner, Fly website):** Developer plan, a new empty cluster named for staging, no PostGIS. Checkpoint: the cluster shows as ready.
5. **Attach it to the staging app (owner, Connect tab, "Set secret and deploy").** This sets the *application* URL `DATABASE_URL` and triggers a deployment of the existing app. Because the image already exists, that deployment is expected to succeed. **If it fails, stop and report the logs; do not continue and do not treat it as ignorable.** After it completes, verify all of:
   - `fly secrets list --app agentsmith-multihub-staging` shows `DATABASE_URL` (names only; values are never printed or shared) (verify);
   - the latest release succeeded and the `app` Machine is healthy;
   - **still no `worker` Machine** (if one appeared, stop);
   - `/health/live` is 200.
6. **Configure the direct migration URL separately (owner, app Secrets page).** Attachment does **not** set it. Copy the cluster's *direct* connection string from the Connect tab into a new secret `DIRECT_DATABASE_URL`. Setting a secret can trigger another deployment: verify that it succeeds and that there is still no worker. On the Developer plan the attached `DATABASE_URL` is also a direct URL, but the migration runner still requires `DIRECT_DATABASE_URL` and never falls back to `DATABASE_URL`.
7. **First real connection, with TLS verification ON.** Call `/health/ready` and allow 30 s for a paused cluster to wake. Fly's docs say SSL is enabled but not which CA signs it, so verification may fail. **If it does, stop and report the exact error. Do not set `DATABASE_SSL_VERIFY=false`.** Any change is proposed to the owner first, with the security trade-off stated; the override is a last resort that reduces security.
8. **Migrations, only after explicit owner approval and confirmation that the cluster is the new empty one.** Run once, inside the staging `app` Machine, so the secrets stay on Fly: `MIGRATE_CONFIRM_REMOTE_HOST=<direct host from the Connect tab> node dist/scripts/migrate.js` (verify how the one-off command is run). The confirmation host must equal the host in `DIRECT_DATABASE_URL`; the runner refuses otherwise. Checkpoint: every migration in `db/migrations` is applied and recorded (currently seven, including the research-state schema).
9. **Second release: add the worker.** `fly deploy --config fly.staging.toml --app agentsmith-multihub-staging --ha=false` (verify). Checkpoint: the release succeeded, `fly status` shows one `app` and one `worker` Machine, and the worker logs show it polling with no database error.
10. **Demonstrate.** Submit one passive intake and verify the persisted steps, snapshots and brief in the database. The Developer plan allows 20 connections in total (API 5, worker 3, migration 1).

## Stop conditions
A failed deployment at any point, a missing secret name, a certificate error, a cluster that is not empty, any host or app name that is not the staging one, or any request that would touch production. Stop, report the exact output, and wait.

## Rollback
Scale the worker to zero (`fly scale count worker=0 --app agentsmith-multihub-staging`) (verify). Delete the staging cluster or app only when the owner asks. The Developer plan keeps one daily backup for one day; take a `pg_dump` of anything that matters first.
