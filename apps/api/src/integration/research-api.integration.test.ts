import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthFailureLimiter, registerBearerAuth } from "../auth.js";
import { HUB_CSP, registerHubStatic } from "../hub-static.js";
import { AUTOMATION_BASIS, HYPOTHESIS_STATUSES, registerResearchRoutes } from "../research-api.js";
import { sha256Hex } from "../research-state.js";
import { assertIntegrationConfigured, migratedTestDatabase, seedRun, skipIntegration, type TestDatabase } from "./harness.js";
import { ResearchFixture, VAULT } from "./research-helpers.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const TOKEN = randomBytes(36).toString("base64url");
const AUTH = { authorization: `Bearer ${TOKEN}` };
const LEGACY_KEYS = ["resolve_source", "identify_project", "locate_official_repositories", "establish_authorization", "map_attack_surface", "generate_hypotheses", "independent_challenge", "prepare_research_brief"];

describe.skipIf(skipIntegration)("hub research API over real Postgres", () => {
  let db: TestDatabase;
  let fx: ResearchFixture;
  let app: FastifyInstance;
  let assetsDir: string;
  const seeded: Record<string, any> = {};

  const get = async (url: string, headers: Record<string, string> = AUTH) => {
    const res = await app.inject({ method: "GET", url, headers });
    return { status: res.statusCode, headers: res.headers, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
  };

  async function legacyProject(finished: boolean) {
    const { runId, stepIds } = await seedRun(db.pool, LEGACY_KEYS);
    await db.ownerPool.query("UPDATE workflow_runs SET input = $2::jsonb, status = $3 WHERE id = $1", [runId,
      JSON.stringify({ kind: "url", value: finished ? "https://github.com/example/finished" : "https://github.com/example/active", source: "user", notes: "private operator note" }),
      finished ? "succeeded" : "running"]);
    const done = finished ? LEGACY_KEYS.length : 5;
    for (let i = 0; i < done; i += 1) {
      const output = LEGACY_KEYS[i] === "map_attack_surface"
        ? { status: "mapped", leads: [{ rule_id: "SOL-TX-ORIGIN", family: "solidity-authentication", path: "Vault.sol", count: 1, description: "tx.origin" }] }
        : LEGACY_KEYS[i] === "prepare_research_brief" ? { status: "brief_prepared", brief: { completeness: "all_stages_executed", research_completeness: "preliminary_unreviewed" } } : { status: "ok" };
      await db.ownerPool.query("UPDATE workflow_steps SET status = 'succeeded', attempt = 1, output = $2::jsonb, completed_at = now() WHERE id = $1", [stepIds[i], JSON.stringify(output)]);
    }
    if (!finished) await db.ownerPool.query("UPDATE workflow_steps SET status = 'running', attempt = 1, lease_owner = 'intake-test', lease_expires_at = now() + interval '1 minute' WHERE id = $1", [stepIds[5]]);
    await db.pool.query("INSERT INTO source_snapshots (workflow_run_id, workflow_step_id, source_uri, source_kind, content_sha256, content) VALUES ($1,$2,'https://api.github.com/repos/example/x','github_repository_metadata_api',$3,'{}'::jsonb)", [runId, stepIds[1], sha256Hex(`legacy${runId}`)]);
    await db.pool.query("INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason) VALUES ('user','intake.created','workflow_run',$1::text,(SELECT correlation_id FROM workflow_runs WHERE id = $1::uuid),'User submitted a research URL or idea')", [runId]);
    await db.pool.query("INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id) VALUES ('intake-test','workflow_step.claimed','workflow_step',$1::text,(SELECT correlation_id FROM workflow_runs WHERE id = $2::uuid))", [stepIds[0], runId]);
    return { runId, stepIds };
  }

  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await migratedTestDatabase();
    fx = new ResearchFixture(db);
    assetsDir = mkdtempSync(join(tmpdir(), "hub-assets-"));
    mkdirSync(join(assetsDir, "assets"));
    writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>hub</title>");
    writeFileSync(join(assetsDir, "assets", "app.js"), "export {};");
    writeFileSync(join(assetsDir, "assets", "styles.css"), "body{}");
    app = Fastify({ logger: false });
    registerBearerAuth(app, TOKEN, new AuthFailureLimiter({ perClientMax: 1000, globalMax: 100000, windowMs: 60_000 })); // roomy: this suite makes many deliberate unauthenticated probes
    registerResearchRoutes(app, db.pool);
    registerHubStatic(app, { assetsDir });
    await app.ready();

    // legacy projects
    seeded.active = await legacyProject(false);
    seeded.finished = await legacyProject(true);

    // research state: one sealed snapshot with stored, skipped and non-text files, spans, hypotheses in several states
    const ctx = await fx.step();
    const snapshotId = await fx.store.createSnapshot(ctx.lease, { repository: "synthetic/fixture-vault", commitSha: fx.commit(), refName: "main", acquisitionReport: { note: "test fixture" } });
    const vault = await fx.store.putBlob(ctx.lease, Buffer.from(VAULT, "utf8"));
    const bad = await fx.store.putBlob(ctx.lease, Buffer.from([0x66, 0xff, 0xfe, 0x0a]));
    const gone = await fx.store.putBlob(ctx.lease, Buffer.from(`evictable ${fx.next()}\nsecond line\n`));
    await fx.store.addSnapshotFiles(ctx.lease, snapshotId, [
      { path: "contracts/Vault.sol", classification: "source", sizeBytes: vault.sizeBytes, blobSha256: vault.sha256 },
      { path: "data/blob.bin", classification: "other", sizeBytes: bad.sizeBytes, blobSha256: bad.sha256 },
      { path: "docs/gone.md", classification: "docs", sizeBytes: gone.sizeBytes, blobSha256: gone.sha256 },
      { path: "big/huge.bin", classification: "other", sizeBytes: 9_000_000, skipReason: "oversize" },
    ]);
    await fx.store.sealSnapshot(ctx.lease, snapshotId);
    const c = { ...ctx, snapshotId };
    fx.adopt(c);
    const call = await fx.span(c, 5); const update = await fx.span(c, 6); const fn = await fx.span(c, 4, 7);
    const doc = await fx.store.createEvidenceSpan(ctx.lease, { snapshotId, path: "docs/gone.md", lineStart: 1, lineEnd: 1 });
    const h = {
      unreviewed: await fx.hypothesis(c, [call]),
      weakened: await fx.hypothesis(c, [update]),
      supported: await fx.hypothesis(c, [fn, call]),
      withdrawn: await fx.hypothesis(c, [doc]),
    };
    await fx.evaluate(c, h.weakened, "weakens", [fn]);
    await fx.evaluate(c, h.supported, "inconclusive", []);
    await fx.review(h.supported, "alice", "supports", "blinded_independent_assessment");
    await fx.review(h.supported, "bob", "supports", "disclosed_adjudication");
    await fx.store.withdraw("alice", h.withdrawn, "Superseded by a narrower claim.");
    Object.assign(seeded, { ctx: c, snapshotId, h, spans: { call, update, fn, doc }, blobs: { gone: gone.sha256 }, runId: ctx.runId });
  });

  afterAll(async () => {
    await app?.close();
    rmSync(assetsDir, { recursive: true, force: true });
    await db?.drop();
  });

  describe("access and safety", () => {
    it("refuses every research route without the bearer token, and when none is configured", async () => {
      for (const url of ["/v1/research/overview", "/v1/research/projects", "/v1/research/hypotheses", "/v1/research/activity"]) {
        expect((await get(url, {})).status, url).toBe(401);
        expect((await get(url, { authorization: "Bearer wrong" + "x".repeat(30) })).status, url).toBe(401);
      }
      const open = Fastify({ logger: false });
      registerBearerAuth(open, undefined);
      registerResearchRoutes(open, db.pool);
      expect((await open.inject({ method: "GET", url: "/v1/research/overview" })).statusCode).toBe(503);
      await open.close();
    });

    it("reports a missing database instead of failing obscurely", async () => {
      const bare = Fastify({ logger: false });
      registerResearchRoutes(bare, undefined);
      const res = await bare.inject({ method: "GET", url: "/v1/research/overview" });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: "database_not_configured" });
      await bare.close();
    });

    it("marks research responses as not cacheable", async () => {
      expect((await get("/v1/research/overview")).headers["cache-control"]).toBe("no-store");
    });

    it("rejects malformed ids and queries with 400 and unknown records with 404", async () => {
      for (const url of ["/v1/research/projects/nope", "/v1/research/hypotheses/123", "/v1/research/evidence/x", "/v1/research/snapshots/y"]) expect((await get(url)).status, url).toBe(400);
      for (const url of ["/v1/research/projects?limit=0", "/v1/research/projects?limit=101", "/v1/research/projects?status=bogus", "/v1/research/hypotheses?status=verified",
        "/v1/research/activity?limit=999", "/v1/research/activity?before=yesterday", "/v1/research/evidence/00000000-0000-4000-8000-000000000001?context=99"]) {
        expect((await get(url)).status, url).toBe(400);
      }
      const ghost = "00000000-0000-4000-8000-000000000999";
      for (const url of [`/v1/research/projects/${ghost}`, `/v1/research/hypotheses/${ghost}`, `/v1/research/evidence/${ghost}`, `/v1/research/snapshots/${ghost}`, `/v1/research/snapshots/${ghost}/files`, `/v1/research/snapshots/${ghost}/surface`]) {
        expect((await get(url)).status, url).toBe(404);
      }
    });
  });

  describe("overview", () => {
    it("counts real records and derives the hypothesis status distribution in the database", async () => {
      const { status, body } = await get("/v1/research/overview");
      expect(status).toBe(200);
      expect(body.projects.total).toBe(3);
      expect(body.research.snapshots).toEqual({ sealed: 1, building: 0 });
      expect(body.research.evidence_spans).toBe(4);
      expect(body.research.hypotheses.total).toBe(4);
      expect(body.research.hypotheses.by_status).toEqual({ unreviewed: 1, weakened_by_static_check: 1, supported_by_review: 1, withdrawn: 1 });
      expect(Object.keys(body.research.hypotheses.by_status).every((s) => (HYPOTHESIS_STATUSES as readonly string[]).includes(s))).toBe(true);
      expect(body.research.evaluations).toBe(2);
      expect(body.research.reviews).toEqual({ blinded_independent_assessment: 1, disclosed_adjudication: 1 });
      expect(body.research.events_24h.research).toBeGreaterThan(0);
      expect(body.storage.blobs).toBe("3");
      expect(body.pipeline.steps_by_key_and_status.map_attack_surface).toEqual({ succeeded: 2 });
    });

    it("derives pipeline health on the server from leases and failures, with reasons", async () => {
      const state = async () => (await get("/v1/research/overview")).body.pipeline;
      // this test changes step rows to create each state; put them back so later tests see the seeded data
      const original = (await db.pool.query("SELECT id, status, attempt, lease_owner, lease_expires_at, completed_at FROM workflow_steps")).rows;
      try {
        await checkHealthStates(state);
      } finally {
        for (const row of original) {
          await db.ownerPool.query("UPDATE workflow_steps SET status = $2, attempt = $3, lease_owner = $4, lease_expires_at = $5, completed_at = $6 WHERE id = $1",
            [row.id, row.status, row.attempt, row.lease_owner, row.lease_expires_at, row.completed_at]);
        }
      }
    });

    async function checkHealthStates(state: () => Promise<any>) {
      let pipeline = await state();
      expect(pipeline.health.state).toBe("working");
      expect(pipeline.live_lease_owners).toBeGreaterThanOrEqual(1);
      await db.ownerPool.query("UPDATE workflow_steps SET lease_expires_at = now() - interval '5 minutes' WHERE status = 'running'");
      pipeline = await state();
      expect(pipeline.health.state).toBe("attention");
      expect(pipeline.running_with_expired_lease).toBeGreaterThanOrEqual(1);
      expect(pipeline.health.reasons.join(" ")).toMatch(/expired lease/);
      await db.ownerPool.query("UPDATE workflow_steps SET status = 'succeeded', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE status IN ('running','queued')");
      pipeline = await state();
      expect(pipeline.health).toEqual({ state: "idle", reasons: [] });
      await db.ownerPool.query("UPDATE workflow_steps SET status = 'failed', completed_at = now() WHERE id = $1", [seeded.finished.stepIds[0]]);
      pipeline = await state();
      expect(pipeline.health.state).toBe("attention");
      expect(pipeline.health.reasons.join(" ")).toMatch(/failed in the last 24 hours/);
    }
  });

  describe("projects", () => {
    it("lists projects with an input summary but without private notes", async () => {
      const { body } = await get("/v1/research/projects");
      expect(body.items).toHaveLength(3);
      const active = body.items.find((p: any) => p.id === seeded.active.runId);
      expect(active.input).toEqual({ kind: "url", value: "https://github.com/example/active", source: "user" });
      expect(JSON.stringify(body)).not.toContain("private operator note");
      expect(active.progress).toMatchObject({ steps_total: 8, steps_succeeded: 5 });
      const research = body.items.find((p: any) => p.id === seeded.runId);
      expect(research.hypotheses).toEqual({ total: 4, by_status: { unreviewed: 1, weakened_by_static_check: 1, supported_by_review: 1, withdrawn: 1 } });
      expect(research.snapshots).toEqual({ total: 1, sealed: 1 });
      expect([research.evaluations, research.reviews]).toEqual([2, 2]);
      expect([active.evaluations, active.reviews]).toEqual([0, 0]);
    });

    it("filters by status and pages with has_more", async () => {
      expect((await get("/v1/research/projects?status=succeeded")).body.items.map((p: any) => p.id)).toEqual([seeded.finished.runId]);
      const first = (await get("/v1/research/projects?limit=2")).body;
      expect(first).toMatchObject({ limit: 2, offset: 0, has_more: true });
      const second = (await get("/v1/research/projects?limit=2&offset=2")).body;
      expect(second.items).toHaveLength(1);
      expect(second.has_more).toBe(false);
      expect(new Set([...first.items, ...second.items].map((p: any) => p.id)).size).toBe(3);
    });

    it("shows a project's steps, snapshots and the legacy pipeline output labelled as legacy", async () => {
      const { status, body } = await get(`/v1/research/projects/${seeded.finished.runId}`);
      expect(status).toBe(200);
      expect(body.notes).toBe("private operator note");
      expect(body.steps).toHaveLength(8);
      expect(body.steps[0]).toMatchObject({ step_key: "resolve_source", sequence: 0 });
      expect(body.legacy.note).toMatch(/legacy passive pipeline/);
      expect(body.legacy.note).toMatch(/not research-state evidence/);
      expect(body.legacy.brief).toMatchObject({ completeness: "all_stages_executed", research_completeness: "preliminary_unreviewed" });
      expect(body.legacy.leads).toHaveLength(1);
      expect(body.legacy.evidence_snapshots).toHaveLength(1);
      expect(body.snapshots).toEqual({ total: 0, sealed: 0 });
      expect(body.snapshot_records).toEqual([]);
      const research = (await get(`/v1/research/projects/${seeded.runId}`)).body;
      expect(research.snapshots).toEqual({ total: 1, sealed: 1 });
      expect(research.snapshot_records[0]).toMatchObject({ repository: "synthetic/fixture-vault", spans: 4, hypotheses: 4 });
      expect(research.legacy.brief).toBeNull();
    });

    it("reports lease state of a running step from the database clock", async () => {
      const { body } = await get(`/v1/research/projects/${seeded.active.runId}`);
      const stepStates = body.steps.map((s: any) => s.status);
      expect(stepStates.slice(0, 5)).toEqual(Array(5).fill("succeeded"));
      expect(body.progress.current_step).toBeTruthy();
    });
    it("A33: a failed step's error is shaped; credentials, addresses and opaque strings never leave the API", async () => {
      const secret = "Q".repeat(44);
      const { runId, stepIds } = await seedRun(db.pool, ["resolve_source"], "failed");
      await db.ownerPool.query("UPDATE workflow_steps SET status = 'failed', attempt = 3, completed_at = now(), error = $2::jsonb WHERE id = $1",
        [stepIds[0], JSON.stringify({ message: `GET https://u:${secret}@api.github.com/repos/x?token=${secret} failed via 10.2.3.4:443`, retryable: false, stack: "at secret.ts:1", upstream_body: secret })]);
      const res = await app.inject({ method: "GET", url: `/v1/research/projects/${runId}`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().steps[0].error).toEqual({ message: expect.stringContaining("https://api.github.com/repos/x"), retryable: false });
      for (const leak of [secret, "10.2.3.4", "at secret.ts", "upstream_body"]) expect(res.body).not.toContain(leak);
      expect((await get(`/v1/research/projects/${seeded.finished.runId}`)).body.steps.every((s: any) => s.error === null)).toBe(true);
    });
  });

  describe("snapshots and the repository explorer", () => {
    it("describes a pinned, sealed snapshot with file accounting and optional re-verification", async () => {
      const snap = (await get(`/v1/research/snapshots/${seeded.snapshotId}`)).body;
      expect(snap).toMatchObject({ repository: "synthetic/fixture-vault", sealed: true, file_count: 4, spans: 4, hypotheses: 4, verification: null });
      expect(snap.commit_sha).toMatch(/^[a-f0-9]{40}$/);
      expect(snap.files).toMatchObject({ stored: 3, skipped: 1, skip_reasons: { oversize: 1 }, by_classification: { source: 1, other: 2, docs: 1 } });
      const verified = (await get(`/v1/research/snapshots/${seeded.snapshotId}?verify=1`)).body;
      expect(verified.verification).toMatchObject({ ok: true, manifest_matches: true });
      expect((await get(`/v1/research/snapshots/${seeded.snapshotId}?verify=2`)).status).toBe(400);
      expect((await get(`/v1/research/snapshots?run=${seeded.runId}`)).body.items).toHaveLength(1);
    });

    it("lists manifest rows in byte order with citation counts, stored/skipped state and prefix filtering", async () => {
      const files = (await get(`/v1/research/snapshots/${seeded.snapshotId}/files`)).body.items;
      expect(files.map((f: any) => f.path)).toEqual(["big/huge.bin", "contracts/Vault.sol", "data/blob.bin", "docs/gone.md"]);
      expect(files[0]).toMatchObject({ stored: false, skip_reason: "oversize", size_bytes: 9_000_000 });
      expect(files[1]).toMatchObject({ stored: true, span_count: 3, hypothesis_count: 3 });
      const filtered = (await get(`/v1/research/snapshots/${seeded.snapshotId}/files?prefix=docs/`)).body.items;
      expect(filtered.map((f: any) => f.path)).toEqual(["docs/gone.md"]);
      expect((await get(`/v1/research/snapshots/${seeded.snapshotId}/files?prefix=%25`)).body.items).toEqual([]); // a LIKE wildcard is a literal here
    });

    it("returns a stored file's text with the spans and hypotheses that cite it", async () => {
      const file = (await get(`/v1/research/snapshots/${seeded.snapshotId}/file?path=${encodeURIComponent("contracts/Vault.sol")}`)).body;
      expect(file.text).toBe(VAULT);
      expect(file.line_count).toBe(8);
      expect(file.spans.map((s: any) => [s.line_start, s.line_end])).toEqual([[4, 7], [5, 5], [6, 6]]);
      const fnSpan = file.spans.find((s: any) => s.line_start === 4);
      expect(fnSpan.hypotheses.map((h: any) => h.status)).toEqual(["supported_by_review"]); // the weakening evaluation cites this span, the weakened hypothesis cites line 6
    });

    it("says why a file cannot be shown: skipped, not text, evicted, or unknown", async () => {
      const file = (path: string) => get(`/v1/research/snapshots/${seeded.snapshotId}/file?path=${encodeURIComponent(path)}`);
      expect(await file("big/huge.bin")).toMatchObject({ status: 409, body: { error: "skipped", reason: "oversize" } });
      expect(await file("data/blob.bin")).toMatchObject({ status: 415, body: { error: "not_text" } });
      expect((await file("nope/missing.sol")).status).toBe(404);
      expect((await get(`/v1/research/snapshots/${seeded.snapshotId}/file`)).status).toBe(400);
    });

    it("aggregates the attack-surface map from real manifest rows, spans and hypotheses only", async () => {
      const surface = (await get(`/v1/research/snapshots/${seeded.snapshotId}/surface`)).body;
      expect(surface.truncated).toBe(false);
      const vault = surface.files.find((f: any) => f.path === "contracts/Vault.sol");
      expect(vault).toMatchObject({ classification: "source", stored: true, spans: 3 });
      expect(vault.hypotheses_by_status).toEqual({ unreviewed: 1, weakened_by_static_check: 1, supported_by_review: 1 });
      expect(surface.files.find((f: any) => f.path === "big/huge.bin")).toMatchObject({ stored: false, spans: 0, hypotheses_by_status: {} });
    });
  });

  describe("hypotheses", () => {
    it("lists hypotheses with their derived status, provenance and counts, plus status facets", async () => {
      const { body } = await get("/v1/research/hypotheses");
      expect(body.items).toHaveLength(4);
      expect(body.facets.status).toEqual({ unreviewed: 1, weakened_by_static_check: 1, supported_by_review: 1, withdrawn: 1 });
      const supported = body.items.find((h: any) => h.id === seeded.h.supported);
      expect(supported).toMatchObject({
        status: "supported_by_review", repository: "synthetic/fixture-vault", generator: { kind: "deterministic_rule", id: "rule-reentrancy", version: "1" },
        counts: { evidence: 2, evaluations: 1, blinded_reviews: 1, adjudications: 1 }, static_conflicts_with_review: false,
      });
    });

    it("filters by status, run and snapshot, and keeps facets across the status filter", async () => {
      const weakened = (await get("/v1/research/hypotheses?status=weakened_by_static_check")).body;
      expect(weakened.items.map((h: any) => h.id)).toEqual([seeded.h.weakened]);
      expect(weakened.facets.status.supported_by_review).toBe(1);
      expect((await get(`/v1/research/hypotheses?run=${seeded.active.runId}`)).body.items).toEqual([]);
      expect((await get(`/v1/research/hypotheses?snapshot=${seeded.snapshotId}&limit=2`)).body).toMatchObject({ has_more: true });
    });

    it("returns the full record with evidence resolved from stored bytes, evaluations, reviews and the event history", async () => {
      const { status, body } = await get(`/v1/research/hypotheses/${seeded.h.supported}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ status: "supported_by_review", generator: { kind: "deterministic_rule" }, produced_by_step_id: seeded.ctx.lease.stepId });
      expect(body.evidence.map((e: any) => e.role)).toEqual(["primary", "supporting"]);
      expect(body.evidence[0].resolution).toMatchObject({ ok: true });
      expect(body.evidence[0].resolution.text).toContain("function withdraw");
      expect(body.evaluations[0]).toMatchObject({ actor_kind: "deterministic_rule", outcome: "inconclusive", span_ids: [] });
      expect(body.reviews.map((r: any) => [r.review_mode, r.reviewer_kind, r.reviewer_id])).toEqual([
        ["blinded_independent_assessment", "human", "alice"], ["disclosed_adjudication", "human", "bob"]]);
      expect(body.reviews[0].reviewer_saw).toMatchObject({ claim: true, generator_rationale: false, prior_reviews: false });
      expect(body.reviews[1].reviewer_saw).toMatchObject({ generator_rationale: true, prior_reviews: true });
      expect(body.reviews[0].model).toBeNull();
      expect(body.events.map((e: any) => e.event_type)).toEqual(["registered", "evaluation_recorded", "review_recorded", "review_recorded"]);
      expect(body.rationale).toBeTruthy();
    });

    it("shows a withdrawal with its reason and actor, and weakening evidence on the weakened claim", async () => {
      const withdrawn = (await get(`/v1/research/hypotheses/${seeded.h.withdrawn}`)).body;
      expect(withdrawn.status).toBe("withdrawn");
      expect(withdrawn.events.at(-1)).toMatchObject({ event_type: "withdrawn", actor_kind: "human", actor_id: "alice", reason: "Superseded by a narrower claim." });
      const weakened = (await get(`/v1/research/hypotheses/${seeded.h.weakened}`)).body;
      expect(weakened).toMatchObject({ status: "weakened_by_static_check", static_outcome: "weakens" });
      expect(weakened.evaluations[0].span_ids).toEqual([seeded.spans.fn]);
    });
  });

  describe("evidence", () => {
    it("lists spans with citation counts and filters", async () => {
      const all = (await get("/v1/research/evidence")).body.items;
      expect(all).toHaveLength(4);
      const call = all.find((s: any) => s.id === seeded.spans.call);
      expect(call).toMatchObject({ path: "contracts/Vault.sol", line_start: 5, line_end: 5, cited_by_hypotheses: 2, repository: "synthetic/fixture-vault" });
      expect((await get("/v1/research/evidence?path=docs/")).body.items).toHaveLength(1);
      expect((await get(`/v1/research/evidence?run=${seeded.runId}&limit=2`)).body).toMatchObject({ has_more: true });
    });

    it("resolves a span with context lines, database verification and everything that cites it", async () => {
      const { body } = await get(`/v1/research/evidence/${seeded.spans.call}?context=2`);
      expect(body.verification).toBe("ok");
      expect(body.resolution).toMatchObject({ ok: true });
      expect(body.resolution.text).toContain("msg.sender.call");
      expect(body.context.before.map((l: any) => l.line)).toEqual([3, 4]);
      expect(body.context.after.map((l: any) => l.line)).toEqual([6, 7]);
      expect(body.cited_by.hypotheses.map((h: any) => h.id).sort()).toEqual([seeded.h.supported, seeded.h.unreviewed].sort());
      expect(body.span.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    });

    it("fails closed when the evidence no longer resolves, saying why", async () => {
      const client = await db.ownerPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('agentsmith.blob_eviction', 'on', true)");
        await client.query("DELETE FROM research_blobs WHERE content_sha256 = $1", [seeded.blobs.gone]);
        await client.query("COMMIT");
      } finally { client.release(); }
      const { body } = await get(`/v1/research/evidence/${seeded.spans.doc}`);
      expect(body.resolution).toEqual({ ok: false, reason: "evicted" });
      expect(body.verification).toBe("evicted");
      expect(body.context).toBeNull();
      const hyp = (await get(`/v1/research/hypotheses/${seeded.h.withdrawn}`)).body;
      expect(hyp.evidence[0].resolution).toEqual({ ok: false, reason: "evicted" });
      expect((await get(`/v1/research/snapshots/${seeded.snapshotId}/file?path=docs%2Fgone.md`)).status).toBe(410);
    });
  });

  describe("activity", () => {
    it("merges research events and workflow audit events, classifying who acted", async () => {
      const { body } = await get("/v1/research/activity?limit=200");
      expect(body.automation_basis).toBe(AUTOMATION_BASIS);
      const by = (predicate: (i: any) => boolean): any[] => body.items.filter(predicate);
      expect(by((i) => i.action === "review_recorded").every((i) => i.automation === "human" && i.actor_kind === "human")).toBe(true);
      expect(by((i) => i.action === "evaluation_recorded").every((i) => i.automation === "automated" && i.actor_kind === "deterministic_rule")).toBe(true);
      expect(by((i) => i.action === "withdrawn")[0]).toMatchObject({ automation: "human", reason: "Superseded by a narrower claim." });
      expect(by((i) => i.action === "registered").every((i) => i.automation === "automated")).toBe(true);
      expect(by((i) => i.action === "intake.created").every((i) => i.automation === "human" && i.source === "workflow_audit")).toBe(true);
      const claimed = by((i) => i.action === "workflow_step.claimed");
      expect(claimed.length).toBeGreaterThan(0);
      expect(claimed.every((i) => i.automation === "automated" && i.actor_kind === "worker")).toBe(true);
      expect(claimed.some((i) => i.step_key === "resolve_source" && i.run_id)).toBe(true);
    });

    it("filters by automation and never labels an automated event as human", async () => {
      const human = (await get("/v1/research/activity?automation=human&limit=200")).body.items;
      const automated = (await get("/v1/research/activity?automation=automated&limit=200")).body.items;
      expect(human.length).toBeGreaterThan(0);
      expect(automated.length).toBeGreaterThan(0);
      expect(human.every((i: any) => i.automation === "human")).toBe(true);
      expect(automated.every((i: any) => i.automation === "automated")).toBe(true);
      expect((await get("/v1/research/activity?automation=model")).body.items).toEqual([]);
    });

    it("pages by a stable cursor with no duplicates and no gaps, newest first", async () => {
      const everything = (await get("/v1/research/activity?limit=200")).body.items.map((i: any) => i.id);
      const seen: string[] = [];
      let url = "/v1/research/activity?limit=7";
      for (let guard = 0; guard < 50; guard += 1) {
        const { body } = await get(url);
        seen.push(...body.items.map((i: any) => i.id));
        if (!body.next) break;
        url = `/v1/research/activity?limit=7&before=${encodeURIComponent(body.next.before)}&before_id=${encodeURIComponent(body.next.before_id)}`;
      }
      expect(seen).toEqual(everything);
      expect(new Set(seen).size).toBe(seen.length);
      const times = (await get("/v1/research/activity?limit=200")).body.items.map((i: any) => new Date(i.at).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });
  });

  describe("hub static files", () => {
    it("serves the shell with a strict content-security policy and refuses everything off the allow-list", async () => {
      const index = await app.inject({ method: "GET", url: "/hub/" });
      expect(index.statusCode).toBe(200);
      expect(index.headers["content-security-policy"]).toBe(HUB_CSP);
      expect(index.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(index.headers["content-security-policy"]).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(index.headers["x-content-type-options"]).toBe("nosniff");
      expect(index.headers["content-type"]).toContain("text/html");
      const js = await app.inject({ method: "GET", url: "/hub/assets/app.js" });
      expect(js.statusCode).toBe(200);
      expect(js.headers["content-type"]).toContain("text/javascript");
      for (const url of ["/hub/assets/..%2F..%2Fetc%2Fpasswd", "/hub/assets/secret.txt", "/hub/assets/.env", "/hub/assets/APP.JS", "/hub/assets/index.html", "/hub/assets/missing.js"]) {
        // Names the public allow-list does not even match (traversal, dotfiles) are refused by default-deny auth (401); other
        // off-list names reach the handler and are 404. Nothing off the allow-list is ever served.
        const unauth = (await app.inject({ method: "GET", url })).statusCode;
        expect(unauth, url).toBe(/\.\.|\/\.env$/.test(url) ? 401 : 404);
      }
      expect((await app.inject({ method: "GET", url: "/hub" })).headers.location).toBe("/hub/");
    });

    it("needs no token for the shell but still protects the data behind it", async () => {
      expect((await app.inject({ method: "GET", url: "/hub/" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/v1/research/overview" })).statusCode).toBe(401);
    });

    it("explains a missing build instead of failing", async () => {
      const bare = Fastify({ logger: false });
      registerHubStatic(bare, { assetsDir: join(assetsDir, "does-not-exist") });
      const res = await bare.inject({ method: "GET", url: "/hub/" });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe("hub_assets_not_built");
      await bare.close();
    });
  });
});
