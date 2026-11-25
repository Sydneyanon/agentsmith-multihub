import { join } from "node:path";
import pg from "pg";
import { assertMigrationTarget } from "../apps/api/src/db-safety.js";
import { buildPoolConfig, selectMigrationUrl, stderrWarning } from "../apps/api/src/db-config.js";
import { assertRoleName, loadManifest, manifestCatalogProblems } from "../apps/api/src/db-roles.js";

/**
 * Applies db/runtime-grants.json to an EXISTING login role, as the owner/migration role (DIRECT_DATABASE_URL).
 * It creates no role and changes no password: role creation is a separate, explicit operator step (docs/db-roles.md).
 * Idempotent: it first revokes everything the role holds in the schema, then grants exactly the manifest.
 */
const url = selectMigrationUrl(process.env);
assertMigrationTarget(url, process.env.MIGRATE_CONFIRM_REMOTE_HOST);
const role = assertRoleName(process.env.RUNTIME_ROLE);
const manifest = loadManifest(join(process.cwd(), "db", "runtime-grants.json"));
const pool = new pg.Pool(buildPoolConfig(process.env, { max: 1, defaultConnectTimeoutMs: 5_000, urlVariable: "DIRECT_DATABASE_URL", onWarning: stderrWarning }));
const q = (s: string) => pg.escapeIdentifier(s);

try {
  const client = await pool.connect();
  try {
    const problems = await manifestCatalogProblems(client, manifest);
    if (problems.length) throw new Error(`grants manifest does not match the database:\n - ${problems.join("\n - ")}`);
    const r = (await client.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
      "SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1", [role])).rows[0];
    if (!r) throw new Error(`role ${role} does not exist; create it first (see docs/db-roles.md)`);
    if (r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolreplication || r.rolbypassrls) throw new Error(`role ${role} has elevated attributes; refusing to use it as the runtime role`);
    const schema = q(manifest.schema);
    await client.query("BEGIN");
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${q(role)}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${q(role)}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${q(role)}`);
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${q(role)}`);
    // Defaults that would otherwise leak authority to every role: no CREATE in the schema, and functions are not callable by default.
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${q(role)}`);
    for (const [table, privs] of Object.entries(manifest.tables)) {
      if (privs.length) await client.query(`GRANT ${privs.join(", ")} ON TABLE ${schema}.${q(table)} TO ${q(role)}`);
    }
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${q(role)}`);
    const fns = await client.query<{ sig: string; name: string }>(
      `SELECT p.proname AS name, p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prorettype <> 'trigger'::regtype`, [manifest.schema]);
    for (const f of fns.rows) if (manifest.functions_executable.includes(f.name)) await client.query(`GRANT EXECUTE ON FUNCTION ${f.sig} TO ${q(role)}`);
    await client.query("COMMIT");
    console.log(`applied runtime grants to role ${role}: ${Object.values(manifest.tables).filter((p) => p.length).length} tables, ${manifest.functions_executable.length} functions`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
