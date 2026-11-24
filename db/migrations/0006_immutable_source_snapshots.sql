-- Durable, immutable source snapshots captured by bounded passive handlers.
CREATE TABLE source_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  workflow_step_id uuid NOT NULL REFERENCES workflow_steps(id),
  source_uri text NOT NULL,
  source_kind text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, source_uri, content_sha256)
);
CREATE INDEX source_snapshots_run_created_idx ON source_snapshots(workflow_run_id, created_at);

CREATE FUNCTION reject_source_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source_snapshots are immutable; capture a new snapshot instead';
END;
$$;
CREATE TRIGGER source_snapshots_append_only
  BEFORE UPDATE OR DELETE ON source_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_source_snapshot_mutation();
