import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { REPOSITORY_RESEARCH_WORKFLOW } from "./acquisition/step.js";

/**
 * Option D: run-scoped worker capability tokens (migration 0015, db/migrations/0015_worker_api.sql).
 *
 * Shape: `wct1_<token id, 32 hex>_<secret, 43 base64url chars = 256 random bits>`. The id is not secret (it is what audit records and
 * operators name); only SHA-256(secret) is stored. A token is bound to exactly one workflow run, expires, can be revoked, and is
 * refused whenever its run is no longer queued or running. The token itself is never written to a log, an error, an audit record or a
 * response other than the single mint response.
 */
export const WORKER_TOKEN_PATTERN = /^wct1_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
const TOKEN_ANYWHERE = /wct1_[0-9a-f]{32}_[A-Za-z0-9_-]{20,}/g;
export const DEFAULT_TOKEN_TTL_SECONDS = 24 * 3600;
export const MAX_TOKEN_TTL_SECONDS = 7 * 24 * 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const toUuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

export function parseWorkerToken(raw: string | undefined): { tokenId: string; secret: string } | null {
  const m = raw ? WORKER_TOKEN_PATTERN.exec(raw) : null;
  return m ? { tokenId: toUuid(m[1]!), secret: m[2]! } : null;
}

/** Replaces anything token-shaped. Applied to every error message the worker logs and every message the API returns or audits. */
export function redactWorkerTokens(text: string): string {
  return text.replace(TOKEN_ANYWHERE, "wct1_[redacted]");
}

export function secretMatches(secret: string, storedSha256: string): boolean {
  const a = Buffer.from(sha256Hex(secret), "hex"); const b = Buffer.from(storedSha256, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type MintedWorkerToken = { token: string; tokenId: string; runId: string; expiresAt: string };

/** Operator action on the owner connection. The run must be a queued or running repository_research run. */
export async function mintWorkerToken(pool: Pick<Pool, "query">, input: { runId: string; createdBy: string; ttlSeconds?: number }): Promise<MintedWorkerToken> {
  if (!UUID.test(input.runId)) throw new WorkerTokenError("invalid_run", "the run id must be a UUID");
  const ttl = input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_TOKEN_TTL_SECONDS) throw new WorkerTokenError("invalid_ttl", `the lifetime must be between 60 and ${MAX_TOKEN_TTL_SECONDS} seconds`);
  if (!input.createdBy.trim() || input.createdBy.length > 200) throw new WorkerTokenError("invalid_actor", "the minting operator must be named");
  const run = (await pool.query<{ status: string; workflow_type: string; correlation_id: string }>(
    "SELECT status, workflow_type, correlation_id FROM workflow_runs WHERE id = $1", [input.runId])).rows[0];
  if (!run) throw new WorkerTokenError("run_not_found", "the run does not exist");
  if (run.workflow_type !== REPOSITORY_RESEARCH_WORKFLOW) throw new WorkerTokenError("run_not_eligible", "worker tokens are issued for repository_research runs only");
  if (!["queued", "running"].includes(run.status)) throw new WorkerTokenError("run_terminal", "the run is already finished");
  const secret = randomBytes(32).toString("base64url");
  const row = (await pool.query<{ id: string; expires_at: Date }>(
    `WITH t AS (
       INSERT INTO worker_capability_tokens (workflow_run_id, secret_sha256, created_by, expires_at)
       VALUES ($1::uuid, $2, $3, now() + ($4::int * interval '1 second')) RETURNING id, workflow_run_id, expires_at)
     , a AS (
       INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason, payload)
       SELECT $3, 'worker_token.minted', 'workflow_run', t.workflow_run_id::text, $5::uuid, 'Run-scoped worker capability token issued (the token is not recorded)',
              jsonb_build_object('token_id', t.id, 'expires_at', t.expires_at) FROM t)
     SELECT id, expires_at FROM t`,
    [input.runId, sha256Hex(secret), input.createdBy, ttl, run.correlation_id])).rows[0]!;
  return { token: `wct1_${row.id.replace(/-/g, "")}_${secret}`, tokenId: row.id, runId: input.runId, expiresAt: row.expires_at.toISOString() };
}

export async function revokeWorkerToken(pool: Pick<Pool, "query">, input: { tokenId: string; revokedBy: string; reason?: string }): Promise<{ revoked: boolean }> {
  if (!UUID.test(input.tokenId)) throw new WorkerTokenError("invalid_token_id", "the token id must be a UUID");
  const result = await pool.query<{ workflow_run_id: string }>(
    `WITH t AS (
       UPDATE worker_capability_tokens SET revoked_at = now(), revoked_by = $2, revoke_reason = $3
       WHERE id = $1 AND revoked_at IS NULL RETURNING id, workflow_run_id)
     , a AS (
       INSERT INTO audit_events (actor, action, entity_type, entity_id, reason, payload)
       SELECT $2, 'worker_token.revoked', 'workflow_run', t.workflow_run_id::text, $3, jsonb_build_object('token_id', t.id) FROM t)
     SELECT workflow_run_id FROM t`,
    [input.tokenId, input.revokedBy, input.reason?.slice(0, 500) ?? null]);
  return { revoked: (result.rowCount ?? 0) > 0 };
}

export class WorkerTokenError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorkerTokenError"; }
}
