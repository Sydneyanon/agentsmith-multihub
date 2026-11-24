export type GitHubRepositorySummary = {
  fullName: string;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
  archived: boolean;
  fork: boolean;
  stars: number;
  updatedAt: string;
};

export type GitHubTreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

export type GitHubClientOptions = {
  token?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetcher?: typeof fetch;
};

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubResearchClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: GitHubClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    if (this.timeoutMs < 500 || this.timeoutMs > 60_000) throw new Error("timeoutMs must be between 500 and 60000");
    if (this.maxResponseBytes < 1_024 || this.maxResponseBytes > 10_000_000) {
      throw new Error("maxResponseBytes must be between 1024 and 10000000");
    }
  }

  async getRepository(owner: string, name: string): Promise<GitHubRepositorySummary> {
    this.assertPathPart(owner);
    this.assertPathPart(name);
    const data = await this.getJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    );
    if (!isRecord(data) || typeof data.full_name !== "string" ||
        typeof data.default_branch !== "string" || typeof data.html_url !== "string") {
      throw new Error("GitHub returned an unexpected repository response");
    }
    return {
      fullName: data.full_name,
      description: typeof data.description === "string" ? data.description : null,
      defaultBranch: data.default_branch,
      htmlUrl: data.html_url,
      archived: data.archived === true,
      fork: data.fork === true,
      stars: typeof data.stargazers_count === "number" ? data.stargazers_count : 0,
      updatedAt: typeof data.updated_at === "string" ? data.updated_at : "",
    };
  }

  async getRepositoryTree(owner: string, name: string, branch: string): Promise<GitHubTreeEntry[]> {
    this.assertPathPart(owner);
    this.assertPathPart(name);
    if (!branch || branch.length > 250) throw new Error("Invalid repository branch");
    const data = await this.getJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    if (!isRecord(data) || !Array.isArray(data.tree)) {
      throw new Error("GitHub returned an unexpected repository tree");
    }
    return data.tree
      .filter((entry): entry is Record<string, unknown> =>
        isRecord(entry) && typeof entry.path === "string" &&
        typeof entry.mode === "string" && typeof entry.type === "string" &&
        typeof entry.sha === "string")
      .slice(0, 20_000)
      .map((entry) => ({
        path: entry.path as string,
        mode: entry.mode as string,
        type: entry.type as GitHubTreeEntry["type"],
        sha: entry.sha as string,
        ...(typeof entry.size === "number" ? { size: entry.size } : {}),
      }));
  }

  private assertPathPart(value: string): void {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(value) || value === "." || value === "..") {
      throw new Error("Invalid GitHub owner or repository name");
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AgentSmith-MultiHub-Research/0.1",
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;

    const response = await this.fetcher(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > this.maxResponseBytes) throw new Error("GitHub response exceeds configured size limit");
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      throw new GitHubApiError(
        `GitHub API request failed with status ${response.status}`,
        response.status,
        retryAfter > 0 ? retryAfter : undefined,
      );
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > this.maxResponseBytes) {
      throw new Error("GitHub response exceeds configured size limit");
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error("GitHub returned invalid JSON");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
