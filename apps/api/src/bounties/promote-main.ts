import { Pool } from "pg";
import { buildPoolConfig, stderrWarning } from "../db-config.js";
import { promoteEligibleProgrammes } from "./promote.js";
import { parseBountyScope } from "../acquisition/bounty-scope.js";

/**
 * One discovery -> research promotion pass, then exit: reads ELIGIBLE bounty programmes and queues repository_research runs for their
 * in-scope GitHub repositories (reusing the existing pipeline), recording a provenance link for each. It creates only queued runs and
 * calls no model; the worker (separate, approval-gated) does the analysis under the $25/mo AiBudgetGateway.
 *
 *   node dist/apps/api/src/bounties/promote-main.js [--dry-run] [--max 25] [--structural]
 * Targeted (one programme, one of its verified repositories, one exact commit, optionally the official scope):
 *   ... --programme sherlock:273 --repository scroll-tech/usx-contracts --commit <40-hex> --structural --max 1
 *       [--scope-paths src/A.sol,src/B.sol --scope-evidence <url or doc> --scope-evidence-sha256 <64-hex>]
 *       [--apex-shadow --apex-approved-by <who approved>]   (the APEX shadow stage: ONLY the approved USX run; refused otherwise;
 *                                                           measurement only, its output is never evidence; off without the flag)
 *
 * NOT scheduled in production yet: this requires migration 0012 (the link table) and is meaningful only once a source that yields
 * officially-confirmed programmes (Sherlock/Immunefi) is enabled. Until then it promotes nothing, by design. Exit 0 on success, 1 on error.
 */
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(64); }
if (args.includes("--apex-shadow") && !flag("--programme")) { console.error("--apex-shadow is valid only on a targeted promotion (--programme, --repository, --commit, the official scope)"); process.exit(64); }
const pool = new Pool(buildPoolConfig(process.env, { max: 4, onWarning: stderrWarning, applicationName: "agentsmith-bounty-bridge" }));
pool.on("error", (e) => console.error(JSON.stringify({ level: "error", msg: "idle_database_connection_error", error: e.message })));
try {
  const maxArg = flag("--max");
  const r = await promoteEligibleProgrammes(pool, {
    dryRun: args.includes("--dry-run"),
    structuralAnalysis: args.includes("--structural"),
    ...(maxArg ? { maxNewRuns: Number(maxArg) } : {}),
    ...(flag("--programme") ? { target: {
      programme: flag("--programme")!, repository: flag("--repository") ?? "", commit: flag("--commit") ?? "",
      ...(flag("--scope-paths") ? { bountyScope: parseBountyScope({ programme: flag("--programme"), in_scope_paths: flag("--scope-paths")!.split(","), evidence: flag("--scope-evidence"), evidence_sha256: flag("--scope-evidence-sha256") }) } : {}),
      // APEX shadow (measurement only): only with the explicit flag AND the approver's name; refused for any run but the approved USX target
      ...(args.includes("--apex-shadow") ? { apexShadow: { approvedBy: flag("--apex-approved-by") ?? "" } } : {}),
    } } : {}),
    createdBy: `bridge@${process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local"}`,
  });
  console.log(JSON.stringify({ level: "info", msg: "bounty_bridge_finished", eligible: r.eligible_programmes, repositories: r.repositories_considered,
    created: r.created, reused: r.reused, already_linked: r.already_linked, skipped_cap: r.skipped_cap, skipped_dry_run: r.skipped_dry_run }));
  if (flag("--programme")) for (const a of r.actions) console.log(JSON.stringify({ level: "info", msg: "bounty_bridge_action", programme: flag("--programme"), repository: a.repository, ref: a.ref, action: a.action, workflow_run_id: a.workflowRunId, reason: a.reason }));
  process.exitCode = 0;
} catch (e) {
  console.error(JSON.stringify({ level: "error", msg: "bounty_bridge_failed", error: (e as Error).message }));
  process.exitCode = 1;
} finally { await pool.end(); }
