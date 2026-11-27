-- 0014: autonomous programme -> repository mappings (enrichment). Eligible programmes from Sherlock/HackenProof are officially
-- confirmed but carry no repository in their listing; enrichment fetches each programme's official page and extracts its in-scope
-- GitHub repositories, with evidence and a confidence status. Only officially_confirmed / official_documentation mappings may enter
-- research automatically; inferred/unverified ones never do. Append-ish: rows are upserted per (programme, repository) and re-checked.
-- Excluded from the production image like 0008/0012/0013; ships only on an approved deploy.

CREATE TABLE bounty_repository_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_program_id uuid NOT NULL REFERENCES bounty_programs(id) ON DELETE CASCADE,
  repository text NOT NULL CHECK (repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  source_url text NOT NULL,                 -- the official programme page the repository was found on (provenance)
  evidence text,                            -- the extracted reference / surrounding snippet
  discovery_method text NOT NULL CHECK (discovery_method IN ('official_page', 'followed_doc', 'official_api', 'manual')),
  verification_status text NOT NULL CHECK (verification_status IN
    ('officially_confirmed', 'official_documentation', 'inferred_unverified', 'rejected', 'unavailable')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  default_branch text,                      -- resolved GitHub default branch, when the repository identity was verified
  repository_github_id bigint,             -- GitHub numeric repo id (stable identity), when verified
  note text,                                -- e.g. 'archived', 'auditor/report repository', '404 not found'
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,                 -- the last enrichment run that still found this repo on the page (scope-change detection)
  UNIQUE (bounty_program_id, repository)
);
CREATE INDEX bounty_repository_mappings_program ON bounty_repository_mappings (bounty_program_id);
CREATE INDEX bounty_repository_mappings_repo ON bounty_repository_mappings (repository);
CREATE INDEX bounty_repository_mappings_status ON bounty_repository_mappings (verification_status);
