import { describe, expect, it } from "vitest";
import { calculateActualCost, estimateWorstCaseCost } from "./ai-budget-gateway.js";

const price = {
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 4,
  maxInputTokens: 10_000,
  maxOutputTokens: 2_000,
  promptVersion: "investigator-v1",
};

describe("AI gateway cost accounting", () => {
  it("reserves worst-case input and output cost before a provider call", () => {
    expect(estimateWorstCaseCost(price)).toBeCloseTo(0.018);
  });

  it("reconciles actual usage using the versioned price", () => {
    expect(calculateActualCost(price, { inputTokens: 5_000, outputTokens: 1_000 })).toBeCloseTo(0.009);
  });

  it("rejects provider usage beyond configured token ceilings", () => {
    expect(() => calculateActualCost(price, { inputTokens: 10_001, outputTokens: 1 })).toThrow(
      "Provider usage exceeded validated token limits",
    );
  });

  it("rejects invalid or unbounded price configuration", () => {
    expect(() => estimateWorstCaseCost({ ...price, maxOutputTokens: 0 })).toThrow();
    expect(() => estimateWorstCaseCost({ ...price, outputUsdPerMillionTokens: Number.NaN })).toThrow();
  });
});
