-- MultiHub initial relational foundation.
-- Append-only evidence and audit records; mutable operational state is versioned.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  platform text,
  source_url text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE program_scope_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES programs(id),
  version integer NOT NULL CHECK (version > 0),
  scope_document jsonb NOT NULL,
  source_snapshot text,
  valid_from timestamptz,
  valid_until timestamptz,
  verified_at timestamptz,
  verified_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, version),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,
  asset_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_name, asset_type)
);

CREATE TABLE program_assets (
  program_id uuid NOT NULL REFERENCES programs(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  scope_version_id uuid NOT NULL REFERENCES program_scope_versions(id),
  scope_status text NOT NULL CHECK (scope_status IN ('in_scope','out_of_scope','excluded','unknown')),
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, asset_id, scope_version_id)
);

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','awaiting_approval','succeeded','failed','rejected','cancelled')),
  program_id uuid REFERENCES programs(id),
  scope_version_id uuid REFERENCES program_scope_versions(id),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX workflow_runs_status_created_idx ON workflow_runs(status, created_at);

CREATE TABLE workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  step_key text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  role text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','awaiting_approval','succeeded','failed','rejected','cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, step_key),
  UNIQUE (workflow_run_id, sequence)
);

CREATE INDEX workflow_steps_claim_idx ON workflow_steps(status, lease_expires_at, created_at);

CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES programs(id),
  asset_id uuid REFERENCES assets(id),
  workflow_run_id uuid REFERENCES workflow_runs(id),
  title text NOT NULL,
  description text NOT NULL,
  severity text NOT NULL DEFAULT 'untriaged'
    CHECK (severity IN ('untriaged','informational','low','medium','high','critical')),
  status text NOT NULL DEFAULT 'hypothesis'
    CHECK (status IN ('hypothesis','needs_evidence','under_review','verified','rejected','reported','resolved')),
  confidence numeric(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finding_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES findings(id),
  evidence_type text NOT NULL,
  source_uri text,
  content_location text,
  content_hash text,
  redaction_status text NOT NULL DEFAULT 'pending'
    CHECK (redaction_status IN ('pending','redacted','not_required')),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES findings(id),
  reviewer_role text NOT NULL DEFAULT 'independent_judge',
  verdict text NOT NULL CHECK (verdict IN ('verified','rejected','inconclusive','needs_more_evidence')),
  rationale text NOT NULL,
  criteria_version text NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  requested_by text NOT NULL,
  decided_by text,
  reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  correlation_id uuid,
  reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at);
CREATE INDEX audit_events_correlation_idx ON audit_events(correlation_id);

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  source_uri text,
  source_hash text,
  confidence numeric(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid REFERENCES knowledge_items(id)
);

CREATE TABLE knowledge_links (
  from_item_id uuid NOT NULL REFERENCES knowledge_items(id),
  to_item_id uuid NOT NULL REFERENCES knowledge_items(id),
  relation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_item_id, to_item_id, relation),
  CHECK (from_item_id <> to_item_id)
);

CREATE TABLE model_usage_events (
  id bigserial PRIMARY KEY,
  workflow_run_id uuid REFERENCES workflow_runs(id),
  workflow_step_id uuid REFERENCES workflow_steps(id),
  provider text NOT NULL,
  model text NOT NULL,
  purpose text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  estimated_cost_usd numeric(14,8) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX model_usage_created_idx ON model_usage_events(created_at);

CREATE TABLE budget_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  scope_key text NOT NULL DEFAULT 'global',
  period text NOT NULL CHECK (period IN ('daily','monthly')),
  limit_usd numeric(12,4) NOT NULL CHECK (limit_usd > 0),
  action_on_limit text NOT NULL DEFAULT 'pause'
    CHECK (action_on_limit IN ('pause','downgrade','approval_required')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, scope_key, period)
);
