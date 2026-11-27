import { outboundFetch, unguardedFetchForLoopbackFixtures } from "../net/outbound.js";
import { assertTestEnvironment } from "../net/test-env.js";
import { z } from "zod";
import { httpStatusError } from "../step-errors.js";
import { AcquisitionError } from "./errors.js";
import { resolveLimits, type AcquisitionLimits } from "./limits.js";
import { escapeForReport } from "./paths.js";
import { readGitHubAuth } from "../net/github-auth.js";

export type RepositoryIdentity = { repositoryId: number; fullName: string; defaultBranch: string; archived: boolean; fork: boolean };
export type ResolvedCommit = { commitSha: string; treeSha: string };
export type TreeEntry = { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number };
export type GitTree = { sha: string; truncated: boolean; entries: TreeEntry[] };
/** GitHub's rate-limit headers from the latest API response (no values from the request: never the token). */
export type RateLimitObservation = { limit: number | null; remaining: number | null; resetEpoch: number | null; resource: string | null; observedAt: string };
export type OpenedArchive = { body: AsyncIterable<Uint8Array>; finalHost: string };

/** What the acquisition needs from a hosting service. The real one talks to GitHub; tests supply a fake built from a real local git repository. */
export interface RepositorySource {
  getRepository(owner: string, repo: string, signal?: AbortSignal): Promise<RepositoryIdentity>;
  resolveCommit(owner: string, repo: string, ref: string | undefined, signal?: AbortSignal): Promise<ResolvedCommit>;
  getTree(owner: string, repo: string, treeSha: string, signal?: AbortSignal): Promise<GitTree>;
  openArchive(owner: string, repo: string, commitSha: string, signal?: AbortSignal): Promise<OpenedArchive>;
}

const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;
export function parseRepositoryName(value: string): { owner: string; repo: string } {
  const parts = value.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !NAME_PART.test(owner) || !NAME_PART.test(repo) || [owner, repo].some((p) => p === "." || p === "..")) {
    throw new AcquisitionError("invalid_reference", `repository must look like owner/name (got ${escapeForReport(value, 80)})`);
  }
  return { owner, repo };
}

const REF = /^[A-Za-z0-9._@+/-]{1,250}$/;
export function assertSafeRef(ref: string): void {
  if (!REF.test(ref) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//") || ref.includes("@{") || ref.endsWith(".lock") || ref.startsWith("-")) {
    throw new AcquisitionError("invalid_reference", `ref is not a safe branch, tag or commit name (got ${escapeForReport(ref, 80)})`);
  }
}

const sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const repoSchema = z.object({
  id: z.number().int().positive(), full_name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/), default_branch: z.string().min(1).max(250),
  private: z.boolean(), archived: z.boolean().optional(), fork: z.boolean().optional(),
});
const commitSchema = z.object({ sha: sha40, commit: z.object({ tree: z.object({ sha: sha40 }) }) });
const treeSchema = z.object({
  sha: sha40, truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string().min(1).max(65_536), mode: z.string().regex(/^[0-7]{6}$/), type: z.enum(["blob", "tree", "commit"]), sha: sha40, size: z.number().int().nonnegative().optional() })),
});

export type GitHubSourceOptions = {
  /** Optional token for the API origin only. Never sent to the archive host, never logged, never stored. */
  token?: string;
  limits?: Partial<AcquisitionLimits>;
  fetcher?: typeof fetch;
  requestTimeoutMs?: number;
  /**
   * TESTS ONLY: replaces the fixed GitHub origins with loopback ones, so the real HTTP code can be exercised against a local fake.
   * Requires NODE_ENV=test.
   */
  testOrigins?: { api: string; archive: string[] };
};

/**
 * Iterates a fetch body with a reader and always cancels it on early exit. A body that goes quiet for `idleMs` is a stall, reported
 * as a retryable timeout; a slow but steady download is never cut short by it (the acquisition's wall-clock limit bounds the total).
 */
async function* readBody(body: ReadableStream<Uint8Array> | null, idleMs: number): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stall = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AcquisitionError("timeout", `the download went quiet for ${idleMs} ms`, true)), idleMs); });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await Promise.race([reader.read(), stall]); } finally { clearTimeout(timer); }
      if (chunk.done) return;
      if (chunk.value) yield chunk.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const PRODUCTION_API = "https://api.github.com";
const PRODUCTION_ARCHIVE_HOSTS = ["https://codeload.github.com"];
const USER_AGENT = "agentsmith-multihub-acquisition/5.2 (passive repository reading)";

export class GitHubSource implements RepositorySource {
  private readonly limits: AcquisitionLimits;
  private readonly fetcher: typeof fetch;
  private readonly apiOrigin: string;
  private readonly allowedOrigins: Set<string>;
  private readonly timeoutMs: number;
  private lastRate: RateLimitObservation | null = null;

  /** Whether this source sends a token (never the token itself). */
  get authenticated(): boolean { return Boolean(this.options.token); }
  /** The latest rate-limit headers GitHub returned, for reports and backoff decisions. */
  get rateLimit(): RateLimitObservation | null { return this.lastRate; }

  constructor(private readonly options: GitHubSourceOptions = {}) {
    this.limits = resolveLimits(options.limits);
    this.fetcher = options.fetcher ?? (options.testOrigins ? unguardedFetchForLoopbackFixtures : outboundFetch); // testOrigins (test environment only) point at loopback fixtures, which the SSRF guard correctly refuses
    this.timeoutMs = options.requestTimeoutMs ?? 60_000;
    if (options.testOrigins) {
      assertTestEnvironment("testOrigins");
      this.apiOrigin = new URL(options.testOrigins.api).origin;
      this.allowedOrigins = new Set([this.apiOrigin, ...options.testOrigins.archive.map((o) => new URL(o).origin)]);
    } else {
      this.apiOrigin = PRODUCTION_API;
      this.allowedOrigins = new Set([PRODUCTION_API, ...PRODUCTION_ARCHIVE_HOSTS]);
    }
  }

  private repoPath(owner: string, repo: string): string {
    return `${this.apiOrigin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private checkRedirectTarget(url: URL): void {
    const refuse = (why: string) => new AcquisitionError("redirect_refused", `${why} (${escapeForReport(url.origin, 80)})`);
    if (url.username || url.password) throw refuse("redirect target carries credentials");
    if (!this.allowedOrigins.has(url.origin)) throw refuse("redirect target is not an allowed host");
    if (url.protocol !== "https:" && !this.options.testOrigins) throw refuse("redirect target is not https");
  }

  /** Follows at most `maxRedirects` redirects, each re-checked against the allow-list. The token goes to the API origin only. */
  private async request(initial: string, accept: string, signal?: AbortSignal): Promise<Response> {
    let url = new URL(initial);
    this.checkRedirectTarget(url);
    for (let hop = 0; hop <= this.limits.maxRedirects; hop += 1) {
      const headers: Record<string, string> = { accept, "user-agent": USER_AGENT, "x-github-api-version": "2022-11-28" };
      if (this.options.token && url.origin === this.apiOrigin) headers.authorization = `Bearer ${this.options.token}`;
      // The timeout covers waiting for the response headers only. The body is bounded by the caller's signal (the acquisition's
      // wall clock) and by the idle-stall check in readBody, so a large, slow download is not aborted by a per-request timer.
      const headerTimeout = new AbortController();
      const timer = setTimeout(() => headerTimeout.abort(new DOMException("timed out", "TimeoutError")), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(url, { method: "GET", headers, redirect: "manual", signal: signal ? AbortSignal.any([signal, headerTimeout.signal]) : headerTimeout.signal });
      } catch (error) {
        throw this.networkError(error, signal);
      } finally {
        clearTimeout(timer);
      }
      if (url.origin === this.apiOrigin) this.observeRate(response);
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new AcquisitionError("unexpected_response", `HTTP ${response.status} without a Location header`);
        url = new URL(location, url);
        this.checkRedirectTarget(url);
        continue;
      }
      return response;
    }
    throw new AcquisitionError("redirect_refused", `more than ${this.limits.maxRedirects} redirects`);
  }

  private observeRate(response: Response): void {
    const n = (h: string) => { const v = response.headers.get(h); return v !== null && /^\d+$/.test(v) ? Number(v) : null; };
    if (response.headers.get("x-ratelimit-limit") === null && response.headers.get("x-ratelimit-remaining") === null) return;
    const resource = response.headers.get("x-ratelimit-resource");
    this.lastRate = { limit: n("x-ratelimit-limit"), remaining: n("x-ratelimit-remaining"), resetEpoch: n("x-ratelimit-reset"), resource: resource && /^[a-z_]{1,40}$/.test(resource) ? resource : null, observedAt: new Date().toISOString() };
  }

  private networkError(error: unknown, signal?: AbortSignal): AcquisitionError {
    if (error instanceof AcquisitionError) return error;
    if (signal?.aborted) return new AcquisitionError("timeout", "the acquisition was cancelled or ran out of time", true);
    const name = (error as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") return new AcquisitionError("timeout", "a request to the hosting service timed out", true);
    return new AcquisitionError("network", `a request to the hosting service failed (${escapeForReport(String((error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message ?? "unknown"), 80)})`, true);
  }

  private failure(label: string, response: Response, notFound: "repository_not_found" | "commit_unavailable" = "repository_not_found"): AcquisitionError {
    const base = httpStatusError(label, response);
    if (response.status === 404) return new AcquisitionError(notFound, `${label} was not found (it may not exist, or it is not public)`);
    // 401: the token itself was refused (expired, revoked or wrong). Permanent until an operator fixes the secret; never retried.
    if (response.status === 401) return new AcquisitionError("auth_failed", this.options.token
      ? `GitHub refused the configured token for ${label} (HTTP 401): it may be expired, revoked or mistyped; fix the GITHUB_TOKEN secret`
      : `GitHub requires authentication for ${label} (HTTP 401)`);
    // 403 that is not a rate limit (rate limits are classified by httpStatusError as retryable with a wait): access refused by policy.
    if (response.status === 403 && !base.retryable) return new AcquisitionError("access_denied", `GitHub refused access to ${label} (HTTP 403)${this.options.token ? ": the token may not cover public repositories, or an organisation policy blocks it" : ""}`);
    if (response.status === 422 && notFound === "commit_unavailable") return new AcquisitionError("commit_unavailable", `${label} does not resolve to a commit`);
    if ((response.status === 403 || response.status === 429) && base.retryable)
      return new AcquisitionError("upstream_http", `${base.message}: GitHub rate limit reached (${this.options.token ? "authenticated" : "unauthenticated: 60 requests/hour; configure GITHUB_TOKEN"})${base.retryAfterSeconds ? `; retry after ${base.retryAfterSeconds} s` : ""}`, true, base.retryAfterSeconds, { rate_limit: this.lastRate });
    return new AcquisitionError("upstream_http", base.message, base.retryable, base.retryAfterSeconds);
  }

  private async readJson<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<T> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const piece of readBody(response.body, this.timeoutMs)) {
        total += piece.byteLength;
        if (total > this.limits.maxApiResponseBytes) { await response.body?.cancel().catch(() => undefined); throw new AcquisitionError("limit_exceeded", `${label} is larger than ${this.limits.maxApiResponseBytes} bytes`, false, undefined, { limit: "api_response_bytes" }); }
        chunks.push(Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength));
      }
    } catch (error) {
      throw this.networkError(error);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AcquisitionError("unexpected_response", `${label} is not valid JSON`); }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new AcquisitionError("unexpected_response", `${label} does not have the expected shape`, false, undefined, { issues: result.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) });
    return result.data;
  }

  /** GET /rate_limit: GitHub documents that this call does not count against the primary rate limit. Used by the live check. */
  async rateLimitStatus(signal?: AbortSignal): Promise<{ core: { limit: number; remaining: number; reset: number } }> {
    const response = await this.request(`${this.apiOrigin}/rate_limit`, "application/vnd.github+json", signal);
    if (!response.ok) throw this.failure("the rate-limit status", response);
    const schema = z.object({ resources: z.object({ core: z.object({ limit: z.number().int(), remaining: z.number().int(), reset: z.number().int() }) }) });
    return { core: (await this.readJson(response, schema, "the rate-limit response")).resources.core };
  }

  async getRepository(owner: string, repo: string, signal?: AbortSignal): Promise<RepositoryIdentity> {
    const response = await this.request(this.repoPath(owner, repo), "application/vnd.github+json", signal);
    if (!response.ok) throw this.failure("the repository", response);
    const data = await this.readJson(response, repoSchema, "the repository response");
    if (data.private) throw new AcquisitionError("repository_private", "only public repositories are acquired");
    return { repositoryId: data.id, fullName: data.full_name, defaultBranch: data.default_branch, archived: data.archived === true, fork: data.fork === true };
  }

  async resolveCommit(owner: string, repo: string, ref: string | undefined, signal?: AbortSignal): Promise<ResolvedCommit> {
    const requested = ref ?? "HEAD";
    if (ref !== undefined) assertSafeRef(ref);
    const encoded = requested.split("/").map(encodeURIComponent).join("/");
    const response = await this.request(`${this.repoPath(owner, repo)}/commits/${encoded}`, "application/vnd.github+json", signal);
    if (!response.ok) throw this.failure("the commit", response, "commit_unavailable");
    const data = await this.readJson(response, commitSchema, "the commit response");
    if (/^[a-f0-9]{40}$/.test(requested) && data.sha !== requested) throw new AcquisitionError("commit_mismatch", "a full commit id resolved to a different commit");
    return { commitSha: data.sha, treeSha: data.commit.tree.sha };
  }

  async getTree(owner: string, repo: string, treeSha: string, signal?: AbortSignal): Promise<GitTree> {
    if (!/^[a-f0-9]{40}$/.test(treeSha)) throw new AcquisitionError("invalid_reference", "tree id is not a 40-character hex id");
    const response = await this.request(`${this.repoPath(owner, repo)}/git/trees/${treeSha}?recursive=1`, "application/vnd.github+json", signal);
    if (!response.ok) throw this.failure("the tree", response, "commit_unavailable");
    const data = await this.readJson(response, treeSchema, "the tree response");
    return { sha: data.sha, truncated: data.truncated, entries: data.tree.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha, ...(e.size !== undefined ? { size: e.size } : {}) })) };
  }

  async openArchive(owner: string, repo: string, commitSha: string, signal?: AbortSignal): Promise<OpenedArchive> {
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new AcquisitionError("invalid_reference", "commit id is not a 40-character hex id");
    const response = await this.request(`${this.repoPath(owner, repo)}/tarball/${commitSha}`, "application/vnd.github+json", signal);
    if (!response.ok) throw this.failure("the archive", response, "commit_unavailable");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > this.limits.maxCompressedBytes) { await response.body?.cancel().catch(() => undefined); throw new AcquisitionError("limit_exceeded", `the archive declares ${declared} bytes`, false, undefined, { limit: "compressed_bytes" }); }
    const body = response.body;
    if (!body) throw new AcquisitionError("unexpected_response", "the archive response has no body");
    const wrap = this.networkError.bind(this);
    const idleMs = this.timeoutMs;
    return {
      finalHost: new URL(response.url || this.apiOrigin).host,
      body: (async function* () {
        try { for await (const chunk of readBody(body, idleMs)) yield chunk; } catch (error) { throw wrap(error, signal); }
      })(),
    };
  }
}

/**
 * The GitHub source every production path uses (worker acquisition, enrichment verification, repository monitoring, the operator CLI,
 * the live check). The token, if configured and well-formed, comes from github-auth.ts; a misconfigured value is never sent.
 */
export function githubSourceFromEnv(env: NodeJS.ProcessEnv = process.env, options: Omit<GitHubSourceOptions, "token"> = {}): GitHubSource {
  const auth = readGitHubAuth(env);
  return new GitHubSource({ ...options, ...(auth.token ? { token: auth.token } : {}) });
}
