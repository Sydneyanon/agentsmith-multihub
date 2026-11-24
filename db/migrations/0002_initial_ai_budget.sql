-- Initial hard AI budget policy: USD 25 per calendar month.
-- Limits are enforced by the central model gateway; these rows are the durable policy source.
ALTER TABLE budget_policies DROP CONSTRAINT budget_policies_period_check;
ALTER TABLE budget_policies
  ADD CONSTRAINT budget_policies_period_check
  CHECK (period IN ('daily','monthly','per_call','per_workflow'));

INSERT INTO budget_policies (scope, scope_key, period, limit_usd, action_on_limit)
VALUES
  ('global', 'global', 'monthly', 25.00, 'pause'),
  ('global', 'global', 'daily', 1.00, 'pause'),
  ('workflow', 'global', 'per_workflow', 0.50, 'pause'),
  ('model_tier', 'tier1', 'monthly', 5.00, 'downgrade'),
  ('model_tier', 'tier2', 'monthly', 15.00, 'downgrade'),
  ('model_tier', 'tier3', 'monthly', 5.00, 'pause'),
  ('model_call', 'tier1', 'per_call', 0.01, 'downgrade'),
  ('model_call', 'tier2', 'per_call', 0.05, 'downgrade'),
  ('model_call', 'tier3', 'per_call', 0.10, 'pause')
ON CONFLICT (scope, scope_key, period)
DO UPDATE SET limit_usd = EXCLUDED.limit_usd,
              action_on_limit = EXCLUDED.action_on_limit,
              enabled = true;
