-- DRAFT T-144 rollback: restores the pre-draft schema exactly (tested: catalog fingerprint and pre-existing data unchanged).
-- Only valid while the new tables hold no data that must be kept; a real rollback after use would first export them.
DROP TABLE IF EXISTS hypothesis_outcomes, missed_in_runs, ground_truth_adjudications, research_effort, research_coverage, external_references;
ALTER TABLE hypothesis_evaluations DROP COLUMN IF EXISTS artifact_sha256;
DROP FUNCTION IF EXISTS hypothesis_outcome_rules();
DROP FUNCTION IF EXISTS research_coverage_sealed();
