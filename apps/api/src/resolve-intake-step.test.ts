import { describe, expect, it, vi } from "vitest";
import { resolveIntakeStep } from "./resolve-intake-step.js";

const record = (input: Record<string, unknown>) => ({
  workflow_type: "link_or_idea_intake",
  input: {
    execution_mode: "passive_only",
    authorization_status: "unverified",
    ...input,
  },
});

describe("resolveIntakeStep", () => {
  it("resolves a URL without network access or assuming authorization", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [record({
      kind: "url", value: "https://github.com/example/project",
    })] });
    const result = await resolveIntakeStep({ query } as never, "run-id");
    expect(query).toHaveBeenCalledWith(
      "SELECT workflow_type, input FROM workflow_runs WHERE id = $1",
      ["run-id"],
    );
    expect(result.network_access_performed).toBe(false);
    expect(result.requires_authorization).toBe(true);
    expect(result.kind).toBe("url");
  });

  it("keeps ideas as hypotheses", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [record({
      kind: "idea", value: "Investigate a possible accounting invariant",
    })] });
    const result = await resolveIntakeStep({ query } as never, "run-id");
    expect(result.kind).toBe("idea");
    expect(result.requires_authorization).toBe(true);
  });

  it("fails closed if the safety state changes", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [record({
      kind: "url", value: "https://example.com", execution_mode: "active",
    })] });
    await expect(resolveIntakeStep({ query } as never, "run-id")).rejects.toThrow(
      "Unexpected intake safety state",
    );
  });

  it("rejects missing workflows", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(resolveIntakeStep({ query } as never, "run-id")).rejects.toThrow(
      "Unsupported or missing intake workflow",
    );
  });
});
