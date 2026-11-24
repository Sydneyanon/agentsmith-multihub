import { describe, expect, it, vi } from "vitest";
import { GitHubApiError, GitHubResearchClient } from "./github-research.js";

const response = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("GitHubResearchClient", () => {
  it("retrieves only bounded repository metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      full_name: "acme/vault",
      description: "Vault contracts",
      default_branch: "main",
      html_url: "https://github.com/acme/vault",
      archived: false,
      fork: false,
      stargazers_count: 42,
      updated_at: "2026-11-24T00:00:00Z",
    }));
    const client = new GitHubResearchClient({ fetcher });
    await expect(client.getRepository("acme", "vault")).resolves.toMatchObject({
      fullName: "acme/vault",
      defaultBranch: "main",
      stars: 42,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/vault",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("extracts a bounded recursive tree", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      tree: [
        { path: "src", mode: "040000", type: "tree", sha: "abc" },
        { path: "src/Vault.sol", mode: "100644", type: "blob", sha: "def", size: 123 },
      ],
    }));
    const client = new GitHubResearchClient({ fetcher });
    await expect(client.getRepositoryTree("acme", "vault", "main")).resolves.toHaveLength(2);
  });

  it("rejects invalid path parts before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GitHubResearchClient({ fetcher });
    await expect(client.getRepository("../evil", "vault")).rejects.toThrow("Invalid GitHub");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces rate limits and does not follow redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, 403, { "retry-after": "30" }));
    const client = new GitHubResearchClient({ fetcher });
    await expect(client.getRepository("acme", "vault")).rejects.toMatchObject<Partial<GitHubApiError>>({
      status: 403,
      retryAfterSeconds: 30,
    });
  });
});
