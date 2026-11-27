import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { runCollection } from "./collect.js";
import { createHttpGet, type HttpGet } from "./http.js";
import { fetchPolicy, runImport } from "./import.js";
import { coverageMetrics, health, lifecycleOverview, listDuplicates, listImports, listPrograms, overview, programDetail, publicFeed, researchCandidates } from "./queries.js";
import { addCorrection, CORRECTABLE, decideDuplicate, setBountySourceEnabled } from "./store.js";
import { ADAPTERS } from "./adapters.js";
import { BountyError } from "./types.js";

/**
 * Bounty intelligence routes.
 * - /v1/bounties/* are operator routes and, like every /v1 route, bearer-protected by the default-deny auth hook. Imports, manual
 *   collection, corrections and duplicate decisions are explicit human actions.
 * - GET /public/bounties.json is the read-only public feed for the dashboard. It is cached in memory (60 s) so public traffic cannot
 *   hammer or keep awake the database, and it carries programme facts and provenance links only.
 */
const OPERATOR = "operator"; // single-operator alpha: every authenticated call is the operator
const id = z.string().uuid();
const listQuery = z.object({
  q: z.string().max(200).optional(), chain: z.string().max(60).optional(), tech: z.string().max(60).optional(), category: z.string().max(60).optional(), source: z.string().max(60).optional(),
  status: z.enum(["active", "reported_active", "paused", "closed", "no_longer_listed", "unknown", "requires_verification"]).optional(),
  verification: z.enum(["official_confirmed", "official_stale", "community_reported", "social_reported", "unverified", "conflicting"]).optional(),
  min_reward: z.coerce.number().min(0).optional(), needs_verification: z.enum(["true", "false"]).optional(),
  sort: z.enum(["priority", "reward", "discovered", "updated", "completeness"]).optional(), limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional(),
}).strict();
const importBody = z.object({ url: z.string().max(2048).optional().nullable(), text: z.string().max(50_000).optional().nullable(), kind: z.enum(["x_thread", "x_post"]).optional().nullable() }).strict()
  .refine((b) => !!(b.url?.trim() || b.text?.trim()), { message: "give a URL, pasted text, or both" });
const correctionBody = z.object({ field: z.enum(CORRECTABLE), value: z.unknown(), note: z.string().min(3).max(1000) }).strict();

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof BountyError) {
    const status = error.code === "not_found" ? 404 : error.code === "invalid_state" || error.code === "source_blocked" ? 409 : 400;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", details: error.flatten() });
  if ((error as { code?: unknown } | null)?.code === "42P01") return reply.code(503).send({ error: "bounties_not_installed", message: "migration 0011_bounty_intelligence is not applied in this database" });
  throw error;
}

export function registerBountyRoutes(app: FastifyInstance, pool: Pool | undefined, options: { http?: HttpGet; publicCacheMs?: number; fetchPolicy?: "respect" | "user_initiated" } = {}) {
  const need = (reply: FastifyReply) => (pool ? null : reply.code(503).send({ error: "database_not_configured" }));
  let http: HttpGet | null = options.http ?? null;
  const getHttp = () => (http ??= createHttpGet());
  const cacheMs = options.publicCacheMs ?? 60_000;
  let cached: { at: number; body: string } | null = null;

  app.get("/public/bounties.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=60").header("x-content-type-options", "nosniff").header("access-control-allow-origin", "*");
    if (!pool) return reply.code(503).send({ error: "database_not_configured" });
    if (cached && Date.now() - cached.at < cacheMs) return reply.type("application/json; charset=utf-8").send(cached.body);
    try {
      const body = JSON.stringify(await publicFeed(pool));
      cached = { at: Date.now(), body };
      return reply.type("application/json; charset=utf-8").send(body);
    } catch (error) { return fail(reply, error); }
  });

  app.get("/v1/bounties", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const q = listQuery.parse(request.query);
      return await listPrograms(pool!, { ...(q.q ? { q: q.q } : {}), ...(q.chain ? { chain: q.chain } : {}), ...(q.tech ? { tech: q.tech } : {}), ...(q.category ? { category: q.category } : {}),
        ...(q.source ? { source: q.source } : {}), ...(q.status ? { status: q.status } : {}), ...(q.verification ? { verification: q.verification } : {}),
        ...(q.min_reward !== undefined ? { minReward: q.min_reward } : {}), ...(q.needs_verification === "true" ? { needsVerification: true } : {}), ...(q.sort ? { sort: q.sort } : {}),
        ...(q.limit ? { limit: q.limit } : {}), ...(q.offset ? { offset: q.offset } : {}) });
    } catch (error) { return fail(reply, error); }
  });
  app.get("/v1/bounties/overview", async (_request, reply) => { if (need(reply)) return reply; try { return await overview(pool!); } catch (error) { return fail(reply, error); } });
  app.get("/v1/bounties/health", async (_request, reply) => { if (need(reply)) return reply; try { return await health(pool!); } catch (error) { return fail(reply, error); } });
  app.get("/v1/bounties/imports", async (_request, reply) => { if (need(reply)) return reply; try { return { imports: await listImports(pool!) }; } catch (error) { return fail(reply, error); } });
  app.get("/v1/bounties/duplicates", async (request, reply) => {
    if (need(reply)) return reply;
    try { const s = z.object({ status: z.enum(["open", "merged", "rejected"]).optional() }).strict().parse(request.query); return { candidates: await listDuplicates(pool!, s.status ?? "open") }; } catch (error) { return fail(reply, error); }
  });
  app.get("/v1/bounties/:id", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const d = await programDetail(pool!, id.parse((request.params as { id: string }).id));
      return d ?? reply.code(404).send({ error: "not_found" });
    } catch (error) { return fail(reply, error); }
  });

  app.post("/v1/bounties/imports", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const b = importBody.parse(request.body ?? {});
      const report = await runImport(pool!, getHttp(), { url: b.url ?? null, text: b.text ?? null, kind: b.kind ?? null, submittedBy: OPERATOR }, () => new Date(), options.fetchPolicy ?? fetchPolicy());
      cached = null;
      return reply.code(report.status === "failed" ? 422 : 201).send(report);
    } catch (error) { return fail(reply, error); }
  });
  app.post("/v1/bounties/collect", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const b = z.object({ sources: z.array(z.string().max(40)).max(20).optional(), force: z.boolean().optional() }).strict().parse(request.body ?? {});
      const r = await runCollection(pool!, { trigger: "manual", startedBy: OPERATOR, http: getHttp(), ...(b.sources ? { sources: b.sources } : {}), force: b.force ?? true });
      cached = null;
      return reply.code(r.status === "already_running" ? 409 : 200).send(r);
    } catch (error) { return fail(reply, error); }
  });
  app.post("/v1/bounties/:id/corrections", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const b = correctionBody.parse(request.body ?? {});
      const r = await addCorrection(pool!, id.parse((request.params as { id: string }).id), { field: b.field, value: b.value, note: b.note, by: OPERATOR });
      cached = null;
      return { status: r.status, verification: r.verification, resolved: r.resolved };
    } catch (error) { return fail(reply, error); }
  });
  app.post("/v1/bounties/duplicates/:id/:decision", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const p = z.object({ id, decision: z.enum(["merge", "reject"]) }).parse(request.params);
      const r = await decideDuplicate(pool!, p.id, p.decision, OPERATOR);
      cached = null;
      return r;
    } catch (error) { return fail(reply, error); }
  });

  app.get("/v1/bounties/candidates", async (_request, reply) => {
    if (need(reply)) return reply;
    try { return { candidates: await researchCandidates(pool!) }; } catch (error) { return fail(reply, error); }
  });
  app.get("/v1/bounties/lifecycle", async (_request, reply) => {
    if (need(reply)) return reply;
    try { return await lifecycleOverview(pool!); } catch (error) { return fail(reply, error); }
  });
  app.get("/v1/bounties/coverage", async (_request, reply) => {
    if (need(reply)) return reply;
    try { return await coverageMetrics(pool!); } catch (error) { return fail(reply, error); }
  });
  // Act on an owner's source-access decision: one authenticated call, not a manual database edit. Enabling a blocked source is refused.
  app.post("/v1/bounties/sources/:key/:action", async (request, reply) => {
    if (need(reply)) return reply;
    try {
      const p = z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/), action: z.enum(["enable", "disable"]) }).parse(request.params);
      const b = z.object({ access_status: z.string().max(40).optional(), note: z.string().max(1000).optional() }).strict().parse(request.body ?? {});
      const r = await setBountySourceEnabled(pool!, p.key, p.action === "enable", OPERATOR, { adapterBlocked: !!ADAPTERS[p.key]?.blocked, ...(b.access_status ? { accessStatus: b.access_status } : {}), ...(b.note ? { note: b.note } : {}) });
      cached = null;
      return r;
    } catch (error) { return fail(reply, error); }
  });
}
