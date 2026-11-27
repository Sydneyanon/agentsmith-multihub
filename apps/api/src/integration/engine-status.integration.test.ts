import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthFailureLimiter, registerBearerAuth } from "../auth.js";
import { expectedMigrations, registerEngineStatusRoutes, workerApplicationName } from "../engine-status.js";
import { assertIntegrationConfigured, migratedTestDatabase, restrictedMode, skipIntegration, type TestDatabase } from "./harness.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const TOKEN = randomBytes(36).toString("base64url");
const AUTH = { authorization: `Bearer ${TOKEN}` };

describe.skipIf(skipIntegration)("GET /v1/engine/status over real Postgres (CR2)", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let worker: pg.Pool | undefined;
  const status = async () => { const r = await app.inject({ method: "GET", url: "/v1/engine/status", headers: AUTH }); expect(r.statusCode).toBe(200); return { body: r.json(), raw: r.body }; };
  const run = async (type: string, steps: Array<{ key: string; status: string; lease?: "live" | "expired"; error?: unknown }>) => {
    const r = await db.ownerPool.query<{ id: string }>("INSERT INTO workflow_runs (workflow_type, status, input, created_by) VALUES ($1, 'running', '{}'::jsonb, 'operator') RETURNING id", [type]);
    for (const [i, s] of steps.entries()) {
      await db.ownerPool.query(
        `INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, status, attempt, error, lease_owner, lease_expires_at, started_at, completed_at)
         VALUES ($1,$2,$3,'test',$4,$5,$6::jsonb,$7,$8,$9,$10)`,
        [r.rows[0]!.id, s.key, i, s.status, s.status === "queued" ? 0 : 1, s.error ? JSON.stringify(s.error) : null,
          s.lease ? "intake-test-worker" : null, s.lease === "live" ? new Date(Date.now() + 60_000) : s.lease === "expired" ? new Date(Date.now() - 60_000) : null,
          s.status === "queued" ? null : new Date(), ["succeeded", "failed"].includes(s.status) ? new Date() : null]);
    }
    return r.rows[0]!.id;
  };

  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await migratedTestDatabase();
    app = Fastify({ logger: false });
    registerBearerAuth(app, TOKEN, new AuthFailureLimiter({ perClientMax: 1e6, globalMax: 1e6, windowMs: 60_000 }));
    registerEngineStatusRoutes(app, db.pool, { build: { commit: null, image: null, built_at: null, source: "none" }, dataKind: "test", expectedMigrations: expectedMigrations() });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await worker?.end(); await db?.drop(); });

  it("an empty database is idle: no runs, no worker, nothing queued, schema complete, every stage empty or not built", async () => {
    const { body } = await status();
    expect(body.engine).toEqual({ state: "idle", reasons: [] });
    expect(body.data_kind).toBe("test");
    expect(body.workers.connected).toEqual([]); expect(body.workers.live_lease_owners).toEqual([]);
    expect(body.queue.totals).toEqual({ queued: 0, running_live: 0, running_expired_lease: 0, failed_24h: 0 });
    expect(body.queue.by_lane).toEqual([]); expect(body.runs).toEqual([]);
    expect(body.last).toEqual({ run: null, step_success: null, failure: null });
    // the least-privilege runtime role has no access to the migration ledger (db-roles.test pins it): the page says so instead of guessing
    if (restrictedMode) expect(body.schema).toMatchObject({ ledger_readable: false, applied: null, missing: null });
    else expect(body.schema).toMatchObject({ ledger_readable: true, missing: [] });
    expect(body.schema.discovery_installed).toBe(true);
    expect(body.stages.discovery).toMatchObject({ installed: true, sources: 0 });
    expect(body.stages.hypotheses).toMatchObject({ total: 0, note: "hypotheses are leads, not findings" });
    expect(body.stages.adjudication.human_confirmed_findings).toBeNull();
    expect(body.stages.memory.built).toBe(false);
    expect(body.build.source).toBe("none");
  });

  it("queued work with no worker connected is flagged, not shown as working", async () => {
    await run("repository_research", [{ key: "acquire_repository", status: "queued" }]);
    const { body } = await status();
    expect(body.engine.state).toBe("attention");
    expect(body.engine.reasons).toContain("1 step(s) are queued but no worker is connected");
    expect(body.queue.by_lane[0]).toMatchObject({ workflow_type: "repository_research", kind: "structural", steps: [expect.objectContaining({ step_key: "acquire_repository", queued: 1 })] });
  });

  it("a connected idle worker is visible through its session name, with its structural switch, even with no lease", async () => {
    worker = new pg.Pool({ connectionString: db.url, max: 1, application_name: workerApplicationName("intake-cr2-test", { STRUCTURAL_ANALYSIS_ENABLED: "true" }) });
    // Postgres terminates this idle session when the disposable database is dropped in teardown (57P01). Without a listener the
    // pool turns that into an unhandled error under full-suite load; the application guards its own pools the same way.
    worker.on("error", () => undefined);
    await worker.query("SELECT 1"); // the pool keeps this idle connection open
    const { body } = await status();
    expect(body.workers.connected).toEqual([{ worker_id: "intake-cr2-test", structural_analysis: true, connections: 1 }]);
    expect(body.engine.state).toBe("queued"); // queued, a worker is connected, nothing running yet
  });

  it("only a live lease counts as running; an expired lease is attention and never shown as live", async () => {
    await run("link_or_idea_intake", [{ key: "resolve_source", status: "succeeded" }, { key: "identify_project", status: "running", lease: "live" }]);
    let { body } = await status();
    expect(body.engine.state).toBe("working");
    expect(body.queue.totals.running_live).toBe(1);
    expect(body.workers.live_lease_owners).toEqual(["intake-test-worker"]);
    const legacy = body.queue.by_lane.find((l: any) => l.workflow_type === "link_or_idea_intake");
    expect(legacy).toMatchObject({ kind: "legacy", label: "Legacy intake (link_or_idea_intake)" });
    await db.ownerPool.query("UPDATE workflow_steps SET lease_expires_at = now() - interval '1 minute' WHERE status = 'running'");
    ({ body } = await status());
    expect(body.queue.totals).toMatchObject({ running_live: 0, running_expired_lease: 1 });
    expect(body.workers.running[0]).toMatchObject({ live: false });
    expect(body.engine.state).toBe("attention");
  });

  it("the last failure is shaped: no credentials, addresses or opaque tokens; and no secret reaches the response", async () => {
    const secret = "S".repeat(48);
    await run("repository_research", [{ key: "acquire_repository", status: "failed", error: { message: `GET https://x:${secret}@codeload.github.com/a/b?sig=${secret} failed via 10.0.0.7:443`, retryable: false } }]);
    const { body, raw } = await status();
    expect(body.last.failure).toMatchObject({ step_key: "acquire_repository", error: { retryable: false } });
    expect(body.last.failure.error.message).toContain("https://codeload.github.com/a/b");
    for (const leak of [secret, "10.0.0.7", TOKEN, new URL(db.url).password].filter(Boolean)) expect(raw).not.toContain(leak);
    expect(body.engine.reasons.some((r: string) => /failed in the last 24 hours/.test(r))).toBe(true);
  });

  it("requires the token", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/engine/status" })).statusCode).toBe(401);
  });
});
