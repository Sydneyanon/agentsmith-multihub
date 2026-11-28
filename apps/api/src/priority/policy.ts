/**
 * Priority policy v1 (T-051). Human-reviewed, versioned weights; no learned parameters and no probabilities.
 * Changing any value is a recorded decision: bump `version` and say why in the design document.
 */
export type PriorityPolicy = {
  version: string;
  /** share of research capacity reserved for exploration (owner decision 2026-11-26: 0.20; configurable; changed only on recorded evidence) */
  explorationShare: number;
  weights: {
    reward: number; deadline: number; freshness: number; recentChange: number; unexplored: number; scopeVerified: number;
    eligibilityKnown: number; saturationPenalty: number; costPenalty: number; uncertaintyPenalty: number;
  };
  freshnessHalfLifeDays: number;
  rewardScaleUsd: number;
};

export const POLICY_V1: PriorityPolicy = {
  version: "priority-policy/1",
  explorationShare: 0.2,
  weights: { reward: 25, deadline: 10, freshness: 10, recentChange: 15, unexplored: 20, scopeVerified: 5, eligibilityKnown: 5, saturationPenalty: 20, costPenalty: 10, uncertaintyPenalty: 5 },
  freshnessHalfLifeDays: 14,
  rewardScaleUsd: 1_000_000,
};
