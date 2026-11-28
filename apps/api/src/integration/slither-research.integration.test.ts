import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "../engine/tools/tool-host/register.js";
import { ACQUIRE_STEP_KEY, createRepositoryResearchRun, processAcquireRepositoryStep } from "../acquisition/step.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY, SLITHER_STEP_KEY } from "../analysis/solidity/keys.js";
import { buildDossier, renderDossierMarkdown, SPECIALIST_ID, VALIDATOR_ID, type Dossier } from "../analysis/solidity/pipeline.js";
import { dispatchAnalysisStep } from "../analysis/solidity/step.js";
import { fakeTools, type FakeMode } from "../engine/tools/testing/fake-tools.js";
import { ResearchStore } from "../research-state.js";
import { intakeStepKeys } from "../worker-runtime.js";
import { WorkflowWorker } from "../worker.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * The optional, pinned Slither stage inside the EXISTING repository_research workflow (no engine loop, no draft migration):
 * acquire_repository -> analyze_structure -> slither_scan -> challenge_leads -> build_dossier. CI uses the stand-in that prints the
 * RECORDED real Slither 0.11.3 output for eval/dev/contracts; the last block runs only where the real binaries are configured.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
const corpus = join(__dirname, "..", "..", "..", "..", "eval", "dev", "contracts");
const ORIGINAL_LIMITATIONS = 4;

describe.skipIf(skipIntegration)("Slither as an optional stage of repository_research (real Postgres)", () => {
  let db: TestDatabase; let fx: GitFixture; const cleanups: Array<() => void> = [];
  beforeAll(async () => {
    assertIntegrationConfigured(); db = await migratedTestDatabase();
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "vaults" });
  });
  afterAll(async () => { fx?.cleanup(); cleanups.forEach((c) => c()); await db?.drop(); });
  const tools = (m: FakeMode) => { const t = fakeTools(m); cleanups.push(t.cleanup); return { AGENTSMITH_SLITHER_BIN: t.slither, AGENTSMITH_SOLC_BIN: t.solc }; };
  const steps = async (runId: string) => (await db.pool.query("SELECT step_key, sequence, role, status, input, output FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [runId])).rows;

  /** creates one run and executes every step of it in order with the given worker environment */
  async function chain(slitherScan: boolean, env: Record<string, string | undefined>) {
    const { runId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vaults", ref: "main" }, "operator", { structuralAnalysis: true, ...(slitherScan ? { slitherScan: true } : {}) });
    const worker = new WorkflowWorker(db.pool, "slither-chain", 120, 3); const ctx = { pool: db.pool, worker, workerId: "slither-chain", heartbeatMs: 40, env };
    const acq = (await worker.claimNext([ACQUIRE_STEP_KEY], runId))!;
    await processAcquireRepositoryStep({ pool: db.pool, worker, workerId: "slither-chain", source: new FakeSource(fx) }, acq);
    const keys = slitherScan ? [ANALYZE_STEP_KEY, SLITHER_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY] : [ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY];
    for (const key of keys) { const s = (await worker.claimNext([key], runId))!; expect(s.step_key).toBe(key); expect(await dispatchAnalysisStep(ctx, s)).toBe(true); }
    const rows = await steps(runId); const snapshotId = rows[0].output.snapshot_id as string;
    const run = (await db.pool.query("SELECT status FROM workflow_runs WHERE id = $1", [runId])).rows[0].status as string;
    return { runId, rows, snapshotId, run, dossier: await buildDossier(db.pool, new ResearchStore(db.pool), snapshotId) };
  }

  it("a run without the option has no slither step, and slitherScan without structuralAnalysis is refused", async () => {
    const { runId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vaults", ref: "main" }, "operator", { structuralAnalysis: true });
    expect((await steps(runId)).map((s) => [s.step_key, s.sequence, s.role, s.input])).toEqual([[ACQUIRE_STEP_KEY, 0, "repository_acquirer", { repository: "acme/vaults", ref: "main" }], [ANALYZE_STEP_KEY, 1, "structural_analyst", {}], [CHALLENGE_STEP_KEY, 2, "lead_challenger", {}], [DOSSIER_STEP_KEY, 3, "dossier_builder", {}]]);
    const plain = await createRepositoryResearchRun(db.pool, { repository: "acme/vaults", ref: "main" });
    expect((await steps(plain.runId)).map((s) => s.step_key)).toEqual([ACQUIRE_STEP_KEY]);
    await expect(createRepositoryResearchRun(db.pool, { repository: "acme/vaults" }, "operator", { slitherScan: true })).rejects.toThrow(/requires structuralAnalysis/);
    await db.ownerPool.query("UPDATE workflow_steps SET status = 'cancelled' WHERE workflow_run_id = ANY($1::uuid[]) AND status = 'queued'", [[runId, plain.runId]]);
    await db.ownerPool.query("UPDATE workflow_runs SET status = 'cancelled' WHERE id = ANY($1::uuid[])", [[runId, plain.runId]]);
  });

  it("with the option, the stage sits between analyse and challenge, and only a worker with the switch AND the binaries may claim it", async () => {
    const { runId } = await createRepositoryResearchRun(db.pool, { repository: "acme/vaults", ref: "main" }, "operator", { structuralAnalysis: true, slitherScan: true });
    const rows = await steps(runId);
    expect(rows.map((s) => [s.step_key, s.sequence, s.role])).toEqual([[ACQUIRE_STEP_KEY, 0, "repository_acquirer"], [ANALYZE_STEP_KEY, 1, "structural_analyst"], [SLITHER_STEP_KEY, 2, "external_producer"], [CHALLENGE_STEP_KEY, 3, "lead_challenger"], [DOSSIER_STEP_KEY, 4, "dossier_builder"]]);
    expect(rows[2].input).toEqual({ scope: "repository_research", producer: "slither", pinned_version: "0.11.3" });
    const audit = (await db.pool.query("SELECT action FROM audit_events WHERE entity_id = $1", [runId])).rows.map((r) => r.action).sort();
    expect(audit).toEqual(["repository_research.created", "repository_research.slither_scan_requested"]);
    // make the stage the next one, then check which workers can claim it
    await db.ownerPool.query("UPDATE workflow_steps SET status = 'succeeded' WHERE workflow_run_id = $1 AND sequence < 2", [runId]);
    const worker = new WorkflowWorker(db.pool, "gate", 60, 3);
    expect(await worker.claimNext(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true" }), runId)).toBeNull(); // the run waits; nothing passes silently
    expect(await worker.claimNext(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", SLITHER_SCAN_ENABLED: "true" }), runId)).toBeNull();
    const claimed = await worker.claimNext(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", SLITHER_SCAN_ENABLED: "true", AGENTSMITH_SLITHER_BIN: "/x", AGENTSMITH_SOLC_BIN: "/y" }), runId);
    expect(claimed?.step_key).toBe(SLITHER_STEP_KEY);
    await db.ownerPool.query("UPDATE workflow_steps SET status = 'cancelled' WHERE workflow_run_id = $1 AND status IN ('queued', 'running')", [runId]);
    await db.ownerPool.query("UPDATE workflow_runs SET status = 'cancelled' WHERE id = $1", [runId]);
  });

  let baseline: Dossier;
  it("default path: a run without the stage produces the dossier it always did (no external-tool fields, original limitations)", async () => {
    const r = await chain(false, {});
    expect(r.run).toBe("succeeded"); expect(r.rows.map((x) => x.step_key)).toEqual([ACQUIRE_STEP_KEY, ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY]);
    expect(r.dossier.coverage).not.toHaveProperty("external_tools"); expect(r.dossier.coverage.status).toBe("complete");
    expect(r.dossier.limitations).toHaveLength(ORIGINAL_LIMITATIONS); expect(r.dossier.limitations[0]).toMatch(/^Every item is a lead produced by deterministic rules/);
    expect(r.rows[2].output).not.toHaveProperty("slither");
    expect(r.dossier.entries.every((e) => e.generator === `${SPECIALIST_ID}@1`)).toBe(true);
    expect(renderDossierMarkdown(r.dossier)).not.toMatch(/External tool|slither/i);
    baseline = r.dossier;
  });

  it("happy path: Slither leads become plane-1 hypotheses on verified spans, are challenged by AgentSmith's validators, and the dossier names their generator", async () => {
    const r = await chain(true, { SLITHER_SCAN_ENABLED: "true", ...tools("ok") });
    expect(r.run).toBe("succeeded"); expect(r.rows.map((x) => x.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
    const out = r.rows[2].output;
    expect(out).toMatchObject({ status: "tool_completed", producer: "slither", generator: "slither@0.11.3", snapshot_id: r.snapshotId, tool: { name: "slither", version: "0.11.3", solc_version: "0.8.28" },
      detections_total: 47, informational_detections: 20, unanchored: 0, leads_not_recorded: 0, execution_mode: "passive_only", active_testing_allowed: false });
    expect(out.unmapped_detectors).toEqual({ "solc-version": 5, "low-level-calls": 14, "immutable-states": 1 }); // counted, never stored
    expect(out.tool.raw_output_sha256).toMatch(/^[0-9a-f]{64}$/); expect(out.tool.raw_output_blob).toBe(out.tool.raw_output_sha256);
    expect(JSON.stringify(out)).not.toMatch(/agentsmith-tool-|pragma solidity/);
    const leads = out.leads as Array<{ hypothesisId: string; class: string; contract: string; function: string }>;
    expect(leads.length).toBe(27); expect(out.leads_by_class).toMatchObject({ reentrancy: 6, "missing-zero-check": 14, "tx-origin": 1 });
    // stored as plane-1 hypotheses with generator slither@0.11.3, each anchored to a span the store hash-verifies
    const hs = (await db.pool.query("SELECT id, generator_id, generator_version, family FROM hypotheses WHERE snapshot_id = $1 AND generator_id = 'slither'", [r.snapshotId])).rows;
    expect(hs.length).toBe(leads.length); for (const h of hs) { expect(h.generator_version).toBe("0.11.3"); expect(h.family).toMatch(/^slither-/); }
    const store = new ResearchStore(db.pool);
    for (const h of hs) { const sp = (await db.pool.query("SELECT span_id FROM hypothesis_evidence WHERE hypothesis_id = $1", [h.id])).rows; expect(sp.length).toBe(1); await store.verifySpan(sp[0].span_id); }
    // challenge: every Slither lead evaluated, never by Slither; reentrancy by the execution validator; unmatched classes say so
    const ev = (await db.pool.query("SELECT h.id, e.evaluator_id, e.outcome FROM hypothesis_evaluations e JOIN hypotheses h ON h.id = e.hypothesis_id WHERE h.snapshot_id = $1 AND h.generator_id = 'slither'", [r.snapshotId])).rows;
    expect(new Set(ev.map((e) => e.id)).size).toBe(leads.length);
    expect(ev.every((e) => !/slither/i.test(e.evaluator_id))).toBe(true);
    const byLead = new Map(ev.map((e) => [e.id, e.evaluator_id]));
    for (const l of leads) {
      if (l.class === "reentrancy") expect(byLead.get(l.hypothesisId)).toBe(VALIDATOR_ID);
      else if (["access-control", "selfdestruct", "delegatecall", "unchecked-call"].includes(l.class)) expect(byLead.get(l.hypothesisId)).toBe(`execution-challenge-${l.class}`);
      else expect(byLead.get(l.hypothesisId)).toBe("no-independent-validator");
    }
    expect(ev.some((e) => e.evaluator_id.startsWith("execution-challenge-"))).toBe(true);
    const nv = (await db.pool.query("SELECT e.rationale FROM hypothesis_evaluations e JOIN hypotheses h ON h.id = e.hypothesis_id WHERE h.snapshot_id = $1 AND h.generator_id = 'slither' AND e.evaluator_id = 'no-independent-validator' LIMIT 1", [r.snapshotId])).rows[0];
    expect(nv.rationale).toMatch(/only been produced by slither@0\.11\.3 and has not been challenged/);
    expect(r.rows[3].output).toMatchObject({ status: "leads_challenged", slither: { status: "tool_completed", leads_challenged: leads.length } });
    // the dossier: Slither entries with their generator named, the specialist entries exactly as in the default run, coverage says what ran
    const d = r.dossier; const sl = d.entries.filter((e) => e.generator === "slither@0.11.3");
    expect(sl.length).toBe(leads.length); expect(sl.every((e) => e.evidence.length === 1 && e.evidence[0]!.verified && e.evaluations.length >= 1)).toBe(true);
    expect(sl.find((e) => e.class === "slither-reentrancy-eth")!.function).toMatch(/^\w+\.\w+$/);
    const strip = (x: Dossier) => x.entries.filter((e) => e.generator !== "slither@0.11.3").map((e) => [e.class, e.function, e.claim, e.evidence.map((v) => [v.path, v.lines, v.text]), e.evaluations, e.status]);
    expect(strip(d)).toEqual(strip(baseline));
    expect(d.coverage.status).toBe("complete");
    expect(d.coverage.external_tools).toEqual([{ tool: "slither", pinned_version: "0.11.3", status: "completed", version: "0.11.3", solc_version: "0.8.28", generator: "slither@0.11.3", leads: leads.length, informational_detections: 20, unanchored: 0, leads_not_recorded: 0 }]);
    expect(d.limitations[0]).toMatch(/slither@0\.11\.3 come from Slither compiling the snapshot with solc 0\.8\.28/);
    expect(d.limitations.some((l) => /Slither leads are claims by an external tool/.test(l))).toBe(true);
    expect(r.rows[4].output.content_sha256).toBe(d.content_sha256); // the step's dossier is the one rebuilt from stored records
    const md = renderDossierMarkdown(d);
    expect(md).toMatch(/\*\*Generated by\*\* slither@0\.11\.3/); expect(md).toMatch(/External tool: \*\*slither@0\.11\.3\*\* completed \(solc 0\.8\.28\): 27 leads, 20 informational/);
  });

  const failures: Array<[string, () => Record<string, string>, string]> = [
    ["tool_unavailable (binary path does not exist)", () => ({ SLITHER_SCAN_ENABLED: "true", AGENTSMITH_SLITHER_BIN: "/nonexistent/slither", AGENTSMITH_SOLC_BIN: "/nonexistent/solc" }), "tool_unavailable"],
    ["tool_unavailable (binaries not configured on the worker)", () => ({ SLITHER_SCAN_ENABLED: "true" }), "tool_unavailable"],
    ["tool_unavailable (worker without the switch)", () => ({ ...tools("ok") }), "tool_unavailable"],
    ["version_mismatch", () => ({ SLITHER_SCAN_ENABLED: "true", ...tools("old_version") }), "version_mismatch"],
    ["compile_failed", () => ({ SLITHER_SCAN_ENABLED: "true", ...tools("compile_error") }), "compile_failed"],
    ["timeout", () => ({ SLITHER_SCAN_ENABLED: "true", SLITHER_SCAN_TIMEOUT_MS: "1000", ...tools("hang") }), "timeout"],
    ["output_invalid", () => ({ SLITHER_SCAN_ENABLED: "true", ...tools("garbage") }), "output_invalid"],
    ["output_invalid (output larger than the limit)", () => ({ SLITHER_SCAN_ENABLED: "true", SLITHER_SCAN_MAX_OUTPUT_BYTES: "65536", ...tools("ok") }), "output_invalid"],
    ["crashed", () => ({ SLITHER_SCAN_ENABLED: "true", ...tools("crash") }), "crashed"],
  ];
  for (const [name, env, code] of failures) {
    it(`a failure (${name}) is an explicit abstention: the run succeeds and the dossier says Slither abstained and why`, async () => {
      const r = await chain(true, env());
      expect(r.run).toBe("succeeded"); expect(r.rows.every((x) => x.status === "succeeded")).toBe(true);
      const out = r.rows[2].output;
      expect(out).toMatchObject({ status: "abstained", producer: "slither", pinned_version: "0.11.3", generator: null, abstention: { code }, leads: [], hypothesis_ids: [] });
      expect(String(out.abstention.detail).length).toBeGreaterThan(0); expect(JSON.stringify(out)).not.toMatch(/agentsmith-tool-[A-Za-z0-9]/);
      expect(Number((await db.pool.query("SELECT count(*) n FROM hypotheses WHERE snapshot_id = $1 AND generator_id = 'slither'", [r.snapshotId])).rows[0].n)).toBe(0);
      expect(r.rows[3].output).toMatchObject({ slither: { status: "abstained", leads_challenged: 0 } });
      const d = r.dossier;
      expect(d.coverage.status).toBe("partial");
      expect(d.coverage.external_tools).toEqual([{ tool: "slither", pinned_version: "0.11.3", status: "abstained", code, detail: out.abstention.detail }]);
      expect(d.coverage.problems.some((p) => p.startsWith(`Slither 0.11.3 abstained (${code}):`))).toBe(true);
      expect(d.limitations.some((l) => l.includes(`abstained (${code}), so no Slither leads are included`))).toBe(true);
      expect(d.limitations[0]).toBe(baseline.limitations[0]);
      expect(renderDossierMarkdown(d)).toMatch(new RegExp(`slither 0\\.11\\.3 ABSTAINED\\*\\* \\(${code}\\)`));
      expect(d.entries.length).toBe(baseline.entries.length);
    });
  }

  describe.skipIf(!process.env["AGENTSMITH_SLITHER_BIN"] || !process.env["AGENTSMITH_SOLC_BIN"])("the REAL pinned Slither (runs only where it is installed)", () => {
    it("runs the stage for real on the sealed snapshot and matches the recorded output's leads", async () => {
      const r = await chain(true, { SLITHER_SCAN_ENABLED: "true", AGENTSMITH_SLITHER_BIN: process.env["AGENTSMITH_SLITHER_BIN"], AGENTSMITH_SOLC_BIN: process.env["AGENTSMITH_SOLC_BIN"] });
      const out = r.rows[2].output;
      console.log("REAL SLITHER STAGE OUTPUT", JSON.stringify({ status: out.status, generator: out.generator, tool: out.tool, detections_total: out.detections_total, informational_detections: out.informational_detections, leads: out.leads?.length, leads_by_class: out.leads_by_class, wall_ms: out.wall_ms, abstention: out.abstention, dossier_external_tools: r.dossier.coverage.external_tools }));
      expect(out).toMatchObject({ status: "tool_completed", generator: "slither@0.11.3", detections_total: 47, informational_detections: 20 });
      expect(out.leads.length).toBe(27);
      expect(r.dossier.entries.filter((e) => e.generator === "slither@0.11.3").length).toBe(27);
    }, 600_000);
  });
});
