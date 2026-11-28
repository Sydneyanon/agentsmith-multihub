import type { Pool, PoolClient } from "pg";
import { approveOpportunityIn } from "../discovery/store.js";
import { buildProtocolModel, type ProtocolModel } from "../analysis/solidity/protocol-model.js";
import { readSnapshotSources } from "../analysis/solidity/pipeline.js";
import { sealedSnapshot } from "../analysis/solidity/step.js";
import { componentFeatures, scoreComponent, totalPairs, type ComponentFeatures, type ComponentMemory, type SurfaceMap } from "../priority/component.js";
import { scoringComponentsFromModel } from "../priority/from-model.js";
import type { CoverageRecord } from "../priority/coverage.js";
import { POLICY_V1 } from "../priority/policy.js";
import { allocate, scoreOpportunity, type PriorityAssessment } from "../priority/score.js";
import { ResearchStore } from "../research-state.js";
import { NOT_MODELLED_CLASSES } from "./classes.js";
import { ATTENDED_CHALLENGE_STEP_KEY, ATTENDED_REPRODUCE_STEP_KEY, availability, capabilityById, evaluatorsAvailable, pinnedVersion, producers, reviewers, testAuthors, TRACKED_CLASSES, type Capability } from "./capabilities.js";
import { appendReproductionIn, reproductionRoundUsed } from "./reproduction.js";
import { createChallengeRunIn } from "./attended.js";
import { addCandidates, openDecision, RESEARCH_POLICY_V0, type Candidate, type Db, type Feature } from "./decisions.js";
import { checkVerdict, readRegistry, recordAssessment, verifiedRepositories, type Assessment, type RegistryEntry } from "./registry.js";
import { CHALLENGE_TARGET_STEP_KEY, createInvestigationRunIn, producerOutput } from "./steps.js";
export type Env = Record<string, string | undefined>;

/**
 * The research loop, owned by AgentSmith (T-149 workflow, T-051/T-052 priority, A28 decision records, T-144 memory):
 *   rankOpportunities  -> provenance and human verification read; unverified, possible-duplicate and ineligible items assessed with
 *                         reasons (never dropped); the rest scored by the T-051 engine and ONE recommended
 *   selectOpportunity  -> a human selects (T-040: selection is human); AgentSmith refuses an unverified repository and creates the
 *                         acquisition assignment in the same transaction as the human decision record
 *   mapAndAssign       -> the sealed snapshot is mapped (protocol model + memory), a target component chosen with its reasons, and a
 *                         specialist assignment created
 *   ingestInvestigation-> the specialist's structured result and the independent challenge are turned into memory: coverage
 *                         (examined / not modelled), effort, and a per-lead account in three planes (claim, evidence, human)
 *   mapAndAssign(follow_up) -> the next action is chosen from the UPDATED state: request human review of supported leads, the next
 *                         component, or "snapshot exhausted"
 * Every stage is deterministic, explained and replayable. Nothing here schedules itself, polls, calls a model or touches the network:
 * a stage runs only when something invokes it.
 */
const POLICY_ID = RESEARCH_POLICY_V0.version;
const EXPLORE_RULE = "every 5th decision in a scope is an exploration draw: seeded uniform choice among never-examined candidates";
const f = (value: unknown, source: string): Feature => ({ value, source });
const unknown = (reason: string): Feature => ({ value: null, unknown_reason: reason });

async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { c.release(); }
}

/** One slot per decision. The 5th, 10th ... decision in a scope explores (A28 example rule); the others exploit the top score. */
function pickOne(assessments: readonly PriorityAssessment[], seed: number): { chosen: string | null; mode: "exploit" | "explore"; probability: number | null; reason: string } {
  if (!assessments.length) return { chosen: null, mode: "exploit", probability: null, reason: "no candidate" };
  const pool = assessments.filter((a) => a.explorationCandidate);
  if (seed % 5 === 4 && pool.length > 0) {
    const a = allocate(assessments, 1, seed, { ...POLICY_V1, explorationShare: 1 }).allocations[0]!;
    if (a.mode === "explore") return { chosen: a.id, mode: "explore", probability: 1 / pool.length, reason: a.reason };
  }
  const a = allocate(assessments, 1, seed, { ...POLICY_V1, explorationShare: 0 }).allocations[0]!;
  return { chosen: a.id, mode: "exploit", probability: null, reason: a.reason };
}

async function storeModel(db: Db, json: string, sha: string): Promise<string | null> {
  const bytes = Buffer.from(json, "utf8"); if (bytes.length > 1_048_576) return null;
  await db.query("INSERT INTO research_blobs (content_sha256, size_bytes, content) VALUES ($1,$2,$3) ON CONFLICT (content_sha256) DO NOTHING", [sha, bytes.length, bytes]);
  return sha;
}

/** Coverage memory for these component versions, from ANY snapshot (a component unchanged between commits keeps its coverage). */
async function coverageMemory(db: Db, componentHashes: readonly string[]): Promise<{ memory: ComponentMemory[]; records: CoverageRecord[] }> {
  const rows = (await db.query<{ component_path: string; component_sha256: string; vulnerability_class: string; result: string; method: string; method_version: string; commit_sha: string; created_at: Date }>(
    `SELECT c.component_path, c.component_sha256, c.vulnerability_class, c.result, c.method, c.method_version, s.commit_sha, c.created_at FROM research_coverage c JOIN repo_snapshots s ON s.id = c.snapshot_id
      WHERE c.component_sha256 = ANY($1::text[]) ORDER BY c.created_at, c.id`, [componentHashes])).rows;
  const by = new Map<string, ComponentMemory>();
  for (const r of rows) {
    const m = by.get(r.component_sha256) ?? { componentSha256: r.component_sha256, examined: [], abstained: [] }; by.set(r.component_sha256, m);
    if (r.result === "examined") m.examined.push({ cls: r.vulnerability_class, method: r.method });
    if (r.result === "abstained") m.abstained.push({ cls: r.vulnerability_class, method: r.method, version: r.method_version });
  }
  const records: CoverageRecord[] = rows.filter((r) => r.result === "examined").map((r) => ({ componentId: r.component_path, contentSha256: r.component_sha256, commitSha: r.commit_sha, classesExamined: [r.vulnerability_class], method: "structural", recordedAt: r.created_at.toISOString() }));
  return { memory: [...by.values()], records };
}

// ---------------------------------------------------------------------------------------------------------------- opportunity level

export type RankStage = { decisionId: string | null; recommended: string | null; candidates: Candidate[] };

type Screen = { entry: RegistryEntry; repos: string[]; action: Candidate["action"] | null; reason: string; assessment: Assessment | null; duplicateOf?: string };

function screen(all: readonly RegistryEntry[], e: RegistryEntry): Screen {
  const repos = verifiedRepositories(e);
  const program = checkVerdict(e, "program_official"); const elig = checkVerdict(e, "eligibility");
  if (elig === "contradicted") return { entry: e, repos, action: "skip_out_of_scope", reason: "eligibility contradicted by the official terms", assessment: "ineligible" };
  if (program === "contradicted") return { entry: e, repos, action: "skip_out_of_scope", reason: "the program could not be confirmed as official (contradicted)", assessment: "out_of_scope" };
  // T-040: the same verified repository in two programs is a POSSIBLE duplicate: shown, linked, never merged, never blocking a human
  const earlier = all.find((o) => o.id !== e.id && (o.firstSeenAt < e.firstSeenAt || (o.firstSeenAt === e.firstSeenAt && o.id < e.id)) && verifiedRepositories(o).some((r) => repos.includes(r)));
  if (earlier) return { entry: e, repos, action: "skip_duplicate_risk", reason: `same verified repository as earlier opportunity ${earlier.canonicalKey}`, assessment: "possible_duplicate", duplicateOf: earlier.id };
  const missing = [program !== "verified" && "program not verified as official", elig !== "verified" && "eligibility not verified", repos.length === 0 && "no repository verified as both official and in scope"].filter(Boolean) as string[];
  if (missing.length) return { entry: e, repos, action: "skip_out_of_scope", reason: `deferred until verified: ${missing.join("; ")}`, assessment: "deferred" };
  return { entry: e, repos, action: null, reason: "", assessment: null };
}

async function opportunityComponents(db: Db, repos: readonly string[]): Promise<{ components: ReturnType<typeof scoringComponentsFromModel>; source: string } | null> {
  const m = (await db.query<{ protocol_model_sha256: string; content: Buffer }>(
    `SELECT d.protocol_model_sha256, b.content FROM research_decisions d JOIN repo_snapshots s ON s.id = d.snapshot_id JOIN research_blobs b ON b.content_sha256 = d.protocol_model_sha256
      WHERE lower(s.repository) = ANY($1::text[]) ORDER BY d.created_at DESC LIMIT 1`, [repos.map((r) => r.toLowerCase())])).rows[0];
  if (!m) return null;
  const model = JSON.parse(m.content.toString("utf8")) as ProtocolModel;
  return { components: scoringComponentsFromModel(model, (await coverageMemory(db, model.components.map((c) => c.contentSha256))).records), source: `protocol model ${m.protocol_model_sha256.slice(0, 12)} + research_coverage` };
}

/**
 * Prioritise: rank every OPEN opportunity (state 'discovered'). The policy screens (unverified, possible duplicate, ineligible), scores the
 * rest with the T-051 engine and RECOMMENDS one. It creates no work: selecting an opportunity is a human decision (T-040 principle 4).
 * Assessments are recorded as events only when they change, so re-ranking an unchanged registry adds a decision but no event noise.
 */
export async function rankOpportunities(pool: Pool, now: Date): Promise<RankStage> {
  const all = await readRegistry(pool);
  const open = all.filter((e) => e.state === "discovered");
  if (!open.length) return { decisionId: null, recommended: null, candidates: [] };
  const screened = open.map((e) => screen(all, e));
  const assessments: PriorityAssessment[] = []; const featureById = new Map<string, Record<string, Feature>>();
  for (const s of screened.filter((x) => x.action === null)) {
    const comp = await opportunityComponents(pool, s.repos); const c = s.entry.claims;
    assessments.push(scoreOpportunity({ id: s.entry.id, title: s.entry.title, maxRewardUsd: c.maxRewardUsd, deadline: c.deadline, publishedAt: c.publishedAt, lastMaterialChangeAt: null,
      scopeVerified: true, eligibilityKnown: true, repositoryVerified: true, currentCommit: null, components: comp?.components ?? [], audits: [], estimatedCostUnits: null }, now));
    featureById.set(s.entry.id, {
      max_reward_usd: c.maxRewardUsd === null ? unknown("the source states no reward") : f(c.maxRewardUsd, "discovery_observations.claims (claimed, not verified)"),
      deadline: c.deadline === null ? unknown("no deadline stated") : f(c.deadline, "discovery_observations.claims (claimed)"),
      verified_repositories: f(s.repos, "opportunity_events 'verified' (repository_official AND scope_includes_repository, by a human)"),
      components: comp ? f(comp.components.length, comp.source) : unknown("no snapshot of these repositories has been mapped yet"),
      observations: f(s.entry.observations, "opportunity_events with an observation"),
    });
  }
  const seed = Number((await pool.query<{ n: string }>("SELECT count(*) n FROM research_decisions WHERE level = 'opportunity' AND decided_by_kind = 'policy'")).rows[0]!.n);
  const pick = pickOne(assessments, seed);
  const rankById = new Map([...assessments].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((a, i) => [a.id, i + 1]));
  return tx(pool, async (c) => {
    const winner = screened.find((s) => s.entry.id === pick.chosen) ?? null;
    const decisionId = await openDecision(c, { level: "opportunity", decidedBy: { kind: "policy" }, mode: pick.mode, exploreRule: pick.mode === "explore" ? EXPLORE_RULE : null,
      rationale: winner ? `Recommend ${winner.entry.canonicalKey} for human selection (${pick.reason}); ${screened.length - 1} other open opportunit${screened.length === 2 ? "y" : "ies"} ranked lower or screened out with reasons.` : `No open opportunity is eligible: ${screened.length} screened out with reasons.` });
    const candidates: Candidate[] = screened.map((s): Candidate => {
      const a = assessments.find((x) => x.id === s.entry.id); const isWinner = s.entry.id === pick.chosen;
      return { kind: "opportunity", ref: s.entry.id, features: featureById.get(s.entry.id) ?? { screening: f(s.reason, "opportunity_events 'verified'") },
        scoreComponents: a ? { score: a.score, contributions: a.contributions, flags: a.flags, policy: a.policyVersion } : { not_scored: s.reason },
        action: s.action ?? (isWinner ? "recommend" : "defer"), reason: s.action ? s.reason : isWinner ? `${pick.reason}; awaiting a human selection` : `rank ${rankById.get(s.entry.id)} by score; one recommendation per decision`,
        selectionProbability: isWinner ? pick.probability : null };
    }).sort((a, b) => Number(b.action === "recommend") - Number(a.action === "recommend") || (rankById.get(a.ref) ?? 1e9) - (rankById.get(b.ref) ?? 1e9) || a.ref.localeCompare(b.ref));
    await addCandidates(c, decisionId, candidates);
    for (const s of screened) {
      const assessment: Assessment | null = s.assessment ?? (s.entry.id === pick.chosen ? "recommended" : null);
      if (!assessment) continue;
      const reason = s.assessment ? s.reason : "ranked first by the policy";
      if (s.entry.lastAssessment?.assessment === assessment && s.entry.lastAssessment.reason === reason) continue; // unchanged: not re-recorded
      await recordAssessment(c, { opportunityId: s.entry.id, assessment, reason, ...(s.duplicateOf ? { duplicateOf: s.duplicateOf } : {}), decisionId });
    }
    return { decisionId, recommended: winner?.entry.id ?? null, candidates };
  });
}

export type SelectionStage = { decisionId: string; acquisitionRunId: string; repository: string; reused: boolean };

/**
 * Select (human): a named person selects an opportunity and one of its repositories. AgentSmith refuses a repository that is not verified
 * official AND in scope. The human decision record, the existing approval events and the acquisition assignment are one transaction.
 */
export async function selectOpportunity(pool: Pool, s: { opportunityId: string; repository: string; humanId: string; basisDecisionId?: string | null; note?: string }): Promise<SelectionStage> {
  const entry = (await readRegistry(pool)).find((e) => e.id === s.opportunityId);
  if (!entry) throw new Error("no such opportunity");
  const repo = s.repository.toLowerCase();
  if (!verifiedRepositories(entry).includes(repo)) throw new Error(`${s.repository} is not verified as both official and in scope for this opportunity; verify it first`);
  return tx(pool, async (c) => {
    const decisionId = await openDecision(c, { level: "opportunity", decidedBy: { kind: "human", id: s.humanId }, mode: "manual",
      rationale: `Human selection of ${entry.canonicalKey}, repository ${s.repository}${s.basisDecisionId ? `, after policy decision ${s.basisDecisionId}` : ""}.${s.note ? ` Note: ${s.note.slice(0, 500)}` : ""}` });
    const run = await approveOpportunityIn(c, s.opportunityId, { repository: s.repository, ...(s.note ? { note: s.note } : {}) }, s.humanId);
    await addCandidates(c, decisionId, [{ kind: "opportunity", ref: s.opportunityId,
      features: { repository: f(s.repository, "opportunity_events 'verified' by a human"), basis_policy_decision: s.basisDecisionId ? f(s.basisDecisionId, "research_decisions") : unknown("selected without a policy ranking") },
      scoreComponents: { decided_by: "human" }, action: "investigate", reason: "selected by a human; acquisition assignment created",
      ...(run.reused ? {} : { resultingRunId: run.runId, ...(run.stepId ? { resultingStepId: run.stepId } : {}) }) }]);
    return { decisionId, acquisitionRunId: run.runId, repository: s.repository, reused: run.reused };
  });
}

// ---------------------------------------------------------------------------------------------------------------- snapshot level

/** Every sealed snapshot of the same VERSION (repository, commit, manifest hash). Snapshots belong to their run (0007), so one version
 *  is sealed once per assignment; leads, outcomes and decisions about that version are read across all of them. */
export async function sameVersionSnapshots(db: Db, snapshotId: string): Promise<string[]> {
  return (await db.query<{ id: string }>(
    `SELECT o.id FROM repo_snapshots s JOIN repo_snapshots o ON o.repository = s.repository AND o.commit_sha = s.commit_sha AND o.manifest_sha256 = s.manifest_sha256
      WHERE s.id = $1 AND o.sealed_at IS NOT NULL ORDER BY o.id`, [snapshotId])).rows.map((r) => r.id);
}

export type MapStage = {
  decisionId: string; snapshotId: string; commitSha: string; repository: string; protocolModelSha256: string;
  assignment: { runId: string; target: string; mode: "exploit" | "explore"; capability: string; targets: string[] } | null;
  challenge: { runId: string; claims: number; capability: string } | null;
  reviewRequests: string[]; exhausted: boolean; candidates: Candidate[];
};

/** Supported-by-independent-evidence leads on this version with no human outcome yet, not already sent for review by an earlier decision. */
async function leadsAwaitingHuman(db: Db, snapshotIds: readonly string[], reviewerSupportCounts = true): Promise<Array<{ id: string; family: string; evaluators: string[] }>> {
  return (await db.query<{ id: string; family: string; evaluators: string[] }>(
    `SELECT h.id, h.family, array_agg(DISTINCT x.who ORDER BY x.who) AS evaluators FROM hypotheses h
       JOIN (SELECT e.hypothesis_id, 'evidence:' || e.evaluator_id AS who FROM hypothesis_evaluations e JOIN hypotheses g ON g.id = e.hypothesis_id WHERE e.outcome = 'supports' AND e.evaluator_id <> g.generator_id
             UNION ALL SELECT r.hypothesis_id, 'review:' || r.reviewer_id FROM hypothesis_reviews r WHERE $2::boolean AND r.reviewer_kind = 'attended_model' AND r.verdict = 'supports') x ON x.hypothesis_id = h.id
      WHERE h.snapshot_id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM hypothesis_outcomes o WHERE o.hypothesis_id = h.id)
        AND NOT EXISTS (SELECT 1 FROM research_decision_candidates c WHERE c.candidate_ref = h.id::text AND c.action = 'request_human_review')
      GROUP BY h.id, h.family ORDER BY h.id`, [snapshotIds, reviewerSupportCounts])).rows;
}

/**
 * Choose the specialist for a target: among the AVAILABLE producers with classes still pending on this component, the one with the most
 * pending classes (ties: declaration order). Complementary machines each get their turn; a tool that failed here is not retried at the
 * same version. A whole-snapshot tool takes every component it has not examined in one assignment.
 */
function signal(name: Capability["profile"]["relevance"][number]["signal"], x: ComponentFeatures): number {
  return name === "ledger_vars" ? x.ledgerVars : name === "external_calls" ? x.externalCalls : name === "entry_points" ? x.entryPoints / 4 : name === "unguarded_writes" ? x.unguardedWrites : x.listVars;
}
export type CapabilityValue = { capability: string; pending: number; relevance: number; costUnits: number; value: number; runtime: string };
/**
 * Choose the specialist for a target by stated, deterministic value: pending classes x relevance (protocol-model facts the capability
 * is good at) / cost units. A mapper that has not mapped this snapshot goes first. Ties: declaration order. Every capability's value is
 * recorded in the decision, so "why this specialist" is answerable and replayable.
 */
function chooseCapability(caps: readonly Capability[], x: ComponentFeatures): { cap: Capability | null; table: CapabilityValue[] } {
  const table = caps.map((c) => {
    const pending = x.pendingByCapability[c.id]?.length ?? 0;
    const relevance = Math.round((1 + c.profile.relevance.reduce((n, r) => n + r.weight * Math.min(1, signal(r.signal, x)), 0)) * 100) / 100;
    return { capability: `${c.id}@${c.version}`, pending, relevance, costUnits: c.profile.costUnits, value: Math.round((pending * relevance / c.profile.costUnits) * 1000) / 1000, runtime: c.profile.runtime };
  });
  const mapper = caps.find((c) => c.profile.precedes && (x.pendingByCapability[c.id]?.length ?? 0) > 0);
  if (mapper) return { cap: mapper, table };
  let best: Capability | null = null; let bestV = 0;
  caps.forEach((c, i) => { const v = table[i]!.value; if (v > bestV) { best = c; bestV = v; } });
  return { cap: best, table };
}

/**
 * What memory says about each capability's past work (T-203), from durable records only: claims it made, independent technical
 * supports, challenger verdicts, and HUMAN outcomes by category. Only human outcomes are labels. The record is shown in every decision;
 * it does not change selection until a capability has MIN_ADJUDICATED human outcomes and a policy version that uses it is recorded and
 * evaluated (T-192/T-193). Lead volume earns nothing.
 */
export const MIN_ADJUDICATED = 5;
export type TrackRecord = { capability: string; claims: number; technicalSupports: number; challengerVerdicts: Record<string, number>; humanOutcomes: Record<string, number>; adjudicated: number; usedInSelection: false; why: string };
export async function trackRecords(db: Db): Promise<TrackRecord[]> {
  const rows = (await db.query<{ cap: string; claims: string; tech: string; rev: Record<string, number> | null; out: Record<string, number> | null }>(
    `SELECT h.generator_id cap, count(DISTINCT h.id) claims,
            count(DISTINCT e.id) FILTER (WHERE e.outcome = 'supports' AND e.evaluator_id <> h.generator_id AND e.evaluator_id <> 'no-independent-validator') tech,
            (SELECT jsonb_object_agg(v, n) FROM (SELECT r.verdict v, count(*) n FROM hypothesis_reviews r JOIN hypotheses x ON x.id = r.hypothesis_id WHERE x.generator_id = h.generator_id AND r.reviewer_kind IN ('model','attended_model') GROUP BY 1) a) rev,
            (SELECT jsonb_object_agg(c, n) FROM (SELECT o.category c, count(*) n FROM hypothesis_outcomes o JOIN hypotheses x ON x.id = o.hypothesis_id WHERE x.generator_id = h.generator_id GROUP BY 1) b) out
       FROM hypotheses h LEFT JOIN hypothesis_evaluations e ON e.hypothesis_id = h.id GROUP BY h.generator_id ORDER BY 1`)).rows;
  return rows.map((r) => {
    const humanOutcomes = Object.fromEntries(Object.entries(r.out ?? {}).map(([k, v]) => [k, Number(v)]));
    const adjudicated = Object.values(humanOutcomes).reduce((n, v) => n + v, 0);
    return { capability: r.cap, claims: Number(r.claims), technicalSupports: Number(r.tech), challengerVerdicts: Object.fromEntries(Object.entries(r.rev ?? {}).map(([k, v]) => [k, Number(v)])), humanOutcomes, adjudicated,
      usedInSelection: false, why: adjudicated < MIN_ADJUDICATED ? `${adjudicated} human-adjudicated outcome(s), fewer than ${MIN_ADJUDICATED}: not used` : "enough outcomes, but no evaluated policy version uses track records yet (T-192/T-193)" };
  });
}

/** The latest imported scoping map for this version: contract -> best attack-surface rank. */
async function surfaceMap(db: Db, version: readonly string[]): Promise<SurfaceMap | null> {
  const r = (await db.query<{ output: { scope?: { attack_surface?: Array<{ rank: number; target: string }> }; pinned_version?: string } }>(
    `SELECT s.output FROM workflow_steps s WHERE s.status = 'succeeded' AND s.output->'capability'->>'id' = 'claude-scoping' AND (s.output->>'snapshot_id')::uuid = ANY($1::uuid[]) ORDER BY s.completed_at DESC LIMIT 1`, [version])).rows[0];
  const list = r?.output.scope?.attack_surface ?? []; if (!list.length) return null;
  const ranks = new Map<string, number>();
  for (const e of list) { const c = e.target.split(/[.:(\s]/)[0]!; if (!ranks.has(c) || ranks.get(c)! > e.rank) ranks.set(c, e.rank); }
  return { ranks, source: `claude-scoping@${r!.output.pinned_version ?? "?"}` };
}

/**
 * Claims that need reproduction (T-202): an independent reviewer supports them, there is no technical evidence yet (a supports or
 * weakens evaluation by an evaluator other than the producer), no human outcome, and no reproduction already appended for them.
 */
async function claimsNeedingReproduction(db: Db, version: readonly string[]): Promise<Array<{ id: string; generator_id: string; workflow_run_id: string }>> {
  return (await db.query<{ id: string; generator_id: string; workflow_run_id: string }>(
    `SELECT h.id, h.generator_id, h.workflow_run_id FROM hypotheses h WHERE h.snapshot_id = ANY($1::uuid[])
        AND EXISTS (SELECT 1 FROM hypothesis_reviews r WHERE r.hypothesis_id = h.id AND r.reviewer_kind = 'attended_model' AND r.verdict = 'supports')
        AND NOT EXISTS (SELECT 1 FROM hypothesis_evaluations e WHERE e.hypothesis_id = h.id AND e.outcome IN ('supports','weakens') AND e.evaluator_id <> h.generator_id AND e.evaluator_id <> 'no-independent-validator')
        AND NOT EXISTS (SELECT 1 FROM hypothesis_outcomes o WHERE o.hypothesis_id = h.id)
        AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.step_key = $2 AND s.status <> 'failed' AND s.input->'claims' @> jsonb_build_array(jsonb_build_object('hypothesisId', h.id::text)))
      ORDER BY h.created_at, h.id`, [version, ATTENDED_REPRODUCE_STEP_KEY])).rows;
}
export const MAX_REPRODUCTIONS_PER_DECISION = 10;

/** Attended (model) claims that no reviewer has challenged and no challenge assignment already covers. */
async function claimsAwaitingChallenge(db: Db, version: readonly string[]): Promise<Array<{ id: string }>> {
  return (await db.query<{ id: string }>(
    `SELECT h.id FROM hypotheses h WHERE h.snapshot_id = ANY($1::uuid[]) AND h.generator_kind = 'attended_model'
        AND NOT EXISTS (SELECT 1 FROM hypothesis_outcomes o WHERE o.hypothesis_id = h.id)
        AND NOT EXISTS (SELECT 1 FROM hypothesis_reviews r WHERE r.hypothesis_id = h.id AND r.reviewer_kind IN ('attended_model','human'))
        AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.step_key = $2 AND s.status IN ('queued','running','succeeded') AND s.input->'claims' @> jsonb_build_array(jsonb_build_object('hypothesisId', h.id::text)))
      ORDER BY h.created_at, h.id`, [version, ATTENDED_CHALLENGE_STEP_KEY])).rows;
}

export async function mapAndAssign(pool: Pool, runId: string, level: "component" | "follow_up" = "component", env: Env = process.env): Promise<MapStage> {
  const store = new ResearchStore(pool); const snap = await sealedSnapshot(pool, store, runId);
  const built = buildProtocolModel(await readSnapshotSources(pool, snap.snapshotId));
  const { memory } = await coverageMemory(pool, built.model.components.map((c) => c.contentSha256));
  const caps = producers(env); const avail = availability(env);
  const version0 = await sameVersionSnapshots(pool, snap.snapshotId);
  const records = await trackRecords(pool);
  const surface = await surfaceMap(pool, version0);
  const features = componentFeatures(built.model, memory, caps, surface);
  // work already assigned and not finished is taken: a (capability, component) pair with an open assignment is not pending again
  const open = new Set((await pool.query<{ cap: string; comp: string }>(
    `SELECT r.input->'assignment'->'capability'->>'id' cap, t comp FROM workflow_runs r, jsonb_array_elements_text(r.input->'assignment'->'targets') t
      WHERE r.status IN ('queued','running') AND r.input ? 'assignment'`)).rows.map((r) => `${r.cap}|${r.comp}`));
  const inFlight = new Map<string, string[]>();
  for (const x of features) {
    for (const capId of Object.keys(x.pendingByCapability)) if (open.has(`${capId}|${x.id}`)) { delete x.pendingByCapability[capId]; inFlight.set(x.id, [...(inFlight.get(x.id) ?? []), capId]); }
    x.pendingPairs = Object.values(x.pendingByCapability).reduce((n, v) => n + v.length, 0);
  }
  const pairs = totalPairs(caps);
  const scored = features.map((x) => ({ x, a: scoreComponent(x, pairs) }));
  const pending = scored.filter((s) => s.x.pendingPairs > 0);
  const version = await sameVersionSnapshots(pool, snap.snapshotId);
  // reproduction is possible when a test author and the pinned evaluator are both available here; otherwise reviewer support goes to a human
  const author = testAuthors(env)[0] ?? null; const forge = evaluatorsAvailable(env).find((c) => c.id === "foundry-forge") ?? null;
  const reproNeeded = level === "follow_up" ? await claimsNeedingReproduction(pool, version) : [];
  const reproPossible = Boolean(author && forge);
  const reviews = level === "follow_up" ? (await leadsAwaitingHuman(pool, version, !reproPossible)).filter((h) => !(reproPossible && reproNeeded.some((x) => x.id === h.id))) : [];
  const challenger = level === "follow_up" ? reviewers(env)[0] ?? null : null;
  const toChallenge = challenger ? await claimsAwaitingChallenge(pool, version) : [];
  const seed = Number((await pool.query<{ n: string }>("SELECT count(*) n FROM research_decisions WHERE snapshot_id = ANY($1::uuid[])", [version])).rows[0]!.n);
  const pick = pickOne(pending.map((p) => p.a), seed);
  const rank = new Map([...scored].sort((a, b) => b.a.score - a.a.score || a.a.id.localeCompare(b.a.id)).map((s, i) => [s.a.id, i + 1]));
  return tx(pool, async (c) => {
    const modelSha = await storeModel(c, built.json, built.sha256);
    const chosen = scored.find((s) => s.a.id === pick.chosen) ?? null;
    const decisionId = await openDecision(c, {
      level, contextRunId: runId, snapshotId: snap.snapshotId, protocolModelSha256: modelSha, decidedBy: { kind: "policy" }, mode: pick.mode, exploreRule: pick.mode === "explore" ? EXPLORE_RULE : null,
      rationale: [chosen ? `Target ${chosen.a.id} (score ${chosen.a.score}; ${pick.reason}).` : "No component has a class left that an available capability can examine at its current version.",
        reviews.length ? `${reviews.length} lead(s) supported by an independent evaluator sent for human review.` : "", `${pending.length} of ${scored.length} components still have unexamined classes.`].filter(Boolean).join(" "),
    });
    let assignment: MapStage["assignment"] = null; let created: { runId: string; investigateStepId: string } | null = null;
    const choice = chosen ? chooseCapability(caps, chosen.x) : { cap: null, table: [] as CapabilityValue[] };
    const cap = choice.cap;
    // a whole-snapshot tool examines every component it has not examined yet, in one run
    const bundle = chosen && cap ? (cap.scope === "snapshot" ? scored.filter((s) => (s.x.pendingByCapability[cap.id]?.length ?? 0) > 0) : [chosen]) : [];
    if (chosen && cap) {
      created = await createInvestigationRunIn(c, { decisionId, capability: { id: cap.id, version: cap.version }, repository: snap.repository, commitSha: snap.commitSha, decidedOnSnapshotId: snap.snapshotId, manifestSha256: snap.manifestSha256,
        targets: bundle.map((b) => ({ componentId: b.x.id, contract: b.x.contract, file: b.x.file, contentSha256: b.x.contentSha256 })) }, POLICY_ID);
      assignment = { runId: created.runId, target: chosen.x.id, mode: pick.mode, capability: `${cap.id}@${cap.version}`, targets: bundle.map((b) => b.x.id) };
    }
    const bundled = new Set(bundle.map((b) => b.x.id));
    // reproduction: one round per run, continuing the run that made the claims; a test author who is never the producer; or why not
    const reproductions: Candidate[] = [];
    const feat = { independent_review: f("supports", "hypothesis_reviews (attended challenger)"), technical_evidence: unknown("none yet") };
    const rule = { rule: "reproduce reviewer-supported claims that lack technical evidence; one round per run" };
    const noRepro = new Map<string, string>(); // a claim sent to a human instead: why it could not be reproduced first
    const byRun = new Map<string, typeof reproNeeded>(); for (const h of reproNeeded) byRun.set(h.workflow_run_id, [...(byRun.get(h.workflow_run_id) ?? []), h]);
    let budget = MAX_REPRODUCTIONS_PER_DECISION;
    for (const [run, hs] of byRun) {
      const why = !forge ? "reproduction needed; foundry-forge is not available here (pinned forge and solc; a persistent install is A39)"
        : !author ? "reproduction needed; no test author is available (attended operator required)"
        : hs.some((h) => h.generator_id === author.id) ? "reproduction needed; the only test author produced one of these claims"
        : (await reproductionRoundUsed(c, run)) ? "reproduction needed; this run has already had its reproduction round (one per run: a later round is not supported yet)"
        : budget < hs.length ? `reproduction needed; deferred to a later decision (at most ${MAX_REPRODUCTIONS_PER_DECISION} per decision)` : null;
      if (why) { for (const h of hs) { if (reviews.some((r) => r.id === h.id)) noRepro.set(h.id, why); else reproductions.push({ kind: "hypothesis", ref: h.id, features: feat, scoreComponents: rule, action: "defer", reason: why }); } continue; }
      budget -= hs.length;
      const app = await appendReproductionIn(c, { decisionId, hypothesisIds: hs.map((h) => h.id), author: { id: author!.id, version: author!.version }, evaluator: { id: forge!.id, version: forge!.version } }, POLICY_ID);
      for (const h of hs) reproductions.push({ kind: "hypothesis", ref: h.id, features: feat, scoreComponents: rule, action: "investigate",
        reason: `reproduction: a test by ${author!.id}@${pinnedVersion(author!)}, executed twice by ${forge!.id}@${forge!.version}, in the claim's own run`, resultingRunId: app.runId, resultingStepId: app.reproduceStepId });
    }
    // independent challenge is required for every attended (model) claim: a blinded review by a different specialist, never by its producer
    let challenge: MapStage["challenge"] = null; let challengeRun: { runId: string; stepId: string } | null = null;
    if (challenger && toChallenge.length) {
      const claims = toChallenge.map((h, i) => ({ claim: `C${String(i + 1).padStart(2, "0")}`, hypothesisId: h.id }));
      challengeRun = await createChallengeRunIn(c, { decisionId, capability: { id: challenger.id, version: challenger.version }, repository: snap.repository, commitSha: snap.commitSha, manifestSha256: snap.manifestSha256, claims }, POLICY_ID);
      challenge = { runId: challengeRun.runId, claims: claims.length, capability: `${challenger.id}@${pinnedVersion(challenger)}` };
    }
    const src = `protocol model ${built.sha256.slice(0, 12)}`;
    const candidates: Candidate[] = [
      ...reviews.map((h): Candidate => ({ kind: "hypothesis", ref: h.id, features: { family: f(h.family, "hypotheses"), independent_supports: f(h.evaluators, "hypothesis_evaluations (evaluator differs from generator)"), human_outcome: unknown("no human outcome recorded") },
        scoreComponents: { rule: RESEARCH_POLICY_V0.followUp.humanReviewWhen }, action: "request_human_review",
        reason: noRepro.has(h.id) ? `supported by an independent reviewer; ${noRepro.get(h.id)}; only a human can confirm or refute it` : "supported by independent evidence; only a human can confirm or refute it" })),
      ...[...scored].sort((a, b) => (rank.get(a.a.id)! - rank.get(b.a.id)!)).map((s): Candidate => {
        const isChosen = chosen?.a.id === s.a.id; const inBundle = !isChosen && bundled.has(s.a.id); const isPending = s.x.pendingPairs > 0;
        return { kind: "component", ref: s.a.id,
          features: { content_sha256: f(s.x.contentSha256, src), entry_points: f(s.x.entryPoints, src), external_calls: f(s.x.externalCalls, src), unguarded_writes: f(s.x.unguardedWrites, src), functions: f(s.x.functions, src),
            examined_classes: f(s.x.examinedClasses, "research_coverage at this content hash"), pending_by_capability: f(s.x.pendingByCapability, "research_coverage x engine/capabilities.ts (available producers)"),
            capabilities: f(avail.map((v) => ({ id: `${v.capability.id}@${v.capability.version}`, kind: v.capability.kind, runtime: v.capability.profile.runtime, available: v.available, reason: v.reason })), "engine/capabilities.ts + this machine"),
            ledger_vars: f(s.x.ledgerVars, `${src} (P2 state roles)`), list_vars: f(s.x.listVars, src),
            surface_rank: s.x.surfaceRank === null ? unknown("no scoping map ranks this component") : f(s.x.surfaceRank, s.x.surfaceSource ?? "scoping map"),
            ...(isChosen ? { capability_values: f(choice.table, "value = pending classes x relevance / cost units (engine/loop.ts chooseCapability)"),
              capability_track_records: f(records, "hypotheses, evaluations, reviews and human outcomes by generator (engine/loop.ts trackRecords); shown, not used in selection yet") } : {}),
            not_modelled_classes: f([...NOT_MODELLED_CLASSES], "engine/capabilities.ts: no capability examines them") },
          scoreComponents: { score: s.a.score, contributions: s.a.contributions, flags: s.a.flags, policy: s.a.policyVersion },
          action: isChosen || inBundle ? "investigate" : isPending || inFlight.has(s.a.id) ? "defer" : "complete",
          reason: isChosen ? `${pick.reason}; ${cap!.id}@${cap!.version} chosen: ${cap!.profile.precedes ? "a mapper goes first on an unmapped snapshot" : "highest value (pending classes x relevance / cost)"} (${(s.x.pendingByCapability[cap!.id] ?? []).join(", ")})` : inBundle ? `bundled: ${cap!.id} examines the whole compilation unit in one run` : isPending ? `rank ${rank.get(s.a.id)} by score; one assignment per decision` : inFlight.has(s.a.id) ? `in progress: open assignment for ${inFlight.get(s.a.id)!.join(", ")}` : "every available capability has examined its classes at this content hash",
          selectionProbability: isChosen ? pick.probability : null, ...((isChosen || inBundle) && created ? { resultingRunId: created.runId, resultingStepId: created.investigateStepId } : {}) };
      }),
      ...reproductions,
      ...(challengeRun ? toChallenge.map((h): Candidate => ({ kind: "hypothesis", ref: h.id, features: { generator_kind: f("attended_model", "hypotheses"), reviews: f(0, "hypothesis_reviews (attended or human)") },
        scoreComponents: { rule: "every attended (model) claim gets a blinded challenge by a different specialist before any human review" }, action: "investigate",
        reason: `blinded challenge by ${challenge!.capability}; a review is an opinion, never technical evidence`, resultingRunId: challengeRun!.runId, resultingStepId: challengeRun!.stepId })) : []),
    ];
    await addCandidates(c, decisionId, candidates);
    return { decisionId, snapshotId: snap.snapshotId, commitSha: snap.commitSha, repository: snap.repository, protocolModelSha256: built.sha256, assignment, challenge, reviewRequests: reviews.map((h) => h.id), exhausted: !chosen && !challenge && !reproductions.some((r) => r.action === "investigate"), candidates };
  });
}

// ---------------------------------------------------------------------------------------------------------------- results -> memory

export type LeadAccount = {
  hypothesisId: string; family: string;
  claim: { generatorKind: string; generatorId: string };              // plane 1: what a generator (rule or model) claims
  evidence: Array<{ evaluatorId: string; outcome: string }>;           // plane 2: independent evaluators only (evaluator != generator)
  human: { reviews: string[]; outcome: string | null };                // plane 3: human adjudication; the only source of an outcome
  modelReviews: Array<{ reviewerId: string; verdict: string }>;        // independent specialists' opinions: never evidence, never an outcome
  machineStatus: "supported_unadjudicated" | "weakened" | "contradicted" | "unchallenged";
};
export type IngestStage = { runId: string; decisionId: string; capability: string; toolFailure: string | null; coverageRows: number; effortRows: number; alreadyIngested: boolean; leads: LeadAccount[] };

export async function ingestInvestigation(pool: Pool, runId: string): Promise<IngestStage> {
  const chal = (await pool.query<{ id: string; status: string; output: Record<string, unknown> | null; input: { decisionId: string; claims: Array<{ hypothesisId: string }> } }>(
    "SELECT id, status, output, input FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [runId, ATTENDED_CHALLENGE_STEP_KEY])).rows[0];
  if (chal) { // a challenge assignment: reviews are already recorded; memory gets its effort
    if (chal.status !== "succeeded") throw new Error("the challenge has not been imported; nothing is ingested from partial results");
    const already = Number((await pool.query<{ n: string }>("SELECT count(*) n FROM research_effort WHERE workflow_run_id = $1", [runId])).rows[0]!.n) > 0;
    if (!already) await pool.query("INSERT INTO research_effort (workflow_run_id, step_id, method, wall_ms, decision_id) VALUES ($1,$2,$3,$4,$5)",
      [runId, chal.id, String((chal.output?.["capability"] as { id?: string } | undefined)?.id ?? "challenger"), Math.max(0, Math.round(Number(chal.output?.["wall_ms"] ?? 0))), chal.input.decisionId]);
    return { runId, decisionId: chal.input.decisionId, capability: String((chal.output?.["capability"] as { id?: string } | undefined)?.id ?? "challenger"), toolFailure: null, coverageRows: 0, effortRows: already ? 0 : 1, alreadyIngested: already, leads: await accountFor(pool, chal.input.claims.map((c) => c.hypothesisId)) };
  }
  const prod = await producerOutput(pool, runId);
  const ch = (await pool.query<{ id: string; status: string; output: Record<string, unknown> | null }>("SELECT id, status, output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = $2", [runId, CHALLENGE_TARGET_STEP_KEY])).rows[0];
  if (!prod || !ch) throw new Error("not an investigation assignment");
  if (prod.status !== "succeeded" || ch.status !== "succeeded") throw new Error("the assignment has not finished; nothing is ingested from partial results");
  const out = prod.output as { status: string; capability: { id: string; version: string }; decision_id: string; snapshot_id: string; targets: Array<{ componentId: string; contract: string; contentSha256: string }>; classes_examined: string[]; hypothesis_ids: string[]; failure?: { code: string }; wall_ms: number };
  const cap = capabilityById(out.capability.id);
  const already = Number((await pool.query<{ n: string }>("SELECT count(*) n FROM research_coverage WHERE workflow_run_id = $1", [runId])).rows[0]!.n) > 0;
  // a failed tool is memory too: 'abstained' with the failure code, so the same version is not retried and nobody reads it as "clean"
  const failed = out.status === "tool_failed";
  const reasonCode = failed ? String(out.failure?.code ?? "tool_failed").replace(/[^a-z0-9_]/g, "_").slice(0, 100) : null;
  let coverageRows = 0; let effortRows = 0;
  if (!already) {
    await tx(pool, async (c) => {
      for (const t of out.targets) {
        const rows: Array<[string, string, string | null]> = [
          ...(failed ? cap.classes.map((k): [string, string, string | null] => [k, "abstained", reasonCode]) : out.classes_examined.map((k): [string, string, null] => [k, "examined", null])),
          // declared classes the producer says it did not examine: 'abstained', so memory says so and the same version is not re-assigned
          ...(failed ? [] : cap.classes.filter((k) => !out.classes_examined.includes(k)).map((k): [string, string, string] => [k, "abstained", "not_examined_by_specialist"])),
          ...NOT_MODELLED_CLASSES.map((k): [string, string, string] => [k, "not_modelled", "no_specialist_for_class"])];
        for (const [klass, result, reason] of rows) {
          // a not-modelled class was examined by nobody: it names no method, so it is never mistaken for this capability's work
          const [method, version] = result === "not_modelled" ? ["no-capability", "0"] : [cap.id, cap.version];
          await c.query(`INSERT INTO research_coverage (snapshot_id, workflow_run_id, produced_by_step_id, component_path, component_name, component_sha256, vulnerability_class, method, method_version, result, reason_code, decision_id)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [out.snapshot_id, runId, prod.stepId, t.componentId, t.contract, t.contentSha256, klass, method, version, result, reason, out.decision_id]);
          coverageRows++;
        }
      }
      for (const [stepId, wall, method] of [[prod.stepId, out.wall_ms, cap.id], [ch.id, ch.output?.["wall_ms"], "independent-challenge"]] as const) {
        await c.query("INSERT INTO research_effort (workflow_run_id, step_id, component_path, method, wall_ms, decision_id) VALUES ($1,$2,$3,$4,$5,$6)",
          [runId, stepId, out.targets.map((t) => t.componentId).join(",").slice(0, 1000), method, Math.max(0, Math.round(Number(wall ?? 0))), out.decision_id]);
        effortRows++;
      }
    });
  }
  return { runId, decisionId: out.decision_id, capability: `${cap.id}@${cap.version}`, toolFailure: failed ? String(out.failure?.code) : null, coverageRows, effortRows, alreadyIngested: already, leads: await accountFor(pool, out.hypothesis_ids) };
}

export async function accountFor(db: Db, hypothesisIds: readonly string[]): Promise<LeadAccount[]> {
  if (!hypothesisIds.length) return [];
  const rows = (await db.query<{ id: string; family: string; generator_kind: string; generator_id: string; evals: Array<{ e: string; o: string }> | null; reviews: string[] | null; mreviews: Array<{ reviewerId: string; verdict: string }> | null; outcome: string | null }>(
    `SELECT h.id, h.family, h.generator_kind, h.generator_id,
            (SELECT jsonb_agg(jsonb_build_object('e', e.evaluator_id, 'o', e.outcome) ORDER BY e.created_at, e.id) FROM hypothesis_evaluations e WHERE e.hypothesis_id = h.id AND e.evaluator_id <> h.generator_id) AS evals,
            (SELECT array_agg(r.verdict ORDER BY r.created_at) FROM hypothesis_reviews r WHERE r.hypothesis_id = h.id AND r.reviewer_kind = 'human') AS reviews,
            (SELECT jsonb_agg(jsonb_build_object('reviewerId', r.reviewer_id, 'verdict', r.verdict) ORDER BY r.created_at) FROM hypothesis_reviews r WHERE r.hypothesis_id = h.id AND r.reviewer_kind IN ('model','attended_model')) AS mreviews,
            (SELECT o.category FROM hypothesis_outcomes o WHERE o.hypothesis_id = h.id ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS outcome
       FROM hypotheses h WHERE h.id = ANY($1::uuid[]) ORDER BY h.family, h.id`, [hypothesisIds])).rows;
  return rows.map((r) => {
    // "no-independent-validator" is an abstention record, not evidence
    const evidence = (r.evals ?? []).filter((x) => x.e !== "no-independent-validator").map((x) => ({ evaluatorId: x.e, outcome: x.o }));
    const has = (o: string) => evidence.some((x) => x.outcome === o);
    return { hypothesisId: r.id, family: r.family, claim: { generatorKind: r.generator_kind, generatorId: r.generator_id }, evidence, human: { reviews: r.reviews ?? [], outcome: r.outcome }, modelReviews: r.mreviews ?? [],
      machineStatus: has("contradicts") ? "contradicted" : has("supports") ? "supported_unadjudicated" : has("weakens") ? "weakened" : "unchallenged" };
  });
}

// ---------------------------------------------------------------------------------------------------------------- memory view

export type OutcomeLedger = {
  /** human-adjudicated outcomes only (T-144 hypothesis_outcomes); confirmed is never produced by a machine */
  confirmed: number; refuted: number; inconclusive: number; duplicate: number; missed: number;
  /** component x class pairs of this snapshot not examined at their current version (including classes with no specialist) */
  unexplored: number; notModelled: number;
  /** leads with machine evidence and no human outcome: explicitly NOT an outcome */
  unadjudicatedLeads: number;
};
export async function outcomeLedger(pool: Pool, snapshotId: string, env: Env = process.env): Promise<OutcomeLedger> {
  const version = await sameVersionSnapshots(pool, snapshotId);
  const o = Object.fromEntries((await pool.query<{ category: string; n: string }>(
    `SELECT category, count(*) n FROM (SELECT DISTINCT ON (o.hypothesis_id) o.category FROM hypothesis_outcomes o JOIN hypotheses h ON h.id = o.hypothesis_id WHERE h.snapshot_id = ANY($1::uuid[]) ORDER BY o.hypothesis_id, o.created_at DESC, o.id DESC) x GROUP BY category`, [version])).rows.map((r) => [r.category, Number(r.n)]));
  const built = buildProtocolModel(await readSnapshotSources(pool, snapshotId));
  const comps = built.model.components.filter((c) => c.deployable || c.kind === "library");
  const { memory } = await coverageMemory(pool, comps.map((c) => c.contentSha256));
  // unexplored: tracked classes not examined (by any capability) at the component's current hash; notModelled: the part of that no
  // AVAILABLE capability can examine here (no specialist at all, or the tool is not installed on this machine)
  const examinable = new Set(producers(env).flatMap((c) => c.classes));
  let examined = 0; let notModelled = 0;
  for (const c of comps) {
    const done = new Set(memory.filter((m) => m.componentSha256 === c.contentSha256).flatMap((m) => m.examined.map((x) => x.cls)));
    examined += TRACKED_CLASSES.filter((k) => done.has(k)).length;
    notModelled += TRACKED_CLASSES.filter((k) => !done.has(k) && !examinable.has(k)).length;
  }
  const classes = TRACKED_CLASSES.length;
  const unadj = Number((await pool.query<{ n: string }>(`SELECT count(DISTINCT h.id) n FROM hypotheses h JOIN hypothesis_evaluations e ON e.hypothesis_id = h.id AND e.evaluator_id <> h.generator_id AND e.outcome IN ('supports','weakens')
      WHERE h.snapshot_id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM hypothesis_outcomes x WHERE x.hypothesis_id = h.id)`, [version])).rows[0]!.n);
  return { confirmed: o["confirmed"] ?? 0, refuted: o["refuted"] ?? 0, inconclusive: o["inconclusive"] ?? 0, duplicate: o["duplicate"] ?? 0, missed: o["missed"] ?? 0,
    unexplored: comps.length * classes - examined, notModelled, unadjudicatedLeads: unadj };
}

/** Plane 3. A human outcome, under the human's own identity; the database enforces the T-144 rules (confirmed needs a human
 *  adjudication review AND independent supporting evidence). */
export async function recordHumanOutcome(pool: Pool, o: { hypothesisId: string; category: "confirmed" | "refuted" | "inconclusive" | "duplicate"; decidedBy: string; rationale: string; basisEvaluationIds?: string[]; basisReviewId?: string | null; duplicateOfHypothesis?: string | null }): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO hypothesis_outcomes (hypothesis_id, category, decided_by_kind, decided_by, basis_evaluation_ids, basis_review_id, duplicate_of_hypothesis, rationale) VALUES ($1,$2,'human',$3,$4::uuid[],$5,$6,$7) RETURNING id`,
    [o.hypothesisId, o.category, o.decidedBy, o.basisEvaluationIds ?? [], o.basisReviewId ?? null, o.duplicateOfHypothesis ?? null, o.rationale])).rows[0]!.id;
}
