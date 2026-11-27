import { Pool } from "pg";
import { buildPoolConfig, stderrWarning } from "../db-config.js";
import { githubSourceFromEnv } from "../acquisition/github-source.js";
import { createHttpGet } from "./http.js";
import { enrichEligibleProgrammes } from "./enrich.js";

/**
 * One enrichment pass, then exit: for eligible programmes with no verified repository, fetch each programme's official Sherlock/
 * HackenProof page (robots-checked, source-gated), extract its in-scope GitHub repositories, verify identity against GitHub, and store
 * the mappings with evidence and a confidence status. Makes no model calls. Immunefi is never fetched.
 *
 *   node dist/apps/api/src/bounties/enrich-main.js [--max 50]
 *
 * NOT scheduled in production yet: needs migration 0014 and is meaningful once Sherlock/HackenProof are enabled. Exit 0 / 1.
 */
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(64); }
const pool = new Pool(buildPoolConfig(process.env, { max: 4, onWarning: stderrWarning, applicationName: "agentsmith-enrich" }));
pool.on("error", (e) => console.error(JSON.stringify({ level: "error", msg: "idle_database_connection_error", error: e.message })));
try {
  const maxArg = flag("--max");
  const deps = { get: createHttpGet(), github: githubSourceFromEnv() };
  const r = await enrichEligibleProgrammes(pool, deps, { ...(maxArg ? { maxProgrammes: Number(maxArg) } : {}) });
  const outcomes: Record<string, number> = {};
  for (const x of r.results) outcomes[x.outcome] = (outcomes[x.outcome] ?? 0) + 1;
  // One line per programme so an operator can see WHY a pass found nothing (robots, fetch error, no repository, all dropped).
  for (const x of r.results) console.log(JSON.stringify({ level: "info", msg: "enrich_programme", outcome: x.outcome, platform: x.platform, url: x.officialUrl,
    verified: x.verified, rejected: x.rejected, unavailable: x.unavailable, dropped: x.dropped, deferred: x.deferred, error: x.error }));
  console.log(JSON.stringify({ level: "info", msg: "enrich_finished", attempted: r.attempted, enriched: r.enriched, verified_repositories: r.verified_repositories, outcomes }));
  process.exitCode = 0;
} catch (e) {
  console.error(JSON.stringify({ level: "error", msg: "enrich_failed", error: (e as Error).message }));
  process.exitCode = 1;
} finally { await pool.end(); }
