import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepositoryResearchRun } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { GitHubSource } from "../acquisition/github-source.js";
import { startLoopbackGitHub, type LoopbackGitHub } from "../acquisition/testing/loopback-github.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { buildApp } from "../app.js";
import { AuthFailureLimiter } from "../auth.js";
import { WorkerApiClient } from "../worker-api-client.js";
import { executeRemoteStep, remoteStepKeys } from "../worker-remote.js";
import { runIntakeWorker } from "../worker-runtime.js";
import { mintWorkerToken } from "../worker-tokens.js";
import { PROGRESS_ACTION } from "../step-progress.js";
import type { Metric, Panel } from "../operations-api.js";
import { migratedTestDatabase, REPO_ROOT, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * The live operations dashboard against a disposable database: the progress record (both modes), the read-only progress, timeline
 * and system endpoints, and that every number equals a count over the stored records. Remote mode uses an in-process API with the
 * worker routes and the loopback GitHub (D2); direct mode uses the real worker runtime.
 */
const GH_TOKEN = "github_pat_" + "11ABCDEFG0" + "y".repeat(72);
const OPERATOR = randomBytes(36).toString("base64url");
const corpus = join(REPO_ROOT, "eval", "dev", "contracts");
const sol = readdirSync(corpus).sort();
const devFiles = () => [...sol.map((f) => ({ path: `src/${f}`, content: readFileSync(join(corpus, f), "utf8") })), ...sol.slice(0, 2).map((f) => ({ path: `test/${f}`, content: readFileSync(join(corpus, f), "utf8") })), { path: "README.md", content: "# fixture\n" }];
const SWITCHES = { STRUCTURAL_ANALYSIS_ENABLED: "true" };
const scopeOf = (programme: string, extra: string[] = []) => ({ programme, in_scope_paths: [...sol.map((f) => `src/${f}`), ...extra], evidence: "docs/research-runs/usx-scope-evidence.md", evidence_sha256: "c".repeat(64) });

describe.skipIf(skipIntegration)("live operations dashboard: progress records and read-only aggregation from stored records", () => {
  let db: TestDatabase; let app: FastifyInstance; let base = ""; let gh: LoopbackGitHub; const fixtures: GitFixture[] = [];
  const owner = () => db.ownerPool;
  const permissive = () => new AuthFailureLimiter({ perClientMax: 1e6, globalMax: 1e6, windowMs: 60_000 });
  const bodies: string[] = []; // every response body any test read, for the no-token check
  const secrets: string[] = [GH_TOKEN];

  beforeAll(async () => {
    db = await migratedTestDatabase(); gh = await startLoopbackGitHub();
    const github = new GitHubSource({ token: GH_TOKEN, testOrigins: { api: gh.origin, archive: [gh.origin] }, requestTimeoutMs: 5000 });
    app = buildApp({ pool: owner(), apiBearerToken: OPERATOR, hubAllowedHosts: [], limiter: permissive(), engineInfo: { expectedMigrations: null }, workerApi: { reaperIntervalMs: 0, limiter: permissive(), github } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }, 60_000);
  afterAll(async () => { await app?.close(); await gh?.close(); for (const f of fixtures) f.cleanup(); await db?.drop(); });

  const fixture = (repo: string) => { const fx = buildGitFixture(devFiles(), { owner: "acme", repo }); fixtures.push(fx); gh.add(fx); return fx; };
  async function get(path: string, token: string | null = OPERATOR): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const text = await res.text(); bodies.push(text); return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  async function wcall(op: string, body: Record<string, unknown>, token: string | null): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}/internal/worker/v1/${op}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const text = await res.text(); bodies.push(text); return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  const client = (token: string) => new WorkerApiClient({ baseUrl: base, token, backoffMs: 1, attempts: 2 });
  const progressRows = async (stepId: string) => (await owner().query<{ payload: any; actor: string }>(`SELECT payload, actor FROM audit_events WHERE entity_type = 'workflow_step' AND entity_id = $1 AND action = $2 ORDER BY id`, [stepId, PROGRESS_ACTION])).rows;
  const panelOf = (doc: any, id: string): Panel => doc.panels.find((p: Panel) => p.id === id);
  const m = (p: Panel, key: string): Metric => [...p.processing, ...p.coverage, ...p.counts].find((x) => x.key === key)!;
  const n = async (sql: string, params: unknown[]) => Number((await owner().query(sql, params)).rows[0].n);

  let remoteRun = ""; let directRun = "";

  it("report_progress: valid only for the token's leased step, strict schema, quota-counted, throttled and persisted", async () => {
    const fx = fixture("ops-remote"); void fx;
    const run = await createRepositoryResearchRun(owner(), { repository: "acme/ops-remote", ref: "main" }, "operator", { structuralAnalysis: true, bountyScope: scopeOf("sherlock:9001", ["src/Missing.sol"]) });
    remoteRun = run.runId;
    const other = await createRepositoryResearchRun(owner(), { repository: "acme/ops-other", ref: "main" }, "operator", { structuralAnalysis: true });
    const tok = await mintWorkerToken(owner(), { runId: run.runId, createdBy: "operator@test" }); secrets.push(tok.token, tok.token.slice("wct1_".length + 33));
    const tokOther = await mintWorkerToken(owner(), { runId: other.runId, createdBy: "operator@test" }); secrets.push(tokOther.token);
    const c = client(tok.token);
    const step = await c.claimNext(remoteStepKeys(SWITCHES)); expect(step!.step_key).toBe("acquire_repository");
    const p = { phase: "planned", done: 0, total: 31, unit: "files" };

    // accepted and persisted with the worker label and the token id (never the token)
    const ok = await wcall("report_progress", { step_id: step!.id, ...p }, tok.token);
    expect(ok.status).toBe(200); expect(ok.json.result).toEqual({ recorded: true });
    let rows = await progressRows(step!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ ...p, reported_by: "worker", via: "worker_api", token_id: tok.tokenId, step_key: "acquire_repository" });
    expect(rows[0]!.actor).toBe(`worker-token:${tok.tokenId}`);
    // throttled: the same phase again within the interval is not stored; a phase change and a completed phase are
    expect((await wcall("report_progress", { step_id: step!.id, ...p, done: 5 }, tok.token)).json.result).toEqual({ recorded: false, reason: "throttled" });
    expect((await wcall("report_progress", { step_id: step!.id, phase: "writing_manifest", done: 3, total: 31, unit: "manifest_rows" }, tok.token)).json.result).toEqual({ recorded: true });
    expect((await wcall("report_progress", { step_id: step!.id, phase: "writing_manifest", done: 31, total: 31, unit: "manifest_rows" }, tok.token)).json.result).toEqual({ recorded: true });
    rows = await progressRows(step!.id); expect(rows.map((r) => [r.payload.phase, r.payload.done])).toEqual([["planned", 0], ["writing_manifest", 3], ["writing_manifest", 31]]);
    // quota-counted: the reports were charged to the token's storage ledger
    expect(await n("SELECT bytes_stored AS n FROM worker_token_usage WHERE token_id = $1", [tok.tokenId])).toBeGreaterThan(0);

    // refused: bad schema (each shape), no lease (a queued step of the same run), another run's step, no token
    const before = rows.length;
    for (const bad of [{ ...p, done: 40 }, { ...p, unit: "percent" }, { ...p, extra: 1 }, { ...p, phase: "DROP TABLE" }, { ...p, done: -1 }]) {
      const r = await wcall("report_progress", { step_id: step!.id, ...bad }, tok.token); expect([r.status, r.json.error], JSON.stringify(bad)).toEqual([400, "invalid_request"]);
    }
    const queued = (await owner().query("SELECT id FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = 'analyze_structure'", [run.runId])).rows[0].id;
    expect((await wcall("report_progress", { step_id: queued, ...p }, tok.token)).json.error).toBe("lease_not_held");
    expect((await wcall("report_progress", { step_id: step!.id, ...p }, tokOther.token)).json.error).toBe("step_not_in_run");
    expect((await wcall("report_progress", { step_id: step!.id, ...p }, null)).status).toBe(401);
    expect((await progressRows(step!.id)).length).toBe(before);
    expect((await progressRows(queued)).length).toBe(0);
    const refused = (await owner().query<{ code: string }>("SELECT payload->>'code' AS code FROM audit_events WHERE action = 'worker_api.refused' AND payload->>'operation' = 'report_progress'")).rows.map((r) => r.code);
    expect(refused.filter((x) => x === "invalid_request")).toHaveLength(5);
    expect(refused).toEqual(expect.arrayContaining(["lease_not_held", "step_not_in_run", "token_invalid"]));

    // a token whose storage quota is spent cannot store progress (D4)
    const tightPool = new pg.Pool({ connectionString: db.url, max: 2 }); // the app ends its pool on close
    const tight = buildApp({ pool: tightPool, apiBearerToken: OPERATOR, hubAllowedHosts: [], limiter: permissive(), engineInfo: { expectedMigrations: null }, workerApi: { reaperIntervalMs: 0, limiter: permissive(), quotas: { maxBytesStored: 1 } } });
    try {
      const r = await tight.inject({ method: "POST", url: "/internal/worker/v1/report_progress", headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json" }, payload: { step_id: step!.id, phase: "sealed", done: 31, total: 31, unit: "manifest_rows" } });
      expect(r.statusCode).toBe(413); expect(r.json().error).toBe("storage_quota_exceeded");
    } finally { await tight.close(); }

    // the honest client path: the acquisition reports through the same operation while it runs, then the run completes remotely
    await executeRemoteStep(c, "ops-remote-worker", step!, { source: new FakeSource(fixtures.at(-1)!), env: SWITCHES });
    const phases = (await progressRows(step!.id)).map((r) => r.payload.phase);
    expect(phases).toEqual(expect.arrayContaining(["resolved_commit", "storing_blobs", "sealed"]));
    for (let i = 0; i < 3; i++) { const s = await c.claimNext(remoteStepKeys(SWITCHES)); await executeRemoteStep(c, "ops-remote-worker", s!, { source: new FakeSource(fixtures.at(-1)!), env: SWITCHES }); }
    expect((await owner().query("SELECT status FROM workflow_runs WHERE id = $1", [run.runId])).rows[0].status).toBe("succeeded");
    const awaited = await n(`SELECT count(*)::int AS n FROM audit_events a JOIN workflow_steps s ON s.id::text = a.entity_id WHERE a.action = $1 AND s.workflow_run_id = $2 AND a.payload->>'phase' = 'awaiting_api_derivation'`, [PROGRESS_ACTION, run.runId]);
    expect(awaited).toBe(3);
  }, 120_000);

  it("remote run: every panel metric equals a count over the stored records; D2 and D3 are labelled verified", async () => {
    const r = await get(`/v1/research/runs/${remoteRun}/progress`);
    expect(r.status).toBe(200);
    const doc = r.json;
    expect(doc.panels.map((p: Panel) => p.id)).toEqual(["overall", "discovery", "acquisition", "scope", "protocol_analysis", "apex", "tools", "validation", "reproduction", "evidence"]);
    const snap = (await owner().query("SELECT id FROM repo_snapshots WHERE workflow_run_id = $1", [remoteRun])).rows[0].id as string;
    // 1. overall
    expect(m(panelOf(doc, "overall"), "stages_succeeded")).toMatchObject({ numerator: await n("SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS n FROM workflow_steps WHERE workflow_run_id = $1", [remoteRun]), denominator: 4, measurable: true, kind: "processing" });
    // 3. acquisition: files stored / manifest rows, and the D2 verification from snapshot_verifications
    const acq = panelOf(doc, "acquisition");
    expect(m(acq, "files_stored")).toMatchObject({ numerator: await n("SELECT count(*)::int AS n FROM repo_snapshot_files WHERE snapshot_id = $1 AND blob_sha256 IS NOT NULL", [snap]), denominator: await n("SELECT count(*)::int AS n FROM repo_snapshot_files WHERE snapshot_id = $1", [snap]), basis: "verified", measurable: true });
    const v = (await owner().query("SELECT files_total, files_matched, skips_verified FROM snapshot_verifications WHERE snapshot_id = $1", [snap])).rows[0];
    expect(m(acq, "d2_files_verified")).toMatchObject({ numerator: v.files_matched + v.skips_verified, denominator: v.files_total, kind: "coverage", basis: "verified", measurable: true });
    expect(acq.activity[0]!.latest_progress).toMatchObject({ phase: "sealed", reported_by: "worker" });
    // 4. scope: 1 in-scope path is missing (a blocker), the rest found; leads in scope from the primary span rule
    const scope = panelOf(doc, "scope");
    expect(m(scope, "scope_paths_found")).toMatchObject({ numerator: sol.length, denominator: sol.length + 1, measurable: true });
    expect(scope.issues.blockers.map((b) => b.text)).toEqual(["in-scope path src/Missing.sol is missing from the snapshot"]);
    const leads = (await owner().query<{ path: string }>(`SELECT (SELECT s.path FROM hypothesis_evidence he JOIN evidence_spans s ON s.id = he.span_id WHERE he.hypothesis_id = h.id ORDER BY (he.role = 'primary') DESC, he.role, s.path, s.line_start LIMIT 1) AS path FROM hypotheses h WHERE h.workflow_run_id = $1`, [remoteRun])).rows;
    expect(leads.length).toBeGreaterThan(0);
    expect(m(scope, "leads_in_scope")).toMatchObject({ numerator: leads.filter((l) => l.path.startsWith("src/")).length, denominator: leads.length, kind: "coverage" });
    // 5. protocol analysis: derived by the API (D3) -> verified; denominator = stored .sol files
    const ana = panelOf(doc, "protocol_analysis");
    expect(m(ana, "sol_files_parsed")).toMatchObject({ denominator: await n("SELECT count(*)::int AS n FROM repo_snapshot_files WHERE snapshot_id = $1 AND blob_sha256 IS NOT NULL AND path LIKE '%.sol'", [snap]), basis: "verified", measurable: true });
    expect(m(ana, "in_scope_sol_parsed").denominator).toBe(sol.length + 1);
    expect(m(ana, "contracts")).toMatchObject({ measurable: false, denominator: null });
    // 8. validation: every hypothesis was evaluated by the API (D1)
    const val = panelOf(doc, "validation");
    const hyps = await n("SELECT count(*)::int AS n FROM hypotheses WHERE workflow_run_id = $1", [remoteRun]);
    expect(m(val, "evaluated_by_api")).toMatchObject({ numerator: await n("SELECT count(DISTINCT e.hypothesis_id)::int AS n FROM hypothesis_evaluations e JOIN evaluation_provenance p ON p.evaluation_id = e.id WHERE p.recorded_by = 'api' AND e.workflow_run_id = $1", [remoteRun]), denominator: hyps, basis: "verified" });
    expect(m(val, "with_independent_validator")).toMatchObject({ numerator: await n("SELECT count(DISTINCT hypothesis_id)::int AS n FROM evaluation_independence x JOIN hypotheses h ON h.id = x.hypothesis_id WHERE h.workflow_run_id = $1 AND x.relation <> 'abstention'", [remoteRun]), denominator: hyps });
    expect(m(val, "not_validated").numerator).toBe(hyps - m(val, "with_independent_validator").numerator!);
    // 10. evidence: dossier built 1/1; every cited span re-verified
    const ev = panelOf(doc, "evidence");
    expect(m(ev, "dossier_built")).toMatchObject({ numerator: 1, denominator: 1, basis: "verified" });
    const spans = await n(`SELECT count(DISTINCT span_id)::int AS n FROM (SELECT span_id FROM hypothesis_evidence he JOIN hypotheses h ON h.id = he.hypothesis_id WHERE h.workflow_run_id = $1 UNION SELECT ee.span_id FROM evaluation_evidence ee JOIN hypothesis_evaluations e ON e.id = ee.evaluation_id WHERE e.workflow_run_id = $1) x`, [remoteRun]);
    expect(m(ev, "spans_reverified")).toMatchObject({ numerator: spans, denominator: spans, measurable: true });
    expect(ev.notes.join(" ")).toMatch(/rebuilt dossier content hash matches the stored one/);
    // confidence is a distribution summing to the number of leads; outcome counts, 0 confirmed
    expect(doc.confidence.distribution.reduce((a: number, d: { count: number }) => a + d.count, 0)).toBe(hyps);
    expect(doc.outcome.counts.find((c: Metric) => c.key === "confirmed")).toMatchObject({ numerator: 0, measurable: false, kind: "outcome" });
    expect(doc.outcome.counts.filter((c: Metric) => c.key !== "confirmed").reduce((a: number, c: Metric) => a + c.numerator!, 0)).toBe(hyps);
  });

  it("unavailable and experimental components are shown as such, never as 0%; unmeasurable metrics carry no denominator", async () => {
    const doc = (await get(`/v1/research/runs/${remoteRun}/progress`)).json;
    const apex = panelOf(doc, "apex");
    expect(apex.state).toBe("experimental"); expect(apex.availability!.state).toBe("experimental"); expect([...apex.processing, ...apex.coverage, ...apex.counts]).toEqual([]);
    const repro = panelOf(doc, "reproduction");
    expect(repro.state).toBe("unavailable"); expect(repro.availability!.reason).toMatch(/forge/);
    expect(m(repro, "reproductions")).toMatchObject({ denominator: null, measurable: false });
    const tools = panelOf(doc, "tools") as Omit<Panel, "capabilities"> & { capabilities: Array<{ id: string; state: string; reason: string }> };
    expect(tools.capabilities.find((c) => c.id === "slither")).toMatchObject({ state: "unavailable" });
    expect(tools.capabilities.find((c) => c.id === "slither")!.reason).toMatch(/AGENTSMITH_SLITHER_BIN/);
    // every refusal total equals the sum of its listed codes (a refusal that cites no step of the run still names its code)
    for (const p of doc.panels as any[]) expect(Object.values(p.issues.refusals.by_code as Record<string, number>).reduce((a, n) => a + n, 0), p.id).toBe(p.issues.refusals.total);
    for (const p of doc.panels as Panel[]) for (const x of [...p.processing, ...p.coverage, ...p.counts]) {
      if (x.measurable) { expect(x.denominator, `${p.id}.${x.key}`).toBeGreaterThan(0); expect(x.numerator!).toBeLessThanOrEqual(x.denominator!); }
      expect(["processing", "coverage", "confidence", "outcome"]).toContain(x.kind);
      expect(typeof x.source).toBe("string"); expect(x.source.length).toBeGreaterThan(3);
    }
  });

  it("direct mode: the worker's progress is stored through its own lease; D2 is not measurable; numbers match the records", async () => {
    const fx = fixture("ops-direct");
    const run = await createRepositoryResearchRun(owner(), { repository: "acme/ops-direct", ref: "main" }, "operator", { structuralAnalysis: true, bountyScope: scopeOf("sherlock:9002") });
    directRun = run.runId;
    const saved = process.env.STRUCTURAL_ANALYSIS_ENABLED; process.env.STRUCTURAL_ANALYSIS_ENABLED = "true";
    const ac = new AbortController();
    const loop = runIntakeWorker(db.pool, "ops-direct-worker", ac.signal, { onlyRunId: run.runId, pollMs: 50, source: new FakeSource(fx) });
    try {
      for (let i = 0; i < 1200; i++) {
        const st = (await owner().query("SELECT status FROM workflow_runs WHERE id = $1", [run.runId])).rows[0].status;
        if (st === "succeeded" || st === "failed") break; await new Promise((r) => setTimeout(r, 50));
      }
    } finally { ac.abort(); await loop.catch(() => undefined); if (saved === undefined) delete process.env.STRUCTURAL_ANALYSIS_ENABLED; else process.env.STRUCTURAL_ANALYSIS_ENABLED = saved; }
    expect((await owner().query("SELECT status FROM workflow_runs WHERE id = $1", [run.runId])).rows[0].status).toBe("succeeded");
    const stored = (await owner().query<{ step_key: string; phase: string; via: string; actor: string }>(`SELECT s.step_key, a.payload->>'phase' AS phase, a.payload->>'via' AS via, a.actor FROM audit_events a JOIN workflow_steps s ON s.id::text = a.entity_id WHERE a.action = $1 AND s.workflow_run_id = $2 ORDER BY a.id`, [PROGRESS_ACTION, run.runId])).rows;
    expect(new Set(stored.map((x) => x.step_key))).toEqual(new Set(["acquire_repository", "analyze_structure", "challenge_leads", "build_dossier"]));
    expect(stored.every((x) => x.via === "direct_worker" && x.actor === "ops-direct-worker")).toBe(true);
    expect(stored.filter((x) => x.step_key === "acquire_repository").map((x) => x.phase)).toEqual(expect.arrayContaining(["resolved_commit", "planned", "writing_manifest", "sealed"]));

    const doc = (await get(`/v1/research/runs/${run.runId}/progress`)).json;
    const acq = panelOf(doc, "acquisition");
    expect(m(acq, "d2_files_verified")).toMatchObject({ numerator: null, denominator: null, measurable: false });
    expect(m(acq, "d2_files_verified").note).toMatch(/not verified by the API against GitHub/);
    expect(m(panelOf(doc, "protocol_analysis"), "sol_files_parsed").basis).toBe("worker_reported"); // the direct worker wrote this output
    const val = panelOf(doc, "validation");
    expect(m(val, "evaluated_by_api").numerator).toBe(0);
    expect(m(val, "evaluated_any")).toMatchObject({ numerator: await n("SELECT count(DISTINCT hypothesis_id)::int AS n FROM hypothesis_evaluations WHERE workflow_run_id = $1", [run.runId]), basis: "worker_reported" });
    expect(m(panelOf(doc, "scope"), "scope_paths_found")).toMatchObject({ numerator: sol.length, denominator: sol.length });
    expect(panelOf(doc, "scope").issues.blockers).toEqual([]);

    // a progress report for a step this worker no longer leases is not stored (the step has succeeded)
    const { WorkflowWorker } = await import("../worker.js");
    const step = (await owner().query("SELECT id FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = 'acquire_repository'", [run.runId])).rows[0].id;
    expect(await new WorkflowWorker(db.pool, "ops-direct-worker").reportProgress(step, { phase: "late", done: 0, total: null, unit: "files" })).toEqual({ recorded: false, reason: "lease_not_held" });
  }, 120_000);

  it("a running step shows its live lease and the latest worker-reported progress; an expired lease is never 'running'", async () => {
    const run = await createRepositoryResearchRun(owner(), { repository: "acme/ops-live", ref: "main" }, "operator", { structuralAnalysis: true });
    const { WorkflowWorker } = await import("../worker.js");
    const w = new WorkflowWorker(db.pool, "ops-live-worker");
    const step = await w.claimNext(["acquire_repository"], run.runId);
    await w.reportProgress(step!.id, { phase: "writing_manifest", done: 120, total: 431, unit: "manifest_rows" });
    let doc = (await get(`/v1/research/runs/${run.runId}/progress`)).json;
    let acq = panelOf(doc, "acquisition");
    expect(acq.state).toBe("running"); expect(acq.activity[0]).toMatchObject({ running_live: true, lease_owner: "ops-live-worker" });
    expect(m(acq, "progress")).toMatchObject({ numerator: 120, denominator: 431, basis: "worker_reported", measurable: true, kind: "processing" });
    expect(panelOf(doc, "overall").state).toBe("running");
    await owner().query("UPDATE workflow_steps SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [step!.id]);
    doc = (await get(`/v1/research/runs/${run.runId}/progress`)).json; acq = panelOf(doc, "acquisition");
    expect(acq.state).toBe("stalled"); expect(panelOf(doc, "overall").state).toBe("stalled");
    expect(acq.issues.expired_leases).toHaveLength(1);
    // before the plan: the total is unknown, so there is no denominator
    const run2 = await createRepositoryResearchRun(owner(), { repository: "acme/ops-live2", ref: "main" }, "operator");
    const s2 = await w.claimNext(["acquire_repository"], run2.runId);
    await w.reportProgress(s2!.id, { phase: "resolved_commit", done: 0, total: null, unit: "files" });
    const p2 = panelOf((await get(`/v1/research/runs/${run2.runId}/progress`)).json, "acquisition");
    expect(m(p2, "files_planned")).toMatchObject({ denominator: null, measurable: false });
    expect(panelOf((await get(`/v1/research/runs/${run2.runId}/progress`)).json, "scope").state).toBe("not_in_run");
  });

  it("the timeline contains only stored events, newest first, with expandable payloads; decisions say 0010 is absent", async () => {
    const t = (await get(`/v1/research/timeline?run=${remoteRun}&limit=200`)).json;
    const audit = await n(`SELECT count(*)::int AS n FROM audit_events a LEFT JOIN workflow_steps s ON a.entity_type = 'workflow_step' AND s.id::text = a.entity_id WHERE (a.entity_type = 'workflow_run' AND a.entity_id = $1::text) OR s.workflow_run_id = $1::uuid`, [remoteRun]);
    const hev = await n("SELECT count(*)::int AS n FROM hypothesis_events WHERE workflow_run_id = $1", [remoteRun]);
    let items = t.items; let next = t.next;
    while (next) { const more = (await get(`/v1/research/timeline?run=${remoteRun}&limit=200&before=${encodeURIComponent(next.before)}&before_id=${encodeURIComponent(next.before_id)}`)).json; items = [...items, ...more.items]; next = more.next; }
    expect(items.length).toBe(audit + hev);
    for (const it of items) {
      const [src, idText] = String(it.id).split(":");
      const found = src === "audit" ? await n("SELECT count(*)::int AS n FROM audit_events WHERE id = $1 AND action = $2", [Number(idText), it.action])
        : await n("SELECT count(*)::int AS n FROM hypothesis_events WHERE seq = $1 AND workflow_run_id = $2", [Number(idText), remoteRun]);
      expect(found, it.id).toBe(1);
    }
    expect(new Set(items.map((i: { category: string }) => i.category))).toEqual(new Set(["run", "step_lifecycle", "worker_api", "worker_token", "progress", "hypothesis"]));
    const times = items.map((i: { at: string }) => Date.parse(i.at)); expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(items.find((i: { category: string }) => i.category === "progress").payload).toMatchObject({ reported_by: "worker" });
    expect(items.find((i: { category: string; payload: any }) => i.category === "hypothesis" && i.payload.evaluation).payload.evaluation).toHaveProperty("relation");
    expect(t.decisions).toMatchObject({ available: false }); expect(t.decisions.note).toMatch(/0010/);
    expect((await get(`/v1/research/timeline?run=${randomUUID()}`)).json.items).toEqual([]);
    expect((await get(`/v1/research/timeline?run=not-a-uuid`)).status).toBe(400);
  });

  it("the system view derives every state from records and probes: nothing is hardcoded green", async () => {
    const s = (await get("/v1/engine/components")).json;
    const by = (id: string) => s.components.find((c: { id: string }) => c.id === id);
    expect(by("stage:analyze_structure")).toMatchObject({ state: "operational" }); // runs above succeeded
    expect(by("worker_api")).toMatchObject({ state: "operational" });
    expect(by("github_verifier")).toMatchObject({ state: "operational" });
    expect(by("apex")).toMatchObject({ state: "experimental" });
    expect(by("capability:slither")).toMatchObject({ state: "unavailable" });
    expect(by("capability:foundry-forge")).toMatchObject({ state: "unavailable" });
    expect(by("engine_loop")).toMatchObject({ state: "unavailable" });
    for (const c of s.components) { expect(c.evidence.length, c.id).toBeGreaterThan(0); for (const e of c.evidence) expect(e.detail.length).toBeGreaterThan(0); }
    // a fresh collector source that failed is blocked, with its recorded error
    await owner().query(`INSERT INTO bounty_sources (source_key, kind, display_name, authority, collection_method, enabled, access_status) VALUES ('hackenproof-test', 'official_platform', 'HackenProof (test)', 3, 'html', true, 'permitted')`);
    const runRow = (await owner().query(`INSERT INTO bounty_collection_runs (trigger, started_by, status, finished_at) VALUES ('test', 'test', 'partial', now()) RETURNING id`)).rows[0].id;
    await owner().query(`INSERT INTO bounty_source_checks (run_id, source_key, outcome, http_status, error, retry_after, finished_at) VALUES ($1, 'hackenproof-test', 'failed', 403, 'blocked_technical: HTTP 403 from https://hackenproof.com/programs?token=${"z".repeat(40)}', now() + interval '1 hour', now())`, [runRow]);
    const s2 = (await get("/v1/engine/components")).json;
    const hp = s2.components.find((c: { id: string }) => c.id === "source:hackenproof-test");
    expect(hp.state).toBe("blocked"); expect(JSON.stringify(hp)).toContain("HTTP 403"); expect(JSON.stringify(hp)).not.toContain("z".repeat(40));
    const disc = panelOf((await get(`/v1/research/runs/${remoteRun}/progress`)).json, "discovery");
    const enabled = await n("SELECT count(*)::int AS n FROM bounty_sources WHERE enabled", []);
    expect(m(disc, "sources_checked")).toMatchObject({ numerator: 0, denominator: enabled, measurable: true }); // the latest collection checked none successfully
    expect(disc.issues.errors[0]!.message).toMatch(/hackenproof-test.*HTTP 403.*next due/);
  });

  it("requires the operator token, and no token or secret appears in any response", async () => {
    for (const p of [`/v1/research/runs/${remoteRun}/progress`, `/v1/research/timeline?run=${remoteRun}`, "/v1/engine/components"]) expect((await get(p, null)).status).toBe(401);
    // a secret written into a stored record (a worker's failure reason) is redacted on the way out
    const leaked = secrets[1]!;
    const step = (await owner().query("SELECT id FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = 'acquire_repository'", [remoteRun])).rows[0].id;
    await owner().query(`INSERT INTO audit_events (actor, action, entity_type, entity_id, payload, reason) VALUES ('test', 'workflow_step.failed', 'workflow_step', $1, $2::jsonb, $3)`,
      [step, JSON.stringify({ attempt: 9, retryable: true, reason: `upstream said Bearer ${secrets[1]} / ${GH_TOKEN}`, token: secrets[0] }), `token ${secrets[0]}`]);
    for (const p of [`/v1/research/runs/${remoteRun}/progress`, `/v1/research/runs/${directRun}/progress`, `/v1/research/timeline?run=${remoteRun}&limit=200`, "/v1/research/timeline?limit=200", "/v1/engine/components"]) expect((await get(p)).status).toBe(200);
    const all = bodies.join("\n");
    for (const s of secrets) expect(all.includes(s), `a secret of length ${s.length} appeared in a response`).toBe(false);
    expect(all).not.toContain(leaked); expect(all).not.toContain(OPERATOR);
  });
});
