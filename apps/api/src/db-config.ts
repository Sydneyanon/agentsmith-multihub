import type { PoolConfig } from "pg";
import { isLoopbackHost, parseDatabaseTarget } from "./db-safety.js";

type Env = Record<string, string | undefined>;

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
export function buildPoolConfig(env: Env, options: { max: number; defaultConnectTimeoutMs?: number }): PoolConfig {
  const target = parseDatabaseTarget(env.DATABASE_URL);
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
  return {
    connectionString: env.DATABASE_URL!,
    max: options.max,
    connectionTimeoutMillis: timeout,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 600,
    ...(useTls ? { ssl: { rejectUnauthorized: verify !== "false" } } : {}),
  };
}
