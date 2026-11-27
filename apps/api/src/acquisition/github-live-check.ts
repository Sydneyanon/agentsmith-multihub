import { createHash, randomUUID } from "node:crypto";
import { manifestSha256, type ResearchStore, type SnapshotFileInput } from "../research-state.js";
import { describeGitHubAuth, redactSecrets } from "../net/github-auth.js";
import { acquireRepository, type AcquisitionStore } from "./acquire.js";
import { githubSourceFromEnv, type GitHubSourceOptions } from "./github-source.js";

/**
 * LIVE GitHub check (operator-run, read-only). It runs the REAL production code path against real GitHub, with the GITHUB_TOKEN of
 * the machine it runs on, and stores nothing anywhere:
 *
 *   1. auth mode (authenticated / unauthenticated / misconfigured), never the token;
 *   2. GET /rate_limit: an authenticated token shows the authenticated limit (unauthenticated is 60/hour);
 *   3. the production acquisition (acquireRepository) of one public repository: repository lookup, default branch, commit SHA,
 *      recursive git tree, commit-pinned tarball, every file verified against its git blob id, the snapshot "sealed" into an
 *      in-memory store that is discarded when the process exits.
 *
 * Every request is a GET to api.github.com (token) or codeload.github.com (no token). Nothing is written to GitHub or to a database.
 *
 *   node dist/apps/api/src/acquisition/github-live-check.js [owner/name] [--require-auth]
 * Default repository: octocat/Hello-World (GitHub's own tiny public sample repository).
 * Exit: 0 all checks passed; 2 --require-auth and the machine is not authenticated; 1 any failure.
 */
class EphemeralStore implements AcquisitionStore {
  private snaps = new Map<string, { repository: string; commitSha: string; refName: string | null; report: Record<string, unknown>; sealed: boolean; manifest: string | null }>();
  private rows = new Map<string, SnapshotFileInput[]>();
  private blobs = new Set<string>();
  findSnapshot: ResearchStore["findSnapshot"] = async () => null;
  createSnapshot: ResearchStore["createSnapshot"] = async (_l, input) => {
    const id = randomUUID(); this.snaps.set(id, { repository: input.repository, commitSha: input.commitSha, refName: input.refName ?? null, report: input.acquisitionReport ?? {}, sealed: false, manifest: null }); this.rows.set(id, []); return id;
  };
  putBlob: ResearchStore["putBlob"] = async (_l, content) => { const sha256 = createHash("sha256").update(content).digest("hex"); this.blobs.add(sha256); return { sha256, sizeBytes: content.length }; };
  addSnapshotFiles: ResearchStore["addSnapshotFiles"] = async (_l, id, files) => { const r = this.rows.get(id)!; for (const f of files) if (!r.some((x) => x.path === f.path)) r.push(f); };
  sealSnapshot: ResearchStore["sealSnapshot"] = async (_l, id) => {
    const rows = this.rows.get(id)!;
    const manifest = manifestSha256(rows.map((r) => ({ path: r.path, blobSha256: "blobSha256" in r ? r.blobSha256 : null, skipReason: "skipReason" in r ? r.skipReason : null })));
    const s = this.snaps.get(id)!; s.sealed = true; s.manifest = manifest;
    return { manifestSha256: manifest, fileCount: rows.length, totalBytes: rows.reduce((n, r) => n + ("blobSha256" in r ? r.sizeBytes : 0), 0) };
  };
  verifySnapshot: ResearchStore["verifySnapshot"] = async (id) => {
    const rows = this.rows.get(id) ?? [];
    return { ok: this.snaps.get(id)?.sealed === true && rows.every((r) => !("blobSha256" in r) || this.blobs.has(r.blobSha256)) };
  };
}

/** `sourceOptions` exists for tests (loopback origins, which GitHubSource accepts only under NODE_ENV=test); production passes none. */
export async function runLiveCheck(argv: string[], env: NodeJS.ProcessEnv = process.env, out: (line: string) => void = (l) => console.log(l), sourceOptions: Omit<GitHubSourceOptions, "token"> = {}): Promise<number> {
  const say = (o: Record<string, unknown>) => out(redactSecrets(JSON.stringify(o), env));
  const requireAuth = argv.includes("--require-auth");
  const repository = argv.find((a) => !a.startsWith("--")) ?? "octocat/Hello-World";
  const auth = describeGitHubAuth(env);
  say({ check: "auth_mode", mode: auth.mode, problem: auth.problem });
  if (requireAuth && auth.mode !== "authenticated") { say({ result: "FAIL", reason: "not authenticated", mode: auth.mode }); return 2; }
  const source = githubSourceFromEnv(env, sourceOptions);
  try {
    const rl = await source.rateLimitStatus(AbortSignal.timeout(20_000));
    say({ check: "rate_limit", limit: rl.core.limit, remaining: rl.core.remaining, reset: new Date(rl.core.reset * 1000).toISOString(), authenticated_limit: rl.core.limit > 60 });
    if (auth.mode === "authenticated" && rl.core.limit <= 60) { say({ result: "FAIL", reason: "a token is configured but GitHub reports the unauthenticated limit" }); return 1; }
    const lease = { stepId: "live-check", workerId: "live-check" };
    const r = await acquireRepository({ store: new EphemeralStore(), source, signal: AbortSignal.timeout(300_000) }, lease, { repository });
    say({ check: "acquisition", repository: r.repository, commit_sha: r.commitSha, tree_sha: r.treeSha, files: r.fileCount, stored_files: r.storedFiles, stored_bytes: r.storedBytes, manifest_sha256: r.manifestSha256, completeness: r.completeness, skipped: r.skipped, stored: "in memory only, discarded on exit" });
    say({ check: "rate_limit_after", ...(source.rateLimit ?? {}) });
    say({ result: "PASS", authenticated: source.authenticated, requests: "GET only; token sent to api.github.com only" });
    return 0;
  } catch (error) {
    say({ result: "FAIL", error: String((error as Error).message ?? error).slice(0, 400), retryable: (error as { retryable?: boolean }).retryable ?? null });
    return 1;
  }
}

if (process.argv[1] && /github-live-check\.(js|ts)$/.test(process.argv[1])) {
  runLiveCheck(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(redactSecrets(String(e))); process.exitCode = 1; });
}
