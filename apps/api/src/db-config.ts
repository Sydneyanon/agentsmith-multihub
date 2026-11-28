import type { PoolConfig } from "pg";
import { isLoopbackHost, parseDatabaseTarget } from "./db-safety.js";

type Env = Record<string, string | undefined>;
export type UrlVariable = "DATABASE_URL" | "DIRECT_DATABASE_URL" | "WORKER_DATABASE_URL";

const MIN_CONNECT_TIMEOUT_MS = 1_000;
const MAX_CONNECT_TIMEOUT_MS = 60_000;

/**
 * Pool settings shared by the API, the worker and the migration runner.
 *
 * - Connect timeout: DATABASE_CONNECT_TIMEOUT_MS (default 3000). A database that
 *   auto-pauses (Fly Managed Postgres Developer plan) needs at least 30000.
 * - TLS: on for production and for any non-loopback host, with certificate
 *   verification unless DATABASE_SSL_VERIFY is exactly "false". Loopback
 *   development databases use no TLS.
 * - Connections are recycled after 10 minutes (before a proxy's drain timeout).
 */
export function buildPoolConfig(env: Env, options: {
  max: number;
  defaultConnectTimeoutMs?: number;
  /** Which variable holds the URL. Never falls back to the other one. Default DATABASE_URL. */
  urlVariable?: UrlVariable;
  /** Called when a security-reducing setting is in effect. */
  onWarning?: (message: string) => void;
  /** The session name other sessions can see in pg_stat_activity (Control Room worker presence). Never carries a secret. */
  applicationName?: string;
}): PoolConfig {
  const urlVariable = options.urlVariable ?? "DATABASE_URL";
  const url = env[urlVariable];
  const target = parseDatabaseTarget(url);
  const rawTimeout = env.DATABASE_CONNECT_TIMEOUT_MS;
  const timeout = rawTimeout === undefined || rawTimeout === "" ? (options.defaultConnectTimeoutMs ?? 3_000) : Number(rawTimeout);
  if (!Number.isInteger(timeout) || timeout < MIN_CONNECT_TIMEOUT_MS || timeout > MAX_CONNECT_TIMEOUT_MS) {
    throw new Error(`DATABASE_CONNECT_TIMEOUT_MS must be an integer between ${MIN_CONNECT_TIMEOUT_MS} and ${MAX_CONNECT_TIMEOUT_MS}`);
  }
  const verify = env.DATABASE_SSL_VERIFY;
  if (verify !== undefined && verify !== "" && verify !== "true" && verify !== "false") {
    throw new Error('DATABASE_SSL_VERIFY must be "true" or "false"');
  }
  const useTls = env.NODE_ENV === "production" || !isLoopbackHost(target.host);
  if (useTls && verify === "false") {
    options.onWarning?.(`DATABASE_SSL_VERIFY=false: TLS certificate verification is DISABLED for ${urlVariable} (host ${target.host}). This is a last-resort override.`);
  }
  return {
    connectionString: url!,
    max: options.max,
    connectionTimeoutMillis: timeout,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 600,
    ...(options.applicationName ? { application_name: options.applicationName } : {}),
    ...(useTls ? { ssl: { rejectUnauthorized: verify !== "false" } } : {}),
  };
}

/**
 * The migration runner's URL. It must be DIRECT_DATABASE_URL: migrations use
 * session-level features (advisory locks) that a pooler can break, and the
 * application URL must never be used for schema changes by accident.
 * There is deliberately no fallback to DATABASE_URL.
 */
export function selectMigrationUrl(env: Env): string {
  const direct = env.DIRECT_DATABASE_URL;
  if (!direct || !direct.trim()) {
    throw new Error("DIRECT_DATABASE_URL is required to run migrations; DATABASE_URL is intentionally not used as a fallback");
  }
  return direct;
}

/** Structured warning line on stderr, for callers that have no logger yet. */
export const stderrWarning = (message: string): void => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: "warn", message })}\n`);
};
