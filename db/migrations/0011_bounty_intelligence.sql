-- Workstream A: bounty intelligence collection. Independent of the research engine and of migration 0008 (discovery):
-- it references no table outside this file, so it can ship with 0001-0007 alone.
--
-- Model: every source listing is an OBSERVATION (who said what, where, when, by which method, at which authority). A PROGRAM is the
-- deduplicated opportunity those observations describe. The program's displayed fields are RESOLVED from its observations by
-- authority and recorded with their source; conflicts are kept, never overwritten. Changes are appended to history.

CREATE TABLE bounty_sources (
  source_key text PRIMARY KEY CHECK (source_key ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  kind text NOT NULL CHECK (kind IN ('official_platform', 'community_index', 'social', 'manual', 'operator')),
  display_name text NOT NULL,
  -- 1 official programme page, 2 official project docs, 3 official platform listing, 4 community board, 5 X post, 6 other, 0 operator correction
  authority smallint NOT NULL CHECK (authority BETWEEN 0 AND 6),
  collection_method text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  access_status text NOT NULL DEFAULT 'unknown' CHECK (access_status IN ('permitted', 'owner_decision_required', 'blocked_terms', 'blocked_robots', 'blocked_technical', 'manual_only', 'unknown')),
  access_note text NOT NULL DEFAULT '',
  min_interval_seconds integer NOT NULL DEFAULT 3600 CHECK (min_interval_seconds >= 300),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_content_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bounty_collection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual', 'import', 'test')),
  started_by text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- One row per source per run: configured is not fetched, fetched is not extracted, extracted is not saved. Each stage is counted.
CREATE TABLE bounty_source_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES bounty_collection_runs(id),
  source_key text NOT NULL REFERENCES bounty_sources(source_key),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'fetched', 'empty', 'failed', 'skipped_disabled', 'skipped_blocked', 'skipped_not_due', 'unchanged')),
  http_status integer,
  bytes integer,
  content_sha256 text,
  pages integer NOT NULL DEFAULT 0,
  listings_extracted integer NOT NULL DEFAULT 0,
  programs_added integer NOT NULL DEFAULT 0,
  programs_updated integer NOT NULL DEFAULT 0,
  observations_unchanged integer NOT NULL DEFAULT 0,
  duplicates_matched integer NOT NULL DEFAULT 0,
  needs_verification integer NOT NULL DEFAULT 0,
  delisted integer NOT NULL DEFAULT 0,
  error text,
  retry_after timestamptz
);
CREATE INDEX bounty_source_checks_source_idx ON bounty_source_checks (source_key, started_at DESC);

CREATE TABLE bounty_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deterministic identity: a platform programme key such as 'immunefi:hyperlane' or 'sherlock:287', derived from an official URL.
  -- NULL for opportunities known only by name (an X post without a platform link, for example).
  canonical_key text UNIQUE,
  project_name text NOT NULL,
  name_key text NOT NULL,           -- normalised project name, used for possible-duplicate detection only
  resolved jsonb NOT NULL DEFAULT '{}'::jsonb,   -- per-field {value, source, authority, observed_at, conflicts[]}
  status text NOT NULL DEFAULT 'requires_verification' CHECK (status IN ('active', 'reported_active', 'paused', 'closed', 'no_longer_listed', 'unknown', 'requires_verification')),
  status_basis text NOT NULL DEFAULT '',
  verification text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('official_confirmed', 'official_stale', 'community_reported', 'social_reported', 'unverified', 'conflicting')),
  merged_into uuid REFERENCES bounty_programs(id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  last_verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (merged_into IS NULL OR merged_into <> id)
);
CREATE INDEX bounty_programs_name_key_idx ON bounty_programs (name_key);

CREATE TABLE bounty_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_url text,
  submitted_text text,
  url_kind text NOT NULL CHECK (url_kind IN ('platform_programme', 'community_listing', 'web_page', 'x_post', 'x_thread', 'x_profile', 'text_only')),
  submitted_by text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  fetched_at timestamptz,
  extracted_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'blocked')),
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (submitted_url IS NOT NULL OR submitted_text IS NOT NULL),
  CHECK (submitted_text IS NULL OR length(submitted_text) <= 50000)
);

-- What one source said about one programme. Re-observing an unchanged listing updates last_observed_at only.
CREATE TABLE bounty_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES bounty_programs(id),
  source_key text NOT NULL REFERENCES bounty_sources(source_key),
  source_ref text NOT NULL,                 -- stable identity within the source (board:<platform>:<id>, an X post URL + index, ...)
  source_url text,
  source_title text,
  source_author text,
  published_at timestamptz,
  match_basis text NOT NULL CHECK (match_basis IN ('canonical_key', 'source_ref', 'name_exact', 'new_record', 'operator')),
  extraction_method text NOT NULL,
  fields jsonb NOT NULL,                    -- the normalised fields exactly as extracted from this source
  content_sha256 text NOT NULL,
  import_id uuid REFERENCES bounty_imports(id),
  check_id uuid REFERENCES bounty_source_checks(id),
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  listed boolean NOT NULL DEFAULT true,     -- false once a complete, successful source check no longer lists it
  UNIQUE (source_key, source_ref)
);
CREATE INDEX bounty_observations_program_idx ON bounty_observations (program_id);

-- Field history: nothing is silently overwritten.
CREATE TABLE bounty_program_changes (
  id bigserial PRIMARY KEY,
  program_id uuid NOT NULL REFERENCES bounty_programs(id),
  field text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  source_key text,
  observation_id uuid REFERENCES bounty_observations(id),
  check_id uuid REFERENCES bounty_source_checks(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bounty_program_changes_program_idx ON bounty_program_changes (program_id, changed_at DESC);

CREATE TABLE bounty_duplicate_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_a uuid NOT NULL REFERENCES bounty_programs(id),
  program_b uuid NOT NULL REFERENCES bounty_programs(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  CHECK (program_a < program_b),
  UNIQUE (program_a, program_b)
);

-- Deterministic scores, kept per scoring version so a change of method never erases the previous score.
CREATE TABLE bounty_scores (
  program_id uuid NOT NULL REFERENCES bounty_programs(id),
  scoring_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  priority numeric(5, 1),
  components jsonb NOT NULL,
  explanation jsonb NOT NULL,
  PRIMARY KEY (program_id, scoring_version)
);

INSERT INTO bounty_sources (source_key, kind, display_name, authority, collection_method, enabled, access_status, access_note, min_interval_seconds) VALUES
  ('community-board', 'community_index', 'Community Bug Bounty Board (bug-bounty-board.vercel.app)', 4, 'GET /programs.json (structured JSON published by the board)', true, 'permitted',
   'Owner approved as a first-class source on 2026-11-27. No published terms; robots.txt absent (404). One identified request per run.', 3600),
  ('sherlock', 'official_platform', 'Sherlock (audits.sherlock.xyz)', 3, 'GET /bug-bounties (public page; reads the listing data embedded in the page)', false, 'owner_decision_required',
   'robots.txt disallows nothing. No terms page was found (sherlock.xyz/terms and audits.sherlock.xyz/terms answer 404). One request per run.', 3600),
  ('hackenproof', 'official_platform', 'HackenProof (hackenproof.com)', 3, 'GET /programs?page=N (public server-rendered listing)', false, 'owner_decision_required',
   'robots.txt Allow: /. Terms grant a personal-use licence and forbid reproducing or publishing Content without written permission: public display needs an owner decision. About 35 pages, 2 s apart, so every 6 hours.', 21600),
  ('cantina', 'official_platform', 'Cantina (cantina.xyz)', 3, 'none: the listing is rendered in the browser from /api/, which robots.txt disallows', false, 'blocked_robots',
   'Listings come from the community board until Cantina offers a permitted feed. Terms page is client-rendered and was not readable.', 3600),
  ('immunefi', 'official_platform', 'Immunefi (immunefi.com)', 3, 'none: Terms of Use section 4 forbid robots and automated access', false, 'blocked_terms',
   'Listings come from the community board; Immunefi links are kept as official references but are not fetched. Written permission from Immunefi would change this.', 3600),
  ('x', 'social', 'X (x.com)', 5, 'pasted post or thread text with its URL; optional single-post oEmbed (publish.x.com) only after an owner decision', false, 'owner_decision_required',
   'x.com robots.txt disallows all paths for general crawlers and publish.x.com robots.txt disallows /oembed, so nothing is fetched from X by default. Threads and profiles need the paid X API.', 3600),
  ('web-import', 'manual', 'Manual URL import', 6, 'operator-submitted public URL, fetched once through the SSRF-guarded fetcher', true, 'permitted', 'One fetch per submission; robots.txt honoured.', 3600),
  ('text-import', 'manual', 'Pasted text import', 6, 'operator-pasted text with its original URL', true, 'permitted', 'Nothing is fetched.', 3600),
  ('operator', 'operator', 'Operator correction', 0, 'reviewed correction entered in the hub', true, 'permitted', 'Highest authority; every correction is recorded with its author and time.', 3600);
