# Fly staging runbook (staging only)

Scope: one staging app (`agentsmith-multihub-staging`) and one new Managed Postgres cluster. **Never** the existing production app, any production database, the public Hunt site, DNS or the public status feed. No step below runs without the owner's explicit approval, migrations are never automatic (`fly.toml` has no `release_command`), and `DATABASE_SSL_VERIFY=false` is never used without asking. Always pass `--app agentsmith-multihub-staging`; `fly.toml` itself names the existing app.

Status: **nothing here has been executed.** Commands marked (verify) have not been exercised against Fly.

## Order of operations
1. **Prepare (owner, Fly website).** Create the empty app and an app-scoped deploy token (48 h). Add the secret `API_BEARER_TOKEN` (32+ random characters). Do not create the database yet.
2. **Build and deploy the staging image first, with no database attached.**
   - Before deploying, test that Fly's remote builder is reachable from the session (build-only) (verify). If it is not, stop and report.
   - Expected after deploy: the API machine is healthy, `/health/live` is 200 and `/health/ready` is 503 (`database_not_configured`). The worker needs a database and will not run: scale it to zero with `fly scale count app=1 worker=0 --app agentsmith-multihub-staging` (verify) and confirm with `fly status`.
   - Checkpoint: the release succeeded and the app machine is healthy.
3. **Create the Managed Postgres cluster (owner, Fly website):** Developer plan, a new empty cluster named for staging, no PostGIS. Checkpoint: the cluster shows as ready.
4. **Attach it to the staging app (owner, Connect tab, "Set secret and deploy").** This sets the *application* URL `DATABASE_URL` and triggers a deployment. Because the image already exists, that deployment is expected to succeed. **If it fails, stop and report the logs; do not continue and do not treat it as ignorable.** After it completes, verify all three:
   - `fly secrets list --app agentsmith-multihub-staging` shows `DATABASE_URL` (names only; values are never printed or shared) (verify);
   - the latest release succeeded and the app machine is healthy (`fly status`);
   - `/health/live` is 200.
5. **Configure the direct migration URL separately (owner, app Secrets page).** Attachment does **not** set it. Copy the cluster's *direct* connection string from the Connect tab into a new secret `DIRECT_DATABASE_URL`. Setting a secret can trigger another deployment: verify that deployment succeeds too. On the Developer plan the attached `DATABASE_URL` is also a direct URL, but the migration runner still requires `DIRECT_DATABASE_URL` and never falls back to `DATABASE_URL`.
6. **First real connection, with TLS verification ON.** Call `/health/ready` and allow 30 s for a paused cluster to wake. Fly's docs say SSL is enabled but not which CA signs it, so verification may fail. **If it does, stop and report the exact error. Do not set `DATABASE_SSL_VERIFY=false`.** Any change is proposed to the owner first, with the security trade-off stated; the override is a last resort that reduces security.
7. **Migrations, only after explicit owner approval and confirmation that the cluster is the new empty one.** Run once, inside a staging machine, so the secrets stay on Fly: `MIGRATE_CONFIRM_REMOTE_HOST=<direct host from the Connect tab> node dist/scripts/migrate.js` (verify how the one-off command is run). The confirmation host must equal the host in `DIRECT_DATABASE_URL`; the runner refuses otherwise. Checkpoint: six migrations applied and recorded.
8. **Start the worker and demonstrate.** `fly scale count worker=1 --app agentsmith-multihub-staging` (verify), submit one passive intake, and verify the persisted steps, snapshots and brief in the database. Remember the Developer plan allows 20 connections in total (API 5, worker 3, migration 1).

## Stop conditions
A failed deployment at any point, a missing secret name, a certificate error, a cluster that is not empty, any host or app name that is not the staging one, or any request that would touch production. Stop, report the exact output, and wait.

## Rollback
Scale the worker to zero. Delete the staging cluster or app only when the owner asks. The Developer plan keeps one daily backup for one day; take a `pg_dump` of anything that matters first.
