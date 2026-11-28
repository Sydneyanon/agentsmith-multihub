-- DRAFT (not a migration; never applied by the migration runner). See README.md in this directory.
-- C2: a database index of the shared lead identity. The lead key is ALREADY derived in code and stored in the producing steps' outputs
-- (workflow_steps.output->'lead_keys'); nothing in the application needs this table to work. It adds what the JSON cannot give:
-- an indexed cross-run lookup, one key per hypothesis enforced by the database, and append-only protection of the link.
-- Requires 0007 (hypotheses, research_reject_mutation). Slot shared with the proposed R4 `hypothesis_contributions`: adopt ONE of them.

CREATE TABLE hypothesis_leads (
  hypothesis_id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL,
  -- sha256 of ["agentsmith-lead-key/1", repository, class, file, contract, function] (apps/api/src/analysis/solidity/lead-identity.ts)
  lead_key text NOT NULL CHECK (lead_key ~ '^[a-f0-9]{64}$'),
  key_schema text NOT NULL CHECK (key_schema = 'agentsmith-lead-key/1'),
  repository text NOT NULL CHECK (repository = lower(repository) AND repository ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'),
  vulnerability_class text NOT NULL CHECK (length(vulnerability_class) BETWEEN 1 AND 100),
  file_path text NOT NULL CHECK (length(file_path) BETWEEN 1 AND 1024),
  contract text NOT NULL CHECK (length(contract) <= 200),
  function_name text NOT NULL CHECK (length(function_name) <= 200),
  recorded_by_step_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (hypothesis_id, workflow_run_id) REFERENCES hypotheses (id, workflow_run_id),
  FOREIGN KEY (recorded_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id)
);
CREATE INDEX hypothesis_leads_key_idx ON hypothesis_leads (lead_key, created_at);
CREATE INDEX hypothesis_leads_repository_idx ON hypothesis_leads (repository, lead_key);

-- append-only, like every other research record
CREATE TRIGGER hypothesis_leads_immutable BEFORE UPDATE OR DELETE ON hypothesis_leads
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- the key must be the key of the recorded anchor (the same derivation as the application's canonical JSON array)
CREATE FUNCTION hypothesis_leads_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected text;
BEGIN
  -- the application's canonical JSON array has no space after a comma (jsonb's own text output has one), so the array is assembled
  -- here element by element. If the two derivations ever differ, the insert is refused rather than guessed.
  expected := encode(sha256(convert_to(
    '[' || to_jsonb(NEW.key_schema)::text || ',' || to_jsonb(NEW.repository)::text || ',' || to_jsonb(NEW.vulnerability_class)::text || ','
        || to_jsonb(NEW.file_path)::text || ',' || to_jsonb(NEW.contract)::text || ',' || to_jsonb(NEW.function_name)::text || ']', 'UTF8')), 'hex');
  IF expected <> NEW.lead_key THEN RAISE EXCEPTION 'lead key % is not the key of its anchor', NEW.lead_key USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hypothesis_leads_before_insert BEFORE INSERT ON hypothesis_leads FOR EACH ROW EXECUTE FUNCTION hypothesis_leads_guard();

-- One row per lead key and snapshot, with the generators that reported it: the investigation, as a view (derived; nothing stored twice).
CREATE VIEW lead_investigations AS
SELECT l.lead_key, h.snapshot_id, l.repository, l.vulnerability_class, l.file_path, l.contract, l.function_name,
       count(*) AS hypotheses,
       count(DISTINCT h.generator_id) AS generators,
       array_agg(DISTINCT h.generator_id ORDER BY h.generator_id) AS generator_ids,
       min(l.created_at) AS first_recorded_at
  FROM hypothesis_leads l JOIN hypotheses h ON h.id = l.hypothesis_id
 GROUP BY l.lead_key, h.snapshot_id, l.repository, l.vulnerability_class, l.file_path, l.contract, l.function_name;
