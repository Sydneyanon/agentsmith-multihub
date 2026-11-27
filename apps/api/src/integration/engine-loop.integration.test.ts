import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACQUIRE_STEP_KEY, processAcquireRepositoryStep } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { NOT_MODELLED_CLASSES, SPECIALIST_CLASSES } from "../engine/classes.js";
import { POLICY_SHA256 } from "../engine/decisions.js";
import { accountFor, ingestInvestigation, mapAndAssign, outcomeLedger, rankOpportunities, recordHumanOutcome, selectOpportunity } from "../engine/loop.js";
import { readRegistry, recordVerification, registerManualOpportunity } from "../engine/registry.js";
import { CHALLENGE_TARGET_STEP_KEY, dispatchEngineStep, ENGINE_STEP_KEYS, INVESTIGATE_STEP_KEY } from "../engine/steps.js";
import { ResearchStore } from "../research-state.js";
import { intakeStepKeys } from "../worker-runtime.js";
import { WorkflowWorker } from "../worker.js";
import { applyDrafts } from "./drafts.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const corpus = join(__dirname, "..", "..", "..", "..", "eval", "dev", "contracts");
const NOW = new Date("2026-11-27T00:00:00Z");
const HUMAN = "owner-test";
const ev = (ref: string) => [{ kind: "official_page", ref, sha256: "a".repeat(64) }];

describe("research-loop step keys", () => {
  it("are claimable only when BOTH switches are exactly 'true'", () => {
    for (const k of ENGINE_STEP_KEYS) {
      expect(intakeStepKeys({})).not.toContain(k);
      expect(intakeStepKeys({ ENGINE_LOOP_ENABLED: "true" })).not.toContain(k);
      expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true" })).not.toContain(k);
      expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", ENGINE_LOOP_ENABLED: "1" })).not.toContain(k);
      expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", ENGINE_LOOP_ENABLED: "true" })).toContain(k);
    }
  });
});

describe.skipIf(skipIntegration)("the research loop end to end on a throwaway database (drafts T-144 + A29 applied)", () => {
  let db: TestDatabase; let fx: GitFixture; let source: FakeSource; let worker: WorkflowWorker;
  const ids: Record<string, string> = {};
  const selectRank = () => rankOpportunities(db.pool, NOW);
  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows as T[];
  /** what a worker would do, invoked explicitly: claim each queued step of the run in order and execute it */
  const execute = async (runId: string) => {
    const ctx = { pool: db.pool, worker, workerId: "loop-worker", heartbeatMs: 50 };
    for (;;) {
      const s = await worker.claimNext([ACQUIRE_STEP_KEY, ...ENGINE_STEP_KEYS]); if (!s) break;
      expect(s.workflow_run_id).toBe(runId);
      if (s.step_key === ACQUIRE_STEP_KEY) await processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "loop-worker", source }, s);
      else expect(await dispatchEngineStep(ctx, s)).toBe(true);
    }
    return q<{ step_key: string; status: string; output: Record<string, unknown> }>("SELECT step_key, status, output FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [runId]);
  };

  beforeAll(async () => {
    assertIntegrationConfigured(); db = await migratedTestDatabase(); await applyDrafts(db);
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "vaults" });
    source = new FakeSource(fx); worker = new WorkflowWorker(db.pool, "loop-worker", 120, 3);
  });
  afterAll(async () => { fx?.cleanup(); await db?.drop(); });

  it("1-2: registers opportunities with provenance, records human verification separately, and the database guards both", async () => {
    const base = { source: { key: "community-board", displayName: "Community bounty board (manual reference)" }, platform: "community", recordedBy: HUMAN };
    ids.a = (await registerManualOpportunity(db.pool, { ...base, canonicalKey: "community:acme-vaults", title: "Acme vaults", referenceUrl: "https://example.org/board/acme", claims: { maxRewardUsd: 50000, repositories: ["acme/vaults"] } })).id;
    ids.b = (await registerManualOpportunity(db.pool, { ...base, source: { key: "other-board", displayName: "Another board" }, canonicalKey: "other:acme-vaults", title: "Acme vaults (relisted)", referenceUrl: "https://example.org/other/acme", claims: { maxRewardUsd: 60000, repositories: ["acme/vaults"] } })).id;
    ids.c = (await registerManualOpportunity(db.pool, { ...base, canonicalKey: "community:unverified", title: "Unverified program", referenceUrl: "https://example.org/board/x", claims: { maxRewardUsd: 1000000, repositories: ["someone/thing"] } })).id;
    ids.d = (await registerManualOpportunity(db.pool, { ...base, canonicalKey: "community:kyc-only", title: "KYC-only program", referenceUrl: "https://example.org/board/kyc", claims: { maxRewardUsd: 20000, repositories: ["kyc/only"] } })).id;
    // a second sighting is a new provenance record on the SAME identity (deduplicated by canonical key, never a second row)
    const again = await registerManualOpportunity(db.pool, { ...base, canonicalKey: "community:acme-vaults", title: "Acme vaults", referenceUrl: "https://example.org/board/acme?seen=2", claims: { maxRewardUsd: 50000, repositories: ["acme/vaults"] } });
    expect(again).toMatchObject({ id: ids.a, created: false });
    const obs = await q<{ provenance_kind: string; outcome: string }>("SELECT DISTINCT provenance_kind, outcome FROM discovery_observations");
    expect(obs).toEqual([{ provenance_kind: "operator_supplied", outcome: "ok" }]); // never labelled as fetched

    for (const id of [ids.a, ids.b]) {
      await recordVerification(db.pool, { opportunityId: id!, check: "program_official", subject: "acme", verdict: "verified", method: "operator read the official program page", evidence: ev("https://example.org/official/acme"), humanId: HUMAN });
      await recordVerification(db.pool, { opportunityId: id!, check: "repository_official", subject: "acme/vaults", verdict: "verified", method: "named on the official page", evidence: ev("https://example.org/official/acme#assets"), humanId: HUMAN });
      await recordVerification(db.pool, { opportunityId: id!, check: "scope_includes_repository", subject: "acme/vaults", verdict: "verified", method: "scope table", evidence: ev("https://example.org/official/acme#scope"), humanId: HUMAN });
      await recordVerification(db.pool, { opportunityId: id!, check: "eligibility", subject: "acme", verdict: "verified", method: "terms read", evidence: ev("https://example.org/official/acme#terms"), humanId: HUMAN });
    }
    await recordVerification(db.pool, { opportunityId: ids.d!, check: "eligibility", subject: "kyc", verdict: "contradicted", method: "terms require KYC we cannot provide", evidence: ev("https://example.org/official/kyc#terms"), humanId: HUMAN });

    const reject = async (p: Promise<unknown>, m: RegExp) => { await expect(p).rejects.toThrow(m); };
    // a manual import source can never be enabled, so it can never be polled
    await reject(db.pool.query("UPDATE discovery_sources SET enabled = true WHERE source_key = 'community-board'"), /manual_never_polled/);
    // verification is a human event with evidence; neither the monitor nor the policy can write one
    const evt = (actor: string, payload: object) => db.pool.query("INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, payload) VALUES ($1, 'verified', $2, 'x', $3::jsonb)", [ids.c, actor, JSON.stringify(payload)]);
    const good = { check: "program_official", subject: "x", verdict: "verified", method: "m", evidence: ev("x") };
    await reject(evt("monitor", good), /check/);
    await reject(evt("policy", good), /check/);
    await reject(evt("human", { ...good, evidence: [] }), /check/);
    // the policy may only write assessments, and only with a decision
    await reject(db.pool.query("INSERT INTO opportunity_events (opportunity_id, event_type, actor_kind, actor_id, payload) VALUES ($1, 'assessed', 'policy', 'p', '{\"assessment\": \"deferred\", \"reason\": \"r\"}'::jsonb)", [ids.c]), /check/);
    await reject(db.pool.query("UPDATE opportunity_events SET payload = '{}'::jsonb WHERE opportunity_id = $1", [ids.a]), /append-only|permission denied/);

    const reg = await readRegistry(db.pool);
    expect(reg.map((e) => [e.canonicalKey, e.state, e.observations])).toEqual([
      ["community:acme-vaults", "discovered", 2], ["other:acme-vaults", "discovered", 1], ["community:unverified", "discovered", 1], ["community:kyc-only", "discovered", 1]]);
  });

  it("3: the policy ranks and recommends with reasons (nothing dropped, no work created); a human selects; AgentSmith refuses an unverified repository", async () => {
    const runsBefore = (await q("SELECT id FROM workflow_runs")).length;
    const rank = await selectRank();
    expect(rank.recommended).toBe(ids.a);
    const byRef = Object.fromEntries(rank.candidates.map((c) => [c.ref, c]));
    expect(byRef[ids.a!]!.action).toBe("recommend");
    expect(byRef[ids.b!]).toMatchObject({ action: "skip_duplicate_risk" }); expect(byRef[ids.b!]!.reason).toMatch(/community:acme-vaults/);
    expect(byRef[ids.c!]).toMatchObject({ action: "skip_out_of_scope" }); expect(byRef[ids.c!]!.reason).toMatch(/program not verified.*eligibility not verified.*no repository verified/);
    expect(byRef[ids.d!]).toMatchObject({ action: "skip_out_of_scope", reason: "eligibility contradicted by the official terms" });
    expect((await q("SELECT id FROM workflow_runs")).length).toBe(runsBefore); // ranking creates no work
    const [d] = await q<{ policy_sha256: string; decided_by: string; mode: string }>("SELECT policy_sha256, decided_by, mode FROM research_decisions WHERE id = $1", [rank.decisionId]);
    expect(d).toEqual({ policy_sha256: POLICY_SHA256, decided_by: "research-policy/0", mode: "exploit" });
    const assessed = Object.fromEntries((await q<{ opportunity_id: string; a: string; dup: string | null }>("SELECT opportunity_id, payload->>'assessment' a, payload->>'duplicate_of' dup FROM opportunity_events WHERE event_type = 'assessed'")).map((r) => [r.opportunity_id, [r.a, r.dup]]));
    expect(assessed).toEqual({ [ids.a!]: ["recommended", null], [ids.b!]: ["possible_duplicate", ids.a], [ids.c!]: ["deferred", null], [ids.d!]: ["ineligible", null] });
    // re-ranking an unchanged registry records a decision but no new assessment events
    await selectRank();
    expect((await q("SELECT 1 FROM opportunity_events WHERE event_type = 'assessed'")).length).toBe(4);

    await expect(selectOpportunity(db.pool, { opportunityId: ids.c!, repository: "someone/thing", humanId: HUMAN })).rejects.toThrow(/not verified/);
    const sel = await selectOpportunity(db.pool, { opportunityId: ids.a!, repository: "acme/vaults", humanId: HUMAN, basisDecisionId: rank.decisionId });
    ids.acq = sel.acquisitionRunId;
    const [hd] = await q<{ decided_by_kind: string; decided_by: string; mode: string; policy_sha256: string | null }>("SELECT decided_by_kind, decided_by, mode, policy_sha256 FROM research_decisions WHERE id = $1", [sel.decisionId]);
    expect(hd).toEqual({ decided_by_kind: "human", decided_by: HUMAN, mode: "manual", policy_sha256: null });
    expect(await q("SELECT resulting_run_id FROM research_decision_candidates WHERE decision_id = $1", [sel.decisionId])).toEqual([{ resulting_run_id: ids.acq }]);
    const ev2 = await q<{ event_type: string; actor_kind: string }>("SELECT event_type, actor_kind FROM opportunity_events WHERE opportunity_id = $1 AND event_type IN ('approved','queued') ORDER BY seq", [ids.a]);
    expect(ev2).toEqual([{ event_type: "approved", actor_kind: "human" }, { event_type: "queued", actor_kind: "human" }]);
    expect((await readRegistry(db.pool)).find((e) => e.id === ids.a)!.state).toBe("queued");
  });

  it("4: a worker acquires the repository and seals a commit-pinned snapshot", async () => {
    const rows = await execute(ids.acq!);
    expect(rows.map((r) => [r.step_key, r.status])).toEqual([[ACQUIRE_STEP_KEY, "succeeded"]]);
    expect(rows[0]!.output).toMatchObject({ commit_sha: fx.commitSha });
    ids.snapshot = String(rows[0]!.output.snapshot_id);
  });

  let firstTarget = "";
  it("5-7: maps the snapshot and its research state, chooses a target with its reasons, and creates a specialist assignment", async () => {
    const m = await mapAndAssign(db.pool, ids.acq!);
    expect(m.snapshotId).toBe(ids.snapshot); expect(m.assignment).not.toBeNull(); expect(m.exhausted).toBe(false);
    firstTarget = m.assignment!.target; ids.inv = m.assignment!.runId;
    const comps = m.candidates.filter((c) => c.kind === "component");
    expect(comps.length).toBeGreaterThan(2);
    const chosen = comps.find((c) => c.action === "investigate")!;
    expect(chosen.ref).toBe(firstTarget);
    // every candidate states its features with a source, and its score with named contributions
    for (const c of comps) {
      for (const v of Object.values(c.features)) expect("source" in v || "unknown_reason" in v).toBe(true);
      expect(Array.isArray((c.scoreComponents as { contributions: unknown[] }).contributions)).toBe(true);
    }
    expect(comps.filter((c) => c.action === "defer").length).toBe(comps.length - 1);
    // the assignment is a repository_research run pinned to the decided commit, linked from the decision
    const [run] = await q<{ workflow_type: string; input: { ref: string; assignment: { decision_id: string } } }>("SELECT workflow_type, input FROM workflow_runs WHERE id = $1", [ids.inv]);
    expect(run).toMatchObject({ workflow_type: "repository_research", input: { ref: fx.commitSha, assignment: { decision_id: m.decisionId } } });
    const [link] = await q<{ resulting_run_id: string; resulting_step_id: string }>("SELECT resulting_run_id, resulting_step_id FROM research_decision_candidates WHERE decision_id = $1 AND selected", [m.decisionId]);
    const [inv] = await q<{ id: string }>("SELECT id FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [ids.inv, INVESTIGATE_STEP_KEY]);
    expect(link).toEqual({ resulting_run_id: ids.inv, resulting_step_id: inv!.id });
  });

  it("8-9: the specialist executes the assignment on the same sealed snapshot and returns structured results only", async () => {
    const rows = await execute(ids.inv!);
    expect(rows.map((r) => [r.step_key, r.status])).toEqual([[ACQUIRE_STEP_KEY, "succeeded"], [INVESTIGATE_STEP_KEY, "succeeded"], [CHALLENGE_TARGET_STEP_KEY, "succeeded"]]);
    // snapshots belong to their run (0007): the assignment re-seals the SAME version (commit and manifest hash), checked by the specialist
    const [first] = await q<{ commit_sha: string; manifest_sha256: string }>("SELECT commit_sha, manifest_sha256 FROM repo_snapshots WHERE id = $1", [ids.snapshot]);
    expect(rows[0]!.output).toMatchObject({ commit_sha: first!.commit_sha, manifest_sha256: first!.manifest_sha256 });
    expect(rows[1]!.output).toMatchObject({ decided_on_snapshot_id: ids.snapshot, manifest_sha256: first!.manifest_sha256 });
    const out = rows[1]!.output as { status: string; targets: Array<{ componentId: string }>; classes_examined: string[]; hypothesis_ids: string[]; execution_mode: string };
    expect(out).toMatchObject({ status: "target_investigated", execution_mode: "passive_only" });
    expect(out.targets.map((t) => t.componentId)).toEqual([firstTarget]);
    expect(out.classes_examined).toEqual([...SPECIALIST_CLASSES]);
    // every stored lead is about the target component, and every lead has been challenged
    const contract = firstTarget.slice(firstTarget.lastIndexOf("#") + 1);
    const hs = await q<{ claim: string }>("SELECT claim FROM hypotheses WHERE id = ANY($1::uuid[])", [out.hypothesis_ids]);
    expect(hs.length).toBe(out.hypothesis_ids.length);
    for (const h of hs) expect(h.claim).toContain(contract);
    expect(JSON.stringify(rows)).not.toMatch(/pragma solidity|SPDX-License/);
  });

  let leads: Awaited<ReturnType<typeof accountFor>> = [];
  it("10-11: the engine records coverage, effort and the three provenance planes; ingesting twice changes nothing", async () => {
    const before = await outcomeLedger(db.pool, ids.snapshot!);
    const r = await ingestInvestigation(db.pool, ids.inv!);
    expect(r.alreadyIngested).toBe(false);
    expect(r.coverageRows).toBe(SPECIALIST_CLASSES.length + NOT_MODELLED_CLASSES.length);
    expect(r.effortRows).toBe(2);
    const cov = await q<{ result: string; n: string }>("SELECT result, count(*) n FROM research_coverage WHERE workflow_run_id = $1 AND decision_id = $2 GROUP BY result ORDER BY result", [ids.inv, r.decisionId]);
    expect(cov.map((x) => [x.result, Number(x.n)])).toEqual([["examined", SPECIALIST_CLASSES.length], ["not_modelled", NOT_MODELLED_CLASSES.length]]);
    leads = r.leads;
    for (const l of leads) {
      expect(l.claim.generatorId).toBe("solidity-structural-specialists");
      expect(l.evidence.every((e) => e.evaluatorId !== l.claim.generatorId)).toBe(true);
      expect(l.human).toEqual({ reviews: [], outcome: null });
    }
    const after = await outcomeLedger(db.pool, ids.snapshot!);
    expect(after.unexplored).toBe(before.unexplored - SPECIALIST_CLASSES.length);
    expect(after).toMatchObject({ confirmed: 0, refuted: 0, inconclusive: 0, duplicate: 0, missed: 0 });
    expect((await ingestInvestigation(db.pool, ids.inv!))).toMatchObject({ alreadyIngested: true, coverageRows: 0, effortRows: 0 });
    await expect(db.pool.query("DELETE FROM research_coverage WHERE workflow_run_id = $1", [ids.inv])).rejects.toThrow(/append-only|permission denied/);
  });

  it("human adjudication is the only source of an outcome, and the database refuses an unearned 'confirmed'", async () => {
    const store = new ResearchStore(db.pool);
    const target = leads[0]; if (!target) return; // a target with no leads still proves the coverage path above
    await expect(recordHumanOutcome(db.pool, { hypothesisId: target.hypothesisId, category: "confirmed", decidedBy: HUMAN, rationale: "no adjudication review exists" })).rejects.toThrow(/confirmed requires/);
    const saw = { claim: true, evidence_spans: true, generator_rationale: true, generator_identity: true, prior_evaluations: true, prior_reviews: true };
    const review = await store.recordReview({ kind: "operator", operatorId: HUMAN }, { hypothesisId: target.hypothesisId, reviewerKind: "human", reviewerId: HUMAN, mode: "disclosed_adjudication", reviewerSaw: saw, inputSha256: "b".repeat(64), verdict: "rejects", rationale: "test adjudication: the guard covers this path" });
    await recordHumanOutcome(db.pool, { hypothesisId: target.hypothesisId, category: "refuted", decidedBy: HUMAN, rationale: "rejected on review", basisReviewId: review });
    expect((await accountFor(db.pool, [target.hypothesisId]))[0]!.human).toEqual({ reviews: ["rejects"], outcome: "refuted" });
    expect((await outcomeLedger(db.pool, ids.snapshot!)).refuted).toBe(1);
  });

  it("12: the next action is chosen from the UPDATED state, and the loop runs until the snapshot is exhausted, then returns to the registry", async () => {
    const seen = new Set([firstTarget]); let runId = ids.acq!; let guard = 0;
    let next = await mapAndAssign(db.pool, runId, "follow_up");
    expect(next.assignment?.target).not.toBe(firstTarget); // the examined component is no longer a candidate for investigation
    expect(next.candidates.find((c) => c.ref === firstTarget)!.action).toBe("complete");
    // adjudicated leads are never sent for review; supported, unadjudicated ones are, once
    const adjudicated = new Set(leads.slice(0, 1).map((l) => l.hypothesisId));
    for (const h of next.reviewRequests) expect(adjudicated.has(h)).toBe(false);
    while (!next.exhausted && guard++ < 40) {
      expect(seen.has(next.assignment!.target)).toBe(false); seen.add(next.assignment!.target);
      runId = next.assignment!.runId; await execute(runId); await ingestInvestigation(db.pool, runId);
      next = await mapAndAssign(db.pool, runId, "follow_up");
      for (const h of next.reviewRequests) expect(adjudicated.has(h)).toBe(false);
    }
    expect(next.exhausted).toBe(true);
    expect(next.candidates.filter((c) => c.kind === "component").every((c) => c.action === "complete")).toBe(true);
    const ledger = await outcomeLedger(db.pool, ids.snapshot!);
    expect(ledger.unexplored).toBe(ledger.notModelled); // only classes with no specialist remain, and memory says so explicitly
    expect(ledger.notModelled).toBeGreaterThan(0);
    // no lead was ever asked about twice
    const asked = await q<{ candidate_ref: string; n: string }>("SELECT candidate_ref, count(*) n FROM research_decision_candidates WHERE action = 'request_human_review' GROUP BY candidate_ref HAVING count(*) > 1");
    expect(asked).toEqual([]);
    // back at the registry: nothing eligible is open; the screened items stay visible with their reasons and are not re-recorded
    const back = await selectRank();
    expect(back.recommended).toBeNull();
    expect(Object.fromEntries(back.candidates.map((c) => [c.ref, c.action]))).toEqual({ [ids.b!]: "skip_duplicate_risk", [ids.c!]: "skip_out_of_scope", [ids.d!]: "skip_out_of_scope" });
    expect((await q("SELECT 1 FROM opportunity_events WHERE event_type = 'assessed'")).length).toBe(4);
  });

  it("decision records are append-only and reject features without a source and inconsistent selections", async () => {
    const [d] = await q<{ id: string }>("SELECT id FROM research_decisions ORDER BY created_at LIMIT 1");
    await expect(db.pool.query("UPDATE research_decisions SET rationale = 'x' WHERE id = $1", [d!.id])).rejects.toThrow(/append-only|permission denied/);
    await expect(db.pool.query("DELETE FROM research_decision_candidates WHERE decision_id = $1", [d!.id])).rejects.toThrow(/append-only|permission denied/);
    const ins = (features: string, action: string, selected: boolean) => db.pool.query(
      "INSERT INTO research_decision_candidates (decision_id, rank, candidate_kind, candidate_ref, features, score_components, selected, action, reason) VALUES ($1, 99, 'component', 'x', $2::jsonb, '{}'::jsonb, $3, $4, 'r')", [d!.id, features, selected, action]);
    await expect(ins('{"a": {"value": 1}}', "defer", false)).rejects.toThrow(/neither a source nor an unknown_reason/);
    await expect(ins('{"a": {"value": 1, "source": "s"}}', "defer", true)).rejects.toThrow(/check/);
    await expect(db.pool.query("INSERT INTO research_decisions (level, decided_by_kind, decided_by, mode, rationale) VALUES ('opportunity', 'policy', 'p', 'exploit', 'no policy hash')")).rejects.toThrow(/check/);
    await expect(db.pool.query("INSERT INTO research_decisions (level, decided_by_kind, decided_by, policy_sha256, mode, rationale) VALUES ('component', 'policy', 'p', $1, 'exploit', 'no snapshot')", [POLICY_SHA256])).rejects.toThrow(/check/);
  });
});
