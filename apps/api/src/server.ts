import Fastify from "fastify";
import { Pool } from "pg";
import { config } from "./config.js";
import { registerIntakeRoutes } from "./intake.js";
import { registerWorkflowRoutes } from "./workflows.js";

const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      max: 5,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 30_000,
      ...(config.environment === "production" ? { ssl: { rejectUnauthorized: true } } : {}),
    })
  : undefined;

export function buildServer() {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });
  app.get("/", async () => ({ service: "agentsmith-multihub-api", version: "0.1.0", status: "scaffolded" }));
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
  app.addHook("onClose", async () => { await pool?.end(); });
  return app;
}

const app = buildServer();
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
