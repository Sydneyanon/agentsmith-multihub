import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositoryResearchRun } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { buildDossier, type Dossier } from "../analysis/solidity/pipeline.js";
import { buildApp } from "../app.js";
import { AuthFailureLimiter } from "../auth.js";
import { promoteEligibleProgrammes } from "../bounties/promote.js";
import { ResearchStore } from "../research-state.js";
import { classifyStepError, LeaseLostError, StepError } from "../step-errors.js";
import { OPERATIONS } from "../worker-api.js";
import { RunTerminalError, WorkerApiClient } from "../worker-api-client.js";
import { executeRemoteStep, remoteStepKeys } from "../worker-remote.js";
import { runIntakeWorker } from "../worker-runtime.js";
import { mintWorkerToken, sha256Hex } from "../worker-tokens.js";
import { expireLease, migratedTestDatabase, REPO_ROOT, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * Option D on a THROWAWAY local database: the worker holds no database credential and does everything through the API's internal
 * worker routes, authorised by a run-scoped capability token. The end-to-end case runs a REAL API process (server.ts) and a REAL worker
 * process with no database URL in its environment, over real HTTP; the rest use an in-process Fastify server listening on a real port.
 */
const DRAFT = join(REPO_ROOT, "db", "drafts", "d-worker-api", "0015_worker_capability_tokens.sql");
const OPERATOR = randomBytes(36).toString("base64url");
const corpus = join(REPO_ROOT, "eval", "dev", "contracts");
const devFiles = () => readdirSync(corpus).sort().map((f) => ({ path: `contracts/${f}`, content: readFileSync(join(corpus, f), "utf8") }));
const field = (value: unknown) => ({ value, source: "sherlock", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });
const SWITCHES = { STRUCTURAL_ANALYSIS_ENABLED: "true" };
const PROTECTED = ["bounty_programs", "bounty_repository_mappings", "bounty_research_links", "bounty_sources", "bounty_opportunities", "bounty_scores", "ai_budget_reservations", "budget_policies", "approvals", "ai_model_prices", "discovery_sources", "programs"];

const freePort = () => new Promise<number>((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
type Proc = { code: Promise<number | null>; out: () => string; kill: () => void };
function start(script: string, env: Record<string, string>): Proc {
  const child = spawn(`${REPO_ROOT}node_modules/.bin/tsx`, [`${REPO_ROOT}${script}`], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { out += c; });
  return { code: new Promise((resolve) => child.on("close", (c) => resolve(c))), out: () => out, kill: () => { child.kill("SIGTERM"); } };
}
/** the secret part of `wct1_<32 hex id>_<secret>` (base64url, so it may itself contain "_") */
const secretOf = (token: string) => token.slice("wct1_".length + 33);
const stripIds = (d: Dossier) => d.entries.map(({ hypothesis_id: _id, ...rest }) => rest);

describe.skipIf(skipIntegration)("option D: the worker reaches the database only through the API's run-scoped worker routes", () => {
  let db: TestDatabase; let app: FastifyInstance; let base = ""; const fixtures: GitFixture[] = []; let n = 4200;
  const owner = () => db.ownerPool;
  const permissive = () => new AuthFailureLimiter({ perClientMax: 1e6, globalMax: 1e6, windowMs: 60_000 });

  beforeAll(async () => {
    db = await migratedTestDatabase();
    await owner().query(readFileSync(DRAFT, "utf8"));
    // the API uses the OWNER connection, as it does in production (Fly's schema_admin)
    app = buildApp({ pool: owner(), apiBearerToken: OPERATOR, hubAllowedHosts: [], limiter: permissive(), engineInfo: { expectedMigrations: null }, workerApi: { reaperIntervalMs: 0, limiter: permissive() } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }, 60_000);
  afterAll(async () => { await app?.close(); for (const f of fixtures) f.cleanup(); await db?.drop(); });

  async function call(op: string, body: unknown, opts: { token?: string | null; key?: string | null | undefined; raw?: string; method?: string; url?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    if (opts.key !== null) headers["idempotency-key"] = opts.key ?? randomUUID();
    const res = await fetch(opts.url ?? `${base}/internal/worker/v1/${op}`, { method: opts.method ?? "POST", headers, ...(opts.method === "GET" ? {} : { body: opts.raw ?? JSON.stringify(body) }) });
    const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  }
  const client = (token: string, extra: Partial<ConstructorParameters<typeof WorkerApiClient>[0]> = {}) => new WorkerApiClient({ baseUrl: base, token, backoffMs: 1, attempts: 3, ...extra });
  const newRun = async (repo: string) => createRepositoryResearchRun(owner(), { repository: `acme/${repo}`, ref: "main" }, "operator", { structuralAnalysis: true });
  const fixture = (repo: string, files = devFiles()) => { const fx = buildGitFixture(files, { owner: "acme", repo }); fixtures.push(fx); return fx; };
  /** claim the next step of the token's run and run it through the SAME handlers the remote runtime uses */
  async function drive(c: WorkerApiClient, source: FakeSource) {
    const step = await c.claimNext(remoteStepKeys(SWITCHES)); expect(step).not.toBeNull();
    await executeRemoteStep(c, "test-remote", step!, { source, env: SWITCHES }); return step!;
  }
  const fingerprint = async () => {
    const out: Record<string, string> = {};
    for (const t of PROTECTED) out[t] = (await owner().query<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0]!.h;
    return out;
  };
  const evaluations = async (hypothesisId: string) => Number((await owner().query("SELECT count(*) FROM hypothesis_evaluations WHERE hypothesis_id = $1", [hypothesisId])).rows[0].count);
  const audits = async (tokenId: string) => (await owner().query<{ action: string; payload: Record<string, any> }>("SELECT action, payload FROM audit_events WHERE payload->>'token_id' = $1 AND action LIKE 'worker\\_api.%' ORDER BY id", [tokenId])).rows;

  /** A programme with a verified mapping, bridged into exactly one structural run (the bridge-to-dossier path). */
  async function bridged(repo: string): Promise<string> {
    n += 1;
    const resolved = { projectName: field(repo), officialUrl: field(`https://audits.sherlock.xyz/bug-bounties/${n}`), maxReward: field(250_000), chains: field(["Ethereum"]), technologies: field(["Solidity"]) };
    const prog = (await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1, $2, $2, $3::jsonb, 'active', 'official_confirmed') RETURNING id`, [`sherlock:${n}`, repo, JSON.stringify(resolved)])).rows[0].id as string;
    await owner().query(`INSERT INTO bounty_repository_mappings (bounty_program_id, repository, source_url, evidence, discovery_method, verification_status, confidence, default_branch, repository_github_id, last_seen_at)
      VALUES ($1, $2, $3, $4, 'official_page', 'official_documentation', 'high', 'main', $5, now())`, [prog, `acme/${repo}`, `https://audits.sherlock.xyz/bug-bounties/${n}`, `https://github.com/acme/${repo}`, n]);
    expect((await promoteEligibleProgrammes(db.pool, { createdBy: "bridge@test", structuralAnalysis: true, maxNewRuns: 1 })).created).toBe(1);
    return (await owner().query(`SELECT workflow_run_id FROM bounty_research_links WHERE repository = $1`, [`acme/${repo}`])).rows[0].workflow_run_id as string;
  }
  const stepsOf = async (runId: string) => (await owner().query<{ step_key: string; status: string }>(`SELECT step_key, status FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence`, [runId])).rows;
  const dossierOf = async (runId: string) => {
    const snap = (await owner().query(`SELECT id FROM repo_snapshots WHERE workflow_run_id = $1`, [runId])).rows[0];
    return buildDossier(owner(), new ResearchStore(owner()), snap.id);
  };

  it("end to end: bridge -> a worker PROCESS with no database URL -> a real API process -> the same dossier as the direct worker", async () => {
    const files = devFiles();
    const remoteRun = await bridged("remote-target");
    const directRun = await bridged("direct-target");
    // the direct worker (unchanged default) on its own run, in process, as the bridge-to-dossier test does
    const saved = process.env.STRUCTURAL_ANALYSIS_ENABLED; process.env.STRUCTURAL_ANALYSIS_ENABLED = "true";
    const ac = new AbortController();
    const loop = runIntakeWorker(db.pool, "direct-worker", ac.signal, { onlyRunId: directRun, pollMs: 50, source: new FakeSource(fixture("direct-target", files)) });
    try { for (let i = 0; i < 1200 && !(await stepsOf(directRun)).every((s) => s.status === "succeeded"); i++) await new Promise((r) => setTimeout(r, 50)); }
    finally { ac.abort(); await loop.catch(() => undefined); if (saved === undefined) delete process.env.STRUCTURAL_ANALYSIS_ENABLED; else process.env.STRUCTURAL_ANALYSIS_ENABLED = saved; }
    expect((await stepsOf(directRun)).every((s) => s.status === "succeeded")).toBe(true);
    const direct = await dossierOf(directRun);
    const before = await fingerprint();

    // a REAL API process: owner connection, the worker API only on a second, private listener
    const [pub, priv] = [await freePort(), await freePort()];
    const api = start("apps/api/src/server.ts", { NODE_ENV: "test", DATABASE_URL: db.url, API_BEARER_TOKEN: OPERATOR, HOST: "127.0.0.1", PORT: String(pub), LOG_LEVEL: "info",
      WORKER_API_ENABLED: "true", WORKER_API_HOST: "127.0.0.1", WORKER_API_PORT: String(priv) });
    let worker: Proc | undefined;
    try {
      for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${pub}/health/live`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
      // an operator mints the run-scoped token through the authenticated API (the hub or the CLI would do the same)
      const minted = await fetch(`http://127.0.0.1:${pub}/v1/research/runs/${remoteRun}/worker-tokens`, { method: "POST", headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" }, body: JSON.stringify({ ttl_seconds: 3600, created_by: "operator@test" }) });
      expect(minted.status).toBe(201); expect(minted.headers.get("cache-control")).toBe("no-store");
      const { token, token_id: tokenId } = await minted.json() as { token: string; token_id: string };
      const secret = secretOf(token);
      // the worker routes do not exist on the PUBLIC listener, even with a valid token
      const onPublic = await fetch(`http://127.0.0.1:${pub}/internal/worker/v1/claim`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ step_keys: ["acquire_repository"] }) });
      expect(onPublic.status).toBe(404);

      const dir = mkdtempSync(join(tmpdir(), "remote-child-")); const spec = join(dir, "fixture.json");
      writeFileSync(spec, JSON.stringify({ owner: "acme", repo: "remote-target", files }));
      // the worker's ENTIRE environment: no DATABASE_URL, no PG* variable, nothing that could connect to Postgres
      const env = { WORKER_STORE: "api", WORKER_API_URL: `http://127.0.0.1:${priv}`, WORKER_API_TOKEN: token, ...SWITCHES, REMOTE_CHILD_FIXTURE: spec, NODE_ENV: "test" };
      expect(Object.keys(env).filter((k) => /DATABASE|^PG/.test(k))).toEqual([]);
      worker = start("apps/api/src/integration/remote-worker-child.ts", env);
      const code = await Promise.race([worker.code, new Promise<number>((r) => setTimeout(() => r(-1), 110_000))]);
      rmSync(dir, { recursive: true, force: true });
      expect(code, worker.out()).toBe(0);
      expect(worker.out()).toContain('"stop":"run_finished"'); expect(worker.out()).toContain('"db_env_present":[]');

      expect((await stepsOf(remoteRun)).map((s) => `${s.step_key}:${s.status}`)).toEqual(["acquire_repository:succeeded", "analyze_structure:succeeded", "challenge_leads:succeeded", "build_dossier:succeeded"]);
      expect((await owner().query("SELECT status FROM workflow_runs WHERE id = $1", [remoteRun])).rows[0].status).toBe("succeeded");
      const remote = await dossierOf(remoteRun);
      expect(remote.snapshot.verified).toBe(true);
      expect(remote.coverage).toEqual(direct.coverage);
      expect(remote.entries.length).toBeGreaterThan(0);
      expect(stripIds(remote)).toEqual(stripIds(direct));
      expect(remote.architecture).toEqual(direct.architecture);
      expect(remote.content_sha256).toBe(direct.content_sha256); // the same dossier content as the direct mode
      const dossierStep = (await owner().query(`SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = 'build_dossier'`, [remoteRun])).rows[0].output;
      expect(dossierStep.content_sha256).toBe(direct.content_sha256);
      // every lease was held by the token's identity; the audit trail names the token id and never the token
      const claimedBy = (await owner().query(`SELECT DISTINCT a.actor FROM audit_events a JOIN workflow_steps s ON s.id::text = a.entity_id WHERE a.action = 'workflow_step.claimed' AND s.workflow_run_id = $1`, [remoteRun])).rows.map((r) => r.actor);
      expect(claimedBy).toEqual([`worker-api:${tokenId}`]);
      const trail = await audits(tokenId);
      expect(trail.filter((a) => a.action === "worker_api.accepted").length).toBeGreaterThan(20);
      expect(new Set(trail.map((a) => a.payload.run_id))).toEqual(new Set([remoteRun]));
      for (const where of [
        "SELECT count(*) FROM audit_events WHERE strpos(actor || coalesce(reason, '') || payload::text, $1) > 0",
        "SELECT count(*) FROM worker_api_requests WHERE strpos(response::text, $1) > 0",
        "SELECT count(*) FROM workflow_steps WHERE strpos(coalesce(output::text, '') || coalesce(error::text, '') || input::text, $1) > 0",
        "SELECT count(*) FROM worker_capability_tokens WHERE strpos(secret_sha256 || created_by, $1) > 0",
      ]) expect(Number((await owner().query(where, [secret])).rows[0].count), where).toBe(0);
      expect((await owner().query("SELECT secret_sha256 FROM worker_capability_tokens WHERE id = $1", [tokenId])).rows[0].secret_sha256).toBe(sha256Hex(secret)); // only the hash is stored
      expect(api.out()).not.toContain(secret); expect(worker.out()).not.toContain(secret);
      expect(api.out()).toContain("internal worker API listening on the private listener only");
      expect(await fingerprint()).toEqual(before); // no bounty, budget, approval, price or source row changed
      // the run is terminal: the same token is now refused for everything
      const after = await fetch(`http://127.0.0.1:${priv}/internal/worker/v1/claim`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ step_keys: ["acquire_repository"] }) });
      expect(after.status).toBe(403); expect(((await after.json()) as { error: string }).error).toBe("run_terminal");
    } finally { worker?.kill(); api.kill(); await api.code; }
  }, 240_000);

  it("refuses to start in remote mode when any database URL is present, and the default mode is still the direct worker", async () => {
    const run = await newRun("startup-refusal");
    const { token, tokenId } = await mintWorkerToken(owner(), { runId: run.runId, createdBy: "operator@test" });
    const remote = { WORKER_STORE: "api", WORKER_API_URL: base, WORKER_API_TOKEN: token };
    for (const extra of [{ DATABASE_URL: db.url }, { WORKER_DATABASE_URL: db.url }, { PGPASSWORD: "x" }, { SOME_OTHER_SETTING: db.url }]) {
      const p = start("apps/api/src/worker-main.ts", { ...remote, ...extra });
      expect(await p.code, p.out()).toBe(64);
      expect(p.out()).toMatch(/refusing to start in remote mode: database connection settings are present/);
      expect(p.out()).not.toContain(secretOf(token));
    }
    expect(await audits(tokenId)).toEqual([]); // nothing reached the API: the refusal happens before any request
    const bogus = start("apps/api/src/worker-main.ts", { WORKER_STORE: "sql" });
    expect(await bogus.code).toBe(64);
    const noToken = start("apps/api/src/worker-main.ts", { WORKER_STORE: "api", WORKER_API_URL: base });
    expect(await noToken.code).toBe(64);
    const plainHttp = start("apps/api/src/worker-main.ts", { ...remote, WORKER_API_URL: "http://api.example.com" });
    expect(await plainHttp.code).toBe(64); expect(plainHttp.out()).toMatch(/must be https/);
    // WORKER_STORE unset: the unchanged direct worker, which still insists on its database URL
    const direct = start("apps/api/src/worker-main.ts", {});
    expect(await direct.code).toBe(1); expect(direct.out()).toContain("WORKER_DATABASE_URL or DATABASE_URL is required");
  }, 120_000);

  it("scopes a token to its run, enforces leases and per-step operations, and never duplicates a retried write", async () => {
    const b = await newRun("scope-b"); const a = await newRun("scope-a"); // B first: an unscoped claim would take B's step
    const ta = await mintWorkerToken(owner(), { runId: a.runId, createdBy: "operator@test" });
    const tb = await mintWorkerToken(owner(), { runId: b.runId, createdBy: "operator@test" });
    const ca = client(ta.token), cb = client(tb.token);
    const srcA = new FakeSource(fixture("scope-a")), srcB = new FakeSource(fixture("scope-b"));

    // nothing of the run's own is held yet: lifecycle calls are refused
    expect((await call("heartbeat", { step_id: a.stepId }, { token: ta.token, key: null })).json.error).toBe("lease_not_held");
    const stepA = await ca.claimNext(remoteStepKeys(SWITCHES));
    expect(stepA!.workflow_run_id).toBe(a.runId); expect(stepA!.id).toBe(a.stepId); // A's token claims A's step, never B's
    const stepB = await cb.claimNext(remoteStepKeys(SWITCHES)); expect(stepB!.id).toBe(b.stepId);
    // A's token cannot touch B's step in any way
    for (const [op, body] of [["heartbeat", { step_id: b.stepId }], ["put_blob", { step_id: b.stepId, content_base64: "eA==" }], ["complete", { step_id: b.stepId, output: { status: "snapshot_sealed" } }], ["fail", { step_id: b.stepId, reason: "x", retryable: false }]] as const) {
      const r = await call(op, body, { token: ta.token, key: op === "heartbeat" ? null : undefined });
      expect(r.status, op).toBe(403); expect(r.json.error, op).toBe("step_not_in_run");
    }
    // a second token for the SAME run is a different lease owner: it cannot act on a step the first holds
    const ta2 = await mintWorkerToken(owner(), { runId: a.runId, createdBy: "operator@test" });
    expect((await call("heartbeat", { step_id: a.stepId }, { token: ta2.token, key: null })).json.error).toBe("lease_not_held");
    // per-step operation allow-list: an acquisition step may not record hypotheses or build a dossier
    expect((await call("build_dossier", { step_id: a.stepId, snapshot_id: randomUUID() }, { token: ta.token, key: null })).json.error).toBe("operation_not_allowed_for_step");
    // a completion must carry the step's own result shape
    expect((await call("complete", { step_id: a.stepId, output: { status: "dossier_built" } }, { token: ta.token })).json.error).toBe("output_rejected");
    // an acquisition step may snapshot only the repository and ref it was queued for
    for (const [repository, ref] of [["acme/scope-b", "main"], ["acme/scope-a", "attacker-branch"]] as const) {
      expect((await call("create_snapshot", { step_id: a.stepId, repository, commit_sha: "a".repeat(40), ref_name: ref }, { token: ta.token })).json.error).toBe("repository_mismatch");
    }
    expect(Number((await owner().query("SELECT count(*) FROM repo_snapshots WHERE workflow_run_id = $1", [a.runId])).rows[0].count)).toBe(0);

    // B runs to the end through the remote path; afterwards B's token is refused for everything
    await executeRemoteStep(cb, "test-remote", stepB!, { source: srcB, env: SWITCHES });
    for (let i = 0; i < 3; i++) await drive(cb, srcB);
    expect((await stepsOf(b.runId)).every((s) => s.status === "succeeded")).toBe(true);
    await expect(cb.claimNext(remoteStepKeys(SWITCHES))).rejects.toBeInstanceOf(RunTerminalError);
    expect((await call("heartbeat", { step_id: b.stepId }, { token: tb.token, key: null })).json.error).toBe("run_terminal");
    const snapB = (await owner().query("SELECT id FROM repo_snapshots WHERE workflow_run_id = $1", [b.runId])).rows[0].id as string;
    const hypB = (await owner().query("SELECT id FROM hypotheses WHERE workflow_run_id = $1 LIMIT 1", [b.runId])).rows[0].id as string;
    const spanB = (await owner().query("SELECT id FROM evidence_spans WHERE workflow_run_id = $1 LIMIT 1", [b.runId])).rows[0].id as string;

    // A: acquisition, analysis, then hold the challenge step
    await executeRemoteStep(ca, "test-remote", stepA!, { source: srcA, env: SWITCHES });
    await drive(ca, srcA);
    const challenge = await ca.claimNext(remoteStepKeys(SWITCHES)); expect(challenge!.step_key).toBe("challenge_leads");
    const snapA = (await owner().query("SELECT id FROM repo_snapshots WHERE workflow_run_id = $1", [a.runId])).rows[0].id as string;
    const hypA = (await owner().query("SELECT id FROM hypotheses WHERE workflow_run_id = $1 ORDER BY id LIMIT 1", [a.runId])).rows[0].id as string;
    const cross = [
      ["snapshot_sources", { step_id: challenge!.id, snapshot_id: snapB }],
      ["hypothesis_span_ids", { step_id: challenge!.id, hypothesis_id: hypB }],
      ["specialist_hypothesis_id", { step_id: challenge!.id, snapshot_id: snapB, claim: "anything at all" }],
      ["record_evaluation", { step_id: challenge!.id, hypothesis_id: hypB, evaluator_id: "no-independent-validator", evaluator_version: "1", outcome: "inconclusive", rationale: "x", span_ids: [], input_sha256: "0".repeat(64) }],
      ["record_evaluation", { step_id: challenge!.id, hypothesis_id: hypA, evaluator_id: "no-independent-validator", evaluator_version: "1", outcome: "supports", rationale: "x", span_ids: [spanB], input_sha256: "0".repeat(64) }],
    ] as const;
    for (const [op, body] of cross) { const r = await call(op, body, { token: ta.token, key: op === "record_evaluation" ? undefined : null }); expect(r.status, op).toBe(403); expect(r.json.error, op).toBe("cross_run_reference"); }
    expect((await call("create_hypothesis", { step_id: challenge!.id }, { token: ta.token })).status).toBe(400); // strict schema first
    expect((await call("put_blob", { step_id: challenge!.id, content_base64: "eA==" }, { token: ta.token })).json.error).toBe("operation_not_allowed_for_step");

    // idempotency: the same key twice writes once; the same key with another body is refused; concurrent duplicates write once
    const evaluation = { step_id: challenge!.id, hypothesis_id: hypA, evaluator_id: "no-independent-validator", evaluator_version: "1", outcome: "inconclusive", rationale: "idempotency probe", span_ids: [], input_sha256: "1".repeat(64) };
    const before = await evaluations(hypA); const key = randomUUID();
    const first = await call("record_evaluation", evaluation, { token: ta.token, key });
    const second = await call("record_evaluation", evaluation, { token: ta.token, key });
    expect(first.status).toBe(200); expect(second.json).toMatchObject({ ok: true, replayed: true, result: first.json.result });
    expect(await evaluations(hypA)).toBe(before + 1);
    expect((await call("record_evaluation", { ...evaluation, rationale: "changed" }, { token: ta.token, key })).json.error).toBe("idempotency_conflict");
    const k2 = randomUUID();
    const both = await Promise.all([call("record_evaluation", { ...evaluation, rationale: "concurrent" }, { token: ta.token, key: k2 }), call("record_evaluation", { ...evaluation, rationale: "concurrent" }, { token: ta.token, key: k2 })]);
    expect(both.map((r) => r.status)).toEqual([200, 200]); expect(both[0]!.json.result).toBe(both[1]!.json.result);
    expect(await evaluations(hypA)).toBe(before + 2);
    // a response lost AFTER the API committed: the client retries with the same key and gets the stored answer, not a second row
    let dropped = false;
    const lossy = client(ta.token, { fetchImpl: async (input, init) => { const res = await fetch(input, init); if (!dropped && String(input).endsWith("record_evaluation")) { dropped = true; throw new TypeError("fetch failed"); } return res; } });
    lossy.scopeToStep(challenge!.id);
    const id = await lossy.recordEvaluation({ stepId: challenge!.id, workerId: "ignored" }, { hypothesisId: hypA, evaluatorId: "no-independent-validator", evaluatorVersion: "1", outcome: "inconclusive", rationale: "lost response", spanIds: [], inputSha256: "2".repeat(64) });
    expect(dropped).toBe(true); expect(typeof id).toBe("string");
    expect(Number((await owner().query("SELECT count(*) FROM hypothesis_evaluations WHERE rationale = 'lost response'")).rows[0].count)).toBe(1);

    // a lease that has expired is not held: every write is refused, and the client reports it as LeaseLostError
    await expireLease(owner(), challenge!.id);
    expect((await call("record_evaluation", { ...evaluation, rationale: "late" }, { token: ta.token })).json.error).toBe("lease_not_held");
    await expect(ca.recordEvaluation({ stepId: challenge!.id, workerId: "x" }, { hypothesisId: hypA, evaluatorId: "no-independent-validator", evaluatorVersion: "1", outcome: "inconclusive", rationale: "late", spanIds: [], inputSha256: "3".repeat(64) })).rejects.toBeInstanceOf(LeaseLostError);
    expect(await ca.heartbeat(challenge!.id)).toBe(false);

    // the audit trail: accepted, refused and replayed calls, each with the token id, operation, run and step; never the token
    const trail = await audits(ta.tokenId);
    const outcomes = new Set(trail.map((t) => t.payload.outcome));
    expect(outcomes).toEqual(new Set(["accepted", "refused", "replayed"]));
    for (const t of trail) { expect(t.payload).toMatchObject({ token_id: ta.tokenId, run_id: a.runId }); expect(typeof t.payload.operation).toBe("string"); }
    expect(trail.some((t) => t.payload.outcome === "refused" && t.payload.code === "cross_run_reference" && t.payload.step_id === challenge!.id)).toBe(true);
    expect(trail.some((t) => t.payload.outcome === "refused" && t.payload.code === "lease_not_held" && t.payload.operation === "record_evaluation")).toBe(true);
    expect(Number((await owner().query("SELECT count(*) FROM audit_events WHERE strpos(payload::text, $1) > 0", [secretOf(ta.token)])).rows[0].count)).toBe(0);
  }, 120_000);

  it("refuses expired, revoked and unknown tokens (the worker stops with exit code 77), and invalid, oversized and unknown operations", async () => {
    const run = await newRun("refusals");
    // expired: created two hours ago, expired one hour ago
    const secret = randomBytes(32).toString("base64url");
    const expired = (await owner().query<{ id: string }>(`INSERT INTO worker_capability_tokens (workflow_run_id, secret_sha256, created_by, created_at, expires_at) VALUES ($1, $2, 'operator@test', now() - interval '2 hours', now() - interval '1 hour') RETURNING id`, [run.runId, sha256Hex(secret)])).rows[0]!.id;
    const expiredToken = `wct1_${expired.replace(/-/g, "")}_${secret}`;
    const r1 = await call("claim", { step_keys: ["acquire_repository"] }, { token: expiredToken });
    expect(r1.status).toBe(401); expect(r1.json.error).toBe("token_expired");
    expect((await audits(expired)).map((a) => [a.action, a.payload.code])).toEqual([["worker_api.refused", "token_expired"]]);

    // revoked through the operator route; the worker process then stops cleanly with its distinct exit code
    const t = await mintWorkerToken(owner(), { runId: run.runId, createdBy: "operator@test" });
    const revoke = await fetch(`${base}/v1/research/worker-tokens/${t.tokenId}/revoke`, { method: "POST", headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "test" }) });
    expect(revoke.status).toBe(200);
    expect((await call("claim", { step_keys: ["acquire_repository"] }, { token: t.token })).json.error).toBe("token_revoked");
    await expect(owner().query("UPDATE worker_capability_tokens SET revoked_at = NULL, revoked_by = NULL WHERE id = $1", [t.tokenId])).rejects.toThrow(/stays revoked/);
    await expect(owner().query("DELETE FROM worker_capability_tokens WHERE id = $1", [t.tokenId])).rejects.toThrow(/never deleted/);
    const dir = mkdtempSync(join(tmpdir(), "remote-child-")); const spec = join(dir, "fixture.json");
    writeFileSync(spec, JSON.stringify({ owner: "acme", repo: "refusals", files: [{ path: "README.md", content: "x\n" }] }));
    const child = start("apps/api/src/integration/remote-worker-child.ts", { WORKER_STORE: "api", WORKER_API_URL: base, WORKER_API_TOKEN: t.token, REMOTE_CHILD_FIXTURE: spec, NODE_ENV: "test" });
    expect(await child.code, child.out()).toBe(77); expect(child.out()).toContain('"stop":"token_rejected"'); expect(child.out()).not.toContain(secretOf(t.token));
    rmSync(dir, { recursive: true, force: true });
    expect((await owner().query("SELECT status, attempt FROM workflow_steps WHERE id = $1", [run.stepId])).rows[0]).toEqual({ status: "queued", attempt: 0 });

    // unknown or forged tokens
    const live = await mintWorkerToken(owner(), { runId: run.runId, createdBy: "operator@test" });
    const forged = `${live.token.slice(0, -4)}AAAA`;
    for (const tok of [null, "nonsense", forged, `wct1_${"0".repeat(32)}_${"A".repeat(43)}`]) {
      const r = await call("claim", { step_keys: ["acquire_repository"] }, { token: tok });
      expect(r.status, String(tok)).toBe(401); expect(r.json.error).toBe("token_invalid");
    }
    expect((await owner().query("SELECT payload FROM audit_events WHERE action = 'worker_api.refused' AND payload->>'presented_token_id' = $1", [live.tokenId])).rows.length).toBe(1);

    // validation: strict schemas, the idempotency key, body limits, malformed JSON
    const v = (r: { status: number; json: any }) => [r.status, r.json?.error];
    expect(v(await call("claim", { step_keys: ["acquire_repository"], sql: "DELETE FROM hypotheses" }, { token: live.token }))).toEqual([400, "invalid_request"]);
    expect(v(await call("claim", { step_keys: ["drop_tables"] }, { token: live.token }))).toEqual([400, "invalid_request"]);
    expect(v(await call("claim", { step_keys: ["acquire_repository"] }, { token: live.token, key: null }))).toEqual([400, "idempotency_key_required"]);
    expect(v(await call("heartbeat", {}, { token: live.token, key: null, raw: "{not json" }))).toEqual([400, "malformed_body"]);
    expect(v(await call("heartbeat", { step_id: run.stepId, pad: "x".repeat(10_000) }, { token: live.token, key: null }))).toEqual([413, "body_too_large"]);
    expect(v(await call("put_blob", { step_id: run.stepId, content_base64: "A".repeat(1_500_000) }, { token: live.token }))).toEqual([413, "body_too_large"]);
    expect(v(await call("create_hypothesis", { step_id: run.stepId, snapshot_id: randomUUID(), family: "solidity-x", claim: "a claim long enough", rationale: "r", required_checks: [], alternative_explanations: [],
      generator: { kind: "human", id: "operator", version: "1" }, spans: [{ span_id: randomUUID(), role: "primary" }] }, { token: live.token }))).toEqual([400, "invalid_request"]);
    expect(v(await call("record_evaluation", { step_id: run.stepId, hypothesis_id: randomUUID(), evaluator_id: "human-review", evaluator_version: "1", outcome: "supports", rationale: "r", span_ids: [], input_sha256: "0".repeat(64) }, { token: live.token }))).toEqual([400, "invalid_request"]);
    const refusedCodes = (await audits(live.tokenId)).map((a) => a.payload.code);
    for (const code of ["invalid_request", "idempotency_key_required", "malformed_body", "body_too_large"]) expect(refusedCodes).toContain(code);
    // unknown operations, other methods and path tricks never reach worker code: the default-deny operator check answers 401
    for (const [method, path] of [["POST", "query"], ["POST", "sql"], ["POST", "update_hypothesis"], ["POST", "delete_snapshot"], ["POST", "claim/"], ["PUT", "claim"], ["DELETE", "claim"], ["PATCH", "complete"]] as const) {
      const r = await fetch(`${base}/internal/worker/v1/${path}`, { method, headers: { authorization: `Bearer ${live.token}`, "content-type": "application/json" }, body: "{}" });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    const asOperator = await fetch(`${base}/internal/worker/v1/query`, { method: "POST", headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" }, body: "{}" });
    expect(asOperator.status).toBe(404); // and the operator token does not open a worker route either
    expect((await call("claim", { step_keys: ["acquire_repository"] }, { token: OPERATOR })).status).toBe(401);
    for (const r of [r1]) expect(r.text).not.toContain(secret);
  }, 120_000);

  it("offers an explicit allow-list with no update, delete, query or non-research operation", () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual(["add_snapshot_files", "build_dossier", "claim", "complete", "create_evidence_span", "create_hypothesis", "create_snapshot", "fail", "find_snapshot",
      "heartbeat", "hypothesis_span_ids", "put_blob", "record_evaluation", "seal_snapshot", "sealed_snapshot", "slither_hypothesis_ids", "slither_scan_outcome", "snapshot_solidity_files",
      "snapshot_sources", "specialist_hypotheses_of_run", "specialist_hypothesis_id", "verify_snapshot"].sort());
    for (const name of Object.keys(OPERATIONS)) expect(name).not.toMatch(/update|delete|drop|truncate|query|sql|exec|bounty|budget|approval|price|source_|review|withdraw/);
    // the server's own SQL: the only UPDATE is the token's last-use time; no DELETE or TRUNCATE at all
    const src = readFileSync(join(REPO_ROOT, "apps/api/src/worker-api.ts"), "utf8");
    expect(src.match(/\bUPDATE\s+\w+/g)).toEqual(["UPDATE worker_capability_tokens"]);
    expect(src).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bALTER\s+TABLE\b|DISABLE TRIGGER/);
  });

  it("an unreachable API is retryable for the loop, and a step with an unrecorded write can never complete", async () => {
    const dead = new WorkerApiClient({ baseUrl: `http://127.0.0.1:${await freePort()}`, token: `wct1_${"a".repeat(32)}_${"B".repeat(43)}`, attempts: 2, backoffMs: 1 });
    dead.scopeToStep(randomUUID());
    const error = await dead.putBlob({ stepId: "00000000-0000-4000-8000-000000000001", workerId: "x" }, Buffer.from("x")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepError); expect(classifyStepError(error).kind).toBe("retryable");
    expect((error as Error).message).not.toContain("B".repeat(43));
    await expect(dead.complete("00000000-0000-4000-8000-000000000001", { status: "x" })).rejects.toThrow(/not completed and will be retried/);
  });
});
