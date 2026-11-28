import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Serves the private hub client under /hub/. It is a fixed allow-list of files from one directory (default
 * dist/web), so there is no path traversal and no directory listing. The shell is public static code; every data
 * request it makes goes to the bearer-protected /v1 API.
 */
export const HUB_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "font-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml",
};
const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.(js|css|svg)$/;

/** One year; no includeSubDomains, so the root domain and the Hunt site are never affected by the hub's policy. */
export const HUB_HSTS = "max-age=31536000";

export function registerHubStatic(app: FastifyInstance, options: { assetsDir?: string; hsts?: boolean } = {}): void {
  const hsts = options.hsts ?? process.env.NODE_ENV === "production";
  const dir = options.assetsDir ?? process.env.HUB_ASSETS_DIR ?? join(process.cwd(), "dist", "web");

  const send = async (reply: FastifyReply, file: string, ext: string) => {
    try {
      const body = await readFile(file);
      if (hsts) reply.header("strict-transport-security", HUB_HSTS);
      return reply.header("content-type", TYPES[ext]!).header("content-security-policy", HUB_CSP).header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer").header("cache-control", "no-cache").header("cross-origin-resource-policy", "same-origin").send(body);
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  };

  // The bare hostname is the hub: send people to the dashboard and reveal nothing about the service (no name, no version).
  app.get("/", async (_request, reply) => reply.header("cache-control", "no-store").redirect("/hub/", 302));
  app.get("/hub", async (_request, reply) => reply.redirect("/hub/", 302));
  app.get("/hub/", async (_request, reply) => {
    try { await readFile(join(dir, "index.html")); } catch { return reply.code(503).send({ error: "hub_assets_not_built", hint: "run npm run build" }); }
    return send(reply, join(dir, "index.html"), "html");
  });
  // The public bounty dashboard: a static page that reads only GET /public/bounties.json (same CSP, no token, no write path).
  app.get("/bounties", async (_request, reply) => reply.redirect("/bounties/", 302));
  app.get("/bounties/", async (_request, reply) => {
    try { await readFile(join(dir, "bounties.html")); } catch { return reply.code(503).send({ error: "hub_assets_not_built", hint: "run npm run build" }); }
    return send(reply, join(dir, "bounties.html"), "html");
  });
  app.get("/hub/assets/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!ASSET_NAME.test(name) || name.includes("..")) return reply.code(404).send({ error: "not_found" });
    return send(reply, join(dir, "assets", name), name.slice(name.lastIndexOf(".") + 1));
  });
}
