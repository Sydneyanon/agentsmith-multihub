-- DRAFT T-144: shared research memory (docs/research-memory-design.md; conforms to T-149, docs/unified-research-workflow.md).
-- STATUS: DRAFT. It lives OUTSIDE db/migrations, so the migration runner never applies it. It is applied only by its own test on throwaway
-- local databases (apps/api/src/integration/research-memory-draft.integration.test.ts). Applying it anywhere else needs a separate owner
-- approval (A4b) and a move into db/migrations under the next free number.
--
-- Expand-only: new append-only tables and one nullable column. Nothing existing is renamed, dropped or reinterpreted.
-- Planes (P3): outcomes and adjudications are HUMAN-plane records; coverage and effort are written by system steps; evidence stays in 0007.
-- hypothesis_contributions is deferred to T-151 (design decision 4).

-- A reference to something outside AgentSmith (an audit report, a public disclosure), recorded with provenance and permitted use.
CREATE TABLE external_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('audit_report','public_disclosure','advisory','bounty_report','other')),
  url text CHECK (url IS NULL OR length(url) <= 2000),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  published_at timestamptz,
  provenance_verified boolean NOT NULL,
  permitted_use boolean NOT NULL,
  observation_id uuid REFERENCES discovery_observations(id),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- What was examined, at which component version, for which class, by which method, and with what result (P8: absence is explicit).
CREATE TABLE research_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES repo_snapshots(id),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  produced_by_step_id uuid REFERENCES workflow_steps(id),
  component_path text NOT NULL CHECK (length(component_path) BETWEEN 1 AND 1000),
  component_name text CHECK (component_name IS NULL OR length(component_name) <= 300),
  component_sha256 text NOT NULL CHECK (component_sha256 ~ '^[a-f0-9]{64}$'),
  vulnerability_class text NOT NULL CHECK (vulnerability_class ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  method text NOT NULL CHECK (length(method) BETWEEN 1 AND 200),
  method_version text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 100),
  result text NOT NULL CHECK (result IN ('examined','abstained','not_modelled','out_of_scope')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (result = 'examined' OR reason_code IS NOT NULL)
);
CREATE INDEX research_coverage_component_idx ON research_coverage (component_sha256, vulnerability_class);

-- Research effort and cost per step (and optionally per component and method). Model spend is referenced, never duplicated.
CREATE TABLE research_effort (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  step_id uuid REFERENCES workflow_steps(id),
  component_path text CHECK (component_path IS NULL OR length(component_path) <= 1000),
  method text NOT NULL CHECK (length(method) BETWEEN 1 AND 200),
  wall_ms bigint NOT NULL CHECK (wall_ms >= 0),
  cpu_ms bigint CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
  model_reservation_id uuid REFERENCES ai_budget_reservations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Links a missed finding (a human-recorded hypothesis) to the runs whose coverage claimed the component.
CREATE TABLE missed_in_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  coverage_id uuid REFERENCES research_coverage(id),
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hypothesis_id, workflow_run_id)
);

-- The one place a discovery label is born. Every outcome is a human decision; corrections supersede, never edit.
CREATE TABLE hypothesis_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id),
  category text NOT NULL CHECK (category IN ('confirmed','refuted','inconclusive','duplicate','missed')),
  decided_by_kind text NOT NULL DEFAULT 'human' CHECK (decided_by_kind = 'human'),
  decided_by text NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 200),
  basis_evaluation_ids uuid[] NOT NULL DEFAULT '{}',
  basis_review_id uuid REFERENCES hypothesis_reviews(id),
  duplicate_of_hypothesis uuid REFERENCES hypotheses(id),
  duplicate_of_external uuid REFERENCES external_references(id),
  supersedes_id uuid REFERENCES hypothesis_outcomes(id),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (category = 'duplicate' OR (duplicate_of_hypothesis IS NULL AND duplicate_of_external IS NULL)),
  CHECK (category <> 'duplicate' OR ((duplicate_of_hypothesis IS NULL) <> (duplicate_of_external IS NULL))),
  CHECK (duplicate_of_hypothesis IS NULL OR duplicate_of_hypothesis <> hypothesis_id)
);
CREATE INDEX hypothesis_outcomes_hypothesis_idx ON hypothesis_outcomes (hypothesis_id, created_at);

-- P7 and the plane rules, enforced in the database:
--  confirmed : a human 'disclosed_adjudication' review with verdict 'supports' on THIS hypothesis, AND at least one 'supports' evaluation
--              on THIS hypothesis by an evaluator different from the hypothesis's generator (independence);
--  refuted   : grounded in a 'contradicts' evaluation or a human 'rejects' review on this hypothesis;
--  missed    : the hypothesis was recorded by a human (generator_kind 'human') and is linked to at least one run that missed it;
--  supersedes: only an outcome of the same hypothesis.
CREATE FUNCTION hypothesis_outcome_rules() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE gen text; gen_kind text;
BEGIN
  SELECT generator_id, generator_kind INTO gen, gen_kind FROM hypotheses WHERE id = NEW.hypothesis_id;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hypothesis_outcomes o WHERE o.id = NEW.supersedes_id AND o.hypothesis_id = NEW.hypothesis_id) THEN
    RAISE EXCEPTION 'an outcome may only supersede an outcome of the same hypothesis' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.basis_review_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hypothesis_reviews r WHERE r.id = NEW.basis_review_id AND r.hypothesis_id = NEW.hypothesis_id) THEN
    RAISE EXCEPTION 'the basis review belongs to a different hypothesis' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.basis_evaluation_ids) b(id) WHERE NOT EXISTS (SELECT 1 FROM hypothesis_evaluations e WHERE e.id = b.id AND e.hypothesis_id = NEW.hypothesis_id)) THEN
    RAISE EXCEPTION 'a basis evaluation does not exist or belongs to a different hypothesis' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.category = 'confirmed' THEN
    IF NOT EXISTS (SELECT 1 FROM hypothesis_reviews r WHERE r.id = NEW.basis_review_id AND r.reviewer_kind = 'human' AND r.review_mode = 'disclosed_adjudication' AND r.verdict = 'supports') THEN
      RAISE EXCEPTION 'confirmed requires a human disclosed_adjudication review with verdict supports' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM hypothesis_evaluations e WHERE e.id = ANY (NEW.basis_evaluation_ids) AND e.outcome = 'supports' AND e.evaluator_id <> gen) THEN
      RAISE EXCEPTION 'confirmed requires a supports evaluation by an evaluator independent of the generator' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.category = 'refuted' THEN
    IF NOT EXISTS (SELECT 1 FROM hypothesis_evaluations e WHERE e.id = ANY (NEW.basis_evaluation_ids) AND e.outcome = 'contradicts')
       AND NOT EXISTS (SELECT 1 FROM hypothesis_reviews r WHERE r.id = NEW.basis_review_id AND r.reviewer_kind = 'human' AND r.verdict = 'rejects') THEN
      RAISE EXCEPTION 'refuted requires a contradicts evaluation or a human rejects review' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.category = 'missed' THEN
    IF gen_kind <> 'human' THEN
      RAISE EXCEPTION 'a missed finding must be recorded as a human hypothesis' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM missed_in_runs m WHERE m.hypothesis_id = NEW.hypothesis_id) THEN
      RAISE EXCEPTION 'a missed finding must name at least one run that missed it' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hypothesis_outcomes_rules BEFORE INSERT ON hypothesis_outcomes FOR EACH ROW EXECUTE FUNCTION hypothesis_outcome_rules();

-- Disputes about ground truth (a corpus label or a hypothesis), mirroring eval/adjudications (schema agentsmith-adjudication/1).
CREATE TABLE ground_truth_adjudications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL CHECK (subject_kind IN ('corpus_label','hypothesis')),
  corpus_path text CHECK (corpus_path IS NULL OR length(corpus_path) <= 300),
  corpus_manifest_sha256 text CHECK (corpus_manifest_sha256 IS NULL OR corpus_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  label_file text, label_contract text, label_function text, label_class text,
  hypothesis_id uuid REFERENCES hypotheses(id),
  disputed_by text NOT NULL CHECK (length(disputed_by) BETWEEN 1 AND 500),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) >= 1),
  outcome text NOT NULL CHECK (outcome IN ('label_upheld','label_overturned','ambiguous')),
  adjudicator_kind text NOT NULL CHECK (adjudicator_kind IN ('human','model')),
  adjudicator_id text NOT NULL CHECK (length(adjudicator_id) BETWEEN 1 AND 200),
  human_sign_off text NOT NULL CHECK (human_sign_off IN ('pending','signed','declined')),
  signed_by text,
  supersedes_id uuid REFERENCES ground_truth_adjudications(id),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (subject_kind <> 'corpus_label' OR (corpus_path IS NOT NULL AND corpus_manifest_sha256 IS NOT NULL AND label_file IS NOT NULL AND label_function IS NOT NULL AND label_class IS NOT NULL AND hypothesis_id IS NULL)),
  CHECK (subject_kind <> 'hypothesis' OR (hypothesis_id IS NOT NULL AND corpus_path IS NULL)),
  -- a model may adjudicate, but only a human can sign off; a signature names who signed
  CHECK (human_sign_off <> 'signed' OR (adjudicator_kind = 'human' AND signed_by IS NOT NULL)),
  CHECK (human_sign_off = 'signed' OR signed_by IS NULL)
);

-- Structured counterexamples: an evaluation may point at a content-addressed artifact (trace, scenario, reproduction recipe).
ALTER TABLE hypothesis_evaluations ADD COLUMN artifact_sha256 text REFERENCES research_blobs(content_sha256);

-- Append-only, reusing the 0007 rejection function.
CREATE TRIGGER external_references_immutable BEFORE UPDATE OR DELETE ON external_references FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
CREATE TRIGGER research_coverage_immutable BEFORE UPDATE OR DELETE ON research_coverage FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
CREATE TRIGGER research_effort_immutable BEFORE UPDATE OR DELETE ON research_effort FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
CREATE TRIGGER missed_in_runs_immutable BEFORE UPDATE OR DELETE ON missed_in_runs FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
CREATE TRIGGER hypothesis_outcomes_immutable BEFORE UPDATE OR DELETE ON hypothesis_outcomes FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
CREATE TRIGGER ground_truth_adjudications_immutable BEFORE UPDATE OR DELETE ON ground_truth_adjudications FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- P1: coverage is recorded only against a sealed snapshot.
CREATE FUNCTION research_coverage_sealed() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM repo_snapshots s WHERE s.id = NEW.snapshot_id AND s.sealed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'coverage can only be recorded against a sealed snapshot' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER research_coverage_sealed BEFORE INSERT ON research_coverage FOR EACH ROW EXECUTE FUNCTION research_coverage_sealed();
