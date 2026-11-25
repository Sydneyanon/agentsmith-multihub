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
  if (!await worker.heartbeat(step.id)) throw new Error("Repository acquisition lost its worker lease before tree retrieval");
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
    if (!await worker.heartbeat(step.id)) throw new Error("Repository acquisition lost its worker lease during source retrieval");
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


/** Authorization is explicit: public source visibility never grants active-test permission. */
export async function processAuthorizationGate(pool: Pool, worker: WorkflowWorker, step: ClaimedStep): Promise<ProcessResult> {
  if (step.step_key !== "establish_authorization") {
    throw new Error(`Unsupported step for authorization gate: ${step.step_key}`);
  }
  const run = await pool.query<{ input: unknown }>(
    "SELECT input FROM workflow_runs WHERE id = $1",
    [step.workflow_run_id],
  );
  const input = run.rows[0]?.input;
  const hasProgram = isRecord(input) && typeof input.program_id === "string";
  await worker.complete(step.id, {
    status: "unverified",
    authorization_status: "unverified",
    execution_mode: "passive_only",
    active_testing_allowed: false,
    reason: hasProgram
      ? "Program reference exists but no current verified scope and explicit approval were established by this intake workflow"
      : "No program scope or explicit approval was supplied; active testing remains blocked",
    passive_source_review_allowed: true,
    network_active_testing_performed: false,
  });
  return { status: "completed", stepId: step.id };
}

type SnapshotFile = { path: string; blob_sha: string; size: number; content: string; truncated: boolean };
export const SURFACE_RULES: Array<{ id: string; family: string; description: string; expression: RegExp; extensions: RegExp }> = [
  { id: "SOL-EXT-ENTRY", family: "solidity-entrypoint", description: "Externally callable or public Solidity function", expression: /\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\)[^{;]*(?:external|public)\b/g, extensions: /\.sol$/ },
  { id: "SOL-LOWLEVEL-CALL", family: "solidity-low-level-call", description: "Low-level call, delegatecall or staticcall site", expression: /\.(?:call|delegatecall|staticcall)\s*(?:\{|\()/g, extensions: /\.sol$/ },
  { id: "SOL-TX-ORIGIN", family: "solidity-authentication", description: "tx.origin reference; review authentication context", expression: /\btx\s*\.\s*origin\b/g, extensions: /\.sol$/ },
  { id: "SOL-SELFDESTRUCT", family: "solidity-destructive-op", description: "selfdestruct usage", expression: /\bselfdestruct\s*\(/g, extensions: /\.sol$/ },
  { id: "SOL-DELEGATECALL", family: "solidity-proxy", description: "delegatecall usage; review storage and target control", expression: /\bdelegatecall\s*\(/g, extensions: /\.sol$/ },
  { id: "JS-EVAL", family: "dynamic-code", description: "Dynamic eval or Function constructor", expression: /\beval\s*\(|\bnew\s+Function\s*\(/g, extensions: /\.(?:[cm]?js|[jt]sx?)$/ },
  { id: "JS-CHILD-PROCESS", family: "process-execution", description: "Node child_process import or require", expression: /(?:from\s*['"]node:child_process['"]|require\s*\(\s*['"](?:node:)?child_process['"]\s*\))/g, extensions: /\.(?:[cm]?js|[jt]sx?)$/ },
  { id: "JS-UNSAFE-SQL", family: "sql-construction", description: "Potentially dynamic SQL construction; inspect parameterization", expression: /\b(?:query|execute)\s*\(\s*(?:`[^\n]*\$\{|['"][^'"]*\+|[A-Za-z_$][\w$]*\s*\+)/g, extensions: /\.(?:[cm]?js|[jt]sx?|py)$/ },
  { id: "RUST-UNSAFE", family: "unsafe-memory", description: "Rust unsafe block or function", expression: /\bunsafe\s+(?:\{|fn\b)/g, extensions: /\.rs$/ },
  { id: "PY-EVAL", family: "dynamic-code", description: "Python eval or exec call", expression: /\b(?:eval|exec)\s*\(/g, extensions: /\.py$/ },
];

function countMatches(source: string, expression: RegExp): number {
  const flags = expression.flags.includes("g") ? expression.flags : expression.flags + "g";
  const matcher = new RegExp(expression.source, flags);
  let count = 0;
  while (matcher.exec(source)) count += 1;
  return count;
}

/** Deterministic passive code-surface inventory. It emits review leads, never verified vulnerabilities. */
export async function processAttackSurfaceMapping(pool: Pool, worker: WorkflowWorker, step: ClaimedStep): Promise<ProcessResult> {
  if (step.step_key !== "map_attack_surface") {
    throw new Error(`Unsupported step for attack-surface mapper: ${step.step_key}`);
  }
  const prior = await pool.query<{ output: unknown }>(
    `SELECT output FROM workflow_steps
     WHERE workflow_run_id = $1 AND step_key = 'locate_official_repositories' AND status = 'succeeded'`,
    [step.workflow_run_id],
  );
  const priorOutput = prior.rows[0]?.output;
  if (!isRecord(priorOutput) || priorOutput.status !== "source_sampled" ||
      !isRecord(priorOutput.evidence) || typeof priorOutput.evidence.snapshot_id !== "string") {
    await worker.complete(step.id, {
      status: "not_applicable",
      reason: "No bounded source sample is available for passive mapping",
      leads: [],
      execution_mode: "passive_only",
      authorization_status: "unverified",
    });
    return { status: "completed", stepId: step.id };
  }
  const snapshotResult = await pool.query<{ id: string; source_uri: string; content: unknown; content_sha256: string }>(
    "SELECT id, source_uri, content, content_sha256 FROM source_snapshots WHERE id = $1",
    [priorOutput.evidence.snapshot_id],
  );
  const snapshot = snapshotResult.rows[0];
  const expectedSourceHash = priorOutput.evidence.content_sha256;
  if (!snapshot || typeof expectedSourceHash !== "string" ||
      !/^[0-9a-f]{64}$/i.test(expectedSourceHash) || snapshot.content_sha256 !== expectedSourceHash) {
    throw new Error("Referenced source snapshot is missing or its content hash does not match workflow evidence");
  }
  if (!isRecord(snapshot.content) || !Array.isArray(snapshot.content.files)) {
    throw new Error("Referenced source snapshot is missing or malformed");
  }
  const files = snapshot.content.files.filter((file): file is SnapshotFile =>
    isRecord(file) && typeof file.path === "string" && typeof file.content === "string" &&
    typeof file.blob_sha === "string" && typeof file.size === "number"
  );
  const leads: Array<{ rule_id: string; family: string; path: string; count: number; description: string }> = [];
  for (const file of files) {
    for (const rule of SURFACE_RULES) {
      if (!rule.extensions.test(file.path)) continue;
      const count = countMatches(file.content, rule.expression);
      if (count > 0) leads.push({
        rule_id: rule.id, family: rule.family, path: file.path, count, description: rule.description,
      });
    }
  }
  const summary = {
    repository_source_snapshot_id: snapshot.id,
    repository_source_sha256: snapshot.content_sha256,
    files_reviewed: files.length,
    total_bytes_reviewed: files.reduce((sum, file) => sum + file.size, 0),
    rule_set: "passive-surface-v1",
    rule_count: SURFACE_RULES.length,
    leads,
    limitations: [
      "Pattern matches are review leads, not vulnerability findings",
      "The source sample is bounded and may omit relevant files",
      "No dependency resolution, semantic analysis, compilation, tests or execution was performed",
    ],
  };
  const evidence = await worker.persistSourceSnapshot(step.id, {
    sourceUri: `internal://source-snapshots/${snapshot.id}/passive-surface-v1`,
    sourceKind: "deterministic_passive_attack_surface_map",
    content: summary,
  });
  await worker.complete(step.id, {
    status: "mapped",
    files_reviewed: summary.files_reviewed,
    total_bytes_reviewed: summary.total_bytes_reviewed,
    rule_set: summary.rule_set,
    lead_count: leads.length,
    leads,
    evidence: { snapshot_id: evidence.id, content_sha256: evidence.contentSha256 },
    execution_mode: "passive_only",
    authorization_status: "unverified",
    active_testing_allowed: false,
  });
  return { status: "completed", stepId: step.id };
}


export const HYPOTHESIS_TEMPLATES: Record<string, { question: string; checks: string[]; alternatives: string[] }> = {
  "solidity-entrypoint": {
    question: "Does this externally callable entry point enforce the intended caller, state and value invariants?",
    checks: ["Trace all state writes and external calls reachable from the entry point", "Identify authorization modifiers and any alternate call paths", "Check preconditions and postconditions across repeated calls"],
    alternatives: ["The function may be intentionally permissionless", "A shared modifier or inherited guard may enforce the invariant"],
  },
  "solidity-low-level-call": {
    question: "Can the low-level call fail, re-enter, or target an unintended contract without safe handling?",
    checks: ["Inspect return-value handling and revert behavior", "Trace target address provenance and user control", "Review state-update ordering and reentrancy protections"],
    alternatives: ["The call may target a trusted fixed contract", "The surrounding function may use checks-effects-interactions or a guard"],
  },
  "solidity-authentication": {
    question: "Is tx.origin used in a security decision where contract-wallet or intermediary calls change the trust boundary?",
    checks: ["Locate the exact authorization condition", "Trace expected caller types and intermediary call paths", "Compare with msg.sender-based ownership or role checks"],
    alternatives: ["The reference may be informational only", "The protocol may deliberately restrict EOAs with a documented rationale"],
  },
  "solidity-destructive-op": {
    question: "Can an untrusted or insufficiently authorized caller reach a destructive lifecycle operation?",
    checks: ["Trace access control and all callers", "Check compiler version and intended lifecycle semantics", "Review asset custody and recovery assumptions"],
    alternatives: ["The operation may be unreachable or protected by a multisig role", "The code may be legacy or test-only"],
  },
  "solidity-proxy": {
    question: "Can a caller influence the delegatecall target or cause storage-layout or authorization confusion?",
    checks: ["Trace target selection and upgrade authority", "Compare storage layouts and initialization paths", "Inspect calldata construction and return/revert handling"],
    alternatives: ["The target may be immutable and audited", "A standard proxy pattern may correctly constrain upgrades"],
  },
  "dynamic-code": {
    question: "Can untrusted input influence dynamically evaluated code?",
    checks: ["Trace input provenance into the dynamic execution sink", "Check sanitization and isolation boundaries", "Identify whether the code path is reachable in production"],
    alternatives: ["The expression may evaluate a fixed trusted expression", "The file may be tooling or test code outside production paths"],
  },
  "process-execution": {
    question: "Can untrusted input influence a process command, arguments, working directory or environment?",
    checks: ["Trace values passed to process APIs", "Check argument-array usage and shell mode", "Review allowlists, escaping and privilege context"],
    alternatives: ["The call may use fixed commands and fixed arguments", "The file may be a development-only script"],
  },
  "sql-construction": {
    question: "Can untrusted input alter SQL structure rather than being passed as a bound parameter?",
    checks: ["Trace input to query construction", "Inspect driver parameter binding and identifier handling", "Check all call sites and query-builder guarantees"],
    alternatives: ["The apparent concatenation may be limited to a trusted identifier", "A wrapper may parameterize the query safely"],
  },
  "unsafe-memory": {
    question: "Does the unsafe Rust block uphold pointer, aliasing, lifetime and bounds invariants?",
    checks: ["Document each unsafe precondition", "Trace pointer origins and lifetimes", "Check slice lengths, aliasing and concurrent access"],
    alternatives: ["The block may be a small audited FFI boundary", "A safe wrapper may enforce all invariants"],
  },
};

export async function processHypothesisGeneration(pool: Pool, worker: WorkflowWorker, step: ClaimedStep): Promise<ProcessResult> {
  if (step.step_key !== "generate_hypotheses") {
    throw new Error(`Unsupported step for hypothesis generation: ${step.step_key}`);
  }
  const prior = await pool.query<{ output: unknown }>(
    `SELECT output FROM workflow_steps
     WHERE workflow_run_id = $1 AND step_key = 'map_attack_surface' AND status = 'succeeded'`,
    [step.workflow_run_id],
  );
  const mapped = prior.rows[0]?.output;
  if (!isRecord(mapped) || mapped.status !== "mapped" || !Array.isArray(mapped.leads)) {
    await worker.complete(step.id, {
      status: "not_applicable",
      reason: "No passive attack-surface leads are available",
      hypotheses: [],
      execution_mode: "passive_only",
      authorization_status: "unverified",
    });
    return { status: "completed", stepId: step.id };
  }
  const mapEvidence = isRecord(mapped.evidence) ? mapped.evidence : null;
  const mapSnapshotId = mapEvidence && typeof mapEvidence.snapshot_id === "string" ? mapEvidence.snapshot_id : null;
  const mapSnapshotHash = mapEvidence && typeof mapEvidence.content_sha256 === "string" ? mapEvidence.content_sha256 : null;
  if (!mapSnapshotId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mapSnapshotId) ||
      !mapSnapshotHash || !/^[0-9a-f]{64}$/i.test(mapSnapshotHash)) {
    throw new Error("Attack-surface map is missing a valid immutable evidence reference");
  }
  const mapSnapshot = await pool.query<{ id: string; content_sha256: string }>(
    "SELECT id, content_sha256 FROM source_snapshots WHERE id = $1",
    [mapSnapshotId],
  );
  if (mapSnapshot.rows[0]?.content_sha256 !== mapSnapshotHash) {
    throw new Error("Attack-surface map snapshot is missing or its content hash does not match workflow evidence");
  }
  const hypotheses: Array<{
    id: string; rule_id: string; family: string; path: string; candidate_question: string;
    verification_checks: string[]; alternative_explanations: string[]; status: "unverified_hypothesis";
  }> = [];
  for (const lead of mapped.leads) {
    if (!isRecord(lead) || typeof lead.rule_id !== "string" || typeof lead.family !== "string" ||
        typeof lead.path !== "string" || typeof lead.count !== "number") continue;
    const template = HYPOTHESIS_TEMPLATES[lead.family];
    if (!template) continue;
    hypotheses.push({
      id: `H-${hypotheses.length + 1}`,
      rule_id: lead.rule_id,
      family: lead.family,
      path: lead.path,
      candidate_question: template.question,
      verification_checks: template.checks,
      alternative_explanations: template.alternatives,
      status: "unverified_hypothesis",
    });
  }
  const content = {
    source_map_evidence: isRecord(mapped.evidence) ? mapped.evidence : null,
    template_set: "passive-hypotheses-v1",
    hypothesis_count: hypotheses.length,
    hypotheses,
    limitations: [
      "Templates generate investigation questions, not claims that a vulnerability exists",
      "No semantic execution, exploit construction, active testing or independent verification occurred",
      "Each candidate requires source-context review and counterevidence before promotion",
    ],
  };
  const evidence = await worker.persistSourceSnapshot(step.id, {
    sourceUri: `internal://workflow-runs/${step.workflow_run_id}/passive-hypotheses-v1`,
    sourceKind: "deterministic_passive_hypothesis_set",
    content,
  });
  await worker.complete(step.id, {
    status: "hypotheses_generated",
    hypothesis_count: hypotheses.length,
    hypotheses,
    evidence: { snapshot_id: evidence.id, content_sha256: evidence.contentSha256 },
    execution_mode: "passive_only",
    authorization_status: "unverified",
    active_testing_allowed: false,
    independent_review_completed: false,
  });
  return { status: "completed", stepId: step.id };
}


export const CHALLENGE_RULES: Record<string, { counterquestions: string[]; minimumEvidence: string[] }> = {
  "solidity-authentication": {
    counterquestions: [
      "Is the tx.origin occurrence actually part of an authorization decision, or is it telemetry, a test, or unrelated logic?",
      "Can an attacker reach the containing function, and is caller identity checked elsewhere in the call path?",
      "Does the intended threat model deliberately exclude contract-wallet callers?",
    ],
    minimumEvidence: ["Containing function and complete modifier chain", "All authorization conditions and inherited guards", "Reachability and caller-controlled path analysis"],
  },
  "solidity-low-level-call": {
    counterquestions: [
      "Is the call target fixed and trusted, or can an untrusted party influence it?",
      "Are return values checked and state changes ordered safely?",
      "Is reentrancy prevented by structure, a guard, or an invariant that remains true during the call?",
    ],
    minimumEvidence: ["Complete call site and surrounding state updates", "Target address provenance", "Failure handling and reentrancy analysis"],
  },
  "solidity-proxy": {
    counterquestions: [
      "Is the delegatecall target immutable or controlled by a narrowly authorized upgrade path?",
      "Are storage layout and initialization invariants compatible?",
      "Is this a standard, correctly constrained proxy implementation?",
    ],
    minimumEvidence: ["Target-selection path", "Upgrade authorization and initialization code", "Storage layout comparison"],
  },
  "solidity-entrypoint": {
    counterquestions: [
      "Is permissionless access intentional and safe for this operation?",
      "Are access checks inherited or applied through modifiers not visible in the sampled line?",
      "Do state and value invariants prevent harmful repeated or reordered calls?",
    ],
    minimumEvidence: ["Complete function body", "Modifiers and inherited implementation", "State transition and caller analysis"],
  },
  "solidity-destructive-op": {
    counterquestions: [
      "Is the operation reachable in the deployed version and protected by appropriate authority?",
      "Is the lifecycle behavior intentionally constrained by the compiler version or execution environment?",
      "Does the operation affect user-controlled assets or only an isolated test fixture?",
    ],
    minimumEvidence: ["Reachability and access-control path", "Compiler and deployment context", "Asset custody impact"],
  },
  "dynamic-code": {
    counterquestions: [
      "Can untrusted data reach the evaluated expression, or is the expression constant?",
      "Is the call confined to tests, build tooling, or a non-production path?",
      "Do sandboxing and validation prevent meaningful attacker influence?",
    ],
    minimumEvidence: ["Complete sink call", "Input provenance and sanitization", "Production reachability and execution context"],
  },
  "process-execution": {
    counterquestions: [
      "Are command and arguments constants, or can untrusted input alter them?",
      "Is shell interpretation enabled, and can metacharacters change command structure?",
      "Does the code run with privileges or filesystem access that increase impact?",
    ],
    minimumEvidence: ["Complete process invocation", "Argument and shell configuration", "Input provenance and runtime privileges"],
  },
  "sql-construction": {
    counterquestions: [
      "Does the database driver bind values separately from SQL syntax?",
      "Is concatenation limited to validated identifiers or fixed fragments?",
      "Does a query-builder or wrapper guarantee parameterization?",
    ],
    minimumEvidence: ["Complete query construction", "Driver API and parameter binding", "Origin and validation of dynamic fragments"],
  },
  "unsafe-memory": {
    counterquestions: [
      "Are all unsafe preconditions upheld by the surrounding safe abstraction?",
      "Can callers violate pointer, aliasing, lifetime or bounds assumptions?",
      "Is the unsafe block a narrow and documented FFI boundary?",
    ],
    minimumEvidence: ["Complete unsafe block", "Pointer and lifetime provenance", "Caller invariants and concurrency assumptions"],
  },
};

/**
 * What the independent_challenge step actually is. A succeeded step means the
 * deterministic checklist ran; it never means a reviewer examined the work.
 */
const DETERMINISTIC_CHECKLIST_REVIEW = {
  review_kind: "deterministic_checklist",
  reviewer: null,
  independent_review_completed: false,
  requires_human_or_separate_model_review: true,
} as const;

export async function processIndependentChallenge(pool: Pool, worker: WorkflowWorker, step: ClaimedStep): Promise<ProcessResult> {
  if (step.step_key !== "independent_challenge") {
    throw new Error(`Unsupported step for independent challenge: ${step.step_key}`);
  }
  const result = await pool.query<{ step_key: string; output: unknown }>(
    `SELECT step_key, output FROM workflow_steps
     WHERE workflow_run_id = $1 AND step_key IN ('generate_hypotheses', 'map_attack_surface')
       AND status = 'succeeded'`,
    [step.workflow_run_id],
  );
  const byKey = new Map(result.rows.map((row) => [row.step_key, row.output]));
  const generated = byKey.get("generate_hypotheses");
  const mapped = byKey.get("map_attack_surface");
  if (!isRecord(generated) || generated.status !== "hypotheses_generated" ||
      !Array.isArray(generated.hypotheses) || !isRecord(mapped) || mapped.status !== "mapped") {
    await worker.complete(step.id, {
      status: "not_applicable",
      reason: "No completed hypothesis set and attack-surface map are available to challenge",
      challenge_count: 0,
      execution_mode: "passive_only",
      authorization_status: "unverified",
      independent_review_completed: false,
    });
    return { status: "completed", stepId: step.id };
  }
  const hypotheses = generated.hypotheses.filter((item): item is Record<string, unknown> =>
    isRecord(item) && typeof item.rule_id === "string" && typeof item.family === "string" &&
    typeof item.path === "string" && typeof item.id === "string"
  );
  if (hypotheses.length === 0) {
    await worker.complete(step.id, {
      status: "not_applicable",
      reason: "No hypotheses were generated, so there is nothing to challenge",
      challenge_count: 0,
      ...DETERMINISTIC_CHECKLIST_REVIEW,
      execution_mode: "passive_only",
      authorization_status: "unverified",
    });
    return { status: "completed", stepId: step.id };
  }
  const mapLeads = Array.isArray(mapped.leads) ? mapped.leads.filter(isRecord) : [];
  const hypothesisSnapshotId = isRecord(generated.evidence) && typeof generated.evidence.snapshot_id === "string"
    ? generated.evidence.snapshot_id : null;
  const mapSnapshotId = isRecord(mapped.evidence) && typeof mapped.evidence.snapshot_id === "string"
    ? mapped.evidence.snapshot_id : null;
  const hypothesisHash = isRecord(generated.evidence) && typeof generated.evidence.content_sha256 === "string"
    ? generated.evidence.content_sha256 : null;
  const mapHash = isRecord(mapped.evidence) && typeof mapped.evidence.content_sha256 === "string"
    ? mapped.evidence.content_sha256 : null;
  const validSnapshotId = (id: string | null): id is string =>
    id !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  const snapshotIds = [hypothesisSnapshotId, mapSnapshotId].filter(validSnapshotId);
  const persistedSnapshots = snapshotIds.length
    ? await pool.query<{ id: string; content_sha256: string }>(
        "SELECT id, content_sha256 FROM source_snapshots WHERE id = ANY($1::uuid[])",
        [snapshotIds],
      )
    : { rows: [] as Array<{ id: string; content_sha256: string }> };
  const persistedSnapshotHashes = new Map(persistedSnapshots.rows.map((row) => [row.id, row.content_sha256]));
  const hypothesisEvidenceMatches = validSnapshotId(hypothesisSnapshotId) &&
    typeof hypothesisHash === "string" && /^[0-9a-f]{64}$/i.test(hypothesisHash) &&
    persistedSnapshotHashes.get(hypothesisSnapshotId) === hypothesisHash;
  const mapEvidenceMatches = validSnapshotId(mapSnapshotId) &&
    typeof mapHash === "string" && /^[0-9a-f]{64}$/i.test(mapHash) &&
    persistedSnapshotHashes.get(mapSnapshotId) === mapHash;
  const challenges = hypotheses.map((hypothesis) => {
    const lead = mapLeads.find((candidate) =>
      candidate.rule_id === hypothesis.rule_id && candidate.family === hypothesis.family &&
      candidate.path === hypothesis.path
    );
    const rules = CHALLENGE_RULES[String(hypothesis.family)];
    const evidenceLinked = Boolean(lead) && hypothesisEvidenceMatches && mapEvidenceMatches;
    return {
      hypothesis_id: hypothesis.id,
      rule_id: hypothesis.rule_id,
      path: hypothesis.path,
      challenge_status: evidenceLinked && rules ? "counter_review_required" : "insufficient_linked_evidence",
      source_lead_confirmed_in_map: Boolean(lead),
      counterquestions: rules?.counterquestions ?? ["Is the pattern reachable and security-relevant in production code?", "What source context or design invariant could make this safe?"],
      minimum_evidence_required: rules?.minimumEvidence ?? ["Complete source context", "Input and caller provenance", "Reachability and impact analysis"],
      reasons_not_to_accept: [
        "A lexical pattern match alone does not establish a vulnerability",
        "The bounded source sample may omit guards, callers, tests or relevant configuration",
        "No exploitability, impact or authorization claim has been independently established",
      ],
      verdict: "unverified",
    };
  });
  const content = {
    challenge_protocol: "deterministic-counterreview-v1",
    hypothesis_snapshot_id: hypothesisSnapshotId,
    surface_map_snapshot_id: mapSnapshotId,
    persisted_evidence_snapshot_count: persistedSnapshotHashes.size,
    hypothesis_snapshot_hash_matches: hypothesisEvidenceMatches,
    surface_map_snapshot_hash_matches: mapEvidenceMatches,
    challenge_count: challenges.length,
    challenges,
    protocol_limitations: [
      "This is an adversarial checklist pass, not an independent human or model reviewer",
      "No source was fetched beyond the existing bounded snapshot",
      "No hypothesis is verified or rejected by this stage",
    ],
  };
  const evidence = await worker.persistSourceSnapshot(step.id, {
    sourceUri: `internal://workflow-runs/${step.workflow_run_id}/counterreview-v1`,
    sourceKind: "deterministic_counterreview",
    content,
  });
  await worker.complete(step.id, {
    status: "checklist_applied",
    challenge_count: challenges.length,
    challenges,
    evidence: { snapshot_id: evidence.id, content_sha256: evidence.contentSha256 },
    ...DETERMINISTIC_CHECKLIST_REVIEW,
    execution_mode: "passive_only",
    authorization_status: "unverified",
    active_testing_allowed: false,
  });
  return { status: "completed", stepId: step.id };
}


export async function processResearchBrief(pool: Pool, worker: WorkflowWorker, step: ClaimedStep): Promise<ProcessResult> {
  if (step.step_key !== "prepare_research_brief") {
    throw new Error(`Unsupported step for research brief: ${step.step_key}`);
  }
  const result = await pool.query<{ step_key: string; output: unknown }>(
    `SELECT step_key, output FROM workflow_steps
     WHERE workflow_run_id = $1 AND step_key IN
       ('identify_project', 'locate_official_repositories', 'establish_authorization',
        'map_attack_surface', 'generate_hypotheses', 'independent_challenge')
       AND status = 'succeeded'`,
    [step.workflow_run_id],
  );
  const outputs = new Map(result.rows.map((row) => [row.step_key, row.output]));
  const hypothesesOutput = outputs.get("generate_hypotheses");
  const challengeOutput = outputs.get("independent_challenge");
  const mapOutput = outputs.get("map_attack_surface");
  const repositoryOutput = outputs.get("identify_project");
  const sourceOutput = outputs.get("locate_official_repositories");
  const requiredStepKeys = [
    "identify_project",
    "locate_official_repositories",
    "establish_authorization",
    "map_attack_surface",
    "generate_hypotheses",
    "independent_challenge",
  ] as const;
  const missingStepKeys = requiredStepKeys.filter((key) => !outputs.has(key));
  // A stage can succeed (the handler ran) while doing nothing for this input.
  const notApplicableStepKeys = requiredStepKeys.filter((key) => {
    const out = outputs.get(key);
    return isRecord(out) && (out.status === "not_applicable" || out.status === "not_found");
  });
  const syntheticSeededStepKeys = requiredStepKeys.filter((key) => {
    const out = outputs.get(key);
    return isRecord(out) && out.seeded_synthetic === true;
  });
  const stageExecution = missingStepKeys.length > 0 ? "partial"
    : notApplicableStepKeys.length > 0 ? "not_applicable_stages" : "all_stages_executed";
  const hypotheses = isRecord(hypothesesOutput) && Array.isArray(hypothesesOutput.hypotheses)
    ? hypothesesOutput.hypotheses.filter(isRecord) : [];
  const challenges = isRecord(challengeOutput) && Array.isArray(challengeOutput.challenges)
    ? challengeOutput.challenges.filter(isRecord) : [];
  const leads = isRecord(mapOutput) && Array.isArray(mapOutput.leads) ? mapOutput.leads.filter(isRecord) : [];
  // Research completeness is separate from stage execution: a stage that ran
  // over zero leads, or a bounded sample, is not a completed assessment.
  const sourceSampled = isRecord(sourceOutput) && sourceOutput.status === "source_sampled";
  const surfaceMapped = isRecord(mapOutput) && mapOutput.status === "mapped";
  const researchCompleteness = !sourceSampled || !surfaceMapped ? "not_assessable"
    : leads.length === 0 ? "no_leads_in_bounded_sample" : "preliminary_unreviewed";
  // Only an explicit claim is a claim; an absent flag is just an absent flag.
  const challengeClaimsReview = isRecord(challengeOutput) &&
    challengeOutput.independent_review_completed === true;
  const checklistApplied = isRecord(challengeOutput) && challengeOutput.status === "checklist_applied";
  const brief = {
    brief_version: "passive-research-brief-v1",
    research_status: "preliminary_passive_review",
    completeness: stageExecution === "partial" ? "partial_pipeline" : stageExecution,
    stage_execution_note: "completeness describes which pipeline stages produced output, not whether the research is complete",
    research_completeness: researchCompleteness,
    research_completeness_note: researchCompleteness === "no_leads_in_bounded_sample"
      ? "No pattern leads were found in a bounded sample; this is not evidence that the project is free of vulnerabilities"
      : researchCompleteness === "not_assessable"
        ? "No bounded source sample and attack-surface map were available to assess"
        : "Leads exist; no independent human or model review or verification has been completed",
    verification: {
      independent_review_completed: false,
      independent_review_status: "not_performed",
      checklist_kind_applied: checklistApplied ? "deterministic_checklist" : null,
      verified_findings: 0,
      ...(challengeClaimsReview ? { warning: "challenge_output_claimed_review_without_reviewer_evidence_ignored" } : {}),
    },
    provenance: {
      synthetic_marker_present: syntheticSeededStepKeys.length > 0,
      synthetic_seeded_step_keys: syntheticSeededStepKeys,
    },
    missing_step_keys: missingStepKeys,
    not_applicable_step_keys: notApplicableStepKeys,
    repository: isRecord(repositoryOutput) && isRecord(repositoryOutput.repository)
      ? repositoryOutput.repository : null,
    source_sample: isRecord(sourceOutput) ? {
      status: sourceOutput.status ?? "unknown",
      file_count: sourceOutput.file_count ?? 0,
      total_bytes: sourceOutput.total_bytes ?? 0,
      evidence: sourceOutput.evidence ?? null,
    } : null,
    authorization: isRecord(outputs.get("establish_authorization"))
      ? outputs.get("establish_authorization") : { status: "unverified", active_testing_allowed: false },
    attack_surface: {
      status: isRecord(mapOutput) ? mapOutput.status : "not_available",
      lead_count: leads.length,
      evidence: isRecord(mapOutput) ? mapOutput.evidence ?? null : null,
    },
    hypotheses: hypotheses.map((hypothesis) => ({
      id: hypothesis.id,
      rule_id: hypothesis.rule_id,
      family: hypothesis.family,
      path: hypothesis.path,
      question: hypothesis.candidate_question,
      status: hypothesis.status,
    })),
    counterreview: challenges.map((challenge) => ({
      hypothesis_id: challenge.hypothesis_id,
      challenge_status: challenge.challenge_status,
      counterquestions: challenge.counterquestions,
      minimum_evidence_required: challenge.minimum_evidence_required,
      verdict: challenge.verdict,
    })),
    unresolved_requirements: [
      "Review complete source context, not only the bounded sample",
      "Resolve counterquestions with code-path and design evidence",
      "Obtain independent human or separately configured model review",
      "Establish current program scope and explicit approval before any active testing",
    ],
    conclusion: "No vulnerability has been verified. This brief is a preliminary passive research artifact, not a bounty submission or security assessment.",
  };
  const evidence = await worker.persistSourceSnapshot(step.id, {
    sourceUri: `internal://workflow-runs/${step.workflow_run_id}/research-brief-v1`,
    sourceKind: "preliminary_passive_research_brief",
    content: brief,
  });
  await worker.complete(step.id, {
    status: "brief_prepared",
    pipeline_completeness: stageExecution,
    research_completeness: researchCompleteness,
    independent_review_completed: false,
    missing_step_keys: missingStepKeys,
    not_applicable_step_keys: notApplicableStepKeys,
    brief,
    evidence: { snapshot_id: evidence.id, content_sha256: evidence.contentSha256 },
    execution_mode: "passive_only",
    authorization_status: "unverified",
    active_testing_allowed: false,
    report_submission_ready: false,
  });
  return { status: "completed", stepId: step.id };
}

export async function runIntakeWorker(pool: Pool, workerId: string, signal: AbortSignal, pollMs = 2_000): Promise<void> {
  const worker = new WorkflowWorker(pool, workerId);
  while (!signal.aborted) {
    await worker.reapExhaustedLeases();
    const step = await worker.claimNext(["resolve_source", "identify_project", "locate_official_repositories", "establish_authorization", "map_attack_surface", "generate_hypotheses", "independent_challenge", "prepare_research_brief"]);
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
      else if (step.step_key === "locate_official_repositories") await processRepositoryAcquisition(pool, worker, step);
      else if (step.step_key === "establish_authorization") await processAuthorizationGate(pool, worker, step);
      else if (step.step_key === "map_attack_surface") await processAttackSurfaceMapping(pool, worker, step);
      else if (step.step_key === "generate_hypotheses") await processHypothesisGeneration(pool, worker, step);
      else if (step.step_key === "independent_challenge") await processIndependentChallenge(pool, worker, step);
      else await processResearchBrief(pool, worker, step);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown intake resolution error";
      await worker.fail(step.id, reason, false);
    }
  }
}
