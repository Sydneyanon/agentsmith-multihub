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
export function registerHostGuard(app: FastifyInstance, allowedHosts: readonly string[]): void {
  if (allowedHosts.length === 0) return;
  const allowed = new Set(allowedHosts);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health/live" || request.url === "/health/ready") return;
    const host = (request.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (!allowed.has(host)) return reply.code(421).send({ error: "misdirected_request" });
  });
}
