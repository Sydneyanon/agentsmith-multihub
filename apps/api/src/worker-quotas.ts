import type { Pool } from "pg";

/**
 * Option D, D4: per-token quotas, kept durably in worker_token_usage (0015), so they hold across API restarts and processes. Every
 * reservation is ONE atomic statement that adds the amount only if the result stays within the limit, so racing requests cannot
 * overshoot it. Stored bytes and blob counts are reserved inside the request's transaction (rolled back with it); reads and processing
 * time are charged when the work is done. A refusal is 413 (storage) or 429 (reads, processing), and is audited like every refusal.
 * This is the only module that writes worker_token_usage; the counters only grow (a database trigger refuses anything else).
 */
export type WorkerQuotas = {
  /** bytes a token may store through put_blob (counted per request, duplicates included); default 256 MiB */ maxBytesStored: number;
  /** blobs a token may store; default 25 000 */ maxBlobs: number;
  /** response bytes a token may read; default 2 GiB */ maxBytesRead: number;
  /** cumulative API processing time (verification, analysis, validators) a token may cause, ms; default 10 min */ maxProcessingMs: number;
};
export const DEFAULT_QUOTAS: WorkerQuotas = { maxBytesStored: 256 * 1024 * 1024, maxBlobs: 25_000, maxBytesRead: 2 * 1024 * 1024 * 1024, maxProcessingMs: 600_000 };

export class QuotaExceeded extends Error {
  constructor(readonly status: 413 | 429, readonly code: "storage_quota_exceeded" | "read_quota_exceeded" | "processing_budget_exhausted", message: string) { super(message); this.name = "QuotaExceeded"; }
}

type Db = Pick<Pool, "query">;
const ensure = (db: Db, tokenId: string) => db.query("INSERT INTO worker_token_usage (token_id) VALUES ($1) ON CONFLICT (token_id) DO NOTHING", [tokenId]);

export async function reserveStorage(db: Db, tokenId: string, bytes: number, q: WorkerQuotas, blobs = 1): Promise<void> {
  await ensure(db, tokenId);
  const ok = (await db.query(`UPDATE worker_token_usage SET bytes_stored = bytes_stored + $2, blobs_stored = blobs_stored + $5, updated_at = now()
    WHERE token_id = $1 AND bytes_stored + $2 <= $3 AND blobs_stored + $5 <= $4`, [tokenId, bytes, q.maxBytesStored, q.maxBlobs, blobs])).rowCount;
  if (!ok) throw new QuotaExceeded(413, "storage_quota_exceeded", `this token's storage quota (${q.maxBytesStored} bytes, ${q.maxBlobs} blobs) is exhausted`);
}

export async function chargeRead(db: Db, tokenId: string, bytes: number, q: WorkerQuotas): Promise<void> {
  await ensure(db, tokenId);
  const ok = (await db.query(`UPDATE worker_token_usage SET bytes_read = bytes_read + $2, updated_at = now() WHERE token_id = $1 AND bytes_read + $2 <= $3`, [tokenId, bytes, q.maxBytesRead])).rowCount;
  if (!ok) throw new QuotaExceeded(429, "read_quota_exceeded", `this token's read quota (${q.maxBytesRead} bytes) is exhausted`);
}

/** Refuses before expensive work when the token's processing budget is already spent. */
export async function assertProcessingBudget(db: Db, tokenId: string, q: WorkerQuotas): Promise<void> {
  await ensure(db, tokenId);
  const used = Number((await db.query<{ ms: string }>("SELECT processing_ms AS ms FROM worker_token_usage WHERE token_id = $1", [tokenId])).rows[0]?.ms ?? 0);
  if (used >= q.maxProcessingMs) throw new QuotaExceeded(429, "processing_budget_exhausted", `this token's processing budget (${q.maxProcessingMs} ms of API time) is spent`);
}

/** Charges processing time actually spent (also when the work failed or hit a limit). Never refuses: the work already happened. */
export async function chargeProcessing(db: Db, tokenId: string, ms: number): Promise<void> {
  await ensure(db, tokenId);
  await db.query("UPDATE worker_token_usage SET processing_ms = processing_ms + $2, updated_at = now() WHERE token_id = $1", [tokenId, Math.max(0, Math.round(ms))]);
}
