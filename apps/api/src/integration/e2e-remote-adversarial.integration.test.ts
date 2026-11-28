import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRepositoryResearchRun } from "../acquisition/step.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { startLoopbackGitHub, type LoopbackGitHub } from "../acquisition/testing/loopback-github.js";
import { buildDossier, renderDossierMarkdown, VALIDATOR_ID, type Dossier } from "../analysis/solidity/pipeline.js";
import { FOUNDRY_STEP_KEY, FOUNDRY_VERSION } from "../engine/capabilities.js";
import { runForgeTest } from "../engine/tools/foundry.js";
import { fakeTools } from "../engine/tools/testing/fake-tools.js";
import "../engine/tools/tool-host/register.js";
import { canonicalJson, ResearchStore, sha256Hex } from "../research-state.js";
import { WorkflowWorker } from "../worker.js";
import { expireLease, migratedTestDatabase, REPO_ROOT, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * ONE end-to-end adversarial scenario for option D with D1-D7: a worker in REMOTE mode with NO database credential, against a REAL API
 * process (server.ts) and a disposable database, over real HTTP, with the API's own GitHub source pointed at a loopback GitHub fake:
 *   hypothesis generation by the analysis step (the API) -> a forged validator `supports` from the compromised worker, refused -> the
 *   API's own validator verdicts -> an independent reproduction recorded by a different analysis family (evm-execution) -> the evidence
 *   linkage (hypothesis -> spans -> evaluations with families -> reproduction) -> the dossier (origin, supporting and contradicting
 *   evidence, validators with families, reproduction, assessment; no forged verdict) -> recovery (the worker is killed mid-challenge and
 *   the API is restarted mid-step; the run completes with no duplicated evaluation and the SAME dossier content hash as an uninterrupted
 *   run) -> a database-level independence refusal (R3a) of a self-evaluation inserted directly as the owner.
 *
 * REPRODUCTION: real pinned Foundry (forge 1.5.1 with solc) is NOT available in this environment, so the reproduction runs the forge
 * STAND-IN from engine/tools/testing (a shell script that prints a passing forge JSON result; it compiles nothing and executes no EVM).
 * The recorded evaluation says so in its rationale, which the dossier shows. A real Foundry reproduction remains UNPROVEN.
 */
vi.setConfig({ testTimeout: 420_000, hookTimeout: 120_000 });
const OPERATOR = randomBytes(36).toString("base64url");
const GH_TOKEN = "github_pat_" + "11ABCDEFG0" + "z".repeat(72);
const corpus = join(REPO_ROOT, "eval", "dev", "contracts");
const FILES = readdirSync(corpus).sort().map((f) => ({ path: `contracts/${f}`, content: readFileSync(join(corpus, f), "utf8") }));
const SWITCHES = { STRUCTURAL_ANALYSIS_ENABLED: "true" };
const STAND_IN = "STAND-IN, not real Foundry";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
type Proc = { code: Promise<number | null>; out: () => string; kill: (sig?: NodeJS.Signals) => void; pid: number };
function start(script: string, env: Record<string, string>): Proc {
  const child = spawn(`${REPO_ROOT}node_modules/.bin/tsx`, [`${REPO_ROOT}${script}`], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { out += c; });
  return { code: new Promise((resolve) => child.on("close", (c) => resolve(c))), out: () => out, kill: (sig = "SIGTERM") => { const tree = descendants(child.pid!); child.kill(sig); for (const p of tree) { try { process.kill(p, sig); } catch { /* gone */ } } }, pid: child.pid! };
}
const descendants = (pid: number): number[] => { try { const kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); return kids.flatMap((k) => [k, ...descendants(k)]); } catch { return []; } };
const until = async (what: string, f: () => Promise<boolean>, ms = 120_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(100); } };

describe.skipIf(skipIntegration)("E2E adversarial: remote worker without a database credential, real API process, forged verdict refused, API validators, independent reproduction (forge STAND-IN, not real Foundry), recovery, R3a refusal", () => {
  let db: TestDatabase; let gh: LoopbackGitHub; let dir = ""; const fixtures: GitFixture[] = []; const procs: Proc[] = [];
  const owner = () => db.ownerPool;
  const tools = fakeTools("ok");
  beforeAll(async () => { db = await migratedTestDatabase(); gh = await startLoopbackGitHub(); dir = mkdtempSync(join(tmpdir(), "e2e-remote-")); });
  afterAll(async () => { for (const p of procs) p.kill("SIGKILL"); await gh?.close(); tools.cleanup(); for (const f of fixtures) f.cleanup(); rmSync(dir, { recursive: true, force: true }); await db?.drop(); });

  const api = async (ports: { pub: number; priv: number }) => {
    const p = start("apps/api/src/server.ts", { NODE_ENV: "test", DATABASE_URL: db.url, API_BEARER_TOKEN: OPERATOR, HOST: "127.0.0.1", PORT: String(ports.pub), LOG_LEVEL: "warn",
      WORKER_API_ENABLED: "true", WORKER_API_HOST: "127.0.0.1", WORKER_API_PORT: String(ports.priv), WORKER_API_GITHUB_TEST_ORIGIN: gh.origin, GITHUB_TOKEN: GH_TOKEN });
    procs.push(p);
    await until("API health", async () => { try { return (await fetch(`http://127.0.0.1:${ports.pub}/health/live`)).ok; } catch { return false; } }, 60_000);
    return p;
  };
  /** a run with the analysis stages and one reproduction round (foundry_validate) BEFORE the dossier, so the dossier shows it */
  const newRun = async (repo: string) => {
    const gx = buildGitFixture(FILES, { owner: "acme", repo }); fixtures.push(gx); gh.add(gx);
    const { runId } = await createRepositoryResearchRun(owner(), { repository: `acme/${repo}`, ref: "main" }, "operator", { structuralAnalysis: true });
    await owner().query("UPDATE workflow_steps SET sequence = 4 WHERE workflow_run_id = $1 AND step_key = 'build_dossier'", [runId]);
    await owner().query("INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 3, 'evaluator', $3::jsonb)", [runId, FOUNDRY_STEP_KEY, JSON.stringify({ reproduction: "trusted-runner", target: "Bank2.cashOut" })]);
    return { runId, gx };
  };
  const mint = async (pub: number, runId: string) => {
    const r = await fetch(`http://127.0.0.1:${pub}/v1/research/runs/${runId}/worker-tokens`, { method: "POST", headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" }, body: JSON.stringify({ ttl_seconds: 3600, created_by: "operator@test" }) });
    expect(r.status).toBe(201); return (await r.json()) as { token: string; token_id: string };
  };
  /** the remote worker: a separate process whose ENTIRE environment is below; the token arrives in a file it unlinks */
  const worker = (priv: number, token: string, repo: string, gx: GitFixture, pauseBefore = "") => {
    const tokenFile = join(dir, `token-${randomUUID()}`); writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const spec = join(dir, `fixture-${repo}.json`); writeFileSync(spec, JSON.stringify({ owner: gx.owner, repo: gx.repo, files: FILES }));
    const env = { NODE_ENV: "test", WORKER_STORE: "api", WORKER_API_URL: `http://127.0.0.1:${priv}`, WORKER_API_TOKEN_FILE: tokenFile, ...SWITCHES, REMOTE_CHILD_FIXTURE: spec, REMOTE_CHILD_DEADLINE_MS: "300000",
      ...(pauseBefore ? { REMOTE_CHILD_PAUSE_BEFORE: pauseBefore, REMOTE_CHILD_PAUSE_FILE: join(dir, `pause-${repo}`) } : {}) };
    expect(Object.keys(env).filter((k) => /DATABASE|^PG|TOKEN$/.test(k))).toEqual([]); // no database credential, no token variable
    const p = start("apps/api/src/integration/remote-worker-child.ts", env); procs.push(p); return p;
  };
  const steps = async (runId: string) => (await owner().query<{ id: string; step_key: string; status: string; attempt: number }>("SELECT id, step_key, status, attempt FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [runId])).rows;
  const stepOf = async (runId: string, key: string) => (await steps(runId)).find((s) => s.step_key === key)!;
  const snapOf = async (runId: string) => (await owner().query<{ id: string; manifest_sha256: string }>("SELECT id, manifest_sha256 FROM repo_snapshots WHERE workflow_run_id = $1", [runId])).rows[0]!;
  const hypothesisOf = async (runId: string, fn: string) => (await owner().query<{ id: string }>("SELECT id FROM hypotheses WHERE workflow_run_id = $1 AND claim LIKE $2", [runId, `${fn}%`])).rows[0]!.id;
  const workerCall = async (priv: number, token: string, op: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${priv}/internal/worker/v1/${op}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };

  /**
   * The reproduction, on the TRUSTED side: an attended runner with the owner connection (never the remote worker), against the run's
   * sealed snapshot, with the forge STAND-IN. Recorded as `foundry-forge` (analysis family evm-execution) with its provenance.
   */
  async function trustedReproduction(runId: string, target: string): Promise<string> {
    const runner = new WorkflowWorker(owner(), "trusted-reproduction-runner", 120, 1);
    const step = (await runner.claimNext([FOUNDRY_STEP_KEY], runId))!; expect(step.step_key).toBe(FOUNDRY_STEP_KEY);
    const snap = await snapOf(runId);
    const files = (await owner().query<{ path: string; content: Buffer }>(`SELECT f.path, b.content FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.snapshot_id = $1 AND f.path LIKE '%.sol' ORDER BY f.path COLLATE "C"`, [snap.id])).rows;
    const test = { path: "test/Repro.t.sol", content: Buffer.from("// reproduces Bank2.cashOut re-entrancy (run here by the forge STAND-IN only)\ncontract Repro { function test_reentrancy_cashOut() public {} }\n") };
    const run = await runForgeTest({ files, test: { files: [test], matchTest: "test_reentrancy_cashOut" }, forgeBin: tools.forge("pass"), solcBin: tools.solc });
    if (!run.ok) throw new Error(`stand-in failed: ${run.failure.code}`);
    expect(run.version).toBe(FOUNDRY_VERSION); expect(run.results.every((r) => r.passed)).toBe(true);
    const inputSha256 = sha256Hex(`${snap.manifest_sha256}|${run.testSha256}|test_reentrancy_cashOut|demonstrate`);
    const primary = (await owner().query<{ span_id: string }>("SELECT span_id FROM hypothesis_evidence WHERE hypothesis_id = $1 ORDER BY (role = 'primary') DESC, span_id LIMIT 1", [target])).rows[0]!.span_id;
    const rationale = `${STAND_IN}: the forge stand-in from engine/tools/testing printed a passing result for ${run.results.map((r) => r.test).join(", ")} against the sealed snapshot. Nothing was compiled and no EVM executed; this exercises the recording path only, and a real Foundry reproduction of this lead remains UNPROVEN.`;
    const output = Buffer.from(canonicalJson({ schema: "agentsmith-validator-output/1", validator_id: "foundry-forge", validator_version: FOUNDRY_VERSION, analysis_family: "evm-execution", method: "compiled-test-execution",
      input_sha256: inputSha256, snapshot_id: snap.id, hypothesis_id: target, ran_by: "trusted-runner", stand_in: true, outcome: "supports", raw: { version: run.version, results: run.results, raw_output_sha256: run.rawOutputSha256 } }), "utf8");
    const lease = { stepId: step.id, workerId: "trusted-reproduction-runner" };
    const id = await new ResearchStore(owner()).recordEvaluation(lease, { hypothesisId: target, evaluatorId: "foundry-forge", evaluatorVersion: FOUNDRY_VERSION, outcome: "supports", rationale, spanIds: [primary], inputSha256,
      provenance: { recordedBy: "trusted-runner", snapshotId: snap.id, analysisFamily: "evm-execution", method: "compiled-test-execution", output } });
    await runner.complete(step.id, { status: "validated", stand_in: true, note: STAND_IN, evaluation_id: id, snapshot_id: snap.id });
    return id;
  }

  it("the full scenario (reproduction by the forge STAND-IN, not real Foundry)", async () => {
    const ports = { pub: await freePort(), priv: await freePort() };
    let apiProc = await api(ports);

    // ---------------- the uninterrupted reference run ----------------
    const ref = await newRun("e2e-reference"); const refTok = await mint(ports.pub, ref.runId);
    const refWorker = worker(ports.priv, refTok.token, "e2e-reference", ref.gx);
    await until("reference challenge", async () => (await stepOf(ref.runId, "challenge_leads")).status === "succeeded");
    await trustedReproduction(ref.runId, await hypothesisOf(ref.runId, "Bank2.cashOut"));
    const refCode = await Promise.race([refWorker.code, sleep(60_000).then(() => -1)]);
    expect(refCode, `${refWorker.out().slice(-4000)}\nAPI:\n${apiProc.out().slice(-3000)}\nSTEPS:${JSON.stringify(await steps(ref.runId))}`).toBe(0);
    const reference = await buildDossier(owner(), new ResearchStore(owner()), (await snapOf(ref.runId)).id);

    // ---------------- the attacked and interrupted run ----------------
    const x = await newRun("e2e-attacked"); const tok = await mint(ports.pub, x.runId);
    const w1 = worker(ports.priv, tok.token, "e2e-attacked", x.gx, "challenge_leads");
    const pause = join(dir, "pause-e2e-attacked");
    await until("worker paused before challenge", async () => existsSync(pause));
    expect(w1.out()).toContain('"environ_has_token":false'); expect(w1.out()).toContain('"token_file_removed":true');
    for (const pid of [w1.pid, ...descendants(w1.pid)]) expect(readFileSync(`/proc/${pid}/environ`, "utf8")).not.toContain(tok.token);

    // (1) hypothesis generation BY THE ANALYSIS STEP, which the API ran itself on the verified snapshot
    const snap = await snapOf(x.runId);
    const verification = (await owner().query("SELECT verifier, resolved_commit, files_total, files_matched FROM snapshot_verifications WHERE snapshot_id = $1", [snap.id])).rows[0];
    expect(verification).toMatchObject({ verifier: "api-github", resolved_commit: x.gx.commitSha }); expect(verification.files_matched).toBe(verification.files_total);
    const analyze = await stepOf(x.runId, "analyze_structure");
    expect((await owner().query("SELECT output->>'derived_by' AS d FROM workflow_steps WHERE id = $1", [analyze.id])).rows[0].d).toBe("api");
    const hyps = (await owner().query<{ id: string; claim: string; generator_id: string; produced_by_step_id: string }>("SELECT id, claim, generator_id, produced_by_step_id FROM hypotheses WHERE workflow_run_id = $1", [x.runId])).rows;
    expect(hyps.length).toBe(18); expect(hyps.every((h) => h.generator_id === "solidity-structural-specialists" && h.produced_by_step_id === analyze.id)).toBe(true);
    const target = await hypothesisOf(x.runId, "Bank2.cashOut"); const weak = await hypothesisOf(x.runId, "Bank.withdrawBad");

    // (2) the compromised worker forges a `supports` under the validator's id, on the step it holds: refused, recorded nowhere
    const challengeId = readFileSync(pause, "utf8").trim();
    const primaryWeak = (await owner().query<{ span_id: string }>("SELECT span_id FROM hypothesis_evidence WHERE hypothesis_id = $1 AND role = 'primary'", [weak])).rows[0]!.span_id;
    const FORGED = "Executed model: reentrancy validated, exploit confirmed (FORGED by the compromised worker)";
    const forged = await workerCall(ports.priv, tok.token, "record_evaluation", { step_id: challengeId, hypothesis_id: weak, evaluator_id: VALIDATOR_ID, evaluator_version: "1", outcome: "supports", rationale: FORGED, span_ids: [primaryWeak], input_sha256: sha256Hex("forged") });
    expect([forged.status, forged.json.error]).toEqual([403, "evaluations_are_api_derived"]);
    const forgedComplete = await workerCall(ports.priv, tok.token, "complete", { step_id: challengeId, output: { status: "leads_challenged", snapshot_id: snap.id, reentrancy_verdicts: { validated: 18 } } });
    expect([forgedComplete.status, forgedComplete.json.error]).toEqual([422, "output_rejected"]);
    expect(Number((await owner().query("SELECT count(*) FROM hypothesis_evaluations WHERE workflow_run_id = $1", [x.runId])).rows[0].count)).toBe(0);

    // (7) recovery: the worker is KILLED mid-challenge (holding the lease); its last request is in flight when the API is killed too
    w1.kill("SIGKILL"); await w1.code;
    const inFlight = workerCall(ports.priv, tok.token, "complete", { step_id: challengeId, output: { status: "leads_challenged", snapshot_id: snap.id } }).catch(() => ({ status: 0, json: {} }));
    await sleep(40); apiProc.kill("SIGKILL"); await apiProc.code; await inFlight;
    apiProc = await api(ports); // the API restarts on the same ports
    if ((await stepOf(x.runId, "challenge_leads")).status === "running") await expireLease(owner(), challengeId);
    const w2 = worker(ports.priv, tok.token, "e2e-attacked", x.gx); // a fresh worker process, same run token (re-delivered in a new file)
    await until("attacked challenge", async () => (await stepOf(x.runId, "challenge_leads")).status === "succeeded");
    // (3) the API ran the validators itself and recorded its own verdicts, one per lead, each with provenance
    const evals = (await owner().query<{ hypothesis_id: string; evaluator_id: string; outcome: string; rationale: string; recorded_by: string; analysis_family: string }>(
      `SELECT e.hypothesis_id, e.evaluator_id, e.outcome, e.rationale, p.recorded_by, p.analysis_family FROM hypothesis_evaluations e JOIN evaluation_provenance p ON p.evaluation_id = e.id WHERE e.workflow_run_id = $1`, [x.runId])).rows;
    expect(evals.length).toBe(hyps.length); expect(evals.every((e) => e.recorded_by === "api")).toBe(true);
    expect(evals.find((e) => e.hypothesis_id === target)).toMatchObject({ evaluator_id: VALIDATOR_ID, outcome: "supports", analysis_family: "agentsmith-solidity-parser" });
    expect(evals.find((e) => e.hypothesis_id === weak)).toMatchObject({ evaluator_id: VALIDATOR_ID, outcome: "weakens" }); // the API's verdict, not the forged one
    expect(evals.some((e) => e.rationale === FORGED)).toBe(false);
    // (4) the independent reproduction by ANOTHER analysis family (evm-execution), recorded by the trusted side
    const repro = await trustedReproduction(x.runId, target);
    const w2code = await Promise.race([w2.code, sleep(60_000).then(() => -1)]);
    expect(w2code, `${w2.out().slice(-4000)}\nAPI:\n${apiProc.out().slice(-3000)}\nSTEPS:${JSON.stringify(await steps(x.runId))}`).toBe(0);
    expect(w2.out()).toContain('"stop":"run_finished"'); expect(w2.out()).toContain('"db_env_present":[]');
    expect((await steps(x.runId)).map((s) => `${s.step_key}:${s.status}`)).toEqual(["acquire_repository:succeeded", "analyze_structure:succeeded", "challenge_leads:succeeded", "foundry_validate:succeeded", "build_dossier:succeeded"]);

    // no duplicated evaluation anywhere, despite the kills and the restart
    expect((await owner().query("SELECT hypothesis_id, evaluator_id, count(*) FROM hypothesis_evaluations WHERE workflow_run_id = $1 GROUP BY 1, 2 HAVING count(*) > 1", [x.runId])).rows).toEqual([]);
    expect(Number((await owner().query("SELECT count(*) FROM hypothesis_evaluations WHERE workflow_run_id = $1", [x.runId])).rows[0].count)).toBe(hyps.length + 1);

    // (5) the evidence linkage: hypothesis -> spans -> evaluations (with families and their relation to the generator) -> reproduction
    const linkage = (await owner().query<{ path: string; line_start: number; evaluator_id: string; outcome: string; evaluator_family: string; relation: string }>(
      `SELECT s.path, s.line_start, x.evaluator_id, x.outcome, x.evaluator_family, x.relation
         FROM hypothesis_evidence he JOIN evidence_spans s ON s.id = he.span_id
         JOIN evaluation_independence x ON x.hypothesis_id = he.hypothesis_id
        WHERE he.hypothesis_id = $1 AND he.role = 'primary' ORDER BY x.evaluator_id`, [target])).rows;
    expect(linkage.map((l) => [l.path, l.evaluator_id, l.outcome, l.evaluator_family, l.relation])).toEqual([
      ["contracts/Bank2.sol", "foundry-forge", "supports", "evm-execution", "cross_family"],
      ["contracts/Bank2.sol", VALIDATOR_ID, "supports", "agentsmith-solidity-parser", "same_family"]]);
    const cited = (await owner().query("SELECT count(*)::int AS n FROM evaluation_evidence ee JOIN hypothesis_evidence he ON he.span_id = ee.span_id AND he.hypothesis_id = $1 WHERE ee.evaluation_id = $2", [target, repro])).rows[0].n;
    expect(cited).toBe(1); // the reproduction cites the hypothesis's own primary span
    expect((await owner().query("SELECT independently_supported, corroborated_same_family, cross_family_supports, same_family_supports FROM hypothesis_independence WHERE hypothesis_id = $1", [target])).rows[0])
      .toEqual({ independently_supported: true, corroborated_same_family: true, cross_family_supports: 1, same_family_supports: 1 });

    // (6) the dossier, built by the API from stored records
    const d: Dossier = await buildDossier(owner(), new ResearchStore(owner()), snap.id);
    const e = d.entries.find((x2) => x2.hypothesis_id === target)!;
    expect(e.origin).toEqual({ generator: "solidity-structural-specialists@1", generator_kind: "deterministic_rule", analysis_family: "agentsmith-solidity-parser", method: "structural-pattern-rules" });
    expect(e.validators.map((v) => [v.evaluator, v.analysis_family, v.relation, v.outcome])).toEqual([[`foundry-forge@${FOUNDRY_VERSION}`, "evm-execution", "cross-family", "supports"], [`${VALIDATOR_ID}@1`, "agentsmith-solidity-parser", "same-family", "supports"]]);
    expect(e.supporting_evidence.map((s) => [s.evaluator.replace(/@.*$/, ""), s.analysis_family, s.relation])).toEqual([["foundry-forge", "evm-execution", "cross-family"], [VALIDATOR_ID, "agentsmith-solidity-parser", "same-family"]]);
    expect(e.reproduction).not.toBe("none");
    expect((e.reproduction as Array<{ rationale: string }>)[0]!.rationale).toContain(STAND_IN);
    expect(e.assessment.verdict).toBe("supported_cross_family"); expect(e.assessment.text).toMatch(/NOT confirmed/);
    expect(e.provenance).toMatchObject({ claim: "api_derived" });
    expect(e.provenance.evaluations.map((v) => [v.evaluator, v.recorded_by])).toEqual([["foundry-forge", "trusted_runner"], [VALIDATOR_ID, "api_verified"]]);
    const w = d.entries.find((x2) => x2.hypothesis_id === weak)!;
    expect(w.contradicting_evidence.map((c) => [c.evaluator.replace(/@.*$/, ""), c.outcome])).toEqual([[VALIDATOR_ID, "weakens"]]);
    expect(w.supporting_evidence).toEqual([]); expect(w.assessment.verdict).toBe("weakened");
    const all = JSON.stringify(d); expect(all).not.toContain(FORGED); expect(all).not.toContain("FORGED");
    expect(d.provenance).toMatchObject({ snapshot: { status: "api_verified_against_github", resolved_commit: x.gx.commitSha }, analysis: "api_derived", challenge: "api_derived", external_tools: "none" });
    const md = renderDossierMarkdown(d);
    expect(md).toContain(STAND_IN); expect(md).toMatch(/API-VERIFIED against GitHub/); expect(md).not.toContain("FORGED");
    // ... and the SAME content as the uninterrupted run (another run of the same commit): the kills and the restart left no trace
    expect(d.content_sha256).toBe(reference.content_sha256);
    const stored = (await owner().query("SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = 'build_dossier'", [x.runId])).rows[0].output;
    expect(stored).toMatchObject({ content_sha256: d.content_sha256, derived_by: "api" });

    // (8) the database itself refuses a self-evaluation, even inserted directly as the OWNER (R3a, migration 0016)
    const h = (await owner().query("SELECT workflow_run_id, produced_by_step_id, generator_id FROM hypotheses WHERE id = $1", [target])).rows[0];
    await expect(owner().query(`INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256) VALUES ($1,$2,$3,$4,'1','supports','self-confirmation',$5)`,
      [h.workflow_run_id, target, h.produced_by_step_id, h.generator_id, sha256Hex("self")])).rejects.toThrow(/cannot be made by the generator of its hypothesis/);
    apiProc.kill(); await apiProc.code;
    if (existsSync(pause)) unlinkSync(pause);
  });

  it("cancellation and revocation stop a remote worker cleanly (exit 78 and 77), with nothing written after, and never print the token", async () => {
    const ports = { pub: await freePort(), priv: await freePort() };
    const apiProc = await api(ports);
    for (const how of ["cancel", "revoke"] as const) {
      const r = await newRun(`e2e-${how}`); const t = await mint(ports.pub, r.runId);
      const w = worker(ports.priv, t.token, `e2e-${how}`, r.gx, "analyze_structure");
      const pause = join(dir, `pause-e2e-${how}`);
      await until(`paused (${how})`, async () => existsSync(pause));
      const before = { hyp: Number((await owner().query("SELECT count(*) FROM hypotheses WHERE workflow_run_id = $1", [r.runId])).rows[0].count), accepted: Number((await owner().query("SELECT count(*) FROM audit_events WHERE action = 'worker_api.accepted' AND payload->>'token_id' = $1", [t.token_id])).rows[0].count) };
      if (how === "cancel") await owner().query("UPDATE workflow_runs SET status = 'cancelled', completed_at = now() WHERE id = $1", [r.runId]);
      else expect((await fetch(`http://127.0.0.1:${ports.pub}/v1/research/worker-tokens/${t.token_id}/revoke`, { method: "POST", headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" }, body: "{}" })).status).toBe(200);
      unlinkSync(pause); // the worker resumes: its next call is refused, and it stops
      const code = await Promise.race([w.code, sleep(60_000).then(() => -1)]);
      expect(code, w.out()).toBe(how === "cancel" ? 78 : 77);
      expect(w.out()).toContain(how === "cancel" ? '"stop":"run_cancelled"' : '"stop":"token_rejected"');
      expect(w.out()).not.toContain(t.token.slice(38));
      expect(Number((await owner().query("SELECT count(*) FROM hypotheses WHERE workflow_run_id = $1", [r.runId])).rows[0].count)).toBe(before.hyp);
      expect(Number((await owner().query("SELECT count(*) FROM audit_events WHERE action = 'worker_api.accepted' AND payload->>'token_id' = $1", [t.token_id])).rows[0].count)).toBe(before.accepted);
      expect((await stepOf(r.runId, "analyze_structure")).status).toBe("running"); // never completed; recovered by lease expiry, not by the worker
    }
    expect(apiProc.out()).not.toMatch(/wct1_[0-9a-f]{32}_[A-Za-z0-9_-]{20,}/);
    apiProc.kill(); await apiProc.code;
  });
});
