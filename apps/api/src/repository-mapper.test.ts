import { describe, expect, it, vi } from "vitest";
import { mapGitHubRepository } from "./repository-mapper.js";
import type { GitHubResearchClient } from "./github-research.js";

describe("mapGitHubRepository", () => {
  it("builds a passive source inventory and prioritises sensitive paths", async () => {
    const client = {
      getRepository: vi.fn().mockResolvedValue({
        fullName: "acme/protocol",
        description: "Protocol",
        defaultBranch: "main",
        htmlUrl: "https://github.com/acme/protocol",
        archived: false,
        fork: false,
        stars: 10,
        updatedAt: "2026-11-24T00:00:00Z",
      }),
      getRepositoryTree: vi.fn().mockResolvedValue([
        { path: "README.md", mode: "100644", type: "blob", sha: "1", size: 10 },
        { path: "src/Vault.sol", mode: "100644", type: "blob", sha: "2", size: 200 },
        { path: "src/utils/math.ts", mode: "100644", type: "blob", sha: "3", size: 80 },
      ]),
    } as unknown as GitHubResearchClient;

    const result = await mapGitHubRepository(client, "acme", "protocol");
    expect(result.fileCount).toBe(2);
    expect(result.candidateFiles[0]?.path).toBe("src/Vault.sol");
    expect(result.candidateFiles[0]?.reasons).toContain("smart_contract_source");
    expect(result.directories).toEqual(["src", "src/utils"]);
    expect(client.getRepositoryTree).toHaveBeenCalledWith("acme", "protocol", "main");
  });
});
