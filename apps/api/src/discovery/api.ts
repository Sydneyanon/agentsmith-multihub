import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { monitorSource } from "./monitor.js";
import { approveOpportunity, createSource, dismissOpportunity, getOpportunity, listOpportunities, listSources, setSourceEnabled } from "./store.js";
import { DiscoveryError, SOURCE_KEY } from "./types.js";

const OPERATOR = "operator"; // single-operator alpha: every authenticated call is the operator
const id = z.string().uuid();

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof DiscoveryError) {
    const status = error.code === "not_found" || error.code === "unknown_source" ? 404 : error.code === "invalid_state" || error.code === "source_exists" ? 409 : 400;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", details: error.flatten() });
  // migration 0008 not applied in this database: say so instead of a generic 500 (the Control Room reads the same fact from engine status)
  if ((error as { code?: unknown } | null)?.code === "42P01") return reply.code(503).send({ error: "discovery_not_installed" });
  throw error;
}

/** All routes sit under /v1 and are therefore bearer-protected by the default-deny auth hook. Nothing here fetches except `check`, an explicit human action. */
export function registerDiscoveryRoutes(app: FastifyInstance, pool: Pool | undefined) {
  const need = (reply: FastifyReply) => (pool ? null : reply.code(503).send({ error: "database_not_configured" }));

  app.get("/v1/discovery/sources", async (_request, reply) => {
    if (need(reply)) return reply;
    try { return { sources: await listSources(pool!) }; } catch (error) { return fail(reply, error); }
  });

  app.post("/v1/discovery/sources", async (request, reply) => {
    if (need(reply)) return reply;
    try { return reply.code(201).send(await createSource(pool!, request.body as never, OPERATOR)); } catch (error) { return fail(reply, error); }
  });

  for (const action of ["enable", "disable"] as const) {
    app.post(`/v1/discovery/sources/:key/${action}`, async (request, reply) => {
      if (need(reply)) return reply;
      try {
        const key = z.string().regex(SOURCE_KEY).parse((request.params as { key: string }).key);
        await setSourceEnabled(pool!, key, action === "enable", OPERATOR);
        return { source_key: key, enabled: action === "enable" };
      } catch (error) { return fail(reply, error); }
    });
  }

  /** An explicit human "check now": one monitoring pass, ignoring the interval but never the enabled flag. */
  app.post("/v1/discovery/sources/:key/check", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const key = z.string().regex(SOURCE_KEY).parse((request.params as { key: string }).key);
      return await monitorSource({ pool: pool!, sourceKey: key, force: true, minForceGapSeconds: 60 });
    } catch (error) { return fail(reply, error); }
  });

  app.get("/v1/discovery/opportunities", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const q = z.object({ state: z.string().optional(), platform: z.string().optional(), limit: z.coerce.number().optional() }).parse(request.query);
      return { opportunities: await listOpportunities(pool!, { ...(q.state ? { state: q.state as never } : {}), ...(q.platform ? { platform: q.platform } : {}), ...(q.limit ? { limit: q.limit } : {}) }) };
    } catch (error) { return fail(reply, error); }
  });

  app.get("/v1/discovery/opportunities/:id", async (request, reply) => {
    if (need(reply)) return reply;
    const parsed = id.safeParse((request.params as { id: string }).id);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_id" });
    try {
      const found = await getOpportunity(pool!, parsed.data);
      return found ?? reply.code(404).send({ error: "not_found" });
    } catch (error) { return fail(reply, error); }
  });

  app.post("/v1/discovery/opportunities/:id/approve", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const oid = id.parse((request.params as { id: string }).id);
      const result = await approveOpportunity(pool!, oid, request.body as never, OPERATOR);
      return reply.code(result.reused ? 200 : 201).send({ research_run_id: result.runId, reused: result.reused, execution_mode: "passive_only", active_testing_allowed: false });
    } catch (error) { return fail(reply, error); }
  });

  app.post("/v1/discovery/opportunities/:id/dismiss", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const oid = id.parse((request.params as { id: string }).id);
      await dismissOpportunity(pool!, oid, String((request.body as { reason?: unknown } | null)?.reason ?? ""), OPERATOR);
      return { dismissed: true };
    } catch (error) { return fail(reply, error); }
  });
}
