import { Pool } from "pg";
import { buildPoolConfig, stderrWarning } from "../db-config.js";
import { runCollection } from "./collect.js";
import { createHttpGet } from "./http.js";

/**
 * One bounty collection run, then exit: the command a schedule runs (for example a Fly scheduled machine, hourly).
 * It is not the research worker and claims no research step. Sources not yet due are skipped, so running it more often than
 * a source's interval is harmless. Exit code: 0 succeeded or nothing due, 1 every attempted source failed, 2 partial, 3 already running.
 *   node dist/apps/api/src/bounties/collect-main.js [--force] [--sources community-board,sherlock] [--trigger manual]
 */
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(64); }
const pool = new Pool(buildPoolConfig(process.env, { max: 4, onWarning: stderrWarning, applicationName: "agentsmith-bounty-collector" }));
pool.on("error", (e) => console.error(JSON.stringify({ level: "error", msg: "idle_database_connection_error", error: e.message })));
try {
  const trigger = (flag("--trigger") ?? "schedule") as "schedule" | "manual";
  const sources = flag("--sources")?.split(",").map((s) => s.trim()).filter(Boolean);
  const r = await runCollection(pool, { trigger, startedBy: `collector@${process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? "local"}`, http: createHttpGet(), force: args.includes("--force"), ...(sources ? { sources } : {}) });
  console.log(JSON.stringify({ level: "info", msg: "bounty_collection_finished", run: r.runId, status: r.status,
    checks: r.checks.map((c) => ({ source: c.source, outcome: c.outcome, listings: c.listings, added: c.added, updated: c.updated, unchanged: c.unchanged, matched: c.matched, delisted: c.delisted, needs_verification: c.needsVerification, error: c.error })) }));
  process.exitCode = r.status === "failed" ? 1 : r.status === "partial" ? 2 : r.status === "already_running" ? 3 : 0;
} finally { await pool.end(); }
