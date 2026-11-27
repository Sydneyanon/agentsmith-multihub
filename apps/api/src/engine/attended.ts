import { mkdirSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ACQUIRE_STEP_KEY, REPOSITORY_RESEARCH_WORKFLOW } from "../acquisition/step.js";
import { parseRepositoryName } from "../acquisition/github-source.js";
import { sealedSnapshot } from "../analysis/solidity/step.js";
import { MAX_SPAN_LINES, ResearchStore, sha256Hex } from "../research-state.js";
import { WorkflowWorker } from "../worker.js";
import { ATTENDED_CHALLENGE_STEP_KEY, ATTENDED_STEP_KEY, capabilityById, pinnedVersion, TRACKED_CLASSES, type Capability } from "./capabilities.js";
import { assertSideEffectAllowed } from "./effects.js";
import { assignmentSchema, type LeadRef } from "./steps.js";

/**
 * Attended specialists (T-203): Claude Code sub-agents run by a NAMED operator in an attended session. AgentSmith decides that one is
 * needed and creates the assignment (a T-149 `repository_research` run); the operator then:
 *   1. `brief`            prints exactly what the specialist is given: its method (prompt, hash-pinned), rules, targets, output schema;
 *   2. `export-snapshot`  writes the sealed snapshot's files (hash-checked) to a directory the specialist may read;
 *   3. runs the sub-agent in Claude Code with that brief (interactive; subscription; no API spend; never on a worker);
 *   4. `import-specialist` / `import-challenge` records the result.
 * Import is where AgentSmith keeps control: the output must match the schema, every finding must anchor to real lines of the sealed
 * snapshot (otherwise it is rejected and counted, never stored), claims are recorded as plane 1 under the specialist's own identity
 * ('attended_model'), and challenger verdicts are reviews, never evidence. Nothing here makes a finding confirmed.
 */
const location = z.object({ file: z.string().min(1).max(1000), line_start: z.number().int().min(1), line_end: z.number().int().min(1) }).strict();
const finding = z.object({
  title: z.string().min(3).max(300), class: z.string().min(2).max(100), contract: z.string().min(1).max(300), functions: z.array(z.string().max(300)).max(30).default([]),
  locations: z.array(location).min(1).max(10), mechanism: z.string().min(3).max(6000), attack_sequence: z.array(z.string().max(2000)).max(30).optional(),
  preconditions: z.array(z.string().max(2000)).max(30).default([]), impact: z.string().max(3000).default(""), confidence: z.enum(["high", "medium", "low"]),
  how_to_validate: z.string().max(3000).default(""),
}).passthrough();
export const specialistResultSchema = z.object({
  specialist: z.string().min(1).max(100),
  examined: z.object({ components: z.array(z.string().max(300)).max(500).default([]), classes: z.array(z.string().max(100)).max(50).default([]) }).passthrough().default({ components: [], classes: [] }),
  not_examined: z.array(z.object({ what: z.string().max(1000), why: z.string().max(2000) }).passthrough()).max(200).default([]),
  findings: z.array(finding).max(200).default([]),
  scope: z.object({ attack_surface: z.array(z.object({ rank: z.number().int().min(1).max(100), target: z.string().min(1).max(300), reason: z.string().max(2000).default(""), specialist: z.string().max(200).default("") }).passthrough()).max(50).default([]) }).passthrough().optional(),
}).passthrough();
export const challengeResultSchema = z.object({
  specialist: z.string().min(1).max(100),
  reviews: z.array(z.object({ claim: z.string().regex(/^C\d{2,4}$/), verdict: z.enum(["supports", "rejects", "needs_more_evidence", "inconclusive"]), reason: z.string().min(3).max(6000), severity: z.string().max(20).default(""),
    executed: z.object({ result: z.string().max(40).default("not_run") }).passthrough().optional(), settling_test: z.string().max(3000).default("") }).passthrough()).max(500),
}).passthrough();

type Step = { id: string; step_key: string; status: string; input: Record<string, unknown> };
async function attendedStep(pool: Pick<Pool, "query">, runId: string, key: string): Promise<Step> {
  const s = (await pool.query<Step>("SELECT id, step_key, status, input FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [runId, key])).rows[0];
  if (!s) throw new Error(`run ${runId} has no ${key} step`);
  return s;
}

// ---------------------------------------------------------------------------------------------------------------- challenge assignment

export const challengeAssignmentSchema = z.object({
  decisionId: z.string().uuid(), capability: z.object({ id: z.string(), version: z.string() }).strict(),
  repository: z.string().min(3).max(201), commitSha: z.string().regex(/^[a-f0-9]{40}$/), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** claim id shown to the challenger -> hypothesis id; the challenger never sees who produced a claim */
  claims: z.array(z.object({ claim: z.string().regex(/^C\d{2,4}$/), hypothesisId: z.string().uuid() }).strict()).min(1).max(500),
}).strict();
export type ChallengeAssignment = z.infer<typeof challengeAssignmentSchema>;

export async function createChallengeRunIn(client: Pick<PoolClient, "query">, raw: ChallengeAssignment, createdBy: string): Promise<{ runId: string; stepId: string }> {
  const a = challengeAssignmentSchema.parse(raw); parseRepositoryName(a.repository);
  const cap = capabilityById(a.capability.id); if (cap.kind !== "reviewer") throw new Error(`${cap.id} is not a reviewer`);
  const run = await client.query<{ id: string }>(`INSERT INTO workflow_runs (workflow_type, status, input, created_by) VALUES ($1, 'queued', $2::jsonb, $3) RETURNING id`,
    [REPOSITORY_RESEARCH_WORKFLOW, JSON.stringify({ kind: "repository", value: a.repository, ref: a.commitSha, source: "research_policy", challenge: { decision_id: a.decisionId, capability: a.capability, claims: a.claims.length }, execution_mode: "passive_only", authorization_status: "unverified" }), createdBy]);
  const runId = run.rows[0]!.id;
  await client.query(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 0, 'repository_acquirer', $3::jsonb)`, [runId, ACQUIRE_STEP_KEY, JSON.stringify({ repository: a.repository, ref: a.commitSha })]);
  const st = await client.query<{ id: string }>(`INSERT INTO workflow_steps (workflow_run_id, step_key, sequence, role, input) VALUES ($1, $2, 1, 'challenger', $3::jsonb) RETURNING id`, [runId, ATTENDED_CHALLENGE_STEP_KEY, JSON.stringify(a)]);
  return { runId, stepId: st.rows[0]!.id };
}

// ---------------------------------------------------------------------------------------------------------------- brief and export

export type Brief = Record<string, unknown>;
/** Read-only: exactly what the attended specialist is given. */
export async function brief(pool: Pool, runId: string): Promise<Brief> {
  const pending = (await pool.query<{ step_key: string; input: Record<string, unknown> }>("SELECT step_key, input FROM workflow_steps WHERE workflow_run_id = $1 AND status <> 'succeeded' ORDER BY sequence LIMIT 1", [runId])).rows[0];
  if (pending?.step_key === "specialist_reproduce") {
    const a = pending.input as { claims: Array<{ claim: string; hypothesisId: string }>; author: { id: string } }; const cap = capabilityById(a.author.id);
    const claims = [];
    for (const c of a.claims) {
      const h = (await pool.query<{ claim: string; rationale: string }>("SELECT claim, rationale FROM hypotheses WHERE id = $1", [c.hypothesisId])).rows[0]!;
      const spans = (await pool.query<{ path: string; line_start: number; line_end: number }>("SELECT s.path, s.line_start, s.line_end FROM hypothesis_evidence he JOIN evidence_spans s ON s.id = he.span_id WHERE he.hypothesis_id = $1 ORDER BY he.role, s.path", [c.hypothesisId])).rows;
      claims.push({ id: c.claim, claim: h.claim.replace(/\bclaude-[a-z]+@[^\s\]]+/g, "<specialist>"), mechanism: h.rationale.split("\n").filter((l) => !/^Produced by /.test(l)).join("\n"), locations: spans.map((s) => ({ file: s.path, line_start: s.line_start, line_end: s.line_end })) });
    }
    return { run: runId, step: "specialist_reproduce", capability: { id: cap.id, version: pinnedVersion(cap), kind: cap.kind, specialisation: cap.profile.specialisation, classes: cap.classes }, runtime: "attended Claude Code session; interactive only; no API spend",
      method: cap.profile.method, export: `export-snapshot --run ${runId} --dir <empty directory>`, claims,
      rules: "Write test/*.sol files only (no other paths), plain Solidity without forge-std; tests import the code as ../src/...; assert the IMPACT (balances, profit, funds locked after every available action), not a revert; or write a test that refutes the claim; answer every claim, with none and the reason where you cannot.",
      output: 'import-test --file answers.json: {"tests":[{"claim":"C01","files":[{"path":"test/X.t.sol","from":"<local file>"}],"matchTest":"<test name>","intent":"demonstrate|refute","demonstrates":"<what it shows>"} | {"claim":"C02","none":true,"reason":"..."}]}' };
  }
  const steps = (await pool.query<{ step_key: string }>("SELECT step_key FROM workflow_steps WHERE workflow_run_id = $1", [runId])).rows.map((r) => r.step_key);
  const isChallenge = steps.includes(ATTENDED_CHALLENGE_STEP_KEY);
  const step = await attendedStep(pool, runId, isChallenge ? ATTENDED_CHALLENGE_STEP_KEY : ATTENDED_STEP_KEY);
  const cap = capabilityById(String((step.input["capability"] as { id: string }).id));
  const common = { run: runId, step_status: step.status, capability: { id: cap.id, version: pinnedVersion(cap), kind: cap.kind, specialisation: cap.profile.specialisation, classes: cap.classes },
    runtime: "attended Claude Code session; interactive only; no API spend", method: cap.profile.method, export: `export-snapshot --run ${runId} --dir <empty directory>` };
  if (isChallenge) {
    const a = challengeAssignmentSchema.parse(step.input);
    const claims = [];
    for (const c of a.claims) {
      const h = (await pool.query<{ claim: string; rationale: string; family: string }>("SELECT claim, rationale, family FROM hypotheses WHERE id = $1", [c.hypothesisId])).rows[0]!;
      const spans = (await pool.query<{ path: string; line_start: number; line_end: number }>("SELECT s.path, s.line_start, s.line_end FROM hypothesis_evidence he JOIN evidence_spans s ON s.id = he.span_id WHERE he.hypothesis_id = $1 ORDER BY he.role, s.path", [c.hypothesisId])).rows;
      // blinded: the claim and its evidence, never the producer's identity
      // blinded (0007 'blinded_independent_assessment'): the claim and its evidence only, never the producer's rationale or identity
      claims.push({ id: c.claim, claim: h.claim.replace(/\bclaude-[a-z]+@[^\s\]]+/g, "<specialist>"), locations: spans.map((s) => ({ file: s.path, line_start: s.line_start, line_end: s.line_end })) });
    }
    return { ...common, claims, output_schema: "challengeResultSchema: {specialist, reviews:[{claim, verdict: supports|rejects|needs_more_evidence|inconclusive, reason, severity, executed?, settling_test}]}" };
  }
  const a = assignmentSchema.parse(step.input);
  return { ...common, snapshot: { repository: a.repository, commit: a.commitSha, manifest_sha256: a.manifestSha256 }, targets: a.targets.map((t) => ({ component: t.componentId, contract: t.contract, file: t.file })),
    output_schema: "specialistResultSchema: {specialist, examined:{components, classes}, not_examined:[{what, why}], findings:[{title, class, contract, functions, locations:[{file, line_start, line_end}], mechanism, preconditions, impact, confidence, how_to_validate}], scope?:{attack_surface:[{rank, target, reason, specialist}]}}" };
}

/** Writes the sealed snapshot of the run (bytes from the store, each checked against its hash) into an EMPTY directory. A filesystem effect. */
export async function exportSnapshot(pool: Pool, runId: string, dir: string): Promise<{ files: number; manifestSha256: string }> {
  assertSideEffectAllowed("filesystem", `export snapshot to ${dir}`);
  const snap = await sealedSnapshot(pool, new ResearchStore(pool), runId);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error("the export directory must be empty");
  mkdirSync(dir, { recursive: true });
  const rows = (await pool.query<{ path: string; blob_sha256: string; content: Buffer }>(
    `SELECT f.path, f.blob_sha256, b.content FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.snapshot_id = $1 ORDER BY f.path COLLATE "C"`, [snap.snapshotId])).rows;
  for (const r of rows) {
    if (sha256Hex(r.content) !== r.blob_sha256) throw new Error(`blob for ${r.path} does not match its hash`);
    const rel = normalize(r.path); if (rel.startsWith(sep) || rel.split(sep).includes("..")) throw new Error(`unsafe path ${r.path}`);
    const abs = join(dir, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, r.content, { flag: "wx" });
  }
  return { files: rows.length, manifestSha256: snap.manifestSha256 };
}

// ---------------------------------------------------------------------------------------------------------------- import

export type ImportReport = { runId: string; capability: string; stored: number; rejected: { unanchored: number; outsideTargets: number; unknownClass: number; locationsInStoredClaims: number }; classesExamined: string[] };

/** Records an attended producer's (or mapper's) result as the completion of its step. */
export async function importSpecialist(pool: Pool, runId: string, raw: unknown, meta: { operator: string; tokens?: number | null; durationMs?: number | null }): Promise<ImportReport> {
  if (!/^[A-Za-z0-9._@-]{2,100}$/.test(meta.operator)) throw new Error("a named operator is required");
  const step = await attendedStep(pool, runId, ATTENDED_STEP_KEY);
  if (step.status !== "queued") throw new Error(`the specialist step is ${step.status}; an import is accepted once, for a queued step`);
  const a = assignmentSchema.parse(step.input); const cap = capabilityById(a.capability.id);
  if (cap.profile.runtime !== "attended_session") throw new Error(`${cap.id} is not an attended capability`);
  const result = specialistResultSchema.parse(raw);
  const store = new ResearchStore(pool); const snap = await sealedSnapshot(pool, store, runId);
  if (snap.commitSha !== a.commitSha || snap.manifestSha256 !== a.manifestSha256) throw new Error("the run's snapshot is not the decided version");
  const worker = new WorkflowWorker(pool, `attended:${meta.operator}`, 600, 1);
  const claimed = await worker.claimNext([ATTENDED_STEP_KEY], runId);
  if (!claimed || claimed.id !== step.id) throw new Error("the specialist step could not be claimed (an earlier step has not finished)");
  const lease = { stepId: step.id, workerId: `attended:${meta.operator}` };
  try {
    const paths = new Set((await pool.query<{ path: string }>("SELECT path FROM repo_snapshot_files WHERE snapshot_id = $1", [snap.snapshotId])).rows.map((r) => r.path));
    const contracts = new Set(a.targets.map((t) => t.contract)); const version = pinnedVersion(cap);
    const leads: Array<LeadRef & { rejectedLocations?: number }> = []; const rejected = { unanchored: 0, outsideTargets: 0, unknownClass: 0, locationsInStoredClaims: 0 };
    for (const f of result.findings) {
      const contract = f.contract.split(/[.,\s]/)[0]!;
      if (!contracts.has(contract)) { rejected.outsideTargets++; continue; }
      if (!TRACKED_CLASSES.includes(f.class) && f.class !== "other") { rejected.unknownClass++; continue; }
      const spanIds: Array<{ spanId: string; role: "primary" | "supporting" }> = []; let badLocations = 0;
      for (const loc of f.locations) {
        if (!paths.has(loc.file) || loc.line_end < loc.line_start || loc.line_end - loc.line_start + 1 > MAX_SPAN_LINES) { badLocations++; continue; }
        try { spanIds.push({ spanId: await store.createEvidenceSpan(lease, { snapshotId: snap.snapshotId, path: loc.file, lineStart: loc.line_start, lineEnd: loc.line_end }), role: spanIds.length ? "supporting" : "primary" }); } catch { badLocations++; /* line range outside the file */ }
      }
      if (!spanIds.length) { rejected.unanchored++; continue; } // a claim AgentSmith cannot anchor to the sealed code is not stored
      const fn = (f.functions[0] ?? "").replace(/^.*\./, "").replace(/\(.*$/, "");
      const h = await store.createHypothesis(lease, {
        snapshotId: snap.snapshotId, family: `${cap.id}-${f.class === "other" ? "other" : f.class}`.slice(0, 100),
        claim: `${f.title} [${f.confidence} confidence; ${contract}${fn ? `.${fn}` : ""}]`.slice(0, 2000),
        rationale: [`Mechanism: ${f.mechanism}`, f.preconditions.length ? `Preconditions: ${f.preconditions.join("; ")}` : "", f.impact ? `Impact: ${f.impact}` : "", f.how_to_validate ? `How to validate: ${f.how_to_validate}` : "",
          badLocations ? `Rejected locations: ${badLocations} of ${f.locations.length} cited locations do not exist in the sealed snapshot (a credibility signal, kept on the record).` : "",
          `Produced by ${cap.id}@${version} in an attended session run by ${meta.operator}. A model claim: not evidence.`].filter(Boolean).join("\n").slice(0, 7900),
        requiredChecks: ["independent technical evidence (an executed test or validator) by an evaluator other than the producer", "human adjudication"],
        alternativeExplanations: ["model error or over-statement", "behaviour intended or guarded elsewhere"],
        generator: { kind: "attended_model", id: cap.id, version }, spans: spanIds,
      });
      if (!leads.some((l) => l.hypothesisId === h.id)) leads.push({ hypothesisId: h.id, class: f.class, contract, function: fn, file: f.locations[0]!.file, line: f.locations[0]!.line_start, ...(badLocations ? { rejectedLocations: badLocations } : {}) });
      if (badLocations) rejected.locationsInStoredClaims += badLocations;
    }
    // examined: what the specialist says it examined AND it is declared for; if it lists none, its declared classes minus what it says it skipped
    const said = result.examined.classes.filter((k) => cap.classes.includes(k));
    const skipped = new Set(result.not_examined.flatMap((n) => cap.classes.filter((k) => n.what.includes(k))));
    const classesExamined = (said.length ? said : [...cap.classes]).filter((k) => !skipped.has(k));
    const rawBlob = Buffer.from(JSON.stringify(raw), "utf8");
    const blob = rawBlob.length <= 1_048_576 ? (await store.putBlob(lease, rawBlob)).sha256 : null;
    const byClass: Record<string, number> = {}; for (const l of leads) byClass[l.class] = (byClass[l.class] ?? 0) + 1;
    await worker.complete(step.id, {
      status: "specialist_completed", capability: a.capability, pinned_version: version, operator: meta.operator, runtime: "attended_session",
      decision_id: a.decisionId, snapshot_id: snap.snapshotId, decided_on_snapshot_id: a.decidedOnSnapshotId, manifest_sha256: snap.manifestSha256, commit_sha: snap.commitSha, targets: a.targets,
      classes_examined: classesExamined, not_examined: result.not_examined.slice(0, 50), hypothesis_ids: leads.map((l) => l.hypothesisId), leads, leads_by_class: byClass, rejected,
      scope: cap.kind === "mapper" ? { attack_surface: result.scope?.attack_surface ?? [] } : undefined,
      raw_result_blob: blob, effort: { subagent_tokens: meta.tokens ?? null, duration_ms: meta.durationMs ?? null }, wall_ms: meta.durationMs ?? 0,
      execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false,
    });
    return { runId, capability: `${cap.id}@${version}`, stored: leads.length, rejected, classesExamined };
  } catch (e) { await worker.fail(step.id, e instanceof Error ? e.message.slice(0, 500) : "import failed", false).catch(() => undefined); throw e; }
}

/** Records an attended challenger's verdicts as blinded reviews (never evaluations), then completes the challenge step. */
export async function importChallenge(pool: Pool, runId: string, raw: unknown, meta: { operator: string; tokens?: number | null; durationMs?: number | null }): Promise<{ runId: string; reviews: number; unknownClaims: number }> {
  if (!/^[A-Za-z0-9._@-]{2,100}$/.test(meta.operator)) throw new Error("a named operator is required");
  const step = await attendedStep(pool, runId, ATTENDED_CHALLENGE_STEP_KEY);
  if (step.status !== "queued") throw new Error(`the challenge step is ${step.status}; an import is accepted once, for a queued step`);
  const a = challengeAssignmentSchema.parse(step.input); const cap: Capability = capabilityById(a.capability.id);
  const result = challengeResultSchema.parse(raw);
  const worker = new WorkflowWorker(pool, `attended:${meta.operator}`, 600, 1);
  const claimed = await worker.claimNext([ATTENDED_CHALLENGE_STEP_KEY], runId);
  if (!claimed || claimed.id !== step.id) throw new Error("the challenge step could not be claimed (an earlier step has not finished)");
  const lease = { stepId: step.id, workerId: `attended:${meta.operator}` }; const store = new ResearchStore(pool);
  const byClaim = new Map(a.claims.map((c) => [c.claim, c.hypothesisId])); let reviews = 0; let unknown = 0; const version = pinnedVersion(cap);
  try {
    for (const r of result.reviews) {
      const hid = byClaim.get(r.claim); if (!hid) { unknown++; continue; }
      await store.recordReview({ kind: "attended", operatorId: meta.operator }, {
        hypothesisId: hid, reviewerKind: "attended_model", reviewerId: cap.id, mode: "blinded_independent_assessment",
        reviewerSaw: { claim: true, evidence_spans: true, generator_rationale: false, generator_identity: false, prior_evaluations: false, prior_reviews: false },
        inputSha256: sha256Hex(JSON.stringify(r)), verdict: r.verdict,
        rationale: `${r.reason}\n(Challenge assignment ${runId}, imported by ${meta.operator}.)${r.settling_test ? `\nSettling test: ${r.settling_test}` : ""}${r.executed?.result && r.executed.result !== "not_run" ? `\nThe challenger reports running a local test: ${r.executed.result} (not recorded as evidence: an executed test becomes evidence only through a pinned evaluator, T-202).` : ""}`.slice(0, 7900),
        model: { provider: "anthropic", name: "claude-code-subagent", promptVersion: version },
      });
      reviews++;
    }
    await worker.complete(step.id, { status: "challenge_completed", capability: a.capability, pinned_version: version, operator: meta.operator, decision_id: a.decisionId, reviews, unknown_claims: unknown,
      effort: { subagent_tokens: meta.tokens ?? null, duration_ms: meta.durationMs ?? null }, wall_ms: meta.durationMs ?? 0 });
    return { runId, reviews, unknownClaims: unknown };
  } catch (e) { await worker.fail(step.id, e instanceof Error ? e.message.slice(0, 500) : "import failed", false).catch(() => undefined); throw e; }
}
