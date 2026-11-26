import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerBearerAuth, AuthFailureLimiter } from "../auth.js";
import { registerDiscoveryRoutes } from "../discovery/api.js";
import { monitorSource } from "../discovery/monitor.js";
import { ensureDueMonitorRuns, MONITOR_STEP_KEY, processMonitorSourceStep } from "../discovery/step.js";
import { approveOpportunity, createSource, dismissOpportunity, getOpportunity, listOpportunities, setSourceEnabled } from "../discovery/store.js";
import { WorkflowWorker } from "../worker.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

const repo = (name: string, over: Record<string, unknown> = {}) => ({
  name, full_name: `code-423n4/${name}`, html_url: `https://github.com/code-423n4/${name}`, description: "Code4rena audit contest", archived: false, fork: false, private: false,
  created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), pushed_at: "2026-11-25T00:00:00Z", topics: [], ...over,
});
type Call = { url: string; headers: Record<string, string>; redirect?: string; method?: string };
/** A scripted GitHub: each call returns the next response; every request is recorded. No network. */
function script(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => { calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(init?.redirect ? { redirect: init.redirect } : {}), ...(init?.method ? { method: init.method } : {}) }); return responses.shift()!(); }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe.skipIf(skipIntegration)("bounty discovery over real Postgres", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await migratedTestDatabase(); });
  afterAll(async () => { await db?.drop(); });
  let n = 0; let key = "";
  beforeEach(async () => {
    key = `c4-${(n += 1)}`;
    await createSource(db.pool, { sourceKey: key, adapter: "github_org_repos", displayName: "Code4rena", config: { org: "code-423n4", platform: "code4rena", requireDatePrefix: true }, minIntervalSeconds: 300 });
  });
  const run = (fetcher: typeof fetch, extra: Record<string, unknown> = {}) => monitorSource({ pool: db.pool, sourceKey: key, fetcher, ...extra } as never);
  const obs = async () => (await db.ownerPool.query("SELECT outcome, error_code, http_status, items_seen FROM discovery_observations o JOIN discovery_sources s ON s.id = o.source_id WHERE s.source_key = $1 ORDER BY o.observed_at, o.id", [key])).rows;

  describe("sources are passive until a human enables them", () => {
    it("is created disabled and a disabled source is never fetched", async () => {
      const s = script([]);
      expect(await run(s.fetcher)).toEqual({ outcome: "skipped", reason: "disabled" });
      expect(s.calls).toHaveLength(0);
      expect((await db.ownerPool.query("SELECT action FROM audit_events WHERE entity_type = 'discovery_source' ORDER BY id DESC LIMIT 1")).rows[0]!.action).toMatch(/discovery\.source\./);
    });
    it("refuses an unknown source and a duplicate key, and an invalid configuration", async () => {
      await expect(monitorSource({ pool: db.pool, sourceKey: "nope-nope", fetcher: script([]).fetcher })).rejects.toMatchObject({ code: "unknown_source" });
      await expect(createSource(db.pool, { sourceKey: key, adapter: "github_org_repos", displayName: "x", config: { org: "a", platform: "pp" } })).rejects.toMatchObject({ code: "source_exists" });
      await expect(createSource(db.pool, { sourceKey: "bad-org", adapter: "github_org_repos", displayName: "x", config: { org: "a/b", platform: "pp" } as never })).rejects.toThrow();
    });
  });

  describe("monitoring pass", () => {
    beforeEach(async () => { await setSourceEnabled(db.pool, key, true); });

    it("discovers opportunities, records provenance (hash, size, never the body) and a discovery event per item", async () => {
      const s = script([json([repo("2026-11-vaultcore"), repo("2026-11-bridge"), repo("docs")], { etag: 'W/"abc"' })]);
      expect(await run(s.fetcher)).toEqual({ outcome: "ok", seen: 3, discovered: 2, updated: 0, closed: 0 });
      expect(s.calls[0]!.url).toBe("https://api.github.com/orgs/code-423n4/repos?type=public&sort=created&direction=desc&per_page=100");
      expect(s.calls[0]!.headers["authorization"]).toBeUndefined();
      expect(s.calls[0]).toMatchObject({ method: "GET", redirect: "manual" }); // passive: one GET, redirects are never followed
      const list = await listOpportunities(db.pool, { platform: "code4rena" });
      expect(list.filter((o) => String(o.canonical_key).startsWith("github:code-423n4/2026-11-")).length).toBeGreaterThanOrEqual(2);
      const o = (await db.ownerPool.query("SELECT * FROM bounty_opportunities WHERE canonical_key = 'github:code-423n4/2026-11-vaultcore'")).rows[0]!;
      expect(o.state).toBe("discovered"); expect(o.priority_score).toBeGreaterThan(0); expect(JSON.stringify(o.priority_reasons)).toMatch(/candidate/);
      const detail = await getOpportunity(db.pool, o.id);
      expect(detail!.events.map((e) => e.event_type)).toEqual(["discovered"]);
      const row = (await db.ownerPool.query("SELECT content_sha256, bytes, items_seen, outcome FROM discovery_observations ORDER BY observed_at DESC LIMIT 1")).rows[0]!;
      expect(row.content_sha256).toMatch(/^[0-9a-f]{64}$/); expect(row.bytes).toBeGreaterThan(10); expect(row.items_seen).toBe(3);
    });

    it("sends If-None-Match after the first pass; a 304 changes nothing and a repeat is deduplicated", async () => {
      const s = script([json([repo("2026-11-a")], { etag: 'W/"v1"' }), () => new Response(null, { status: 304 }), json([repo("2026-11-a")], { etag: 'W/"v1"' })]);
      await run(s.fetcher);
      expect(await run(s.fetcher, { force: true })).toEqual({ outcome: "not_modified" });
      expect(s.calls[1]!.headers["if-none-match"]).toBe('W/"v1"');
      expect(await run(s.fetcher, { force: true })).toMatchObject({ outcome: "ok", discovered: 0, updated: 0 });
      expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM bounty_opportunities WHERE canonical_key = 'github:code-423n4/2026-11-a'")).rows[0]!.n).toBe(1);
    });

    it("records a material change as an 'updated' event, ignores churn in pushed_at, and closes an archived repository", async () => {
      const s = script([json([repo("2026-11-b")]), json([repo("2026-11-b", { pushed_at: "2026-11-26T09:00:00Z" })]), json([repo("2026-11-b", { description: "New scope published" })]), json([repo("2026-11-b", { description: "New scope published", archived: true })])]);
      await run(s.fetcher);
      expect(await run(s.fetcher, { force: true })).toMatchObject({ updated: 0 });
      expect(await run(s.fetcher, { force: true })).toMatchObject({ updated: 1 });
      expect(await run(s.fetcher, { force: true })).toMatchObject({ closed: 1 });
      const o = (await db.ownerPool.query("SELECT id, state, priority_score FROM bounty_opportunities WHERE canonical_key = 'github:code-423n4/2026-11-b'")).rows[0]!;
      expect(o.state).toBe("closed"); expect(o.priority_score).toBe(0);
      expect((await getOpportunity(db.pool, o.id))!.events.map((e) => e.event_type)).toEqual(["discovered", "updated", "updated", "closed"]);
    });

    it("honours the minimum interval unless a human forces a check", async () => {
      const s = script([json([repo("2026-11-c")]), json([repo("2026-11-c")])]);
      await run(s.fetcher);
      expect(await run(s.fetcher)).toEqual({ outcome: "skipped", reason: "too_soon" });
      expect(s.calls).toHaveLength(1);
      expect((await run(s.fetcher, { force: true })).outcome).toBe("ok");
    });

    it.each([
      ["rate limit", () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "rate_limited"],
      ["secondary rate limit", () => new Response("{}", { status: 429 }), "rate_limited"],
      ["forbidden", () => new Response("{}", { status: 403 }), "forbidden"],
      ["not found", () => new Response("{}", { status: 404 }), "http_error"],
      ["server error", () => new Response("{}", { status: 502 }), "http_error"],
      ["redirect", () => new Response(null, { status: 301, headers: { location: "https://evil.example/" } }), "redirect_refused"],
      ["malformed JSON", () => new Response("{not json", { status: 200 }), "bad_json"],
      ["wrong shape", () => new Response(JSON.stringify({ message: "Not Found" }), { status: 200 }), "bad_shape"],
    ])("a %s answer is recorded as a failed observation and creates nothing", async (_name, response, code) => {
      const before = (await db.ownerPool.query("SELECT count(*)::int AS n FROM bounty_opportunities")).rows[0]!.n;
      expect(await run(script([response as () => Response]).fetcher)).toEqual({ outcome: "failed", errorCode: code });
      expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM bounty_opportunities")).rows[0]!.n).toBe(before);
      expect((await obs()).at(-1)).toMatchObject({ outcome: "failed", error_code: code });
      expect((await db.ownerPool.query("SELECT consecutive_failures FROM discovery_sources WHERE source_key = $1", [key])).rows[0]!.consecutive_failures).toBe(1);
    });

    it("refuses an oversized body (declared or streamed) and a network failure or timeout, and a good pass resets the failure count", async () => {
      expect(await run(script([() => new Response("x".repeat(2000), { status: 200 })]).fetcher, { maxBodyBytes: 1000, force: true })).toEqual({ outcome: "failed", errorCode: "response_too_large" });
      expect(await run(script([() => new Response("[]", { status: 200, headers: { "content-length": "99999999" } })]).fetcher, { force: true })).toEqual({ outcome: "failed", errorCode: "response_too_large" });
      expect(await run((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, { force: true })).toEqual({ outcome: "failed", errorCode: "network_error" });
      expect(await run((async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch, { force: true })).toEqual({ outcome: "failed", errorCode: "timeout" });
      expect((await db.ownerPool.query("SELECT consecutive_failures FROM discovery_sources WHERE source_key = $1", [key])).rows[0]!.consecutive_failures).toBe(4);
      await run(script([json([])]).fetcher, { force: true });
      expect((await db.ownerPool.query("SELECT consecutive_failures FROM discovery_sources WHERE source_key = $1", [key])).rows[0]!.consecutive_failures).toBe(0);
    });

    it("observations and events are append-only at the database level (even for the owner)", async () => {
      await run(script([json([repo("2026-11-d")])]).fetcher);
      await expect(db.ownerPool.query("UPDATE discovery_observations SET http_status = 500")).rejects.toThrow(/append-only/);
      await expect(db.ownerPool.query("DELETE FROM discovery_observations")).rejects.toThrow(/append-only/);
      await expect(db.ownerPool.query("UPDATE opportunity_events SET actor_id = 'x'")).rejects.toThrow(/append-only/);
      await expect(db.ownerPool.query("DELETE FROM opportunity_events")).rejects.toThrow(/append-only/);
    });
  });

  describe("a human decision connects an opportunity to the research queue", () => {
    let oppId = "";
    beforeEach(async () => {
      await setSourceEnabled(db.pool, key, true);
      const name = `2026-11-q${n}`;
      await run(script([json([repo(name)])]).fetcher);
      oppId = (await db.ownerPool.query("SELECT id FROM bounty_opportunities WHERE canonical_key = $1", [`github:code-423n4/${name}`])).rows[0]!.id;
    });

    it("approval atomically records the decision, queues ONE passive repository_research run and audits it", async () => {
      const out = await approveOpportunity(db.pool, oppId, { repository: "code-423n4/2026-11-q" + n, note: "looks in scope" }, "operator");
      expect(out.reused).toBe(false);
      const wf = (await db.ownerPool.query("SELECT workflow_type, status, input FROM workflow_runs WHERE id = $1", [out.runId])).rows[0]!;
      expect(wf).toMatchObject({ workflow_type: "repository_research", status: "queued" });
      expect(wf.input).toMatchObject({ kind: "repository", value: `code-423n4/2026-11-q${n}` });
      const step = (await db.ownerPool.query("SELECT step_key, status FROM workflow_steps WHERE workflow_run_id = $1", [out.runId])).rows;
      expect(step).toEqual([{ step_key: "acquire_repository", status: "queued" }]);
      const d = await getOpportunity(db.pool, oppId);
      expect(d!.opportunity.state).toBe("queued");
      expect(d!.events.map((e) => [e.event_type, e.actor_kind])).toEqual([["discovered", "monitor"], ["approved", "human"], ["queued", "human"]]);
      expect(d!.events.at(-1)!.research_run_id).toBe(out.runId);
      expect((await db.ownerPool.query("SELECT 1 FROM audit_events WHERE action = 'discovery.opportunity.approved' AND entity_id = $1", [oppId])).rowCount).toBe(1);
    });

    it("is idempotent: approving again returns the same run and queues nothing new", async () => {
      const a = await approveOpportunity(db.pool, oppId, { repository: "code-423n4/2026-11-q" + n }, "operator");
      const b = await approveOpportunity(db.pool, oppId, { repository: "code-423n4/2026-11-q" + n }, "operator");
      expect(b).toMatchObject({ runId: a.runId, reused: true });
      expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_type = 'repository_research' AND input->>'value' = $1", [`code-423n4/2026-11-q${n}`])).rows[0]!.n).toBe(1);
    });

    it("two simultaneous approvals still queue exactly one run", async () => {
      const [a, b] = await Promise.all([approveOpportunity(db.pool, oppId, { repository: "code-423n4/2026-11-q" + n }, "operator"), approveOpportunity(db.pool, oppId, { repository: "code-423n4/2026-11-q" + n }, "operator")]);
      expect(a.runId).toBe(b.runId);
      expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_type = 'repository_research' AND input->>'value' = $1", [`code-423n4/2026-11-q${n}`])).rows[0]!.n).toBe(1);
    });

    it("only a candidate repository can be chosen; a stranger, a closed or a dismissed opportunity cannot be approved, and nothing is queued", async () => {
      const before = (await db.ownerPool.query("SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_type = 'repository_research'")).rows[0]!.n;
      await expect(approveOpportunity(db.pool, oppId, { repository: "attacker/whatever" }, "operator")).rejects.toMatchObject({ code: "repository_not_a_candidate" });
      await expect(approveOpportunity(db.pool, oppId, { repository: "../../etc" }, "operator")).rejects.toThrow();
      await dismissOpportunity(db.pool, oppId, "not interested", "operator");
      await expect(approveOpportunity(db.pool, oppId, { repository: "code-423n4/2026-11-q" + n }, "operator")).rejects.toMatchObject({ code: "invalid_state" });
      expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_type = 'repository_research'")).rows[0]!.n).toBe(before);
      await expect(approveOpportunity(db.pool, "00000000-0000-0000-0000-000000000000", { repository: "a/b" }, "operator")).rejects.toMatchObject({ code: "not_found" });
    });

    it("the projection cannot claim a human decision the event log lacks, and a decision cannot be reverted (database rule)", async () => {
      for (const state of ["approved", "queued", "dismissed"]) await expect(db.ownerPool.query("UPDATE bounty_opportunities SET state = $2 WHERE id = $1", [oppId, state])).rejects.toThrow(/requires a recorded human/);
      await approveOpportunity(db.pool, oppId, { repository: (await db.ownerPool.query("SELECT repository_candidates->0->>'repository' AS r FROM bounty_opportunities WHERE id = $1", [oppId])).rows[0]!.r }, "operator");
      await expect(db.ownerPool.query("UPDATE bounty_opportunities SET state = 'discovered' WHERE id = $1", [oppId])).rejects.toThrow(/cannot be reverted/);
      expect((await db.ownerPool.query("SELECT state FROM bounty_opportunities WHERE id = $1", [oppId])).rows[0]!.state).toBe("queued");
    });

    it("an upstream archive of a queued opportunity records the closure but keeps it queued, so approval stays idempotent", async () => {
      const name = `2026-11-q${n}`;
      const repository = `code-423n4/${name}`;
      await approveOpportunity(db.pool, oppId, { repository }, "operator");
      const s = script([json([repo(name, { archived: true })])]);
      expect(await run(s.fetcher, { force: true })).toMatchObject({ closed: 1 });
      const o = (await db.ownerPool.query("SELECT state, priority_score FROM bounty_opportunities WHERE id = $1", [oppId])).rows[0]!;
      expect(o).toMatchObject({ state: "queued", priority_score: 0 });
      expect((await getOpportunity(db.pool, oppId))!.events.map((e) => e.event_type)).toEqual(["discovered", "approved", "queued", "updated", "closed"]);
      expect((await approveOpportunity(db.pool, oppId, { repository }, "operator")).reused).toBe(true);
    });

    it("a human 'check now' still respects a minimum gap when one is given", async () => {
      const s = script([json([repo(`2026-11-g${n}`)])]);
      // beforeEach has just run a pass, so a forced check inside the gap is refused without any request...
      expect(await run(s.fetcher, { force: true, minForceGapSeconds: 60 })).toEqual({ outcome: "skipped", reason: "too_soon" });
      expect(s.calls).toHaveLength(0);
      // ...while a plain forced check (no gap) proceeds.
      expect((await run(s.fetcher, { force: true })).outcome).toBe("ok");
      expect(s.calls).toHaveLength(1);
    });

    it("a monitor can never make a human decision (database rule)", async () => {
      await expect(db.ownerPool.query("INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id) VALUES ($1,'approved','monitor','x')", [oppId])).rejects.toThrow();
    });
  });

  describe("scheduling and the worker step", () => {
    it("creates one monitoring run per due enabled source, none for disabled or recently checked ones, and never duplicates a pending run", async () => {
      await db.ownerPool.query("DELETE FROM workflow_steps WHERE step_key = 'monitor_source'");
      await db.ownerPool.query("DELETE FROM workflow_runs WHERE workflow_type = 'source_monitoring'");
      await db.ownerPool.query("UPDATE discovery_sources SET enabled = false");
      expect(await ensureDueMonitorRuns(db.pool)).toBe(0);
      await setSourceEnabled(db.pool, key, true);
      expect(await ensureDueMonitorRuns(db.pool)).toBe(1);
      expect(await ensureDueMonitorRuns(db.pool)).toBe(0);
      expect(await Promise.all([ensureDueMonitorRuns(db.pool), ensureDueMonitorRuns(db.pool)])).toEqual([0, 0]);
    });

    it("two schedulers racing for the same due source create exactly one run (advisory lock plus re-check)", async () => {
      await db.ownerPool.query("UPDATE workflow_steps SET status = 'succeeded' WHERE step_key = 'monitor_source'");
      await db.ownerPool.query("UPDATE workflow_runs SET status = 'succeeded' WHERE workflow_type = 'source_monitoring'");
      await db.ownerPool.query("UPDATE discovery_sources SET enabled = false, last_attempt_at = NULL");
      await setSourceEnabled(db.pool, key, true);
      const results = await Promise.all([ensureDueMonitorRuns(db.pool), ensureDueMonitorRuns(db.pool), ensureDueMonitorRuns(db.pool)]);
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
      expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_type = 'source_monitoring' AND status = 'queued' AND input->>'source_key' = $1", [key])).rows[0]!.n).toBe(1);
    });
    it("the worker claims the step, monitors with the injected fetcher and completes with a passive-only output", async () => {
      await db.ownerPool.query("UPDATE workflow_steps SET status = 'succeeded' WHERE step_key = 'monitor_source'");
      await db.ownerPool.query("UPDATE workflow_runs SET status = 'succeeded' WHERE workflow_type = 'source_monitoring'");
      await setSourceEnabled(db.pool, key, true);
      await db.ownerPool.query("UPDATE discovery_sources SET enabled = false WHERE source_key <> $1", [key]);
      expect(await ensureDueMonitorRuns(db.pool)).toBe(1);
      const worker = new WorkflowWorker(db.pool, "discovery-test", 90, 3);
      const step = await worker.claimNext([MONITOR_STEP_KEY]);
      expect(step).not.toBeNull();
      await processMonitorSourceStep({ pool: db.pool, worker, fetcher: script([json([repo("2026-11-w")])]).fetcher }, step!);
      const done = (await db.ownerPool.query("SELECT status, output FROM workflow_steps WHERE id = $1", [step!.id])).rows[0]!;
      expect(done.status).toBe("succeeded");
      expect(done.output).toMatchObject({ outcome: "ok", discovered: 1, execution_mode: "passive_only", active_testing_allowed: false });
    });
  });

  describe("HTTP API (bearer-protected)", () => {
    it("creates sources disabled, validates input, lists, and exposes a decision flow; unauthenticated calls are refused", async () => {
      const app = Fastify({ logger: false });
      registerBearerAuth(app, "t".repeat(20) + "abcdefghijklmnopqrstuvwxyz0123456789", new AuthFailureLimiter({ perClientMax: 1000, globalMax: 100000, windowMs: 60_000 }));
      registerDiscoveryRoutes(app, db.pool);
      const auth = { authorization: `Bearer ${"t".repeat(20)}abcdefghijklmnopqrstuvwxyz0123456789` };
      try {
        expect((await app.inject({ method: "GET", url: "/v1/discovery/opportunities" })).statusCode).toBe(401);
        expect((await app.inject({ method: "POST", url: "/v1/discovery/sources", payload: {} })).statusCode).toBe(401);
        const bad = await app.inject({ method: "POST", url: "/v1/discovery/sources", headers: auth, payload: { sourceKey: "x-api", adapter: "github_org_repos", displayName: "x", config: { org: "a/b", platform: "pp" } } });
        expect(bad.statusCode).toBe(400);
        const ok = await app.inject({ method: "POST", url: "/v1/discovery/sources", headers: auth, payload: { sourceKey: "api-src", adapter: "github_org_repos", displayName: "API test", config: { org: "sherlock-audit", platform: "sherlock" } } });
        expect(ok.statusCode).toBe(201);
        expect((await app.inject({ method: "POST", url: "/v1/discovery/sources", headers: auth, payload: { sourceKey: "api-src", adapter: "github_org_repos", displayName: "API test", config: { org: "sherlock-audit", platform: "sherlock" } } })).statusCode).toBe(409);
        const list = (await app.inject({ method: "GET", url: "/v1/discovery/sources", headers: auth })).json() as { sources: Array<{ source_key: string; enabled: boolean }> };
        expect(list.sources.find((s) => s.source_key === "api-src")!.enabled).toBe(false);
        const check = await app.inject({ method: "POST", url: "/v1/discovery/sources/api-src/check", headers: auth });
        expect(check.json()).toEqual({ outcome: "skipped", reason: "disabled" }); // a disabled source is not fetched, even on a human 'check now'
        expect((await app.inject({ method: "POST", url: "/v1/discovery/sources/nope-nope/enable", headers: auth })).statusCode).toBe(404);
        expect((await app.inject({ method: "GET", url: "/v1/discovery/opportunities/not-a-uuid", headers: auth })).statusCode).toBe(400);
        expect((await app.inject({ method: "GET", url: "/v1/discovery/opportunities/00000000-0000-0000-0000-000000000000", headers: auth })).statusCode).toBe(404);
        expect((await app.inject({ method: "POST", url: "/v1/discovery/opportunities/00000000-0000-0000-0000-000000000000/approve", headers: auth, payload: { repository: "a/b" } })).statusCode).toBe(404);
        expect((await app.inject({ method: "POST", url: "/v1/discovery/opportunities/00000000-0000-0000-0000-000000000000/dismiss", headers: auth, payload: {} })).statusCode).toBe(400);
      } finally { await app.close(); }
    });
  });
});
