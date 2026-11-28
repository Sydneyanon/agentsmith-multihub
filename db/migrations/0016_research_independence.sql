-- 0016 (R3a): enforced generator/evaluator independence, WITHOUT any dependency on the unapplied 0008-0010 drafts
-- (docs/architecture/integrated-research-architecture.md §3.2, §6.2). Requires only 0007. Promoted from the R3 draft MINUS its
-- replacement of hypothesis_outcome_rules() (that function belongs to the T-144 draft 0009): that part is R3b, which stays in
-- db/drafts/r3b-outcome-independence and ships with 0009. Expand-only on 0007: one append-only reference table, one helper function,
-- one BEFORE INSERT trigger on hypothesis_evaluations, two views. Nothing existing is altered, renamed, dropped or rewritten.
-- hypothesis_status (0007) is NOT changed: it never derives a confirmed or supported state from evaluations.
-- Rollback: db/rollbacks/0016_research_independence.rollback.sql.

-- 1. Analysis identities: the family (the substrate whose errors are shared) and the method of every known generator and evaluator.
--    Mirrors apps/api/src/analysis-identity.ts (ANALYSIS_IDENTITIES) row for row; a unit test keeps them equal. Append-only.
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

-- 2. The generator never evaluates its own claim, whatever the outcome and whoever writes (ResearchStore.recordEvaluation refuses it
--    too). 'no-independent-validator' is an abstention by a different id, so it stays allowed.
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

-- 3. How each evaluation relates to its claim. ONLY 'cross_family' may count toward independent confirmation; 'same_family' agreement
--    is corroboration by the same substrate; an unlisted evaluator or generator is 'unknown_family' and never counts.
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

-- Per hypothesis, over each evaluator's LATEST evaluation (the same rule as hypothesis_status). Same-family corroboration and
-- independent (cross-family) support are separate columns; neither is ever derived from the other.
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
       COALESCE(bool_or(l.outcome = 'supports' AND l.relation = 'cross_family'), false) AS independently_supported,
       COALESCE(bool_or(l.outcome = 'supports' AND l.relation = 'same_family'), false) AS corroborated_same_family
FROM hypotheses h LEFT JOIN latest l ON l.hypothesis_id = h.id
GROUP BY h.id, h.generator_id, h.generator_kind;
