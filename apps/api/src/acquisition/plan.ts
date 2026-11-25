import { AcquisitionError } from "./errors.js";
import type { AcquisitionLimits } from "./limits.js";
import { CLASS_RANK, classifyPath, manifestPathProblem, escapeForReport, type Classification } from "./paths.js";
import type { TreeEntry } from "./github-source.js";

export type SkipReason = "binary" | "oversize" | "symlink" | "submodule" | "excluded_by_policy" | "unreadable_encoding" | "limit_reached";
export type PlanKind = "file" | "symlink" | "submodule";
export type PlanItem = {
  path: string; kind: PlanKind; gitSha: string; size: number; classification: Classification;
  /** Decided from the tree alone. A file with no planned skip is a candidate to store, subject to its content (binary, encoding). */
  plannedSkip: SkipReason | null;
};
export type Unrepresentable = { path: string; reason: string; kind: PlanKind; gitSha: string; size: number };
export type Plan = { items: PlanItem[]; unrepresentable: Unrepresentable[]; caseCollisions: number; treeEntries: number; plannedStoredBytes: number };

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/**
 * Accounts for every non-directory tree entry before anything is downloaded. Nothing here reads content, so memory stays bounded,
 * the result is a pure function of (tree, options), and the same commit always gives the same plan.
 */
export function buildPlan(entries: readonly TreeEntry[], options: { limits: AcquisitionLimits; excludePathPrefixes: readonly string[] }): Plan {
  const { limits } = options;
  const exclude = options.excludePathPrefixes.map((p) => p.replace(/\/+$/, "")).filter(Boolean);
  const seen = new Set<string>();
  const items: PlanItem[] = [];
  const unrepresentable: Unrepresentable[] = [];
  let treeEntries = 0;

  for (const entry of entries) {
    if (entry.type === "tree") continue;
    treeEntries += 1;
    if (seen.has(entry.path)) throw new AcquisitionError("unexpected_response", `the tree lists ${escapeForReport(entry.path, 120)} twice`);
    seen.add(entry.path);
    let kind: PlanKind;
    if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) kind = "file";
    else if (entry.type === "blob" && entry.mode === "120000") kind = "symlink";
    else if (entry.type === "commit" && entry.mode === "160000") kind = "submodule";
    else throw new AcquisitionError("unexpected_response", `the tree has an entry of type ${entry.type} with mode ${entry.mode}, which is not supported`);
    if (kind !== "submodule" && entry.size === undefined) throw new AcquisitionError("unexpected_response", `the tree gives no size for ${escapeForReport(entry.path, 120)}`);
    const size = kind === "submodule" ? 0 : entry.size!;
    const problem = manifestPathProblem(entry.path, limits);
    if (problem) { unrepresentable.push({ path: entry.path, reason: problem, kind, gitSha: entry.sha, size }); continue; }
    items.push({ path: entry.path, kind, gitSha: entry.sha, size, classification: classifyPath(entry.path), plannedSkip: null });
  }

  if (items.length + unrepresentable.length > limits.maxManifestEntries) {
    throw new AcquisitionError("repository_too_large", `the repository has ${items.length + unrepresentable.length} entries; a snapshot manifest holds at most ${limits.maxManifestEntries}`, false, undefined, { entries: items.length + unrepresentable.length, limit: limits.maxManifestEntries });
  }

  const lowered = new Map<string, number>();
  for (const item of items) lowered.set(item.path.toLowerCase(), (lowered.get(item.path.toLowerCase()) ?? 0) + 1);
  const caseCollisions = [...lowered.values()].filter((n) => n > 1).length;

  const candidates: PlanItem[] = [];
  for (const item of items) {
    if (item.kind === "symlink") item.plannedSkip = "symlink";
    else if (item.kind === "submodule") item.plannedSkip = "submodule";
    else if (exclude.some((p) => item.path === p || item.path.startsWith(`${p}/`))) item.plannedSkip = "excluded_by_policy";
    else if (item.size > limits.maxFileBytes) item.plannedSkip = "oversize";
    else candidates.push(item);
  }
  // Deterministic byte budget: rank by classification, then path; a file that does not fit is skipped and later smaller ones may still fit.
  candidates.sort((a, b) => CLASS_RANK[a.classification] - CLASS_RANK[b.classification] || byteOrder(a.path, b.path));
  let used = 0;
  for (const item of candidates) {
    if (used + item.size > limits.maxStoredBytes) item.plannedSkip = "limit_reached";
    else used += item.size;
  }
  items.sort((a, b) => byteOrder(a.path, b.path));
  unrepresentable.sort((a, b) => byteOrder(a.path, b.path));
  return { items, unrepresentable, caseCollisions, treeEntries, plannedStoredBytes: used };
}
