import { readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeGitHubAuth, githubApiAuthHeader, readGitHubAuth, redactSecrets, redactValue } from "../net/github-auth.js";
import { acquireRepository } from "./acquire.js";
import { AcquisitionError } from "./errors.js";
import { githubSourceFromEnv } from "./github-source.js";
import { runLiveCheck } from "./github-live-check.js";
import { buildGitFixture, type GitFixture } from "./testing/git-fixture.js";
import { MemoryStore } from "./testing/memory-store.js";

/**
 * GITHUB_TOKEN integration. IMPORTANT: everything here runs against LOOPBACK HTTP servers that serve a real git repository built
 * locally (real commit, tree, blob ids and a real `git archive` tarball). The production HTTP client, redirect rules and acquisition
 * code run unchanged, but this is NOT proof of live GitHub access: that is the operator-run live check (github-live-check.ts) on Fly.
 */
const TOKEN = "github_pat_" + "11ABCDEFG0" + "x".repeat(72); // shape of a fine-grained token; not a real credential
const env = (token?: string): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...(token !== undefined ? { GITHUB_TOKEN: token } : {}) });

type Hit = { method: string; url: string; auth: string | undefined; body: number };
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ origin: string; hits: Hit[]; server: Server }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let n = 0; req.on("data", (c: Buffer) => { n += c.length; });
    req.on("end", () => { hits.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: n }); handler(req, res); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server };
}
const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };

describe("GITHUB_TOKEN configuration (github-auth.ts)", () => {
  it("8. missing token: unauthenticated, no header, the documented 60/hour basis", () => {
    expect(readGitHubAuth(env())).toEqual({ mode: "unauthenticated", token: null, problem: null });
    expect(githubApiAuthHeader(env())).toEqual({});
    expect(describeGitHubAuth(env()).rate_limit_basis).toMatch(/60\/hour/);
  });
  it("a well-formed fine-grained token is used, as a Bearer header", () => {
    expect(readGitHubAuth(env(TOKEN)).mode).toBe("authenticated");
    expect(githubApiAuthHeader(env(TOKEN))).toEqual({ authorization: `Bearer ${TOKEN}` });
  });
  it("a malformed value (trailing newline, quotes, wrong kind of secret) is NOT sent, and is reported without echoing it", () => {
    for (const bad of [`${TOKEN}\n`, ` ${TOKEN}`, `"${TOKEN}"`, "hunter2-not-a-token", "Bearer " + TOKEN]) {
      const a = readGitHubAuth(env(bad));
      expect(a).toMatchObject({ mode: "misconfigured", token: null });
      expect(githubApiAuthHeader(env(bad))).toEqual({});
      expect(JSON.stringify(describeGitHubAuth(env(bad)))).not.toContain(TOKEN.slice(12));
    }
  });
  it("describeGitHubAuth (what engine status shows) never contains the token", () => {
    expect(JSON.stringify(describeGitHubAuth(env(TOKEN)))).not.toContain(TOKEN);
  });
});

describe("one reader of the secret", () => {
  it("no source file other than net/github-auth.ts reads GITHUB_TOKEN from the environment", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|mjs|js)$/.test(e.name) && !e.name.endsWith(".test.ts") ? [join(d, e.name)] : []);
    const readers = [...walk(join(root, "apps", "api", "src")), ...walk(join(root, "scripts"))]
      .filter((f) => /env(\.|\[["'])GITHUB_TOKEN/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1));
    expect(readers).toEqual(["apps/api/src/net/github-auth.ts"]);
  });
});

describe("9. redaction", () => {
  it("removes token shapes, authorization headers, bearer values and the configured value", () => {
    const e = env(TOKEN);
    const text = `token ${TOKEN} / authorization: Bearer ${TOKEN} / {"authorization":"token abc"} / ghp_${"a".repeat(36)} / raw=${TOKEN}`;
    const out = redactSecrets(text, e);
    expect(out).not.toContain(TOKEN); expect(out).not.toContain("ghp_aaaa"); expect(out).not.toContain("abc\"");
    expect(out).toContain("[REDACTED]");
    expect(redactSecrets("custom-secret-value-xyz in a message", { GITHUB_TOKEN: "custom-secret-value-xyz" })).not.toContain("custom-secret-value-xyz");
  });
  it("deep-redacts details and drops authorization/token keys", () => {
    expect(redactValue({ headers: { authorization: "Bearer x" }, token: "y", nested: [`see ${TOKEN}`] }, env(TOKEN))).toEqual({ headers: { authorization: "[REDACTED]" }, token: "[REDACTED]", nested: ["see [REDACTED]"] });
  });
  it("every AcquisitionError message and details are redacted at construction", () => {
    const prior = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = TOKEN;
    try {
      const e = new AcquisitionError("network", `failed with ${TOKEN}`, true, undefined, { echoed: `Bearer ${TOKEN}` });
      expect(e.message).not.toContain(TOKEN); expect(JSON.stringify(e.details)).not.toContain(TOKEN);
    } finally { if (prior === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prior; }
  });
});

describe("authenticated GitHub over loopback HTTP: the production client and acquisition, unchanged", () => {
  let fx: GitFixture; let api: Awaited<ReturnType<typeof listen>>; let archive: Awaited<ReturnType<typeof listen>>;
  let mode: "ok" | "401" | "403-policy" | "403-rate" | "429" = "ok";
  const RATE = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1900000000", "x-ratelimit-resource": "core" };
  beforeAll(async () => {
    fx = buildGitFixture([{ path: "contracts/Vault.sol", content: "pragma solidity ^0.8.20;\ncontract Vault { uint256 public total; }\n" }, { path: "README.md", content: "# vault\n" }], { owner: "acme", repo: "vault" });
    archive = await listen((_q, res) => { res.writeHead(200, { "content-type": "application/x-gzip" }); res.end(fx.tarGz); });
    api = await listen((req, res) => {
      const url = req.url ?? "";
      if (mode === "401") return json(res, { message: "Bad credentials" }, 401);
      if (mode === "403-policy") return json(res, { message: "Resource not accessible by personal access token" }, 403, RATE);
      if (mode === "403-rate") return json(res, { message: "API rate limit exceeded" }, 403, { ...RATE, "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 40) });
      if (mode === "429") return json(res, { message: "secondary rate limit" }, 429, { "retry-after": "23" });
      if (url === "/rate_limit") return json(res, { resources: { core: { limit: req.headers.authorization ? 5000 : 60, remaining: 4990, reset: 1900000000 } } }, 200);
      if (url === "/repos/acme/vault") return json(res, { id: 77, full_name: "acme/vault", default_branch: "main", private: false, archived: false, fork: false }, 200, RATE);
      if (url === "/repos/acme/vault/commits/HEAD" || url === "/repos/acme/vault/commits/main") return json(res, { sha: fx.commitSha, commit: { tree: { sha: fx.treeSha } } }, 200, RATE);
      if (url === `/repos/acme/vault/git/trees/${fx.treeSha}?recursive=1`) return json(res, { sha: fx.treeSha, truncated: false, tree: fx.treeEntries }, 200, RATE);
      if (url === `/repos/acme/vault/tarball/${fx.commitSha}`) { res.writeHead(302, { location: `${archive.origin}/acme/vault/legacy.tar.gz/${fx.commitSha}` }); return res.end(); }
      json(res, { message: "Not Found" }, 404);
    });
  });
  afterAll(() => { fx?.cleanup(); for (const s of [api, archive]) { s?.server.closeAllConnections(); s?.server.close(); } });
  const opts = () => ({ testOrigins: { api: api.origin, archive: [archive.origin] }, requestTimeoutMs: 5000 });
  const reset = () => { api.hits.length = 0; archive.hits.length = 0; mode = "ok"; };

  it("1-5. authenticated lookup, metadata, default branch, commit SHA, tree, commit-pinned archive, per-file verification, sealing", async () => {
    reset();
    const source = githubSourceFromEnv(env(TOKEN), opts());
    expect(source.authenticated).toBe(true);
    expect(await source.getRepository("acme", "vault")).toEqual({ repositoryId: 77, fullName: "acme/vault", defaultBranch: "main", archived: false, fork: false });
    const store = new MemoryStore();
    const r = await acquireRepository({ store, source }, { stepId: "s", workerId: "w" }, { repository: "acme/vault" });
    expect(r).toMatchObject({ repository: "acme/vault", commitSha: fx.commitSha, treeSha: fx.treeSha, fileCount: 2, completeness: "complete" });
    expect(r.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...store.blobs.values()].map(String)).toContain("# vault\n"); // source content retrieved through the pinned archive
    expect(source.rateLimit).toMatchObject({ limit: 5000, resource: "core" });
    // the token went to the API origin on every API request, and never to the archive host
    expect(api.hits.length).toBeGreaterThanOrEqual(4);
    expect(api.hits.every((h) => h.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(archive.hits.every((h) => h.auth === undefined)).toBe(true);
    expect(archive.hits[0]!.url).toContain(fx.commitSha); // the archive is fetched by exact commit id
  });

  it("10. no write operations: every request the source makes is a bodiless GET", async () => {
    reset();
    const source = githubSourceFromEnv(env(TOKEN), opts());
    await source.rateLimitStatus(); await acquireRepository({ store: new MemoryStore(), source }, { stepId: "s", workerId: "w" }, { repository: "acme/vault" });
    const all = [...api.hits, ...archive.hits];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((h) => h.method === "GET" && h.body === 0)).toBe(true);
  });

  it("10. no write operations in the code: GitHub clients contain no non-GET method", () => {
    const root = join(__dirname, "..");
    const files = ["acquisition/github-source.ts", "acquisition/github-live-check.ts", "net/github-auth.ts", "discovery/monitor.ts", "bounties/enrich.ts", "bounties/monitor.ts"];
    for (const f of files) expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/method:\s*["'`](POST|PUT|PATCH|DELETE)/i);
    // every literal GitHub API URL in the API sources is read with GET: no file that names api.github.com issues a write method
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(d, e.name)] : []);
    for (const f of walk(root).filter((f) => readFileSync(f, "utf8").includes("api.github.com")))
      expect(readFileSync(f, "utf8"), f).not.toMatch(/method:\s*["'`](POST|PUT|PATCH|DELETE)/i);
  });

  it("8. missing token: the same pipeline works unauthenticated, with no authorization header", async () => {
    reset();
    const source = githubSourceFromEnv(env(), opts());
    expect(source.authenticated).toBe(false);
    await acquireRepository({ store: new MemoryStore(), source }, { stepId: "s", workerId: "w" }, { repository: "acme/vault" });
    expect(api.hits.every((h) => h.auth === undefined)).toBe(true);
  });

  it("7. authentication failure: 401 is a permanent auth_failed naming the secret, never the token, never retried", async () => {
    reset(); mode = "401";
    const e = await githubSourceFromEnv(env(TOKEN), opts()).getRepository("acme", "vault").then(() => { throw new Error("expected failure"); }, (x) => x as AcquisitionError);
    expect(e).toBeInstanceOf(AcquisitionError);
    expect(e).toMatchObject({ code: "auth_failed", retryable: false });
    expect(e.message).toMatch(/GITHUB_TOKEN/); expect(e.message).not.toContain(TOKEN);
    expect(api.hits).toHaveLength(1); // no retry inside the client
  });

  it("7. a 403 that is not a rate limit is a permanent access_denied", async () => {
    reset(); mode = "403-policy";
    const e = await githubSourceFromEnv(env(TOKEN), opts()).getRepository("acme", "vault").then(() => { throw new Error("expected failure"); }, (x) => x as AcquisitionError);
    expect(e).toMatchObject({ code: "access_denied", retryable: false });
  });

  it("6. rate limits: primary (403, remaining 0) and secondary (429 retry-after) are retryable with the wait GitHub asked for", async () => {
    reset(); mode = "403-rate";
    const s = githubSourceFromEnv(env(TOKEN), opts());
    const p = await s.getRepository("acme", "vault").then(() => { throw new Error("expected failure"); }, (x) => x as AcquisitionError);
    expect(p).toMatchObject({ code: "upstream_http", retryable: true }); expect(p.retryAfterSeconds).toBeGreaterThan(30);
    expect(p.message).toMatch(/rate limit reached \(authenticated\)/);
    expect(s.rateLimit).toMatchObject({ remaining: 0 });
    mode = "429";
    const q = await githubSourceFromEnv(env(), opts()).getRepository("acme", "vault").then(() => { throw new Error("expected failure"); }, (x) => x as AcquisitionError);
    expect(q).toMatchObject({ retryable: true, retryAfterSeconds: 23 });
    expect(q.message).toMatch(/unauthenticated: 60 requests\/hour; configure GITHUB_TOKEN/);
  });

  it("the live check passes end to end, reports the authenticated limit, and prints no token", async () => {
    reset();
    const lines: string[] = [];
    const code = await runLiveCheck(["acme/vault", "--require-auth"], env(TOKEN), (l) => lines.push(l), opts());
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).not.toContain(TOKEN);
    expect(lines.map((l) => JSON.parse(l))).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "auth_mode", mode: "authenticated" }),
      expect.objectContaining({ check: "rate_limit", limit: 5000, authenticated_limit: true }),
      expect.objectContaining({ check: "acquisition", commit_sha: fx.commitSha, completeness: "complete" }),
      expect.objectContaining({ result: "PASS", authenticated: true }),
    ]));
  });

  it("9. the live check's failure output contains no token, even when the server echoes the credential back", async () => {
    reset(); mode = "401";
    const lines: string[] = [];
    expect(await runLiveCheck(["acme/vault"], env(TOKEN), (l) => lines.push(l), opts())).toBe(1);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.at(-1)).toMatch(/auth_failed/);
  });

  it("--require-auth refuses to run unauthenticated (exit 2) and with a misconfigured secret", async () => {
    expect(await runLiveCheck(["--require-auth"], env(), () => undefined, opts())).toBe(2);
    expect(await runLiveCheck(["--require-auth"], env(`${TOKEN}\n`), () => undefined, opts())).toBe(2);
  });
});
