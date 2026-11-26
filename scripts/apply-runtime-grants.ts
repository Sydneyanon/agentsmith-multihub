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
    const dbName = (await client.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
    const problems = await manifestCatalogProblems(client, manifest);
    if (problems.length) throw new Error(`grants manifest does not match the database:\n - ${problems.join("\n - ")}`);
    const r = (await client.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
      "SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1", [role])).rows[0];
    if (!r) throw new Error(`role ${role} does not exist; create it first (see docs/db-roles.md)`);
    if (r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolreplication || r.rolbypassrls) throw new Error(`role ${role} has elevated attributes; refusing to use it as the runtime role`);
    if (role.startsWith("pg_")) throw new Error(`role ${role} is a predefined PostgreSQL role (pg_*); refusing to use it as the runtime role`);
    const owned = (await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND pg_get_userbyid(c.relowner) = $2", [manifest.schema, role])).rows[0]!.n;
    if (owned > 0) throw new Error(`role ${role} owns ${owned} object(s) in ${manifest.schema}; an owner cannot be a least-privilege role`);
    const memberOf = (await client.query<{ r: string }>(
      "SELECT g.rolname AS r FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1", [role])).rows.map((x) => x.r);
    if (memberOf.length) throw new Error(`role ${role} is a member of ${memberOf.join(", ")}; membership can carry privileges this script cannot revoke`);
    const schema = q(manifest.schema);
    await client.query("BEGIN");
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${q(role)}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${q(role)}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${q(role)}`);
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${q(role)}`);
    // Defaults that would otherwise leak authority to every role: no CREATE in the schema, and functions are not callable by default.
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC`);
    // Temp tables are searched BEFORE the schema for unqualified relation names: with TEMP available, a session could shadow
    // research_blobs, repo_snapshots, ... and make the guard functions validate forged data. Remove the privilege, and pin the
    // search_path of every application function (below) so shadowing fails even if TEMP is later granted back.
    await client.query(`REVOKE TEMPORARY ON DATABASE ${q(dbName)} FROM PUBLIC`);
    await client.query(`REVOKE TEMPORARY, CREATE ON DATABASE ${q(dbName)} FROM ${q(role)}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${q(role)}`);
    for (const [table, privs] of Object.entries(manifest.tables)) {
      if (privs.length) await client.query(`GRANT ${privs.join(", ")} ON TABLE ${schema}.${q(table)} TO ${q(role)}`);
    }
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${q(role)}`);
    const fns = await client.query<{ sig: string; name: string }>(
      `SELECT p.proname AS name, p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prorettype <> 'trigger'::regtype`, [manifest.schema]);
    for (const f of fns.rows) if (manifest.functions_executable.includes(f.name)) await client.query(`GRANT EXECUTE ON FUNCTION ${f.sig} TO ${q(role)}`);
    const allFns = await client.query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`, [manifest.schema]);
    for (const f of allFns.rows) await client.query(`ALTER FUNCTION ${f.sig} SET search_path = ${schema}, pg_temp`);
    await client.query("COMMIT");
    const stillTemp = (await client.query<{ h: boolean }>("SELECT has_database_privilege($1, current_database(), 'TEMP') AS h", [role])).rows[0]!.h;
    if (stillTemp) console.error(`WARNING: ${role} still has TEMPORARY on the database (this user may not own the database); the pinned search_path is the remaining defence, and the startup role check will report it`);
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
