-- DRAFT R3 rollback: restores the schema left by 0001-0008 plus the T-144 draft (and the A29 draft, if applied) exactly (tested: catalog
-- fingerprint unchanged). Only valid while analysis_identities holds no rows beyond the seed that must be kept.
DROP VIEW IF EXISTS hypothesis_independence;
DROP VIEW IF EXISTS evaluation_independence;
DROP TRIGGER IF EXISTS hypothesis_evaluations_independence ON hypothesis_evaluations;
DROP FUNCTION IF EXISTS hypothesis_evaluations_independence();
DROP FUNCTION IF EXISTS analysis_generator_family(text, text);
DROP TABLE IF EXISTS analysis_identities;
-- the T-144 outcome rule exactly as 0009_research_memory.sql defines it
CREATE OR REPLACE FUNCTION hypothesis_outcome_rules() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
