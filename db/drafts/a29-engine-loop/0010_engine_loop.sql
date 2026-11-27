-- DRAFT (A28 design, A29 to apply): decision records and the opportunity registry for the research loop.
-- Requires 0001-0008 and the T-144 draft (0009_research_memory.sql). Never in db/migrations: the runner cannot apply it.
-- Every new table is append-only (research_reject_mutation from 0007). A correction is a new row, never an edit.

-- 1. Opportunity registry, aligned with the T-040 unified opportunity model (docs/opportunity-model-design.md) and built on the 0008
--    tables, NOT a parallel model: provenance is an observation, verification and policy assessments are append-only opportunity_events,
--    and the human selection is the existing 'approved' + 'queued' events (approveOpportunity). Only the columns and event kinds the loop
--    needs are added; T-041 (program, program_version, project) remains a separate, unapproved draft and can absorb these unchanged.
-- 1a. Manual import sources (T-040 access method 'manual_import'): an opportunity can be entered from a source a person reads, such as a
--     community bounty board. Such a source can never be enabled, so the monitor can never poll it.
ALTER TABLE discovery_sources DROP CONSTRAINT discovery_sources_adapter_check;
ALTER TABLE discovery_sources ADD CONSTRAINT discovery_sources_adapter_check CHECK (adapter IN ('github_org_repos','manual_import'));
ALTER TABLE discovery_sources ADD CONSTRAINT discovery_sources_manual_never_polled CHECK (adapter <> 'manual_import' OR enabled = false);
-- 1b. T-040 provenance_kind: operator-supplied input is never labelled as fetched. Its claims are stored with it (what the source said).
ALTER TABLE discovery_observations ADD COLUMN provenance_kind text NOT NULL DEFAULT 'fetched' CHECK (provenance_kind IN ('fetched','operator_supplied'));
ALTER TABLE discovery_observations ADD COLUMN claims jsonb CHECK (claims IS NULL OR jsonb_typeof(claims) = 'object');
ALTER TABLE discovery_observations ADD CONSTRAINT discovery_observations_supplied_shape
  CHECK (provenance_kind <> 'operator_supplied' OR (claims IS NOT NULL AND workflow_run_id IS NULL AND outcome = 'ok' AND http_status IS NULL));

-- 2. Decisions (A28 section 2.1). One row per choice point.
CREATE TABLE research_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level text NOT NULL CHECK (level IN ('opportunity','repository','component','function','path','follow_up')),
  context_run_id uuid REFERENCES workflow_runs(id),
  snapshot_id uuid REFERENCES repo_snapshots(id),
  protocol_model_sha256 text REFERENCES research_blobs(content_sha256),
  decided_by_kind text NOT NULL CHECK (decided_by_kind IN ('policy','human')),
  decided_by text NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 200),
  policy_sha256 text REFERENCES research_blobs(content_sha256),
  mode text NOT NULL CHECK (mode IN ('exploit','explore','manual')),
  explore_rule text CHECK (explore_rule IS NULL OR length(explore_rule) <= 200),
  budget_reservation_id uuid REFERENCES ai_budget_reservations(id),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  -- now(), like workflow_runs.created_at: a run created in the same transaction as its decision has an equal timestamp, never an earlier one
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (level IN ('opportunity','repository') OR snapshot_id IS NOT NULL),
  CHECK (decided_by_kind = 'human' OR policy_sha256 IS NOT NULL),
  CHECK (decided_by_kind <> 'human' OR mode = 'manual'),
  CHECK (mode <> 'explore' OR explore_rule IS NOT NULL)
);
CREATE INDEX research_decisions_snapshot_idx ON research_decisions (snapshot_id, created_at);

-- 3. Every alternative considered, chosen or not (A28 section 2.2). Non-actions are rows too.
--    Deviation from A28, recorded in docs/research-loop.md: actions 'recommend' (the policy ranks opportunities; a human selects),
--    'request_human_review' (a supported lead goes to a human, never to "confirmed") and 'complete' (nothing left to investigate).
CREATE TABLE research_decision_candidates (
  decision_id uuid NOT NULL REFERENCES research_decisions(id),
  rank integer NOT NULL CHECK (rank >= 1),
  candidate_kind text NOT NULL CHECK (candidate_kind IN ('opportunity','repository','component','function','path','hypothesis')),
  candidate_ref text NOT NULL CHECK (length(candidate_ref) BETWEEN 1 AND 1000),
  features jsonb NOT NULL,
  score_components jsonb NOT NULL,
  selected boolean NOT NULL,
  selection_probability numeric CHECK (selection_probability IS NULL OR (selection_probability > 0 AND selection_probability <= 1)),
  action text NOT NULL CHECK (action IN ('investigate','defer','skip_duplicate_risk','skip_out_of_scope','skip_budget','skip_low_value','recommend','request_human_review','complete')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  resulting_run_id uuid REFERENCES workflow_runs(id),
  resulting_step_id uuid REFERENCES workflow_steps(id),
  PRIMARY KEY (decision_id, rank),
  UNIQUE (decision_id, candidate_ref),
  CHECK (selected = (action IN ('investigate','request_human_review'))),
  CHECK (jsonb_typeof(features) = 'object' AND jsonb_typeof(score_components) = 'object'),
  CHECK (resulting_step_id IS NULL OR resulting_run_id IS NOT NULL)
);

-- Rule 3 (provenance of features) and rule 2 (decide before acting).
CREATE FUNCTION research_decision_candidate_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; v jsonb; decided timestamptz; made timestamptz;
BEGIN
  FOR k, v IN SELECT * FROM jsonb_each(NEW.features) LOOP
    IF jsonb_typeof(v) <> 'object' OR NOT (v ? 'source' OR v ? 'unknown_reason') THEN
      RAISE EXCEPTION 'feature % has neither a source nor an unknown_reason', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NEW.resulting_run_id IS NOT NULL THEN
    SELECT created_at INTO decided FROM research_decisions WHERE id = NEW.decision_id;
    SELECT created_at INTO made FROM workflow_runs WHERE id = NEW.resulting_run_id;
    IF made < decided THEN
      RAISE EXCEPTION 'the resulting run was created before the decision' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.resulting_step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.id = NEW.resulting_step_id AND s.workflow_run_id = NEW.resulting_run_id) THEN
    RAISE EXCEPTION 'the resulting step does not belong to the resulting run' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER research_decision_candidates_rules BEFORE INSERT ON research_decision_candidates FOR EACH ROW EXECUTE FUNCTION research_decision_candidate_rules();

-- 4. A28 section 2.3: coverage and effort say which decision caused them.
ALTER TABLE research_coverage ADD COLUMN decision_id uuid REFERENCES research_decisions(id);
ALTER TABLE research_effort ADD COLUMN decision_id uuid REFERENCES research_decisions(id);

-- 5. Opportunity events gain two kinds (T-040: "verification is itself a recorded event"; lifecycle and decisions are events):
--    'verified'  a human's check against the official source: payload {check, subject, verdict, method, evidence[]};
--    'assessed'  the policy's screening of an open opportunity: payload {assessment, reason, duplicate_of?}, linked to its decision.
--    An assessment never changes the opportunity's state and never blocks a human decision (T-040: a possible duplicate does not merge
--    and does not block). The state guard of 0008 is unchanged: only human events move the state.
ALTER TABLE opportunity_events DROP CONSTRAINT opportunity_events_event_type_check;
ALTER TABLE opportunity_events ADD CONSTRAINT opportunity_events_event_type_check
  CHECK (event_type IN ('discovered','updated','closed','approved','dismissed','queued','verified','assessed'));
ALTER TABLE opportunity_events DROP CONSTRAINT opportunity_events_actor_kind_check;
ALTER TABLE opportunity_events ADD CONSTRAINT opportunity_events_actor_kind_check CHECK (actor_kind IN ('monitor','human','policy'));
ALTER TABLE opportunity_events ADD COLUMN decision_id uuid REFERENCES research_decisions(id);
ALTER TABLE opportunity_events ADD CONSTRAINT opportunity_events_policy_only_assesses
  CHECK ((actor_kind = 'policy') = (event_type = 'assessed') AND (event_type = 'assessed') = (decision_id IS NOT NULL));
ALTER TABLE opportunity_events ADD CONSTRAINT opportunity_events_verified_shape CHECK (event_type <> 'verified' OR (
  actor_kind = 'human'
  AND payload->>'check' IN ('program_official','repository_official','scope_includes_repository','eligibility')
  AND payload->>'verdict' IN ('verified','unverified','contradicted')
  AND length(coalesce(payload->>'subject', '')) BETWEEN 1 AND 500
  AND length(coalesce(payload->>'method', '')) BETWEEN 1 AND 200
  AND jsonb_typeof(payload->'evidence') = 'array'
  AND (payload->>'verdict' = 'unverified' OR jsonb_array_length(payload->'evidence') >= 1)));
ALTER TABLE opportunity_events ADD CONSTRAINT opportunity_events_assessed_shape CHECK (event_type <> 'assessed' OR (
  payload->>'assessment' IN ('recommended','deferred','possible_duplicate','ineligible','out_of_scope')
  AND length(coalesce(payload->>'reason', '')) BETWEEN 1 AND 2000
  AND ((payload->>'assessment' = 'possible_duplicate') = (payload ? 'duplicate_of'))));

CREATE TRIGGER research_decisions_immutable BEFORE UPDATE OR DELETE ON research_decisions FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
CREATE TRIGGER research_decision_candidates_immutable BEFORE UPDATE OR DELETE ON research_decision_candidates FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- 6. Attended specialist sessions (T-203). A Claude Code sub-agent run by a named operator in an attended session is NOT a paid,
--    budget-reserved model call ('model' keeps requiring a gateway reservation) and NOT a human. It gets its own provenance kind,
--    'attended_model', identified by capability id and a version that pins the prompt (e.g. '1+prompt-0123456789ab').
--    Planes are unchanged: an attended model may write claims (hypotheses) and reviews, never evaluations (technical evidence stays
--    'deterministic_rule' only, 0007) and never outcomes (human only, T-144). So no model output can make a finding confirmed.
ALTER TABLE hypotheses DROP CONSTRAINT hypotheses_generator_kind_check;
ALTER TABLE hypotheses ADD CONSTRAINT hypotheses_generator_kind_check CHECK (generator_kind IN ('deterministic_rule','model','human','attended_model'));
ALTER TABLE hypotheses ADD CONSTRAINT hypotheses_attended_version CHECK (generator_kind <> 'attended_model' OR (generator_version ~ '^[0-9][0-9.]*\+prompt-[a-f0-9]{12}$' AND generator_reservation_id IS NULL));
ALTER TABLE hypothesis_events DROP CONSTRAINT hypothesis_events_actor_kind_check;
ALTER TABLE hypothesis_events ADD CONSTRAINT hypothesis_events_actor_kind_check CHECK (actor_kind IN ('deterministic_rule','model','human','attended_model'));
ALTER TABLE hypothesis_reviews DROP CONSTRAINT hypothesis_reviews_reviewer_kind_check;
ALTER TABLE hypothesis_reviews ADD CONSTRAINT hypothesis_reviews_reviewer_kind_check CHECK (reviewer_kind IN ('model','human','attended_model'));
ALTER TABLE hypothesis_reviews ADD CONSTRAINT hypothesis_reviews_attended_shape CHECK (reviewer_kind <> 'attended_model' OR (
  model_provider IS NOT NULL AND model_name IS NOT NULL AND model_prompt_version ~ '^[0-9][0-9.]*\+prompt-[a-f0-9]{12}$' AND model_reservation_id IS NULL AND review_mode = 'blinded_independent_assessment'));
-- a specialist never reviews its own claim, in ANY mode (0007 only forbids it for blinded assessments by the same kind and id)
CREATE FUNCTION hypothesis_reviews_attended_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g text;
BEGIN
  SELECT generator_id INTO g FROM hypotheses WHERE id = NEW.hypothesis_id;
  IF NEW.reviewer_kind = 'attended_model' AND NEW.reviewer_id = g THEN
    RAISE EXCEPTION 'a specialist cannot review its own claim' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hypothesis_reviews_attended_guard BEFORE INSERT ON hypothesis_reviews FOR EACH ROW EXECUTE FUNCTION hypothesis_reviews_attended_guard();
