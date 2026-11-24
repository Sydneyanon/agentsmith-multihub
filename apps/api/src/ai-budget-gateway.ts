import type { Pool } from "pg";
import { MODEL_ROUTING, type ModelTask, type ModelTier } from "./ai-budget.js";\nimport { config } from "./config.js";

export type ModelPrice = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  promptVersion: string;
};

export type ModelRequest = {
  system: string;
  user: string;
  metadata?: Record<string, unknown>;
};

export type ModelResponse = {
  text: string;
  inputTokens: number;
  outputTokens: number;
};

export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  generate(request: ModelRequest, limits: { maxInputTokens: number; maxOutputTokens: number }): Promise<ModelResponse>;
}

export type GatewayTask = {
  task: ModelTask;
  request: ModelRequest;
  adapter: ModelAdapter;
  workflowRunId?: string;
  workflowStepId?: string;
  emergencyStop?: boolean;
};

export type GatewayResult =
  | { status: "completed"; text: string; costUsd: number; tier: ModelTier; reservationId: string }
  | { status: "blocked"; reason: string; tier: ModelTier | "tier0" };

type PolicyRow = { scope: string; scope_key: string; period: string; limit_usd: string };

const toNumber = (value: unknown): number => Number(value ?? 0);
const money = (value: number): string => value.toFixed(8);

export function estimateWorstCaseCost(price: ModelPrice): number {
  const values = [
    price.inputUsdPerMillionTokens,
    price.outputUsdPerMillionTokens,
    price.maxInputTokens,
    price.maxOutputTokens,
  ];
  if (values.some((v) => !Number.isFinite(v) || v < 0) ||
      price.maxInputTokens < 1 || price.maxOutputTokens < 1) {
    throw new Error("Model pricing and token limits must be finite, non-negative, and bounded");
  }
  return (price.inputUsdPerMillionTokens * price.maxInputTokens +
    price.outputUsdPerMillionTokens * price.maxOutputTokens) / 1_000_000;
}

export function calculateActualCost(price: ModelPrice, usage: Pick<ModelResponse, "inputTokens" | "outputTokens">): number {
  if (!Number.isInteger(usage.inputTokens) || !Number.isInteger(usage.outputTokens) ||
      usage.inputTokens < 0 || usage.outputTokens < 0 ||
      usage.inputTokens > price.maxInputTokens || usage.outputTokens > price.maxOutputTokens) {
    throw new Error("Provider usage exceeded validated token limits");
  }
  return (price.inputUsdPerMillionTokens * usage.inputTokens +
    price.outputUsdPerMillionTokens * usage.outputTokens) / 1_000_000;
}

/**
 * All provider requests must pass through this gateway. Pricing is injected
 * from a reviewed, versioned catalog; unknown prices fail closed.
 */
export class AiBudgetGateway {
  constructor(
    private readonly pool: Pool,
    private readonly emergencyStop = config.aiBudgetEmergencyStop,
  ) {}

  async execute(input: GatewayTask): Promise<GatewayResult> {
    const tier = MODEL_ROUTING[input.task];
    if (tier === "tier0") return { status: "blocked", reason: "tier0_must_run_without_a_model", tier: "tier0" };
    if (!input.workflowRunId) {\n      return { status: "blocked", reason: "workflow_context_required", tier };\n    }\n    if (this.emergencyStop || input.emergencyStop) {
      return { status: "blocked", reason: "global_emergency_stop", tier };
    }

    let reserveUsd: number;
    try {
      reserveUsd = estimateWorstCaseCost(price);
    } catch {
      return { status: "blocked", reason: "unknown_or_invalid_pricing", tier };
    }

    if (reserveUsd <= 0) return { status: "blocked", reason: "zero_or_invalid_price", tier };\n\n    const reservation = await this.reserve(input, tier, reserveUsd, price.promptVersion, price.priceVersion);
    if (!reservation.allowed) return { status: "blocked", reason: reservation.reason, tier };

    const startedAt = Date.now();
    try {
      const response = await input.adapter.generate(input.request, {
        maxInputTokens: price.maxInputTokens,
        maxOutputTokens: price.maxOutputTokens,
      });
      const actualUsd = calculateActualCost(price, response);
      await this.settle({
        reservationId: reservation.id,
        workflowRunId: input.workflowRunId,
        workflowStepId: input.workflowStepId,
        provider: input.adapter.provider,
        model: input.adapter.model,
        purpose: input.task,
        tier,
        promptVersion: price.promptVersion,\n        priceVersion: price.priceVersion,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        actualUsd,
        latencyMs: Date.now() - startedAt,
      });
      return {
        status: "completed",
        text: response.text,
        costUsd: actualUsd,
        tier,
        reservationId: reservation.id,
      };
    } catch (error) {
      // Provider failures may still be billable. Charge the full reservation
      // rather than releasing money that may already have been spent.
      await this.failCharged(reservation.id, reserveUsd, input.adapter.provider, input.adapter.model, input.task, tier,
        Date.now() - startedAt, error instanceof Error ? error.message : "unknown_provider_error", price.priceVersion);
      throw error;
    }
  }

  private async reserve(
    input: GatewayTask,
    tier: ModelTier,
    amountUsd: number,
  ): Promise<{ allowed: true; id: string } | { allowed: false; reason: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agentsmith-multihub-ai-budget'))");

      const policies = await client.query<PolicyRow>(
        "SELECT scope, scope_key, period, limit_usd FROM budget_policies WHERE enabled = true",
      );
      const limit = (scope: string, key: string, period: string): number | undefined => {
        const row = policies.rows.find((p) => p.scope === scope && p.scope_key === key && p.period === period);
        return row ? toNumber(row.limit_usd) : undefined;
      };
      const monthlyCap = limit("global", "global", "monthly");
      const dailyCap = limit("global", "global", "daily");
      const workflowCap = limit("workflow", "global", "per_workflow");
      const callCap = limit("model_call", tier, "per_call");
      const tierCap = limit("model_tier", tier, "monthly");
      if ([monthlyCap, dailyCap, workflowCap, callCap, tierCap].some((v) => v === undefined)) {
        await client.query("ROLLBACK");
        return { allowed: false, reason: "budget_policy_missing" };
      }
      if (amountUsd > callCap! + 1e-9) {
        await client.query("ROLLBACK");
        return { allowed: false, reason: "per_call_cap_exceeded" };
      }

      const totals = await client.query<{
        month_spent: string; day_spent: string; workflow_spent: string; tier_month_spent: string;
      }>(
        `SELECT
          COALESCE((SELECT sum(estimated_cost_usd) FROM model_usage_events
            WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)
          + COALESCE((SELECT sum(reserved_usd) FROM ai_budget_reservations
            WHERE status = 'reserved' AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS month_spent,
          COALESCE((SELECT sum(estimated_cost_usd) FROM model_usage_events
            WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)
          + COALESCE((SELECT sum(reserved_usd) FROM ai_budget_reservations
            WHERE status = 'reserved' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS day_spent,
          COALESCE((SELECT sum(estimated_cost_usd) FROM model_usage_events
            WHERE workflow_run_id = $1), 0)
          + COALESCE((SELECT sum(reserved_usd) FROM ai_budget_reservations
            WHERE workflow_run_id = $1 AND status = 'reserved'), 0) AS workflow_spent,
          COALESCE((SELECT sum(estimated_cost_usd) FROM model_usage_events
            WHERE tier = $2 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)
          + COALESCE((SELECT sum(reserved_usd) FROM ai_budget_reservations
            WHERE tier = $2 AND status = 'reserved'
              AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS tier_month_spent`,
        [input.workflowRunId ?? null, tier],
      );
      const totalsRow = totals.rows[0]!;
      const checks: Array<[number, number, string]> = [
        [toNumber(totalsRow.month_spent), monthlyCap!, "monthly_cap_exceeded"],
        [toNumber(totalsRow.day_spent), dailyCap!, "daily_cap_exceeded"],
        [toNumber(totalsRow.workflow_spent), workflowCap!, "workflow_cap_exceeded"],
        [toNumber(totalsRow.tier_month_spent), tierCap!, "tier_monthly_allocation_exceeded"],
      ];
      for (const [spent, cap, reason] of checks) {
        if (spent + amountUsd > cap + 1e-9) {
          await client.query("ROLLBACK");
          return { allowed: false, reason };
        }
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ai_budget_reservations
          (workflow_run_id, workflow_step_id, provider, model, purpose, tier, reserved_usd, prompt_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [input.workflowRunId ?? null, input.workflowStepId ?? null, input.adapter.provider,
          input.adapter.model, input.task, tier, money(amountUsd), promptVersion],
      );
      await client.query("COMMIT");
      return { allowed: true, id: inserted.rows[0]!.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async settle(input: {
    reservationId: string; workflowRunId?: string; workflowStepId?: string;
    provider: string; model: string; purpose: string; tier: ModelTier; promptVersion: string;
    inputTokens: number; outputTokens: number; actualUsd: number; latencyMs: number;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE ai_budget_reservations SET status = 'reconciled', charged_usd = $2,
          input_tokens = $3, output_tokens = $4, prompt_version = $5, latency_ms = $6, settled_at = now()
         WHERE id = $1 AND status = 'reserved'`,
        [input.reservationId, money(input.actualUsd), input.inputTokens, input.outputTokens,
          input.promptVersion, input.latencyMs],
      );
      if (updated.rowCount !== 1) throw new Error("AI budget reservation could not be reconciled");
      await client.query(
        `INSERT INTO model_usage_events
          (workflow_run_id, workflow_step_id, provider, model, purpose, tier,
           input_tokens, output_tokens, estimated_cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [input.workflowRunId ?? null, input.workflowStepId ?? null, input.provider, input.model,
          input.purpose, input.tier, input.inputTokens, input.outputTokens, money(input.actualUsd)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async failCharged(
    reservationId: string, amountUsd: number, provider: string, model: string,
    purpose: string, tier: ModelTier, latencyMs: number, reason: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE ai_budget_reservations SET status = 'failed_charged', charged_usd = $2,
          latency_ms = $3, error_code = left($4, 200), settled_at = now()
         WHERE id = $1 AND status = 'reserved'
         RETURNING workflow_run_id, workflow_step_id`,
        [reservationId, money(amountUsd), latencyMs, reason],
      );
      if (updated.rowCount === 1) {
        const row = updated.rows[0]!;
        await client.query(
          `INSERT INTO model_usage_events
            (workflow_run_id, workflow_step_id, provider, model, purpose, tier, estimated_cost_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [row.workflow_run_id, row.workflow_step_id, provider, model, purpose, tier, money(amountUsd)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
