import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRepositoryResearchRun } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { buildDossier, VALIDATOR_ID } from "../analysis/solidity/pipeline.js";
import { buildApp } from "../app.js";
import { AuthFailureLimiter } from "../auth.js";
import { ResearchStore } from "../research-state.js";
import { WorkerApiClient } from "../worker-api-client.js";
import { executeRemoteStep, remoteStepKeys } from "../worker-remote.js";
import type { ClaimedStep } from "../worker.js";
import { mintWorkerToken, revokeWorkerToken, sha256Hex } from "../worker-tokens.js";
import { expireLease, migratedTestDatabase, REPO_ROOT, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * SHARED ADVERSARIAL SCENARIOS (S1-S12), design D (API-mediated). The attacker is a COMPROMISED WORKER: it holds its run-scoped worker
 * token, can send ANY HTTP request (hand-crafted bodies, paths, methods, headers) to the API, and can read its own environment. It has no
 * database credential. The API is a real Fastify app on the OWNER connection, with the worker routes on a second, private listener
 * exactly as server.ts wires it (privateListenerPort), and the public listener next to it.
 *
 * [PREVENTED] asserts the refusal; [VULNERABLE] / [PARTIAL] assert the OBSERVED successful attack. The design is not changed here.
 * The same scenario ids are implemented against design B' in the B' worktree.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const DRAFT = join(REPO_ROOT, "db", "drafts", "d-worker-api", "0015_worker_capability_tokens.sql");
const OPERATOR = randomBytes(36).toString("base64url");
const corpus = join(REPO_ROOT, "eval", "dev", "contracts");
const devFiles = () => readdirSync(corpus).sort().map((f) => ({ path: `contracts/${f}`, content: readFileSync(join(corpus, f), "utf8") }));
const SWITCHES = { STRUCTURAL_ANALYSIS_ENABLED: "true" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secretOf = (token: string) => token.slice("wct1_".length + 33);
const freePort = () => new Promise<number>((resolve, reject) => { const s = createNetServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
const permissive = () => new AuthFailureLimiter({ perClientMax: 1e6, globalMax: 1e6, windowMs: 60_000 });
const PROTECTED = ["bounty_programs", "bounty_repository_mappings", "bounty_research_links", "bounty_sources", "bounty_opportunities", "bounty_scores", "ai_budget_reservations", "budget_policies", "approvals",
  "ai_model_prices", "discovery_sources", "programs", "hunt_gate_definitions", "schema_migrations", "worker_capability_tokens"];

type Api = { app: FastifyInstance; internal: Server; pool: pg.Pool; pub: number; priv: number; close(): Promise<void> };

describe.skipIf(skipIntegration)("ADVERSARIAL (shared scenarios) against D: a compromised worker holding a run-scoped token and arbitrary HTTP", () => {
  let db: TestDatabase; let api: Api; let base = ""; let pubBase = "";
  const fixtures: GitFixture[] = []; const apis: Api[] = [];
  const owner = () => db.ownerPool;

  /** The API as server.ts runs it: owner pool (max 5 as in production), public listener + private worker listener. */
  async function startApi(ports: { pub?: number; priv?: number } = {}, rateLimit?: { perSecond: number; burst: number }, connectTimeoutMs = 3_000): Promise<Api> {
    // as buildPoolConfig configures the API in production: max 5 (server.ts), connectionTimeoutMillis 3000 (DATABASE_CONNECT_TIMEOUT_MS default)
    const pool = new pg.Pool({ connectionString: db.url, max: 5, application_name: "dapi", connectionTimeoutMillis: connectTimeoutMs });
    pool.on("error", () => undefined); pool.on("connect", (c) => { c.on("error", () => undefined); });
    const priv = ports.priv ?? await freePort();
    const app = buildApp({ pool, apiBearerToken: OPERATOR, hubAllowedHosts: [], limiter: permissive(), engineInfo: { expectedMigrations: null },
      workerApi: { reaperIntervalMs: 0, limiter: permissive(), privateListenerPort: priv, ...(rateLimit ? { rateLimit } : {}) } });
    await app.listen({ host: "127.0.0.1", port: ports.pub ?? 0 });
    const internal = createServer((req, res) => app.server.emit("request", req, res));
    await new Promise<void>((resolve, reject) => { internal.once("error", reject); internal.listen(priv, "127.0.0.1", () => resolve()); });
    const a: Api = { app, internal, pool, pub: (app.server.address() as { port: number }).port, priv,
      async close() { const closed = new Promise<void>((r) => internal.close(() => r())); internal.closeAllConnections(); await closed; await app.close(); } };
    apis.push(a); return a;
  }

  beforeAll(async () => {
    db = await migratedTestDatabase();
    await owner().query(readFileSync(DRAFT, "utf8"));
    api = await startApi();
    base = `http://127.0.0.1:${api.priv}`; pubBase = `http://127.0.0.1:${api.pub}`;
    await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ('sherlock:adv', 'victim', 'victim', '{}'::jsonb, 'active', 'official_confirmed')`);
    await owner().query("INSERT INTO ai_budget_reservations (provider, model, purpose, tier, reserved_usd) VALUES ('test','m','investigation','tier2', 5.0)");
  });
  afterAll(async () => { for (const a of apis) await a.close().catch(() => undefined); for (const f of fixtures) f.cleanup(); await db?.drop(); });

  async function call(op: string, body: unknown, opts: { token?: string | null; key?: string | null | undefined; raw?: string; method?: string; url?: string; headers?: Record<string, string>; at?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    if (opts.key !== null) headers["idempotency-key"] = opts.key ?? randomUUID();
    const res = await fetch(opts.url ?? `${opts.at ?? base}/internal/worker/v1/${op}`, { method: opts.method ?? "POST", headers, signal: AbortSignal.timeout(30_000), ...(opts.method === "GET" || opts.method === "HEAD" ? {} : { body: opts.raw ?? JSON.stringify(body) }) });
    const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  }
  const plain = (op: string, body: unknown, token: string) => call(op, body, { token, key: null });

  type R = { runId: string; stepId: string; token: string; tokenId: string; client: WorkerApiClient; source: FakeSource; gx: GitFixture };
  async function researchRun(repo: string, files = devFiles()): Promise<R> {
    const { runId, stepId } = await createRepositoryResearchRun(owner(), { repository: `acme/${repo}`, ref: "main" }, "operator", { structuralAnalysis: true });
    const t = await mintWorkerToken(owner(), { runId, createdBy: "operator@test" });
    const gx = buildGitFixture(files, { owner: "acme", repo }); fixtures.push(gx);
    return { runId, stepId, token: t.token, tokenId: t.tokenId, client: new WorkerApiClient({ baseUrl: base, token: t.token, backoffMs: 1, attempts: 3 }), source: new FakeSource(gx), gx };
  }
  async function claim(r: R, keys = remoteStepKeys(SWITCHES)): Promise<ClaimedStep> { const s = await r.client.claimNext(keys); expect(s).not.toBeNull(); return s!; }
  async function drive(r: R): Promise<ClaimedStep> { const s = await claim(r); await executeRemoteStep(r.client, "adv", s, { source: r.source, env: SWITCHES }); return s; }
  const stepsOf = async (runId: string) => (await owner().query<{ id: string; step_key: string; status: string; attempt: number }>("SELECT id, step_key, status, attempt FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [runId])).rows;
  const snapOf = async (runId: string) => (await owner().query("SELECT id FROM repo_snapshots WHERE workflow_run_id = $1", [runId])).rows[0]?.id as string;
  const count = async (sql: string, params: unknown[] = []) => Number((await owner().query(sql, params)).rows[0].n);
  const fingerprint = async () => {
    const out: Record<string, string> = {};
    for (const t of PROTECTED) out[t] = (await owner().query<{ h: string }>(t === "worker_capability_tokens"
      ? "SELECT md5(coalesce(string_agg((id, workflow_run_id, secret_sha256, expires_at, revoked_at)::text, '|' ORDER BY id), '')) AS h FROM worker_capability_tokens"
      : `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0]!.h;
    return out;
  };
  const schemaFingerprint = async () => (await owner().query<{ h: string }>(
    `SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
       SELECT 'rel:' || c.oid::regclass::text || ':' || c.relkind::text || ':' || coalesce(c.relacl, acldefault('r', c.relowner))::text || ':' || c.relowner::regrole::text AS x FROM pg_class c
       UNION ALL SELECT 'att:' || attrelid::regclass::text || ':' || attname || ':' || atttypid::regtype::text FROM pg_attribute WHERE attnum > 0 AND NOT attisdropped
       UNION ALL SELECT 'fn:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || p.prosecdef FROM pg_proc p
       UNION ALL SELECT 'con:' || conrelid::regclass::text || ':' || conname || ':' || convalidated FROM pg_constraint
       UNION ALL SELECT 'tg:' || tgrelid::regclass::text || ':' || tgname || ':' || tgenabled::text FROM pg_trigger) q`)).rows[0]!.h;

  // shared state for the scenario battery: run A (the attacker's) and run B (another worker's), both through the real remote path
  let A: R; let B: R; let schemaBefore = ""; let protectedBefore: Record<string, string> = {};
  beforeAll(async () => {
    B = await researchRun("adv-b"); A = await researchRun("adv-a");
    await drive(B); await drive(B); // B: acquired and analysed; B's challenge step stays queued
    schemaBefore = await schemaFingerprint(); protectedBefore = await fingerprint();
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  it("S1 delete protected research records [PREVENTED]: no operation deletes; delete-like paths, methods and the fail operation remove nothing", async () => {
    const tables = ["hypotheses", "hypothesis_evidence", "evidence_spans", "hypothesis_evaluations", "repo_snapshots", "repo_snapshot_files", "research_blobs", "audit_events"];
    const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(`SELECT count(*) AS n FROM ${t}`)])));
    const before = await counts();
    for (const t of ["hypotheses", "repo_snapshots", "research_blobs", "evidence_spans"]) expect(before[t], t).toBeGreaterThan(0);
    for (const op of ["delete_hypothesis", "delete_snapshot", "evict_blob", "truncate", "delete", "query", "sql"]) {
      const r = await call(op, { step_id: A.stepId, sql: "DELETE FROM hypotheses" }, { token: A.token }); expect(r.status, op).toBe(401); // default-deny operator hook
    }
    for (const method of ["DELETE", "PUT", "PATCH"]) expect((await call("put_blob", {}, { token: A.token, method })).status, method).toBe(401);
    const s = await claim(A);
    expect((await call("fail", { step_id: s.id, reason: "x", retryable: true }, { token: A.token })).status).toBe(200); // re-queues; deletes nothing
    expect(await counts()).toMatchObject(Object.fromEntries(tables.filter((t) => t !== "audit_events").map((t) => [t, before[t]])));
  });

  it("S2 alter protected research records [PREVENTED]: no update operation; sealed snapshot, completed steps and recorded evaluations cannot be changed", async () => {
    const snapB = await snapOf(B.runId); const [acqB] = await stepsOf(B.runId);
    // B's finished steps: no lease, so no completion or failure can overwrite them, even with B's own token
    expect((await call("complete", { step_id: acqB!.id, output: { status: "snapshot_sealed", snapshot_id: snapB } }, { token: B.token })).json.error).toBe("lease_not_held");
    expect((await call("fail", { step_id: acqB!.id, reason: "x", retryable: false }, { token: B.token })).json.error).toBe("lease_not_held");
    // A acquires; then its sealed snapshot's manifest cannot grow, and re-sealing changes nothing
    const acq = await claim(A); await executeRemoteStep(A.client, "adv", acq, { source: A.source, env: SWITCHES });
    const snapA = await snapOf(A.runId);
    const manifest = (await owner().query("SELECT manifest_sha256 FROM repo_snapshots WHERE id = $1", [snapA])).rows[0].manifest_sha256;
    const an = await claim(A); // analyze_structure: may not add files, seal or create snapshots
    for (const [op, body] of [["add_snapshot_files", { step_id: an.id, snapshot_id: snapA, files: [{ path: "contracts/Evil.sol", classification: "source", size_bytes: 0, skip_reason: "binary" }] }],
      ["seal_snapshot", { step_id: an.id, snapshot_id: snapA }], ["create_snapshot", { step_id: an.id, repository: "acme/adv-a", commit_sha: "b".repeat(40), ref_name: "main" }]] as const) {
      expect((await call(op, body, { token: A.token })).json.error, op).toBe("operation_not_allowed_for_step");
    }
    expect((await owner().query("SELECT manifest_sha256 FROM repo_snapshots WHERE id = $1", [snapA])).rows[0].manifest_sha256).toBe(manifest);
    await executeRemoteStep(A.client, "adv", an, { source: A.source, env: SWITCHES }); // A is now analysed (real analysis)
  });

  it("S3 write outside the worker's responsibilities [PREVENTED]: bounty, budget, approval, price, gate, migration and token tables are byte-identical after the battery", async () => {
    // run at the end of the battery too (see S6); here: the only token-table write is last_used_at, which the fingerprint excludes
    expect(await fingerprint()).toEqual(protectedBefore);
    expect((await call("claim", { step_keys: ["acquire_repository"], table: "approvals" }, { token: A.token })).json.error).toBe("invalid_request");
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  it("S4 injection and reads beyond the run [PREVENTED]: ids, paths, family/claim text and JSON never reach SQL as code; cross-run reads refused or empty", async () => {
    const ch = await claim(A); expect(ch.step_key).toBe("challenge_leads");
    const snapA = await snapOf(A.runId); const snapB = await snapOf(B.runId);
    const hypsB = (await owner().query("SELECT id, claim FROM hypotheses WHERE workflow_run_id = $1", [B.runId])).rows as Array<{ id: string; claim: string }>;
    const inj = "x' OR '1'='1'; DELETE FROM hypotheses; --";
    for (const [op, body] of [
      ["hypothesis_span_ids", { step_id: ch.id, hypothesis_id: inj }], ["snapshot_sources", { step_id: `${ch.id}' OR 1=1 --`, snapshot_id: snapA }],
      ["specialist_hypothesis_id", { step_id: ch.id, snapshot_id: snapA, claim: inj, extra: { $where: "1" } }],
      ["slither_hypothesis_ids", { step_id: ch.id, snapshot_id: snapA, ids: [inj] }],
    ] as const) { const r = await plain(op, body, A.token); expect(r.status, op).toBe(400); expect(r.json.error).toBe("invalid_request"); }
    // well-formed but hostile text is data: the claim lookup returns nothing and nothing is deleted
    const before = await count("SELECT count(*) AS n FROM hypotheses");
    expect((await plain("specialist_hypothesis_id", { step_id: ch.id, snapshot_id: snapA, claim: inj }, A.token)).json.result).toBeNull();
    // B's claim text against A's snapshot: at most A's OWN identical lead (A and B analyse the same corpus); never B's row
    const byClaim = (await plain("specialist_hypothesis_id", { step_id: ch.id, snapshot_id: snapA, claim: hypsB[0]!.claim }, A.token)).json.result as string | null;
    if (byClaim) expect((await owner().query("SELECT workflow_run_id FROM hypotheses WHERE id = $1", [byClaim])).rows[0].workflow_run_id).toBe(A.runId);
    expect(byClaim).not.toBe(hypsB[0]!.id);
    expect((await plain("slither_hypothesis_ids", { step_id: ch.id, snapshot_id: snapA, ids: hypsB.map((h) => h.id) }, A.token)).json.result).toEqual([]);
    for (const [op, body] of [["snapshot_sources", { step_id: ch.id, snapshot_id: snapB }], ["hypothesis_span_ids", { step_id: ch.id, hypothesis_id: hypsB[0]!.id }]] as const) {
      expect((await plain(op, body, A.token)).json.error, op).toBe("cross_run_reference");
    }
    expect(await count("SELECT count(*) AS n FROM hypotheses")).toBe(before);
    // the sealed snapshot the run's read returns is the run's own
    expect((await plain("sealed_snapshot", { step_id: ch.id }, A.token)).json.result.snapshotId).toBe(snapA);
    expect((await call("fail", { step_id: ch.id, reason: "s4 done", retryable: true }, { token: A.token })).status).toBe(200);
  });

  it("S4 cross-run blob read through content addressing [PARTIAL]: knowing a blob's sha256+size, another run's bytes can be pulled into the attacker's snapshot", async () => {
    const C = await researchRun("adv-c", [{ path: "contracts/Mine.sol", content: "contract Mine {}\n" }]);
    const acq = await claim(C);
    const secretContent = (await owner().query("SELECT b.content_sha256 AS sha, b.size_bytes AS size, convert_from(b.content, 'UTF8') AS text FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.workflow_run_id = $1 AND f.path LIKE '%.sol' LIMIT 1", [B.runId])).rows[0];
    const snap = (await call("create_snapshot", { step_id: acq.id, repository: "acme/adv-c", commit_sha: C.gx.commitSha, ref_name: "main" }, { token: C.token })).json.result as string;
    // an existence oracle: an unknown hash is refused, a stored one (from any run) is accepted
    const unknown = await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [{ path: "contracts/X.sol", classification: "source", size_bytes: 3, blob_sha256: sha256Hex("nope") }] }, { token: C.token });
    expect(unknown.json.error).toBe("database_rejected"); expect(unknown.json.message).toMatch(/is not stored/);
    const known = await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [{ path: "contracts/Stolen.sol", classification: "source", size_bytes: secretContent.size, blob_sha256: secretContent.sha }] }, { token: C.token });
    expect(known.status).toBe(200);
    await call("seal_snapshot", { step_id: acq.id, snapshot_id: snap }, { token: C.token });
    await call("complete", { step_id: acq.id, output: { status: "snapshot_sealed", snapshot_id: snap } }, { token: C.token });
    const an = await claim(C);
    const src = (await plain("snapshot_sources", { step_id: an.id, snapshot_id: snap }, C.token)).json.result as Array<{ path: string; text: string }>;
    expect(src.find((f) => f.path === "contracts/Stolen.sol")!.text).toBe(secretContent.text); // B's file, read through C's token
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  it("S5 authentication [PREVENTED]: none, malformed, wrong secret, unknown id, another run's token, expired, revoked, terminal-run token; operator token", async () => {
    const R1 = await researchRun("adv-auth");
    const secret = randomBytes(32).toString("base64url");
    const expiredId = (await owner().query("INSERT INTO worker_capability_tokens (workflow_run_id, secret_sha256, created_by, created_at, expires_at) VALUES ($1,$2,'op', now() - interval '2 hours', now() - interval '1 hour') RETURNING id", [R1.runId, sha256Hex(secret)])).rows[0].id as string;
    const revoked = await mintWorkerToken(owner(), { runId: R1.runId, createdBy: "op" }); await revokeWorkerToken(owner(), { tokenId: revoked.tokenId, revokedBy: "op" });
    const doneRun = await researchRun("adv-done"); await owner().query("UPDATE workflow_runs SET status = 'succeeded' WHERE id = $1", [doneRun.runId]);
    const cases: Array<[string | null, number, string]> = [
      [null, 401, "token_invalid"], ["Basic abc", 401, "token_invalid"], [`wct1_${"0".repeat(32)}_${"A".repeat(43)}`, 401, "token_invalid"],
      [`${R1.token.slice(0, -2)}AA`, 401, "token_invalid"], [`wct1_${expiredId.replace(/-/g, "")}_${secret}`, 401, "token_expired"], [revoked.token, 401, "token_revoked"],
      [doneRun.token, 403, "run_terminal"], [OPERATOR, 401, "token_invalid"],
    ];
    for (const [tok, st, code] of cases) {
      const r = await call("claim", { step_keys: ["acquire_repository"] }, { token: tok, ...(tok === "Basic abc" ? { headers: { authorization: "Basic abc" }, token: null } : {}) });
      expect([r.status, r.json?.error], String(tok)).toEqual([st, code]);
    }
    // another run's token claims only ITS run: B's token never returns R1's queued step
    const other = await call("claim", { step_keys: ["acquire_repository"] }, { token: B.token });
    expect(other.json.result).toBeNull();
    expect((await stepsOf(R1.runId))[0]).toMatchObject({ status: "queued", attempt: 0 });
  });

  it("S5 authorisation [PREVENTED]: another run's step, a step without the lease, an operation not allowed for the step key, a lease-owner spoof in the body", async () => {
    const R2 = await researchRun("adv-authz");
    expect((await plain("heartbeat", { step_id: R2.stepId }, R2.token)).json.error).toBe("lease_not_held"); // not claimed yet
    const s = await claim(R2);
    expect((await plain("heartbeat", { step_id: s.id }, A.token)).json.error).toBe("step_not_in_run");
    const second = await mintWorkerToken(owner(), { runId: R2.runId, createdBy: "op" });
    expect((await plain("heartbeat", { step_id: s.id }, second.token)).json.error).toBe("lease_not_held");
    expect((await plain("build_dossier", { step_id: s.id, snapshot_id: randomUUID() }, R2.token)).json.error).toBe("operation_not_allowed_for_step");
    expect((await call("record_evaluation", { step_id: s.id, hypothesis_id: randomUUID(), evaluator_id: VALIDATOR_ID, evaluator_version: "1", outcome: "supports", rationale: "r", span_ids: [], input_sha256: "0".repeat(64) }, { token: R2.token })).json.error).toBe("operation_not_allowed_for_step");
    for (const extra of [{ worker_id: `worker-api:${second.tokenId}` }, { lease_owner: "x" }, { run_id: A.runId }, { token_id: second.tokenId }]) {
      expect((await plain("heartbeat", { step_id: s.id, ...extra }, second.token)).json.error, JSON.stringify(extra)).toBe("invalid_request");
    }
    expect((await plain("heartbeat", { step_id: s.id }, R2.token, )).json.result).toBe(true);
  });

  it("S5 request validation [PREVENTED]: oversize, extra fields, wrong types, unknown operation, path variants, other methods, public vs internal port", async () => {
    const v = async (p: Promise<{ status: number; json: any }>) => { const r = await p; return [r.status, r.json?.error ?? r.json?.message ?? null]; };
    expect(await v(call("heartbeat", { step_id: A.stepId, pad: "x".repeat(10_000) }, { token: A.token, key: null }))).toEqual([413, "body_too_large"]);
    expect(await v(call("claim", { step_keys: "acquire_repository" }, { token: A.token }))).toEqual([400, "invalid_request"]);
    expect(await v(call("claim", { step_keys: ["acquire_repository"], x: 1 }, { token: A.token }))).toEqual([400, "invalid_request"]);
    expect(await v(call("claim", null, { token: A.token, raw: "[1,2,3]" }))).toEqual([400, "invalid_request"]);
    expect(await v(call("claim", null, { token: A.token, raw: "{\"step_keys\":[\"acquire_repository\"],\"__proto__\":{\"admin\":true}}" }))).toEqual([400, "malformed_body"]); // prototype poisoning refused by the JSON parser
    expect(await v(call("claim", null, { token: A.token, raw: "step_keys=acquire_repository", headers: { "content-type": "application/x-www-form-urlencoded" } }))).toEqual([415, "unsupported_content_type"]);
    const statuses: Record<string, number> = {};
    for (const [method, path] of [["POST", "/internal/worker/v1/%63laim"], ["POST", "/internal/worker/v1//claim"], ["POST", "/internal//worker/v1/claim"], ["POST", "/INTERNAL/worker/v1/claim"],
      ["POST", "/internal/worker/v1/claim/"], ["POST", "/internal/worker/v1/claim%2F"], ["POST", "/internal/worker/v1/claim;x"], ["GET", "/internal/worker/v1/claim"], ["PUT", "/internal/worker/v1/claim"],
      ["POST", "/internal/worker/v1/nope"], ["GET", "/v1/workflows"], ["POST", "/v1/research/runs/" + A.runId + "/worker-tokens"]] as const) {
      statuses[`${method} ${path}`] = (await call("", { step_keys: ["acquire_repository"] }, { token: A.token, method, url: `${base}${path}` })).status;
    }
    // every variant that is not EXACTLY a worker path falls to the operator check, where the worker token is not valid (or the route is absent)
    for (const [k, st] of Object.entries(statuses)) expect([401, 404], k).toContain(st);
    expect(statuses["POST /v1/research/runs/" + A.runId + "/worker-tokens"]).toBe(401); // a worker cannot mint tokens
    // a query string is the same path and is served (it carries nothing the handler reads)
    expect((await call("", { step_keys: ["acquire_repository"] }, { token: A.token, url: `${base}/internal/worker/v1/claim?run=${B.runId}` })).status).toBe(200);
    // the public listener never serves worker routes, even with a valid token and a spoofed Host/X-Forwarded-* header
    const onPublic = await call("claim", { step_keys: ["acquire_repository"] }, { token: A.token, at: pubBase, headers: { host: `127.0.0.1:${api.priv}`, "x-forwarded-port": String(api.priv), "x-forwarded-for": "127.0.0.1" } });
    expect(onPublic.status).toBe(404);
  });

  it("S5 replay, duplicates and races [PREVENTED with a note]: same key+body replays, same key+other body or op conflicts, racing duplicates write once; different keys DO write twice", async () => {
    const R3 = await researchRun("adv-replay");
    const acq = await claim(R3);
    const body = { step_id: acq.id, content_base64: Buffer.from(`replay ${randomUUID()}`).toString("base64") };
    const key = randomUUID();
    const r1 = await call("put_blob", body, { token: R3.token, key }); const r2 = await call("put_blob", body, { token: R3.token, key });
    expect(r1.status).toBe(200); expect(r2.json).toMatchObject({ ok: true, replayed: true, result: r1.json.result });
    expect((await call("put_blob", { ...body, content_base64: "eA==" }, { token: R3.token, key })).json.error).toBe("idempotency_conflict");
    expect((await call("heartbeat", { step_id: acq.id }, { token: R3.token, key })).status).toBe(200); // a plain op ignores the key
    expect((await call("create_snapshot", { step_id: acq.id, repository: "acme/adv-replay", commit_sha: "c".repeat(40), ref_name: "main" }, { token: R3.token, key })).json.error).toBe("idempotency_conflict");
    const k2 = randomUUID();
    const snapBody = { step_id: acq.id, repository: "acme/adv-replay", commit_sha: R3.gx.commitSha, ref_name: "main" };
    const raced = await Promise.all(Array.from({ length: 12 }, () => call("create_snapshot", snapBody, { token: R3.token, key: k2 })));
    // every accepted duplicate gets the SAME snapshot id and only one row is written. Duplicates that lose the race can instead time out
    // waiting for one of the 5 pool connections (see "racing duplicates exhaust the owner pool"): observed as 422 'rejected' or
    // 500 'internal_error' carrying the pool-timeout message -- never a second write
    const ok = raced.filter((r) => r.status === 200);
    const poolTimeout = (r: { status: number; json: any }) => (r.status === 422 && r.json.error === "rejected" && /timeout exceeded when trying to connect/.test(r.json.message)) || (r.status === 500 && r.json.error === "internal_error") || (r.status === 503 && r.json.error === "database_unavailable");
    expect(raced.every((r) => r.status === 200 || poolTimeout(r)), JSON.stringify(raced.map((r) => [r.status, r.json?.error]))).toBe(true);
    expect(ok.length).toBeGreaterThan(0); expect(new Set(ok.map((r) => r.json.result)).size).toBe(1);
    expect(await count("SELECT count(*) AS n FROM repo_snapshots WHERE workflow_run_id = $1", [R3.runId])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM worker_api_requests WHERE token_id = $1 AND idempotency_key = $2", [R3.tokenId, k2])).toBe(1);
    // the same snapshot request under a NEW key: answered by the store (same row), no duplicate snapshot
    const again = await call("create_snapshot", snapBody, { token: R3.token });
    expect([again.status, again.json.result ?? again.json.error]).toEqual([200, ok[0]!.json.result]);
    expect(await count("SELECT count(*) AS n FROM repo_snapshots WHERE workflow_run_id = $1", [R3.runId])).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  it("S6 change ownership, privileges or schema objects [PREVENTED]: no operation causes DDL; catalog fingerprint identical after the whole battery", async () => {
    expect(await schemaFingerprint()).toBe(schemaBefore);
    // the server's own SQL in worker-api.ts has no DDL; the store code it calls has none either
    for (const f of ["apps/api/src/worker-api.ts", "apps/api/src/research-state.ts", "apps/api/src/worker.ts"]) {
      expect(readFileSync(join(REPO_ROOT, f), "utf8"), f).not.toMatch(/\b(ALTER|CREATE|DROP|GRANT|REVOKE)\s+(TABLE|ROLE|FUNCTION|TRIGGER|SCHEMA|INDEX|VIEW)\b/);
    }
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  it("S7a / (b) forge the independent validator [VULNERABLE]: the API records a validator 'supports' on a lead the validator never evaluates; it shows in the dossier", async () => {
    const V = await researchRun("adv-forge"); await drive(V); await drive(V); // acquired + REAL analysis
    const snap = await snapOf(V.runId);
    const leads = (await owner().query<{ id: string; family: string }>("SELECT id, family FROM hypotheses WHERE workflow_run_id = $1 ORDER BY family", [V.runId])).rows;
    // a lead of a class with NO validator method (the honest challenge records 'no-independent-validator' / execution-challenge-*)
    const target = leads.find((l) => /tx-origin/.test(l.family)) ?? leads.find((l) => l.family !== "solidity-reentrancy")!;
    expect(target.family).not.toBe("solidity-reentrancy");
    const ch = await claim(V); expect(ch.step_key).toBe("challenge_leads");
    const primary = (await plain("hypothesis_span_ids", { step_id: ch.id, hypothesis_id: target.id }, V.token)).json.result[0] as string;
    const forged = await call("record_evaluation", { step_id: ch.id, hypothesis_id: target.id, evaluator_id: VALIDATOR_ID, evaluator_version: "1", outcome: "supports",
      rationale: "Executed model: reentrancy validated (forged by a compromised worker)", span_ids: [primary], input_sha256: sha256Hex("forged") }, { token: V.token });
    expect(forged.status).toBe(200);
    // latest-wins within one evaluator id: a weakens followed by a supports under the validator's id reads as 'supports'
    const reent = leads.find((l) => l.family === "solidity-reentrancy");
    if (reent) {
      const sp = (await plain("hypothesis_span_ids", { step_id: ch.id, hypothesis_id: reent.id }, V.token)).json.result[0];
      for (const outcome of ["weakens", "supports"]) await call("record_evaluation", { step_id: ch.id, hypothesis_id: reent.id, evaluator_id: VALIDATOR_ID, evaluator_version: "1", outcome, rationale: outcome, span_ids: [sp], input_sha256: sha256Hex(outcome) }, { token: V.token });
      expect((await owner().query("SELECT static_outcome FROM hypothesis_status WHERE hypothesis_id = $1", [reent.id])).rows[0].static_outcome).toBe("supports");
    }
    // the honest challenge code then runs on the same held step, and the dossier is built from the records
    await executeRemoteStep(V.client, "adv", ch, { source: V.source, env: SWITCHES });
    const d = await buildDossier(owner(), new ResearchStore(owner()), snap);
    const entry = d.entries.find((e) => e.hypothesis_id === target.id)!;
    expect(entry.evaluations).toContainEqual({ evaluator: VALIDATOR_ID, outcome: "supports", rationale: "Executed model: reentrancy validated (forged by a compromised worker)" });
    expect(entry.static_outcome).toBe("supports");
    expect(entry.status).toBe("unreviewed"); // no review operation exists: a 'supported_by_review' status cannot be forged in D
  });

  it("S7b record a hypothesis under another generator's id [PREVENTED]: only the step's own generator; never model, human, or the other stage's id", async () => {
    const G = await researchRun("adv-gen"); await drive(G);
    const an = await claim(G); const snap = await snapOf(G.runId);
    const span = (await call("create_evidence_span", { step_id: an.id, snapshot_id: snap, path: "contracts/Bank.sol", line_start: 1, line_end: 1 }, { token: G.token })).json.result as string;
    const h = (generator: Record<string, string>) => call("create_hypothesis", { step_id: an.id, snapshot_id: snap, family: "solidity-reentrancy", claim: "Bank.withdraw forged lead text.", rationale: "r", required_checks: [], alternative_explanations: [], generator, spans: [{ span_id: span, role: "primary" }] }, { token: G.token });
    expect((await h({ kind: "model", id: "claude", version: "1" })).json.error).toBe("invalid_request");
    expect((await h({ kind: "human", id: "alice", version: "1" })).json.error).toBe("invalid_request");
    expect((await h({ kind: "deterministic_rule", id: "slither", version: "1" })).json.error).toBe("generator_not_allowed");
    expect((await h({ kind: "deterministic_rule", id: "solidity-structural-specialists", version: "2" })).json.error).toBe("generator_not_allowed");
    // what remains: ANY claim text under the analyze stage's own id is accepted (the API cannot know what the rules would have produced)
    expect((await h({ kind: "deterministic_rule", id: "solidity-structural-specialists", version: "1" })).status).toBe(200);
    await call("fail", { step_id: an.id, reason: "done", retryable: false }, { token: G.token });
  });

  it("S7c make the snapshot claim a different commit/content than GitHub has [VULNERABLE]: any 40-hex commit and any bytes, for the queued repository and ref", async () => {
    const S = await researchRun("adv-snap", [{ path: "contracts/Real.sol", content: "contract Real {}\n" }]);
    const acq = await claim(S);
    const snap = (await call("create_snapshot", { step_id: acq.id, repository: "acme/adv-snap", commit_sha: "deadbeef".repeat(5), ref_name: "main" }, { token: S.token })).json.result as string;
    const blob = (await call("put_blob", { step_id: acq.id, content_base64: Buffer.from("contract Real { /* attacker bytes */ }\n").toString("base64") }, { token: S.token })).json.result;
    expect((await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [{ path: "contracts/Real.sol", classification: "source", size_bytes: blob.sizeBytes, blob_sha256: blob.sha256 }] }, { token: S.token })).status).toBe(200);
    expect((await call("seal_snapshot", { step_id: acq.id, snapshot_id: snap }, { token: S.token })).status).toBe(200);
    expect((await call("complete", { step_id: acq.id, output: { status: "snapshot_sealed", snapshot_id: snap, commit_sha: "deadbeef".repeat(5) } }, { token: S.token })).status).toBe(200);
    expect((await owner().query("SELECT verify_repo_snapshot($1) AS v", [snap])).rows[0].v.ok).toBe(true);
    expect((await owner().query("SELECT commit_sha FROM repo_snapshots WHERE id = $1", [snap])).rows[0].commit_sha).toBe("deadbeef".repeat(5));
    // what IS enforced: the repository and ref the operator queued
    const S2 = await researchRun("adv-snap2"); const a2 = await claim(S2);
    expect((await call("create_snapshot", { step_id: a2.id, repository: "OpenZeppelin/openzeppelin-contracts", commit_sha: "a".repeat(40), ref_name: "main" }, { token: S2.token })).json.error).toBe("repository_mismatch");
  });

  it("S7d make dossier coverage say 'complete' when analysis did not run [VULNERABLE]: complete analyze_structure with a hand-written output", async () => {
    const K = await researchRun("adv-cov"); await drive(K);
    const an = await claim(K); expect(an.step_key).toBe("analyze_structure");
    const r = await call("complete", { step_id: an.id, output: { status: "structure_analyzed", problems: [], contracts: 42, functions: 420 } }, { token: K.token });
    expect(r.status).toBe(200);
    const d = await buildDossier(owner(), new ResearchStore(owner()), await snapOf(K.runId));
    expect(d.coverage).toMatchObject({ status: "complete", contracts: 42, functions: 420, problems: [] });
    expect(d.entries).toEqual([]); // nothing was analysed, yet the dossier says the analysis was complete
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  it("S8 reuse another worker's credentials [PREVENTED]: token A against run B's steps, snapshots, hypotheses and spans", async () => {
    const bs = await stepsOf(B.runId); const ch = bs.find((s) => s.step_key === "challenge_leads")!;
    const bc = await claim(B); expect(bc.id).toBe(ch.id); // B holds its challenge step
    const hB = (await owner().query("SELECT id FROM hypotheses WHERE workflow_run_id = $1 LIMIT 1", [B.runId])).rows[0].id;
    for (const [op, body] of [["heartbeat", { step_id: bc.id }], ["complete", { step_id: bc.id, output: { status: "leads_challenged" } }], ["fail", { step_id: bc.id, reason: "x", retryable: false }],
      ["record_evaluation", { step_id: bc.id, hypothesis_id: hB, evaluator_id: VALIDATOR_ID, evaluator_version: "1", outcome: "supports", rationale: "x", span_ids: [], input_sha256: "0".repeat(64) }]] as const) {
      expect((await call(op, body, { token: A.token, key: op === "heartbeat" ? null : undefined })).json.error, op).toBe("step_not_in_run");
    }
    expect((await stepsOf(B.runId)).find((s) => s.id === bc.id)!.status).toBe("running");
    await call("fail", { step_id: bc.id, reason: "release", retryable: true }, { token: B.token });
  });

  it("S9 keep operating after cancellation or revocation [PREVENTED]: every operation refused at once; a stored replay is still answered (no write)", async () => {
    const X = await researchRun("adv-cancel"); const acq = await claim(X);
    const key = randomUUID(); const body = { step_id: acq.id, content_base64: Buffer.from(`pre-cancel ${randomUUID()}`).toString("base64") };
    expect((await call("put_blob", body, { token: X.token, key })).status).toBe(200);
    await owner().query("UPDATE workflow_runs SET status = 'cancelled', completed_at = now() WHERE id = $1", [X.runId]); // step still 'running' with a live lease
    for (const [op, b] of [["heartbeat", { step_id: acq.id }], ["put_blob", { step_id: acq.id, content_base64: "eA==" }], ["complete", { step_id: acq.id, output: { status: "snapshot_sealed" } }], ["claim", { step_keys: ["acquire_repository"] }]] as const) {
      const r = await call(op, b, { token: X.token, key: op === "heartbeat" ? null : undefined }); expect([r.status, r.json.error], op).toEqual([403, "run_terminal"]);
    }
    const replay = await call("put_blob", body, { token: X.token, key });
    expect(replay.json).toMatchObject({ ok: true, replayed: true }); // observed: the replay check precedes the run-status check (returns the stored answer only)
    const Y = await researchRun("adv-revoke"); await claim(Y);
    await revokeWorkerToken(owner(), { tokenId: Y.tokenId, revokedBy: "op" });
    expect((await plain("heartbeat", { step_id: Y.stepId }, Y.token)).json.error).toBe("token_revoked");
  });

  it("S10 secrets and reach [PARTIAL]: no DB credential and no operator route; but the token survives `delete process.env` in /proc/<pid>/environ", async () => {
    expect((await fetch(`${pubBase}/v1/workflows`, { headers: { authorization: `Bearer ${A.token}` } })).status).toBe(401);
    expect((await fetch(`${base}/v1/workflows`, { headers: { authorization: `Bearer ${A.token}` } })).status).toBe(401);
    // the worker runtime deletes WORKER_API_TOKEN from process.env after reading it (worker-remote-main.ts); the kernel copy remains
    const child = spawn(process.execPath, ["-e", "delete process.env.WORKER_API_TOKEN; console.log(JSON.stringify(process.env.WORKER_API_TOKEN ?? null)); setTimeout(() => {}, 4000)"], { env: { PATH: process.env.PATH ?? "", WORKER_API_TOKEN: A.token }, stdio: ["ignore", "pipe", "ignore"] });
    const said = await new Promise<string>((r) => child.stdout.once("data", (d) => r(String(d).trim())));
    const environ = readFileSync(`/proc/${child.pid}/environ`, "utf8"); child.kill();
    expect(said).toBe("null"); // gone from process.env ...
    expect(environ).toContain(`WORKER_API_TOKEN=${A.token}`); // ... but readable by any same-user process on the machine
    // what the token can reach: exactly the 21 worker operations of its run on the private listener
    expect((await call("claim", { step_keys: ["acquire_repository"] }, { token: A.token, at: pubBase })).status).toBe(404);
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  it("S11 compromised API / owner path [VULNERABLE]: the API's owner connection disables the immutability triggers and rewrites the ledger; it can mint any run's token", async () => {
    const h = (await owner().query("SELECT id FROM hypotheses WHERE workflow_run_id = $1 LIMIT 1", [B.runId])).rows[0].id;
    await expect(owner().query("UPDATE hypotheses SET claim = 'rewritten by the API'")).rejects.toThrow(/append-only/); // holds while triggers are on
    const c = await owner().connect();
    try {
      await c.query("BEGIN");
      for (const t of ["hypotheses", "hypothesis_evaluations", "hypothesis_events", "worker_api_requests", "audit_events"]) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
      await c.query("UPDATE hypotheses SET claim = 'Rewritten by a compromised API process.' WHERE id = $1", [h]);
      await c.query("DELETE FROM worker_api_requests WHERE token_id = $1", [B.tokenId]); // erase the idempotency record
      await c.query("DELETE FROM audit_events WHERE actor = $1", [`worker-token:${B.tokenId}`]); // and the audit trail
      for (const t of ["hypotheses", "hypothesis_evaluations", "hypothesis_events", "worker_api_requests", "audit_events"]) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      await c.query("COMMIT");
    } finally { c.release(); }
    expect((await owner().query("SELECT claim FROM hypotheses WHERE id = $1", [h])).rows[0].claim).toBe("Rewritten by a compromised API process.");
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE actor = $1", [`worker-token:${B.tokenId}`])).toBe(0);
    // and it mints a token for any queued/running run (no operator interaction is needed on the owner connection)
    const Z = await createRepositoryResearchRun(owner(), { repository: "acme/any", ref: "main" });
    expect((await mintWorkerToken(owner(), { runId: Z.runId, createdBy: "attacker" })).token).toMatch(/^wct1_/);
  });

  it("S12 recovery: worker killed mid-step, API down/restarted mid-step, connection dropped mid-transaction, crash between commit and response", async () => {
    // (1) worker killed mid-acquisition: no fail(), no cleanup; the lease expires; a fresh client with the same token reclaims; the run completes
    const W = await researchRun("adv-kill");
    const acq = await claim(W);
    const crashing = new FakeSource(W.gx); crashing.archiveError = new Error("SIGKILL (simulated)");
    await executeRemoteStep(W.client, "adv", acq, { source: crashing, env: SWITCHES }).catch(() => undefined);
    await expireLease(owner(), acq.id);
    const reborn = new WorkerApiClient({ baseUrl: base, token: W.token, backoffMs: 1, attempts: 3 }); const W2 = { ...W, client: reborn };
    const again = await claim(W2); expect([again.id, again.attempt]).toEqual([acq.id, 2]);
    await executeRemoteStep(reborn, "adv", again, { source: W.source, env: SWITCHES });
    await drive(W2); // analysis
    // killed mid-CHALLENGE after the first evaluation was committed: the retried step records it AGAIN (no idempotency across processes)
    const ch = await claim(W2);
    const h = (await owner().query("SELECT id FROM hypotheses WHERE workflow_run_id = $1 ORDER BY claim COLLATE \"C\" LIMIT 1", [W.runId])).rows[0].id as string;
    await reborn.recordEvaluation({ stepId: ch.id, workerId: "x" }, { hypothesisId: h, evaluatorId: "no-independent-validator", evaluatorVersion: "1", outcome: "inconclusive", rationale: "partial progress before the kill", spanIds: [], inputSha256: sha256Hex("p") });
    await expireLease(owner(), ch.id);
    const ch2 = await claim(W2); await executeRemoteStep(reborn, "adv", ch2, { source: W.source, env: SWITCHES });
    await drive(W2); // dossier
    expect((await stepsOf(W.runId)).map((s) => s.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(await count("SELECT count(*) AS n FROM repo_snapshots WHERE workflow_run_id = $1", [W.runId])).toBe(1);
    const perHyp = (await owner().query("SELECT count(*)::int AS n FROM hypothesis_evaluations WHERE hypothesis_id = $1", [h])).rows[0].n;
    expect(perHyp).toBe(2); // [observed] a duplicate evaluation from the retried challenge (the honest code has no "already evaluated" check)

    // (2) API down longer than the client's retries, then restarted on the same ports, mid-acquisition
    const fixed = await startApi();
    const U = await researchRun("adv-restart");
    const uc = new WorkerApiClient({ baseUrl: `http://127.0.0.1:${fixed.priv}`, token: U.token, backoffMs: 1, attempts: 2 }); const U2 = { ...U, client: uc };
    const ua = await claim(U2);
    await fixed.close();
    const down = await executeRemoteStep(uc, "adv", ua, { source: U.source, env: SWITCHES }).then(() => "ok", (e: Error) => e.message);
    expect(down).toMatch(/worker API unavailable/);
    const restarted = await startApi({ pub: fixed.pub, priv: fixed.priv });
    expect(await uc.complete(ua.id, { status: "snapshot_sealed" }).then(() => "completed", (e: Error) => e.message)).toMatch(/not completed and will be retried/); // tainted
    await uc.fail(ua.id, "API was down", true);
    const ua2 = await claim(U2); expect(ua2.attempt).toBe(2);
    await executeRemoteStep(uc, "adv", ua2, { source: U.source, env: SWITCHES });
    expect(await count("SELECT count(*) AS n FROM repo_snapshots WHERE workflow_run_id = $1 AND sealed_at IS NOT NULL", [U.runId])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM repo_snapshots WHERE workflow_run_id = $1", [U.runId])).toBe(1);

    // (3) database connection dropped mid-transaction (the API's request transaction waits on a row lock and its backend is terminated)
    const T = await researchRun("adv-drop"); const tc = new WorkerApiClient({ baseUrl: `http://127.0.0.1:${restarted.priv}`, token: T.token, backoffMs: 1, attempts: 2 });
    const ta = (await tc.claimNext(remoteStepKeys(SWITCHES)))!;
    const hold = await owner().connect(); await hold.query("BEGIN"); await hold.query("SELECT 1 FROM workflow_steps WHERE id = $1 FOR UPDATE", [ta.id]);
    const key = randomUUID(); const content = Buffer.from(`dropped ${randomUUID()}`); const blobBody = { step_id: ta.id, content_base64: content.toString("base64") };
    const pending = call("put_blob", blobBody, { token: T.token, key, at: `http://127.0.0.1:${restarted.priv}` });
    let killed = 0;
    for (let i = 0; i < 100 && !killed; i++) { killed = (await db.adminPool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'dapi' AND wait_event_type = 'Lock'")).rowCount ?? 0; if (!killed) await sleep(50); }
    expect(killed).toBe(1);
    const dropped = await pending; await hold.query("COMMIT"); hold.release();
    expect([dropped.status, dropped.json.error]).toEqual([503, "database_unavailable"]);
    expect(await count("SELECT count(*) AS n FROM research_blobs WHERE content_sha256 = $1", [sha256Hex(content.toString("utf8"))])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM worker_api_requests WHERE idempotency_key = $1", [key])).toBe(0);
    const retry = await call("put_blob", blobBody, { token: T.token, key, at: `http://127.0.0.1:${restarted.priv}` });
    const replay = await call("put_blob", blobBody, { token: T.token, key, at: `http://127.0.0.1:${restarted.priv}` });
    expect([retry.status, retry.json.replayed ?? false, replay.json.replayed]).toEqual([200, false, true]);
    expect(await count("SELECT count(*) AS n FROM research_blobs WHERE content_sha256 = $1", [sha256Hex(content.toString("utf8"))])).toBe(1);

    // (4) the API commits and the response is lost on the way back: the client retries with the SAME key and gets the stored answer
    const Q = await researchRun("adv-lost");
    const lost = new Set<string>();
    const lossy = new WorkerApiClient({ baseUrl: base, token: Q.token, backoffMs: 1, attempts: 3, fetchImpl: async (input, init) => {
      const res = await fetch(input, init); const op = String(input).split("/").pop()!;
      if (["create_snapshot", "seal_snapshot", "complete"].includes(op) && !lost.has(op)) { lost.add(op); await res.text(); throw new TypeError("fetch failed (response lost)"); }
      return res;
    } });
    const Q2 = { ...Q, client: lossy };
    const qa = await claim(Q2); await executeRemoteStep(lossy, "adv", qa, { source: Q.source, env: SWITCHES });
    expect([...lost].sort()).toEqual(["complete", "create_snapshot", "seal_snapshot"]);
    expect(await count("SELECT count(*) AS n FROM repo_snapshots WHERE workflow_run_id = $1", [Q.runId])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'workflow_step.succeeded' AND entity_id = $1", [qa.id])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'worker_api.replayed' AND payload->>'token_id' = $1", [Q.tokenId])).toBe(3);
    expect((await stepsOf(Q.runId))[0]!.status).toBe("succeeded");
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("D-specific", () => {
    it("operations beyond their purpose [PARTIAL]: complete() stores arbitrary output fields; acquisition_report is free JSON; claim text is free (see S7)", async () => {
      const O = await researchRun("adv-output"); const acq = await claim(O);
      const snap = (await call("create_snapshot", { step_id: acq.id, repository: "acme/adv-output", commit_sha: O.gx.commitSha, ref_name: "main", acquisition_report: { completeness: "complete", note: "x".repeat(1_000_000) } }, { token: O.token }));
      expect(snap.status).toBe(200); // ~1 MB of free JSON stored in a research record
      const s = snap.json.result as string;
      await call("add_snapshot_files", { step_id: acq.id, snapshot_id: s, files: [{ path: "a.txt", classification: "docs", size_bytes: 0, skip_reason: "binary" }] }, { token: O.token });
      await call("seal_snapshot", { step_id: acq.id, snapshot_id: s }, { token: O.token });
      const done = await call("complete", { step_id: acq.id, output: { status: "snapshot_sealed", snapshot_id: s, completeness: "complete", authorization_status: "authorized", active_testing_allowed: true, file_count: 99999 } }, { token: O.token });
      expect(done.status).toBe(200);
      expect((await owner().query("SELECT output FROM workflow_steps WHERE id = $1", [acq.id])).rows[0].output).toMatchObject({ authorization_status: "authorized", active_testing_allowed: true, file_count: 99999 });
    });

    it("transactionalPool [PREVENTED]: a failing store call inside a request leaves no partial rows, no idempotency record and no accepted audit", async () => {
      const P = await researchRun("adv-tx"); const acq = await claim(P);
      const snap = (await call("create_snapshot", { step_id: acq.id, repository: "acme/adv-tx", commit_sha: P.gx.commitSha, ref_name: "main" }, { token: P.token })).json.result as string;
      const blob = (await call("put_blob", { step_id: acq.id, content_base64: Buffer.from(`tx ${randomUUID()}`).toString("base64") }, { token: P.token })).json.result;
      const key = randomUUID();
      const bad = await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [
        { path: "contracts/Good.sol", classification: "source", size_bytes: blob.sizeBytes, blob_sha256: blob.sha256 },
        { path: "contracts/Bad.sol", classification: "source", size_bytes: 1, blob_sha256: sha256Hex("missing") }] }, { token: P.token, key });
      expect(bad.json.error).toBe("database_rejected");
      expect(await count("SELECT count(*) AS n FROM repo_snapshot_files WHERE snapshot_id = $1", [snap])).toBe(0);
      expect(await count("SELECT count(*) AS n FROM worker_api_requests WHERE idempotency_key = $1", [key])).toBe(0);
      expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'worker_api.accepted' AND payload->>'idempotency_key' = $1", [key])).toBe(0);
      // a store transaction that commits inside the savepoint, followed by a failure later in the SAME request, is rolled back too
      await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [{ path: "contracts/Good.sol", classification: "source", size_bytes: blob.sizeBytes, blob_sha256: blob.sha256 }] }, { token: P.token });
      await call("seal_snapshot", { step_id: acq.id, snapshot_id: snap }, { token: P.token });
      const badOutput = await call("complete", { step_id: acq.id, output: { status: "snapshot_sealed", snapshot_id: randomUUID() } }, { token: P.token });
      expect(badOutput.json.error).toBe("cross_run_reference");
      expect((await stepsOf(P.runId))[0]!.status).toBe("running");
    });

    it("storage abuse [VULNERABLE]: one token stores distinct 1 MiB blobs with no quota; they are global and outlive the run", async () => {
      const St = await researchRun("adv-storage"); const acq = await claim(St);
      const before = Number((await owner().query("SELECT blob_bytes FROM research_storage_stats")).rows[0].blob_bytes);
      const t0 = Date.now(); const N = 48;
      const rs = await Promise.all(Array.from({ length: N }, (_, i) => call("put_blob", { step_id: acq.id, content_base64: randomBytes(1_048_576 - (i % 3)).toString("base64") }, { token: St.token })));
      const ms = Date.now() - t0;
      expect(rs.every((r) => r.status === 200)).toBe(true);
      const grown = Number((await owner().query("SELECT blob_bytes FROM research_storage_stats")).rows[0].blob_bytes) - before;
      expect(grown).toBeGreaterThan(N * 1_048_570);
      console.log(`[measured] ${N} x 1 MiB blobs accepted from one token in ${ms} ms (${((grown / 1048576) / (ms / 1000)).toFixed(1)} MiB/s); the token bucket allows 200 req/s sustained`);
      await owner().query("UPDATE workflow_runs SET status = 'cancelled' WHERE id = $1", [St.runId]);
      expect(Number((await owner().query("SELECT blob_bytes FROM research_storage_stats")).rows[0].blob_bytes) - before).toBe(grown); // nothing reclaims them
    });

    it("racing duplicates exhaust the owner pool [VULNERABLE availability]: a duplicate that loses the race awaits its 'replayed' audit while still holding its transaction client", async () => {
      // worker-api.ts, raced branch: `await client.query("ROLLBACK"); ... await audit(...)` -- audit() needs a SECOND pool connection
      const own = await startApi(); const at = `http://127.0.0.1:${own.priv}`;
      const Rr = await researchRun("adv-race"); const rc = new WorkerApiClient({ baseUrl: at, token: Rr.token, backoffMs: 1, attempts: 1 });
      const st = (await rc.claimNext(remoteStepKeys(SWITCHES)))!;
      const key = randomUUID();
      const body = { step_id: st.id, content_base64: Buffer.from(`race ${randomUUID()}`).toString("base64") };
      // hold the request's advisory lock so that five duplicates are inside their transactions, waiting, when the stored answer appears
      const lock = await owner().connect();
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`${Rr.tokenId}:${key}`]);
      const t0 = Date.now();
      const racers = Array.from({ length: 8 }, () => call("put_blob", body, { token: Rr.token, key, at }).then((r) => ({ ...r, ms: Date.now() - t0 })));
      let waiting = 0;
      for (let i = 0; i < 150 && waiting < 5; i++) { waiting = (await owner().query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'dapi' AND wait_event = 'advisory'")).rows[0].n; if (waiting < 5) await sleep(20); }
      expect([waiting, own.pool.totalCount, own.pool.idleCount]).toEqual([5, 5, 0]);
      // the stored answer for exactly this request (what a concurrent winner would have committed)
      await owner().query("INSERT INTO worker_api_requests (token_id, idempotency_key, operation, step_id, request_sha256, response) VALUES ($1, $2, 'put_blob', $3, $4, '\"stored\"')",
        [Rr.tokenId, key, st.id, sha256Hex(`put_blob\n${JSON.stringify(body)}`)]);
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`${Rr.tokenId}:${key}`]); lock.release();
      const tProbe = Date.now();
      const probe = await fetch(`http://127.0.0.1:${own.pub}/v1/workflows`, { headers: { authorization: `Bearer ${OPERATOR}` } }).then(async (r) => ({ status: r.status, ms: Date.now() - tProbe }));
      const rs = await Promise.all(racers);
      const replayAudits = await count("SELECT count(*) AS n FROM audit_events WHERE action = 'worker_api.replayed' AND payload->>'token_id' = $1", [Rr.tokenId]);
      console.log(`[measured] 8 same-key duplicates: statuses ${JSON.stringify(rs.map((r) => r.status))}, slowest ${Math.max(...rs.map((r) => r.ms))} ms; operator GET /v1/workflows meanwhile: HTTP ${probe.status} after ${probe.ms} ms; 'replayed' audits written ${replayAudits}/8`);
      // every pool connection is held by a request that waits for a pool connection: nothing moves until connectionTimeoutMillis (3 s)
      expect(Math.max(...rs.map((r) => r.ms))).toBeGreaterThanOrEqual(2_900);
      expect(probe.ms).toBeGreaterThanOrEqual(2_000); // the operator's request waited for (or timed out on) the exhausted pool
      expect(replayAudits).toBeLessThan(8); // the timed-out audit inserts are lost (only logged)
      // and a pool timeout surfaces as a PERMANENT refusal: asRefusal() tests `error.constructor === Error` (422 "rejected") before its
      // connection-timeout pattern (503), so the remote client treats a transient overload as a non-retryable WorkerApiRefusedError
      for (const r of rs.filter((x) => x.status !== 200)) expect([[422, "rejected", "timeout exceeded when trying to connect"], [500, "internal_error", "internal error"]]).toContainEqual([r.status, r.json.error, r.json.message]);
      expect(rs.some((r) => r.status !== 200)).toBe(true);
      await own.close();
    });

    it("API resource exhaustion from one token [PARTIAL availability]: a 400-request burst is admitted whole and shares the 5-connection owner pool with operator requests", async () => {
      const E = await researchRun("adv-dos"); await drive(E);
      const an = await claim(E); const snap = await snapOf(E.runId);
      const probe = async () => { const t = Date.now(); const r = await fetch(`http://127.0.0.1:${api.pub}/v1/workflows`, { headers: { authorization: `Bearer ${OPERATOR}` } }); await r.text(); return { ms: Date.now() - t, status: r.status }; };
      const baseline = await probe();
      const burst = Promise.all(Array.from({ length: 400 }, () => call("snapshot_sources", { step_id: an.id, snapshot_id: snap }, { token: E.token, key: null })));
      await sleep(30);
      const loaded = await probe();
      const results = await burst;
      const by = results.reduce<Record<number, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
      console.log(`[measured] operator GET /v1/workflows: ${baseline.ms} ms idle, ${loaded.ms} ms during a 400-request burst from ONE worker token; burst statuses ${JSON.stringify(by)}`);
      expect(by[200]).toBeGreaterThanOrEqual(390); // the per-token bucket (burst 400) admits the whole burst
      expect(loaded.status).toBe(200);
      expect(loaded.ms).toBeGreaterThan(baseline.ms);
    });
  });
});
