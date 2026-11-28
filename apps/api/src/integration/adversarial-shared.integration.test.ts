import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRepositoryResearchRun } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { GitHubSource } from "../acquisition/github-source.js";
import { startLoopbackGitHub, type LoopbackGitHub } from "../acquisition/testing/loopback-github.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { buildDossier, computeStructuralAnalysis, VALIDATOR_ID } from "../analysis/solidity/pipeline.js";
import { analysisIdentity } from "../analysis-identity.js";
import { execFixed } from "../engine/tools/tool-host/exec.js";
import type { SnapshotFileInput, StepLease } from "../research-state.js";
import { buildApp } from "../app.js";
import type { WorkerApiOptions } from "../worker-api.js";
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
 * [PREVENTED] asserts the refusal; [VULNERABLE] / [PARTIAL] assert the OBSERVED successful attack. The same scenario ids are implemented
 * against design B' in the B' worktree. RE-RUN after the fixes D1-D7 (docs/security/worker-architecture-decision.md): every scenario
 * keeps its id; those the fixes close now assert PREVENTED ("[PREVENTED by Dn]") with the original attack re-run, the rest keep asserting
 * the observed behaviour ([PARTIAL], [VULNERABLE]). The API here also has its OWN read-only GitHub source (a loopback fake, `gh`), as
 * server.ts gives it in production.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const GH_TOKEN = "github_pat_" + "11ABCDEFG0" + "y".repeat(72); // the API's own read-only GitHub credential (shape only; loopback fake)
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
  let db: TestDatabase; let api: Api; let base = ""; let pubBase = ""; let gh: LoopbackGitHub;
  const fixtures: GitFixture[] = []; const apis: Api[] = [];
  const owner = () => db.ownerPool;

  /** The API as server.ts runs it: owner pool (max 5 as in production), public listener + private worker listener. */
  async function startApi(ports: { pub?: number; priv?: number } = {}, rateLimit?: { perSecond: number; burst: number }, connectTimeoutMs = 3_000, extra: Partial<WorkerApiOptions> = {}): Promise<Api> {
    // as buildPoolConfig configures the API in production: max 5 (server.ts), connectionTimeoutMillis 3000 (DATABASE_CONNECT_TIMEOUT_MS default)
    const pool = new pg.Pool({ connectionString: db.url, max: 5, application_name: "dapi", connectionTimeoutMillis: connectTimeoutMs });
    pool.on("error", () => undefined); pool.on("connect", (c) => { c.on("error", () => undefined); });
    const priv = ports.priv ?? await freePort();
    const github = new GitHubSource({ token: GH_TOKEN, testOrigins: { api: gh.origin, archive: [gh.origin] }, requestTimeoutMs: 5000 });
    const app = buildApp({ pool, apiBearerToken: OPERATOR, hubAllowedHosts: [], limiter: permissive(), engineInfo: { expectedMigrations: null },
      workerApi: { reaperIntervalMs: 0, limiter: permissive(), privateListenerPort: priv, github, ...(rateLimit ? { rateLimit } : {}), ...extra } });
    await app.listen({ host: "127.0.0.1", port: ports.pub ?? 0 });
    const internal = createServer((req, res) => app.server.emit("request", req, res));
    await new Promise<void>((resolve, reject) => { internal.once("error", reject); internal.listen(priv, "127.0.0.1", () => resolve()); });
    const a: Api = { app, internal, pool, pub: (app.server.address() as { port: number }).port, priv,
      async close() { const closed = new Promise<void>((r) => internal.close(() => r())); internal.closeAllConnections(); await closed; await app.close(); } };
    apis.push(a); return a;
  }

  beforeAll(async () => {
    db = await migratedTestDatabase();
    gh = await startLoopbackGitHub();
    api = await startApi();
    base = `http://127.0.0.1:${api.priv}`; pubBase = `http://127.0.0.1:${api.pub}`;
    await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ('sherlock:adv', 'victim', 'victim', '{}'::jsonb, 'active', 'official_confirmed')`);
    await owner().query("INSERT INTO ai_budget_reservations (provider, model, purpose, tier, reserved_usd) VALUES ('test','m','investigation','tier2', 5.0)");
  });
  afterAll(async () => { for (const a of apis) await a.close().catch(() => undefined); await gh?.close(); for (const f of fixtures) f.cleanup(); await db?.drop(); });

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
    const gx = buildGitFixture(files, { owner: "acme", repo }); fixtures.push(gx); gh.add(gx);
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

  it("S4 cross-run blob read through content addressing [PREVENTED by D4]: a manifest row may cite only blobs its OWN run uploaded; an unknown hash and another run's hash get the SAME refusal (no existence oracle); own copies are checked against GitHub", async () => {
    const C = await researchRun("adv-c", [{ path: "contracts/Mine.sol", content: "contract Mine {}\n" }]);
    const acq = await claim(C);
    const secretContent = (await owner().query("SELECT b.content_sha256 AS sha, b.size_bytes AS size, convert_from(b.content, 'UTF8') AS text FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.workflow_run_id = $1 AND f.path LIKE '%.sol' LIMIT 1", [B.runId])).rows[0];
    const snap = (await call("create_snapshot", { step_id: acq.id, repository: "acme/adv-c", commit_sha: C.gx.commitSha, ref_name: "main" }, { token: C.token })).json.result as string;
    const unknown = await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [{ path: "contracts/X.sol", classification: "source", size_bytes: 3, blob_sha256: sha256Hex("nope") }] }, { token: C.token });
    const known = await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [{ path: "contracts/Stolen.sol", classification: "source", size_bytes: secretContent.size, blob_sha256: secretContent.sha }] }, { token: C.token });
    expect([unknown.status, unknown.json.error]).toEqual([422, "blob_not_uploaded"]);
    expect([known.status, known.json.error, known.json.message]).toEqual([422, "blob_not_uploaded", unknown.json.message]); // indistinguishable
    expect(await count("SELECT count(*) AS n FROM repo_snapshot_files WHERE snapshot_id = $1", [snap])).toBe(0);
    // uploading the same bytes itself is allowed (it then knows them anyway), but the API verifies the snapshot against GitHub at seal:
    // a path that is not in the commit's tree is refused, so another run's file cannot be smuggled into this run's snapshot
    expect((await call("put_blob", { step_id: acq.id, content_base64: Buffer.from(secretContent.text, "utf8").toString("base64") }, { token: C.token })).status).toBe(200);
    expect((await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [{ path: "contracts/Stolen.sol", classification: "source", size_bytes: secretContent.size, blob_sha256: secretContent.sha }] }, { token: C.token })).status).toBe(200);
    const seal = await call("seal_snapshot", { step_id: acq.id, snapshot_id: snap }, { token: C.token });
    expect([seal.status, seal.json.error]).toEqual([422, "snapshot_verification_failed"]);
    expect(seal.json.problems.join("\n")).toMatch(/"contracts\/Stolen\.sol" is not in the GitHub tree/);
    expect((await owner().query("SELECT sealed_at FROM repo_snapshots WHERE id = $1", [snap])).rows[0].sealed_at).toBeNull();
    await call("fail", { step_id: acq.id, reason: "s4 blob done", retryable: false }, { token: C.token });
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
    // every accepted duplicate gets the SAME snapshot id and only one row is written
    const ok = raced.filter((r) => r.status === 200);
    // D5: a duplicate that cannot get a slot or a connection is a RETRYABLE 503, never a 422 or a 500
    const retryable = (r: { status: number; json: any }) => r.status === 503 && ["database_unavailable", "worker_api_busy"].includes(r.json.error);
    expect(raced.every((r) => r.status === 200 || retryable(r)), JSON.stringify(raced.map((r) => [r.status, r.json?.error]))).toBe(true);
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
  it("S7a / (b) forge the independent validator [PREVENTED by D1]: the worker cannot record any evaluation under any id; the API runs the validators itself and only its verdicts, with provenance, reach the dossier", async () => {
    const V = await researchRun("adv-forge"); await drive(V); await drive(V); // acquired + the API's own analysis
    const snap = await snapOf(V.runId);
    const leads = (await owner().query<{ id: string; family: string }>("SELECT id, family FROM hypotheses WHERE workflow_run_id = $1 ORDER BY family", [V.runId])).rows;
    const target = leads.find((l) => /tx-origin/.test(l.family)) ?? leads.find((l) => l.family !== "solidity-reentrancy")!;
    const reent = leads.find((l) => l.family === "solidity-reentrancy");
    const ch = await claim(V); expect(ch.step_key).toBe("challenge_leads");
    const primary = (await plain("hypothesis_span_ids", { step_id: ch.id, hypothesis_id: target.id }, V.token)).json.result[0] as string;
    const FORGED = "Executed model: reentrancy validated (forged by a compromised worker)";
    const forge = (hypothesisId: string, evaluatorId: string, outcome: string) => call("record_evaluation", { step_id: ch.id, hypothesis_id: hypothesisId, evaluator_id: evaluatorId, evaluator_version: "1", outcome,
      rationale: FORGED, span_ids: outcome === "inconclusive" ? [] : [primary], input_sha256: sha256Hex(`${evaluatorId}${outcome}`) }, { token: V.token });
    for (const [h, e, o] of [[target.id, VALIDATOR_ID, "supports"], [target.id, "execution-challenge-access-control", "supports"], [target.id, "foundry-forge", "supports"], [target.id, "no-independent-validator", "inconclusive"],
      ...(reent ? [[reent.id, VALIDATOR_ID, "weakens"], [reent.id, VALIDATOR_ID, "supports"]] : [])] as const) {
      const r = await forge(h, e, o); expect([r.status, r.json.error], `${e} ${o}`).toEqual([403, "evaluations_are_api_derived"]);
    }
    expect(await count("SELECT count(*) AS n FROM hypothesis_evaluations WHERE workflow_run_id = $1", [V.runId])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE payload->>'token_id' = $1 AND payload->>'code' = 'evaluations_are_api_derived'", [V.tokenId])).toBeGreaterThanOrEqual(4);
    // a completion that carries verdicts is refused by the strict per-step schema (D3)
    const verdicts = await call("complete", { step_id: ch.id, output: { status: "leads_challenged", snapshot_id: snap, reentrancy_verdicts: { validated: 9 } } }, { token: V.token });
    expect([verdicts.status, verdicts.json.error]).toEqual([422, "output_rejected"]);
    // the honest remote step names the snapshot only; the API runs the validators on the stored hypotheses by id and records them
    await executeRemoteStep(V.client, "adv", ch, { source: V.source, env: SWITCHES });
    const d = await buildDossier(owner(), new ResearchStore(owner()), snap);
    const entry = d.entries.find((e) => e.hypothesis_id === target.id)!;
    expect(entry.evaluations.map((e) => e.rationale)).not.toContain(FORGED);
    expect(d.entries.flatMap((e) => e.evaluations).some((e) => e.rationale === FORGED)).toBe(false);
    expect(d.entries.flatMap((e) => e.provenance.evaluations).every((x) => x.recorded_by === "api_verified" && /^[0-9a-f]{64}$/.test(x.output_blob_sha256 ?? ""))).toBe(true);
    expect(d.provenance.challenge).toBe("api_derived");
    // every evaluation's provenance: identity, version and family from the API's registry, the input hash, the snapshot, the raw output
    const prov = (await owner().query<{ validator_id: string; validator_version: string; analysis_family: string; input_sha256: string; recorded_by: string; snapshot_id: string; content: Buffer }>(
      "SELECT p.validator_id, p.validator_version, p.analysis_family, p.input_sha256, p.recorded_by, p.snapshot_id, b.content FROM evaluation_provenance p JOIN research_blobs b ON b.content_sha256 = p.output_blob_sha256 WHERE p.workflow_run_id = $1", [V.runId])).rows;
    expect(prov.length).toBe(await count("SELECT count(*) AS n FROM hypothesis_evaluations WHERE workflow_run_id = $1", [V.runId]));
    expect(prov.length).toBe(leads.length);
    for (const x of prov) {
      expect(x.recorded_by).toBe("api"); expect(x.snapshot_id).toBe(snap);
      expect(x.analysis_family).toBe(analysisIdentity(x.validator_id)!.analysisFamily);
      const doc = JSON.parse(x.content.toString("utf8"));
      expect(doc).toMatchObject({ schema: "agentsmith-validator-output/1", validator_id: x.validator_id, validator_version: x.validator_version, analysis_family: x.analysis_family, input_sha256: x.input_sha256, snapshot_id: snap, ran_by: "api" });
    }
  });
  it("S7b record a hypothesis under another generator's id [PREVENTED]: the analysis stage records NO hypothesis itself (D3: the API derives them); never model, human, or another stage's id", async () => {
    const G = await researchRun("adv-gen"); await drive(G);
    const an = await claim(G); const snap = await snapOf(G.runId);
    expect((await call("create_evidence_span", { step_id: an.id, snapshot_id: snap, path: "contracts/Bank.sol", line_start: 1, line_end: 1 }, { token: G.token })).json.error).toBe("operation_not_allowed_for_step");
    const h = (generator: Record<string, string>) => call("create_hypothesis", { step_id: an.id, snapshot_id: snap, family: "solidity-reentrancy", claim: "Bank.withdraw forged lead text.", rationale: "r", required_checks: [], alternative_explanations: [], generator, spans: [{ span_id: randomUUID(), role: "primary" }] }, { token: G.token });
    expect((await h({ kind: "model", id: "claude", version: "1" })).json.error).toBe("invalid_request");
    expect((await h({ kind: "human", id: "alice", version: "1" })).json.error).toBe("invalid_request");
    for (const g of [{ kind: "deterministic_rule", id: "slither", version: "1" }, { kind: "deterministic_rule", id: "solidity-structural-specialists", version: "2" }, { kind: "deterministic_rule", id: "solidity-structural-specialists", version: "1" }]) {
      expect((await h(g)).json.error, JSON.stringify(g)).toBe("operation_not_allowed_for_step"); // was accepted under the stage's own id before D3
    }
    expect(await count("SELECT count(*) AS n FROM hypotheses WHERE workflow_run_id = $1", [G.runId])).toBe(0);
    await call("fail", { step_id: an.id, reason: "done", retryable: false }, { token: G.token });
  });

  it("S7b' the optional Slither stage's leads [PARTIAL]: the tool runs on the worker, so any claim text under 'slither' is accepted; such leads are labelled WORKER-REPORTED and are challenged by the API's own validators", async () => {
    const { runId } = await createRepositoryResearchRun(owner(), { repository: "acme/adv-slither", ref: "main" }, "operator", { structuralAnalysis: true, slitherScan: true });
    const t = await mintWorkerToken(owner(), { runId, createdBy: "operator@test" });
    const gx = buildGitFixture(devFiles(), { owner: "acme", repo: "adv-slither" }); fixtures.push(gx); gh.add(gx);
    const R: R = { runId, stepId: "", token: t.token, tokenId: t.tokenId, client: new WorkerApiClient({ baseUrl: base, token: t.token, backoffMs: 1, attempts: 3 }), source: new FakeSource(gx), gx };
    await drive(R); await drive(R); // acquisition, then the API's own analysis
    const sl = (await call("claim", { step_keys: ["slither_scan"] }, { token: R.token })).json.result as ClaimedStep; expect(sl.step_key).toBe("slither_scan");
    const snap = await snapOf(runId);
    const span = (await call("create_evidence_span", { step_id: sl.id, snapshot_id: snap, path: "contracts/Bank.sol", line_start: 1, line_end: 1 }, { token: R.token })).json.result as string;
    const hyp = (generator: Record<string, string>, claim: string) => call("create_hypothesis", { step_id: sl.id, snapshot_id: snap, family: "solidity-reentrancy", claim, rationale: "worker says so", required_checks: [], alternative_explanations: [], generator, spans: [{ span_id: span, role: "primary" }] }, { token: R.token });
    expect((await hyp({ kind: "deterministic_rule", id: "solidity-structural-specialists", version: "1" }, "Bank.withdraw is reentrant (forged specialist lead).")).json.error).toBe("generator_not_allowed");
    const forged = await hyp({ kind: "deterministic_rule", id: "slither", version: "0.11.3" }, "Slither reentrancy-eth (High) in Bank.withdraw: a lead invented by the compromised worker.");
    expect(forged.status).toBe(200); // [PARTIAL]: the API cannot know what the tool would have reported
    const id = forged.json.result.id as string;
    const out = { status: "tool_completed", generator: "slither@0.11.3", producer: "slither", pinned_version: "0.11.3", snapshot_id: snap, repository: "acme/adv-slither", commit_sha: gx.commitSha,
      manifest_sha256: (await owner().query("SELECT manifest_sha256 FROM repo_snapshots WHERE id = $1", [snap])).rows[0].manifest_sha256, limits: {}, wall_ms: 1, execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false,
      tool: { name: "slither", version: "0.11.3", solc_version: "0.8.28", args: [], input_manifest_sha256: "0".repeat(64), raw_output_sha256: "0".repeat(64), raw_output_blob: null, exit_codes: [255], duration_ms: 1 },
      hypothesis_ids: [id], leads: [{ hypothesisId: id, class: "reentrancy", contract: "Bank", function: "withdraw", file: "contracts/Bank.sol", line: 1 }], leads_by_class: { reentrancy: 1 }, detections_total: 1, informational_detections: 0,
      unmapped_detectors: {}, outside_snapshot_contracts: 0, unanchored: 0, leads_not_recorded: 0 };
    expect((await call("complete", { step_id: sl.id, output: { ...out, authorization_status: "authorized" } }, { token: R.token })).json.error).toBe("output_rejected");
    expect((await call("complete", { step_id: sl.id, output: { ...out, hypothesis_ids: [randomUUID()] } }, { token: R.token })).json.error).toBe("output_rejected");
    expect((await call("complete", { step_id: sl.id, output: out }, { token: R.token })).status).toBe(200);
    await drive(R); await drive(R); // the API's challenge (it evaluates the Slither lead too) and the API's dossier
    const d = await buildDossier(owner(), new ResearchStore(owner()), snap);
    const e = d.entries.find((x) => x.hypothesis_id === id)!;
    expect(e.provenance.claim).toBe("worker_reported"); expect(d.provenance.external_tools).toBe("worker_reported");
    expect(e.provenance.evaluations.length).toBeGreaterThan(0);
    expect(e.provenance.evaluations.every((x) => x.recorded_by === "api_verified")).toBe(true); // judged by the API, never by the worker
    expect(d.entries.filter((x) => x.generator.startsWith("solidity-structural-specialists")).every((x) => x.provenance.claim === "api_derived")).toBe(true);
  });
  it("S7c make the snapshot claim a different commit/content than GitHub has [PREVENTED by D2]: the API resolves the ref and fetches the tree from GitHub itself, re-hashes every stored byte, and refuses any difference", async () => {
    const files = [{ path: "contracts/Real.sol", content: "contract Real {}\n" }, { path: "contracts/Other.sol", content: "contract Other {}\n" }, { path: "README.md", content: "# real\n" }];
    /** a compromised worker running the honest acquisition but rewriting what it uploads */
    class Tampering extends WorkerApiClient {
      constructor(token: string, private readonly mutate: { commit?: (c: string) => string; files?: (rows: readonly SnapshotFileInput[], c: Tampering, lease: StepLease) => Promise<SnapshotFileInput[]> }) { super({ baseUrl: base, token, backoffMs: 1, attempts: 2 }); }
      override createSnapshot(lease: StepLease, input: Parameters<WorkerApiClient["createSnapshot"]>[1]) { return super.createSnapshot(lease, { ...input, commitSha: this.mutate.commit ? this.mutate.commit(input.commitSha) : input.commitSha }); }
      override async addSnapshotFiles(lease: StepLease, snapshotId: string, rows: readonly SnapshotFileInput[]) { return super.addSnapshotFiles(lease, snapshotId, this.mutate.files ? await this.mutate.files(rows, this, lease) : rows); }
    }
    const run = async (name: string, mutate: ConstructorParameters<typeof Tampering>[1], pin = false) => {
      const gx = buildGitFixture(files, { owner: "acme", repo: name }); fixtures.push(gx); gh.add(gx);
      const { runId } = await createRepositoryResearchRun(owner(), { repository: `acme/${name}`, ref: pin ? gx.commitSha : "main" }, "operator", { structuralAnalysis: true });
      const t = await mintWorkerToken(owner(), { runId, createdBy: "operator@test" });
      const c = new Tampering(t.token, mutate); const s = (await c.claimNext(["acquire_repository"]))!;
      const error = await executeRemoteStep(c, "adv", s, { source: new FakeSource(gx), env: SWITCHES }).then(() => null, (e: Error) => e.message);
      const sealed = await count("SELECT count(*) AS n FROM repo_snapshots WHERE workflow_run_id = $1 AND sealed_at IS NOT NULL", [runId]);
      const verifications = await count("SELECT count(*) AS n FROM snapshot_verifications WHERE workflow_run_id = $1", [runId]);
      return { error, sealed, verifications, runId, gx };
    };
    const swapBytes = (path: string, bytes: string) => async (rows: readonly SnapshotFileInput[], c: Tampering, lease: StepLease) => {
      const blob = await c.putBlob(lease, Buffer.from(bytes, "utf8"));
      return rows.map((r) => r.path === path ? { ...r, sizeBytes: blob.sizeBytes, blobSha256: blob.sha256 } as SnapshotFileInput : r);
    };
    // the honest worker: verified against GitHub, sealed, with the evidence recorded
    const honest = await run("adv-snap-honest", {});
    expect([honest.error, honest.sealed, honest.verifications]).toEqual([null, 1, 1]);
    const v = (await owner().query("SELECT * FROM snapshot_verifications WHERE workflow_run_id = $1", [honest.runId])).rows[0];
    expect(v).toMatchObject({ verifier: "api-github", resolved_commit: honest.gx.commitSha, tree_sha: honest.gx.treeSha, files_total: 3, files_matched: 3, skips_unverified: 0, completeness: "complete" });
    expect(gh.hits.some((x) => x.url === `/repos/acme/adv-snap-honest/git/trees/${honest.gx.treeSha}?recursive=1` && x.authorized)).toBe(true); // the API's OWN authenticated read
    const pinned = await run("adv-snap-pinned", {}, true); expect([pinned.error, pinned.sealed]).toEqual([null, 1]);
    // every forgery is refused at the seal, nothing is sealed, no verification is recorded
    for (const [name, mutate, pin, why] of [
      ["adv-snap-commit", { commit: () => "deadbeef".repeat(5) }, false, /commit_mismatch|GitHub resolves main/],
      ["adv-snap-pin", { commit: () => "deadbeef".repeat(5) }, true, /the step pins/],
      ["adv-snap-bytes", { files: swapBytes("contracts/Real.sol", "contract Real { /* attacker bytes */ }\n") }, false, /snapshot_verification_failed/],
      ["adv-snap-samesize", { files: swapBytes("contracts/Real.sol", "contract Evil {}\n") }, false, /snapshot_verification_failed/],
      ["adv-snap-extra", { files: async (rows: readonly SnapshotFileInput[], c: Tampering, lease: StepLease) => { const b = await c.putBlob(lease, Buffer.from("contract Planted {}\n")); return [...rows, { path: "contracts/Planted.sol", classification: "source", sizeBytes: b.sizeBytes, blobSha256: b.sha256 }]; } }, false, /snapshot_verification_failed/],
      ["adv-snap-omit", { files: async (rows: readonly SnapshotFileInput[]) => rows.filter((r) => r.path !== "contracts/Other.sol") }, false, /snapshot_verification_failed/],
      ["adv-snap-skip", { files: async (rows: readonly SnapshotFileInput[]) => rows.map((r) => r.path === "contracts/Real.sol" ? { path: r.path, classification: r.classification, sizeBytes: r.sizeBytes, skipReason: "binary", ...(r.gitBlobSha ? { gitBlobSha: r.gitBlobSha } : {}) } : r) }, false, /snapshot_verification_failed/],
    ] as const) {
      const r = await run(name, mutate as never, pin);
      expect(r.error, name).toMatch(why); expect([r.sealed, r.verifications], name).toEqual([0, 0]);
    }
    const audit = (await owner().query<{ code: string }>("SELECT payload->>'code' AS code FROM audit_events WHERE action = 'worker_api.refused' AND payload->>'operation' = 'seal_snapshot'")).rows.map((x) => x.code);
    expect(audit.filter((c) => c === "snapshot_verification_failed").length).toBeGreaterThanOrEqual(7);
    // GitHub unreachable from the API: a RETRYABLE refusal, never an acceptance; once GitHub answers, the same snapshot seals
    gh.mode = "down";
    const down = await run("adv-snap-down", {});
    gh.mode = "ok";
    expect([down.sealed, down.verifications]).toEqual([0, 0]); expect(down.error).toMatch(/worker API unavailable for seal_snapshot|github_unavailable/);
    expect((await owner().query<{ c: string }>("SELECT payload->>'code' AS c FROM audit_events WHERE action = 'worker_api.refused' AND payload->>'operation' = 'seal_snapshot' AND payload->>'run_id' = $1 LIMIT 1", [down.runId])).rows[0]?.c).toBe("github_unavailable");
    // the repository and ref the operator queued are still enforced
    const S2 = await researchRun("adv-snap2"); const a2 = await claim(S2);
    expect((await call("create_snapshot", { step_id: a2.id, repository: "OpenZeppelin/openzeppelin-contracts", commit_sha: "a".repeat(40), ref_name: "main" }, { token: S2.token })).json.error).toBe("repository_mismatch");
  });
  it("S7d make dossier coverage say 'complete' when analysis did not run [PREVENTED by D3]: a hand-written analysis output is refused; coverage comes only from the API's own analysis of the sealed snapshot", async () => {
    const K = await researchRun("adv-cov"); await drive(K);
    const an = await claim(K); expect(an.step_key).toBe("analyze_structure");
    const snap = await snapOf(K.runId);
    for (const output of [{ status: "structure_analyzed", problems: [], contracts: 42, functions: 420 }, { status: "structure_analyzed", snapshot_id: snap, contracts: 42, functions: 420, problems: [] },
      { status: "structure_analyzed", snapshot_id: snap, hypothesis_ids: [] }, { status: "structure_analyzed", snapshot_id: snap, authorization_status: "authorized" }]) {
      const r = await call("complete", { step_id: an.id, output }, { token: K.token });
      expect([r.status, r.json.error], JSON.stringify(output)).toEqual([422, "output_rejected"]);
    }
    expect((await call("complete", { step_id: an.id, output: { status: "structure_analyzed", snapshot_id: randomUUID() } }, { token: K.token })).json.error).toBe("cross_run_reference");
    expect((await stepsOf(K.runId))[1]!.status).toBe("running");
    const r = await call("complete", { step_id: an.id, output: { status: "structure_analyzed", snapshot_id: snap } }, { token: K.token });
    expect(r.status).toBe(200);
    const truth = computeStructuralAnalysis(devFiles().map((f) => ({ path: f.path, text: f.content })));
    const stored = (await owner().query("SELECT output FROM workflow_steps WHERE id = $1", [an.id])).rows[0].output;
    expect(stored).toMatchObject({ derived_by: "api", contracts: truth.contracts, functions: truth.functions, problems: truth.problems, hypotheses: truth.findings.length, authorization_status: "unverified" });
    const d = await buildDossier(owner(), new ResearchStore(owner()), snap);
    expect(d.coverage).toMatchObject({ contracts: truth.contracts, functions: truth.functions });
    expect(d.coverage.contracts).not.toBe(42); expect(d.entries.length).toBe(truth.findings.length); expect(d.provenance.analysis).toBe("api_derived");
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

  it("S10 secrets and reach [PREVENTED by D6 for the environment; residual documented]: the worker reads its token from a file it unlinks, refuses a token in its environment, and neither its /proc/<pid>/environ nor its tool child's environment holds a token", async () => {
    expect((await fetch(`${pubBase}/v1/workflows`, { headers: { authorization: `Bearer ${A.token}` } })).status).toBe(401);
    expect((await fetch(`${base}/v1/workflows`, { headers: { authorization: `Bearer ${A.token}` } })).status).toBe(401);
    expect((await call("claim", { step_keys: ["acquire_repository"] }, { token: A.token, at: pubBase })).status).toBe(404);
    const R10 = await researchRun("adv-env"); const dir = mkdtempSync(join(tmpdir(), "adv-env-"));
    try {
      const fixture = join(dir, "fixture.json"); writeFileSync(fixture, JSON.stringify({ owner: "acme", repo: "adv-env", files: [{ path: "contracts/A.sol", content: "contract A {}\n" }] }));
      const tokenFile = join(dir, "token"); writeFileSync(tokenFile, `${R10.token}\n`, { mode: 0o600 });
      const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test", WORKER_STORE: "api", WORKER_API_URL: base, WORKER_API_TOKEN_FILE: tokenFile, ...SWITCHES,
        REMOTE_CHILD_FIXTURE: fixture, REMOTE_CHILD_PAUSE_BEFORE: "acquire_repository", REMOTE_CHILD_PAUSE_FILE: join(dir, "paused") };
      const child = spawn(`${REPO_ROOT}node_modules/.bin/tsx`, [`${REPO_ROOT}apps/api/src/integration/remote-worker-child.ts`], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { out += c; });
      for (let i = 0; i < 300 && !existsSync(join(dir, "paused")); i++) await sleep(50);
      expect(existsSync(join(dir, "paused")), out).toBe(true);
      // tsx runs the script in a node grandchild: read every process of the tree
      const pids = [child.pid!, ...readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)];
      for (const pid of pids) { const environ = readFileSync(`/proc/${pid}/environ`, "utf8"); expect(environ).not.toContain(R10.token); expect(environ).not.toMatch(/WORKER_API_TOKEN=/); }
      expect(existsSync(tokenFile)).toBe(false); // unlinked after reading
      expect(out).toContain('"environ_has_token":false'); expect(out).toContain('"token_file_removed":true'); expect(out).not.toContain(secretOf(R10.token));
      for (const pid of pids.reverse()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      // a token in the environment refuses the start (exit 64), without echoing it
      const refused = spawn(`${REPO_ROOT}node_modules/.bin/tsx`, [`${REPO_ROOT}apps/api/src/worker-main.ts`], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", WORKER_STORE: "api", WORKER_API_URL: base, WORKER_API_TOKEN: R10.token }, stdio: ["ignore", "pipe", "pipe"] });
      let rout = ""; refused.stdout.on("data", (c) => { rout += c; }); refused.stderr.on("data", (c) => { rout += c; });
      expect(await new Promise((r) => refused.on("close", r))).toBe(64);
      expect(rout).toMatch(/WORKER_API_TOKEN is set in the environment/); expect(rout).not.toContain(secretOf(R10.token));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // the pinned tool runner (Slither, forge) starts its child with PATH, HOME and LANG only, whatever the worker's environment holds
    process.env.ADV_PROBE_SECRET = "must-not-leak";
    try {
      const work = mkdtempSync(join(tmpdir(), "adv-envprobe-"));
      const r = await execFixed("/usr/bin/env", [], { cwd: work, timeoutMs: 5000, home: work });
      rmSync(work, { recursive: true, force: true });
      expect(r.stdout.trim().split("\n").map((l) => l.split("=")[0]).sort()).toEqual(["HOME", "LANG", "PATH"]);
    } finally { delete process.env.ADV_PROBE_SECRET; }
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
    // killed mid-CHALLENGE: the worker records no evaluation (D1); the API's challenge is ONE transaction, so a kill leaves nothing or
    // everything, and every evaluation is idempotent on its key (D7). (a) the worker dies with the request in flight (its connection
    // is cut); (b) the lease expires and a fresh client retries the whole step
    const ch = await claim(W2); const snapW = await snapOf(W.runId);
    const h = (await owner().query("SELECT id FROM hypotheses WHERE workflow_run_id = $1 ORDER BY claim COLLATE \"C\" LIMIT 1", [W.runId])).rows[0].id as string;
    expect((await reborn.recordEvaluation({ stepId: ch.id, workerId: "x" }, { hypothesisId: h, evaluatorId: "no-independent-validator", evaluatorVersion: "1", outcome: "inconclusive", rationale: "partial progress before the kill", spanIds: [], inputSha256: sha256Hex("p") }).catch((e: Error) => e.message))).toMatch(/evaluations_are_api_derived/);
    const cut = new AbortController();
    const inFlight = fetch(`${base}/internal/worker/v1/complete`, { method: "POST", signal: cut.signal, headers: { authorization: `Bearer ${W.token}`, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ step_id: ch.id, output: { status: "leads_challenged", snapshot_id: snapW } }) }).catch(() => "cut");
    await sleep(30); cut.abort(); await inFlight;
    for (let i = 0; i < 100 && (await stepsOf(W.runId))[2]!.status === "running" && await count("SELECT count(*) AS n FROM hypothesis_evaluations WHERE workflow_run_id = $1", [W.runId]) === 0; i++) await sleep(50);
    if ((await stepsOf(W.runId))[2]!.status === "running") { await expireLease(owner(), ch.id); const ch2 = await claim(W2); await executeRemoteStep(reborn, "adv", ch2, { source: W.source, env: SWITCHES }); }
    await drive(W2); // dossier
    expect((await stepsOf(W.runId)).map((s) => s.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(await count("SELECT count(*) AS n FROM repo_snapshots WHERE workflow_run_id = $1", [W.runId])).toBe(1);
    const dup = (await owner().query("SELECT hypothesis_id, evaluator_id, count(*)::int AS n FROM hypothesis_evaluations WHERE workflow_run_id = $1 GROUP BY 1, 2 HAVING count(*) > 1", [W.runId])).rows;
    expect(dup).toEqual([]); // [PREVENTED by D1+D7]; before the fixes: a duplicate evaluation from the retried challenge
    expect(await count("SELECT count(*) AS n FROM hypothesis_evaluations WHERE hypothesis_id = $1", [h])).toBe(1);

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
    it("operations beyond their purpose [PARTIAL]: complete() is refused unless it matches its step's strict schema (D3); acquisition_report stays free JSON, worker-reported and counted against the storage quota", async () => {
      const O = await researchRun("adv-output"); const acq = await claim(O);
      const snap = (await call("create_snapshot", { step_id: acq.id, repository: "acme/adv-output", commit_sha: O.gx.commitSha, ref_name: "main", acquisition_report: { completeness: "complete", note: "x".repeat(1_000_000) } }, { token: O.token }));
      expect(snap.status).toBe(200); // [PARTIAL] ~1 MB of free JSON stored in a research record (bounded by the body limit and charged to the quota)
      expect(Number((await owner().query("SELECT bytes_stored FROM worker_token_usage WHERE token_id = $1", [O.tokenId])).rows[0].bytes_stored)).toBeGreaterThan(1_000_000);
      const s = snap.json.result as string;
      const forged = { status: "snapshot_sealed", snapshot_id: s, completeness: "complete", authorization_status: "authorized", active_testing_allowed: true, file_count: 99999 };
      const done = await call("complete", { step_id: acq.id, output: forged }, { token: O.token });
      expect([done.status, done.json.error]).toEqual([422, "output_rejected"]); // [PREVENTED]
      expect((await owner().query("SELECT status, output FROM workflow_steps WHERE id = $1", [acq.id])).rows[0]).toMatchObject({ status: "running", output: null });
      // every step key: a field outside its schema is refused, including the passive labels set to anything but their fixed values
      for (const output of [{ status: "snapshot_sealed", snapshot_id: s, extra: 1 }, { status: "dossier_built" }, { status: "snapshot_sealed", snapshot_id: s, execution_mode: "active" }]) {
        expect((await call("complete", { step_id: acq.id, output }, { token: O.token })).json.error, JSON.stringify(output)).toBe("output_rejected");
      }
    });

    it("transactionalPool [PREVENTED]: a failing store call inside a request leaves no partial rows, no idempotency record and no accepted audit", async () => {
      const P = await researchRun("adv-tx"); const acq = await claim(P);
      const snap = (await call("create_snapshot", { step_id: acq.id, repository: "acme/adv-tx", commit_sha: P.gx.commitSha, ref_name: "main" }, { token: P.token })).json.result as string;
      const blob = (await call("put_blob", { step_id: acq.id, content_base64: Buffer.from(`tx ${randomUUID()}`).toString("base64") }, { token: P.token })).json.result;
      const key = randomUUID();
      const bad = await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [
        { path: "contracts/Good.sol", classification: "source", size_bytes: blob.sizeBytes, blob_sha256: blob.sha256 },
        { path: "contracts/Bad.sol", classification: "source", size_bytes: 1, blob_sha256: sha256Hex("missing") }] }, { token: P.token, key });
      expect(bad.json.error).toBe("blob_not_uploaded"); // D4: refused before the store runs; nothing of the batch is written
      expect(await count("SELECT count(*) AS n FROM repo_snapshot_files WHERE snapshot_id = $1", [snap])).toBe(0);
      expect(await count("SELECT count(*) AS n FROM worker_api_requests WHERE idempotency_key = $1", [key])).toBe(0);
      expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'worker_api.accepted' AND payload->>'idempotency_key' = $1", [key])).toBe(0);
      // a store transaction that commits inside the savepoint, followed by a failure later in the SAME request, is rolled back too
      await call("add_snapshot_files", { step_id: acq.id, snapshot_id: snap, files: [{ path: "contracts/Good.sol", classification: "source", size_bytes: blob.sizeBytes, blob_sha256: blob.sha256 }] }, { token: P.token });
      expect((await call("seal_snapshot", { step_id: acq.id, snapshot_id: snap }, { token: P.token })).json.error).toBe("snapshot_verification_failed"); // D2: not GitHub's content
      expect(await count("SELECT count(*) AS n FROM snapshot_verifications WHERE snapshot_id = $1", [snap])).toBe(0);
      expect((await call("complete", { step_id: acq.id, output: { status: "snapshot_sealed", snapshot_id: randomUUID() } }, { token: P.token })).json.error).toBe("output_rejected"); // strict schema (D3)
      const wellFormed = { status: "snapshot_sealed", snapshot_id: randomUUID(), repository: "acme/adv-tx", commit_sha: P.gx.commitSha, tree_sha: P.gx.treeSha, manifest_sha256: "0".repeat(64), file_count: 1, stored_files: 1, stored_bytes: 1,
        skipped_by_reason: {}, completeness: "complete", reused: "new", execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false };
      const badOutput = await call("complete", { step_id: acq.id, output: wellFormed }, { token: P.token });
      expect(badOutput.json.error).toBe("cross_run_reference");
      expect((await stepsOf(P.runId))[0]!.status).toBe("running");
    });

    it("storage abuse [PREVENTED by D4]: per-token byte and blob quotas refuse with 413 and an audit; other tokens and operator routes are unaffected", async () => {
      const q = await startApi({}, undefined, 3_000, { quotas: { maxBytesStored: 8 * 1_048_576, maxBlobs: 50 } }); const at = `http://127.0.0.1:${q.priv}`;
      const St = await researchRun("adv-storage"); const acq = (await new WorkerApiClient({ baseUrl: at, token: St.token, backoffMs: 1, attempts: 1 }).claimNext(["acquire_repository"]))!;
      const before = Number((await owner().query("SELECT blob_bytes FROM research_storage_stats")).rows[0].blob_bytes);
      const N = 48;
      const rs = []; for (let i = 0; i < N; i++) rs.push(await call("put_blob", { step_id: acq.id, content_base64: randomBytes(1_048_576 - (i % 3)).toString("base64") }, { token: St.token, at }));
      const by = rs.reduce<Record<string, number>>((m, r) => { const k = `${r.status}:${r.json?.error ?? "ok"}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
      console.log(`[measured] ${N} x 1 MiB from one token with an 8 MiB quota: ${JSON.stringify(by)}`);
      expect(by["200:ok"]).toBe(8); expect(by["413:storage_quota_exceeded"]).toBe(N - 8);
      const grown = Number((await owner().query("SELECT blob_bytes FROM research_storage_stats")).rows[0].blob_bytes) - before;
      expect(grown).toBeLessThanOrEqual(8 * 1_048_576);
      expect(await count("SELECT count(*) AS n FROM audit_events WHERE payload->>'token_id' = $1 AND payload->>'code' = 'storage_quota_exceeded'", [St.tokenId])).toBe(N - 8);
      // the quota is per token, durable (a database ledger), and other tokens and operators are unaffected
      const Other = await researchRun("adv-storage-other"); const oacq = (await new WorkerApiClient({ baseUrl: at, token: Other.token, backoffMs: 1, attempts: 1 }).claimNext(["acquire_repository"]))!;
      expect((await call("put_blob", { step_id: oacq.id, content_base64: randomBytes(1000).toString("base64") }, { token: Other.token, at })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${q.pub}/v1/workflows`, { headers: { authorization: `Bearer ${OPERATOR}` } })).status).toBe(200);
      const restarted = await startApi({}, undefined, 3_000, { quotas: { maxBytesStored: 8 * 1_048_576, maxBlobs: 50 } });
      expect((await call("put_blob", { step_id: acq.id, content_base64: randomBytes(10).toString("base64") }, { token: St.token, at: `http://127.0.0.1:${restarted.priv}` })).json.error).toBe("storage_quota_exceeded");
      await restarted.close(); await q.close();
    });

    it("read volume and processing time [PREVENTED by D4]: per-token read and API-processing budgets, and per-request CPU, wall, heap and size limits, refuse cleanly while other tokens and operator routes stay responsive", async () => {
      // reads: a token's read budget is charged with every answer's size
      const r1 = await startApi({}, undefined, 3_000, { quotas: { maxBytesRead: 200_000 } }); const at1 = `http://127.0.0.1:${r1.priv}`;
      const Rd = await researchRun("adv-reads"); const rc = new WorkerApiClient({ baseUrl: at1, token: Rd.token, backoffMs: 1, attempts: 1 });
      const a1 = (await rc.claimNext(["acquire_repository"]))!; await executeRemoteStep(rc, "adv", a1, { source: Rd.source, env: SWITCHES });
      const z = (await rc.claimNext(remoteStepKeys(SWITCHES)))!; const snapR = await snapOf(Rd.runId);
      const readsAt = []; for (let i = 0; i < 40; i++) readsAt.push(await call("snapshot_sources", { step_id: z.id, snapshot_id: snapR }, { token: Rd.token, key: null, at: at1 }));
      expect(readsAt.some((r) => r.status === 200)).toBe(true);
      expect(readsAt.filter((r) => r.status !== 200).every((r) => r.status === 429 && r.json.error === "read_quota_exceeded")).toBe(true);
      expect(readsAt.some((r) => r.json?.error === "read_quota_exceeded")).toBe(true);
      expect(Number((await owner().query("SELECT bytes_read FROM worker_token_usage WHERE token_id = $1", [Rd.tokenId])).rows[0].bytes_read)).toBeLessThanOrEqual(200_000);
      await r1.close();
      // a per-request CPU limit: the API's own analysis is killed, refused with 413, the step stays as it was; the operator is served meanwhile
      const r2 = await startApi({}, undefined, 3_000, { compute: { cpuMs: 1 } }); const at2 = `http://127.0.0.1:${r2.priv}`;
      const Cp = await researchRun("adv-cpu"); const cc = new WorkerApiClient({ baseUrl: at2, token: Cp.token, backoffMs: 1, attempts: 1 });
      const ca = (await cc.claimNext(["acquire_repository"]))!; await executeRemoteStep(cc, "adv", ca, { source: Cp.source, env: SWITCHES });
      const cz = (await cc.claimNext(remoteStepKeys(SWITCHES)))!; const snapC = await snapOf(Cp.runId);
      const t0 = Date.now(); const cpu = call("complete", { step_id: cz.id, output: { status: "structure_analyzed", snapshot_id: snapC } }, { token: Cp.token, at: at2 });
      const probe = await fetch(`http://127.0.0.1:${r2.pub}/v1/workflows`, { headers: { authorization: `Bearer ${OPERATOR}` } }); const probeMs = Date.now() - t0;
      const cpuR = await cpu;
      expect([cpuR.status, cpuR.json.error, cpuR.json.limit]).toEqual([413, "processing_limit_exceeded", "cpu_limit"]);
      expect(probe.status).toBe(200); expect(probeMs).toBeLessThan(2_000);
      expect((await stepsOf(Cp.runId))[1]!.status).toBe("running");
      expect(await count("SELECT count(*) AS n FROM hypotheses WHERE workflow_run_id = $1", [Cp.runId])).toBe(0);
      expect(Number((await owner().query("SELECT processing_ms FROM worker_token_usage WHERE token_id = $1", [Cp.tokenId])).rows[0].processing_ms)).toBeGreaterThan(0);
      await r2.close();
      // the cumulative processing budget: once spent, further API-side work for the token is refused (429), another token is unaffected
      const r3 = await startApi({}, undefined, 3_000, { quotas: { maxProcessingMs: 1 } }); const at3 = `http://127.0.0.1:${r3.priv}`;
      const Pb = await researchRun("adv-budget"); const pc = new WorkerApiClient({ baseUrl: at3, token: Pb.token, backoffMs: 1, attempts: 1 });
      const pa = (await pc.claimNext(["acquire_repository"]))!; await executeRemoteStep(pc, "adv", pa, { source: Pb.source, env: SWITCHES }); // the seal's verification spends the budget
      const pz = (await pc.claimNext(remoteStepKeys(SWITCHES)))!; const snapP = await snapOf(Pb.runId);
      const spent = await call("complete", { step_id: pz.id, output: { status: "structure_analyzed", snapshot_id: snapP } }, { token: Pb.token, at: at3 });
      expect([spent.status, spent.json.error]).toEqual([429, "processing_budget_exhausted"]);
      const Ob = await researchRun("adv-budget-other"); const oc = new WorkerApiClient({ baseUrl: at3, token: Ob.token, backoffMs: 1, attempts: 1 });
      const oa = (await oc.claimNext(["acquire_repository"]))!; await executeRemoteStep(oc, "adv", oa, { source: Ob.source, env: SWITCHES });
      expect((await stepsOf(Ob.runId))[0]!.status).toBe("succeeded");
      expect(await count("SELECT count(*) AS n FROM audit_events WHERE payload->>'token_id' = $1 AND payload->>'code' = 'processing_budget_exhausted'", [Pb.tokenId])).toBe(1);
      await r3.close();
      // the maximum snapshot size for the API's own analysis
      const r4 = await startApi({}, undefined, 3_000, { compute: { maxInputBytes: 1000 } }); const at4 = `http://127.0.0.1:${r4.priv}`;
      const Mx = await researchRun("adv-size"); const mc = new WorkerApiClient({ baseUrl: at4, token: Mx.token, backoffMs: 1, attempts: 1 });
      const ma = (await mc.claimNext(["acquire_repository"]))!; await executeRemoteStep(mc, "adv", ma, { source: Mx.source, env: SWITCHES });
      const mz = (await mc.claimNext(remoteStepKeys(SWITCHES)))!;
      const big = await call("complete", { step_id: mz.id, output: { status: "structure_analyzed", snapshot_id: await snapOf(Mx.runId) } }, { token: Mx.token, at: at4 });
      expect([big.status, big.json.error, big.json.limit]).toEqual([413, "processing_limit_exceeded", "input_too_large"]);
      await r4.close();
    });

    it("racing duplicates exhaust the owner pool [PREVENTED by D5]: no request waits for a second connection while holding one; 8+ same-key duplicates on a pool of 5 all answer, none with 500 or 422, and operator routes stay responsive", async () => {
      const own = await startApi(); const at = `http://127.0.0.1:${own.priv}`;
      const Rr = await researchRun("adv-race"); const rc = new WorkerApiClient({ baseUrl: at, token: Rr.token, backoffMs: 1, attempts: 1 });
      const st = (await rc.claimNext(remoteStepKeys(SWITCHES)))!;
      const key = randomUUID();
      const body = { step_id: st.id, content_base64: Buffer.from(`race ${randomUUID()}`).toString("base64") };
      // hold the request's advisory lock so that the duplicates are inside their transactions, waiting, when the stored answer appears
      const lock = await owner().connect();
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`${Rr.tokenId}:${key}`]);
      const t0 = Date.now();
      const racers = Array.from({ length: 10 }, () => call("put_blob", body, { token: Rr.token, key, at }).then((r) => ({ ...r, ms: Date.now() - t0 })));
      let waiting = 0;
      for (let i = 0; i < 150 && waiting < 3; i++) { waiting = (await owner().query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'dapi' AND wait_event = 'advisory'")).rows[0].n; if (waiting < 3) await sleep(20); }
      // the worker API never takes more than its slots (3 of the pool's 5): the operator still gets a connection WHILE they wait
      const tHeld = Date.now();
      const during = await fetch(`http://127.0.0.1:${own.pub}/v1/workflows`, { headers: { authorization: `Bearer ${OPERATOR}` } }).then(async (r) => ({ status: r.status, ms: Date.now() - tHeld }));
      expect([waiting, own.pool.totalCount <= 5]).toEqual([3, true]);
      await owner().query("INSERT INTO worker_api_requests (token_id, idempotency_key, operation, step_id, request_sha256, response) VALUES ($1, $2, 'put_blob', $3, $4, '\"stored\"')",
        [Rr.tokenId, key, st.id, sha256Hex(`put_blob\n${JSON.stringify(body)}`)]);
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`${Rr.tokenId}:${key}`]); lock.release();
      const tProbe = Date.now();
      const probe = await fetch(`http://127.0.0.1:${own.pub}/v1/workflows`, { headers: { authorization: `Bearer ${OPERATOR}` } }).then(async (r) => ({ status: r.status, ms: Date.now() - tProbe }));
      const rs = await Promise.all(racers);
      const replayAudits = await count("SELECT count(*) AS n FROM audit_events WHERE action = 'worker_api.replayed' AND payload->>'token_id' = $1", [Rr.tokenId]);
      console.log(`[measured] 10 same-key duplicates: statuses ${JSON.stringify(rs.map((r) => r.status))}, slowest ${Math.max(...rs.map((r) => r.ms))} ms; operator GET while held: HTTP ${during.status} after ${during.ms} ms, after release: ${probe.ms} ms; 'replayed' audits ${replayAudits}/10`);
      expect(rs.every((r) => r.status === 200 && r.json.replayed === true && r.json.result === "stored"), JSON.stringify(rs.map((r) => [r.status, r.json?.error]))).toBe(true);
      expect(rs.some((r) => r.status === 500 || r.status === 422)).toBe(false);
      expect([during.status, probe.status]).toEqual([200, 200]);
      expect(during.ms).toBeLessThan(1_000); expect(probe.ms).toBeLessThan(1_000);
      expect(replayAudits).toBe(10); // every replay is audited (on the request's own connection)
      await own.close();
    });

    it("pool or connect timeouts are a RETRYABLE 503 [PREVENTED by D5]: asRefusal checks them before the generic 'rejected' mapping", async () => {
      const tiny = await startApi({}, undefined, 200); const at = `http://127.0.0.1:${tiny.priv}`;
      const Tt = await researchRun("adv-timeout"); const tc = new WorkerApiClient({ baseUrl: at, token: Tt.token, backoffMs: 1, attempts: 1 });
      const st = (await tc.claimNext(["acquire_repository"]))!;
      const held = await Promise.all(Array.from({ length: 5 }, () => tiny.pool.connect())); // the API's whole pool, taken
      const r = await call("put_blob", { step_id: st.id, content_base64: "eA==" }, { token: Tt.token, at });
      for (const c of held) c.release();
      expect([r.status, r.json?.error ?? null]).toEqual([503, "database_unavailable"]);
      await tiny.close();
    });

    // NOTE: this measurement passes on the code before D5 as well (the burst never exhausted the pool there either); it is NOT the test
    // that proves D5 (that is "racing duplicates exhaust the owner pool"). The request rate stays an in-memory, per-process bucket.
    it("API resource exhaustion from one token [PARTIAL availability, measured]: a 400-request burst is served at most 3 at a time (D5) and operator latency stays bounded; the rate limit is per process, in memory", async () => {
      const E = await researchRun("adv-dos"); await drive(E);
      const an = await claim(E); const snap = await snapOf(E.runId);
      const probe = async () => { const t = Date.now(); const r = await fetch(`http://127.0.0.1:${api.pub}/v1/workflows`, { headers: { authorization: `Bearer ${OPERATOR}` } }); await r.text(); return { ms: Date.now() - t, status: r.status }; };
      const baseline = await probe();
      const burst = Promise.all(Array.from({ length: 400 }, () => call("snapshot_sources", { step_id: an.id, snapshot_id: snap }, { token: E.token, key: null })));
      await sleep(30);
      const loaded = await probe();
      const results = await burst;
      const by = results.reduce<Record<string, number>>((m, r) => { const k = `${r.status}:${r.json?.error ?? "ok"}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
      console.log(`[measured] operator GET /v1/workflows: ${baseline.ms} ms idle, ${loaded.ms} ms during a 400-request burst from ONE worker token; burst statuses ${JSON.stringify(by)}`);
      expect(Object.keys(by).every((k) => ["200:ok", "503:worker_api_busy", "429:rate_limited"].includes(k)), JSON.stringify(by)).toBe(true);
      expect(loaded.status).toBe(200);
      expect(loaded.ms).toBeLessThan(2_000);
    });
  });
});
