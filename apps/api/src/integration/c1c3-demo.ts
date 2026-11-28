import { readFileSync } from "node:fs";
import "../engine/tools/tool-host/register.js";
import { DEPENDENCY_STEP_KEY, type DependencyManifest } from "../acquisition/dependencies.js";
import { dependencyManifestOfRun, processAcquireDependenciesStep } from "../acquisition/dependency-step.js";
import { GitHubSource, type RepositorySource } from "../acquisition/github-source.js";
import { ACQUIRE_STEP_KEY, createRepositoryResearchRun, processAcquireRepositoryStep } from "../acquisition/step.js";
import { startLoopbackGitHub, type LoopbackGitHub } from "../acquisition/testing/loopback-github.js";
import { leadHistory, type Investigation } from "../analysis/solidity/lead-identity.js";
import { buildDossier, renderDossierMarkdown, type Dossier } from "../analysis/solidity/pipeline.js";
import { readSharedModelOfRun, sectionStatuses, unsupportedFeaturesOfRun, type UnsupportedFeaturesView } from "../analysis/solidity/shared-model.js";
import { dbResearchReads, dispatchAnalysisStep } from "../analysis/solidity/step.js";
import { APEX_SHADOW_ACTION } from "../apex/shadow-record.js";
import { APEX_SHADOW_TARGET as T } from "../apex/shadow-target.js";
import { usxScope } from "../apex/testing/usx-like.js";
import { ResearchStore } from "../research-state.js";
import { WorkflowWorker } from "../worker.js";
import { buildBlockedFixture, buildDemoFixtures, slitherStandIn, STANDIN_LABEL, type DemoFixtures } from "./c1c3-fixtures.js";
import type { TestDatabase } from "./harness.js";

/**
 * The C1-C3 demonstration on a disposable database, shared by the integration test and scripts/c1-c3-rehearsal.ts. One run of the
 * existing `repository_research` workflow, in direct (db) mode, on controlled local fixtures:
 *
 *   acquire_repository -> acquire_dependencies -> analyze_structure -> slither_scan -> challenge_leads -> build_dossier -> apex_shadow
 *
 * Nothing is fetched from the network (a loopback GitHub stand-in serves local git fixtures to the PRODUCTION GitHubSource), Slither is a
 * labelled stand-in that prints authored output, and APEX is eligible only because the fixture is served under the approved repository,
 * commit and scope: the production eligibility check is not changed and still runs three times (creation, the step, the recorder).
 */
export const DEMO_APPROVER = "c1-c3 demonstration (controlled fixture; test configuration only)";
const GH_TOKEN = "github_pat_" + "11C1C3DEMO0" + "d".repeat(71); // shape only: the GitHub here is a loopback stand-in
const SWITCHES = { STRUCTURAL_ANALYSIS_ENABLED: "true", SLITHER_SCAN_ENABLED: "true", DEPENDENCY_ACQUISITION_ENABLED: "true" };
/** small APEX budgets: the demonstration is about the data flow, not about exploration depth */
export const DEMO_SHADOW = { shadowLimits: { maxTransitions: 20_000, perSearchBudget: 600, softWallMs: 60_000 } };

export type DemoEnvironment = { gh: LoopbackGitHub; source: RepositorySource; fixtures: DemoFixtures; tools: ReturnType<typeof slitherStandIn>; close(): Promise<void> };
export async function demoEnvironment(options: { commit?: string; shiftLines?: number } = {}): Promise<DemoEnvironment> {
  const gh = await startLoopbackGitHub(); const fixtures = buildDemoFixtures(options); const tools = slitherStandIn(options.shiftLines ?? 0);
  for (const f of fixtures.all) gh.add(f);
  const source = new GitHubSource({ token: GH_TOKEN, testOrigins: { api: gh.origin, archive: [gh.origin] }, requestTimeoutMs: 10_000 });
  return { gh, source, fixtures, tools, close: async () => { await gh.close(); fixtures.cleanup(); tools.cleanup(); } };
}

type StepRow = { step_key: string; sequence: number; status: string; output: Record<string, any> | null };
export const stepsOf = async (db: TestDatabase, runId: string): Promise<StepRow[]> => (await db.ownerPool.query<StepRow>("SELECT step_key, sequence, status, output FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [runId])).rows;

/** Runs every queued step of a run on the direct worker, in order, with the given tools. */
export async function driveRun(db: TestDatabase, runId: string, source: RepositorySource, tools: { slither: string; solc: string } | null, workerId = "c1c3-direct-worker"): Promise<StepRow[]> {
  const worker = new WorkflowWorker(db.pool, workerId, 120, 3);
  const env = { ...SWITCHES, ...(tools ? { AGENTSMITH_SLITHER_BIN: tools.slither, AGENTSMITH_SOLC_BIN: tools.solc } : {}) };
  for (;;) {
    const next = (await db.ownerPool.query<{ step_key: string }>(`SELECT step_key FROM workflow_steps WHERE workflow_run_id = $1 AND status = 'queued' ORDER BY sequence LIMIT 1`, [runId])).rows[0]?.step_key;
    if (!next) break;
    const step = await worker.claimNext([next], runId); if (!step) throw new Error(`could not claim ${next}`);
    if (step.step_key === ACQUIRE_STEP_KEY) await processAcquireRepositoryStep({ pool: db.pool, worker, workerId, source, heartbeatMs: 1000 }, step);
    else if (step.step_key === DEPENDENCY_STEP_KEY) await processAcquireDependenciesStep({ worker, workerId, source, store: new ResearchStore(db.pool), reads: dbResearchReads(db.pool), heartbeatMs: 1000 }, step);
    else if (!(await dispatchAnalysisStep({ pool: db.pool, worker, workerId, heartbeatMs: 1000, env, shadow: DEMO_SHADOW }, step))) throw new Error(`no handler for ${step.step_key}`);
  }
  return stepsOf(db, runId);
}

export const createDemoRun = (db: TestDatabase, commit: string = T.commit, apex = true) => createRepositoryResearchRun(db.pool, { repository: T.repository, ref: commit }, "c1c3-demo",
  { structuralAnalysis: true, slitherScan: true, dependencies: true, bountyScope: usxScope(), ...(apex ? { apexShadow: { approvedBy: DEMO_APPROVER } } : {}) });

export type DemoRecord = {
  generated_by: string; fixtures: string; slither: string; apex: string;
  run: { id: string; repository: string; commit: string; status: string; steps: Array<{ step: string; sequence: number; status: string; result: string | null }> };
  snapshot: { id: string; manifest_sha256: string; dependency_snapshots: Array<{ repository: string; commit_sha: string; sealed: boolean; files: number; dependency_of: unknown }> };
  shared_model: { sha256: string; base_sha256: string; schema: string; sections: Record<string, string>; not_computed: Array<{ section: string; reason: string }>; facts: Record<string, number>; example_facts: Record<string, unknown> };
  model_hash_read_by: Record<string, { sha256: string | null; read: string; used_for?: string; detail?: unknown }>;
  all_consumers_read_the_same_model: boolean;
  shared_hypothesis: Investigation | null;
  contradiction_case: Investigation | null;
  investigation_summary: Dossier["investigation_summary"]; dossier: { content_sha256: string; entries: number; investigations: number; step_output_leads: number; step_output_hypotheses: number | null };
  independence: { self_evaluation_refused: string; relations: Array<{ hypothesis: string; generator: string; evaluator: string; relation_to_generator: string; relation_to_investigation: string; outcome: string }> };
  dependencies: { digest: string; blob_sha256: string; records: DependencyManifest["dependencies"]; remappings: DependencyManifest["remappings"]; packages: DependencyManifest["packages"]; limitations: DependencyManifest["limitations"] };
  slither_stage: { status: string; generator: string | null; stand_in: string; remappings_passed: string[]; dependency_files: number; arguments_seen: string[]; dependency_source_on_disk: boolean; leads: number; lead_keys: string[] };
  unsupported_features: UnsupportedFeaturesView;
  apex_shadow: { status: string; eligibility: string; report_sha256: string | null; label: string | null; contracts_explored: unknown; abstentions_by_feature: Record<string, number>; hypotheses_written: number };
  blocked_run: { repository: string; slither_status: string; abstention: unknown; limitations: Array<{ code: string; subject: string; reason: string }>; unresolved_imports: Array<{ path: string; reason: string | null }>; dossier_coverage_status: string } | null;
  reproducibility: { second_run_id: string; dependency_digest_equal: boolean; shared_model_sha256_equal: boolean; analysed_snapshot_manifest_equal: boolean } | null;
  cross_snapshot: { lead_key: string; occurrences: Array<{ commit_sha: string; generator: string; analysis_family: string | null }>; note: string } | null;
};

const result = (s: StepRow): string | null => (s.output ? String(s.output["status"] ?? "") : null);

/** Everything the demonstration shows about one finished run, read back from the database (stored records only). */
export async function collectDemoRecord(db: TestDatabase, runId: string, env: DemoEnvironment): Promise<DemoRecord> {
  const pool = db.ownerPool; const steps = await stepsOf(db, runId);
  const out = (key: string) => steps.find((s) => s.step_key === key)?.output ?? {};
  const run = (await pool.query<{ status: string; input: Record<string, any> }>("SELECT status, input FROM workflow_runs WHERE id = $1", [runId])).rows[0]!;
  const snapshotId = String(out(ACQUIRE_STEP_KEY)["snapshot_id"]);
  const depSnaps = (await pool.query<{ repository: string; commit_sha: string; sealed: boolean; files: number; dependency_of: unknown }>(
    `SELECT s.repository, s.commit_sha, s.sealed_at IS NOT NULL AS sealed, coalesce(s.file_count, 0) AS files, s.acquisition_report->'dependency_of' AS dependency_of FROM repo_snapshots s WHERE s.workflow_run_id = $1 AND s.id <> $2 ORDER BY s.repository`, [runId, snapshotId])).rows;
  const model = await readSharedModelOfRun(pool, runId);
  if (!model.available) throw new Error(`no shared model: ${model.reason}`);
  const S = model.doc.sections;
  const facts: Record<string, number> = {}; const example: Record<string, unknown> = {};
  if (S.state.status === "computed") { facts["state.variables"] = S.state.variables.length; example["state"] = S.state.variables.find((v) => v.component === "SharedVault" && v.variable === "balances") ?? S.state.variables[0]; }
  if (S.actors_permissions.status === "computed") { facts["actors_permissions.functions"] = S.actors_permissions.functions.length; facts["actors_permissions.roles"] = S.actors_permissions.roles.length; example["actors_permissions"] = S.actors_permissions.functions.find((f) => f.function.startsWith("SharedVault.configure")) ?? S.actors_permissions.functions[0]; }
  if (S.external_dependencies.status === "computed") { facts["external_dependencies.external_calls"] = S.external_dependencies.external_calls.length; facts["external_dependencies.imports"] = S.external_dependencies.imports.length;
    example["external_dependencies.external_call"] = S.external_dependencies.external_calls.find((c) => c.from.startsWith("SharedVault.")) ?? S.external_dependencies.external_calls[0]; example["external_dependencies.import"] = S.external_dependencies.imports.find((i) => i.resolution === "dependency") ?? S.external_dependencies.imports[0]; }
  if (S.upgradeability.status === "computed") { facts["upgradeability.markers"] = S.upgradeability.markers.length; example["upgradeability"] = S.upgradeability.markers[0] ?? null; }
  if (S.unsupported_features.status === "computed") { facts["unsupported_features.predicted"] = S.unsupported_features.predicted.length; example["unsupported_features"] = S.unsupported_features.predicted[0] ?? null; }
  if (S.unresolved_questions.status === "computed") { facts["unresolved_questions.questions"] = S.unresolved_questions.questions.length; example["unresolved_questions"] = S.unresolved_questions.questions.find((q) => q.raised_by === "dependency-acquisition") ?? S.unresolved_questions.questions[0]; }
  if (S.functions.status === "computed") facts["functions.callers"] = S.functions.callers.length;
  const not_computed = (Object.entries(S) as Array<[string, { status: string; reason?: string }]>).filter(([, v]) => v.status === "not_computed").map(([section, v]) => ({ section, reason: v.reason ?? "" }));
  if (S.actors_permissions.status === "computed") not_computed.push({ section: "actors_permissions.actors", reason: S.actors_permissions.actors.reason });
  if (S.unsupported_features.status === "computed") not_computed.push({ section: "unsupported_features.gate_observations (inside the immutable document)", reason: S.unsupported_features.gate_observations.reason });

  const shadowRow = (await pool.query<{ payload: Record<string, any> }>(`SELECT a.payload FROM audit_events a JOIN workflow_steps s ON s.id::text = a.entity_id WHERE s.workflow_run_id = $1 AND a.action = $2 ORDER BY a.id DESC LIMIT 1`, [runId, APEX_SHADOW_ACTION])).rows[0]?.payload ?? null;
  const pm = (o: Record<string, any>) => o["protocol_model"] as { sha256: string | null; read: string; used_for?: string } | undefined;
  const readBy: DemoRecord["model_hash_read_by"] = {
    "analyze_structure (builds and stores it)": { sha256: String(out("analyze_structure")["shared_model_sha256"]), read: "built", used_for: "the one build of the model for this sealed snapshot" },
    slither_scan: { sha256: pm(out("slither_scan"))?.sha256 ?? null, read: pm(out("slither_scan"))?.read ?? "not recorded", ...(pm(out("slither_scan"))?.used_for ? { used_for: pm(out("slither_scan"))!.used_for! } : {}) },
    challenge_leads: { sha256: pm(out("challenge_leads"))?.sha256 ?? null, read: pm(out("challenge_leads"))?.read ?? "not recorded", ...(pm(out("challenge_leads"))?.used_for ? { used_for: pm(out("challenge_leads"))!.used_for! } : {}), detail: { inputs_checked: out("challenge_leads")["protocol_model"]?.inputs_checked, leads: out("challenge_leads")["protocol_model"]?.leads, leads_on_modelled_functions: out("challenge_leads")["protocol_model"]?.leads_on_modelled_functions } },
    build_dossier: { sha256: pm(out("build_dossier"))?.sha256 ?? null, read: pm(out("build_dossier"))?.read ?? "not recorded", ...(pm(out("build_dossier"))?.used_for ? { used_for: pm(out("build_dossier"))!.used_for! } : {}) },
    apex_shadow: { sha256: shadowRow?.provenance?.protocol_model?.sha256 ?? null, read: shadowRow?.provenance?.protocol_model?.read ?? "not recorded", ...(shadowRow?.provenance?.protocol_model?.used_for ? { used_for: shadowRow.provenance.protocol_model.used_for } : {}),
      detail: shadowRow?.provenance?.protocol_model ? { inputs_matched: shadowRow.provenance.protocol_model.inputs_matched, inputs_total: shadowRow.provenance.protocol_model.inputs_total, gate_vs_model: shadowRow.provenance.protocol_model.gate_vs_model } : null },
  };
  const dossier = await buildDossier(pool, new ResearchStore(pool), snapshotId);
  const inv = dossier.investigations;
  const sharedHyp = inv.find((i) => i.anchor?.function === "withdraw" && i.anchor.contract === "SharedVault") ?? null;
  const contra = inv.find((i) => i.anchor?.function === "configure" && i.anchor.contract === "SharedVault") ?? null;
  const dm = (await dependencyManifestOfRun(pool, runId)).manifest!;
  const sl = out("slither_scan");
  let argsSeen: string[] = []; try { argsSeen = readFileSync(env.tools.argsLog, "utf8").split("\n").filter(Boolean); } catch { argsSeen = []; }
  const hypothesesWritten = Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM hypotheses h JOIN workflow_steps s ON s.id = h.produced_by_step_id WHERE h.workflow_run_id = $1 AND s.step_key = 'apex_shadow'", [runId])).rows[0]!.n);
  // the existing independence rule, exercised on the shared hypothesis: an engine never validates its own hypothesis
  let refused = "not exercised";
  if (sharedHyp) {
    const own = sharedHyp.contributions.find((c) => c.generator.startsWith("solidity-structural-specialists"));
    if (own) {
      try { await pool.query(`INSERT INTO hypothesis_evaluations (hypothesis_id, workflow_run_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256)
          SELECT h.id, h.workflow_run_id, h.produced_by_step_id, h.generator_id, '1', 'inconclusive', 'self-validation attempt (must be refused)', repeat('0', 64) FROM hypotheses h WHERE h.id = $1`, [own.hypothesis_id]); refused = "NOT REFUSED (unexpected)"; }
      catch (error) { refused = `refused by the database: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "error"}`; }
    }
  }
  return {
    generated_by: "apps/api/src/integration/c1c3-demo.ts (collectDemoRecord): read back from stored records of a disposable database",
    fixtures: "self-authored, local git repositories served by a loopback GitHub stand-in; nothing fetched from the network; no real project",
    slither: STANDIN_LABEL, apex: "the unchanged APEX engine on the USX-like fixture; eligible only because the fixture is served as the approved repository, commit and scope (test configuration); measurement only",
    run: { id: runId, repository: String(run.input["value"]), commit: String(run.input["ref"]), status: run.status, steps: steps.map((s) => ({ step: s.step_key, sequence: s.sequence, status: s.status, result: result(s) })) },
    snapshot: { id: snapshotId, manifest_sha256: String(out(ACQUIRE_STEP_KEY)["manifest_sha256"]), dependency_snapshots: depSnaps },
    shared_model: { sha256: model.sha256, base_sha256: model.base_sha256, schema: model.doc.schema, sections: sectionStatuses(model.doc), not_computed, facts, example_facts: example },
    model_hash_read_by: readBy, all_consumers_read_the_same_model: Object.values(readBy).every((r) => r.sha256 === model.sha256),
    shared_hypothesis: sharedHyp, contradiction_case: contra, investigation_summary: dossier.investigation_summary,
    dossier: { content_sha256: dossier.content_sha256, entries: dossier.entries.length, investigations: dossier.investigations.length, step_output_leads: Number(out("build_dossier")["leads"]), step_output_hypotheses: (out("build_dossier")["hypotheses"] as number | undefined) ?? null },
    independence: { self_evaluation_refused: refused, relations: [sharedHyp, contra].flatMap((i) => (i ? i.contributions.flatMap((c) => c.evaluations.map((e) => ({ hypothesis: c.hypothesis_id, generator: c.generator, evaluator: e.evaluator, relation_to_generator: e.relation, relation_to_investigation: e.relation_to_investigation, outcome: e.outcome }))) : [])) },
    dependencies: { digest: dm.digest, blob_sha256: String(out(DEPENDENCY_STEP_KEY)["dependency_manifest_blob_sha256"]), records: dm.dependencies, remappings: dm.remappings, packages: dm.packages, limitations: dm.limitations },
    slither_stage: { status: String(sl["status"]), generator: (sl["generator"] as string | null) ?? null, stand_in: STANDIN_LABEL, remappings_passed: (sl["dependencies"]?.remappings as string[] | undefined) ?? [], dependency_files: Number(sl["dependencies"]?.dependency_files ?? 0),
      arguments_seen: argsSeen.filter((l) => l !== "dependency-source-present").slice(0, 6).map((l) => l.split(env.tools.solc).join("<solc stand-in>")), dependency_source_on_disk: argsSeen.includes("dependency-source-present"), leads: ((sl["leads"] as unknown[]) ?? []).length, lead_keys: ((sl["lead_keys"] as Array<{ lead_key: string }> | undefined) ?? []).map((k) => k.lead_key) },
    unsupported_features: await unsupportedFeaturesOfRun(pool, runId),
    apex_shadow: { status: String(out("apex_shadow")["status"] ?? "no shadow step"), eligibility: "checked at creation, by the step and by the recorder (production check unchanged)", report_sha256: (out("apex_shadow")["report_sha256"] as string | undefined) ?? null, label: (out("apex_shadow")["label"] as string | undefined) ?? null,
      contracts_explored: out("apex_shadow")["coverage"]?.contracts_explored ?? null, abstentions_by_feature: shadowRow?.result?.abstentions_by_feature ?? {}, hypotheses_written: hypothesesWritten },
    blocked_run: null, reproducibility: null, cross_snapshot: null,
  };
}

/** The whole demonstration: the main run, the blocked run, a second run of the same commit, and the same lead at another commit. */
export async function runC1C3Demonstration(db: TestDatabase): Promise<{ record: DemoRecord; dossierMarkdown: string }> {
  const env = await demoEnvironment();
  const blocked = buildBlockedFixture(); env.gh.add(blocked);
  try {
    // 1-6: the main run
    const { runId } = await createDemoRun(db);
    await driveRun(db, runId, env.source, env.tools);
    const record = await collectDemoRecord(db, runId, env);
    const dossierMarkdown = renderDossierMarkdown(await buildDossier(db.ownerPool, new ResearchStore(db.ownerPool), record.snapshot.id));

    // 6: a project whose sources import an unavailable and an unpinned dependency: Slither abstains and names them
    const b = await createRepositoryResearchRun(db.pool, { repository: "acme-labs/blocked", ref: blocked.commitSha }, "c1c3-demo", { structuralAnalysis: true, slitherScan: true, dependencies: true });
    const bSteps = await driveRun(db, b.runId, env.source, env.tools, "c1c3-blocked-worker");
    const bModel = await readSharedModelOfRun(db.ownerPool, b.runId);
    const bOut = (k: string) => bSteps.find((s) => s.step_key === k)?.output ?? {};
    const bDossier = await buildDossier(db.ownerPool, new ResearchStore(db.ownerPool), String(bOut(ACQUIRE_STEP_KEY)["snapshot_id"]));
    record.blocked_run = { repository: "acme-labs/blocked", slither_status: String(bOut("slither_scan")["status"]), abstention: bOut("slither_scan")["abstention"] ?? null,
      limitations: ((await dependencyManifestOfRun(db.ownerPool, b.runId)).manifest?.limitations ?? []).map((l) => ({ code: l.code, subject: l.subject, reason: l.reason })),
      unresolved_imports: bModel.available && bModel.doc.sections.external_dependencies.status === "computed" ? bModel.doc.sections.external_dependencies.imports.filter((i) => i.resolution === "unresolved").map((i) => ({ path: i.path, reason: i.reason })) : [],
      dossier_coverage_status: bDossier.coverage.status };

    // reproducibility: the same parent commit again (a new run): the same dependency set and the same model, by digest
    const again = await createDemoRun(db, T.commit, false);
    const aSteps = await driveRun(db, again.runId, env.source, env.tools, "c1c3-second-worker");
    const aOut = (k: string) => aSteps.find((s) => s.step_key === k)?.output ?? {};
    record.reproducibility = { second_run_id: again.runId, dependency_digest_equal: aOut(DEPENDENCY_STEP_KEY)["dependency_manifest_digest"] === record.dependencies.digest,
      shared_model_sha256_equal: aOut("analyze_structure")["shared_model_sha256"] === record.shared_model.sha256, analysed_snapshot_manifest_equal: aOut(ACQUIRE_STEP_KEY)["manifest_sha256"] === record.snapshot.manifest_sha256 };

    // C2 across snapshots: the same repository at ANOTHER commit, with the demo contract shifted down three lines
    if (record.shared_hypothesis) {
      const other = await demoEnvironment({ commit: "a".repeat(40), shiftLines: 3 });
      try {
        const o = await createRepositoryResearchRun(db.pool, { repository: T.repository, ref: "a".repeat(40) }, "c1c3-demo", { structuralAnalysis: true, slitherScan: true });
        await driveRun(db, o.runId, other.source, other.tools, "c1c3-shifted-worker");
        const history = await leadHistory(db.ownerPool, T.repository, record.shared_hypothesis.lead_key);
        record.cross_snapshot = { lead_key: record.shared_hypothesis.lead_key, occurrences: history.map((h) => ({ commit_sha: h.commit_sha, generator: h.generator, analysis_family: h.analysis_family })),
          note: "the same lead key at two commits of the same repository, from both generators, although the cited lines moved by three" };
      } finally { await other.close(); }
    }
    return { record, dossierMarkdown };
  } finally { await env.close(); blocked.cleanup(); }
}
