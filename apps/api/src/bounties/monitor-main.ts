import { Pool } from "pg";
import { buildPoolConfig, stderrWarning } from "../db-config.js";
import { GitHubSource } from "../acquisition/github-source.js";
import { monitorRepositories } from "./monitor.js";

/**
 * One repository-monitor pass, then exit: resolve each tracked repository's HEAD and queue an incremental research run when the commit
 * is new. Reuses the acquisition GitHub source for HEAD resolution and the existing repository_research pipeline for the run. It
 * creates only queued runs and calls no model; the worker does the analysis under the AiBudgetGateway.
 *
 *   node dist/apps/api/src/bounties/monitor-main.js [--max 25]
 *
 * NOT scheduled in production yet: it needs migrations 0012 (links) and 0013 (monitor state), and is meaningful only once programmes
 * have been promoted and the worker is active. Exit 0 on success, 1 on error.
 */
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(64); }
const pool = new Pool(buildPoolConfig(process.env, { max: 4, onWarning: stderrWarning, applicationName: "agentsmith-repo-monitor" }));
pool.on("error", (e) => console.error(JSON.stringify({ level: "error", msg: "idle_database_connection_error", error: e.message })));
try {
  const maxArg = flag("--max");
  const source = new GitHubSource({ ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}) });
  const r = await monitorRepositories(pool, { source }, { ...(maxArg ? { maxRescans: Number(maxArg) } : {}) });
  console.log(JSON.stringify({ level: "info", msg: "repo_monitor_finished", checked: r.checked, queued: r.queued, up_to_date: r.up_to_date,
    already_queued: r.already_queued, unavailable: r.unavailable, errors: r.errors, skipped_cap: r.skipped_cap }));
  process.exitCode = 0;
} catch (e) {
  console.error(JSON.stringify({ level: "error", msg: "repo_monitor_failed", error: (e as Error).message }));
  process.exitCode = 1;
} finally { await pool.end(); }
