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
import { verifiedRepositoriesFor } from "./enrich.js";
import { latestSealedSnapshot } from "./repo-intel.js";
import { resolveProgrammeRepositories } from "./repo-resolve.js";
import type { Resolution } from "./resolve.js";
import type { BountyScope } from "../acquisition/bounty-scope.js";

export type CreateRun = (
  client: Pick<PoolClient, "query">,
  input: { repository: string; ref?: string },
  createdBy: string,
  options?: { structuralAnalysis?: boolean; bountyScope?: BountyScope },
) => Promise<{ runId: string }>;

export type PromoteOptions = {
  maxNewRuns?: number;         // cap on NEW runs created per invocation (default 25); reused links do not count
  createdBy?: string;          // audit actor (default "bounty-bridge")
  structuralAnalysis?: boolean; // append analysis stages to created runs (default false; acquisition-only otherwise)
  dryRun?: boolean;            // resolve and decide, but create nothing (for reporting)
  createRun?: CreateRun;       // injected for tests; defaults to createRepositoryResearchRunIn
  /**
   * A TARGETED promotion: exactly one programme (canonical key, e.g. "sherlock:273") and one of ITS verified repositories, pinned to a
   * full commit id, optionally with the official bounty scope. Nothing else is considered. A repository that is not among the
   * programme's resolved or verified repositories is refused, never inferred. Without `target` the bridge behaves exactly as before.
   */
  target?: { programme: string; repository: string; commit: string; bountyScope?: BountyScope };
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

/** A targeted promotion (see PromoteOptions.target). */
export type PromoteTarget = NonNullable<PromoteOptions["target"]>;

type ProgramRow = { id: string; project_name: string | null; resolved: unknown; verification: string | null; status: string | null };

/** Promote eligible programmes into repository_research runs. Read eligible candidates, resolve repos, de-dup, create/reuse runs. */
export async function promoteEligibleProgrammes(pool: Pool, opts: PromoteOptions = {}): Promise<PromoteResult> {
  const maxNewRuns = opts.maxNewRuns ?? 25;
  const createdBy = opts.createdBy ?? "bounty-bridge";
  const createRun = opts.createRun ?? createRepositoryResearchRunIn;
  const result: PromoteResult = { eligible_programmes: 0, repositories_considered: 0, created: 0, reused: 0, already_linked: 0, skipped_cap: 0, skipped_dry_run: 0, actions: [] };

  const t = opts.target;
  if (t) {
    if (!/^[0-9a-f]{40}$/.test(t.commit)) throw new Error("a targeted promotion needs a full 40-character commit id");
    if (t.bountyScope && t.bountyScope.programme !== t.programme) throw new Error("the bounty scope belongs to a different programme");
  }
  const { rows } = t
    ? await pool.query<ProgramRow>(`SELECT id, project_name, resolved, verification, status FROM bounty_programs WHERE merged_into IS NULL AND canonical_key = $1`, [t.programme])
    : await pool.query<ProgramRow>(`SELECT id, project_name, resolved, verification, status FROM bounty_programs WHERE merged_into IS NULL ORDER BY id`);
  if (t && !rows[0]) throw new Error(`programme ${t.programme} does not exist`);

  for (const row of rows) {
    const resolved = (row.resolved ?? {}) as Resolution["resolved"];
    const elig = classifyEligibility({ resolved, verification: row.verification ?? "unverified" } as Resolution);
    if (elig.tier !== "eligible") { if (t) throw new Error(`programme ${t.programme} is not eligible (${elig.tier})`); continue; } // evidence-based: only officially-confirmed, sc-scoped, funded programmes
    result.eligible_programmes += 1;
    // Repositories come from the collected fields AND from verified enrichment mappings (officially_confirmed/official_documentation
    // only — inferred/unverified never enter research automatically).
    const resolvedRepos = resolveProgrammeRepositories(resolved).repositories;
    const verified = await verifiedRepositoriesFor(pool, row.id);
    const all = [...new Set([...resolvedRepos, ...verified])];
    if (t && !all.some((r) => r.toLowerCase() === t.repository.toLowerCase())) throw new Error(`${t.repository} is not a resolved or verified repository of ${t.programme}; refusing to infer an association`);
    const repositories = t ? all.filter((r) => r.toLowerCase() === t.repository.toLowerCase()) : all;
    for (const repository of repositories) {
      result.repositories_considered += 1;
      const ref: string | null = t ? t.commit : null; // untargeted: default branch (acquisition pins the commit); targeted: the exact commit
      const action = await promoteOne(pool, { programId: row.id, project: row.project_name ?? row.id, repository, ref }, { maxNewRuns, createdBy, createRun, structuralAnalysis: opts.structuralAnalysis ?? false, dryRun: opts.dryRun ?? false, ...(t?.bountyScope ? { bountyScope: t.bountyScope } : {}) }, result);
      result.actions.push(action);
    }
  }
  return result;
}

async function promoteOne(
  pool: Pool,
  target: { programId: string; project: string; repository: string; ref: string | null },
  cfg: { maxNewRuns: number; createdBy: string; createRun: CreateRun; structuralAnalysis: boolean; dryRun: boolean; bountyScope?: BountyScope },
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

  // No bounty link yet, but has this repository already been analysed by ANY run (e.g. a manual intake or an engine run)? If so,
  // reuse that run instead of re-dispatching the same code. Repository intelligence, not a second scan.
  let analysedRunId: string | null = null;
  // A pinned (targeted) promotion never reuses another run by repository alone: that run may have analysed a different commit, or carry
  // no bounty scope. It creates its own run for exactly this commit.
  if (!reusable.rows[0] && target.ref === null) {
    const sealed = await latestSealedSnapshot(pool, target.repository);
    if (sealed) analysedRunId = sealed.runId;
  }

  const reuseRunId: string | null = reusable.rows[0] && !cfg.bountyScope ? String(reusable.rows[0].workflow_run_id) : analysedRunId;

  if (cfg.dryRun) { result.skipped_dry_run += 1; return { ...base, action: "skipped_dry_run", workflowRunId: reuseRunId, reason: reuseRunId ? "would reuse an existing run" : "would create a new run" }; }

  if (reuseRunId) {
    const via = reusable.rows[0] ? "another programme's run" : "a prior run that already analysed this repository";
    await pool.query(
      `INSERT INTO bounty_research_links (bounty_program_id, repository, ref, workflow_run_id, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (bounty_program_id, repository, ref) DO NOTHING`,
      [target.programId, target.repository, target.ref, reuseRunId, `reused ${via} (already analysed)`, cfg.createdBy]);
    result.reused += 1; return { ...base, action: "reused", workflowRunId: reuseRunId, reason: `reused ${via}` };
  }

  if (result.created >= cfg.maxNewRuns) { result.skipped_cap += 1; return { ...base, action: "skipped_cap", workflowRunId: null, reason: `reached the per-run creation cap (${cfg.maxNewRuns})` }; }

  // Create the run and record the link atomically.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { runId } = await cfg.createRun(client, { repository: target.repository, ...(target.ref ? { ref: target.ref } : {}) }, cfg.createdBy, { structuralAnalysis: cfg.structuralAnalysis, ...(cfg.bountyScope ? { bountyScope: cfg.bountyScope } : {}) });
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
