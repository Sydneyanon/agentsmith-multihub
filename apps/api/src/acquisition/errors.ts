import { StepError } from "../step-errors.js";

export type AcquisitionErrorCode =
  | "invalid_reference" | "repository_not_found" | "repository_private" | "commit_unavailable" | "unexpected_response"
  | "repository_too_large" | "tree_truncated" | "archive_malformed" | "unsupported_tar_entry" | "limit_exceeded"
  | "archive_tree_mismatch" | "commit_mismatch" | "unrepresentable_paths" | "timeout" | "network" | "upstream_http"
  | "snapshot_conflict" | "verification_failed" | "redirect_refused";

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
    super(`${code}: ${message}`, retryable, retryAfterSeconds);
    this.name = "AcquisitionError";
  }
}

export const isAcquisitionError = (error: unknown): error is AcquisitionError => error instanceof AcquisitionError;
