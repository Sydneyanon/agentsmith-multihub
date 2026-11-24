import { describe, expect, it, vi } from "vitest";
import { processIntakeResolution, processProjectIdentification } from "./worker-runtime.js";
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
  const persistSourceSnapshot = vi.fn().mockResolvedValue({ id: "snapshot-1", contentSha256: "a".repeat(64) });
  return { complete, persistSourceSnapshot, worker: { complete, persistSourceSnapshot } as unknown as WorkflowWorker };
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
  it("identifies a public GitHub repository through the fixed API host", async () => {
    const { complete, worker } = fakeWorker();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 123,
      full_name: "example/project",
      html_url: "https://github.com/example/project",
      description: "Example project",
      default_branch: "main",
      language: "TypeScript",
      archived: false,
      disabled: false,
      visibility: "public",
      updated_at: "2026-11-01T00:00:00Z",
      stargazers_count: 12,
      forks_count: 3,
      topics: ["security"],
      license: { spdx_id: "MIT", name: "MIT License" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await processProjectIdentification(worker, step({
        intake_kind: "url",
        value: "https://github.com/example/project",
        source_reference: {
          host: "github.com",
          kind: "github_repository",
          repository: { owner: "example", name: "project", url: "https://github.com/example/project" },
        },
        execution_mode: "passive_only",
        authorization_status: "unverified",
      }));
      expect(result).toEqual({ status: "completed", stepId: "step-1" });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(persistSourceSnapshot).toHaveBeenCalledOnce();
      expect(persistSourceSnapshot.mock.calls[0]?.[0]).toBe("step-1");
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/example/project");
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", method: "GET" });
      expect(complete.mock.calls[0]?.[1]).toMatchObject({
        status: "identified",
        repository: { full_name: "example/project", language: "TypeScript" },
        evidence: { snapshot_id: "snapshot-1", content_sha256: "a".repeat(64) },
        network_access_performed: true,
        authorization_status: "unverified",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not call the network for an idea", async () => {
    const { complete, worker } = fakeWorker();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await processProjectIdentification(worker, step({
        intake_kind: "idea",
        value: "Review authorization logic",
        execution_mode: "passive_only",
        authorization_status: "unverified",
      }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(complete.mock.calls[0]?.[1]).toMatchObject({ status: "not_applicable", network_access_performed: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects GitHub API redirects instead of following them", async () => {
    const { complete, worker } = fakeWorker();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/" },
    })));
    try {
      await expect(processProjectIdentification(worker, step({
        intake_kind: "url",
        value: "https://github.com/example/project",
        source_reference: { repository: { owner: "example", name: "project" } },
        execution_mode: "passive_only",
        authorization_status: "unverified",
      }))).rejects.toThrow("redirect rejected");
      expect(complete).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

});
