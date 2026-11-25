import { describe, expect, it, vi } from "vitest";
import { processAttackSurfaceMapping, processAuthorizationGate, processHypothesisGeneration, processIndependentChallenge, processResearchBrief, processIntakeResolution, processProjectIdentification, processRepositoryAcquisition } from "./worker-runtime.js";
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
  const heartbeat = vi.fn().mockResolvedValue(true);
  return { complete, persistSourceSnapshot, heartbeat, worker: { complete, persistSourceSnapshot, heartbeat } as unknown as WorkflowWorker };
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
    const { complete, persistSourceSnapshot, worker } = fakeWorker();
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

  it("retrieves a bounded GitHub source sample and persists it as immutable evidence", async () => {
    const { complete, persistSourceSnapshot, worker } = fakeWorker();
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{
        output: {
          status: "identified",
          repository: { full_name: "example/project", default_branch: "main" },
        },
      }] }),
    } as unknown as import("pg").Pool;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", size: 40, sha: "readme-sha" },
          { path: "contracts/Vault.sol", type: "blob", size: 50, sha: "vault-sha" },
          { path: "node_modules/evil/index.js", type: "blob", size: 100, sha: "excluded" },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("# Example\nSafe source sample\n", { status: 200 }))
      .mockResolvedValueOnce(new Response("contract Vault {}\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await processRepositoryAcquisition(pool, worker, {
        ...step({}), step_key: "locate_official_repositories",
      });
      expect(result).toEqual({ status: "completed", stepId: "step-1" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0]?.[0]).toContain("api.github.com/repos/example/project/git/trees/main");
      expect(persistSourceSnapshot).toHaveBeenCalledOnce();
      const snapshotArg = persistSourceSnapshot.mock.calls[0]?.[1] as { content: { files: Array<{ path: string }> } };
      expect(snapshotArg.content.files.map((file) => file.path)).toEqual(["README.md", "contracts/Vault.sol"]);
      expect(complete.mock.calls[0]?.[1]).toMatchObject({
        status: "source_sampled",
        repository: "example/project",
        file_count: 2,
        code_executed: false,
        authorization_status: "unverified",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an oversized repository tree before selecting or persisting files", async () => {
    const { complete, persistSourceSnapshot, worker } = fakeWorker();
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{
        output: { status: "identified", repository: { full_name: "example/project", default_branch: "main" } },
      }] }),
    } as unknown as import("pg").Pool;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tree: [],
      padding: "x".repeat(2_000_100),
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(processRepositoryAcquisition(pool, worker, {
        ...step({}), step_key: "locate_official_repositories",
      })).rejects.toThrow("byte limit");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(persistSourceSnapshot).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps active testing blocked when no verified scope and approval exist", async () => {
    const { complete, worker } = fakeWorker();
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ input: { kind: "url" } }] }) } as unknown as import("pg").Pool;
    await processAuthorizationGate(pool, worker, { ...step({}), step_key: "establish_authorization" });
    expect(complete.mock.calls[0]?.[1]).toMatchObject({
      status: "unverified",
      authorization_status: "unverified",
      execution_mode: "passive_only",
      active_testing_allowed: false,
      network_active_testing_performed: false,
    });
  });

  it("maps source patterns into review leads without claiming verified vulnerabilities", async () => {
    const { complete, persistSourceSnapshot, worker } = fakeWorker();
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{
          output: { status: "source_sampled", evidence: { snapshot_id: "source-snapshot-1", content_sha256: "b".repeat(64) } },
        }] })
        .mockResolvedValueOnce({ rows: [{
          id: "source-snapshot-1",
          source_uri: "https://api.github.com/tree",
          content_sha256: "b".repeat(64),
          content: { files: [
            { path: "contracts/Vault.sol", blob_sha: "blob-1", size: 80, content: "function withdraw() external { tx.origin; target.delegatecall(data); }" },
            { path: "src/app.ts", blob_sha: "blob-2", size: 30, content: "eval(input);" },
          ] },
        }] }),
    } as unknown as import("pg").Pool;
    await processAttackSurfaceMapping(pool, worker, { ...step({}), step_key: "map_attack_surface" });
    const output = complete.mock.calls[0]?.[1] as { status: string; lead_count: number; leads: Array<{ rule_id: string }> };
    expect(output.status).toBe("mapped");
    expect(output.lead_count).toBeGreaterThanOrEqual(3);
    expect(output.leads.map((lead) => lead.rule_id)).toContain("SOL-TX-ORIGIN");
    expect(output.leads.map((lead) => lead.rule_id)).toContain("JS-EVAL");
    expect(output).toMatchObject({ execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false });
    expect(persistSourceSnapshot).toHaveBeenCalledOnce();
    expect(persistSourceSnapshot.mock.calls[0]?.[1]).toMatchObject({ sourceKind: "deterministic_passive_attack_surface_map" });
  });

  it("turns surface leads into evidence-linked unverified research questions", async () => {
    const { complete, persistSourceSnapshot, worker } = fakeWorker();
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{
        output: {
          status: "mapped",
          leads: [{ rule_id: "SOL-TX-ORIGIN", family: "solidity-authentication", path: "Vault.sol", count: 1 }],
          evidence: { snapshot_id: "00000000-0000-4000-8000-000000000003", content_sha256: "c".repeat(64) },
        },
      }] })
        .mockResolvedValueOnce({ rows: [{ id: "00000000-0000-4000-8000-000000000003", content_sha256: "c".repeat(64) }] }),
    } as unknown as import("pg").Pool;
    await processHypothesisGeneration(pool, worker, { ...step({}), step_key: "generate_hypotheses" });
    expect(complete.mock.calls[0]?.[1]).toMatchObject({
      status: "hypotheses_generated",
      hypothesis_count: 1,
      hypotheses: [{ status: "unverified_hypothesis", path: "Vault.sol", rule_id: "SOL-TX-ORIGIN" }],
      authorization_status: "unverified",
      active_testing_allowed: false,
      independent_review_completed: false,
    });
    expect(persistSourceSnapshot).toHaveBeenCalledOnce();
  });

  it("challenges hypotheses with counterquestions and refuses to claim independent verification", async () => {
    const { complete, persistSourceSnapshot, worker } = fakeWorker();
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [
          { step_key: "generate_hypotheses", output: {
            status: "hypotheses_generated",
            evidence: { snapshot_id: "00000000-0000-4000-8000-000000000001", content_sha256: "a".repeat(64) },
            hypotheses: [{ id: "H-1", rule_id: "SOL-TX-ORIGIN", family: "solidity-authentication", path: "Vault.sol" }],
          } },
          { step_key: "map_attack_surface", output: {
            status: "mapped",
            evidence: { snapshot_id: "00000000-0000-4000-8000-000000000002", content_sha256: "b".repeat(64) },
            leads: [{ rule_id: "SOL-TX-ORIGIN", family: "solidity-authentication", path: "Vault.sol", count: 1 }],
          } },
        ] })
        .mockResolvedValueOnce({ rows: [
          { id: "00000000-0000-4000-8000-000000000001", content_sha256: "a".repeat(64) },
          { id: "00000000-0000-4000-8000-000000000002", content_sha256: "b".repeat(64) },
        ] }),
    } as unknown as import("pg").Pool;
    await processIndependentChallenge(pool, worker, { ...step({}), step_key: "independent_challenge" });
    const output = complete.mock.calls[0]?.[1] as {
      status: string; challenges: Array<{ challenge_status: string; counterquestions: string[]; verdict: string }>;
      independent_review_completed: boolean;
    };
    expect(output.status).toBe("challenged");
    expect(output.challenges[0]?.challenge_status).toBe("counter_review_required");
    expect(output.challenges[0]?.counterquestions.length).toBeGreaterThan(1);
    expect(output.challenges[0]?.verdict).toBe("unverified");
    expect(output.independent_review_completed).toBe(false);
    expect(persistSourceSnapshot).toHaveBeenCalledOnce();
  });

  it("prepares a cautious evidence-linked brief without declaring findings verified", async () => {
    const { complete, persistSourceSnapshot, worker } = fakeWorker();
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [
        { step_key: "establish_authorization", output: { status: "unverified", active_testing_allowed: false } },
        { step_key: "map_attack_surface", output: { status: "mapped", leads: [{ rule_id: "SOL-TX-ORIGIN" }], evidence: { snapshot_id: "map-1" } } },
        { step_key: "generate_hypotheses", output: { hypotheses: [{ id: "H-1", status: "unverified_hypothesis", candidate_question: "Is this safe?" }] } },
        { step_key: "independent_challenge", output: { challenges: [{ hypothesis_id: "H-1", challenge_status: "counter_review_required", verdict: "unverified" }] } },
      ] }),
    } as unknown as import("pg").Pool;
    await processResearchBrief(pool, worker, { ...step({}), step_key: "prepare_research_brief" });
    expect(complete.mock.calls[0]?.[1]).toMatchObject({
      status: "brief_prepared",
      execution_mode: "passive_only",
      authorization_status: "unverified",
      active_testing_allowed: false,
      report_submission_ready: false,
      pipeline_completeness: "partial",
      missing_step_keys: ["identify_project", "locate_official_repositories"],
      brief: {
        research_status: "preliminary_passive_review",
        completeness: "partial_pipeline",
        missing_step_keys: ["identify_project", "locate_official_repositories"],
      },
    });
    expect(persistSourceSnapshot).toHaveBeenCalledOnce();
  });

  it("does not fetch code when repository identification did not succeed", async () => {
    const { complete, worker } = fakeWorker();
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ output: { status: "not_found" } }] }) } as unknown as import("pg").Pool;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await processRepositoryAcquisition(pool, worker, { ...step({}), step_key: "locate_official_repositories" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(complete.mock.calls[0]?.[1]).toMatchObject({ status: "not_applicable", network_access_performed: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

});
