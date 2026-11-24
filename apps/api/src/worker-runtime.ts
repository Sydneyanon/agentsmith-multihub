import { createHash } from "node:crypto";
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

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 128_000) {
    throw new Error("GitHub repository metadata exceeded the response size limit");
  }
  if (!response.body) throw new Error("GitHub API response body was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > 128_000) {
        await reader.cancel();
        throw new Error("GitHub repository metadata exceeded the response size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new TextDecoder("utf-8", { fatal: true }).decode(
    chunks.reduce((joined, chunk) => {
      const combined = new Uint8Array(joined.length + chunk.length);
      combined.set(joined);
      combined.set(chunk, joined.length);
      return combined;
    }, new Uint8Array()),
  );
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


type GitTreeEntry = { path: string; type: string; size?: number; sha: string };
type GitTreeResponse = { tree: GitTreeEntry[]; truncated?: boolean };

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Source response exceeded configured byte limit");
  }
  if (!response.body) throw new Error("Source response body was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Source response exceeded configured byte limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

async function githubGet(url: string, maxBytes: number): Promise<{ response: Response; body: string }> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "AgentSmith-MultiHub/0.1",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("GitHub API redirect rejected by source-fetch policy");
  }
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  return { response, body: await readBoundedResponse(response, maxBytes) };
}

/**
 * Retrieve a small, deterministic source sample from a public GitHub repository.
 * The tree is read recursively, but only a fixed allowlist of text files and
 * extensions is fetched. No code is executed.
 */
export async function processRepositoryAcquisition(pool: Pool, worker: WorkflowWorker, step: ClaimedStep): Promise<ProcessResult> {
  if (step.step_key !== "locate_official_repositories") {
    throw new Error(`Unsupported step for repository acquisition: ${step.step_key}`);
  }
  const prior = await pool.query<{ output: unknown }>(
    `SELECT output FROM workflow_steps
     WHERE workflow_run_id = $1 AND step_key = 'identify_project' AND status = 'succeeded'`,
    [step.workflow_run_id],
  );
  const previous = prior.rows[0]?.output;
  if (!isRecord(previous) || previous.status !== "identified" || !isRecord(previous.repository)) {
    await worker.complete(step.id, {
      status: "not_applicable",
      reason: "No identified public GitHub repository is available",
      source_files_fetched: 0,
      network_access_performed: false,
      execution_mode: "passive_only",
      authorization_status: "unverified",
    });
    return { status: "completed", stepId: step.id };
  }

  const repository = previous.repository;
  const fullName = repository.full_name;
  const branch = repository.default_branch;
  if (typeof fullName !== "string" || typeof branch !== "string" ||
      !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(fullName) ||
      !/^(?!\/)(?!.*\/\/)[A-Za-z0-9_.-]{1,100}(?:\/[A-Za-z0-9_.-]{1,100})*$/.test(branch)) {
    throw new Error("Repository identity or default branch is invalid");
  }
  const [owner, name] = fullName.split("/");
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const treeResult = await githubGet(treeUrl, 2_000_000);
  const treeParsed: unknown = JSON.parse(treeResult.body);
  if (!isRecord(treeParsed) || !Array.isArray(treeParsed.tree)) {
    throw new Error("GitHub tree response did not match the expected shape");
  }
  const tree = treeParsed.tree.filter((entry): entry is GitTreeEntry =>
    isRecord(entry) && typeof entry.path === "string" && entry.type === "blob" &&
    typeof entry.sha === "string" && typeof entry.size === "number" &&
    entry.size >= 0 && entry.size <= 48_000
  );
  const allowedNames = new Set([
    "README.md", "SECURITY.md", "CONTRIBUTING.md", "package.json", "Cargo.toml",
    "foundry.toml", "hardhat.config.ts", "hardhat.config.js", "Anchor.toml",
  ]);
  const candidates = tree.filter((entry) => {
    const base = entry.path.split("/").pop() ?? "";
    const extensionAllowed = /\.(sol|rs|ts|tsx|js|jsx|py|go|vy|md|toml|yaml|yml|json)$/.test(base);
    const excluded = /(^|\/)(node_modules|vendor|target|dist|build|coverage|\.git|\.next)\//.test(entry.path);
    return !excluded && (allowedNames.has(base) || extensionAllowed);
  }).sort((a,b) => {
    const score = (path: string) => {
      const base = path.split("/").pop() ?? "";
      return (base === "README.md" ? 0 : base === "SECURITY.md" ? 1 : base === "package.json" ? 2 : 3);
    };
    return score(a.path) - score(b.path) || a.path.localeCompare(b.path);
  }).slice(0, 20);

  const files: Array<{ path: string; blob_sha: string; size: number; content: string; truncated: boolean }> = [];
  let totalBytes = 0;
  for (const entry of candidates) {
    const remaining = 512_000 - totalBytes;
    if (remaining <= 0) break;
    const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${encodedBranch}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "AgentSmith-MultiHub/0.1", accept: "text/plain" },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("Raw GitHub redirect rejected");
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Raw GitHub returned HTTP ${response.status} for ${entry.path}`);
    const content = await readBoundedResponse(response, Math.min(48_000, remaining));
    const bytes = new TextEncoder().encode(content).byteLength;
    totalBytes += bytes;
    files.push({ path: entry.path, blob_sha: entry.sha, size: bytes, content, truncated: false });
  }

  const snapshot = await worker.persistSourceSnapshot(step.id, {
    sourceUri: treeUrl,
    sourceKind: "github_repository_source_sample",
    content: {
      repository: fullName,
      default_branch: branch,
      tree_truncated: treeParsed.truncated === true,
      selected_file_count: files.length,
      total_bytes: totalBytes,
      files,
    },
  });
  const inventory = files.map((file) => ({
    path: file.path,
    blob_sha: file.blob_sha,
    size: file.size,
    content_sha256: createHash("sha256").update(file.content).digest("hex"),
  }));
  await worker.complete(step.id, {
    status: "source_sampled",
    repository: fullName,
    default_branch: branch,
    file_count: files.length,
    total_bytes: totalBytes,
    files: inventory,
    tree_truncated: treeParsed.truncated === true,
    evidence: {
      snapshot_id: snapshot.id,
      source_uri: treeUrl,
      content_sha256: snapshot.contentSha256,
    },
    network_access_performed: true,
    execution_mode: "passive_only",
    authorization_status: "unverified",
    code_executed: false,
  });
  return { status: "completed", stepId: step.id };
}

export async function runIntakeWorker(pool: Pool, workerId: string, signal: AbortSignal, pollMs = 2_000): Promise<void> {
  const worker = new WorkflowWorker(pool, workerId);
  while (!signal.aborted) {
    await worker.reapExhaustedLeases();
    const step = await worker.claimNext(["resolve_source", "identify_project", "locate_official_repositories"]);
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
      else if (step.step_key === "identify_project") await processProjectIdentification(worker, step);
      else await processRepositoryAcquisition(pool, worker, step);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown intake resolution error";
      await worker.fail(step.id, reason, false);
    }
  }
}
