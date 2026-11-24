-- Versioned hunt-gate contracts and append-only execution results.
-- Gate labels are seeded as definitions only after their exact criteria are reviewed; this migration does not invent criteria.
CREATE TABLE hunt_gate_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_code text NOT NULL CHECK (gate_code IN ('G0','G1','G2','G3','G4','G5','G6')),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  criteria jsonb NOT NULL CHECK (jsonb_typeof(criteria) = 'object'),
  required_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_artifacts) = 'array'),
  enabled boolean NOT NULL DEFAULT false,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gate_code, version),
  CHECK (NOT enabled OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE hunt_gate_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  gate_definition_id uuid NOT NULL REFERENCES hunt_gate_definitions(id),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('pending','running','passed','failed','inconclusive','blocked','skipped')) ,
  evaluator text NOT NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifact_refs) = 'array'),
  rationale text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);
CREATE INDEX hunt_gate_results_run_created_idx ON hunt_gate_results(workflow_run_id, created_at);
CREATE INDEX hunt_gate_results_gate_status_idx ON hunt_gate_results(gate_definition_id, status, created_at);

CREATE FUNCTION reject_hunt_gate_result_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hunt_gate_results are append-only; create a superseding result instead';
END;
$$;
CREATE TRIGGER hunt_gate_results_append_only
  BEFORE UPDATE OR DELETE ON hunt_gate_results
  FOR EACH ROW EXECUTE FUNCTION reject_hunt_gate_result_mutation();

CREATE FUNCTION reject_approved_gate_definition_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled THEN
    RAISE EXCEPTION 'approved hunt_gate_definitions are immutable; create a new version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hunt_gate_definitions_versioned
  BEFORE UPDATE OR DELETE ON hunt_gate_definitions
  FOR EACH ROW EXECUTE FUNCTION reject_approved_gate_definition_mutation();
