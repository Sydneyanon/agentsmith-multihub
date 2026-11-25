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
  const tables = (await db.query<{ t: string }>("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m')", [m.schema])).rows.map((r) => r.t);
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

/** What the connected role can do that a runtime role must not. Used at startup and in the grants script. */
export async function assessConnectedRole(db: pg.Pool | pg.PoolClient, schema = "public"): Promise<RoleAssessment> {
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
      WHERE ns.nspname = $1 AND a.grantee = 0 AND c.relkind IN ('r','p','v','m','S')`, [schema])).rows[0]!.n;
  if (publicGrants > 0) problems.push(`PUBLIC holds privileges on ${publicGrants} relation(s) in schema ${schema}`);
  const members = (await db.query<{ r: string }>(
    "SELECT r.rolname AS r FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)")).rows;
  if (members.length) problems.push(`role is a member of: ${members.map((x) => x.r).join(", ")}`);
  return { ok: problems.length === 0, problems };
}

/**
 * Startup guard. With `require` the process refuses to run as a role that could disable the append-only triggers; without it the
 * problem is reported loudly (staged rollout: deploy the code, switch DATABASE_URL to the runtime role, then require it).
 */
export async function enforceRuntimeRole(
  db: pg.Pool, options: { require: boolean; warn: (message: string) => void },
): Promise<RoleAssessment> {
  const result = await assessConnectedRole(db);
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
  attempts?: number; retryDelayMs?: number; sleep?: (ms: number) => Promise<void>; assess?: () => Promise<RoleAssessment>;
}): Promise<void> {
  const attempts = options.attempts ?? 6;
  const delay = options.retryDelayMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const assess = options.assess ?? (() => assessConnectedRole(db));
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
