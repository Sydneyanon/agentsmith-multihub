import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { WorkflowWorker, type ClaimedStep } from "./worker.js";
import { resolveSourceReference } from "./source-resolver.js";

type IntakeStepInput = {
  intake_kind?: unknown;
  value?: unknown;
  source?: unknown;
  notes?: unknown;
  source_reference?: unknown;
  execution_mode?: unknown;
  authorization_status?: unknown;
};

export type ProcessResult = { status: "idle" } | { status: "completed"; stepId: string };

/**
 * First deliberately narrow worker slice: normalize and persist intake provenance.
 * It performs no network request, repository clone, scan, transaction or PoC execution.
 */
export async function processIntakeResolution(worker: WorkflowWorker, step: ClaimedStep): Promise<ProcessResult> {
  if (step.step_key !== "resolve_source") {
    throw new Error(`Unsupported step for intake-resolution worker: ${step.step_key}`);
  }
  const input = step.input as IntakeStepInput;
  if (input.execution_mode !== "passive_only" || input.authorization_status !== "unverified") {
    throw new Error("Intake step is missing the required passive-only authorization defaults");
  }
  if (input.intake_kind !== "url" && input.intake_kind !== "idea") {
    throw new Error("Invalid intake_kind in persisted workflow step");
  }
  if (typeof input.value !== "string" || input.value.length < 3 || input.value.length > 4_000) {
    throw new Error("Invalid intake value in persisted workflow step");
  }

  let sourceReference: ReturnType<typeof resolveSourceReference> | null = null;
  if (input.intake_kind === "url") {
    sourceReference = resolveSourceReference(input.value);
    if (input.source_reference && !isDeepStrictEqual(input.source_reference, sourceReference)) {
      throw new Error("Stored source reference does not match deterministic URL resolution");
    }
  }

  await worker.complete(step.id, {
    intake_kind: input.intake_kind,
    submitted_value: input.value,
    source: typeof input.source === "string" ? input.source : "user",
    notes_present: typeof input.notes === "string" && input.notes.length > 0,
    source_reference: sourceReference,
    execution_mode: "passive_only",
    authorization_status: "unverified",
    network_access_performed: false,
    next_step_requires_separate_handler: true,
  });
  return { status: "completed", stepId: step.id };
}


type GitHubRepositoryMetadata = {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  language: string | null;
  archived: boolean;
  disabled: boolean;
  visibility: string;
  updated_at: string;
  stargazers_count: number;
  forks_count: number;
  topics: string[];
  license: { spdx_id: string | null; name: string } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only public GitHub repository metadata from a fixed API host. */
export async function processProjectIdentification(worker: WorkflowWorker, step: ClaimedStep): Promise<ProcessResult> {
  if (step.step_key !== "identify_project") {
    throw new Error(`Unsupported step for project-identification worker: ${step.step_key}`);
  }
  const input = step.input as IntakeStepInput;
  if (input.execution_mode !== "passive_only" || input.authorization_status !== "unverified") {
    throw new Error("Project identification requires passive-only, unverified authorization defaults");
  }
  if (input.intake_kind !== "url" && input.intake_kind !== "idea") {
    throw new Error("Invalid intake_kind in project-identification step");
  }
  if (input.intake_kind === "idea" || !isRecord(input.source_reference) ||
      !isRecord(input.source_reference.repository)) {
    await worker.complete(step.id, {
      status: "not_applicable",
      reason: input.intake_kind === "idea" ? "Idea intake has no source URL" : "Source is not a recognized GitHub repository URL",
      network_access_performed: false,
      execution_mode: "passive_only",
      authorization_status: "unverified",
    });
    return { status: "completed", stepId: step.id };
  }

  const repository = input.source_reference.repository;
  const owner = repository.owner;
  const name = repository.name;
  if (typeof owner !== "string" || typeof name !== "string" ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
    throw new Error("Invalid GitHub repository identity in persisted intake");
  }

  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "AgentSmith-MultiHub/0.1",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("GitHub API redirect rejected by source-fetch policy");
  }
  if (response.status === 404) {
    await worker.complete(step.id, {
      status: "not_found",
      repository_url: `https://github.com/${owner}/${name}`,
      http_status: 404,
      network_access_performed: true,
      execution_mode: "passive_only",
      authorization_status: "unverified",
    });
    return { status: "completed", stepId: step.id };
  }
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);

  const body = await response.text();
  if (body.length > 128_000) throw new Error("GitHub repository metadata exceeded the response size limit");
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || typeof parsed.id !== "number" ||
      typeof parsed.full_name !== "string" || typeof parsed.html_url !== "string" ||
      typeof parsed.default_branch !== "string" || typeof parsed.archived !== "boolean") {
    throw new Error("GitHub API response did not match the expected repository metadata shape");
  }
  const metadata: GitHubRepositoryMetadata = {
    id: parsed.id,
    full_name: parsed.full_name,
    html_url: parsed.html_url,
    description: typeof parsed.description === "string" ? parsed.description.slice(0, 2_000) : null,
    default_branch: parsed.default_branch.slice(0, 200),
    language: typeof parsed.language === "string" ? parsed.language.slice(0, 100) : null,
    archived: parsed.archived,
    disabled: parsed.disabled === true,
    visibility: typeof parsed.visibility === "string" ? parsed.visibility : "unknown",
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
    stargazers_count: typeof parsed.stargazers_count === "number" ? parsed.stargazers_count : 0,
    forks_count: typeof parsed.forks_count === "number" ? parsed.forks_count : 0,
    topics: Array.isArray(parsed.topics) ? parsed.topics.filter((topic): topic is string => typeof topic === "string").slice(0, 30) : [],
    license: isRecord(parsed.license) ? {
      spdx_id: typeof parsed.license.spdx_id === "string" ? parsed.license.spdx_id : null,
      name: typeof parsed.license.name === "string" ? parsed.license.name.slice(0, 200) : "Unknown",
    } : null,
  };
  const snapshot = await worker.persistSourceSnapshot(step.id, {
    sourceUri: endpoint,
    sourceKind: "github_repository_metadata_api",
    content: metadata as unknown as Record<string, unknown>,
  });
  await worker.complete(step.id, {
    status: "identified",
    repository: metadata,
    evidence: {
      snapshot_id: snapshot.id,
      source_uri: endpoint,
      source_kind: "github_repository_metadata_api",
      content_sha256: snapshot.contentSha256,
    },
    network_access_performed: true,
    execution_mode: "passive_only",
    authorization_status: "unverified",
  });
  return { status: "completed", stepId: step.id };
}

export async function runIntakeWorker(pool: Pool, workerId: string, signal: AbortSignal, pollMs = 2_000): Promise<void> {
  const worker = new WorkflowWorker(pool, workerId);
  while (!signal.aborted) {
    await worker.reapExhaustedLeases();
    const step = await worker.claimNext(["resolve_source", "identify_project"]);
    if (!step) {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        timer = setTimeout(finish, pollMs);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
      continue;
    }
    try {
      if (step.step_key === "resolve_source") await processIntakeResolution(worker, step);
      else await processProjectIdentification(worker, step);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown intake resolution error";
      await worker.fail(step.id, reason, false);
    }
  }
}
