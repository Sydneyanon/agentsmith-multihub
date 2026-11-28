-- DRAFT (option D): run-scoped worker capability tokens and the internal worker API's idempotency record.
-- Not in db/migrations: the runner never applies it. Tests apply it to throwaway databases only.
--
-- A token authorises exactly one workflow run. Only the SHA-256 of its secret is stored. It expires (at most 7 days after
-- minting), can be revoked, and is refused by the API whenever its run is no longer queued or running. Neither table is a research
-- record; both are written by the API's owner connection only (the worker holds no database credential in this design).

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
CREATE FUNCTION worker_capability_tokens_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

-- One row per accepted state-changing call, written in the SAME transaction as the call's effect, so a retry with the same
-- idempotency key returns the stored answer instead of writing twice. A key reused for a different request is refused.
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
