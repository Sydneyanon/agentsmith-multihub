import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACQUIRE_STEP_KEY, createRepositoryResearchRun, processAcquireRepositoryStep } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { GitHubSource } from "../acquisition/github-source.js";
import type { GitFixture } from "../acquisition/testing/git-fixture.js";
import { startLoopbackGitHub, type LoopbackGitHub } from "../acquisition/testing/loopback-github.js";
import { ANALYSIS_STEP_KEYS } from "../analysis/solidity/keys.js";
import { buildDossier } from "../analysis/solidity/pipeline.js";
import { dispatchAnalysisStep, type AnalysisStepContext } from "../analysis/solidity/step.js";
import { APEX_SHADOW_ACTION, reportSha256 } from "../apex/shadow-record.js";
import { computeApexShadow } from "../apex/shadow.js";
import { ApexShadowRefused, APEX_SHADOW_LABEL, APEX_SHADOW_STEP_KEY, APEX_SHADOW_TARGET as T } from "../apex/shadow-target.js";
import { usxLikeGitFixture, usxLikeSources, usxScope } from "../apex/testing/usx-like.js";
import { buildApp } from "../app.js";
import { AuthFailureLimiter } from "../auth.js";
import { promoteEligibleProgrammes } from "../bounties/promote.js";
import type { Metric, Panel } from "../operations-api.js";
import { IndependenceError, ResearchStore } from "../research-state.js";
import { WorkflowWorker } from "../worker.js";
import { WorkerApiClient } from "../worker-api-client.js";
import { OPERATIONS } from "../worker-api.js";
import { executeRemoteStep, remoteStepKeys } from "../worker-remote.js";
import { mintWorkerToken } from "../worker-tokens.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";
import { ResearchFixture } from "./research-helpers.js";

/**
 * The APEX shadow stage end to end, on disposable databases, with the SELF-AUTHORED USX-like snapshot served locally as
 * scroll-tech/usx-contracts at the approved commit (nothing is fetched): direct (db) mode and remote (api) mode, the refusals, the
 * isolation of a failing stage, the one worker-API operation, and the Operations endpoint. Every comparison of evidence is byte-for-byte
 * over the evidence tables of the whole database, before and after the shadow step.
 */
const SWITCHES = { STRUCTURAL_ANALYSIS_ENABLED: "true" };
const OPERATOR = randomBytes(36).toString("base64url");
const GH_TOKEN = "github_pat_" + "11ABCDEFG0" + "z".repeat(72);
const APPROVER = "owner@agentsmith (approval 2026-11-28)";
const field = (value: unknown) => ({ value, source: "sherlock", authority: 10, observedAt: "2026-11-28T00:00:00Z", conflicts: [] });
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** for comparisons ACROSS databases: ids differ, and so do the hashes of blobs that embed them (evaluation provenance) */
const norm = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "output_blob_sha256" ? "<blob>" : k === "finding_payloads" && x && typeof x === "object" ? `${Object.keys(x).length} payloads` : x)).replace(UUID, "<id>"));
const EVIDENCE_TABLES = ["hypotheses", "hypothesis_evidence", "evidence_spans", "hypothesis_evaluations", "evaluation_evidence", "evaluation_provenance", "hypothesis_evaluation_keys", "hypothesis_reviews", "hypothesis_events", "research_blobs", "repo_snapshots", "repo_snapshot_files", "snapshot_verifications"];

/** Every row of every table the evidence path reads, as stored (blobs by hash and size). */
async function evidenceState(pool: pg.Pool): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of EVIDENCE_TABLES) {
    const exists = (await pool.query("SELECT to_regclass($1) AS r", [`public.${t}`])).rows[0].r;
    if (!exists) continue;
    const sel = t === "research_blobs" ? "SELECT content_sha256, size_bytes FROM research_blobs" : `SELECT to_jsonb(x) AS j FROM ${t} x`;
    out[t] = (await pool.query(`${sel} ORDER BY 1`)).rows.map((r) => (t === "research_blobs" ? r : r.j)).map((r) => JSON.stringify(r)).sort();
  }
  return out;
}
const nonShadowSteps = async (pool: pg.Pool, runId: string) => (await pool.query(`SELECT step_key, status, attempt, output, error FROM workflow_steps WHERE workflow_run_id = $1 AND step_key <> $2 ORDER BY sequence`, [runId, APEX_SHADOW_STEP_KEY])).rows;

async function seedUsxProgramme(owner: pg.Pool): Promise<void> {
  const resolved = { projectName: field("USX"), officialUrl: field("https://audits.sherlock.xyz/bug-bounties/273"), maxReward: field(100_000), chains: field(["Scroll"]), technologies: field(["Solidity"]) };
  const prog = (await owner.query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ($1, 'USX', 'usx', $2::jsonb, 'active', 'official_confirmed') RETURNING id`, [T.programme, JSON.stringify(resolved)])).rows[0].id;
  await owner.query(`INSERT INTO bounty_repository_mappings (bounty_program_id, repository, source_url, evidence, discovery_method, verification_status, confidence, default_branch, repository_github_id, last_seen_at)
    VALUES ($1, $2, 'https://audits.sherlock.xyz/bug-bounties/273', 'https://github.com/scroll-tech/usx-contracts', 'official_page', 'official_documentation', 'high', 'main', 1057730048, now())`, [prog, T.repository]);
}
const promoteUsx = (pool: pg.Pool, apex: boolean, scope = usxScope()) => promoteEligibleProgrammes(pool, { structuralAnalysis: true, maxNewRuns: 1, target: { programme: T.programme, repository: T.repository, commit: T.commit, bountyScope: scope, ...(apex ? { apexShadow: { approvedBy: APPROVER } } : {}) } });

/** Drives the run's steps on the direct worker in order; `until` stops before that step key. */
async function driveDirect(db: TestDatabase, runId: string, fx: GitFixture, opts: { until?: string; shadow?: AnalysisStepContext["shadow"] } = {}): Promise<void> {
  const worker = new WorkflowWorker(db.pool, "apex-direct-worker");
  for (;;) {
    const next = (await db.ownerPool.query(`SELECT step_key FROM workflow_steps WHERE workflow_run_id = $1 AND status = 'queued' ORDER BY sequence LIMIT 1`, [runId])).rows[0]?.step_key as string | undefined;
    if (!next || next === opts.until) return;
    const step = await worker.claimNext([next], runId); if (!step) throw new Error(`could not claim ${next}`);
    if (step.step_key === ACQUIRE_STEP_KEY) await processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "apex-direct-worker", source: new FakeSource(fx) }, step);
    else if (!(await dispatchAnalysisStep({ pool: db.pool, worker, workerId: "apex-direct-worker", ...(opts.shadow ? { shadow: opts.shadow } : {}) }, step))) throw new Error(`no handler for ${step.step_key}`);
  }
}

/** A run inserted as a compromised or buggy creator could (bypassing the creation check): acquisition, then the shadow step. */
async function rawShadowRun(owner: pg.Pool, input: Record<string, unknown>): Promise<string> {
  const run = (await owner.query(`INSERT INTO workflow_runs (workflow_type, status, input, created_by) VALUES ('repository_research', 'queued', $1::jsonb, 'test') RETURNING id`, [JSON.stringify(input)])).rows[0].id as string;
  await owner.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, 'acquire_repository', 0, 'repository_acquirer', $2::jsonb)`, [run, JSON.stringify({ repository: input["value"], ref: input["ref"] })]);
  await owner.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 1, 'shadow_explorer', $3::jsonb)`, [run, APEX_SHADOW_STEP_KEY,
    JSON.stringify({ scope: "repository_research", mode: "measurement_only", repository: input["value"], ref: input["ref"], approval: input["apex_shadow"], bounty_scope: input["bounty_scope"] })]);
  return run;
}
const usxInput = (over: Record<string, unknown> = {}) => ({ kind: "repository", value: T.repository, source: "user", ref: T.commit, execution_mode: "passive_only", authorization_status: "unverified", bounty_scope: usxScope(),
  apex_shadow: { approved_by: APPROVER, approved_commit: T.commit, approved_at: "2026-11-28T00:00:00.000Z", basis: "test" }, ...over });
const shadowRecords = async (pool: pg.Pool, runId: string) => (await pool.query(`SELECT a.id::text AS id, a.actor, a.payload FROM audit_events a JOIN workflow_steps s ON s.id::text = a.entity_id WHERE s.workflow_run_id = $1 AND a.action = $2 ORDER BY a.id`, [runId, APEX_SHADOW_ACTION])).rows;
const runStatus = async (pool: pg.Pool, runId: string) => (await pool.query("SELECT status FROM workflow_runs WHERE id = $1", [runId])).rows[0].status as string;
const shadowStep = async (pool: pg.Pool, runId: string) => (await pool.query("SELECT id, status, sequence, output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [runId, APEX_SHADOW_STEP_KEY])).rows[0];

describe.skipIf(skipIntegration)("APEX shadow, direct (db) mode: never evidence, off by default, refusals", () => {
  let on: TestDatabase; let off: TestDatabase; let fx: GitFixture; const fixtures: GitFixture[] = [];
  let onRun = ""; let offRun = "";
  beforeAll(async () => {
    [on, off] = await Promise.all([migratedTestDatabase(), migratedTestDatabase()]);
    fx = usxLikeGitFixture(); fixtures.push(fx);
    await seedUsxProgramme(on.ownerPool); await seedUsxProgramme(off.ownerPool);
  }, 120_000);
  afterAll(async () => { for (const f of fixtures) f.cleanup(); await on?.drop(); await off?.drop(); });

  it("the explicit flag creates the shadow step LAST, records who approved it and the commit; without it nothing changes", async () => {
    const r = await promoteUsx(on.pool, true);
    expect(r.actions[0]).toMatchObject({ action: "created", ref: T.commit });
    onRun = r.actions[0]!.workflowRunId!;
    const input = (await on.ownerPool.query("SELECT input FROM workflow_runs WHERE id = $1", [onRun])).rows[0].input;
    expect(input.apex_shadow).toMatchObject({ approved_by: APPROVER, approved_commit: T.commit });
    const steps = (await on.ownerPool.query("SELECT step_key, sequence, role FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [onRun])).rows;
    expect(steps.map((s) => s.step_key)).toEqual(["acquire_repository", "analyze_structure", "challenge_leads", "build_dossier", APEX_SHADOW_STEP_KEY]);
    expect((await on.ownerPool.query("SELECT payload FROM audit_events WHERE entity_id = $1 AND action = 'repository_research.apex_shadow_requested'", [onRun])).rows[0].payload).toMatchObject({ approved_by: APPROVER, approved_commit: T.commit, programme: T.programme });

    const o = await promoteUsx(off.pool, false);
    offRun = o.actions[0]!.workflowRunId!;
    const offInput = (await off.ownerPool.query("SELECT input FROM workflow_runs WHERE id = $1", [offRun])).rows[0].input;
    expect(offInput).not.toHaveProperty("apex_shadow");
    expect({ ...input, apex_shadow: undefined }).toEqual({ ...offInput, apex_shadow: undefined }); // the run input is otherwise identical
    expect((await off.ownerPool.query("SELECT step_key FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [offRun])).rows.map((s) => s.step_key)).toEqual(["acquire_repository", "analyze_structure", "challenge_leads", "build_dossier"]);
  }, 60_000);

  it("the shadow step changes NOTHING the evidence path reads; the dossier, the leads and the evaluations are byte-identical before and after", async () => {
    await driveDirect(on, onRun, fx, { until: APEX_SHADOW_STEP_KEY });
    const snapshotId = (await on.ownerPool.query("SELECT id FROM repo_snapshots WHERE workflow_run_id = $1", [onRun])).rows[0].id;
    const store = new ResearchStore(on.pool);
    const before = { evidence: await evidenceState(on.ownerPool), steps: await nonShadowSteps(on.ownerPool, onRun), dossier: await buildDossier(on.pool, store, snapshotId) };
    expect(before.dossier.entries.length).toBeGreaterThan(0);
    expect(await runStatus(on.ownerPool, onRun)).toBe("running");
    await driveDirect(on, onRun, fx);
    expect(await runStatus(on.ownerPool, onRun)).toBe("succeeded");
    const after = { evidence: await evidenceState(on.ownerPool), steps: await nonShadowSteps(on.ownerPool, onRun), dossier: await buildDossier(on.pool, store, snapshotId) };
    expect(after.evidence).toEqual(before.evidence);
    expect(after.steps).toEqual(before.steps);
    expect(after.dossier).toEqual(before.dossier);
    expect(JSON.stringify(after.dossier)).not.toMatch(/apex/i);
    // the stored dossier step's own hash still matches a rebuild: nothing the dossier reads changed
    expect(after.steps.find((s) => s.step_key === "build_dossier")!.output.content_sha256).toBe(after.dossier.content_sha256);
  }, 300_000);

  it("APEX output is nowhere among the leads, evaluations, reviews or outcomes: APEX cannot create or confirm anything", async () => {
    const q = async (sql: string) => Number((await on.ownerPool.query(sql)).rows[0].n);
    expect(await q("SELECT count(*)::int AS n FROM hypotheses WHERE generator_id ILIKE '%apex%' OR family ILIKE '%apex%' OR claim ILIKE '%apex%'")).toBe(0);
    expect(await q("SELECT count(*)::int AS n FROM hypothesis_evaluations WHERE evaluator_id ILIKE '%apex%' OR rationale ILIKE '%apex%'")).toBe(0);
    expect(await q("SELECT count(*)::int AS n FROM hypothesis_reviews WHERE reviewer_id ILIKE '%apex%'")).toBe(0);
    expect(await q("SELECT count(*)::int AS n FROM hypothesis_events WHERE actor_id ILIKE '%apex%'")).toBe(0);
    // the record exists, as an audit event only, labelled
    const recs = await shadowRecords(on.ownerPool, onRun);
    expect(recs).toHaveLength(1);
    const p = recs[0]!.payload;
    expect(p).toMatchObject({ status: "completed", label: APEX_SHADOW_LABEL, reported_by: "worker", via: "direct_worker", overlaps: { derived_by: "recorder" } });
    expect(p.result.would_be_hypotheses.length).toBeGreaterThan(0);
    for (const h of p.result.would_be_hypotheses) expect(h.label).toBe("APEX-generated, unvalidated");
    expect(p.provenance).toMatchObject({ snapshot_id: expect.any(String), commit_sha: T.commit, manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), approved_by: APPROVER, approved_commit: T.commit, worker: { mode: "direct" } });
    expect(p.provenance.input_files.map((f: { path: string }) => f.path).sort()).toEqual([...T.inScopePaths].sort());
    expect(p.recorder.checked).toContain("input files in scope with the snapshot's digests");
    // the overlaps are with the specialists' leads of THIS run, by the recorder
    expect(p.overlaps.leads_considered).toBe(Number((await on.ownerPool.query("SELECT count(*)::int AS n FROM hypotheses WHERE workflow_run_id = $1", [onRun])).rows[0].n));
    const st = await shadowStep(on.ownerPool, onRun);
    expect(st.status).toBe("succeeded");
    expect(st.output).toMatchObject({ status: "apex_shadow_recorded", label: APEX_SHADOW_LABEL, reported_by: "worker", measurement_only: true, report_audit_event_id: recs[0]!.id, report_sha256: p.report_sha256 });
    expect(st.output.counts.would_be_hypotheses_unvalidated).toBe(p.result.would_be_hypotheses.length);
  });

  it("IndependenceError: were an APEX claim ever stored, APEX could not evaluate it, and its family never counts as independent", async () => {
    const f = new ResearchFixture(on);
    const s = await f.sealedSnapshot(); const sp = await f.span(s, 5);
    const h = await f.hypothesis(s, [sp], { generator: { kind: "deterministic_rule", id: "apex-state-explorer", version: "0-prototype" } });
    await expect(f.store.recordEvaluation(s.lease, { hypothesisId: h, evaluatorId: "apex-state-explorer", evaluatorVersion: "0-prototype", outcome: "supports", rationale: "self", spanIds: [sp], inputSha256: "a".repeat(64) })).rejects.toBeInstanceOf(IndependenceError);
    expect(Number((await on.ownerPool.query("SELECT count(*)::int AS n FROM hypothesis_evaluations WHERE hypothesis_id = $1", [h])).rows[0].n)).toBe(0);
    // the database rule (0016) says the same for any writer: an unlisted generator has no family, so no evaluation of it is cross-family
    expect((await on.ownerPool.query("SELECT count(*)::int AS n FROM analysis_identities WHERE actor_id ILIKE '%apex%'")).rows[0].n).toBe(0);
  });

  it("shadow OFF (the default): APEX never runs, and the dossier, leads, evaluations and step outputs equal the shadow-ON run's", async () => {
    await driveDirect(off, offRun, fx);
    expect(await runStatus(off.ownerPool, offRun)).toBe("succeeded");
    expect(await shadowRecords(off.ownerPool, offRun)).toEqual([]);
    expect((await off.ownerPool.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'apex%' OR action LIKE '%apex_shadow%'")).rows[0].n).toBe(0);
    // with the switches on, the worker has nothing left to claim in this run
    expect(await new WorkflowWorker(off.pool, "idle").claimNext(undefined, offRun)).toBeNull();
    const dossierOf = async (db: TestDatabase, runId: string) => { const sid = (await db.ownerPool.query("SELECT id FROM repo_snapshots WHERE workflow_run_id = $1", [runId])).rows[0].id; return buildDossier(db.pool, new ResearchStore(db.pool), sid); };
    const [dOn, dOff] = [await dossierOf(on, onRun), await dossierOf(off, offRun)];
    // the dossier's eligible-finding and confirmation counts are identical, and so is everything else (ids aside: separate databases)
    expect(dOn.bounty_scope).toEqual(dOff.bounty_scope);
    expect(dOn.summary).toEqual(dOff.summary);
    expect(dOn.entries.map((e) => [e.assessment.verdict, e.corroboration, e.scope_status])).toEqual(dOff.entries.map((e) => [e.assessment.verdict, e.corroboration, e.scope_status]));
    expect(norm({ ...dOn, content_sha256: null })).toEqual(norm({ ...dOff, content_sha256: null }));
    const evals = async (db: TestDatabase) => (await db.ownerPool.query(`SELECT h.claim, e.evaluator_id, e.evaluator_version, e.outcome, e.rationale, e.input_sha256 FROM hypothesis_evaluations e JOIN hypotheses h ON h.id = e.hypothesis_id ORDER BY 1, 2, 3, 6`)).rows;
    expect(await evals(on)).toEqual(await evals(off));
    expect(norm((await nonShadowSteps(on.ownerPool, onRun)).map((s) => ({ ...s, output: { ...s.output, content_sha256: undefined } })))).toEqual(norm((await nonShadowSteps(off.ownerPool, offRun)).map((s) => ({ ...s, output: { ...s.output, content_sha256: undefined } }))));
  }, 300_000);

  it("the flag on any other run is refused at creation, and nothing is created", async () => {
    const before = Number((await off.ownerPool.query("SELECT count(*)::int AS n FROM workflow_runs")).rows[0].n);
    await expect(createRepositoryResearchRun(off.pool, { repository: "acme/vault", ref: T.commit }, "op", { structuralAnalysis: true, bountyScope: usxScope(), apexShadow: { approvedBy: APPROVER } })).rejects.toBeInstanceOf(ApexShadowRefused);
    await expect(createRepositoryResearchRun(off.pool, { repository: T.repository, ref: "main" }, "op", { structuralAnalysis: true, bountyScope: usxScope(), apexShadow: { approvedBy: APPROVER } })).rejects.toThrow(/not_the_approved_commit/);
    await expect(createRepositoryResearchRun(off.pool, { repository: T.repository, ref: T.commit }, "op", { structuralAnalysis: true, bountyScope: usxScope({ in_scope_paths: T.inScopePaths.slice(0, 19) }), apexShadow: { approvedBy: APPROVER } })).rejects.toThrow(/scope_paths_differ/);
    await expect(createRepositoryResearchRun(off.pool, { repository: T.repository, ref: T.commit }, "op", { structuralAnalysis: false, bountyScope: usxScope(), apexShadow: { approvedBy: APPROVER } })).rejects.toThrow(/structural_analysis_required/);
    await expect(promoteEligibleProgrammes(off.pool, { structuralAnalysis: true, target: { programme: T.programme, repository: T.repository, commit: "1".repeat(40), bountyScope: usxScope(), apexShadow: { approvedBy: APPROVER } } })).rejects.toThrow(/not_the_approved_commit/);
    await expect(promoteUsx(off.pool, true, usxScope({ in_scope_paths: [...T.inScopePaths, "src/cloak/USXRebalancer.sol"] }))).rejects.toThrow(/scope_paths_differ/);
    // the USX target itself, but already linked to the shadow-OFF run: a shadow run must be new, never a reused or linked one
    await expect(promoteUsx(off.pool, true)).rejects.toThrow(/must be newly created/);
    expect(Number((await off.ownerPool.query("SELECT count(*)::int AS n FROM workflow_runs")).rows[0].n)).toBe(before);
  });

  it("at run time, a run whose commit or scope is not the approved one is REFUSED with a recorded reason, and the run still succeeds", async () => {
    const other = usxLikeGitFixture({ commit: "1".repeat(40) }); fixtures.push(other);
    const wrongCommit = await rawShadowRun(on.ownerPool, usxInput({ ref: "1".repeat(40) }));
    const wrongScope = await rawShadowRun(on.ownerPool, usxInput({ bounty_scope: usxScope({ in_scope_paths: T.inScopePaths.slice(1) }) }));
    const noApproval = await rawShadowRun(on.ownerPool, usxInput({ apex_shadow: undefined }));
    const before = await evidenceState(on.ownerPool);
    await driveDirect(on, wrongCommit, other); await driveDirect(on, wrongScope, fx); await driveDirect(on, noApproval, fx);
    for (const [run, code] of [[wrongCommit, "not_the_approved_commit"], [wrongScope, "scope_paths_differ"], [noApproval, "not_requested"]] as const) {
      expect(await runStatus(on.ownerPool, run), code).toBe("succeeded");
      const recs = await shadowRecords(on.ownerPool, run);
      expect(recs.map((r) => [r.payload.status, r.payload.refusal?.code, r.payload.result]), code).toEqual([["refused", code, null]]);
      expect((await shadowStep(on.ownerPool, run)).output).toMatchObject({ status: "apex_shadow_refused", refusal: { code } });
    }
    // nothing but the acquisitions' own records changed (two reused the sealed snapshot; one stored a new one)
    const after = await evidenceState(on.ownerPool);
    for (const t of ["hypotheses", "hypothesis_evaluations", "hypothesis_reviews", "hypothesis_events", "evidence_spans"]) expect(after[t], t).toEqual(before[t]);
  }, 300_000);
});

describe.skipIf(skipIntegration)("APEX shadow, direct (db) mode: a failing stage cannot fail or corrupt the run", () => {
  let db: TestDatabase; let fx: GitFixture;
  beforeAll(async () => { db = await migratedTestDatabase(); fx = usxLikeGitFixture(); await seedUsxProgramme(db.ownerPool); }, 120_000);
  afterAll(async () => { fx?.cleanup(); await db?.drop(); });

  it("a throwing APEX, a wall-time kill and a heap kill of the bounded child are recorded shadow failures; the run succeeds; its outputs are unchanged", async () => {
    const r = await promoteUsx(db.pool, true); const runId = r.actions[0]!.workflowRunId!;
    await driveDirect(db, runId, fx, { until: APEX_SHADOW_STEP_KEY });
    const before = { evidence: await evidenceState(db.ownerPool), steps: await nonShadowSteps(db.ownerPool, runId) };
    await driveDirect(db, runId, fx, { shadow: { compute: async () => { throw new Error("APEX crashed (injected)"); } } });
    // two more approved runs of the same snapshot (acquisition + shadow only), one killed on wall time, one on heap
    const wall = await rawShadowRun(db.ownerPool, usxInput()); const heap = await rawShadowRun(db.ownerPool, usxInput());
    await driveDirect(db, wall, fx, { shadow: { computeLimits: { wallMs: 50 } } });
    await driveDirect(db, heap, fx, { shadow: { computeLimits: { maxHeapMb: 16 } } });
    for (const [run, codes] of [[runId, ["error"]], [wall, ["wall_limit"]], [heap, ["memory_limit", "compute_failed"]]] as const) {
      expect(await runStatus(db.ownerPool, run)).toBe("succeeded");
      const recs = await shadowRecords(db.ownerPool, run);
      expect(recs).toHaveLength(1); expect(recs[0]!.payload.status).toBe("failed"); expect(codes as readonly string[]).toContain(recs[0]!.payload.failure.code);
      expect((await shadowStep(db.ownerPool, run))).toMatchObject({ status: "succeeded", output: { status: "apex_shadow_failed", failure: { code: recs[0]!.payload.failure.code } } });
    }
    expect((await shadowRecords(db.ownerPool, runId))[0]!.payload.failure.message).toBe("APEX crashed (injected)");
    const after = { evidence: await evidenceState(db.ownerPool), steps: await nonShadowSteps(db.ownerPool, runId) };
    expect(after.steps).toEqual(before.steps);
    for (const t of EVIDENCE_TABLES.filter((x) => !["repo_snapshots", "repo_snapshot_files", "research_blobs"].includes(x))) expect(after.evidence[t], t).toEqual(before.evidence[t]);
  }, 300_000);
});

describe.skipIf(skipIntegration)("APEX shadow, remote (api) mode: one allow-listed operation, worker-reported, and the Operations view", () => {
  let db: TestDatabase; let app: FastifyInstance; let base = ""; let gh: LoopbackGitHub; let fx: GitFixture;
  const permissive = () => new AuthFailureLimiter({ perClientMax: 1e6, globalMax: 1e6, windowMs: 60_000 });
  let runId = ""; let plainRun = "";
  beforeAll(async () => {
    db = await migratedTestDatabase(); gh = await startLoopbackGitHub(); fx = usxLikeGitFixture(); gh.add(fx);
    await seedUsxProgramme(db.ownerPool);
    const github = new GitHubSource({ token: GH_TOKEN, testOrigins: { api: gh.origin, archive: [gh.origin] }, requestTimeoutMs: 5000 });
    app = buildApp({ pool: db.ownerPool, apiBearerToken: OPERATOR, hubAllowedHosts: [], limiter: permissive(), engineInfo: { expectedMigrations: null }, workerApi: { reaperIntervalMs: 0, limiter: permissive(), github } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }, 120_000);
  afterAll(async () => { await app?.close(); await gh?.close(); fx?.cleanup(); await db?.drop(); });

  const wcall = async (op: string, body: Record<string, unknown>, token: string, key = randomUUID()) => {
    const res = await fetch(`${base}/internal/worker/v1/${op}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": key }, body: JSON.stringify(body) });
    const text = await res.text(); return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const get = async (path: string) => { const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${OPERATOR}` } }); return { status: res.status, json: await res.json() as any }; };

  it("report_apex_shadow is allow-listed, schema-validated, quota-counted, re-checked, and cannot write any evidence table", async () => {
    expect(Object.keys(OPERATIONS)).toContain("report_apex_shadow");
    expect(OPERATIONS.report_apex_shadow!.stepKeys).toEqual([APEX_SHADOW_STEP_KEY]);
    const r = await promoteUsx(db.pool, true); runId = r.actions[0]!.workflowRunId!;
    const tok = await mintWorkerToken(db.ownerPool, { runId, createdBy: "operator@test" });
    const c = new WorkerApiClient({ baseUrl: base, token: tok.token, backoffMs: 1, attempts: 2 });
    const honest = computeApexShadow({ sources: usxLikeSources(), inScopePaths: T.inScopePaths });
    let snap: { id: string; commit_sha: string; manifest_sha256: string } = { id: "", commit_sha: "", manifest_sha256: "" };
    const report = (over: Record<string, unknown> = {}, result: unknown = honest) => ({
      schema: "agentsmith-apex-shadow/1", label: APEX_SHADOW_LABEL, version: "apex-shadow/1", status: "completed", refusal: null, failure: null, result, observed: { wall_ms: 1, cpu_ms: 1 },
      provenance: { apex_version: "apex-shadow/1", engine_generator: "apex-state-explorer@0-prototype", strategy: "deep", compute_limits: { cpuMs: 1, wallMs: 1, maxHeapMb: 1, maxInputBytes: 1, maxOutputBytes: 1 }, shadow_limits: honest.engine.limits,
        snapshot_id: snap.id, commit_sha: snap.commit_sha, manifest_sha256: snap.manifest_sha256, repository: T.repository, approved_by: APPROVER, approved_commit: T.commit, input_files: (result as typeof honest).input_files ?? honest.input_files, worker: { mode: "remote", build_commit: null } }, ...over });
    let s = await c.claimNext(remoteStepKeys(SWITCHES));
    while (s && s.step_key !== APEX_SHADOW_STEP_KEY) {
      if (s.step_key === "analyze_structure") {
        // a non-shadow step may not use the operation, even with its lease held and a well-formed report
        snap = (await db.ownerPool.query("SELECT id, commit_sha, manifest_sha256 FROM repo_snapshots WHERE workflow_run_id = $1", [runId])).rows[0];
        const wrong = await wcall("report_apex_shadow", { step_id: s.id, report: report() }, tok.token);
        expect([wrong.status, wrong.json.error]).toEqual([403, "operation_not_allowed_for_step"]);
      }
      await executeRemoteStep(c, "apex-remote", s, { source: new FakeSource(fx), env: SWITCHES });
      s = await c.claimNext(remoteStepKeys(SWITCHES));
    }
    expect(s!.step_key).toBe(APEX_SHADOW_STEP_KEY);
    const before = await evidenceState(db.ownerPool);
    // schema: any extra or missing field, a forged label, a result on a refusal
    for (const bad of [{ ...report(), extra: 1 }, report({ label: "evidence" }), report({ status: "refused", refusal: { code: "x", reason: "y" } }), report({}, { ...honest, would_be_hypotheses: [{ ...honest.would_be_hypotheses[0], label: "confirmed" }] })]) {
      const res = await wcall("report_apex_shadow", { step_id: s!.id, report: bad }, tok.token);
      expect([res.status, res.json.error]).toEqual([400, "invalid_request"]);
    }
    // re-checked by the recorder: an out-of-scope file, and a digest that is not the sealed snapshot's
    const outOfScope = { ...honest, input_files: [...honest.input_files, { path: "src/cloak/USXRebalancer.sol", sha256: "a".repeat(64), bytes: 1 }] };
    expect((await wcall("report_apex_shadow", { step_id: s!.id, report: report({}, outOfScope) }, tok.token)).json.error).toBe("provenance_mismatch");
    const forged = { ...honest, input_files: honest.input_files.map((f, i) => (i === 0 ? { ...f, sha256: "b".repeat(64) } : f)) };
    expect((await wcall("report_apex_shadow", { step_id: s!.id, report: report({}, forged) }, tok.token)).json.error).toBe("provenance_mismatch");
    expect((await wcall("report_apex_shadow", { step_id: s!.id, report: report({ provenance: { ...report().provenance, snapshot_id: "00000000-0000-4000-8000-000000000001" } }) }, tok.token)).json.error).toBe("provenance_mismatch");
    // complete may name only a recorded report, in its exact shape
    expect((await wcall("complete", { step_id: s!.id, output: { status: "apex_shadow_finished", report_sha256: "c".repeat(64) } }, tok.token)).json.error).toBe("shadow_report_not_recorded");
    expect((await wcall("complete", { step_id: s!.id, output: { status: "apex_shadow_finished", report_sha256: "c".repeat(64), hypotheses: [] } }, tok.token)).json.error).toBe("output_rejected");
    // quota: a token whose storage quota is spent cannot record a report (D4)
    const tightPool = new pg.Pool({ connectionString: db.url, max: 2 });
    const tight = buildApp({ pool: tightPool, apiBearerToken: OPERATOR, hubAllowedHosts: [], limiter: permissive(), engineInfo: { expectedMigrations: null }, workerApi: { reaperIntervalMs: 0, limiter: permissive(), quotas: { maxBytesStored: 1 } } });
    try {
      const q = await tight.inject({ method: "POST", url: "/internal/worker/v1/report_apex_shadow", headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json", "idempotency-key": "11111111-1111-4111-8111-111111111111" }, payload: { step_id: s!.id, report: report() } });
      expect([q.statusCode, q.json().error]).toEqual([413, "storage_quota_exceeded"]);
    } finally { await tight.close(); }
    expect(await evidenceState(db.ownerPool)).toEqual(before);
    expect(await shadowRecords(db.ownerPool, runId)).toEqual([]);

    // the honest worker: APEX runs on the worker, in its bounded child; one report, then complete
    await executeRemoteStep(c, "apex-remote", s!, { source: new FakeSource(fx), env: SWITCHES });
    expect(await runStatus(db.ownerPool, runId)).toBe("succeeded");
    expect(await evidenceState(db.ownerPool)).toEqual(before);
    const recs = await shadowRecords(db.ownerPool, runId);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.actor).toBe(`worker-token:${tok.tokenId}`);
    expect(recs[0]!.payload).toMatchObject({ status: "completed", reported_by: "worker", via: "worker_api", token_id: tok.tokenId, provenance: { worker: { mode: "remote" }, snapshot_id: snap.id, commit_sha: T.commit } });
    expect(recs[0]!.payload.report_sha256).toBe(reportSha256(Object.fromEntries(Object.entries(recs[0]!.payload).filter(([k]) => !["report_sha256", "reported_by", "via", "token_id", "overlaps", "recorder"].includes(k)))));
    expect((await shadowStep(db.ownerPool, runId)).output).toMatchObject({ status: "apex_shadow_recorded", reported_by: "worker", report_sha256: recs[0]!.payload.report_sha256 });
    const accepted = (await db.ownerPool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'worker_api.accepted' AND payload->>'operation' = 'report_apex_shadow'")).rows[0].n;
    expect(accepted).toBe(1);
    expect(Number((await db.ownerPool.query("SELECT bytes_stored AS n FROM worker_token_usage WHERE token_id = $1", [tok.tokenId])).rows[0].n)).toBeGreaterThan(JSON.stringify(recs[0]!.payload.result).length / 2);
  }, 300_000);

  it("the Operations endpoint shows the shadow record, every number labelled; a run without it says 'experimental, not enabled for this run'", async () => {
    const doc = (await get(`/v1/research/runs/${runId}/progress`)).json;
    const apex: Panel = doc.panels.find((p: Panel) => p.id === "apex");
    expect(apex.state).toBe("recorded");
    expect(apex.availability!.state).toBe("experimental");
    expect(apex.availability!.reason).toContain(APEX_SHADOW_LABEL);
    expect(apex.availability!.reason).toContain(APPROVER);
    const metrics: Metric[] = [...apex.processing, ...apex.coverage, ...apex.counts];
    expect(metrics.length).toBeGreaterThanOrEqual(15);
    for (const m of metrics) { expect(m.label.startsWith(`${APEX_SHADOW_LABEL}:`), m.key).toBe(true); expect(m.basis).toBe("worker_reported"); expect(m.note).toBe(APEX_SHADOW_LABEL); expect(Object.keys(m).sort()).toEqual(["basis", "denominator", "key", "kind", "label", "measurable", "note", "numerator", "source", "unit"]); }
    const rec = (await shadowRecords(db.ownerPool, runId))[0]!.payload;
    const byKey = (k: string) => metrics.find((m) => m.key === k)!;
    expect(byKey("apex_contracts_explored")).toMatchObject({ numerator: rec.result.coverage.contracts_explored.numerator, denominator: rec.result.coverage.contracts_explored.denominator, measurable: true, kind: "coverage" });
    expect(byKey("apex_frontier_dropped")).toMatchObject({ numerator: rec.result.coverage.frontier_dropped.numerator, denominator: rec.result.coverage.frontier_dropped.denominator });
    expect(byKey("apex_abstentions").numerator).toBe(rec.result.abstentions.length);
    expect(byKey("apex_suppressed").numerator).toBe(rec.result.suppressions.total);
    expect(byKey("apex_transitions_requested").numerator).toBe(rec.result.cost.transitions_requested);
    const sh = apex.shadow as any;
    expect(sh).toMatchObject({ label: APEX_SHADOW_LABEL, measurement_only: true, status: "completed", record: { reported_by: "worker", via: "worker_api" }, provenance: { approved_by: APPROVER, commit_sha: T.commit } });
    expect(sh.abstentions.items.length).toBe(rec.result.abstentions.length);
    for (const a of sh.abstentions.items) { expect(a.file).toMatch(/^src\//); expect(Number.isInteger(a.line)).toBe(true); expect(a.feature).toBeTruthy(); }
    expect(sh.candidates.items.some((x: any) => x.decision === "rejected" && x.reason)).toBe(true);
    expect(sh.candidates.items.some((x: any) => x.decision === "accepted")).toBe(true);
    expect(sh.suppressions.by_kind).toEqual(rec.result.suppressions.by_kind);
    // nothing of the shadow reaches validation, confidence or outcome
    const leads = Number((await db.ownerPool.query("SELECT count(*)::int AS n FROM hypotheses WHERE workflow_run_id = $1", [runId])).rows[0].n);
    expect(doc.confidence.total).toBe(leads);
    expect(doc.outcome.counts.find((m: Metric) => m.key === "confirmed").numerator).toBe(0);
    const validation: Panel = doc.panels.find((p: Panel) => p.id === "validation");
    expect([...validation.processing, ...validation.coverage].every((m) => m.denominator === leads)).toBe(true);
    // the timeline lists the record (payload capped), labelled by its reason
    const tl = (await get(`/v1/research/timeline?run=${runId}&limit=200`)).json;
    expect(tl.items.some((i: any) => i.action === APEX_SHADOW_ACTION && /not evidence/.test(i.reason))).toBe(true);
    // a run without the shadow step
    plainRun = (await createRepositoryResearchRun(db.ownerPool, { repository: "acme/plain", ref: "main" }, "operator", { structuralAnalysis: true })).runId;
    const plain: Panel = (await get(`/v1/research/runs/${plainRun}/progress`)).json.panels.find((p: Panel) => p.id === "apex");
    expect(plain).toMatchObject({ state: "experimental", availability: { state: "experimental", reason: "experimental, not enabled for this run" } });
    expect([...plain.processing, ...plain.coverage, ...plain.counts]).toEqual([]);
    expect(plain.shadow).toBeUndefined();
    const comps = (await get("/v1/engine/components")).json.components;
    expect(comps.find((x: any) => x.id === "apex")).toMatchObject({ state: "experimental" });
    expect(JSON.stringify(comps.find((x: any) => x.id === "apex").evidence)).toMatch(/1 runs with a shadow step, 1 shadow records/);
  }, 120_000);
});

