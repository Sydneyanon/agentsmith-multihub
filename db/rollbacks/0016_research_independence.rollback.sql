-- Rollback of 0016_research_independence.sql (R3a). Removes ONLY what 0016 created; no earlier object or row is touched (tested by
-- catalog and data fingerprints). Valid while no decision that must be kept depends on the identities table (R3b, if ever applied,
-- must be rolled back first: it reads evaluation_independence).
BEGIN;
DROP VIEW hypothesis_independence;
DROP VIEW evaluation_independence;
DROP TRIGGER hypothesis_evaluations_independence ON hypothesis_evaluations;
DROP FUNCTION hypothesis_evaluations_independence();
DROP FUNCTION analysis_generator_family(text, text);
DROP TABLE analysis_identities;
DELETE FROM schema_migrations WHERE name = '0016_research_independence.sql';
COMMIT;
