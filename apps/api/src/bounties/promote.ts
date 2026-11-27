/**
 * The discovery -> research bridge (task 5, "the most important part"). It feeds genuinely ELIGIBLE bounty programmes into the EXISTING
 * repository_research pipeline, reusing createRepositoryResearchRunIn — it does not create a second scanning pipeline.
 *
 * Guardrails, by construction:
 * - Only tier === "eligible" programmes are promoted (officially confirmed + smart-contract scope + reward). A discovered or
 *   community-reported lead (needs_verification) is NEVER promoted. With Sherlock/HackenProof/Immunefi collection disabled, there are
 *   usually zero eligible programmes, so this promotes nothing until a source is enabled and a programme is officially confirmed.
 * - It only CREATES QUEUED runs; it never calls a model. All AI spend stays behind the worker + AiBudgetGateway ($25/mo), which this
 *   code does not touch. A flood is bounded by maxNewRuns.
 * - Repository de-duplication: a programme already linked to a run for a (repository, ref) is skipped; a repository already analysed by
 *   another programme's run is REUSED (a link to the existing run is recorded) rather than re-dispatched.
 * - Every promotion records a bounty_research_links row (provenance: programme -> repository -> run), inside the same transaction as
 *   the run creation, so the link and the run commit together or not at all.
 *
 * createRun is injected (defaults to the production creator) so the bridge is unit-testable without the acquisition layer.
 */
import type { Pool, PoolClient } from "pg";
import { createRepositoryResearchRunIn } from "../acquisition/step.js";
import { classifyEligibility } from "./eligibility.js";
import { resolveProgrammeRepositories } from "./repo-resolve.js";
import type { Resolution } from "./resolve.js";

export type CreateRun = (
  client: Pick<PoolClient, "query">,
  input: { repository: string; ref?: string },
  createdBy: string,
  options?: { structuralAnalysis?: boolean },
) => Promise<{ runId: string }>;

export type PromoteOptions = {
  maxNewRuns?: number;         // cap on NEW runs created per invocation (default 25); reused links do not count
  createdBy?: string;          // audit actor (default "bounty-bridge")
  structuralAnalysis?: boolean; // append analysis stages to created runs (default false; acquisition-only otherwise)
  dryRun?: boolean;            // resolve and decide, but create nothing (for reporting)
  createRun?: CreateRun;       // injected for tests; defaults to createRepositoryResearchRunIn
};

export type PromotionAction = {
  programId: string;
  project: string;
  repository: string;
  ref: string | null;
  action: "created" | "reused" | "already_linked" | "skipped_cap" | "skipped_dry_run";
  workflowRunId: string | null;
  reason: string;
};

export type PromoteResult = {
  eligible_programmes: number;
  repositories_considered: number;
  created: number;
  reused: number;
  already_linked: number;
  skipped_cap: number;
  skipped_dry_run: number;
  actions: PromotionAction[];
};

type ProgramRow = { id: string; project_name: string | null; resolved: unknown; verification: string | null; status: string | null };

/** Promote eligible programmes into repository_research runs. Read eligible candidates, resolve repos, de-dup, create/reuse runs. */
export async function promoteEligibleProgrammes(pool: Pool, opts: PromoteOptions = {}): Promise<PromoteResult> {
  const maxNewRuns = opts.maxNewRuns ?? 25;
  const createdBy = opts.createdBy ?? "bounty-bridge";
  const createRun = opts.createRun ?? createRepositoryResearchRunIn;
  const result: PromoteResult = { eligible_programmes: 0, repositories_considered: 0, created: 0, reused: 0, already_linked: 0, skipped_cap: 0, skipped_dry_run: 0, actions: [] };

  const { rows } = await pool.query<ProgramRow>(
    `SELECT id, project_name, resolved, verification, status FROM bounty_programs WHERE merged_into IS NULL ORDER BY id`);

  for (const row of rows) {
    const resolved = (row.resolved ?? {}) as Resolution["resolved"];
    const elig = classifyEligibility({ resolved, verification: row.verification ?? "unverified" } as Resolution);
    if (elig.tier !== "eligible") continue; // evidence-based: only officially-confirmed, sc-scoped, funded programmes
    result.eligible_programmes += 1;
    const { repositories } = resolveProgrammeRepositories(resolved);
    for (const repository of repositories) {
      result.repositories_considered += 1;
      const ref: string | null = null; // default branch; acquisition pins the commit
      const action = await promoteOne(pool, { programId: row.id, project: row.project_name ?? row.id, repository, ref }, { maxNewRuns, createdBy, createRun, structuralAnalysis: opts.structuralAnalysis ?? false, dryRun: opts.dryRun ?? false }, result);
      result.actions.push(action);
    }
  }
  return result;
}

async function promoteOne(
  pool: Pool,
  target: { programId: string; project: string; repository: string; ref: string | null },
  cfg: { maxNewRuns: number; createdBy: string; createRun: CreateRun; structuralAnalysis: boolean; dryRun: boolean },
  result: PromoteResult,
): Promise<PromotionAction> {
  const base = { programId: target.programId, project: target.project, repository: target.repository, ref: target.ref };

  // Already linked for this (programme, repository, ref)?
  const existing = await pool.query(
    `SELECT workflow_run_id FROM bounty_research_links WHERE bounty_program_id = $1 AND repository = $2 AND ref IS NOT DISTINCT FROM $3 LIMIT 1`,
    [target.programId, target.repository, target.ref]);
  if (existing.rows[0]) { result.already_linked += 1; return { ...base, action: "already_linked", workflowRunId: String(existing.rows[0].workflow_run_id), reason: "this programme is already linked to a run for this repository" }; }

  // Another programme already has a (non-failed) run for this repository+ref? Reuse it.
  const reusable = await pool.query(
    `SELECT l.workflow_run_id FROM bounty_research_links l JOIN workflow_runs r ON r.id = l.workflow_run_id
       WHERE l.repository = $1 AND l.ref IS NOT DISTINCT FROM $2 AND r.status <> 'failed' ORDER BY l.created_at LIMIT 1`,
    [target.repository, target.ref]);

  if (cfg.dryRun) { result.skipped_dry_run += 1; return { ...base, action: "skipped_dry_run", workflowRunId: reusable.rows[0] ? String(reusable.rows[0].workflow_run_id) : null, reason: reusable.rows[0] ? "would reuse an existing run" : "would create a new run" }; }

  if (reusable.rows[0]) {
    const runId = String(reusable.rows[0].workflow_run_id);
    await pool.query(
      `INSERT INTO bounty_research_links (bounty_program_id, repository, ref, workflow_run_id, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (bounty_program_id, repository, ref) DO NOTHING`,
      [target.programId, target.repository, target.ref, runId, "reused an existing run for this repository (already analysed)", cfg.createdBy]);
    result.reused += 1; return { ...base, action: "reused", workflowRunId: runId, reason: "reused an existing run for this repository" };
  }

  if (result.created >= cfg.maxNewRuns) { result.skipped_cap += 1; return { ...base, action: "skipped_cap", workflowRunId: null, reason: `reached the per-run creation cap (${cfg.maxNewRuns})` }; }

  // Create the run and record the link atomically.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { runId } = await cfg.createRun(client, { repository: target.repository, ...(target.ref ? { ref: target.ref } : {}) }, cfg.createdBy, { structuralAnalysis: cfg.structuralAnalysis });
    await client.query(
      `INSERT INTO bounty_research_links (bounty_program_id, repository, ref, workflow_run_id, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [target.programId, target.repository, target.ref, runId, "eligible programme, repository newly resolved", cfg.createdBy]);
    await client.query("COMMIT");
    result.created += 1; return { ...base, action: "created", workflowRunId: runId, reason: "eligible programme, repository newly resolved" };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
