-- 0015: option D, the research worker holds NO database credential and reaches the database only through the API's internal,
-- run-scoped worker routes (apps/api/src/worker-api.ts). Promoted from db/drafts/d-worker-api with the fixes D1-D7
-- (docs/security/worker-architecture-decision.md). Expand-only: new tables, one new trigger on hypothesis_evaluations (0007); nothing
-- existing is altered, renamed, dropped or rewritten. Excluded from the production image until the owner approves the release.
-- Rollback: db/rollbacks/0015_worker_api.rollback.sql (outside db/migrations, so the runner never applies it).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Run-scoped capability tokens (only the SHA-256 of the secret is stored) and the idempotency record of state-changing calls.
-- Neither is a research record; both are written by the API's owner connection only.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE worker_capability_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  secret_sha256 text NOT NULL UNIQUE CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text CHECK (revoked_by IS NULL OR length(revoked_by) BETWEEN 1 AND 200),
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500),
  last_used_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX worker_capability_tokens_run_idx ON worker_capability_tokens (workflow_run_id);

-- Identity, run binding, hash and expiry never change; a revocation is set once and never cleared; nothing is deleted.
CREATE FUNCTION worker_capability_tokens_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'worker_capability_tokens are never deleted; revoke instead'; END IF;
  IF NEW.id <> OLD.id OR NEW.workflow_run_id <> OLD.workflow_run_id OR NEW.secret_sha256 <> OLD.secret_sha256
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'a worker capability token''s identity, run, secret hash and expiry are immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'a revoked worker capability token stays revoked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worker_capability_tokens_guard BEFORE UPDATE OR DELETE ON worker_capability_tokens
  FOR EACH ROW EXECUTE FUNCTION worker_capability_tokens_guard();

-- One row per accepted state-changing call, in the SAME transaction as its effect: a retry with the same key returns the stored answer.
CREATE TABLE worker_api_requests (
  token_id uuid NOT NULL REFERENCES worker_capability_tokens(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation ~ '^[a-z_]{1,40}$'),
  step_id uuid REFERENCES workflow_steps(id),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, idempotency_key)
);
CREATE TRIGGER worker_api_requests_append_only BEFORE UPDATE OR DELETE ON worker_api_requests
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- D4: per-token usage, the API's quota ledger (bytes stored, blobs stored, bytes read, processing time). Counters only ever grow.
CREATE TABLE worker_token_usage (
  token_id uuid PRIMARY KEY REFERENCES worker_capability_tokens(id),
  bytes_stored bigint NOT NULL DEFAULT 0 CHECK (bytes_stored >= 0),
  blobs_stored integer NOT NULL DEFAULT 0 CHECK (blobs_stored >= 0),
  bytes_read bigint NOT NULL DEFAULT 0 CHECK (bytes_read >= 0),
  processing_ms bigint NOT NULL DEFAULT 0 CHECK (processing_ms >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION worker_token_usage_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'worker token usage is never deleted'; END IF;
  IF NEW.token_id <> OLD.token_id OR NEW.bytes_stored < OLD.bytes_stored OR NEW.blobs_stored < OLD.blobs_stored
     OR NEW.bytes_read < OLD.bytes_read OR NEW.processing_ms < OLD.processing_ms THEN
    RAISE EXCEPTION 'worker token usage counters only grow';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worker_token_usage_guard BEFORE UPDATE OR DELETE ON worker_token_usage FOR EACH ROW EXECUTE FUNCTION worker_token_usage_guard();

-- D4: which blobs a run's worker uploaded. A manifest row of a snapshot built through the worker API may cite only these, so a worker
-- can neither pull another run's bytes into its snapshot nor learn whether a hash is stored elsewhere (closes the existence oracle).
CREATE TABLE worker_blob_uploads (
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  content_sha256 text NOT NULL REFERENCES research_blobs(content_sha256),
  token_id uuid NOT NULL REFERENCES worker_capability_tokens(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_run_id, content_sha256)
);
CREATE TRIGGER worker_blob_uploads_append_only BEFORE UPDATE OR DELETE ON worker_blob_uploads
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- D7: evaluations are idempotent on (hypothesis, evaluator, evaluator version, input hash), for EVERY writer: an after-insert trigger
-- records the key, and its primary key refuses a second evaluation of the same key (unique_violation). ResearchStore.recordEvaluation
-- returns the existing evaluation instead of inserting. Existing rows are backfilled (earliest per key); earlier duplicates stay as history.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE hypothesis_evaluation_keys (
  hypothesis_id uuid NOT NULL,
  evaluator_id text NOT NULL,
  evaluator_version text NOT NULL,
  input_sha256 text NOT NULL,
  evaluation_id uuid NOT NULL UNIQUE REFERENCES hypothesis_evaluations(id),
  PRIMARY KEY (hypothesis_id, evaluator_id, evaluator_version, input_sha256)
);
CREATE TRIGGER hypothesis_evaluation_keys_append_only BEFORE UPDATE OR DELETE ON hypothesis_evaluation_keys
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
INSERT INTO hypothesis_evaluation_keys (hypothesis_id, evaluator_id, evaluator_version, input_sha256, evaluation_id)
SELECT DISTINCT ON (e.hypothesis_id, e.evaluator_id, e.evaluator_version, e.input_sha256) e.hypothesis_id, e.evaluator_id, e.evaluator_version, e.input_sha256, e.id
FROM hypothesis_evaluations e JOIN hypothesis_events ev ON ev.evaluation_id = e.id
ORDER BY e.hypothesis_id, e.evaluator_id, e.evaluator_version, e.input_sha256, ev.seq;

CREATE FUNCTION hypothesis_evaluations_record_key() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO hypothesis_evaluation_keys (hypothesis_id, evaluator_id, evaluator_version, input_sha256, evaluation_id)
  VALUES (NEW.hypothesis_id, NEW.evaluator_id, NEW.evaluator_version, NEW.input_sha256, NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER hypothesis_evaluations_record_key AFTER INSERT ON hypothesis_evaluations FOR EACH ROW EXECUTE FUNCTION hypothesis_evaluations_record_key();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- D1: provenance of a validator's evaluation: the validator's identity, version, analysis family and method (from the recording
-- code's registry, never from a request), the input hash, the snapshot, who ran it, and its raw output as a content-addressed blob.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE evaluation_provenance (
  evaluation_id uuid PRIMARY KEY REFERENCES hypothesis_evaluations(id),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  snapshot_id uuid NOT NULL REFERENCES repo_snapshots(id),
  recorded_by text NOT NULL CHECK (recorded_by IN ('api', 'direct-worker', 'trusted-runner')),
  validator_id text NOT NULL CHECK (length(validator_id) BETWEEN 1 AND 200),
  validator_version text NOT NULL CHECK (length(validator_version) BETWEEN 1 AND 100),
  analysis_family text NOT NULL CHECK (analysis_family ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  method text NOT NULL CHECK (method ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  output_blob_sha256 text NOT NULL REFERENCES research_blobs(content_sha256),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION evaluation_provenance_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE ev record; snap record;
BEGIN
  SELECT workflow_run_id, evaluator_id, evaluator_version, input_sha256 INTO ev FROM hypothesis_evaluations WHERE id = NEW.evaluation_id;
  IF ev.workflow_run_id IS DISTINCT FROM NEW.workflow_run_id OR ev.evaluator_id IS DISTINCT FROM NEW.validator_id
     OR ev.evaluator_version IS DISTINCT FROM NEW.validator_version OR ev.input_sha256 IS DISTINCT FROM NEW.input_sha256 THEN
    RAISE EXCEPTION 'evaluation provenance must name its evaluation''s run, validator, version and input hash' USING ERRCODE = 'check_violation';
  END IF;
  SELECT workflow_run_id INTO snap FROM repo_snapshots WHERE id = NEW.snapshot_id;
  IF snap.workflow_run_id IS DISTINCT FROM NEW.workflow_run_id THEN
    RAISE EXCEPTION 'evaluation provenance must name a snapshot of the same run' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_provenance_before_insert BEFORE INSERT ON evaluation_provenance FOR EACH ROW EXECUTE FUNCTION evaluation_provenance_guard();
CREATE TRIGGER evaluation_provenance_append_only BEFORE UPDATE OR DELETE ON evaluation_provenance FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- D2: the API's independent verification of a worker-uploaded snapshot against GitHub, recorded before sealing: the commit it resolved,
-- the tree, the counts, and the per-file results as a content-addressed blob.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE snapshot_verifications (
  snapshot_id uuid PRIMARY KEY REFERENCES repo_snapshots(id),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  verifier text NOT NULL CHECK (verifier IN ('api-github')),
  requested_ref text CHECK (requested_ref IS NULL OR length(requested_ref) BETWEEN 1 AND 250),
  resolved_commit text NOT NULL CHECK (resolved_commit ~ '^[0-9a-f]{40}$'),
  tree_sha text NOT NULL CHECK (tree_sha ~ '^[0-9a-f]{40}$'),
  files_total integer NOT NULL CHECK (files_total >= 0),
  files_matched integer NOT NULL CHECK (files_matched >= 0),
  skips_verified integer NOT NULL CHECK (skips_verified >= 0),
  skips_unverified integer NOT NULL CHECK (skips_unverified >= 0),
  completeness text NOT NULL CHECK (completeness IN ('complete', 'partial')),
  result_blob_sha256 text NOT NULL REFERENCES research_blobs(content_sha256),
  verified_at timestamptz NOT NULL DEFAULT now(),
  CHECK (files_matched + skips_verified + skips_unverified = files_total)
);
CREATE FUNCTION snapshot_verifications_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE s record;
BEGIN
  SELECT workflow_run_id, commit_sha, sealed_at INTO s FROM repo_snapshots WHERE id = NEW.snapshot_id;
  IF s.workflow_run_id IS DISTINCT FROM NEW.workflow_run_id OR s.commit_sha IS DISTINCT FROM NEW.resolved_commit THEN
    RAISE EXCEPTION 'a snapshot verification must name its snapshot''s run and commit' USING ERRCODE = 'check_violation';
  END IF;
  IF s.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a snapshot is verified before it is sealed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_verifications_before_insert BEFORE INSERT ON snapshot_verifications FOR EACH ROW EXECUTE FUNCTION snapshot_verifications_guard();
CREATE TRIGGER snapshot_verifications_append_only BEFORE UPDATE OR DELETE ON snapshot_verifications FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
