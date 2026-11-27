import { join } from "node:path";
import pg from "pg";
import { assertMigrationTarget } from "../apps/api/src/db-safety.js";
import { buildPoolConfig, selectMigrationUrl, stderrWarning } from "../apps/api/src/db-config.js";
import { assertRoleName, loadManifest, manifestCatalogProblems, readOnlyMembershipsFromEnv, readOnlyRoleProblems } from "../apps/api/src/db-roles.js";

/**
 * Applies db/runtime-grants.json to an EXISTING login role, as the owner/migration role (DIRECT_DATABASE_URL).
 * It creates no role and changes no password: role creation is a separate, explicit operator step (docs/db-roles.md).
 * Idempotent: it first revokes everything the role holds in the schema, then grants exactly the manifest.
 *
 * R1 options (all explicit, all reported):
 * - RUNTIME_ROLE_READONLY_MEMBERSHIPS=reader: tolerate membership in these roles ONLY after proving them read-only (Fly Managed
 *   Postgres users are always members of a provider role; `reader` is pg_read_all_data). Any other membership is still refused.
 * - RUNTIME_GRANTS_ALLOW_ABSENT=true: manifest tables and functions that do not exist in this database (their migration is not
 *   applied, e.g. 0008 in production) are listed and skipped. A table or function that exists but is NOT in the manifest still fails.
 * - RUNTIME_GRANTS_DRY_RUN=true: do everything inside the transaction, print the privilege changes, then ROLL BACK.
 */
const allowedMemberships = readOnlyMembershipsFromEnv(process.env);
const allowAbsent = process.env.RUNTIME_GRANTS_ALLOW_ABSENT === "true";
const dryRun = process.env.RUNTIME_GRANTS_DRY_RUN === "true";
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
    const all = await manifestCatalogProblems(client, manifest);
    const absent = all.filter((p) => /^manifest names (table|function) \S+ which does not exist$/.test(p));
    const problems = allowAbsent ? all.filter((p) => !absent.includes(p)) : all;
    if (problems.length) throw new Error(`grants manifest does not match the database:\n - ${problems.join("\n - ")}`);
    if (absent.length) console.log(`skipped (not present in this database; RUNTIME_GRANTS_ALLOW_ABSENT=true):\n - ${absent.join("\n - ")}`);
    const existingTables = new Set((await client.query<{ t: string }>("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1", [manifest.schema])).rows.map((r) => r.t));
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
    const notAllowed = memberOf.filter((m) => !allowedMemberships.includes(m));
    if (notAllowed.length) throw new Error(`role ${role} is a member of ${notAllowed.join(", ")}; membership can carry privileges this script cannot revoke`);
    const privsOf = async () => (await client.query<{ t: string; p: string }>(
      `SELECT c.relname AS t, p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) p
        WHERE n.nspname = $2 AND c.relkind IN ('r','p','v','m') AND has_table_privilege($1, c.oid, p) ORDER BY 1, 2`, [role, manifest.schema])).rows.map((r) => `${r.t}:${r.p}`);
    const before = await privsOf();
    const schema = q(manifest.schema);
    await client.query("BEGIN");
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${q(role)}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${q(role)}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${q(role)}`);
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${q(role)}`);
    // Defaults that would otherwise leak authority to every role: no CREATE in the schema, and functions are not callable by default.
    await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
    // Application objects only: objects that belong to an extension (pgcrypto's functions, a provider's monitoring view such as
    // pg_stat_monitor on Fly Managed Postgres) are the extension's, not ours, and are left exactly as they are.
    const appRels = await client.query<{ n: string; k: string }>(
      `SELECT c.relname AS n, c.relkind AS k FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = $1 AND c.relkind IN ('r','p','v','m','S') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`, [manifest.schema]);
    for (const r of appRels.rows) await client.query(`REVOKE ALL ON ${r.k === "S" ? "SEQUENCE" : "TABLE"} ${schema}.${q(r.n)} FROM PUBLIC`);
    const appFns = await client.query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`, [manifest.schema]);
    for (const f of appFns.rows) await client.query(`REVOKE ALL ON FUNCTION ${f.sig} FROM PUBLIC`);
    // Temp tables are searched BEFORE the schema for unqualified relation names: with TEMP available, a session could shadow
    // research_blobs, repo_snapshots, ... and make the guard functions validate forged data. Remove the privilege, and pin the
    // search_path of every application function (below) so shadowing fails even if TEMP is later granted back.
    await client.query(`REVOKE TEMPORARY ON DATABASE ${q(dbName)} FROM PUBLIC`);
    await client.query(`REVOKE TEMPORARY, CREATE ON DATABASE ${q(dbName)} FROM ${q(role)}`);
    // Memberships are verified on the state this transaction leaves (after the PUBLIC revocations above); failure rolls everything back.
    for (const m of memberOf) {
      const p = await readOnlyRoleProblems(client, m, manifest.schema);
      if (p.length) throw new Error(`role ${role} is a member of ${m}, which is not read-only: ${p.join("; ")}`);
      console.log(`membership ${m} tolerated: verified read-only (inherits only pg_read_all_data or nothing; no write, create, temp or ownership)`);
    }
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${q(role)}`);
    for (const [table, privs] of Object.entries(manifest.tables)) {
      if (privs.length && existingTables.has(table)) await client.query(`GRANT ${privs.join(", ")} ON TABLE ${schema}.${q(table)} TO ${q(role)}`);
    }
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${q(role)}`);
    const fns = await client.query<{ sig: string; name: string }>(
      `SELECT p.proname AS name, p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prorettype <> 'trigger'::regtype`, [manifest.schema]);
    for (const f of fns.rows) if (manifest.functions_executable.includes(f.name)) await client.query(`GRANT EXECUTE ON FUNCTION ${f.sig} TO ${q(role)}`);
    const allFns = await client.query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`, [manifest.schema]);
    for (const f of allFns.rows) await client.query(`ALTER FUNCTION ${f.sig} SET search_path = ${schema}, pg_temp`);
    const after = await privsOf();
    const added = after.filter((x) => !before.includes(x)); const removed = before.filter((x) => !after.includes(x));
    console.log(`effective privileges of ${role}: ${before.length} before, ${after.length} after; added ${added.length}, removed ${removed.length}`);
    if (process.env.RUNTIME_GRANTS_VERBOSE === "true" || dryRun) { for (const x of added) console.log(`  + ${x}`); for (const x of removed) console.log(`  - ${x}`); }
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    if (dryRun) console.log("DRY RUN: rolled back; nothing was changed");
    const stillTemp = (await client.query<{ h: boolean }>("SELECT has_database_privilege($1, current_database(), 'TEMP') AS h", [role])).rows[0]!.h;
    if (stillTemp) console.error(`WARNING: ${role} still has TEMPORARY on the database (this user may not own the database); the pinned search_path is the remaining defence, and the startup role check will report it`);
    if (!dryRun) console.log(`applied runtime grants to role ${role}: ${Object.values(manifest.tables).filter((p) => p.length).length} tables, ${manifest.functions_executable.length} functions`);
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
