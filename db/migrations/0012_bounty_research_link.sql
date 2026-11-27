-- 0012: the discovery -> research bridge (task 5). Links a bounty programme to the repository_research run(s) it triggered, so the
-- system can (a) feed eligible programmes into the existing research pipeline automatically, (b) avoid re-dispatching a repository it
-- has already queued, and (c) report a programme's lifecycle state (discovered -> ... -> scanning -> completed) from real records.
--
-- NOT in the production image yet. Like 0008 (discovery), this migration is excluded from the hub release build (HUB_RELEASE_*),
-- so it ships only when the owner explicitly approves a deploy. It references both workstreams' tables (bounty_programs from 0011 and
-- workflow_runs from 0007); both exist in production, so the foreign keys are safe when it is eventually applied.

CREATE TABLE bounty_research_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_program_id uuid NOT NULL REFERENCES bounty_programs(id) ON DELETE CASCADE,
  repository text NOT NULL,                 -- owner/name on github.com, as passed to the repository_research workflow
  ref text,                                 -- requested ref (branch/tag/commit); null means the repository default branch
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  reason text NOT NULL,                     -- why this run was created (e.g. "eligible programme, repository newly resolved")
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One link per (programme, repository, ref). A later run on a NEW commit of the same repo is a new ref value (or the default
  -- branch re-resolved by acquisition), so this does not block legitimate re-analysis of changed code.
  CONSTRAINT bounty_research_links_repo_shape CHECK (repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  UNIQUE (bounty_program_id, repository, ref)
);
CREATE INDEX bounty_research_links_program ON bounty_research_links (bounty_program_id);
CREATE INDEX bounty_research_links_repository ON bounty_research_links (repository);
CREATE INDEX bounty_research_links_run ON bounty_research_links (workflow_run_id);
