import type { FastifyInstance } from "fastify";

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Parses HUB_ALLOWED_HOSTS: a comma-separated list of exact lowercase hostnames. No wildcards, ports, schemes or paths. Returns the problem or the list. */
export function parseAllowedHosts(raw: string | undefined): { hosts: string[] } | { error: string } {
  if (!raw || !raw.trim()) return { hosts: [] };
  const hosts = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const host of hosts) if (!HOSTNAME.test(host)) return { error: `"${host}" is not an exact hostname (no wildcards, ports, schemes or paths)` };
  return { hosts: [...new Set(hosts)] };
}

/**
 * Serves the app only under its intended hostnames. Anything else (the platform's default hostname, a spoofed Host header, an
 * unrelated domain pointed at the same address) gets 421 before any route runs. Health checks are exempt because the platform calls
 * them with its own internal host. With no list configured nothing is restricted (local development, tests).
 */
/**
 * `privateWorkerApi`: the ONLY other exemption. A request that arrived on the private worker listener's own port (the socket's local
 * port, which a client cannot choose) AND targets the worker API path is served whatever its Host. On Fly the worker reaches the API as
 * `<app>.internal`, which must not be added to HUB_ALLOWED_HOSTS (that would serve the public listener under that name too). The same
 * path on the public listener, or any other path on the private listener, still needs an allowed Host.
 */
export function registerHostGuard(app: FastifyInstance, allowedHosts: readonly string[], privateWorkerApi?: { port: number; pathPrefix: string }): void {
  if (allowedHosts.length === 0) return;
  const allowed = new Set(allowedHosts);
  app.addHook("onRequest", async (request, reply) => {
    // Exact URLs only, on purpose: a query string does not earn the Host exemption (hub-deploy.test.ts pins this).
    if (request.url === "/health/live" || request.url === "/health/ready") return;
    if (privateWorkerApi && request.socket.localPort === privateWorkerApi.port && request.url.startsWith(privateWorkerApi.pathPrefix)) return;
    const host = (request.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (!allowed.has(host)) return reply.code(421).send({ error: "misdirected_request" });
  });
}
