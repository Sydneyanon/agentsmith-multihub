-- Phase 5.0: autonomous bounty discovery and source monitoring.
-- Passive by construction: these tables record what public sources said, when, and what a human decided. Nothing here authorises
-- contact with a project, active testing or any submission. Sources are created DISABLED and fetching is off until a human enables it.

CREATE TABLE discovery_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE CHECK (source_key ~ '^[a-z0-9][a-z0-9_.-]{1,80}$'),
  adapter text NOT NULL CHECK (adapter IN ('github_org_repos')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  config jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  min_interval_seconds integer NOT NULL DEFAULT 3600 CHECK (min_interval_seconds BETWEEN 300 AND 604800),
  etag text CHECK (etag IS NULL OR length(etag) <= 200),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_by text NOT NULL DEFAULT 'operator',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per fetch attempt: what was requested, what came back (hash and size, never the body), and the outcome.
CREATE TABLE discovery_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES discovery_sources(id),
  workflow_run_id uuid REFERENCES workflow_runs(id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  url text NOT NULL CHECK (length(url) <= 2000),
  http_status integer,
  outcome text NOT NULL CHECK (outcome IN ('ok','not_modified','failed')),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 100),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer CHECK (bytes IS NULL OR bytes >= 0),
  items_seen integer CHECK (items_seen IS NULL OR items_seen >= 0),
  CHECK ((outcome = 'ok') = (content_sha256 IS NOT NULL)),
  CHECK ((outcome = 'failed') = (error_code IS NOT NULL))
);
CREATE INDEX discovery_observations_source_idx ON discovery_observations (source_id, observed_at DESC);
CREATE TRIGGER discovery_observations_immutable BEFORE UPDATE OR DELETE ON discovery_observations
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

CREATE TABLE bounty_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key text NOT NULL UNIQUE CHECK (canonical_key ~ '^[a-z0-9:_./-]{3,255}$'),
  source_id uuid NOT NULL REFERENCES discovery_sources(id),
  platform text NOT NULL CHECK (platform ~ '^[a-z0-9][a-z0-9_-]{1,60}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  state text NOT NULL DEFAULT 'discovered' CHECK (state IN ('discovered','approved','queued','dismissed','closed')),
  source_url text NOT NULL CHECK (length(source_url) <= 2000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  repository_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority_score integer NOT NULL DEFAULT 0 CHECK (priority_score BETWEEN 0 AND 100),
  priority_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bounty_opportunities_state_idx ON bounty_opportunities (state, priority_score DESC, last_seen_at DESC);

-- Append-only lifecycle. A human decision (approved, dismissed) is always a 'human' actor with an id; 'queued' records the research
-- run it created. The row above is a convenience projection of the latest events.
CREATE TABLE opportunity_events (
  seq bigserial PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES bounty_opportunities(id),
  event_type text NOT NULL CHECK (event_type IN ('discovered','updated','closed','approved','dismissed','queued')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('monitor','human')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  observation_id uuid REFERENCES discovery_observations(id),
  research_run_id uuid REFERENCES workflow_runs(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type NOT IN ('approved','dismissed') OR actor_kind = 'human'),
  CHECK ((event_type = 'queued') = (research_run_id IS NOT NULL))
);
CREATE INDEX opportunity_events_opportunity_idx ON opportunity_events (opportunity_id, seq);
CREATE TRIGGER opportunity_events_immutable BEFORE UPDATE OR DELETE ON opportunity_events
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
