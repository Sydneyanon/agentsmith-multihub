import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { HttpGet, HttpResponse } from "../http.js";

const DIR = new URL("./fixtures/", import.meta.url);
export const fixture = (name: string): string => {
  const buf = readFileSync(new URL(name, DIR));
  return (name.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
};
export const BOARD_JSON = () => fixture("board-programs-2026-11-27.json.gz");
export const SHERLOCK_HTML = () => fixture("sherlock-bug-bounties-2026-11-27.html.gz");
export const HACKENPROOF_HTML = () => fixture("hackenproof-programs-p1-2026-11-27.html.gz");

export type Route = { status?: number; body: string; contentType?: string; headers?: Record<string, string>; location?: string } | ((url: string) => { status?: number; body: string; contentType?: string; location?: string });
/** A recorded HttpGet: serves fixtures by exact URL, counts requests, and answers 404 for anything else. */
export function fakeHttp(routes: Record<string, Route>): HttpGet & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = routes[url];
    const res = typeof r === "function" ? r(url) : r ?? { status: 404, body: "not found", contentType: "text/plain" };
    const body = Buffer.from(res.body, "utf8");
    const out: HttpResponse = { status: res.status ?? 200, finalUrl: url, contentType: res.contentType ?? "text/html", body: res.body, bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"), retryAfterSeconds: null, location: res.location ?? null };
    return out;
  }) as HttpGet & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** HackenProof page 2 with no programme cards: the end of pagination. */
export const EMPTY_HP_PAGE = "<html><body><main><p>No programs</p></main></body></html>";
export const standardRoutes = (): Record<string, Route> => ({
  "https://bug-bounty-board.vercel.app/robots.txt": { status: 404, body: "not found", contentType: "text/plain" },
  "https://bug-bounty-board.vercel.app/programs.json": { body: BOARD_JSON(), contentType: "application/json" },
  "https://audits.sherlock.xyz/robots.txt": { body: "User-Agent: *\n", contentType: "text/plain" },
  "https://audits.sherlock.xyz/bug-bounties": { body: SHERLOCK_HTML() },
  "https://hackenproof.com/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
  "https://hackenproof.com/programs": { body: HACKENPROOF_HTML() },
  "https://hackenproof.com/programs?page=2": { body: EMPTY_HP_PAGE },
});
