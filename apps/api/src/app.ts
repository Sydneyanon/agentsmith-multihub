import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerBearerAuth, type AuthFailureLimiter } from "./auth.js";
import { createClientIdentity, parseCidrList } from "./client-identity.js";
import { registerIntakeRoutes } from "./intake.js";
import { registerWorkflowRoutes } from "./workflows.js";
import { registerResearchRoutes } from "./research-api.js";
import { registerDiscoveryRoutes } from "./discovery/api.js";
import { registerBountyRoutes } from "./bounties/api.js";
import { registerHubStatic } from "./hub-static.js";
import { registerHostGuard } from "./host-guard.js";
import { isWorkerApiRequest, registerWorkerApi, WORKER_API_PREFIX, type WorkerApiOptions } from "./worker-api.js";
import { registerOperationsRoutes } from "./operations-api.js";
import { expectedMigrations, readBuildInfo, registerEngineStatusRoutes, type EngineInfo } from "./engine-status.js";

export type AppOptions = {
  pool: Pool | undefined;
  apiBearerToken: string | undefined;
  hubAllowedHosts: readonly string[];
  logLevel?: string;
  limiter?: AuthFailureLimiter;
  /** How long a /health/ready answer is reused, so the public probe cannot hammer or keep awake the database. Default 5000 ms; 0 disables. */
  readinessCacheMs?: number;
  /** CIDR ranges of proxies whose Fly-Client-IP header may be believed. Empty/absent: trust no header. */
  trustedProxyCidrs?: readonly string[];
  /** Called for every route as it is registered (used by the route-coverage test). */
  onRouteRegistered?: (route: { method: string; url: string }) => void;
  /** Build identity, data label and shipped migrations for GET /v1/engine/status. Default: read from the build; data unlabelled. */
  engineInfo?: Partial<EngineInfo>;
  /** Bounty collection options (tests inject a fixture transport and disable the public-feed cache). */
  bounties?: { http?: import("./bounties/http.js").HttpGet; publicCacheMs?: number };
  /** Option D: serve the internal worker API (run-scoped worker tokens). Absent: no such route exists. */
  workerApi?: WorkerApiOptions;
};

/** Builds the whole HTTP application without reading the environment or opening a socket, so tests can exercise the real thing. */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logLevel ? { level: options.logLevel } : false, trustProxy: false });
  if (options.onRouteRegistered) {
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) options.onRouteRegistered!({ method, url: route.url });
    });
  }
  // Internal details (hostnames, ports, driver messages) never reach a client; 4xx keep their messages.
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
      return reply.code(status).send({ error: "internal_error" });
    }
    return reply.code(status).send(error);
  });
  registerHostGuard(app, options.hubAllowedHosts, options.workerApi?.privateListenerPort !== undefined ? { port: options.workerApi.privateListenerPort, pathPrefix: WORKER_API_PREFIX } : undefined);
  const trusted = parseCidrList((options.trustedProxyCidrs ?? []).join(","));
  if ("error" in trusted) throw new Error(`Invalid trusted proxy range: ${trusted.error}`);
  registerBearerAuth(app, options.apiBearerToken, options.limiter, createClientIdentity(trusted.cidrs), options.workerApi ? isWorkerApiRequest : undefined);
  const { pool } = options;
  app.get("/health/live", async () => ({ status: "ok", timestamp: new Date().toISOString() }));
  const cacheMs = options.readinessCacheMs ?? 5_000;
  let cached: { at: number; ok: boolean } | undefined;
  app.get("/health/ready", async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: "not_ready", reason: "database_not_configured" });
    if (!(cached && Date.now() - cached.at < cacheMs)) {
      try {
        await pool.query("select 1");
        cached = { at: Date.now(), ok: true };
      } catch (error) {
        app.log.error({ err: error }, "Readiness check failed");
        cached = { at: Date.now(), ok: false };
      }
    }
    return cached.ok ? { status: "ready", dependencies: { postgres: "ok" } } : reply.code(503).send({ status: "not_ready", dependencies: { postgres: "error" } });
  });
  registerIntakeRoutes(app, pool);
  registerWorkflowRoutes(app, pool);
  registerResearchRoutes(app, pool);
  registerDiscoveryRoutes(app, pool);
  registerBountyRoutes(app, pool, options.bounties ?? {});
  registerEngineStatusRoutes(app, pool, { build: options.engineInfo?.build ?? readBuildInfo(), dataKind: options.engineInfo?.dataKind ?? "unlabelled", expectedMigrations: options.engineInfo?.expectedMigrations !== undefined ? options.engineInfo.expectedMigrations : expectedMigrations() });
  if (options.workerApi) registerWorkerApi(app, pool, options.workerApi);
  registerOperationsRoutes(app, pool, { workerApiEnabled: Boolean(options.workerApi), githubVerifierConfigured: options.workerApi ? Boolean(options.workerApi.github) : null });
  registerHubStatic(app);
  app.addHook("onClose", async () => { await pool?.end(); });
  return app;
}
