-- DRAFT R3b: the T-144 'confirmed' rule needs a CROSS-FAMILY supports evaluation (was: a different evaluator id).
-- STATUS: DRAFT. Outside db/migrations, so the runner never applies it. It replaces hypothesis_outcome_rules(), which the T-144 draft
-- (db/drafts/t144-research-memory/0009_research_memory.sql) defines, so it ships WITH 0009, after it, never before.
-- Requires: 0016_research_independence.sql (R3a: analysis_identities, evaluation_independence) and the T-144 draft.
-- R3a (the identities, the self-evaluation trigger and the two views) was promoted to db/migrations/0016; this is the remainder.

-- Tighten the T-144 outcome rule: 'confirmed' needs a basis 'supports' evaluation of a DIFFERENT analysis family than the generator
--    (was: a different evaluator id). Every other rule is unchanged, byte for byte, from 0009.
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
    IF NOT EXISTS (SELECT 1 FROM evaluation_independence x WHERE x.evaluation_id = ANY (NEW.basis_evaluation_ids) AND x.outcome = 'supports' AND x.relation = 'cross_family') THEN
      RAISE EXCEPTION 'confirmed requires a supports evaluation by an evaluator of a different analysis family than the generator (same-family agreement is corroboration, not independent confirmation)' USING ERRCODE = 'check_violation';
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
