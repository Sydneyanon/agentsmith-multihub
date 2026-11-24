import { describe, expect, it } from "vitest";
import {
  checkModelCallBudget,
  createEmptyBudgetSnapshot,
  INITIAL_AI_BUDGET,
  MODEL_ROUTING,
} from "./ai-budget.js";

describe("initial AI budget policy", () => {
  it("sets the monthly ceiling to exactly US$25", () => {
    expect(INITIAL_AI_BUDGET.monthlyUsd).toBe(25);
  });

  it("routes deterministic work away from models", () => {
    expect(MODEL_ROUTING.classify).toBe("tier1");
    expect(MODEL_ROUTING.code_review).toBe("tier2");
    expect(MODEL_ROUTING.independent_challenge).toBe("tier3");
  });

  it("allows an in-cap call and returns the selected tier", () => {
    const decision = checkModelCallBudget("code_review", 0.04, createEmptyBudgetSnapshot());
    expect(decision).toMatchObject({ allowed: true, tier: "tier2" });
  });

  it("blocks a call above its per-call ceiling", () => {
    const decision = checkModelCallBudget("code_review", 0.051, createEmptyBudgetSnapshot());
    expect(decision).toMatchObject({ allowed: false, reason: "per_call_cap_exceeded" });
  });

  it("blocks spend that would cross the monthly ceiling", () => {
    const snapshot = { ...createEmptyBudgetSnapshot(), monthlySpentUsd: 24.98 };
    expect(checkModelCallBudget("classify", 0.01, snapshot)).toMatchObject({
      allowed: false,
      reason: "monthly_cap_exceeded",
    });
  });

  it("blocks spend that would cross the daily or workflow ceiling", () => {
    const daily = { ...createEmptyBudgetSnapshot(), dailySpentUsd: 0.995 };
    expect(checkModelCallBudget("classify", 0.01, daily)).toMatchObject({
      allowed: false,
      reason: "daily_cap_exceeded",
    });
    const workflow = { ...createEmptyBudgetSnapshot(), workflowSpentUsd: 0.495 };
    expect(checkModelCallBudget("classify", 0.01, workflow)).toMatchObject({
      allowed: false,
      reason: "workflow_cap_exceeded",
    });
  });

  it("blocks exhausted tier allocations and emergency stop", () => {
    const tier = {
      ...createEmptyBudgetSnapshot(),
      tierMonthlySpentUsd: { tier1: 5, tier2: 0, tier3: 0 },
    };
    expect(checkModelCallBudget("classify", 0.001, tier)).toMatchObject({
      allowed: false,
      reason: "tier_monthly_allocation_exceeded",
    });
    const stopped = { ...createEmptyBudgetSnapshot(), emergencyStop: true };
    expect(checkModelCallBudget("classify", 0.001, stopped)).toMatchObject({
      allowed: false,
      reason: "global_emergency_stop",
    });
  });
});
