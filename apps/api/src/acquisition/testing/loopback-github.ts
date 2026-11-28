import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GitFixture } from "./git-fixture.js";

/**
 * TESTS ONLY. A loopback HTTP server that answers like GitHub's REST API for any number of local git fixtures (real commit, tree and
 * blob ids, built by buildGitFixture), so the PRODUCTION GitHubSource runs unchanged against it (testOrigins, NODE_ENV=test). It is
 * the same kind of fake as acquisition/github-token.test.ts, made reusable for the API's own snapshot verification (option D, D2).
 * `mode` simulates outages; `hits` records every request (method, url, whether an Authorization header was sent).
 */
export type LoopbackGitHub = {
  origin: string; server: Server; hits: Array<{ method: string; url: string; authorized: boolean }>;
  add(fx: GitFixture, options?: { refs?: Record<string, string> }): void;
  /** "ok"; "down": every request gets 503; "drop": every connection is destroyed (a network failure) */
  mode: "ok" | "down" | "drop";
  close(): Promise<void>;
};

export async function startLoopbackGitHub(): Promise<LoopbackGitHub> {
  const repos = new Map<string, { fx: GitFixture; refs: Record<string, string> }>();
  const hits: LoopbackGitHub["hits"] = [];
  const json = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const state = { mode: "ok" as LoopbackGitHub["mode"] };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    hits.push({ method: req.method ?? "", url, authorized: Boolean(req.headers.authorization) });
    if (state.mode === "drop") { req.socket.destroy(); return; }
    if (state.mode === "down") return json(res, { message: "service unavailable" }, 503);
    const m = /^\/repos\/([^/]+)\/([^/?]+)(\/.*)?$/.exec(url);
    const r = m ? repos.get(`${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`.toLowerCase()) : undefined;
    if (!m || !r) return json(res, { message: "Not Found" }, 404);
    const rest = m[3] ?? ""; const { fx } = r;
    if (rest === "") return json(res, { id: 4242, full_name: `${fx.owner}/${fx.repo}`, default_branch: "main", private: false, archived: false, fork: false });
    const commit = /^\/commits\/([^/?]+)$/.exec(rest);
    if (commit) {
      const ref = decodeURIComponent(commit[1]!); const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : r.refs[ref];
      if (!sha || sha !== fx.commitSha) return json(res, { message: "No commit found for SHA" }, 422);
      return json(res, { sha, commit: { tree: { sha: fx.treeSha } } });
    }
    if (rest === `/git/trees/${fx.treeSha}?recursive=1`) return json(res, { sha: fx.treeSha, truncated: false, tree: fx.treeEntries });
    if (rest === `/tarball/${fx.commitSha}`) { res.writeHead(200, { "content-type": "application/x-gzip" }); return res.end(fx.tarGz); }
    return json(res, { message: "Not Found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, server, hits,
    add(fx, options = {}) { repos.set(`${fx.owner}/${fx.repo}`.toLowerCase(), { fx, refs: { main: fx.commitSha, HEAD: fx.commitSha, ...options.refs } }); },
    get mode() { return state.mode; }, set mode(v) { state.mode = v; },
    async close() { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
  };
}
