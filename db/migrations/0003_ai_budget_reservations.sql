-- Atomic pre-call reservations prevent concurrent workers overspending shared caps.\nALTER TABLE model_usage_events ADD COLUMN tier text CHECK (tier IS NULL OR tier IN ('tier1','tier2','tier3'));
CREATE TABLE ai_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid REFERENCES workflow_runs(id),
  workflow_step_id uuid REFERENCES workflow_steps(id),
  provider text NOT NULL,
  model text NOT NULL,
  purpose text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('tier1','tier2','tier3')),
  reserved_usd numeric(14,8) NOT NULL CHECK (reserved_usd > 0),
  charged_usd numeric(14,8),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','reconciled','released','failed_charged')),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  prompt_version text,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX ai_budget_reservations_status_created_idx
  ON ai_budget_reservations(status, created_at);
CREATE INDEX ai_budget_reservations_workflow_idx
  ON ai_budget_reservations(workflow_run_id, created_at);
