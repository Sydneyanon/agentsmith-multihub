import { StepError } from "../step-errors.js";
import { redactSecrets, redactValue } from "../net/github-auth.js";

export type AcquisitionErrorCode =
  | "invalid_reference" | "repository_not_found" | "repository_private" | "commit_unavailable" | "unexpected_response"
  | "repository_too_large" | "tree_truncated" | "archive_malformed" | "unsupported_tar_entry" | "limit_exceeded"
  | "archive_tree_mismatch" | "commit_mismatch" | "unrepresentable_paths" | "timeout" | "network" | "upstream_http"
  | "snapshot_conflict" | "verification_failed" | "redirect_refused" | "auth_failed" | "access_denied";

/**
 * Every acquisition failure carries a stable code. It extends StepError so the existing worker loop classifies it:
 * network trouble, timeouts, 5xx and rate limits are retryable; anything about the content is permanent.
 */
export class AcquisitionError extends StepError {
  constructor(
    readonly code: AcquisitionErrorCode,
    message: string,
    retryable = false,
    retryAfterSeconds?: number,
    readonly details: Record<string, unknown> = {},
  ) {
    // Messages and details are stored in step outputs and logged: they are redacted here, once, for every acquisition failure.
    super(redactSecrets(`${code}: ${message}`), retryable, retryAfterSeconds);
    this.details = redactValue(details);
    this.name = "AcquisitionError";
  }
}

export const isAcquisitionError = (error: unknown): error is AcquisitionError => error instanceof AcquisitionError;
