import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertDisposableTestDatabaseUrl, assertLoopbackDatabaseUrl } from "../db-safety.js";

/**
 * Real-Postgres test harness. Nothing here talks to a database unless
 * TEST_DATABASE_URL points at a loopback server, and every test gets its own
 * freshly created agentsmith_test_<hex> database that is dropped afterwards.
 * There is no fallback to any other database.
 */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
export const integrationRequired = process.env.REQUIRE_INTEGRATION === "1";

/** Used as `describe.skipIf(skipIntegration)`; a required run with no database fails instead of skipping. */
export const skipIntegration = !integrationEnabled && !integrationRequired;

export function assertIntegrationConfigured(): void {
  if (!integrationEnabled) throw new Error("TEST_DATABASE_URL is required (a loopback Postgres) when integration tests are required");
}

export type TestDatabase = {
  url: string;
  name: string;
  pool: pg.Pool;
  adminPool: pg.Pool;
  drop(): Promise<void>;
};

function withDatabase(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  assertLoopbackDatabaseUrl(adminUrl);
  const name = `agentsmith_test_${randomBytes(6).toString("hex")}`;
  const url = withDatabase(adminUrl!, name);
  assertDisposableTestDatabaseUrl(url);

  const adminPool = new pg.Pool({ connectionString: adminUrl!, max: 2, connectionTimeoutMillis: 5_000 });
  adminPool.on("error", () => undefined);
  await adminPool.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: url, max: 25, connectionTimeoutMillis: 5_000 });
  pool.on("error", () => undefined); // tests terminate backends on purpose
  return {
    url, name, pool, adminPool,
    async drop() {
      await pool.end().catch(() => undefined);
      await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await adminPool.end();
    },
  };
}

export type RunResult = { code: number | null; stdout: string; stderr: string; ms: number };

/** Run the real migration runner (scripts/migrate.ts) in a child process with a scrubbed environment. */
export function runMigrate(options: { directUrl?: string; cwd?: string; extraEnv?: Record<string, string> }): Promise<RunResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...(options.directUrl === undefined ? {} : { DIRECT_DATABASE_URL: options.directUrl }),
    ...options.extraEnv,
  }; // deliberately no PGHOST/PGDATABASE/etc.: nothing ambient can redirect the connection
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(`${REPO_ROOT}node_modules/.bin/tsx`, [`${REPO_ROOT}scripts/migrate.ts`], {
      cwd: options.cwd ?? REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

export async function migratedTestDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase();
  const result = await runMigrate({ directUrl: db.url });
  if (result.code !== 0) {
    await db.drop();
    throw new Error(`Migrations failed in the test database: ${result.stderr.slice(0, 500)}`);
  }
  return db;
}

/** Insert a workflow run with ordered steps; returns their ids. */
export async function seedRun(pool: pg.Pool, stepKeys: string[], runStatus = "queued"): Promise<{ runId: string; stepIds: string[] }> {
  const run = await pool.query<{ id: string }>(
    "INSERT INTO workflow_runs (workflow_type, status, input) VALUES ('link_or_idea_intake', $1, '{}'::jsonb) RETURNING id",
    [runStatus],
  );
  const runId = run.rows[0]!.id;
  const stepIds: string[] = [];
  for (const [sequence, key] of stepKeys.entries()) {
    const step = await pool.query<{ id: string }>(
      "INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1,$2,$3,'test','{}'::jsonb) RETURNING id",
      [runId, key, sequence],
    );
    stepIds.push(step.rows[0]!.id);
  }
  return { runId, stepIds };
}

export const stepRow = async (pool: pg.Pool, id: string) =>
  (await pool.query("SELECT * FROM workflow_steps WHERE id = $1", [id])).rows[0] as Record<string, any>;
export const runRow = async (pool: pg.Pool, id: string) =>
  (await pool.query("SELECT * FROM workflow_runs WHERE id = $1", [id])).rows[0] as Record<string, any>;
export const auditCount = async (pool: pg.Pool, entityId: string, action: string) =>
  Number((await pool.query("SELECT count(*) FROM audit_events WHERE entity_id = $1 AND action = $2", [entityId, action])).rows[0]!.count);
export const expireLease = (pool: pg.Pool, stepId: string) =>
  pool.query("UPDATE workflow_steps SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [stepId]);
