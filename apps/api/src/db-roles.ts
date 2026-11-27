import { readFileSync } from "node:fs";
import pg from "pg";

export type GrantsManifest = {
  schema: string;
  tables: Record<string, string[]>; // tables and views
  _notes?: Record<string, string>;
  functions_executable: string[];
  functions_denied: string[];
  sequences_usable: "all";
};

export const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const ROLE_NAME = /^[a-z_][a-z0-9_]{2,62}$/;

export function loadManifest(path: string): GrantsManifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as GrantsManifest;
  for (const [table, privs] of Object.entries(m.tables)) {
    for (const p of privs) if (!(TABLE_PRIVILEGES as readonly string[]).includes(p)) throw new Error(`manifest: ${table} has unknown privilege ${p}`);
    // The runtime role may never be able to rewrite history, bypass triggers or change structure.
    for (const forbidden of ["DELETE", "TRUNCATE", "TRIGGER", "REFERENCES"]) {
      if (privs.includes(forbidden)) throw new Error(`manifest: ${table} grants ${forbidden}, which the runtime role must never hold`);
    }
  }
  return m;
}

export function assertRoleName(name: string | undefined): string {
  if (!name || !ROLE_NAME.test(name)) throw new Error("RUNTIME_ROLE must be a lower-case identifier (letters, digits, underscore; 3-63 chars)");
  return name;
}

/** Compares the manifest with the live catalog. Returns problems; empty means every table and function is accounted for. */
export async function manifestCatalogProblems(db: pg.Pool | pg.PoolClient, m: GrantsManifest): Promise<string[]> {
  const problems: string[] = [];
  // Relations that belong to an extension (e.g. pg_stat_monitor on Fly Managed Postgres) are not the application's and not in the manifest.
  const tables = (await db.query<{ t: string }>("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')", [m.schema])).rows.map((r) => r.t);
  for (const t of tables) if (!(t in m.tables)) problems.push(`table ${t} is not in the grants manifest`);
  for (const t of Object.keys(m.tables)) if (!tables.includes(t)) problems.push(`manifest names table ${t} which does not exist`);
  const fns = (await db.query<{ f: string }>(
    `SELECT DISTINCT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prorettype <> 'trigger'::regtype AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`, [m.schema])).rows.map((r) => r.f);
  const listed = new Set([...m.functions_executable, ...m.functions_denied]);
  for (const f of fns) if (!listed.has(f)) problems.push(`function ${f} is neither in functions_executable nor functions_denied`);
  for (const f of listed) if (!fns.includes(f)) problems.push(`manifest names function ${f} which does not exist`);
  return problems;
}

export type RoleAssessment = { ok: boolean; problems: string[] };

/**
 * R1 on Fly Managed Postgres: users can only be created by the provider, and every user is a member of exactly one provider role
 * (schema_admin, writer or reader). `reader` is pg_read_all_data: SELECT only. A membership is tolerated ONLY when it is named in
 * RUNTIME_ROLE_READONLY_MEMBERSHIPS and this check proves the role, with everything it inherits, cannot write, own, create or
 * bypass anything. `writer` (pg_write_all_data: INSERT/UPDATE/DELETE on every table) always fails it.
 */
export const ALLOWED_PREDEFINED_READ_ROLES = ["pg_read_all_data"] as const;
export function readOnlyMembershipsFromEnv(env: Record<string, string | undefined>): string[] {
  const raw = env.RUNTIME_ROLE_READONLY_MEMBERSHIPS?.trim();
  if (!raw) return [];
  return raw.split(",").map((r) => assertRoleName(r.trim()));
}

export async function readOnlyRoleProblems(db: pg.Pool | pg.PoolClient, role: string, schema = "public"): Promise<string[]> {
  const problems: string[] = [];
  const a = (await db.query<Record<string, boolean>>("SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1", [role])).rows[0];
  if (!a) return [`membership role ${role} does not exist`];
  for (const [flag, label] of [["rolsuper", "superuser"], ["rolcreaterole", "CREATEROLE"], ["rolcreatedb", "CREATEDB"], ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"]] as const) {
    if (a[flag]) problems.push(`membership role ${role} has ${label}`);
  }
  // Everything the role inherits, transitively. Only the predefined read-all role may appear.
  const inherited = (await db.query<{ r: string }>(
    `WITH RECURSIVE up(oid) AS (SELECT m.roleid FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1)
       UNION SELECT m.roleid FROM pg_auth_members m JOIN up ON m.member = up.oid)
     SELECT r.rolname AS r FROM up JOIN pg_roles r ON r.oid = up.oid ORDER BY 1`, [role])).rows.map((x) => x.r);
  for (const r of inherited) if (!(ALLOWED_PREDEFINED_READ_ROLES as readonly string[]).includes(r)) problems.push(`membership role ${role} inherits ${r}`);
  const writes = (await db.query<{ t: string; p: string }>(
    `SELECT c.relname AS t, p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) p
      WHERE n.nspname = $2 AND c.relkind IN ('r','p','v','m') AND has_table_privilege($1, c.oid, p)`, [role, schema])).rows;
  if (writes.length) problems.push(`membership role ${role} can ${[...new Set(writes.map((w) => w.p))].join("/")} on ${new Set(writes.map((w) => w.t)).size} relation(s)`);
  const owned = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE pg_get_userbyid(relowner) = $1", [role])).rows[0]!.n;
  if (owned) problems.push(`membership role ${role} owns ${owned} relation(s)`);
  const ddl = (await db.query<{ c: boolean; t: boolean }>("SELECT has_schema_privilege($1, $2, 'CREATE') AS c, has_database_privilege($1, current_database(), 'TEMP') AS t", [role, schema])).rows[0]!;
  if (ddl.c) problems.push(`membership role ${role} can CREATE in schema ${schema}`);
  if (ddl.t) problems.push(`membership role ${role} can create TEMPORARY tables`);
  return problems;
}

/** What the connected role can do that a runtime role must not. Used at startup and in the grants script. */
export async function assessConnectedRole(db: pg.Pool | pg.PoolClient, schema = "public", allowedReadOnlyMemberships: readonly string[] = []): Promise<RoleAssessment> {
  const problems: string[] = [];
  const attrs = (await db.query<Record<string, boolean | string>>(
    "SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0];
  if (!attrs) return { ok: false, problems: ["current role not found in pg_roles"] };
  for (const [flag, label] of [["rolsuper", "superuser"], ["rolcreaterole", "CREATEROLE"], ["rolcreatedb", "CREATEDB"], ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"]] as const) {
    if (attrs[flag]) problems.push(`role ${String(attrs.name)} has ${label}`);
  }
  const owned = (await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND pg_get_userbyid(c.relowner) = current_user", [schema])).rows[0]!.n;
  if (owned > 0) problems.push(`role owns ${owned} relation(s) in schema ${schema} (an owner can disable triggers and drop tables)`);
  const canCreate = (await db.query<{ c: boolean }>("SELECT has_schema_privilege(current_user, $1, 'CREATE') AS c", [schema])).rows[0]!.c;
  if (canCreate) problems.push(`role can CREATE objects in schema ${schema}`);
  const temp = (await db.query<{ h: boolean }>("SELECT has_database_privilege(current_user, current_database(), 'TEMP') AS h")).rows[0]!.h;
  // A temp table named like a real one is searched first by unqualified names: it can feed forged data to the guard functions.
  if (temp) problems.push("role can create TEMPORARY tables (temp-schema shadowing of guard-function lookups)");
  const publicGrants = (await db.query<{ n: number }>(
    `SELECT count(DISTINCT c.oid)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace, aclexplode(c.relacl) a
      WHERE ns.nspname = $1 AND a.grantee = 0 AND c.relkind IN ('r','p','v','m','S') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`, [schema])).rows[0]!.n;
  if (publicGrants > 0) problems.push(`PUBLIC holds privileges on ${publicGrants} relation(s) in schema ${schema}`);
  const members = (await db.query<{ r: string }>(
    "SELECT r.rolname AS r FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)")).rows;
  const unexpected = members.filter((x) => !allowedReadOnlyMemberships.includes(x.r));
  if (unexpected.length) problems.push(`role is a member of: ${unexpected.map((x) => x.r).join(", ")}`);
  for (const m of members.filter((x) => allowedReadOnlyMemberships.includes(x.r))) problems.push(...await readOnlyRoleProblems(db, m.r, schema));
  // Belt and braces: whatever the path (direct grant, membership, PUBLIC), the runtime role must not hold these on any relation.
  const forbidden = (await db.query<{ p: string; n: number }>(
    `SELECT p, count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace, unnest(ARRAY['DELETE','TRUNCATE','TRIGGER','REFERENCES']) p
      WHERE ns.nspname = $1 AND c.relkind IN ('r','p','v','m') AND has_table_privilege(current_user, c.oid, p) GROUP BY p`, [schema])).rows;
  for (const f of forbidden) problems.push(`role holds ${f.p} on ${f.n} relation(s)`);
  return { ok: problems.length === 0, problems };
}

/**
 * Startup guard. With `require` the process refuses to run as a role that could disable the append-only triggers; without it the
 * problem is reported loudly (staged rollout: deploy the code, switch DATABASE_URL to the runtime role, then require it).
 */
export async function enforceRuntimeRole(
  db: pg.Pool, options: { require: boolean; warn: (message: string) => void; allowedReadOnlyMemberships?: readonly string[] },
): Promise<RoleAssessment> {
  const result = await assessConnectedRole(db, "public", options.allowedReadOnlyMemberships ?? []);
  if (!result.ok) {
    const message = `database runtime role is not least-privilege: ${result.problems.join("; ")}`;
    if (options.require) throw new Error(message);
    options.warn(message);
  }
  return result;
}

/**
 * Runs after the server is already listening, so a slow, paused or unreachable database can never delay or prevent boot
 * (the app answers liveness and reports readiness honestly). A failed check is retried (a paused Managed Postgres needs time
 * to wake). A bad role is reported; it is fatal only when `require` is set, and so is a role that could never be verified.
 */
export async function runRoleGuard(db: pg.Pool, options: {
  require: boolean; warn: (message: string) => void; fatal: (message: string) => void;
  attempts?: number; retryDelayMs?: number; sleep?: (ms: number) => Promise<void>; assess?: () => Promise<RoleAssessment>; allowedReadOnlyMemberships?: readonly string[];
}): Promise<void> {
  const attempts = options.attempts ?? 6;
  const delay = options.retryDelayMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const assess = options.assess ?? (() => assessConnectedRole(db, "public", options.allowedReadOnlyMemberships ?? []));
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await assess();
      if (!result.ok) {
        const message = `database runtime role is not least-privilege: ${result.problems.join("; ")}`;
        if (options.require) options.fatal(message); else options.warn(message);
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) {
        options.warn(`database runtime role check: attempt ${attempt}/${attempts} failed (${lastError}); retrying`);
        await sleep(delay);
      }
    }
  }
  const message = `could not verify the database runtime role after ${attempts} attempts (${lastError})`;
  if (options.require) options.fatal(message); else options.warn(message);
}
