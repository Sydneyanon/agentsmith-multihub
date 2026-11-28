import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AcquisitionError } from "./errors.js";
import { GitHubSource } from "./github-source.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];
async function listen(handler: Handler): Promise<{ origin: string; hits: Array<{ url: string; headers: IncomingMessage["headers"] }>; server: Server }> {
  const hits: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
  const server = createServer((req, res) => { hits.push({ url: req.url ?? "", headers: req.headers }); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server };
}
afterAll(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

const SHA = "a".repeat(40); const TREE = "b".repeat(40);
const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const code = async (p: Promise<unknown>): Promise<AcquisitionError> => p.then(() => { throw new Error("expected failure"); }, (e) => { expect(e).toBeInstanceOf(AcquisitionError); return e as AcquisitionError; });
async function drain(body: AsyncIterable<Uint8Array>): Promise<Buffer> { const parts: Buffer[] = []; for await (const c of body) parts.push(Buffer.from(c)); return Buffer.concat(parts); }

describe("GitHubSource over real HTTP (loopback fakes standing in for the API and archive hosts)", () => {
  let api: Awaited<ReturnType<typeof listen>>; let archive: Awaited<ReturnType<typeof listen>>; let other: Awaited<ReturnType<typeof listen>>;
  let apiHandler: Handler = () => undefined; let archiveHandler: Handler = () => undefined;
  beforeAll(async () => {
    api = await listen((q, s) => apiHandler(q, s)); archive = await listen((q, s) => archiveHandler(q, s)); other = await listen((_q, s) => { s.writeHead(200); s.end("other host"); });
  });
  afterEach(() => { api.hits.length = 0; archive.hits.length = 0; other.hits.length = 0; });
  const source = (extra: Partial<ConstructorParameters<typeof GitHubSource>[0]> = {}) => new GitHubSource({ testOrigins: { api: api.origin, archive: [archive.origin] }, requestTimeoutMs: 2000, ...extra });

  const repoBody = { id: 42, full_name: "Acme/Vault", default_branch: "main", private: false, archived: false, fork: true };
  const commitBody = { sha: SHA, commit: { tree: { sha: TREE } } };
  const treeBody = { sha: TREE, truncated: false, tree: [{ path: "a.sol", mode: "100644", type: "blob", sha: "c".repeat(40), size: 12 }, { path: "src", mode: "040000", type: "tree", sha: "d".repeat(40) }] };

  it("reads repository identity, resolves a commit and its tree, and lists the tree", async () => {
    apiHandler = (req, res) => {
      if (req.url === "/repos/acme/vault") return json(res, repoBody);
      if (req.url === "/repos/acme/vault/commits/main") return json(res, commitBody);
      if (req.url === `/repos/acme/vault/git/trees/${TREE}?recursive=1`) return json(res, treeBody);
      json(res, { message: "Not Found" }, 404);
    };
    const s = source();
    expect(await s.getRepository("acme", "vault")).toEqual({ repositoryId: 42, fullName: "Acme/Vault", defaultBranch: "main", archived: false, fork: true });
    expect(await s.resolveCommit("acme", "vault", "main")).toEqual({ commitSha: SHA, treeSha: TREE });
    const tree = await s.getTree("acme", "vault", TREE);
    expect(tree.truncated).toBe(false); expect(tree.entries).toHaveLength(2);
    expect(tree.entries[0]).toEqual({ path: "a.sol", mode: "100644", type: "blob", sha: "c".repeat(40), size: 12 });
    expect(api.hits[0]!.headers["user-agent"]).toMatch(/agentsmith-multihub-acquisition/);
    expect(api.hits[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
  });
  it("accepts a very long path in a tree listing (the planner reports it as unrepresentable instead of the whole acquisition failing)", async () => {
    apiHandler = (_q, res) => json(res, { sha: TREE, truncated: false, tree: [{ path: "x".repeat(5000), mode: "100644", type: "blob", sha: "c".repeat(40), size: 1 }] });
    expect((await source().getTree("acme", "vault", TREE)).entries[0]!.path).toHaveLength(5000);
  });
  it("encodes each ref segment and defaults to HEAD", async () => {
    apiHandler = (_q, res) => json(res, commitBody);
    await source().resolveCommit("acme", "vault", "feature/x y".replace(" ", "-"));
    await source().resolveCommit("acme", "vault", undefined);
    expect(api.hits.map((h) => h.url)).toEqual(["/repos/acme/vault/commits/feature/x-y", "/repos/acme/vault/commits/HEAD"]);
  });
  it("sends no request at all for an unsafe ref or repository", async () => {
    const s = source();
    for (const ref of ["..", "a b", "a\nb", "/x", "x?y=1"]) await code(s.resolveCommit("acme", "vault", ref));
    expect(api.hits).toHaveLength(0);
  });
  it("refuses a private repository", async () => {
    apiHandler = (_q, res) => json(res, { ...repoBody, private: true });
    expect((await code(source().getRepository("acme", "vault"))).code).toBe("repository_private");
  });
  it("a full commit id must resolve to itself", async () => {
    apiHandler = (_q, res) => json(res, commitBody);
    expect((await code(source().resolveCommit("acme", "vault", "9".repeat(40)))).code).toBe("commit_mismatch");
    expect(await source().resolveCommit("acme", "vault", SHA)).toMatchObject({ commitSha: SHA });
  });

  describe("responses that are wrong", () => {
    it.each([
      ["not JSON", (_q: IncomingMessage, s: ServerResponse) => { s.writeHead(200); s.end("<html>"); }],
      ["the wrong shape", (_q: IncomingMessage, s: ServerResponse) => json(s, { hello: "world" })],
      ["a commit id that is not 40 hex characters", (_q: IncomingMessage, s: ServerResponse) => json(s, { sha: "xyz", commit: { tree: { sha: TREE } } })],
      ["a repository name with traversal in it", (_q: IncomingMessage, s: ServerResponse) => json(s, { ...repoBody, full_name: "../etc/passwd" })],
    ])("%s", async (_n, handler) => { apiHandler = handler; expect((await code(source().getRepository("acme", "vault"))).code).toBe("unexpected_response"); });
    it("a response larger than the limit is cut off", async () => {
      apiHandler = (_q, res) => { res.writeHead(200); res.write("x".repeat(5000)); res.end("x".repeat(5000)); };
      expect((await code(source({ limits: { maxApiResponseBytes: 1024 } }).getRepository("acme", "vault"))).code).toBe("limit_exceeded");
    });
  });

  describe("how HTTP statuses are classified", () => {
    const status = async (code_: number, headers: Record<string, string> = {}, call: (s: GitHubSource) => Promise<unknown> = (s) => s.getRepository("acme", "vault")) => {
      apiHandler = (_q, res) => json(res, { message: "x" }, code_, headers); return code(call(source()));
    };
    it("404 is permanent: not found or not public", async () => { const e = await status(404); expect(e.code).toBe("repository_not_found"); expect(e.retryable).toBe(false); });
    it("404 and 422 on a commit mean it is unavailable", async () => {
      expect((await status(404, {}, (s) => s.resolveCommit("acme", "vault", "main"))).code).toBe("commit_unavailable");
      expect((await status(422, {}, (s) => s.resolveCommit("acme", "vault", "main"))).code).toBe("commit_unavailable");
    });
    it("rate limiting is retryable and carries the wait", async () => {
      const e = await status(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) });
      expect(e).toMatchObject({ code: "upstream_http", retryable: true }); expect(e.retryAfterSeconds).toBeGreaterThan(20);
      const e2 = await status(429, { "retry-after": "17" }); expect(e2.retryable).toBe(true); expect(e2.retryAfterSeconds).toBe(17);
    });
    it("server errors are retryable, a plain 401 or 403 is not", async () => {
      expect((await status(503)).retryable).toBe(true);
      expect((await status(500)).retryable).toBe(true);
      expect((await status(401)).retryable).toBe(false);
      expect((await status(403)).retryable).toBe(false);
    });
  });

  describe("the archive and its redirects", () => {
    const body = Buffer.from("not really a tarball, just bytes for the transport test");
    it("follows the API's redirect to the archive host and streams the body", async () => {
      apiHandler = (_q, res) => { res.writeHead(302, { location: `${archive.origin}/acme/vault/legacy.tar.gz/${SHA}` }); res.end(); };
      archiveHandler = (_q, res) => { res.writeHead(200, { "content-type": "application/x-gzip" }); res.end(body); };
      const opened = await source().openArchive("acme", "vault", SHA);
      expect((await drain(opened.body)).equals(body)).toBe(true);
      expect(archive.hits[0]!.url).toBe(`/acme/vault/legacy.tar.gz/${SHA}`);
    });
    it("sends the token to the API origin only, never to the archive host", async () => {
      apiHandler = (_q, res) => { res.writeHead(302, { location: `${archive.origin}/x` }); res.end(); };
      archiveHandler = (_q, res) => { res.writeHead(200); res.end("ok"); };
      await drain((await source({ token: "SECRET-TOKEN" }).openArchive("acme", "vault", SHA)).body);
      expect(api.hits[0]!.headers.authorization).toBe("Bearer SECRET-TOKEN");
      expect(archive.hits[0]!.headers.authorization).toBeUndefined();
    });
    it("sends no authorization header when there is no token", async () => {
      apiHandler = (_q, res) => json(res, repoBody);
      await source().getRepository("acme", "vault");
      expect(api.hits[0]!.headers.authorization).toBeUndefined();
    });
    it("refuses a redirect to a host that is not on the allow-list", async () => {
      apiHandler = (_q, res) => { res.writeHead(302, { location: `${other.origin}/steal` }); res.end(); };
      expect((await code(source().openArchive("acme", "vault", SHA))).code).toBe("redirect_refused");
      expect(other.hits).toHaveLength(0);
    });
    it("refuses a redirect whose target carries credentials", async () => {
      apiHandler = (_q, res) => { res.writeHead(302, { location: archive.origin.replace("http://", "http://user:pw@") + "/x" }); res.end(); };
      expect((await code(source().openArchive("acme", "vault", SHA))).code).toBe("redirect_refused");
    });
    it("refuses a redirect loop after the limit", async () => {
      apiHandler = (_q, res) => { res.writeHead(302, { location: `${api.origin}/again` }); res.end(); };
      expect((await code(source().openArchive("acme", "vault", SHA))).code).toBe("redirect_refused");
      expect(api.hits.length).toBe(4); // the first request plus three redirects, then it stops
    });
    it("refuses a redirect with no Location", async () => {
      apiHandler = (_q, res) => { res.writeHead(302); res.end(); };
      expect((await code(source().openArchive("acme", "vault", SHA))).code).toBe("unexpected_response");
    });
    it("refuses a download that declares more than the limit, without reading it", async () => {
      apiHandler = (_q, res) => { res.writeHead(200, { "content-length": "5000" }); res.end(Buffer.alloc(5000)); };
      expect((await code(source({ limits: { maxCompressedBytes: 1000 } }).openArchive("acme", "vault", SHA))).code).toBe("limit_exceeded");
    });
    it("a stalled response times out as retryable", async () => {
      apiHandler = () => undefined;
      const e = await code(source({ requestTimeoutMs: 150 }).openArchive("acme", "vault", SHA));
      expect(e).toMatchObject({ code: "timeout", retryable: true });
    });
    it("a body that goes quiet part-way is a retryable stall, not an endless wait", async () => {
      apiHandler = (_req, res) => { res.writeHead(200, { "content-length": "100000" }); res.write(Buffer.alloc(1000)); /* then silence */ };
      const opened = await source({ requestTimeoutMs: 200 }).openArchive("acme", "vault", SHA);
      const started = Date.now();
      const e = await code(drain(opened.body));
      expect(e).toMatchObject({ code: "timeout", retryable: true });
      expect(Date.now() - started).toBeLessThan(2000);
    });
    it("a slow but steady download is NOT cut short by the per-request timeout", async () => {
      const total = 8 * 4096;
      apiHandler = (_req, res) => {
        res.writeHead(200, { "content-length": String(total) });
        let sent = 0;
        const timer = setInterval(() => { res.write(Buffer.alloc(4096, 1)); sent += 4096; if (sent >= total) { clearInterval(timer); res.end(); } }, 60);
      };
      const opened = await source({ requestTimeoutMs: 200 }).openArchive("acme", "vault", SHA); // 8 chunks x 60 ms = ~480 ms, longer than the 200 ms timeout
      expect((await drain(opened.body)).length).toBe(total);
    });
    it("still honours the caller's overall deadline while the body is streaming", async () => {
      apiHandler = (_req, res) => { res.writeHead(200); const t = setInterval(() => res.write("x"), 20); res.on("close", () => clearInterval(t)); };
      const controller = new AbortController(); setTimeout(() => controller.abort(), 120);
      const opened = await source({ requestTimeoutMs: 5000 }).openArchive("acme", "vault", SHA, controller.signal);
      const e = await code(drain(opened.body));
      expect(e).toMatchObject({ code: "timeout", retryable: true });
    });
    it("a connection that drops mid-download is a retryable network error, not a short archive", async () => {
      apiHandler = (req, res) => { res.writeHead(200, { "content-length": "100000" }); res.write(Buffer.alloc(1000)); setTimeout(() => req.socket.destroy(), 30); };
      const opened = await source().openArchive("acme", "vault", SHA);
      const e = await code(drain(opened.body));
      expect(e).toMatchObject({ retryable: true }); expect(["network", "timeout"]).toContain(e.code);
    });
    it("a refused connection is retryable", async () => {
      const dead = await listen(() => undefined); const origin = dead.origin; dead.server.close();
      const e = await code(new GitHubSource({ testOrigins: { api: origin, archive: [] } }).getRepository("acme", "vault"));
      expect(e).toMatchObject({ code: "network", retryable: true });
    });
  });
});

describe("GitHubSource production behaviour (no network: the fetch function is injected)", () => {
  const response = (status: number, headers: Record<string, string> = {}, body = "{}") => new Response(body, { status, headers });
  it("talks only to https://api.github.com and encodes names", async () => {
    const urls: string[] = [];
    const s = new GitHubSource({ fetcher: (async (url: URL) => { urls.push(String(url)); return response(200, {}, JSON.stringify({ id: 1, full_name: "a/b", default_branch: "main", private: false })); }) as unknown as typeof fetch });
    await s.getRepository("a", "b");
    expect(urls).toEqual(["https://api.github.com/repos/a/b"]);
  });
  it("refuses redirects to any other host, to http, or to a host that only looks like GitHub", async () => {
    for (const target of ["https://evil.example/x", "http://codeload.github.com/x", "https://codeload.github.com.evil.example/x", "https://api.github.com@evil.example/x", "file:///etc/passwd", "https://user:pw@codeload.github.com/x", "https://codeload.github.com:8443/x"]) {
      const s = new GitHubSource({ fetcher: (async () => response(302, { location: target })) as unknown as typeof fetch });
      expect((await code(s.openArchive("a", "b", SHA))).code, target).toBe("redirect_refused");
    }
  });
  it("follows a redirect from the API to codeload.github.com", async () => {
    const urls: string[] = [];
    const s = new GitHubSource({ fetcher: (async (url: URL) => { urls.push(String(url)); return urls.length === 1 ? response(302, { location: "https://codeload.github.com/a/b/legacy.tar.gz/x" }) : response(200, {}, "data"); }) as unknown as typeof fetch });
    await drain((await s.openArchive("a", "b", SHA)).body);
    expect(urls[1]).toBe("https://codeload.github.com/a/b/legacy.tar.gz/x");
  });
  it("accepts test origins only when NODE_ENV is exactly 'test' (not production, not development, not unset)", () => {
    const before = process.env.NODE_ENV;
    try {
      for (const v of ["production", "development", ""]) {
        process.env.NODE_ENV = v;
        expect(() => new GitHubSource({ testOrigins: { api: "http://127.0.0.1:1", archive: [] } }), v).toThrow(/NODE_ENV/);
      }
      delete process.env.NODE_ENV;
      expect(() => new GitHubSource({ testOrigins: { api: "http://127.0.0.1:1", archive: [] } })).toThrow(/NODE_ENV/);
    } finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
  });
  it("refuses a tree id or commit id that is not 40 hex characters", async () => {
    const s = new GitHubSource({ fetcher: (async () => response(200)) as unknown as typeof fetch });
    expect((await code(s.getTree("a", "b", "../x"))).code).toBe("invalid_reference");
    expect((await code(s.openArchive("a", "b", "main"))).code).toBe("invalid_reference");
  });
});
