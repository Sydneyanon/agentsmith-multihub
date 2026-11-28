-- Rollback of 0015_worker_api.sql (roll back 0016 first). Removes ONLY what 0015 created; no 0001-0014 object or row is touched
-- (tested: the catalog and the data fingerprint of every pre-existing table equal those before 0015). It discards the worker-API
-- records themselves (tokens, idempotency records, usage, the upload index, evaluation keys, provenance, snapshot verifications):
-- export them first if they must be kept. The research records those requests created (snapshots, blobs, hypotheses, evaluations)
-- stay, as 0007 rows.
BEGIN;
DROP TRIGGER hypothesis_evaluations_record_key ON hypothesis_evaluations;
DROP FUNCTION hypothesis_evaluations_record_key();
DROP TABLE snapshot_verifications;
DROP FUNCTION snapshot_verifications_guard();
DROP TABLE evaluation_provenance;
DROP FUNCTION evaluation_provenance_guard();
DROP TABLE hypothesis_evaluation_keys;
DROP TABLE worker_blob_uploads;
DROP TABLE worker_token_usage;
DROP FUNCTION worker_token_usage_guard();
DROP TABLE worker_api_requests;
DROP TABLE worker_capability_tokens;
DROP FUNCTION worker_capability_tokens_guard();
DELETE FROM schema_migrations WHERE name = '0015_worker_api.sql';
COMMIT;
