/**
 * Fail-closed checks on database targets, run BEFORE any connection is attempted.
 * Error messages name the host only and never include credentials.
 */
export class UnsafeDatabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDatabaseTargetError";
  }
}

export type DatabaseTarget = { host: string; port: string; database: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// pg would let these override or replace the host in the URL.
const HOST_OVERRIDE_PARAMS = ["host", "hostaddr", "service"];
export const TEST_DATABASE_NAME = /^agentsmith_test_[a-f0-9]{12}$/;

export function parseDatabaseTarget(raw: string | undefined): DatabaseTarget {
  if (!raw || !raw.trim()) throw new UnsafeDatabaseTargetError("A database URL is required; refusing to fall back to ambient PG* settings");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeDatabaseTargetError("Database URL is not parseable; refusing to connect");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new UnsafeDatabaseTargetError("Database URL must use the postgres:// or postgresql:// scheme");
  }
  if (!url.hostname) {
    throw new UnsafeDatabaseTargetError("Database URL has no host; refusing to fall back to PGHOST or a unix socket");
  }
  for (const key of HOST_OVERRIDE_PARAMS) {
    if (url.searchParams.has(key)) {
      throw new UnsafeDatabaseTargetError(`Database URL parameter "${key}" could override the host; refusing`);
    }
  }
  return { host: url.hostname.toLowerCase(), port: url.port, database: decodeURIComponent(url.pathname.replace(/^\//, "")) };
}

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host.toLowerCase());

/** Only a loopback host is acceptable. Hosted, internal, private-network and unknown hosts are refused. */
export function assertLoopbackDatabaseUrl(raw: string | undefined): DatabaseTarget {
  const target = parseDatabaseTarget(raw);
  if (!isLoopbackHost(target.host)) {
    throw new UnsafeDatabaseTargetError(`Refusing non-loopback database host "${target.host}"; disposable databases must be local`);
  }
  return target;
}

/** A per-run test database: loopback host and an agentsmith_test_<12 hex> name. */
export function assertDisposableTestDatabaseUrl(raw: string | undefined): DatabaseTarget {
  const target = assertLoopbackDatabaseUrl(raw);
  if (!TEST_DATABASE_NAME.test(target.database)) {
    throw new UnsafeDatabaseTargetError(`Refusing database "${target.database}": test databases must be named agentsmith_test_<12 hex chars>`);
  }
  return target;
}

/**
 * Migration entry point. Loopback targets are allowed. Any other host needs
 * MIGRATE_CONFIRM_REMOTE_HOST to equal the URL's host exactly, so a remote
 * migration is always a deliberate act. This is a guard against mistakes, not
 * a substitute for the approval policy.
 */
export function assertMigrationTarget(raw: string | undefined, confirmRemoteHost: string | undefined): DatabaseTarget {
  const target = parseDatabaseTarget(raw);
  if (isLoopbackHost(target.host)) return target;
  if (confirmRemoteHost && confirmRemoteHost.toLowerCase() === target.host) return target;
  throw new UnsafeDatabaseTargetError(
    `Refusing to migrate non-loopback host "${target.host}": set MIGRATE_CONFIRM_REMOTE_HOST to that exact host to confirm`,
  );
}
