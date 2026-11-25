import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

import { assertMigrationTarget } from "../apps/api/src/db-safety.js";
import { buildPoolConfig, selectMigrationUrl, stderrWarning } from "../apps/api/src/db-config.js";

// Migrations use DIRECT_DATABASE_URL only; DATABASE_URL (the application/pooled URL) is never read here.
const directUrl = selectMigrationUrl(process.env);
// Fail closed before any connection: loopback only, unless the remote host is explicitly confirmed.
assertMigrationTarget(directUrl, process.env.MIGRATE_CONFIRM_REMOTE_HOST);

const pool = new Pool(buildPoolConfig(process.env, {
  max: 1, defaultConnectTimeoutMs: 5_000, urlVariable: "DIRECT_DATABASE_URL", onWarning: stderrWarning,
}));
const lockId = 7_341_109_221;

try {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockId]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const directory = join(process.cwd(), "db", "migrations");
    const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
    for (const name of files) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0]!.checksum !== checksum) {
          throw new Error(`Applied migration ${name} has changed; create a new migration instead`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        process.stdout.write(`Applied ${name}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
