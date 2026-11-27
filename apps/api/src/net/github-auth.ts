/**
 * The ONE place that reads the GitHub token. Every GitHub client in the pipeline (acquisition, enrichment verification, repository
 * monitoring, legacy intake, the operator CLI and the live check) gets its credential from here, so the rules below hold everywhere:
 *
 * - The token comes only from the environment variable GITHUB_TOKEN (a Fly secret in production). It is never hardcoded, committed,
 *   stored in the database, put in an API response, a log line, an error message or a model prompt.
 * - It is sent only as an `authorization` header, only to https://api.github.com (the archive host codeload.github.com, raw content
 *   hosts and redirect targets never receive it).
 * - A value that does not look like a GitHub token is NOT sent at all ("misconfigured"), so a pasted-with-a-newline or wrong secret
 *   fails loudly in engine status and the logs instead of producing a stream of 401s.
 * - Every GitHub request is a GET. Nothing here or in the clients can write to GitHub.
 */

export type GitHubAuthMode = "authenticated" | "unauthenticated" | "misconfigured";
export type GitHubAuth = { mode: GitHubAuthMode; token: string | null; problem: string | null };

/** Fine-grained PATs (github_pat_…) and the classic/app token prefixes (ghp_, gho_, ghu_, ghs_, ghr_). Shape only, never the value. */
const TOKEN_SHAPE = /^(github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255})$/;

export function readGitHubAuth(env: NodeJS.ProcessEnv = process.env): GitHubAuth {
  const raw = env.GITHUB_TOKEN;
  if (raw === undefined || raw === "") return { mode: "unauthenticated", token: null, problem: null };
  if (!TOKEN_SHAPE.test(raw)) {
    const why = raw.trim() !== raw ? "it has leading or trailing whitespace" : "it does not look like a GitHub token (expected github_pat_… for a fine-grained token)";
    return { mode: "misconfigured", token: null, problem: `GITHUB_TOKEN is set but is not used: ${why}` };
  }
  return { mode: "authenticated", token: raw, problem: null };
}

/** What operators and the engine status may see: the mode and the problem, never the token or any part of it. */
export function describeGitHubAuth(env: NodeJS.ProcessEnv = process.env): { mode: GitHubAuthMode; problem: string | null; rate_limit_basis: string } {
  const a = readGitHubAuth(env);
  return {
    mode: a.mode, problem: a.problem,
    rate_limit_basis: a.mode === "authenticated" ? "authenticated REST requests (per-token limit, 5,000/hour for a personal token)" : "unauthenticated REST requests (60/hour per outbound IP)",
  };
}

/** The authorization header for the GitHub API origin only. Empty when there is no usable token. */
export function githubApiAuthHeader(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const a = readGitHubAuth(env);
  return a.token ? { authorization: `Bearer ${a.token}` } : {};
}

const PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  /(authorization"?\s*[:=]\s*)("?)(bearer|token|basic)\s+[^\s",}]+/gi,
  /\b(bearer|token)\s+[A-Za-z0-9_\-.=]{20,}/gi,
];

/**
 * Removes anything token-like from text before it is logged, stored or returned: GitHub token shapes, authorization headers, bearer
 * values, and the configured token's exact value (whatever its shape). Used by AcquisitionError and the CLIs' error output.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  const exact = env.GITHUB_TOKEN;
  if (exact && exact.length >= 8) out = out.split(exact).join("[REDACTED]");
  out = out.replace(PATTERNS[0]!, "[REDACTED]").replace(PATTERNS[1]!, "[REDACTED]");
  out = out.replace(PATTERNS[2]!, (_m, head: string, q: string) => `${head}${q}[REDACTED]`);
  out = out.replace(PATTERNS[3]!, (_m, kind: string) => `${kind} [REDACTED]`);
  return out;
}

/** Deep-redacts string values of a details object (error details end up in step outputs and logs). */
export function redactValue<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") return redactSecrets(value, env) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, env)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = /^(authorization|token|github_token)$/i.test(k) ? "[REDACTED]" : redactValue(v, env);
    return out as T;
  }
  return value;
}
