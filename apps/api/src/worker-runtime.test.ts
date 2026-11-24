import { describe, expect, it, vi } from "vitest";
import { processIntakeResolution } from "./worker-runtime.js";
import type { ClaimedStep, WorkflowWorker } from "./worker.js";

function step(input: Record<string, unknown>): ClaimedStep {
  return {
    id: "step-1",
    workflow_run_id: "run-1",
    step_key: "resolve_source",
    sequence: 0,
    role: "intake",
    attempt: 1,
    input,
    correlation_id: "correlation-1",
  };
}

function fakeWorker() {
  const complete = vi.fn().mockResolvedValue(undefined);
  return { complete, worker: { complete } as unknown as WorkflowWorker };
}

describe("passive intake resolution worker", () => {
  it("normalizes a GitHub URL without making a network request", async () => {
    const { complete, worker } = fakeWorker();
    const result = await processIntakeResolution(worker, step({
      intake_kind: "url",
      value: "https://github.com/example/project#readme",
      source: "user",
      source_reference: {
        submittedUrl: "https://github.com/example/project#readme",
        canonicalUrl: "https://github.com/example/project",
        host: "github.com",
        kind: "github_repository",
        repository: { owner: "example", name: "project", url: "https://github.com/example/project" },
      },
      execution_mode: "passive_only",
      authorization_status: "unverified",
    }));
    expect(result).toEqual({ status: "completed", stepId: "step-1" });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[1]).toMatchObject({
      execution_mode: "passive_only",
      authorization_status: "unverified",
      network_access_performed: false,
      source_reference: { kind: "github_repository", host: "github.com" },
    });
  });

  it("records ideas without inventing a URL reference", async () => {
    const { complete, worker } = fakeWorker();
    await processIntakeResolution(worker, step({
      intake_kind: "idea",
      value: "Review withdrawal authorization edge cases",
      execution_mode: "passive_only",
      authorization_status: "unverified",
    }));
    expect(complete.mock.calls[0]?.[1]).toMatchObject({
      intake_kind: "idea",
      source_reference: null,
      network_access_performed: false,
    });
  });

  it("fails closed if persisted source metadata has drifted", async () => {
    const { complete, worker } = fakeWorker();
    await expect(processIntakeResolution(worker, step({
      intake_kind: "url",
      value: "https://github.com/example/project",
      source_reference: { kind: "web_page" },
      execution_mode: "passive_only",
      authorization_status: "unverified",
    }))).rejects.toThrow("Stored source reference does not match deterministic URL resolution");
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects attempts to use the intake resolver for another workflow step", async () => {
    const { worker } = fakeWorker();
    await expect(processIntakeResolution(worker, { ...step({}), step_key: "map_attack_surface" }))
      .rejects.toThrow("Unsupported step");
  });
});
