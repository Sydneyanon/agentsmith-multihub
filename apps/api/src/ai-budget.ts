export const INITIAL_AI_BUDGET = {
  currency: "USD",
  monthlyUsd: 25,
  dailyUsd: 1,
  perWorkflowUsd: 0.5,
  perCallUsd: {
    tier1: 0.01,
    tier2: 0.05,
    tier3: 0.1,
  },
  monthlyTierUsd: {
    tier1: 5,
    tier2: 15,
    tier3: 5,
  },
  reserveUsd: 0,
} as const;

export type ModelTier = "tier1" | "tier2" | "tier3";
export type ModelTask =
  | "classify"
  | "extract"
  | "summarise"
  | "routine_triage"
  | "investigation"
  | "code_review"
  | "report_draft"
  | "hard_vulnerability_analysis"
  | "conflicting_evidence"
  | "independent_challenge";

export const MODEL_ROUTING: Record<ModelTask, ModelTier | "tier0"> = {
  classify: "tier1",
  extract: "tier1",
  summarise: "tier1",
  routine_triage: "tier1",
  investigation: "tier2",
  code_review: "tier2",
  report_draft: "tier2",
  hard_vulnerability_analysis: "tier3",
  conflicting_evidence: "tier3",
  independent_challenge: "tier3",
};

export type BudgetSnapshot = {
  monthlySpentUsd: number;
  dailySpentUsd: number;
  workflowSpentUsd: number;
  tierMonthlySpentUsd: Record<ModelTier, number>;
  emergencyStop?: boolean;
};

export type BudgetDecision =
  | { allowed: true; tier: ModelTier; maximumSpendUsd: number; reason: string }
  | { allowed: false; tier: ModelTier | "tier0"; reason: string };

const EPSILON = 1e-9;

/** Deterministic, fail-closed preflight. Call before every provider request. */
export function checkModelCallBudget(
  task: ModelTask,
  estimatedWorstCaseUsd: number,
  snapshot: BudgetSnapshot,
): BudgetDecision {
  const tier = MODEL_ROUTING[task];
  if (tier === "tier0") return { allowed: false, tier, reason: "tier0_must_run_without_a_model" };
  if (snapshot.emergencyStop) return { allowed: false, tier, reason: "global_emergency_stop" };
  if (!Number.isFinite(estimatedWorstCaseUsd) || estimatedWorstCaseUsd < 0) {
    return { allowed: false, tier, reason: "invalid_cost_estimate" };
  }
  if (estimatedWorstCaseUsd > INITIAL_AI_BUDGET.perCallUsd[tier] + EPSILON) {
    return { allowed: false, tier, reason: "per_call_cap_exceeded" };
  }
  if (snapshot.monthlySpentUsd + estimatedWorstCaseUsd > INITIAL_AI_BUDGET.monthlyUsd + EPSILON) {
    return { allowed: false, tier, reason: "monthly_cap_exceeded" };
  }
  if (snapshot.dailySpentUsd + estimatedWorstCaseUsd > INITIAL_AI_BUDGET.dailyUsd + EPSILON) {
    return { allowed: false, tier, reason: "daily_cap_exceeded" };
  }
  if (snapshot.workflowSpentUsd + estimatedWorstCaseUsd > INITIAL_AI_BUDGET.perWorkflowUsd + EPSILON) {
    return { allowed: false, tier, reason: "workflow_cap_exceeded" };
  }
  if (snapshot.tierMonthlySpentUsd[tier] + estimatedWorstCaseUsd > INITIAL_AI_BUDGET.monthlyTierUsd[tier] + EPSILON) {
    return { allowed: false, tier, reason: "tier_monthly_allocation_exceeded" };
  }
  return {
    allowed: true,
    tier,
    maximumSpendUsd: INITIAL_AI_BUDGET.perCallUsd[tier],
    reason: "within_all_hard_caps",
  };
}

export function createEmptyBudgetSnapshot(): BudgetSnapshot {
  return {
    monthlySpentUsd: 0,
    dailySpentUsd: 0,
    workflowSpentUsd: 0,
    tierMonthlySpentUsd: { tier1: 0, tier2: 0, tier3: 0 },
    emergencyStop: false,
  };
}
