import { GitHubResearchClient, type GitHubRepositorySummary, type GitHubTreeEntry } from "./github-research.js";

export type RepositoryMap = {
  repository: GitHubRepositorySummary;
  branch: string;
  truncated: boolean;
  fileCount: number;
  directories: string[];
  candidateFiles: Array<{ path: string; size?: number; reasons: string[] }>;
  warnings: string[];
};

const SOURCE_EXTENSIONS = /\.(sol|vy|rs|ts|tsx|js|jsx|go|py|move|cairo|java|kt|rb)$/i;
const SECURITY_PATH = /(auth|access|owner|admin|role|permission|withdraw|deposit|transfer|claim|mint|burn|bridge|oracle|price|vault|pool|router|swap|signature|nonce|upgrade|proxy|token|account|safe|escrow)/i;
const MAX_CANDIDATES = 250;

/**
 * Passive repository mapping only. This inventories source paths and flags
 * review candidates; it does not clone, execute, fuzz, scan endpoints or test
 * deployed assets.
 */
export async function mapGitHubRepository(
  client: GitHubResearchClient,
  owner: string,
  name: string,
): Promise<RepositoryMap> {
  const repository = await client.getRepository(owner, name);
  const tree = await client.getRepositoryTree(owner, name, repository.defaultBranch);
  const files = tree.filter((entry) => entry.type === "blob" && SOURCE_EXTENSIONS.test(entry.path));
  const directories = [...new Set(files.map((entry) => {
    const index = entry.path.lastIndexOf("/");
    return index < 0 ? "." : entry.path.slice(0, index);
  }))].sort();

  const candidateFiles = files
    .map((entry) => {
      const reasons: string[] = [];
      if (SECURITY_PATH.test(entry.path)) reasons.push("security_sensitive_path_name");
      if (/\.(sol|vy|move|cairo)$/i.test(entry.path)) reasons.push("smart_contract_source");
      if (/(test|spec|audit|security|invariant)/i.test(entry.path)) reasons.push("security_or_test_context");
      return { entry, reasons };
    })
    .filter(({ reasons }) => reasons.length > 0)
    .sort((a, b) => b.reasons.length - a.reasons.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, MAX_CANDIDATES)
    .map(({ entry, reasons }) => ({
      path: entry.path,
      ...(typeof entry.size === "number" ? { size: entry.size } : {}),
      reasons,
    }));

  const warnings: string[] = [];
  if (repository.archived) warnings.push("Repository is archived; confirm this is the intended codebase.");
  if (repository.fork) warnings.push("Repository is a fork; verify it is the official project repository.");
  if (tree.length >= 20_000) warnings.push("Repository tree was capped at 20,000 entries.");
  if (candidateFiles.length === MAX_CANDIDATES) warnings.push("Candidate file list was capped at 250 entries.");

  return {
    repository,
    branch: repository.defaultBranch,
    truncated: tree.length >= 20_000,
    fileCount: files.length,
    directories,
    candidateFiles,
    warnings,
  };
}

export function isSecurityReviewCandidate(entry: GitHubTreeEntry): boolean {
  return entry.type === "blob" && SOURCE_EXTENSIONS.test(entry.path) && SECURITY_PATH.test(entry.path);
}
