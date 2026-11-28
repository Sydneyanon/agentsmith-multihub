-- DRAFT R3: enforced generator/evaluator independence (docs/architecture/integrated-research-architecture.md §3.2, §6.2).
-- STATUS: DRAFT. It lives OUTSIDE db/migrations, so the migration runner never applies it. It is applied only by its own test on throwaway
-- local databases (apps/api/src/integration/evaluator-independence-draft.integration.test.ts). Applying it anywhere else needs the owner's
-- R3 decision (§12 item 2) AND the T-144 draft (A4b) first, because it tightens that draft's outcome rule.
-- Requires: 0001-0008 and the T-144 draft (0009_research_memory.sql). Independent of the A29 draft (0010); tested with and without it.
--
-- Expand-only on 0007: one new append-only reference table, one new trigger on hypothesis_evaluations, two new views, one helper function.
-- Nothing existing is renamed or dropped. hypothesis_status (0007) is NOT changed: it never derives a confirmed or supported state from
-- evaluations (a supports evaluation leaves status `unreviewed`), so no same-family agreement can reach it. The one place confirmation
-- is derived, the T-144 outcome rule, is tightened from "evaluator id <> generator id" to "evaluator of a DIFFERENT analysis family".

-- 1. Analysis identities: the family (the substrate whose errors are shared) and the method of every known generator and evaluator.
--    Mirrors apps/api/src/analysis-identity.ts (ANALYSIS_IDENTITIES) row for row; a unit test keeps them equal. Append-only: an id's family
--    can never change after evaluations were judged by it; a new method version that changes substrate needs a new id.
CREATE TABLE analysis_identities (
  actor_id text PRIMARY KEY CHECK (length(actor_id) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('generator','evaluator','abstention')),
  analysis_family text NOT NULL CHECK (analysis_family ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  method text NOT NULL CHECK (method ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'abstention') = (analysis_family = 'none'))
);
CREATE TRIGGER analysis_identities_immutable BEFORE UPDATE OR DELETE ON analysis_identities FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

INSERT INTO analysis_identities (actor_id, role, analysis_family, method) VALUES
  ('solidity-structural-specialists', 'generator', 'agentsmith-solidity-parser', 'structural-pattern-rules'),
  ('slither', 'generator', 'slither-ir', 'static-detectors'),
  ('claude-scoping', 'generator', 'claude-model', 'attended-model-reading'),
  ('claude-accounting', 'generator', 'claude-model', 'attended-model-reading'),
  ('claude-path', 'generator', 'claude-model', 'attended-model-reading'),
  ('claude-assumptions', 'generator', 'claude-model', 'attended-model-reading'),
  ('claude-liveness', 'generator', 'claude-model', 'attended-model-reading'),
  ('claude-hunter', 'generator', 'claude-model', 'attended-model-reading'),
  ('reentrancy-execution-validator', 'evaluator', 'agentsmith-solidity-parser', 'bounded-execution'),
  ('execution-challenge-access-control', 'evaluator', 'agentsmith-solidity-parser', 'bounded-execution'),
  ('execution-challenge-selfdestruct', 'evaluator', 'agentsmith-solidity-parser', 'bounded-execution'),
  ('execution-challenge-delegatecall', 'evaluator', 'agentsmith-solidity-parser', 'bounded-execution'),
  ('execution-challenge-initializer', 'evaluator', 'agentsmith-solidity-parser', 'bounded-execution'),
  ('execution-challenge-unchecked-call', 'evaluator', 'agentsmith-solidity-parser', 'bounded-execution'),
  ('foundry-forge', 'evaluator', 'evm-execution', 'compiled-test-execution'),
  ('no-independent-validator', 'abstention', 'none', 'abstention');

-- The family of a claim's generator: a listed generator by id; a human generator is the 'human' family; anything else is unknown (NULL).
CREATE FUNCTION analysis_generator_family(p_generator_id text, p_generator_kind text) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT analysis_family FROM analysis_identities WHERE actor_id = p_generator_id AND role = 'generator'),
                  CASE WHEN p_generator_kind = 'human' THEN 'human' END)
$$;

-- 2. The generator never evaluates its own claim, whatever the outcome (code: ResearchStore.recordEvaluation refuses it too).
--    'no-independent-validator' is an abstention by a different id, so it stays allowed.
CREATE FUNCTION hypothesis_evaluations_independence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE gen text;
BEGIN
  SELECT generator_id INTO gen FROM hypotheses WHERE id = NEW.hypothesis_id;
  IF gen = NEW.evaluator_id THEN
    RAISE EXCEPTION 'an evaluation cannot be made by the generator of its hypothesis (%)', gen USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hypothesis_evaluations_independence BEFORE INSERT ON hypothesis_evaluations FOR EACH ROW EXECUTE FUNCTION hypothesis_evaluations_independence();

-- 3. How each evaluation relates to its claim. Only 'cross_family' may count toward independent confirmation; 'same_family' agreement is
--    corroboration by the same substrate; an unlisted evaluator or generator is 'unknown_family' and never counts.
CREATE VIEW evaluation_independence AS
SELECT e.id AS evaluation_id, e.hypothesis_id, e.evaluator_id, e.outcome, h.generator_kind, h.generator_id,
       g.family AS generator_family, i.analysis_family AS evaluator_family, i.method AS evaluator_method,
       CASE WHEN i.role = 'abstention' THEN 'abstention'
            WHEN i.role IS DISTINCT FROM 'evaluator' OR g.family IS NULL THEN 'unknown_family'
            WHEN i.analysis_family = g.family THEN 'same_family'
            ELSE 'cross_family' END AS relation
FROM hypothesis_evaluations e
JOIN hypotheses h ON h.id = e.hypothesis_id
CROSS JOIN LATERAL (SELECT analysis_generator_family(h.generator_id, h.generator_kind) AS family) g
LEFT JOIN analysis_identities i ON i.actor_id = e.evaluator_id;

-- Per hypothesis, over each evaluator's LATEST evaluation (the same rule as hypothesis_status).
CREATE VIEW hypothesis_independence AS
WITH latest AS (
  SELECT DISTINCT ON (x.hypothesis_id, x.evaluator_id) x.*
  FROM evaluation_independence x JOIN hypothesis_events ev ON ev.evaluation_id = x.evaluation_id
  ORDER BY x.hypothesis_id, x.evaluator_id, ev.seq DESC
)
SELECT h.id AS hypothesis_id, analysis_generator_family(h.generator_id, h.generator_kind) AS generator_family,
       count(l.evaluation_id) FILTER (WHERE l.outcome = 'supports' AND l.relation = 'cross_family')::integer AS cross_family_supports,
       count(l.evaluation_id) FILTER (WHERE l.outcome = 'supports' AND l.relation = 'same_family')::integer AS same_family_supports,
       count(l.evaluation_id) FILTER (WHERE l.outcome = 'supports' AND l.relation = 'unknown_family')::integer AS unknown_family_supports,
       count(l.evaluation_id) FILTER (WHERE l.outcome = 'contradicts')::integer AS contradicts,
       COALESCE(bool_or(l.outcome = 'supports' AND l.relation = 'cross_family'), false) AS independently_supported
FROM hypotheses h LEFT JOIN latest l ON l.hypothesis_id = h.id
GROUP BY h.id, h.generator_id, h.generator_kind;

-- 4. Tighten the T-144 outcome rule: 'confirmed' needs a basis 'supports' evaluation of a DIFFERENT analysis family than the generator
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
