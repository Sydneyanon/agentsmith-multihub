# Database migrations

Set `DATABASE_URL` in the environment where the migration command runs. Do not commit it or paste it into issue trackers.

Run:

```sh
npm install
npm run build
npm run db:migrate
```

The migration runner reads ordered SQL files from `db/migrations`, acquires a PostgreSQL advisory lock, and records each applied filename and SHA-256 checksum in `schema_migrations`. Each individual migration and its ledger row commit in one transaction.

The runner refuses any non-loopback `DATABASE_URL` before connecting unless `MIGRATE_CONFIRM_REMOTE_HOST` equals the URL's host exactly, and it never falls back to ambient `PG*` settings (a URL with no host is refused). This guards against mistakes; it does not replace the approval policy for running migrations against any hosted database.

Never edit an applied migration. Add a new, forward-only migration with the next sequence number. Review SQL and take a recoverable database backup before production migrations. The runner does not automatically roll back earlier migrations if a later migration fails.

For a Fly deployment, run the migration command as a controlled release step before starting code that depends on the new schema. Do not run migrations independently from every application machine.
