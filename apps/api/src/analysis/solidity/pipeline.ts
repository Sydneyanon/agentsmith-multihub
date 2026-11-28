import { createHash } from "node:crypto";
import { bountyScopeOfSnapshot, scopeOfPath, type ScopeStatus } from "../../acquisition/bounty-scope.js";
import type { Pool } from "pg";
import { ProgramIndex } from "./index.js";
import { challengeFinding, type ChallengeOutcome } from "./challenge.js";
import { validateReentrancy, type SimOutcome } from "./simulate.js";
import { analyzeSources, type Finding } from "./specialists.js";
import { buildProtocolModel, reachableCalls, type ProtocolModel } from "./protocol-model.js";
import type { AuthorityFacts } from "./authority.js";
import { canonicalJson, sha256Hex, type ResearchStore, type StepLease } from "../../research-state.js";
import { slitherScanOfSnapshot } from "./slither-record.js";
import { analysisIdentity, evaluationRelation, type EvaluationRelation } from "../../analysis-identity.js";
import { SLITHER_VERSION as SLITHER_PINNED } from "./keys.js";
import type { ResearchReads } from "../../research-port.js";

/**
 * Glue between the structural analysis and the durable research state (5.1): findings become evidence-linked hypotheses citing
 * hash-verified spans of a sealed snapshot; the execution validator's verdicts become recorded evaluations. Nothing is claimed
 * beyond what each stage actually did: a class with no independent validator is recorded as `inconclusive`, never as "supports".
 */
export const SPECIALIST_ID = "solidity-structural-specialists"; export const SPECIALIST_VERSION = "1";
export const VALIDATOR_ID = "reentrancy-execution-validator"; export const VALIDATOR_VERSION = "1";

export type StoredHypothesis = {
  id: string; finding: Finding; spanIds: string[]; /** set for an external producer's lead (e.g. "slither@0.11.3"); absent for the specialists' own */ producer?: string;
  /** the content-addressed canonical finding payload the analysis step stored for this hypothesis (the specialists' own leads only) */
  payloadSha256?: string;
  /** set when a stored hypothesis cannot be turned back into a challengeable finding: it is recorded as inconclusive with this reason, never skipped */
  unresolved?: string;
};

/**
 * The canonical finding payload (schema `agentsmith-finding/1`): exactly the fields the evaluators need, stored by the analysis step as a
 * content-addressed blob beside each hypothesis and referenced from its step output (`finding_payloads`: hypothesis id -> blob hash). The
 * challenge stage reads the hypotheses it challenges, and their findings, from these records; it never re-runs the analyzer or matches by
 * claim text.
 */
export const FINDING_PAYLOAD_SCHEMA = "agentsmith-finding/1";
export type FindingPayload = { schema: typeof FINDING_PAYLOAD_SCHEMA; hypothesis_id: string; snapshot_id: string; generator: string; class: Finding["class"]; contract: string; function: string; file: string; line: number; detail: Finding["detail"] };
export function findingPayload(hypothesisId: string, snapshotId: string, f: Finding): FindingPayload {
  return { schema: FINDING_PAYLOAD_SCHEMA, hypothesis_id: hypothesisId, snapshot_id: snapshotId, generator: `${SPECIALIST_ID}@${SPECIALIST_VERSION}`, class: f.class, contract: f.contract, function: f.function, file: f.file, line: f.line, detail: f.detail };
}
/** research_blobs holds at most 1 MiB per blob; a larger model is not stored (and the step says so) rather than truncated. */
const MODEL_BLOB_LIMIT = 1_048_576;
export type StoredProtocolModel = { sha256: string; stored: boolean; components: number; functions: number; callEdges: number; unknowns: number };

export async function readSnapshotSources(pool: Pool, snapshotId: string): Promise<Array<{ path: string; text: string }>> {
  const r = await pool.query<{ path: string; text: string }>(
    `SELECT f.path, convert_from(b.content, 'UTF8') AS text FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256
      WHERE f.snapshot_id = $1 AND f.path LIKE '%.sol' ORDER BY f.path COLLATE "C"`, [snapshotId]);
  return r.rows;
}

/**
 * The reads the pipeline makes (option D's port, see research-port.ts). Given a pool, the SQL is exactly what these functions always
 * ran; given a `PipelineReads` (the remote worker's client), the same functions run with no database connection at all.
 */
export type PipelineReads = Pick<ResearchReads, "snapshotSources" | "specialistHypothesisId" | "hypothesisSpanIds">;
export function pipelineReads(pool: Pick<Pool, "query">): PipelineReads {
  return {
    snapshotSources: (snapshotId) => readSnapshotSources(pool as Pool, snapshotId),
    specialistHypothesisId: async (snapshotId, claim) =>
      (await pool.query<{ id: string }>("SELECT id FROM hypotheses WHERE snapshot_id = $1 AND claim = $2 AND generator_id = $3", [snapshotId, claim, SPECIALIST_ID])).rows[0]?.id ?? null,
    hypothesisSpanIds: async (hypothesisId) =>
      (await pool.query<{ span_id: string }>("SELECT span_id FROM hypothesis_evidence WHERE hypothesis_id = $1 ORDER BY (role = 'primary') DESC, span_id", [hypothesisId])).rows.map((x) => x.span_id),
  };
}
export type PoolOrReads = Pick<Pool, "query"> | PipelineReads;
export const asPipelineReads = (source: PoolOrReads): PipelineReads =>
  typeof (source as { query?: unknown }).query === "function" ? pipelineReads(source as Pick<Pool, "query">) : source as PipelineReads;

/**
 * A finding may only cite lines that exist in the sealed snapshot. One that does not is an analyzer attribution error: it is rejected
 * and reported as a problem (never stored, never "fixed up"), so one bad finding cannot abort the analysis of a whole repository and
 * no unverifiable evidence is ever recorded.
 */
export function rejectUncitableFindings(findings: Finding[], sources: ReadonlyArray<{ path: string; text: string }>): { kept: Finding[]; problems: string[] } {
  const lineCount = new Map(sources.map((s) => [s.path, s.text.split("\n").length]));
  const citable = (file: string, line: number) => Number.isInteger(line) && line >= 1 && line <= (lineCount.get(file) ?? 0);
  const kept: Finding[] = []; const problems: string[] = [];
  for (const f of findings) {
    const bad = f.spans.filter((s) => !citable(s.file, s.lineStart) || !citable(s.file, s.lineEnd));
    if (bad.length) problems.push(`finding rejected (analyzer attribution error): ${f.class} ${f.contract}.${f.function} cites ${bad.map((s) => `${s.file}:${s.lineStart}`).join(", ")}, which does not exist in the snapshot`);
    else kept.push(f);
  }
  return { kept, problems };
}

export async function runStructuralAnalysis(pool: PoolOrReads, store: Pick<ResearchStore, "putBlob" | "createEvidenceSpan" | "createHypothesis">, lease: StepLease, snapshotId: string, options: { include?: (f: Finding) => boolean } = {}): Promise<{ stored: StoredHypothesis[]; problems: string[]; contracts: number; functions: number; protocolModel: StoredProtocolModel }> {
  const sources = await asPipelineReads(pool).snapshotSources(snapshotId);
  // P1: the protocol model is built from the same sealed sources and stored content-addressed; the step output links it (T-149 stage 4)
  const pm = buildProtocolModel(sources); const bytes = Buffer.from(pm.json, "utf8");
  const storedModel = bytes.length <= MODEL_BLOB_LIMIT ? (await store.putBlob(lease, bytes)).sha256 === pm.sha256 : false;
  const protocolModel: StoredProtocolModel = { sha256: pm.sha256, stored: storedModel, components: pm.model.components.length, functions: pm.model.functions.length, callEdges: pm.model.callEdges.length, unknowns: pm.model.unknowns.length };
  const { findings, index, problems } = analyzeSources(sources);
  const stored: StoredHypothesis[] = []; const spanCache = new Map<string, string>();
  const span = async (file: string, line: number) => {
    const key = `${file}:${line}`; const have = spanCache.get(key); if (have) return have;
    const id = await store.createEvidenceSpan(lease, { snapshotId, path: file, lineStart: line, lineEnd: line }); spanCache.set(key, id); return id;
  };
  const checked = rejectUncitableFindings(findings, sources); problems.push(...checked.problems);
  for (const f of checked.kept) {
    if (options.include && !options.include(f)) continue; // an assignment scoped to target components stores only their findings
    const seen = new Set<string>(); const spans: Array<{ spanId: string; role: "primary" | "supporting" | "context" }> = [];
    for (const s of f.spans) { const k = `${s.file}:${s.lineStart}`; if (seen.has(k)) continue; seen.add(k); spans.push({ spanId: await span(s.file, s.lineStart), role: spans.length === 0 ? "primary" : s.role === "primary" ? "supporting" : s.role }); }
    const made = await store.createHypothesis(lease, {
      snapshotId, family: `solidity-${f.class}`, claim: f.claim, rationale: f.rationale + (f.assumptions.length ? ` Assumptions: ${f.assumptions.join("; ")}.` : ""),
      requiredChecks: f.requiredChecks, alternativeExplanations: f.alternatives, generator: { kind: "deterministic_rule", id: SPECIALIST_ID, version: SPECIALIST_VERSION }, spans,
    });
    const payload = await store.putBlob(lease, Buffer.from(canonicalJson(findingPayload(made.id, snapshotId, f)), "utf8"));
    stored.push({ id: made.id, finding: f, spanIds: spans.map((s) => s.spanId), payloadSha256: payload.sha256 });
  }
  const fns = [...index.contracts.values()].reduce((n, c) => n + c.functions.length, 0);
  return { stored, problems, contracts: index.contracts.size, functions: fns, protocolModel };
}

/**
 * An EXTERNAL producer's stored leads (e.g. Slither's), as the input the independent evaluators need: the class, the contract, the
 * function and the location, with the hypothesis's own recorded spans (primary first). Nothing of the producer's reasoning is passed on,
 * so the evaluators judge the lead by their own method; a class with no validator is recorded as "no independent validator".
 */
export async function externalLeadsAsStored(pool: PoolOrReads, producer: string, leads: ReadonlyArray<{ hypothesisId: string; class: string; contract: string; function: string; file: string; line: number }>): Promise<StoredHypothesis[]> {
  const out: StoredHypothesis[] = []; const reads = asPipelineReads(pool);
  for (const l of leads) {
    const spans = await reads.hypothesisSpanIds(l.hypothesisId);
    const finding = { class: l.class as Finding["class"], contract: l.contract, function: l.function, file: l.file, line: l.line, claim: "", rationale: "", requiredChecks: [], alternatives: [], spans: [], chain: [], assumptions: [], confidence: "low", detail: {} } as Finding;
    out.push({ id: l.hypothesisId, finding, spanIds: spans, producer });
  }
  return out;
}

export type Validation = { hypothesisId: string; outcome: SimOutcome };

/**
 * How a validator's verdict is recorded (the evaluation outcome), precisely:
 *  - `supports`: the validator executed the claimed path in the model and observed the claimed effect (validated, with a trace);
 *  - `contradicts`: an EXECUTED COUNTEREXAMPLE: a control run shows the model can execute the claimed path, and the claim's own
 *    adversarial transaction on it reverts at an explicit check that negates the claim's mechanism, with the trace recorded
 *    (challenge.ts: `refutation: "counterexample"`). It holds in the modelled world only; it is a basis for a human `refuted` outcome,
 *    never an outcome itself;
 *  - `weakens`: the validator executed and did not observe the claimed effect, but nothing executed contradicts it (bounded search found
 *    no exploit, the statement was not reached, nothing observable changed). Every reentrancy refutation is of this kind: "no exploit in N
 *    bounded scenarios" is the absence of an observation, not a counterexample;
 *  - `inconclusive`: the validator abstained (something on the path is not modelled, the control run failed, the function is not found).
 */
export function challengeOutcome(c: Pick<ChallengeOutcome, "verdict" | "refutation" | "trace">): "supports" | "contradicts" | "weakens" | "inconclusive" {
  if (c.verdict === "validated") return "supports";
  if (c.verdict === "refuted") return c.refutation === "counterexample" && c.trace.length > 0 ? "contradicts" : "weakens";
  return "inconclusive";
}
/** the classes `challengeFinding` has a method for (reentrancy has its own validator, below) */
const CHALLENGED_CLASSES: ReadonlySet<string> = new Set(["access-control", "selfdestruct", "delegatecall", "initializer", "unchecked-call"]);

/** Independent challenge of reentrancy leads by execution; other classes are recorded as inconclusive (no independent validator exists yet). */
export async function runChallenge(pool: PoolOrReads, store: Pick<ResearchStore, "recordEvaluation">, lease: StepLease, snapshotId: string, stored: StoredHypothesis[]): Promise<Validation[]> {
  const index = new ProgramIndex(await asPipelineReads(pool).snapshotSources(snapshotId)); const out: Validation[] = [];
  for (const h of stored) {
    const primary = h.spanIds[0]!;
    const evaluatorOf = (cls: string) => cls === "reentrancy" ? VALIDATOR_ID : CHALLENGED_CLASSES.has(cls) ? `execution-challenge-${cls}` : "no-independent-validator";
    // a stored hypothesis that cannot be read back as a finding is recorded as inconclusive WITH the reason, never skipped
    if (h.unresolved) {
      await store.recordEvaluation(lease, { hypothesisId: h.id, evaluatorId: evaluatorOf(h.finding.class), evaluatorVersion: h.finding.class === "reentrancy" ? VALIDATOR_VERSION : "1", outcome: "inconclusive",
        rationale: `Not challenged: ${h.unresolved}.`.slice(0, 7900), spanIds: [], inputSha256: sha256Hex(`${h.id}|unresolved|${h.unresolved}`) });
      continue;
    }
    // the stored hypothesis names a function that the index re-parsed from the sealed snapshot does not contain: recorded, never skipped
    const missing = CHALLENGED_CLASSES.has(h.finding.class) || h.finding.class === "reentrancy" ? !index.findFunctions(h.finding.contract, h.finding.function)[0] : false;
    if (missing) {
      const why = `the stored hypothesis names ${h.finding.contract}.${h.finding.function}, which is not a function of the index re-parsed from the sealed snapshot`;
      if (h.finding.class === "reentrancy") out.push({ hypothesisId: h.id, outcome: { verdict: "inconclusive", reason: why, trace: [], scenarios: 0, detail: {} } });
      await store.recordEvaluation(lease, { hypothesisId: h.id, evaluatorId: evaluatorOf(h.finding.class), evaluatorVersion: h.finding.class === "reentrancy" ? VALIDATOR_VERSION : "1", outcome: "inconclusive",
        rationale: `The validator abstained: ${why}; the lead is not challenged.`, spanIds: [], inputSha256: sha256Hex(`${h.finding.claim}|inconclusive|${why}`) });
      continue;
    }
    if (h.finding.class !== "reentrancy") {
      // a class with no challenger (e.g. an external producer's missing-zero-check) is "no independent validator", even when its
      // function cannot be found; for the specialists' own classes this is exactly the previous behaviour
      const c = CHALLENGED_CLASSES.has(h.finding.class) ? challengeFinding(index, h.finding) : null;
      if (!c) {
        await store.recordEvaluation(lease, { hypothesisId: h.id, evaluatorId: "no-independent-validator", evaluatorVersion: "1", outcome: "inconclusive",
          rationale: `No independent validator exists yet for ${h.finding.class} leads; this lead has only been produced by ${h.producer ?? "the specialist"} and has not been challenged.`, spanIds: [], inputSha256: sha256Hex(h.finding.claim) });
        continue;
      }
      const outcome = challengeOutcome(c);
      const text = `${c.method}: ${c.reason}.${c.trace.length ? " Trace: " + c.trace.join(" | ") + "." : ""}${outcome === "contradicts" ? " This CONTRADICTS the lead in the modelled world (an executed counterexample, trace above); it is not a proof for a real deployment, and a refuted outcome still needs a human decision." : outcome === "weakens" ? " This weakens (does not eliminate) the lead: the claimed effect was not observed, but nothing executed contradicts it; the model is a bounded abstraction." : ""}`;
      await store.recordEvaluation(lease, { hypothesisId: h.id, evaluatorId: `execution-challenge-${h.finding.class}`, evaluatorVersion: "1", outcome, rationale: text.slice(0, 7900), spanIds: outcome === "inconclusive" ? [] : [primary], inputSha256: sha256Hex(`${h.finding.claim}|${c.verdict}|${c.reason}`) });
      continue;
    }
    const fn = index.findFunctions(h.finding.contract, h.finding.function)[0];
    const r = fn ? validateReentrancy(index, fn) : { verdict: "inconclusive" as const, reason: "function not found", trace: [], scenarios: 0, detail: {} };
    out.push({ hypothesisId: h.id, outcome: r });
    const outcome = r.verdict === "validated" ? "supports" : r.verdict === "refuted" ? "weakens" : "inconclusive";
    const body = r.verdict === "validated" ? `Executed model: ${r.reason}. Trace: ${r.trace.join(" | ")}` : r.verdict === "refuted" ? `Executed model, ${r.scenarios} bounded scenarios: ${r.reason}. This weakens (does not eliminate) the lead: the model is a bounded abstraction.` : `The validator abstained: ${r.reason}`;
    await store.recordEvaluation(lease, { hypothesisId: h.id, evaluatorId: VALIDATOR_ID, evaluatorVersion: VALIDATOR_VERSION, outcome, rationale: body.slice(0, 7900), spanIds: outcome === "inconclusive" ? [] : [primary], inputSha256: sha256Hex(`${h.finding.claim}|${r.verdict}|${r.reason}`) });
  }
  return out;
}

export type DossierEntry = {
  hypothesis_id: string; class: string; function: string; claim: string; rationale: string; required_checks: unknown; alternative_explanations: unknown;
  generator: string; evidence: Array<{ path: string; lines: string; role: string; text: string; verified: boolean }>;
  evaluations: Array<{ evaluator: string; outcome: string; rationale: string }>; status: string | null; static_outcome: string | null; human_review: string;
  /** D: the claim as generated, with who generated it and from which analysis family */
  origin: { generator: string; generator_kind: string; analysis_family: string | null; method: string | null };
  /** D: each validator's identity, family and relation to the generator, with its latest outcome (one row per evaluator) */
  validators: DossierValidator[];
  /** D: latest `supports` evaluations, each labelled with its family relation (agreement is corroboration, never proof) */
  supporting_evidence: DossierEvidence[];
  /** D: latest `contradicts` and `weakens` evaluations, with the executed counterexample or the reason */
  contradicting_evidence: DossierEvidence[];
  /** D: agreement counted by family relation; shown as corroboration only */
  corroboration: { same_family: number; cross_family: number; unknown_family: number; note: string };
  /** D: an executed reproduction (a compiled test run, e.g. foundry-forge), or "none" */
  reproduction: "none" | Array<{ evaluator: string; outcome: string; rationale: string }>;
  /** D: the final assessment, derived from the database status and the evaluations; never "confirmed" without a human outcome */
  assessment: { verdict: DossierVerdict; text: string };
  /** D: what this entry's conclusion rests on and cannot show */
  uncertainty: string[];
  /** present only when the run carries an official bounty scope: whether the lead's primary location is in the selected scope */
  scope_status?: ScopeStatus;
};
export type DossierVerdict = "withdrawn" | "reviewed" | "refuted" | "weakened" | "supported_cross_family" | "corroborated_same_family" | "supported_unknown_family" | "open";
export type DossierValidator = { evaluator: string; version: string; analysis_family: string | null; method: string | null; relation: EvaluationRelation; outcome: string };
export type DossierEvidence = { evaluator: string; analysis_family: string | null; relation: EvaluationRelation; outcome: string; rationale: string; cited: Array<{ path: string; lines: string }> };
export type ArchitectureSection =
  | { available: false; reason: string }
  | { available: true; model_sha256: string; builder: string; components: Array<{ id: string; kind: string; file: string; lines: string; content_sha256: string; state_roles: Array<{ variable: string; status: string; roles: string[] }>; authority: AuthoritySummary | null; entry_points: Array<{ fn: string; guarded: boolean; writes: string[]; external_calls: Array<{ kind: string; to: string; target_provenance: string | null; resolved_callee: string | null; at: string }>; unresolved_calls: Array<{ name: string; at: string }> }> }>; unknowns: Array<{ at: string; what: string }> };
export type AuthoritySummary = {
  roles: Array<{ variable: string; strength: string; holder: string; held_by: string | null; transfer: string; writers: string[] }>;
  open_authority_writes: string[]; callee_side_checks: string[]; factory_paths: string[]; proxy: string[]; initialisers: string[]; assumptions: string[]; unresolved: string[];
};
/**
 * Whether the analysis behind a dossier actually covered the snapshot, from stored records only. A dossier is never presented as a
 * complete investigation when it was not: `partial` lists every parser problem and every finding rejected for an uncitable span;
 * `not_analysable` means the snapshot holds no Solidity (e.g. a non-EVM repository); `not_analysed` means no successful analysis
 * step is recorded for the snapshot's run.
 */
export type AnalysisCoverage = {
  status: "complete" | "partial" | "not_analysable" | "not_analysed"; solidity_files: number; contracts: number | null; functions: number | null; problems: string[];
  /** present ONLY for runs created with the optional Slither stage: what the external tool did, or why it abstained */
  external_tools?: ExternalToolCoverage[];
};
export type ExternalToolCoverage =
  | { tool: "slither"; pinned_version: string; status: "completed"; version: string; solc_version: string; generator: string; leads: number; informational_detections: number; unanchored: number; leads_not_recorded: number }
  | { tool: "slither"; pinned_version: string; status: "abstained"; code: string; detail: string };
export type Dossier = {
  snapshot: { id: string; repository: string; commit_sha: string; file_count: number; manifest_sha256: string; verified: boolean };
  coverage: AnalysisCoverage;
  /** what produced the analysis, from the analysis step's own record (null fields: not recorded, e.g. builds before structural-solidity/2) */
  analyzer: { version: string | null; build_commit: string | null; image: string | null };
  summary: Record<string, number>; entries: DossierEntry[]; architecture: ArchitectureSection; limitations: string[]; content_sha256: string;
  /** the official bounty scope recorded on the run (null for runs without one): its evidence, and how many leads fall in and out of it */
  bounty_scope?: { programme: string; evidence: string; evidence_sha256: string; in_scope_files: number; in_scope_leads: number; out_of_scope_leads: number } | null;
};

async function analysisCoverage(pool: Pool, snapshotId: string): Promise<AnalysisCoverage> {
  const sol = Number((await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.snapshot_id = $1 AND f.path LIKE '%.sol'`, [snapshotId])).rows[0]!.n);
  const out = (await pool.query<{ output: { problems?: unknown; contracts?: unknown; functions?: unknown } | null }>(
    `SELECT st.output FROM repo_snapshots s JOIN workflow_steps st ON st.workflow_run_id = s.workflow_run_id
      WHERE s.id = $1 AND st.step_key = 'analyze_structure' AND st.status = 'succeeded' ORDER BY st.completed_at DESC LIMIT 1`, [snapshotId])).rows[0]?.output ?? null;
  if (sol === 0) return { status: "not_analysable", solidity_files: 0, contracts: null, functions: null, problems: ["the snapshot contains no Solidity source; this engine analyses Solidity only"] };
  if (!out) return { status: "not_analysed", solidity_files: sol, contracts: null, functions: null, problems: ["no successful structural-analysis step is recorded for this snapshot"] };
  const problems = Array.isArray(out.problems) ? out.problems.map(String) : [];
  return { status: problems.length ? "partial" : "complete", solidity_files: sol, contracts: typeof out.contracts === "number" ? out.contracts : null, functions: typeof out.functions === "number" ? out.functions : null, problems };
}

async function analyzerRecord(pool: Pool, snapshotId: string): Promise<Dossier["analyzer"]> {
  const o = (await pool.query<{ output: { analyzer?: unknown; analyzer_build?: { commit?: unknown; image?: unknown } } | null }>(
    `SELECT st.output FROM repo_snapshots s JOIN workflow_steps st ON st.workflow_run_id = s.workflow_run_id
      WHERE s.id = $1 AND st.step_key = 'analyze_structure' AND st.status = 'succeeded' ORDER BY st.completed_at DESC LIMIT 1`, [snapshotId])).rows[0]?.output ?? null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return { version: str(o?.analyzer), build_commit: str(o?.analyzer_build?.commit), image: str(o?.analyzer_build?.image) };
}

/** P3 consumer: what the dossier says about authority, with code locations, and with every unresolved or assumed path listed. */
function authoritySummary(a: AuthorityFacts | null, at: (e: { file: string; lineStart: number; lineEnd: number }) => string): AuthoritySummary | null {
  if (!a) return null;
  const L = (l: { file: string; line: number }) => `${l.file}:${l.line}`;
  return {
    roles: a.roles.map((r) => ({ variable: r.variable, strength: r.strength, holder: r.holder, held_by: r.heldBy ? `${r.heldBy.contract} (deploying contract; ${r.heldBy.evidence.map(L).join(", ")})` : null, transfer: r.transfer,
      writers: r.writers.map((w) => `${w.fn} [${w.control}${w.guardedBy.length ? ` by ${w.guardedBy.join(",")}` : ""}] @ ${L(w.at)}`) })),
    open_authority_writes: a.unguardedAuthorityWrites.map((w) => `${w.fn} writes ${w.variable} with no caller-side check @ ${L(w.at)}`),
    callee_side_checks: a.checks.filter((c) => c.side === "callee-side").map((c) => `${c.fn}: ${c.note} @ ${L(c.at)}`),
    factory_paths: a.factoryPaths.map((p) => `${p.from} -> ${p.callee}${p.reaches.length ? ` (${p.reaches.join(", ")})` : ""}: callee checks ${p.calleeChecks.map((c) => `${c.reads.join(",") || "?"} @ ${L(c.at)}`).join("; ")}; ${p.outerCallerGuarded ? "outer function has a caller-side check" : "**outer function has NO caller-side check**"} @ ${L(p.at)}`),
    proxy: a.proxy.map((p) => `${p.fallback} delegatecalls ${p.pointer} -> ${p.implementation} @ ${L(p.at)}; pointer writers: ${p.upgradeWriters.map((w) => `${w.fn} [${w.control}]`).join(", ") || "none found"}; ${p.note}`),
    initialisers: a.initialisers.map((i) => `${i.fn} (flag ${i.flag}) @ ${L(i.at)}: ${i.note}`),
    assumptions: a.externalAssumptions.map((x) => `${x.fn} @ ${L(x.at)}: ${x.why}`),
    unresolved: a.unresolved.map((u) => `${u.what}${u.at ? ` @ ${L(u.at)}` : ""}`),
  };
  void at;
}

/** P1 consumer: the dossier's architecture section, built ONLY from the protocol model the analysis step stored for this snapshot's run
 *  (located through the step output, re-hashed on read; a missing or mismatching model is reported, never reconstructed). */
async function architectureFromStoredModel(pool: Pool, snapshotId: string): Promise<ArchitectureSection> {
  const ref = (await pool.query<{ sha: string | null }>(
    `SELECT st.output->>'protocol_model_sha256' AS sha FROM repo_snapshots s JOIN workflow_steps st ON st.workflow_run_id = s.workflow_run_id
      WHERE s.id = $1 AND st.step_key = 'analyze_structure' AND st.status = 'succeeded' AND st.output ? 'protocol_model_sha256' ORDER BY st.completed_at DESC LIMIT 1`, [snapshotId])).rows[0];
  if (!ref?.sha) return { available: false, reason: "no protocol model is recorded for this snapshot's analysis step" };
  const blob = (await pool.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [ref.sha])).rows[0];
  if (!blob) return { available: false, reason: `the recorded protocol model ${ref.sha} was not stored (too large for one blob)` };
  if (createHash("sha256").update(blob.content).digest("hex") !== ref.sha) throw new Error("dossier refused: the stored protocol model does not match its recorded hash");
  const m = JSON.parse(blob.content.toString("utf8")) as ProtocolModel;
  const at = (e: { file: string; lineStart: number; lineEnd: number }) => `${e.file}:${e.lineStart}${e.lineEnd !== e.lineStart ? `-${e.lineEnd}` : ""}`;
  return {
    available: true, model_sha256: ref.sha, builder: `${m.schema} ${m.builder}`,
    components: m.components.filter((c) => c.deployable).map((c) => ({
      id: c.id, kind: c.kind, file: c.file, lines: `${c.evidence.lineStart}-${c.evidence.lineEnd}`, content_sha256: c.contentSha256,
      // P2 roles, shown with basis and strength so a name-only "authority" is never mistaken for an enforced one
      state_roles: (m.stateRoles?.byComponent.find((x) => x.component === c.id)?.variables ?? []).map((v) => ({
        variable: v.variable, status: v.status, roles: v.roles.map((r) => `${r.role} (${r.basis}, ${r.strength}, ${r.rule} @ ${r.evidence.map((e) => `${e.file}:${e.line}`).join(", ")})`),
      })),
      authority: authoritySummary(m.authority?.byComponent.find((x) => x.component === c.id) ?? null, at),
      entry_points: m.functions.filter((f) => f.component === c.id && f.entryPoint).map((f) => ({
        fn: f.id, guarded: f.callerGuarded, writes: f.stateWrites,
        external_calls: reachableCalls(m, f.id).filter((e) => e.kind !== "unresolved").map((e) => ({ kind: e.kind, to: e.to, target_provenance: e.targetProvenance, resolved_callee: e.resolvedCallee ?? null, at: at(e.evidence) })),
        unresolved_calls: reachableCalls(m, f.id).filter((e) => e.kind === "unresolved").map((e) => ({ name: e.to, at: at(e.evidence) })),
      })),
    })),
    unknowns: m.unknowns.map((u) => ({ at: `${u.file}${u.line ? `:${u.line}` : ""}`, what: u.what })),
  };
}

/**
 * The optional Slither stage in the dossier (runs created with `slitherScan` only; otherwise nothing changes). A completed scan is listed
 * as an external tool with its generator; an abstention is listed with its code and reason, is added to the coverage problems (so the
 * dossier is PARTIAL, never presented as complete) and to the limitations. A stage that exists but has no recorded outcome is the same.
 */
async function addSlitherCoverage(pool: Pool, snapshotId: string, coverage: AnalysisCoverage, limitations: string[]): Promise<void> {
  const s = await slitherScanOfSnapshot(pool, snapshotId);
  if (!s.exists) return;
  const o = s.outcome ?? { status: "abstained" as const, code: "not_recorded", detail: "the Slither stage has no recorded outcome" };
  if (o.status === "tool_completed") {
    coverage.external_tools = [{ tool: "slither", pinned_version: SLITHER_PINNED, status: "completed", version: o.version, solc_version: o.solcVersion, generator: `slither@${o.version}`, leads: o.leads.length, informational_detections: o.informational, unanchored: o.unanchored, leads_not_recorded: o.notRecorded }];
    if (o.notRecorded > 0) { coverage.problems.push(`Slither ${o.version}: ${o.notRecorded} mapped detections were not recorded (the per-run lead limit was reached)`); if (coverage.status === "complete") coverage.status = "partial"; }
    limitations[0] = `Leads generated by ${SPECIALIST_ID} come from deterministic rules over source text. Leads generated by slither@${o.version} come from Slither compiling the snapshot with solc ${o.solcVersion} on the worker (pinned, offline); nothing was run against a chain or tested with a fuzzer.`;
    limitations.push(`Slither leads are claims by an external tool, not evidence. Each is challenged by AgentSmith's own validators where its class has one; other classes are recorded as "no independent validator". ${o.informational} informational detections were counted, not stored${o.unanchored ? `; ${o.unanchored} mapped detections could not be anchored to the snapshot and were not stored` : ""}.`);
  } else {
    coverage.external_tools = [{ tool: "slither", pinned_version: SLITHER_PINNED, status: "abstained", code: o.code, detail: o.detail }];
    coverage.problems.push(`Slither ${SLITHER_PINNED} abstained (${o.code}): ${o.detail}`);
    if (coverage.status === "complete") coverage.status = "partial";
    limitations.push(`Slither ${SLITHER_PINNED} was requested for this run but abstained (${o.code}), so no Slither leads are included. That is NOT evidence that Slither would find nothing.`);
  }
}

const REVIEW_STATUSES = new Set(["reviews_disagree", "supported_by_review", "rejected_by_review", "needs_more_evidence", "review_inconclusive"]);
/**
 * D: the evidence-integrity part of a dossier entry, from the stored evaluations only (latest per evaluator, as the status view does).
 * Origin, supporting and contradicting evidence, each validator's identity and analysis family, the reproduction, the assessment and the
 * uncertainty are kept apart. Agreement is reported as corroboration from the same or another family, never as proof; nothing here says
 * "confirmed" (that needs a human outcome, which the dossier does not record).
 */
export function evidenceIntegrity(gen: { kind: string; id: string; version: string },
  evals: ReadonlyArray<{ id: string; evaluator_id: string; evaluator_version: string; outcome: string; rationale: string }>,
  cited: ReadonlyMap<string, Array<{ path: string; lines: string }>>, status: string | null, rationale: string, reviewCount: number,
): Pick<DossierEntry, "origin" | "validators" | "supporting_evidence" | "contradicting_evidence" | "corroboration" | "reproduction" | "assessment" | "uncertainty"> {
  const gi = analysisIdentity(gen.id);
  const latest = new Map<string, (typeof evals)[number]>(); for (const e of evals) latest.set(e.evaluator_id, e); // ordered by evaluator, then time
  const rows = [...latest.values()];
  const fam = (id: string) => analysisIdentity(id);
  const item = (e: (typeof evals)[number]): DossierEvidence => ({ evaluator: `${e.evaluator_id}@${e.evaluator_version}`, analysis_family: fam(e.evaluator_id)?.analysisFamily ?? null, relation: evaluationRelation(gen, e.evaluator_id), outcome: e.outcome, rationale: e.rationale, cited: cited.get(e.id) ?? [] });
  const validators: DossierValidator[] = rows.map((e) => ({ evaluator: `${e.evaluator_id}@${e.evaluator_version}`, version: e.evaluator_version, analysis_family: fam(e.evaluator_id)?.analysisFamily ?? null, method: fam(e.evaluator_id)?.method ?? null, relation: evaluationRelation(gen, e.evaluator_id), outcome: e.outcome }));
  const supporting = rows.filter((e) => e.outcome === "supports").map(item);
  const contradicting = rows.filter((e) => e.outcome === "contradicts" || e.outcome === "weakens").map(item);
  const count = (r: EvaluationRelation) => supporting.filter((s) => s.relation === r).length;
  const corroboration = { same_family: count("same-family"), cross_family: count("cross-family"), unknown_family: count("unknown-family"),
    note: "Agreement between a producer and a validator is corroboration (same family: the same substrate, errors correlate; another family: an independent substrate), never proof." };
  const repro = rows.filter((e) => fam(e.evaluator_id)?.analysisFamily === "evm-execution");
  const has = (o: string) => rows.some((e) => e.outcome === o);
  let verdict: DossierVerdict; let text: string;
  if (status === "withdrawn") { verdict = "withdrawn"; text = "Withdrawn by a human; kept for the record."; }
  else if (status && REVIEW_STATUSES.has(status)) { verdict = "reviewed"; text = `Status from recorded reviews: ${status}. Technical evidence is listed separately; no outcome (confirmed or refuted) is recorded in this dossier.`; }
  else if (has("contradicts")) { verdict = "refuted"; text = "REFUTED in the modelled world: a validator executed a counterexample (see contradicting evidence). This is not a proof for a real deployment; a recorded refuted outcome still needs a human decision."; }
  else if (has("weakens")) { verdict = "weakened"; text = "Weakened: a validator executed the claimed path and did not observe the claimed effect, but nothing executed contradicts it. The lead stays open."; }
  else if (corroboration.cross_family > 0) { verdict = "supported_cross_family"; text = "Supported by evidence from a different analysis family than the generator. NOT confirmed: confirmation needs a human adjudication."; }
  else if (corroboration.same_family > 0) { verdict = "corroborated_same_family"; text = "Corroborated within the generator's own analysis family only (same substrate, different method). This is NOT independent confirmation."; }
  else if (corroboration.unknown_family > 0) { verdict = "supported_unknown_family"; text = "Supported by an evaluator whose analysis family is not recorded; it does not count as independent."; }
  else { verdict = "open"; text = "Open: no validator decided this lead. That is NOT evidence that the issue is absent."; }
  const uncertainty: string[] = [];
  if (rows.some((e) => fam(e.evaluator_id)?.method === "bounded-execution")) uncertainty.push("The execution validators run a bounded model of one contract (privileged addresses are a third party, sampled arguments, no external code); their results hold in that modelled world only.");
  if (supporting.some((s) => s.relation === "same-family") || contradicting.some((s) => s.relation === "same-family")) uncertainty.push(`The validator shares the generator's analysis family (${gi?.analysisFamily ?? "?"}): a misreading by that substrate would affect both.`);
  for (const e of rows.filter((x) => x.outcome === "inconclusive")) uncertainty.push(`${e.evaluator_id} abstained: ${e.rationale.slice(0, 300)} The lead stays open; this is NOT evidence that the issue is absent.`);
  if (!rows.length) uncertainty.push("No evaluation is recorded; the lead is unchallenged.");
  if (!repro.length) uncertainty.push("No executed reproduction (compiled test on the EVM) is recorded.");
  if (/Assumptions: /.test(rationale)) uncertainty.push(`The generator recorded assumptions: ${rationale.slice(rationale.indexOf("Assumptions: ") + 13, rationale.indexOf("Assumptions: ") + 413)}`);
  if (!reviewCount) uncertainty.push("No review is recorded.");
  return {
    origin: { generator: `${gen.id}@${gen.version}`, generator_kind: gen.kind, analysis_family: gi?.role === "generator" ? gi.analysisFamily : gen.kind === "human" ? "human" : null, method: gi?.role === "generator" ? gi.method : null },
    validators, supporting_evidence: supporting, contradicting_evidence: contradicting, corroboration,
    reproduction: repro.length ? repro.map((e) => ({ evaluator: `${e.evaluator_id}@${e.evaluator_version}`, outcome: e.outcome, rationale: e.rationale })) : "none",
    assessment: { verdict, text }, uncertainty,
  };
}

/** Builds the dossier ONLY from stored records; spans are re-resolved and re-verified; fails closed if any cited span cannot be verified. */
export async function buildDossier(pool: Pool, store: ResearchStore, snapshotId: string): Promise<Dossier> {
  const snap = (await pool.query("SELECT id, repository, commit_sha, file_count, manifest_sha256 FROM repo_snapshots WHERE id = $1", [snapshotId])).rows[0];
  const verified = (await store.verifySnapshot(snapshotId)) as { ok?: boolean };
  const hs = (await pool.query<{ id: string; family: string; claim: string; rationale: string; required_checks: unknown; alternative_explanations: unknown; generator_kind: string; generator_id: string; generator_version: string }>(
    "SELECT id, family, claim, rationale, required_checks, alternative_explanations, generator_kind, generator_id, generator_version FROM hypotheses WHERE snapshot_id = $1 ORDER BY claim COLLATE \"C\"", [snapshotId])).rows;
  const entries: DossierEntry[] = [];
  for (const h of hs) {
    const ev = (await pool.query<{ span_id: string; role: string }>("SELECT span_id, role FROM hypothesis_evidence WHERE hypothesis_id = $1 ORDER BY role, span_id", [h.id])).rows;
    const evidence: DossierEntry["evidence"] = [];
    for (const e of ev) {
      const r = await store.resolveSpan(e.span_id); const verifiedHash = await store.verifySpan(e.span_id).then((v) => v === "ok").catch(() => false);
      if (!r.ok || !verifiedHash) throw new Error(`dossier refused: a cited span of hypothesis ${h.id} cannot be verified`);
      evidence.push({ path: r.path, lines: `${r.lineStart}-${r.lineEnd}`, role: e.role, text: r.text.trim(), verified: true });
    }
    evidence.sort((a, b) => a.path.localeCompare(b.path) || a.lines.localeCompare(b.lines));
    const evals = (await pool.query<{ id: string; evaluator_id: string; evaluator_version: string; outcome: string; rationale: string }>("SELECT id, evaluator_id, evaluator_version, outcome, rationale FROM hypothesis_evaluations WHERE hypothesis_id = $1 ORDER BY evaluator_id, created_at", [h.id])).rows;
    // what each evaluation cites, re-resolved and re-verified like the hypothesis's own evidence (fail closed)
    const cited = new Map<string, Array<{ path: string; lines: string }>>();
    for (const e of evals) {
      const spans = (await pool.query<{ span_id: string }>("SELECT span_id FROM evaluation_evidence WHERE evaluation_id = $1 ORDER BY span_id", [e.id])).rows;
      const out: Array<{ path: string; lines: string }> = [];
      for (const s of spans) {
        const r = await store.resolveSpan(s.span_id); const ok = await store.verifySpan(s.span_id).then((v) => v === "ok").catch(() => false);
        if (!r.ok || !ok) throw new Error(`dossier refused: a span cited by an evaluation of hypothesis ${h.id} cannot be verified`);
        out.push({ path: r.path, lines: `${r.lineStart}-${r.lineEnd}` });
      }
      cited.set(e.id, out);
    }
    const reviews = (await pool.query<{ reviewer_kind: string; reviewer_id: string; review_mode: string; verdict: string }>("SELECT reviewer_kind, reviewer_id, review_mode, verdict FROM hypothesis_reviews WHERE hypothesis_id = $1 ORDER BY created_at, id", [h.id])).rows;
    const st = (await store.getStatus(h.id)) as Record<string, unknown> | null;
    const cls = h.family.replace(/^solidity-/, "");
    const fn = h.generator_id === "slither" ? /^Slither \S+ \([^)]*\) in ([\w$]+(?:\.[\w$]+)?):/.exec(h.claim)?.[1] ?? "" : /^(\w+\.\w+)/.exec(h.claim)?.[1] ?? "";
    const status = (st?.status as string) ?? null;
    entries.push({ hypothesis_id: h.id, class: cls, function: fn, claim: h.claim, rationale: h.rationale, required_checks: h.required_checks, alternative_explanations: h.alternative_explanations,
      generator: `${h.generator_id}@${h.generator_version}`, evidence, evaluations: evals.map((e) => ({ evaluator: e.evaluator_id, outcome: e.outcome, rationale: e.rationale })),
      status, static_outcome: (st?.static_outcome as string) ?? null,
      human_review: reviews.filter((r) => r.reviewer_kind === "human").map((r) => `${r.review_mode} by ${r.reviewer_id}: ${r.verdict}`).join("; ") || "none recorded",
      ...evidenceIntegrity({ kind: h.generator_kind, id: h.generator_id, version: h.generator_version }, evals, cited, status, h.rationale, reviews.length) });
  }
  const summary: Record<string, number> = {};
  for (const e of entries) summary[e.status ?? "unknown"] = (summary[e.status ?? "unknown"] ?? 0) + 1;
  const limitations = [
    "Every item is a lead produced by deterministic rules over source text; nothing was compiled, run against a chain or tested with a fuzzer.",
    "Reentrancy, access-control, initializer, delegatecall, selfdestruct and unchecked-call leads are challenged by bounded execution of a modelled contract (a different method from the specialists); tx.origin leads have no independent method and stay unchallenged.",
    "No human review is recorded for any item. Status values come from the database view and say so.",
    "The analysis is intra-repository: calls into code outside the snapshot, inline assembly and unresolved modifiers are not analysed (they are listed as assumptions where they affect a lead).",
  ];
  const architecture = await architectureFromStoredModel(pool, snapshotId);
  const coverage = await analysisCoverage(pool, snapshotId); const analyzer = await analyzerRecord(pool, snapshotId);
  await addSlitherCoverage(pool, snapshotId, coverage, limitations); // no-op unless the run was created with the Slither stage
  const content = entries.map((e) => [e.class, e.function, e.claim, e.evidence.map((x) => `${x.path}:${x.lines}:${x.text}`), e.evaluations.map((x) => `${x.evaluator}:${x.outcome}`), e.status]);
  // The official bounty scope, when the run carries one: label every lead by its PRIMARY evidence location. Runs without a scope are
  // unchanged (no field, same content hash as before).
  const scope = await bountyScopeOfSnapshot(pool, snapshotId);
  let bountyScope: Dossier["bounty_scope"] = null;
  if (scope) {
    for (const e of entries) { const at = e.evidence.find((x) => x.role === "primary") ?? e.evidence[0]; e.scope_status = at ? scopeOfPath(scope, at.path) : "out_of_scope"; }
    const inScope = entries.filter((e) => e.scope_status === "in_scope").length;
    bountyScope = { programme: scope.programme, evidence: scope.evidence, evidence_sha256: scope.evidence_sha256, in_scope_files: scope.in_scope_paths.length, in_scope_leads: inScope, out_of_scope_leads: entries.length - inScope };
    limitations.push(`Bounty scope (${scope.programme}, evidence ${scope.evidence}, sha256 ${scope.evidence_sha256.slice(0, 12)}…): ${scope.in_scope_paths.length} files are in scope. The whole repository was analysed so that interactions are visible, but only leads whose primary location is in scope can be eligible bounty findings; every other lead is labelled OUT OF SCOPE.`);
  }
  const hashed: unknown[] = [content, architecture.available ? architecture.model_sha256 : null, coverage, analyzer];
  if (bountyScope) hashed.push(bountyScope, entries.map((e) => [e.hypothesis_id, e.scope_status]));
  const content_sha256 = createHash("sha256").update(JSON.stringify(hashed)).digest("hex");
  return { snapshot: { id: snap.id, repository: snap.repository, commit_sha: snap.commit_sha, file_count: snap.file_count, manifest_sha256: snap.manifest_sha256, verified: verified.ok === true }, coverage, analyzer, summary, entries, architecture, limitations, content_sha256, ...(bountyScope ? { bounty_scope: bountyScope } : {}) };
}

export function renderDossierMarkdown(d: Dossier): string {
  const o: string[] = [`# Research dossier: ${d.snapshot.repository} @ ${d.snapshot.commit_sha}\n`,
    `Snapshot ${d.snapshot.id}: ${d.snapshot.file_count} files, manifest \`${d.snapshot.manifest_sha256}\`, database verification ok=${d.snapshot.verified}. Content hash \`${d.content_sha256}\`.\n`,
    `Analyzer: ${d.analyzer.version ?? "not recorded"}; build commit ${d.analyzer.build_commit ?? "not recorded"}${d.analyzer.image ? ` (image \`${d.analyzer.image}\`)` : ""}.\n`,
    `**Analysis coverage: ${d.coverage.status.toUpperCase().replace("_", " ")}** — ${d.coverage.solidity_files} Solidity files${d.coverage.contracts !== null ? `, ${d.coverage.contracts} contracts, ${d.coverage.functions} functions analysed` : ""}.${d.coverage.status === "complete" ? "" : " This is NOT a complete investigation of the snapshot."}\n`
      + (d.coverage.problems.length ? d.coverage.problems.map((p) => `- ${p}`).join("\n") + "\n" : "")
      + (d.coverage.external_tools?.length ? d.coverage.external_tools.map((t) => t.status === "completed"
        ? `External tool: **${t.generator}** completed (solc ${t.solc_version}): ${t.leads} leads, ${t.informational_detections} informational detections counted, not stored.`
        : `External tool: **slither ${t.pinned_version} ABSTAINED** (${t.code}): ${t.detail}`).join("\n") + "\n" : ""),
    `Status counts (derived by the database view): ${Object.entries(d.summary).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}.\n`,
    `Assessments: ${Object.entries(d.entries.reduce<Record<string, number>>((a, e) => ({ ...a, [e.assessment.verdict]: (a[e.assessment.verdict] ?? 0) + 1 }), {})).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}. Refuted leads are listed with their counterexample, never dropped; nothing is confirmed without a human outcome.\n`, ...(d.bounty_scope ? [`**Bounty scope:** ${d.bounty_scope.programme}: ${d.bounty_scope.in_scope_files} files in scope (evidence ${d.bounty_scope.evidence}, sha256 \`${d.bounty_scope.evidence_sha256}\`). Leads: ${d.bounty_scope.in_scope_leads} in scope, ${d.bounty_scope.out_of_scope_leads} OUT OF SCOPE (not eligible bounty findings).\n`] : []), "## Leads\n"];
  if (!d.entries.length) o.push("_No leads were generated. That is NOT evidence that the code is free of vulnerabilities: it means only that this analyzer's patterns did not match (see coverage and limitations)._\n");
  const VERDICT: Record<DossierVerdict, string> = { withdrawn: "WITHDRAWN", reviewed: "REVIEWED", refuted: "REFUTED (executed counterexample)", weakened: "WEAKENED", supported_cross_family: "SUPPORTED by another analysis family (not confirmed)", corroborated_same_family: "CORROBORATED within the same analysis family (not independent)", supported_unknown_family: "SUPPORTED by an evaluator of unknown family (not independent)", open: "OPEN (undecided)" };
  const rel = (r: EvaluationRelation) => r === "cross-family" ? "another analysis family than the generator" : r === "same-family" ? "the SAME analysis family as the generator" : r === "abstention" ? "abstention" : "unknown analysis family";
  const ev = (x: DossierEvidence) => `- ${x.evaluator} (${x.analysis_family ?? "family not recorded"}; ${rel(x.relation)}): **${x.outcome}**${x.cited.length ? ` citing ${x.cited.map((c) => `\`${c.path}:${c.lines}\``).join(", ")}` : ""}. ${x.rationale.slice(0, 900)}`;
  d.entries.forEach((e, i) => {
    o.push(`### ${i + 1}. ${e.function} - ${e.class}: ${VERDICT[e.assessment.verdict]} (status: ${e.status})${e.scope_status === "out_of_scope" ? " — OUT OF BOUNTY SCOPE: not an eligible finding" : e.scope_status === "in_scope" ? " — in bounty scope" : ""}\n**Claim.** ${e.claim}\n`);
    o.push(`**Hypothesis.** **Generated by** ${e.origin.generator} (${e.origin.generator_kind}; analysis family ${e.origin.analysis_family ?? "not recorded"}${e.origin.method ? `, method ${e.origin.method}` : ""}). Cited code:`);
    for (const x of e.evidence) o.push(`- evidence (${x.role}) \`${x.path}:${x.lines}\`: \`${x.text.slice(0, 140)}\``);
    o.push(`\n**Supporting evidence.**` + (e.supporting_evidence.length ? "\n" + e.supporting_evidence.map(ev).join("\n") : " none"));
    o.push(`\n**Contradicting evidence.**` + (e.contradicting_evidence.length ? "\n" + e.contradicting_evidence.map(ev).join("\n") : " none"));
    o.push(`\n**Validators.**` + (e.validators.length ? "\n" + e.validators.map((v) => `- ${v.evaluator}: analysis family ${v.analysis_family ?? "not recorded"}${v.method ? `, method ${v.method}` : ""}; ${rel(v.relation)}; latest outcome **${v.outcome}**`).join("\n") : " none recorded"));
    o.push(`\n**Corroboration.** ${e.corroboration.cross_family} from another family, ${e.corroboration.same_family} from the same family${e.corroboration.unknown_family ? `, ${e.corroboration.unknown_family} from an unknown family` : ""}. ${e.corroboration.note}`);
    o.push(`\n**Reproduction.** ${e.reproduction === "none" ? "none" : e.reproduction.map((r) => `${r.evaluator}: **${r.outcome}**. ${r.rationale.slice(0, 400)}`).join("; ")}`);
    o.push(`\n**Assessment.** ${e.assessment.text}`);
    o.push(`\n**Uncertainty and limitations.**\n` + e.uncertainty.map((u) => `- ${u}`).join("\n"));
    o.push(`\n**Required checks.** ${(e.required_checks as string[]).join("; ")}\n**Alternative explanations.** ${(e.alternative_explanations as string[]).join("; ")}\nHuman review: ${e.human_review}.\n`);
  });
  o.push("## Architecture (protocol model P1-P3)\n");
  if (!d.architecture.available) o.push(`Not available: ${d.architecture.reason}.\n`);
  else {
    o.push(`Model \`${d.architecture.model_sha256}\` (${d.architecture.builder}). Every item cites code; P1 covers components, entry points, writes and external calls; P2 adds state-variable roles with their basis and strength; P3 adds who holds and can change authority, which checks are caller-side, cross-contract and proxy boundaries, initialisation controls and unresolved paths. A check is described, never certified. No assets or value flows yet.\n`);
    for (const c of d.architecture.components) {
      o.push(`### ${c.id} (${c.kind}, \`${c.file}:${c.lines}\`)`);
      const classified = c.state_roles.filter((v) => v.status !== "unclassified");
      if (classified.length) o.push("State variables: " + classified.map((v) => `\`${v.variable}\` [${v.status}] ${v.roles.join("; ")}`).join(" · "));
      const unc = c.state_roles.filter((v) => v.status === "unclassified").map((v) => v.variable);
      if (unc.length) o.push(`Unclassified state variables (kept for investigation): ${unc.map((x) => `\`${x}\``).join(", ")}`);
      const au = c.authority;
      if (au) {
        for (const r of au.roles) o.push(`- authority \`${r.variable}\` (${r.strength}, ${r.holder}${r.held_by ? `, held by ${r.held_by}` : ""}), transfer: ${r.transfer}${r.writers.length ? `; writers: ${r.writers.join("; ")}` : ""}`);
        for (const [label, xs] of [["Open authority writes", au.open_authority_writes], ["Callee-side checks (not a check on this function's caller)", au.callee_side_checks], ["Cross-contract authority paths", au.factory_paths], ["Proxy boundaries", au.proxy], ["Initialisation controls", au.initialisers], ["Trust assumptions", au.assumptions], ["Unresolved authority", au.unresolved]] as const)
          if (xs.length) o.push(`**${label}:** ` + xs.join(" · "));
      }
      for (const f of c.entry_points) o.push(`- \`${f.fn}\` ${f.guarded ? "caller-guarded" : "**no caller guard**"}${f.writes.length ? `; writes ${f.writes.join(", ")}` : ""}${f.external_calls.length ? `; calls ${f.external_calls.map((x) => `${x.kind} ${x.to}${x.resolved_callee ? ` -> ${x.resolved_callee}` : ""} (target from ${x.target_provenance ?? "n/a"}, \`${x.at}\`)`).join("; ")}` : ""}${f.unresolved_calls.length ? `; **unresolved:** ${f.unresolved_calls.map((x) => `${x.name} (\`${x.at}\`)`).join(", ")}` : ""}`);
      o.push("");
    }
    if (d.architecture.unknowns.length) o.push(`Not modelled (${d.architecture.unknowns.length}): ` + d.architecture.unknowns.slice(0, 20).map((u) => `\`${u.at}\` ${u.what}`).join("; ") + (d.architecture.unknowns.length > 20 ? "; ..." : "") + "\n");
  }
  o.push("## Limitations\n" + d.limitations.map((l) => `- ${l}`).join("\n") + "\n");
  return o.join("\n");
}

/** The structural map, now a PROJECTION of the protocol model (P1): one derivation, kept in the step output for compatibility. Metadata only. */
export function buildStructuralMap(sources: ReadonlyArray<{ path: string; text: string }>) {
  const { model } = buildProtocolModel(sources); const ix = new ProgramIndex(sources);
  const contracts = model.components.map((c) => ({
    name: c.id, kind: c.kind, file: c.file, bases: ix.contracts.get(c.id)?.bases ?? [], lines: [c.evidence.lineStart, c.evidence.lineEnd],
    state_variables: c.stateVariables.map((v) => ({ name: v.name, type: v.type, constant: v.constant, immutable: v.immutable })),
    functions: model.functions.filter((f) => f.component === c.id).map((f) => {
      const calls = reachableCalls(model, f.id).filter((e) => e.kind !== "unresolved");
      return {
        name: f.name, kind: f.kind, visibility: f.visibility, mutability: f.mutability, modifiers: f.modifiers, lines: [f.evidence.lineStart, f.evidence.lineEnd], declared_in: f.declaredIn,
        entry_point: f.entryPoint, caller_guarded: f.callerGuarded, external_calls: calls.length,
        low_level_calls: [...new Set(calls.map((e) => e.kind).filter((k) => k !== "external"))], state_writes: f.stateWrites,
        unresolved_calls: reachableCalls(model, f.id).filter((e) => e.kind === "unresolved").length,
      };
    }),
  }));
  return { contracts, problems: ix.problems, protocol_model_schema: model.schema };
}

/**
 * The specialists' hypotheses a challenge stage must challenge, rebuilt ONLY from stored records: the ids the producing step recorded
 * (`hypothesis_ids`), each hypothesis row and its evidence links, and the canonical finding payload the step output references
 * (`finding_payloads`, re-hashed on read). The analyzer is never re-run and nothing is matched by claim text. An id that is not a
 * specialist hypothesis of this snapshot is an integrity error (the step fails). A hypothesis whose payload is missing or does not describe
 * it is returned with `unresolved` set, so the challenge records it as inconclusive with the reason instead of skipping it.
 */
export async function storedHypothesesFromRecords(pool: Pick<Pool, "query">, snapshotId: string, ids: readonly string[], payloads: Readonly<Record<string, unknown>> | null | undefined): Promise<StoredHypothesis[]> {
  const out: StoredHypothesis[] = [];
  for (const id of ids) {
    const h = (await pool.query<{ snapshot_id: string; family: string; claim: string; generator_id: string }>("SELECT snapshot_id, family, claim, generator_id FROM hypotheses WHERE id = $1", [id])).rows[0];
    if (!h || h.snapshot_id !== snapshotId || h.generator_id !== SPECIALIST_ID) throw new Error(`the producing step lists hypothesis ${id}, which is not a ${SPECIALIST_ID} hypothesis of snapshot ${snapshotId}; refusing to challenge`);
    const spanIds = (await pool.query<{ span_id: string }>("SELECT span_id FROM hypothesis_evidence WHERE hypothesis_id = $1 ORDER BY (role = 'primary') DESC, span_id", [id])).rows.map((x) => x.span_id);
    const cls = h.family.replace(/^solidity-/, "") as Finding["class"];
    const bare = { class: cls, contract: "", function: "", file: "", line: 0, claim: h.claim, rationale: "", requiredChecks: [], alternatives: [], spans: [], chain: [], assumptions: [], confidence: "low", detail: {} } as Finding;
    const unresolved = (why: string, sha?: string): void => { out.push({ id, finding: bare, spanIds, ...(sha ? { payloadSha256: sha } : {}), unresolved: why }); };
    const sha = payloads?.[id];
    if (typeof sha !== "string") { unresolved("no canonical finding payload is recorded for this hypothesis by the producing step, so its contract, function and location cannot be read from stored records"); continue; }
    const blob = (await pool.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [sha])).rows[0];
    if (!blob) { unresolved(`the recorded finding payload ${sha} is not stored`, sha); continue; }
    if (sha256Hex(blob.content) !== sha) throw new Error(`the stored finding payload of hypothesis ${id} does not match its recorded hash`);
    let p: Partial<FindingPayload>;
    try { p = JSON.parse(blob.content.toString("utf8")) as Partial<FindingPayload>; } catch { unresolved("the recorded finding payload is not valid JSON", sha); continue; }
    if (p.schema !== FINDING_PAYLOAD_SCHEMA || p.hypothesis_id !== id || p.snapshot_id !== snapshotId || p.class !== cls || typeof p.contract !== "string" || typeof p.function !== "string" || typeof p.file !== "string" || typeof p.line !== "number") {
      unresolved(`the recorded finding payload does not describe this hypothesis (schema ${String(p.schema)}, hypothesis ${String(p.hypothesis_id)}, class ${String(p.class)})`, sha); continue;
    }
    out.push({ id, finding: { ...bare, contract: p.contract, function: p.function, file: p.file, line: p.line, detail: p.detail ?? {} }, spanIds, payloadSha256: sha });
  }
  return out;
}
