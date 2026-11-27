/**
 * The repository monitor (the autonomous loop's missing piece). For every repository AgentSmith is researching, it resolves the live
 * HEAD of the default branch, asks planRepositoryResearch whether that commit is new, and — when it is — automatically queues an
 * incremental (or first-pass) repository_research run against that exact commit, with provenance links to the owning programmes. No
 * human initiates any of this.
 *
 * It reuses the acquisition layer's RepositorySource (resolveCommit / getRepository) for HEAD resolution and its typed errors, so it
 * handles deleted/inaccessible repositories, rate limits, timeouts and transient GitHub failures the same way acquisition does. It
 * creates only QUEUED runs and calls no model; analysis and sealing are the worker's job under the AiBudgetGateway. A repository is
 * NEVER marked researched merely because its HEAD was fetched — "analysed" means a sealed snapshot (repo_snapshots), tracked separately.
 *
 * The GitHub source and the run creator are injected, so the whole loop is exercisable in a disposable-Postgres integration test.
 */
import type { Pool } from "pg";
import { AcquisitionError } from "../acquisition/errors.js";
import type { RepositorySource } from "../acquisition/github-source.js";
import { parseRepositoryName } from "../acquisition/github-source.js";
import { createRepositoryResearchRunIn } from "../acquisition/step.js";
import type { CreateRun } from "./promote.js";
import { planRepositoryResearch } from "./repo-intel.js";

export type MonitorSource = Pick<RepositorySource, "getRepository" | "resolveCommit">;
export type MonitorDeps = { source: MonitorSource; createRun?: CreateRun; now?: () => Date };
/** structuralAnalysis: append the analysis stages to queued rescans (as the bridge does with --structural). Default false: acquisition only. */
export type MonitorOptions = { maxRescans?: number; backoffBaseSeconds?: number; maxBackoffSeconds?: number; disableAfterFailures?: number; structuralAnalysis?: boolean };
export type MonitorOutcome = "up_to_date" | "first_scan_queued" | "rescan_queued" | "already_queued" | "unavailable" | "error" | "skipped_cap";
export type RepoCheck = { repository: string; outcome: MonitorOutcome; headCommit: string | null; decision: string | null; runId: string | null; error: string | null };
export type MonitorResult = {
  checked: number; queued: number; up_to_date: number; already_queued: number; unavailable: number; errors: number; skipped_cap: number;
  checks: RepoCheck[];
};

type Cfg = { source: MonitorSource; now: () => Date; createRun: CreateRun; maxRescans: number; backoffBase: number; maxBackoff: number; disableAfter: number; structuralAnalysis: boolean };

/** Monitor every tracked repository once. Repositories are tracked as soon as the bridge links them to a programme. */
export async function monitorRepositories(pool: Pool, deps: MonitorDeps, opts: MonitorOptions = {}): Promise<MonitorResult> {
  const cfg: Cfg = {
    source: deps.source, now: deps.now ?? (() => new Date()), createRun: deps.createRun ?? createRepositoryResearchRunIn,
    maxRescans: opts.maxRescans ?? 25, backoffBase: opts.backoffBaseSeconds ?? 300, maxBackoff: opts.maxBackoffSeconds ?? 6 * 3600, disableAfter: opts.disableAfterFailures ?? 10, structuralAnalysis: opts.structuralAnalysis ?? false,
  };
  const res: MonitorResult = { checked: 0, queued: 0, up_to_date: 0, already_queued: 0, unavailable: 0, errors: 0, skipped_cap: 0, checks: [] };

  await pool.query(`INSERT INTO repository_monitors (repository) SELECT DISTINCT repository FROM bounty_research_links ON CONFLICT (repository) DO NOTHING`);
  const due = await pool.query<{ repository: string }>(
    `SELECT repository FROM repository_monitors WHERE enabled AND (next_attempt_at IS NULL OR next_attempt_at <= $1) ORDER BY last_checked_at NULLS FIRST, repository`, [cfg.now()]);

  for (const { repository } of due.rows) {
    res.checked += 1;
    res.checks.push(await monitorOne(pool, repository, cfg, res));
  }
  return res;
}

async function monitorOne(pool: Pool, repository: string, cfg: Cfg, res: MonitorResult): Promise<RepoCheck> {
  const { owner, repo } = parseRepositoryName(repository);
  let headCommit: string;
  let defaultBranch: string;
  try {
    const identity = await cfg.source.getRepository(owner, repo);
    defaultBranch = identity.defaultBranch;
    headCommit = (await cfg.source.resolveCommit(owner, repo, defaultBranch)).commitSha;
  } catch (e) {
    return handleSourceError(pool, repository, e, cfg, res);
  }

  const plan = await planRepositoryResearch(pool, repository, headCommit);

  if (plan.decision === "already_analysed") {
    await setMonitor(pool, repository, { headCommit, defaultBranch, outcome: "up_to_date", resetFailures: true });
    await logCheck(pool, repository, { headCommit, outcome: "up_to_date", decision: plan.decision });
    res.up_to_date += 1;
    return { repository, outcome: "up_to_date", headCommit, decision: plan.decision, runId: null, error: null };
  }

  // Idempotency: is a non-terminal run already queued for this exact (repository, commit)? Then do not create a duplicate.
  const pending = await pool.query(
    `SELECT 1 FROM bounty_research_links l JOIN workflow_runs r ON r.id = l.workflow_run_id
       WHERE l.repository = $1 AND l.ref = $2 AND r.status IN ('queued','running','awaiting_approval') LIMIT 1`, [repository, headCommit]);
  if (pending.rows[0]) {
    await setMonitor(pool, repository, { headCommit, defaultBranch, outcome: "already_queued", resetFailures: true });
    await logCheck(pool, repository, { headCommit, outcome: "already_queued", decision: plan.decision });
    res.already_queued += 1;
    return { repository, outcome: "already_queued", headCommit, decision: plan.decision, runId: null, error: null };
  }

  if (res.queued >= cfg.maxRescans) {
    // Leave the monitor untouched so this repo is retried next pass; do not create beyond the cap.
    res.skipped_cap += 1;
    return { repository, outcome: "skipped_cap", headCommit, decision: plan.decision, runId: null, error: null };
  }

  // Create the rescan run at the exact HEAD commit and link it to every programme that owns this repository (provenance).
  const outcome: MonitorOutcome = plan.decision === "full" ? "first_scan_queued" : "rescan_queued";
  const reason = plan.decision === "full" ? "first scan (repository monitor)" : `incremental rescan: new commit ${headCommit.slice(0, 12)} since ${plan.baseCommit?.slice(0, 12) ?? "?"}`;
  const client = await pool.connect();
  let runId: string;
  try {
    await client.query("BEGIN");
    ({ runId } = await cfg.createRun(client, { repository, ref: headCommit }, "repo-monitor", { structuralAnalysis: cfg.structuralAnalysis }));
    await client.query(
      `INSERT INTO bounty_research_links (bounty_program_id, repository, ref, workflow_run_id, reason, created_by)
         SELECT DISTINCT bounty_program_id, $1, $2, $3::uuid, $4, 'repo-monitor' FROM bounty_research_links WHERE repository = $1
         ON CONFLICT (bounty_program_id, repository, ref) DO NOTHING`, [repository, headCommit, runId, reason]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw e;
  }
  client.release();

  await setMonitor(pool, repository, { headCommit, defaultBranch, outcome, resetFailures: true });
  await logCheck(pool, repository, { headCommit, outcome, decision: plan.decision, runId, baseCommit: plan.baseCommit });
  res.queued += 1;
  return { repository, outcome, headCommit, decision: plan.decision, runId, error: null };
}

async function handleSourceError(pool: Pool, repository: string, e: unknown, cfg: Cfg, res: MonitorResult): Promise<RepoCheck> {
  const err = e instanceof AcquisitionError ? e : new AcquisitionError("network", (e as Error).message ?? "unknown", true);
  // A repository that no longer exists / is not accessible: stop monitoring it (can be re-enabled by the operator).
  if (err.code === "repository_not_found") {
    await pool.query(`UPDATE repository_monitors SET enabled = false, last_checked_at = $2, last_outcome = 'unavailable', last_error = $3, updated_at = now() WHERE repository = $1`,
      [repository, cfg.now(), err.message]);
    await logCheck(pool, repository, { outcome: "unavailable", error: err.message });
    res.unavailable += 1;
    return { repository, outcome: "unavailable", headCommit: null, decision: null, runId: null, error: err.message };
  }
  // Transient (rate limit / timeout / network / upstream 5xx): back off, keep enabled, retry next pass.
  const failures = await bumpFailure(pool, repository, cfg, err);
  await logCheck(pool, repository, { outcome: "error", error: err.message });
  res.errors += 1;
  return { repository, outcome: failures >= cfg.disableAfter ? "unavailable" : "error", headCommit: null, decision: null, runId: null, error: err.message };
}

async function bumpFailure(pool: Pool, repository: string, cfg: Cfg, err: AcquisitionError): Promise<number> {
  const row = await pool.query<{ consecutive_failures: number }>(
    `UPDATE repository_monitors SET consecutive_failures = consecutive_failures + 1, last_checked_at = $2, last_outcome = 'error', last_error = $3, updated_at = now()
       WHERE repository = $1 RETURNING consecutive_failures`, [repository, cfg.now(), err.message]);
  const failures = row.rows[0]?.consecutive_failures ?? 1;
  const retryAfter = err.retryAfterSeconds ?? Math.min(cfg.maxBackoff, cfg.backoffBase * 2 ** (failures - 1));
  const next = new Date(cfg.now().getTime() + retryAfter * 1000);
  const disable = failures >= cfg.disableAfter;
  await pool.query(`UPDATE repository_monitors SET next_attempt_at = $2, enabled = $3 WHERE repository = $1`, [repository, next, !disable]);
  return failures;
}

async function setMonitor(pool: Pool, repository: string, o: { headCommit: string; defaultBranch: string; outcome: MonitorOutcome; resetFailures: boolean }): Promise<void> {
  await pool.query(
    `UPDATE repository_monitors SET default_branch = $2, last_head_commit = $3, last_checked_at = now(), last_outcome = $4, last_error = NULL,
        consecutive_failures = CASE WHEN $5 THEN 0 ELSE consecutive_failures END, next_attempt_at = NULL, updated_at = now() WHERE repository = $1`,
    [repository, o.defaultBranch, o.headCommit, o.outcome, o.resetFailures]);
}

async function logCheck(pool: Pool, repository: string, o: { headCommit?: string | null; outcome: string; decision?: string | null; runId?: string | null; baseCommit?: string | null; error?: string | null }): Promise<void> {
  await pool.query(
    `INSERT INTO repository_monitor_checks (repository, head_commit, outcome, decision, workflow_run_id, base_commit, error) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [repository, o.headCommit ?? null, o.outcome, o.decision ?? null, o.runId ?? null, o.baseCommit ?? null, o.error ?? null]);
}
