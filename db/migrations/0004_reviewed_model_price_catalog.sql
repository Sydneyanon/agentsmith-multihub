-- Versioned, reviewed provider prices. No provider/model is enabled by default.
CREATE TABLE ai_model_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  price_version text NOT NULL,
  input_usd_per_million_tokens numeric(16,8) NOT NULL CHECK (input_usd_per_million_tokens > 0),
  output_usd_per_million_tokens numeric(16,8) NOT NULL CHECK (output_usd_per_million_tokens > 0),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 2000000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 2000000),
  enabled boolean NOT NULL DEFAULT false,
  reviewed_by text,
  reviewed_at timestamptz,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, price_version),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (NOT enabled OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX ai_model_prices_lookup_idx
  ON ai_model_prices(provider, model, enabled, valid_from DESC);

ALTER TABLE ai_budget_reservations ADD COLUMN price_version text;
ALTER TABLE model_usage_events ADD COLUMN price_version text;

ALTER TABLE ai_budget_reservations
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes');
