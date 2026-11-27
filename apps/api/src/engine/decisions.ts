import type { PoolClient } from "pg";
import { canonicalJson, sha256Hex } from "../research-state.js";
import { COMPONENT_POLICY_V1 } from "../priority/component.js";
import { POLICY_V1 } from "../priority/policy.js";

/**
 * Decision records (A28 design; tables in the A29 draft). A decision is written BEFORE the work it causes, in the same transaction,
 * and lists every candidate considered with its features (each citing a source), its score components and the action taken,
 * including the non-actions. Rationale is a concise explanation, never model reasoning.
 */
export const RESEARCH_POLICY_V0 = {
  version: "research-policy/0",
  opportunity: { priority: POLICY_V1, slots: 1, selection: "human (T-040 principle 4): the policy recommends one, a person selects", screenOutWhen: ["program not verified", "eligibility not verified or contradicted", "possible duplicate of an earlier opportunity", "no repository verified as official and in scope"] },
  component: { priority: COMPONENT_POLICY_V1, slots: 1, seedRule: "seed = the decision sequence number within the snapshot" },
  followUp: { humanReviewWhen: "an independent evaluator supports a lead and no human outcome exists", stopWhen: "every component examined for every specialist class at its current hash" },
} as const;
export const POLICY_JSON = canonicalJson(RESEARCH_POLICY_V0);
export const POLICY_SHA256 = sha256Hex(POLICY_JSON);

export type Feature = { value: unknown; source: string } | { value: null; unknown_reason: string };
export type CandidateAction = "investigate" | "defer" | "skip_duplicate_risk" | "skip_out_of_scope" | "skip_budget" | "skip_low_value" | "recommend" | "request_human_review" | "complete";
export type Candidate = {
  kind: "opportunity" | "repository" | "component" | "function" | "path" | "hypothesis";
  ref: string; features: Record<string, Feature>; scoreComponents: Record<string, unknown>;
  action: CandidateAction; reason: string; selectionProbability?: number | null;
  resultingRunId?: string | null; resultingStepId?: string | null;
};
export type DecisionInput = {
  level: "opportunity" | "repository" | "component" | "function" | "path" | "follow_up";
  contextRunId?: string | null; snapshotId?: string | null; protocolModelSha256?: string | null;
  decidedBy: { kind: "policy" } | { kind: "human"; id: string };
  mode: "exploit" | "explore" | "manual"; exploreRule?: string | null; rationale: string;
};
export type Db = Pick<PoolClient, "query">;

export async function storePolicy(db: Db): Promise<string> {
  const bytes = Buffer.from(POLICY_JSON, "utf8");
  await db.query("INSERT INTO research_blobs (content_sha256, size_bytes, content) VALUES ($1, $2, $3) ON CONFLICT (content_sha256) DO NOTHING", [POLICY_SHA256, bytes.length, bytes]);
  return POLICY_SHA256;
}

/** Writes the decision header. Candidates are added with `addCandidates` once any work they cause exists (decide, then act, same transaction). */
export async function openDecision(db: Db, d: DecisionInput): Promise<string> {
  const policy = d.decidedBy.kind === "policy" ? await storePolicy(db) : null;
  const r = await db.query<{ id: string }>(
    `INSERT INTO research_decisions (level, context_run_id, snapshot_id, protocol_model_sha256, decided_by_kind, decided_by, policy_sha256, mode, explore_rule, rationale)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [d.level, d.contextRunId ?? null, d.snapshotId ?? null, d.protocolModelSha256 ?? null, d.decidedBy.kind, d.decidedBy.kind === "policy" ? RESEARCH_POLICY_V0.version : d.decidedBy.id,
      policy, d.mode, d.exploreRule ?? null, d.rationale.slice(0, 2000)]);
  return r.rows[0]!.id;
}

export async function addCandidates(db: Db, decisionId: string, candidates: readonly Candidate[]): Promise<void> {
  for (const [i, c] of candidates.entries()) {
    await db.query(
      `INSERT INTO research_decision_candidates (decision_id, rank, candidate_kind, candidate_ref, features, score_components, selected, selection_probability, action, reason, resulting_run_id, resulting_step_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
      [decisionId, i + 1, c.kind, c.ref, JSON.stringify(c.features), JSON.stringify(c.scoreComponents), c.action === "investigate" || c.action === "request_human_review",
        c.selectionProbability ?? null, c.action, c.reason.slice(0, 1000), c.resultingRunId ?? null, c.resultingStepId ?? null]);
  }
}
