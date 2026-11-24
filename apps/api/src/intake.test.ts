import { describe, expect, it } from "vitest";
import { intakeSchema, isAllowedIntakeUrl } from "./intake.js";

describe("research intake validation", () => {
  it("accepts a project URL with optional notes", () => {
    const result = intakeSchema.safeParse({
      kind: "url",
      value: "https://github.com/example/project",
      source: "user",
      notes: "Review the withdrawal flow",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a plain research idea", () => {
    const result = intakeSchema.safeParse({
      kind: "idea",
      value: "Check whether role changes invalidate existing sessions",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty and oversized submissions", () => {
    expect(intakeSchema.safeParse({ kind: "idea", value: " " }).success).toBe(false);
    expect(intakeSchema.safeParse({ kind: "idea", value: "x".repeat(4_001) }).success).toBe(false);
  });

  it("rejects unexpected fields", () => {
    expect(intakeSchema.safeParse({
      kind: "idea",
      value: "Test idea",
      execute_now: true,
    }).success).toBe(false);
  });

  it("only permits HTTP and HTTPS URL schemes", () => {
    expect(isAllowedIntakeUrl("https://example.com")).toBe(true);
    expect(isAllowedIntakeUrl("http://example.com")).toBe(true);
    expect(isAllowedIntakeUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedIntakeUrl("javascript:alert(1)")).toBe(false);
  });
});
