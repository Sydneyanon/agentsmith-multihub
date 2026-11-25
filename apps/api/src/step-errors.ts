/** Raised when a worker no longer owns a step's lease. The step is recovered by lease expiry, never failed by this worker. */
export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseLostError";
  }
}

/** An error whose retry semantics are known at the throw site. */
export class StepError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "StepError";
  }
}

export type FailureClass =
  | { kind: "lease_lost" }
  | { kind: "retryable"; category: string; retryAfterSeconds?: number }
  | { kind: "permanent"; category: string };

const MAX_RETRY_AFTER_SECONDS = 300;

/**
 * Build an error for a non-OK HTTP response. Server errors, timeouts and rate
 * limits are retryable; everything else (including a plain 403/404) is permanent.
 */
export function httpStatusError(label: string, response: Pick<Response, "status" | "headers">, detail = ""): StepError {
  const status = response.status;
  const retryAfter = Number(response.headers.get("retry-after") ?? 0);
  const rateLimitExhausted = response.headers.get("x-ratelimit-remaining") === "0";
  const resetEpoch = Number(response.headers.get("x-ratelimit-reset") ?? 0);
  const resetSeconds = rateLimitExhausted && resetEpoch > 0
    ? Math.max(0, Math.ceil(resetEpoch - Date.now() / 1000)) : 0;
  const waitSeconds = Math.min(Math.max(retryAfter > 0 ? retryAfter : 0, resetSeconds), MAX_RETRY_AFTER_SECONDS);
  const retryable = status === 408 || status === 429 || status >= 500 ||
    (status === 403 && (retryAfter > 0 || rateLimitExhausted));
  const message = `${label} returned HTTP ${status}${detail}`;
  return waitSeconds > 0 ? new StepError(message, retryable, waitSeconds) : new StepError(message, retryable);
}

const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
// pg SQLSTATE: 08 connection exception, 57P01-03 server shutdown, 53300 too many
// connections, 40001 serialization failure, 40P01 deadlock.
const TRANSIENT_SQLSTATE = /^(08|57P0[123]|53300|40001|40P01)/;
const TRANSIENT_DB_MESSAGE = /connection terminated|timeout exceeded when trying to connect|connection error|server closed the connection/i;

function codeOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string"
    ? (value as { code: string }).code : undefined;
}

/** Classify a thrown value. Anything not positively known to be transient fails closed as permanent. */
export function classifyStepError(error: unknown): FailureClass {
  if (error instanceof LeaseLostError) return { kind: "lease_lost" };
  if (error instanceof StepError) {
    return error.retryable
      ? (error.retryAfterSeconds !== undefined
        ? { kind: "retryable", category: "upstream_http", retryAfterSeconds: error.retryAfterSeconds }
        : { kind: "retryable", category: "upstream_http" })
      : { kind: "permanent", category: "upstream_http" };
  }
  const code = codeOf(error);
  const causeCode = error instanceof Error ? codeOf(error.cause) : undefined;
  if (code && TRANSIENT_SQLSTATE.test(code)) return { kind: "retryable", category: "database_transient" };
  if (error instanceof Error && TRANSIENT_DB_MESSAGE.test(error.message)) {
    return { kind: "retryable", category: "database_transient" };
  }
  if ((code && NETWORK_CODES.has(code)) || (causeCode && NETWORK_CODES.has(causeCode))) {
    return { kind: "retryable", category: "network" };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { kind: "retryable", category: "timeout" };
  }
  if (error instanceof TypeError && error.message === "fetch failed") {
    return { kind: "retryable", category: "network" };
  }
  return { kind: "permanent", category: "unclassified" };
}
