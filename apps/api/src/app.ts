import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerBearerAuth, type AuthFailureLimiter } from "./auth.js";
import { createClientIdentity, parseCidrList } from "./client-identity.js";
import { registerIntakeRoutes } from "./intake.js";
import { registerWorkflowRoutes } from "./workflows.js";
import { registerResearchRoutes } from "./research-api.js";
import { registerHubStatic } from "./hub-static.js";
import { registerHostGuard } from "./host-guard.js";

export type AppOptions = {
  pool: Pool | undefined;
  apiBearerToken: string | undefined;
  hubAllowedHosts: readonly string[];
  logLevel?: string;
  limiter?: AuthFailureLimiter;
  /** CIDR ranges of proxies whose Fly-Client-IP header may be believed. Empty/absent: trust no header. */
  trustedProxyCidrs?: readonly string[];
  /** Called for every route as it is registered (used by the route-coverage test). */
  onRouteRegistered?: (route: { method: string; url: string }) => void;
};

/** Builds the whole HTTP application without reading the environment or opening a socket, so tests can exercise the real thing. */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logLevel ? { level: options.logLevel } : false, trustProxy: false });
  if (options.onRouteRegistered) {
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) options.onRouteRegistered!({ method, url: route.url });
    });
  }
  registerHostGuard(app, options.hubAllowedHosts);
  const trusted = parseCidrList((options.trustedProxyCidrs ?? []).join(","));
  if ("error" in trusted) throw new Error(`Invalid trusted proxy range: ${trusted.error}`);
  registerBearerAuth(app, options.apiBearerToken, options.limiter, createClientIdentity(trusted.cidrs));
  const { pool } = options;
  app.get("/health/live", async () => ({ status: "ok", timestamp: new Date().toISOString() }));
  app.get("/health/ready", async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: "not_ready", reason: "database_not_configured" });
    try {
      await pool.query("select 1");
      return { status: "ready", dependencies: { postgres: "ok" } };
    } catch (error) {
      app.log.error({ err: error }, "Readiness check failed");
      return reply.code(503).send({ status: "not_ready", dependencies: { postgres: "error" } });
    }
  });
  registerIntakeRoutes(app, pool);
  registerWorkflowRoutes(app, pool);
  registerResearchRoutes(app, pool);
  registerHubStatic(app);
  app.addHook("onClose", async () => { await pool?.end(); });
  return app;
}
