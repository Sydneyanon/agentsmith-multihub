import type { AcquisitionLimits } from "./limits.js";

/**
 * Whether a path can be a manifest row. Mirrors the CHECK on repo_snapshot_files.path (1 to 1,024 characters, no leading
 * slash, no empty, "." or ".." segment, no tab, newline or carriage return) and adds what PostgreSQL text cannot hold
 * (NUL, lone surrogates) and the depth limit.
 */
export function manifestPathProblem(path: string, limits: Pick<AcquisitionLimits, "maxPathLength" | "maxPathDepth">): string | null {
  const length = Array.from(path).length;
  if (length < 1 || length > limits.maxPathLength) return "length_out_of_range";
  if (path.startsWith("/")) return "leading_slash";
  if (/[\t\n\r]/.test(path)) return "tab_or_newline";
  if (path.includes("\u0000")) return "nul";
  if (Buffer.from(path, "utf8").toString("utf8") !== path) return "invalid_unicode";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "empty_dot_or_dotdot_segment";
  if (segments.length > limits.maxPathDepth) return "too_deep";
  return null;
}

/** Paths from an archive that look like an attempt to leave the tree. Never written anywhere; rejected as evidence of a hostile archive. */
export function isTraversalShaped(path: string): boolean {
  return path.startsWith("/") || path.includes("\u0000") || /(^|\/)\.\.?(\/|$)/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || path.includes("//");
}

/** Makes any untrusted text safe to place in a log line or a report: control characters become escapes, long text is cut. */
export function escapeForReport(text: string, max = 200): string {
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count >= max) { out += `…(+${Array.from(text).length - max} more)`; break; }
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff)) out += `\\u{${code.toString(16)}}`;
    else if (ch === "\\") out += "\\\\";
    else out += ch;
    count += 1;
  }
  return out;
}

export type Classification = "source" | "test" | "vendored" | "generated" | "docs" | "config" | "other";

const SOURCE_EXT = /\.(sol|vy|rs|go|ts|tsx|js|jsx|mjs|cjs|py|c|h|cc|cpp|hpp|java|kt|move|cairo|fe|yul|huff|sway|rb|php|swift|cs|scala|zig)$/i;
const CONFIG_EXT = /\.(json|toml|ya?ml|ini|cfg|conf|lock|xml|properties|env\.example)$/i;
const DOC_EXT = /\.(md|mdx|rst|txt|adoc)$/i;

/** Deterministic, path-only classification. It informs ranking and display; it never changes whether a file is trusted. */
export function classifyPath(path: string): Classification {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const base = segments[segments.length - 1]!;
  if (segments.some((s) => ["node_modules", "vendor", "third_party", "third-party", "thirdparty", "deps"].includes(s))) return "vendored";
  if (segments[0] === "lib" || segments.some((s) => s === "forge-std" || s === "openzeppelin-contracts" || s === "openzeppelin-contracts-upgradeable")) return "vendored";
  if (segments.some((s) => ["dist", "build", "out", "artifacts", "cache", "typechain", "typechain-types", "generated", "coverage"].includes(s)) ||
      /\.(min\.js|min\.css|generated\.[a-z]+|pb\.go|g\.dart)$/.test(base) || /(^|\.)generated(\.|$)/.test(base)) return "generated";
  if (segments.some((s) => ["test", "tests", "__tests__", "spec", "specs", "e2e", "mocks", "mock"].includes(s)) ||
      /\.(t|test|spec)\.[a-z0-9]+$/.test(base) || /^test[_.-]/.test(base) || /[_.-]test\.[a-z0-9]+$/.test(base)) return "test";
  if (DOC_EXT.test(base) || segments[0] === "docs" || segments[0] === "doc" || ["license", "licence", "notice", "authors", "contributing", "changelog", "security"].includes(base.split(".")[0]!)) return "docs";
  if (SOURCE_EXT.test(base)) return "source";
  if (CONFIG_EXT.test(base) || base.startsWith(".") || ["makefile", "dockerfile", "foundry.toml", "hardhat.config.js", "hardhat.config.ts", "package.json", "remappings.txt"].includes(base)) return "config";
  return "other";
}

/** Rank for the deterministic byte budget: lower is stored first. */
export const CLASS_RANK: Record<Classification, number> = { source: 0, test: 1, config: 2, docs: 3, other: 4, generated: 5, vendored: 6 };

export type LfsPointer = { oid: string; size: number };
/** A Git LFS pointer file: stored as the repository's real content, flagged so reports never imply the large object was fetched. */
export function parseLfsPointer(content: Buffer): LfsPointer | null {
  if (content.length > 1_024) return null;
  const text = content.toString("utf8");
  if (!text.startsWith("version https://git-lfs.github.com/spec/v1\n")) return null;
  const oid = /^oid sha256:([a-f0-9]{64})$/m.exec(text)?.[1];
  const size = /^size (\d{1,15})$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : null;
}
