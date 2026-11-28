import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEPENDENCY_STEP_KEY } from "../acquisition/dependencies.js";
import { createRepositoryResearchRun } from "../acquisition/step.js";
import { ANALYZE_STEP_KEY } from "../analysis/solidity/keys.js";
import { SHARED_MODEL_SCHEMA, verifySharedModel, readSharedModelOfRun } from "../analysis/solidity/shared-model.js";
import { ApexShadowRefused, APEX_SHADOW_TARGET as T } from "../apex/shadow-target.js";
import { usxScope } from "../apex/testing/usx-like.js";
import { buildApp } from "../app.js";
import { AuthFailureLimiter } from "../auth.js";
import { RunTerminalError, WorkerApiClient, WorkerApiRefusedError } from "../worker-api-client.js";
import { executeRemoteStep, remoteStepKeys } from "../worker-remote.js";
import { mintWorkerToken } from "../worker-tokens.js";
import { intakeStepKeys } from "../worker-runtime.js";
import { createDemoRun, DEMO_APPROVER, DEMO_SHADOW, demoEnvironment, runC1C3Demonstration, stepsOf, type DemoEnvironment, type DemoRecord } from "./c1c3-demo.js";
import { buildBlockedFixture, PINS } from "./c1c3-fixtures.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * C1 (one shared protocol model, read by hash), C2 (shared lead identity) and C3 (dependency acquisition), demonstrated end to end on
 * controlled local fixtures inside the EXISTING repository_research workflow, in direct (db) mode and in remote (api) mode. Slither is a
 * labelled stand-in printing authored output; nothing is fetched from the network; the production APEX eligibility check is unchanged.
 */
vi.setConfig({ testTimeout: 300_000, hookTimeout: 600_000 });
const HEX = /^[0-9a-f]{64}$/;
let direct: DemoRecord | null = null;

describe.skipIf(skipIntegration)("C1-C3 demonstration, direct (db) mode", () => {
  let db: TestDatabase; let rec: DemoRecord; let markdown = "";
  beforeAll(async () => { db = await migratedTestDatabase(); const r = await runC1C3Demonstration(db); rec = r.record; markdown = r.dossierMarkdown; direct = rec; });
  afterAll(async () => { await db?.drop(); });

  it("the run is the existing workflow with the optional stages, and every step succeeded", () => {
    expect(rec.run.steps.map((s) => s.step)).toEqual(["acquire_repository", "acquire_dependencies", "analyze_structure", "slither_scan", "challenge_leads", "build_dossier", "apex_shadow"]);
    expect(rec.run.steps.map((s) => s.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rec.run.steps.every((s) => s.status === "succeeded")).toBe(true); expect(rec.run.status).toBe("succeeded");
  });

  it("1. structural analysis produces ONE shared protocol model: every section has an explicit status, and uncomputed ones say why", () => {
    expect(rec.shared_model.sha256).toMatch(HEX); expect(rec.shared_model.schema).toBe(SHARED_MODEL_SCHEMA);
    expect(Object.keys(rec.shared_model.sections).sort()).toEqual(["actors_permissions", "assets_accounting", "contracts", "external_dependencies", "functions", "invariants", "state", "unresolved_questions", "unsupported_features", "upgradeability"]);
    expect(rec.shared_model.sections).toMatchObject({ contracts: "computed:parsed", functions: "computed:derived", state: "computed:derived", actors_permissions: "computed:derived", external_dependencies: "computed:parsed",
      upgradeability: "computed:parsed", unsupported_features: "computed:parsed", unresolved_questions: "computed:unknown", assets_accounting: "not_computed", invariants: "not_computed" });
    // nothing claims to be verified or understood: no section is `verified`
    expect(Object.values(rec.shared_model.sections).some((s) => /verified/.test(s))).toBe(false);
    for (const n of rec.shared_model.not_computed) expect(n.reason.length, n.section).toBeGreaterThan(20);
    expect(rec.shared_model.not_computed.map((n) => n.section)).toEqual(expect.arrayContaining(["assets_accounting", "invariants", "actors_permissions.actors"]));
    // the new sections hold real facts, each with its own status and location
    expect(rec.shared_model.facts["state.variables"]).toBeGreaterThan(5);
    expect(rec.shared_model.example_facts["state"]).toMatchObject({ epistemic: "derived", component: "SharedVault", variable: "balances", writers: expect.arrayContaining([expect.objectContaining({ function: "SharedVault.withdraw()", entry_point: true, caller_guarded: false })]) });
    expect(rec.shared_model.example_facts["actors_permissions"]).toMatchObject({ epistemic: "derived", function: "SharedVault.configure(address)", caller_guarded: expect.any(Boolean), at: [expect.objectContaining({ file: "src/demo/SharedVault.sol" })] });
    expect(rec.shared_model.example_facts["external_dependencies.external_call"]).toMatchObject({ epistemic: "parsed", from: "SharedVault.withdraw()", kind: "low-level-call", target: "msg.sender" });
    expect(rec.shared_model.example_facts["external_dependencies.import"]).toMatchObject({ resolution: "dependency", dependency: "lib/vault-lib", resolved_path: "lib/vault-lib/src/VaultMath.sol", path: "vault-lib/VaultMath.sol" });
    expect(rec.shared_model.facts["upgradeability.markers"]).toBeGreaterThan(0);
  });

  it("2-3. the Slither stage, the challenge stage, the dossier and the APEX shadow all read THAT model by hash, and record the hash", () => {
    const h = rec.shared_model.sha256;
    for (const [who, r] of Object.entries(rec.model_hash_read_by)) expect(r.sha256, who).toBe(h);
    expect(rec.all_consumers_read_the_same_model).toBe(true);
    for (const who of ["slither_scan", "challenge_leads", "build_dossier", "apex_shadow"]) expect(rec.model_hash_read_by[who]!.read, who).toBe("by_hash");
    // each consumer USED it: the challenge checked every source against the model's inputs; APEX matched its in-scope inputs and compared its gate with the model's prediction
    expect(rec.model_hash_read_by["challenge_leads"]!.detail).toMatchObject({ inputs_checked: expect.any(Number), leads_on_modelled_functions: expect.any(Number) });
    const apex = rec.model_hash_read_by["apex_shadow"]!.detail as { inputs_matched: number; inputs_total: number; gate_vs_model: { predicted_and_observed: string[] } };
    expect(apex.inputs_total).toBe(T.inScopePaths.length); expect(apex.inputs_matched).toBe(apex.inputs_total);
    expect(apex.gate_vs_model.predicted_and_observed.length).toBeGreaterThan(0);
    // Slither (a labelled stand-in) got the remappings and the dependency source the manifest provides
    expect(rec.slither).toMatch(/STAND-IN/); expect(rec.slither_stage.status).toBe("tool_completed");
    expect(rec.slither_stage.remappings_passed).toEqual(["vault-lib/=lib/vault-lib/src/", "demo/=src/demo/"]);
    expect(rec.slither_stage.arguments_seen.some((a) => a.includes("--solc-remaps vault-lib/=lib/vault-lib/src/ demo/=src/demo/"))).toBe(true);
    expect(rec.slither_stage.dependency_source_on_disk).toBe(true); expect(rec.slither_stage.dependency_files).toBeGreaterThan(0);
    // APEX ran as a measurement only: recorded, labelled, and it wrote no hypothesis
    expect(rec.apex_shadow.status).toBe("apex_shadow_recorded"); expect(rec.apex_shadow.label).toMatch(/unvalidated, not evidence/); expect(rec.apex_shadow.hypotheses_written).toBe(0);
  });

  it("4-5. two engines contribute to ONE investigation; their evidence stays separately attributable; nothing is counted twice", () => {
    const inv = rec.shared_hypothesis!; expect(inv).not.toBeNull();
    expect(inv.keyed).toBe(true); expect(inv.lead_key).toMatch(HEX);
    expect(inv.anchor).toEqual({ repository: T.repository, class: "reentrancy", file: "src/demo/SharedVault.sol", contract: "SharedVault", function: "withdraw" });
    expect(inv.contributions).toHaveLength(2);
    const spec = inv.contributions.find((c) => c.generator === "solidity-structural-specialists@1")!; const sl = inv.contributions.find((c) => c.generator === "slither@0.11.3")!;
    expect(spec.hypothesis_id).not.toBe(sl.hypothesis_id); // two rows, never merged
    expect([spec.analysis_family, sl.analysis_family]).toEqual(["agentsmith-solidity-parser", "slither-ir"]);
    expect([spec.produced_by_step, sl.produced_by_step]).toEqual(["analyze_structure", "slither_scan"]);
    expect(spec.evidence.length).toBeGreaterThan(0); expect(sl.evidence.length).toBeGreaterThan(0); expect(spec.evidence).not.toEqual(sl.evidence);
    expect(inv.independent_generation).toBe(true); expect(inv.generator_families).toEqual(["agentsmith-solidity-parser", "slither-ir"]);
    // the validator's support: same-family for the specialists' hypothesis; cross-family for Slither's, but NOT independent of the investigation
    const e1 = spec.evaluations.find((e) => e.evaluator.startsWith("reentrancy-execution-validator"))!; const e2 = sl.evaluations.find((e) => e.evaluator.startsWith("reentrancy-execution-validator"))!;
    expect([e1.outcome, e1.relation, e1.relation_to_investigation]).toEqual(["supports", "same-family", "same-family"]);
    expect([e2.outcome, e2.relation, e2.relation_to_investigation]).toEqual(["supports", "cross-family", "same-family"]);
    expect(inv.corroboration).toEqual({ same_family: 2, cross_family: 0, unknown_family: 0 }); expect(inv.assessment).toBe("corroborated_same_family");
    // counts: every hypothesis is still listed, each investigation once
    expect(rec.dossier.entries).toBe(rec.investigation_summary.hypotheses); expect(rec.dossier.investigations).toBe(rec.investigation_summary.investigations);
    expect(rec.investigation_summary.multi_engine).toBe(2); expect(rec.dossier.entries - rec.dossier.investigations).toBe(2);
    expect(rec.dossier.step_output_leads).toBe(rec.dossier.investigations); expect(rec.dossier.step_output_hypotheses).toBe(rec.dossier.entries);
    expect(markdown).toMatch(/## Investigations \(shared lead identity\)/); expect(markdown).toMatch(/counted ONCE/);
    expect(markdown).toMatch(/## Shared protocol model/); expect(markdown).toMatch(/NOT COMPUTED `assets_accounting`/);
  });

  it("5. a disagreement is recorded as a contradiction with both sides kept, and the independence rules hold unchanged", () => {
    const inv = rec.contradiction_case!; expect(inv).not.toBeNull();
    expect(inv.anchor).toMatchObject({ class: "access-control", contract: "SharedVault", function: "configure" });
    expect(inv.generators).toEqual(["slither@0.11.3", "solidity-structural-specialists@1"]); expect(inv.assessment).toBe("contradicted");
    const against = inv.contradictions.filter((c) => c.kind === "refuted_by_another_engine");
    expect(against.map((c) => c.for.engine).sort()).toEqual(["slither@0.11.3", "solidity-structural-specialists@1"]);
    for (const c of against) { expect(c.against.engine).toBe("execution-challenge-access-control@1"); expect(c.against.stance).toBe("contradicts"); expect(c.for.stance).toBe("asserts"); expect(c.note).toMatch(/Both records are kept/); }
    // Slither (slither-ir) asserts; the AgentSmith validator (parser family) executed a counterexample: both records exist
    expect(against.find((c) => c.for.engine === "slither@0.11.3")).toMatchObject({ for: { analysis_family: "slither-ir" }, against: { analysis_family: "agentsmith-solidity-parser" }, families: "cross-family" });
    expect(against.find((c) => c.for.engine === "solidity-structural-specialists@1")!.families).toBe("same-family");
    expect(inv.contributions.every((c) => c.claim.length > 10)).toBe(true); expect(inv.contributions).toHaveLength(2);
    // 0016 unchanged: an engine never validates its own hypothesis
    expect(rec.independence.self_evaluation_refused).toMatch(/refused by the database: an evaluation cannot be made by the generator of its hypothesis/);
    expect(rec.independence.relations.every((r) => !r.evaluator.startsWith(r.generator.split("@")[0]!))).toBe(true);
  });

  it("6. unsupported features and missing dependencies are explicit limitations, never silent", () => {
    const by = (code: string) => rec.dependencies.limitations.filter((l) => l.code === code).map((l) => l.subject);
    expect(by("disallowed_host")).toEqual(["lib/gitlab-lib"]); expect(by("unpinned")).toEqual(["lib/unpinned"]); expect(by("unavailable")).toEqual(["lib/ghost"]);
    expect(by("missing_url")).toEqual(["lib/no-url"]); expect(by("nested_depth_exceeded")).toEqual(["lib/vault-lib/lib/nested-lib/lib/deeper"]);
    expect(by("package_not_acquired")).toEqual(["@openzeppelin/contracts"]); expect(by("remapping_target_missing")).toEqual(["ghost/=lib/ghost/src/"]);
    for (const l of rec.dependencies.limitations) expect(l.reason.length, l.code).toBeGreaterThan(15);
    const status = Object.fromEntries(rec.dependencies.records.map((d) => [d.path, d.status]));
    expect(status).toEqual({ "lib/ghost": "unavailable", "lib/gitlab-lib": "disallowed_host", "lib/no-url": "missing_url", "lib/unpinned": "unpinned", "lib/vault-lib": "acquired", "lib/vault-lib/lib/nested-lib": "acquired", "lib/vault-lib/lib/nested-lib/lib/deeper": "nested_depth_exceeded" });
    // an unpinned submodule has no commit at all and was never fetched; a pinned one records how the pin was established
    const unpinned = rec.dependencies.records.find((d) => d.path === "lib/unpinned")!; expect([unpinned.pinned_commit, unpinned.pin_established_by, unpinned.snapshot_id]).toEqual([null, null, null]);
    expect(rec.dependencies.records.find((d) => d.path === "lib/gitlab-lib")).toMatchObject({ pinned_commit: PINS.gitlab, snapshot_id: null, source_url: null });
    expect(rec.dependencies.packages.map((p) => [p.name, p.status, p.pin_established_by])).toEqual([["@openzeppelin/contracts", "pinned_not_acquired", "package-lock.json integrity"], ["unpinned-pkg", "unavailable", null]]);
    // the APEX gate's unsupported features: the model's prediction and the gate's own abstentions, side by side, each with provenance
    const u = rec.unsupported_features;
    expect(u.predicted.status).toBe("computed"); expect(u.predicted.epistemic).toBe("parsed"); expect(u.predicted.total).toBeGreaterThan(0);
    expect(u.gate.status).toBe("computed");
    if (u.gate.status === "computed") { expect(Object.keys(u.gate.by_feature).length).toBeGreaterThan(0); expect(u.gate.provenance).toMatchObject({ analysis: "apex-fidelity-gate", reported_by: "worker", model_sha256_read: rec.shared_model.sha256 }); expect(u.gate.abstentions[0]).toMatchObject({ feature: expect.any(String), at: expect.stringMatching(/\.sol/) }); }
    expect(Object.keys(rec.apex_shadow.abstentions_by_feature).length).toBeGreaterThan(0);
    // a project whose sources import a missing and an unpinned dependency: Slither abstains and names the dependency
    const b = rec.blocked_run!;
    expect(b.slither_status).toBe("abstained"); expect(b.abstention).toMatchObject({ code: "dependency_unavailable" });
    expect((b.abstention as { detail: string }).detail).toMatch(/^cannot compile: dependency lib\/ghost unavailable \(dependency lib\/ghost is unavailable/);
    expect(b.unresolved_imports.map((i) => i.path).sort()).toEqual(["ghost/Ghost.sol", "unpinned/Thing.sol"]);
    expect(b.limitations.map((l) => l.code).sort()).toEqual(["remapping_target_missing", "remapping_target_missing", "unavailable", "unpinned"]);
    expect(b.dossier_coverage_status).toBe("partial"); // an abstaining tool never leaves the dossier "complete"
  });

  it("C3: dependencies are separate, linked, immutable snapshots; the analysed snapshot is unchanged; the set is reproducible", async () => {
    const pool = db.ownerPool;
    expect(rec.snapshot.dependency_snapshots.map((d) => d.repository)).toEqual(["acme-labs/nested-lib", "acme-labs/vault-lib"]);
    for (const d of rec.snapshot.dependency_snapshots) { expect(d.sealed).toBe(true); expect(d.dependency_of).toMatchObject({ root_repository: T.repository, root_commit_sha: T.commit, pin_established_by: "gitlink_in_parent_tree" }); }
    const vault = rec.dependencies.records.find((d) => d.path === "lib/vault-lib")!;
    expect(vault).toMatchObject({ pin_established_by: "gitlink_in_parent_tree", source_url: "https://github.com/acme-labs/vault-lib", repository: "acme-labs/vault-lib", depth: 1, parent: { repository: T.repository, commit_sha: T.commit, path_in_parent: "lib/vault-lib" } });
    expect(vault.tree_sha).toMatch(/^[0-9a-f]{40}$/); expect(vault.manifest_sha256).toMatch(HEX); expect(vault.pinned_commit).toMatch(/^[0-9a-f]{40}$/);
    // file hashes: every stored file of the dependency snapshot has its git object id and content hash
    const files = (await pool.query("SELECT path, blob_sha256, git_blob_sha FROM repo_snapshot_files WHERE snapshot_id = $1 AND blob_sha256 IS NOT NULL", [vault.snapshot_id])).rows;
    expect(files.map((f) => f.path).sort()).toEqual([".gitmodules", "README.md", "src/VaultMath.sol"]); for (const f of files) { expect(f.blob_sha256).toMatch(HEX); expect(f.git_blob_sha).toMatch(/^[0-9a-f]{40}$/); }
    // the analysed snapshot still records the submodule paths as skipped gitlinks: nothing was added to it
    const sub = (await pool.query("SELECT path, skip_reason, blob_sha256 FROM repo_snapshot_files WHERE snapshot_id = $1 AND path LIKE 'lib/%' ORDER BY path", [rec.snapshot.id])).rows;
    expect(sub).toEqual(["lib/ghost", "lib/gitlab-lib", "lib/no-url", "lib/vault-lib"].map((path) => ({ path, skip_reason: "submodule", blob_sha256: null })));
    expect((await pool.query("SELECT (verify_repo_snapshot($1)->>'ok')::boolean AS ok", [rec.snapshot.id])).rows[0].ok).toBe(true);
    // hypotheses exist only on the analysed snapshot: dependencies are outside the scope classification
    expect((await pool.query("SELECT count(*)::int AS n FROM hypotheses WHERE workflow_run_id = $1 AND snapshot_id <> $2", [rec.run.id, rec.snapshot.id])).rows[0].n).toBe(0);
    // reproducibility: a second run of the same parent commit gives the same dependency digest and the same model hash
    expect(rec.reproducibility).toMatchObject({ dependency_digest_equal: true, shared_model_sha256_equal: true, analysed_snapshot_manifest_equal: true });
    expect(rec.dependencies.digest).toMatch(HEX); expect(rec.dependencies.blob_sha256).toMatch(HEX);
  });

  it("C2 across snapshots: the same lead has the same key at another commit, although its lines moved", () => {
    const c = rec.cross_snapshot!; expect(c.lead_key).toBe(rec.shared_hypothesis!.lead_key);
    expect([...new Set(c.occurrences.map((o) => o.commit_sha))].sort()).toEqual([T.commit, "a".repeat(40)].sort());
    expect([...new Set(c.occurrences.map((o) => o.generator))].sort()).toEqual(["slither@0.11.3", "solidity-structural-specialists@1"]);
  });

  it("the model is read by hash or not at all: a wrong hash is refused, never repaired", async () => {
    const model = await readSharedModelOfRun(db.ownerPool, rec.run.id); expect(model.available).toBe(true);
    const json = JSON.stringify(model.available ? model.doc : null);
    expect(() => verifySharedModel({ sha256: "0".repeat(64), base_sha256: rec.shared_model.base_sha256, json })).toThrow(/does not match the hash it was read by/);
    expect(() => verifySharedModel({ sha256: rec.shared_model.sha256, base_sha256: "1".repeat(64), json })).toThrow(/names another base model/);
  });

  it("the production gates are unchanged: APEX only for the approved target, the dependency stage only on request and with its switch", async () => {
    await expect(createRepositoryResearchRun(db.pool, { repository: "acme-labs/blocked", ref: "b".repeat(40) }, "t", { structuralAnalysis: true, dependencies: true, bountyScope: usxScope(), apexShadow: { approvedBy: DEMO_APPROVER } })).rejects.toBeInstanceOf(ApexShadowRefused);
    const plain = await createRepositoryResearchRun(db.pool, { repository: "acme-labs/plain", ref: "main" }, "t", { structuralAnalysis: true });
    expect((await stepsOf(db, plain.runId)).map((s) => [s.step_key, s.sequence])).toEqual([["acquire_repository", 0], ["analyze_structure", 1], ["challenge_leads", 2], ["build_dossier", 3]]);
    expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true" })).not.toContain(DEPENDENCY_STEP_KEY);
    expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", DEPENDENCY_ACQUISITION_ENABLED: "1" })).not.toContain(DEPENDENCY_STEP_KEY);
    expect(intakeStepKeys({ DEPENDENCY_ACQUISITION_ENABLED: "true" })).toContain(DEPENDENCY_STEP_KEY);
    await db.ownerPool.query("UPDATE workflow_steps SET status = 'cancelled' WHERE workflow_run_id = $1 AND status = 'queued'", [plain.runId]);
    await db.ownerPool.query("UPDATE workflow_runs SET status = 'cancelled' WHERE id = $1", [plain.runId]);
  });
});

describe.skipIf(skipIntegration)("C1-C3 demonstration, remote (api) mode: the API derives the same model and dependency set itself", () => {
  let db: TestDatabase; let app: FastifyInstance; let base = ""; let env: DemoEnvironment; let runId = "";
  const OPERATOR = randomBytes(36).toString("base64url");
  const permissive = () => new AuthFailureLimiter({ perClientMax: 1e6, globalMax: 1e6, windowMs: 60_000 });
  const SW = { STRUCTURAL_ANALYSIS_ENABLED: "true", SLITHER_SCAN_ENABLED: "true", DEPENDENCY_ACQUISITION_ENABLED: "true" };
  beforeAll(async () => {
    db = await migratedTestDatabase(); env = await demoEnvironment();
    const blocked = buildBlockedFixture(); env.gh.add(blocked); env.fixtures.all.push(blocked);
    app = buildApp({ pool: db.ownerPool, apiBearerToken: OPERATOR, hubAllowedHosts: [], limiter: permissive(), engineInfo: { expectedMigrations: null }, workerApi: { reaperIntervalMs: 0, limiter: permissive(), github: env.source } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    runId = (await createDemoRun(db)).runId;
  });
  afterAll(async () => { await app?.close(); await env?.close(); await db?.drop(); });

  it("a remote worker with no database credential runs the whole chain; the API verifies every dependency and derives every output", async () => {
    const tok = await mintWorkerToken(db.ownerPool, { runId, createdBy: "operator@test" });
    const c = new WorkerApiClient({ baseUrl: base, token: tok.token, backoffMs: 1, attempts: 2 });
    const wenv = { ...SW, AGENTSMITH_SLITHER_BIN: env.tools.slither, AGENTSMITH_SOLC_BIN: env.tools.solc };
    expect(remoteStepKeys(wenv)).toContain(DEPENDENCY_STEP_KEY);
    let forged = false;
    // once the run has finished, the token is no longer valid: that is the end of the loop
    const next = () => c.claimNext(remoteStepKeys(wenv)).catch((e: unknown) => { if (e instanceof RunTerminalError) return null; throw e; });
    for (let s = await next(); s; s = await next()) {
      if (s.step_key === DEPENDENCY_STEP_KEY && !forged) {
        forged = true; c.scopeToStep(s.id); c.adoptStep(s);
        // a compromised worker cannot smuggle in a repository the parent tree does not pin, nor an unpinned ref
        const blocked = env.fixtures.all[env.fixtures.all.length - 1]!; const lease = { stepId: s.id, workerId: "x" };
        await expect(c.createSnapshot(lease, { repository: "acme-labs/blocked", commitSha: blocked.commitSha, refName: "main", acquisitionReport: { dependency_of: {} } })).rejects.toMatchObject({ code: "dependency_not_pinned" });
        const id = await c.createSnapshot(lease, { repository: "acme-labs/blocked", commitSha: blocked.commitSha, refName: blocked.commitSha, acquisitionReport: { dependency_of: { forged: "yes" } } });
        const sealing = await c.sealSnapshot(lease, id).then(() => null, (e: unknown) => e);
        expect(sealing).toBeInstanceOf(WorkerApiRefusedError); expect((sealing as WorkerApiRefusedError).code).toBe("dependency_not_pinned");
        c.scopeToStep(null);
      }
      await executeRemoteStep(c, "c1c3-remote", s, { source: env.source, env: wenv, heartbeatMs: 1000, shadow: DEMO_SHADOW });
    }
    expect(forged).toBe(true);
    const steps = await stepsOf(db, runId); const out = (k: string) => steps.find((s) => s.step_key === k)!.output!;
    expect(steps.map((s) => [s.step_key, s.status])).toEqual(["acquire_repository", "acquire_dependencies", "analyze_structure", "slither_scan", "challenge_leads", "build_dossier", "apex_shadow"].map((k) => [k, "succeeded"]));
    // the dependency manifest and the model are the API's own derivations, and equal the direct worker's BY DIGEST (another database, another mode)
    expect(out(DEPENDENCY_STEP_KEY)).toMatchObject({ status: "dependencies_resolved", derived_by: "api", worker_reported_failures: 0 }); // the API established lib/ghost's unavailability from GitHub itself
    expect(out(ANALYZE_STEP_KEY)["derived_by"]).toBe("api");
    expect(direct).not.toBeNull();
    expect(out(DEPENDENCY_STEP_KEY)["dependency_manifest_digest"]).toBe(direct!.dependencies.digest);
    expect(out(ANALYZE_STEP_KEY)["shared_model_sha256"]).toBe(direct!.shared_model.sha256);
    const h = out(ANALYZE_STEP_KEY)["shared_model_sha256"];
    expect(out("slither_scan")["protocol_model"].sha256).toBe(h); expect(out("challenge_leads")["protocol_model"].sha256).toBe(h); expect(out("build_dossier")["protocol_model"].sha256).toBe(h);
    expect(out("apex_shadow")["protocol_model"].sha256).toBe(h); expect(out("apex_shadow")["status"]).toBe("apex_shadow_recorded");
    // every dependency snapshot was verified against GitHub by the API before it was sealed; the forged one was never sealed
    const snaps = (await db.ownerPool.query(`SELECT s.repository, s.sealed_at IS NOT NULL AS sealed, (SELECT count(*)::int FROM snapshot_verifications v WHERE v.snapshot_id = s.id) AS verified FROM repo_snapshots s WHERE s.workflow_run_id = $1 ORDER BY s.repository`, [runId])).rows;
    expect(snaps).toEqual([{ repository: "acme-labs/blocked", sealed: false, verified: 0 }, { repository: "acme-labs/nested-lib", sealed: true, verified: 1 }, { repository: "acme-labs/vault-lib", sealed: true, verified: 1 }, { repository: T.repository, sealed: true, verified: 1 }]);
    // the Slither stage is worker-reported, but its lead keys are derived by the API, and the same two leads are shared
    expect(out("slither_scan")).toMatchObject({ reported_by: "worker", status: "tool_completed" });
    expect((out("slither_scan")["lead_keys"] as Array<{ lead_key: string }>).map((k) => k.lead_key)).toEqual(direct!.slither_stage.lead_keys);
    expect(out("build_dossier")).toMatchObject({ derived_by: "api", leads: direct!.dossier.investigations, hypotheses: direct!.dossier.entries });
    expect(out("build_dossier")["investigations"]).toMatchObject({ multi_engine: 2 });
  });

  it("a remote worker cannot complete the dependency stage with a set the API does not derive, nor name another model", async () => {
    const second = await createDemoRun(db, T.commit, false);
    const tok = await mintWorkerToken(db.ownerPool, { runId: second.runId, createdBy: "operator@test" });
    const c = new WorkerApiClient({ baseUrl: base, token: tok.token, backoffMs: 1, attempts: 2 });
    const wenv = { ...SW, AGENTSMITH_SLITHER_BIN: env.tools.slither, AGENTSMITH_SOLC_BIN: env.tools.solc };
    const acq = (await c.claimNext(remoteStepKeys(wenv)))!; await executeRemoteStep(c, "c1c3-remote-2", acq, { source: env.source, env: wenv, heartbeatMs: 1000 });
    const dep = (await c.claimNext(remoteStepKeys(wenv)))!; expect(dep.step_key).toBe(DEPENDENCY_STEP_KEY);
    const snapshotId = (await stepsOf(db, second.runId))[0]!.output!["snapshot_id"];
    await expect(c.complete(dep.id, { status: "dependencies_resolved", snapshot_id: snapshotId, dependency_manifest_digest: "f".repeat(64), failures: [] })).rejects.toMatchObject({ code: "output_rejected" });
    await expect(c.complete(dep.id, { status: "dependencies_resolved", snapshot_id: snapshotId, dependency_manifest_digest: "f".repeat(64), failures: [], manifest: {} })).rejects.toMatchObject({ code: "output_rejected" });
    expect((await stepsOf(db, second.runId))[1]!.status).toBe("running"); // nothing was stored for the forged completion
  });
});
