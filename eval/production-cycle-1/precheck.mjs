// Read-only production pre-check. Prints no secrets. Every database statement runs inside BEGIN READ ONLY ... ROLLBACK.
import { createRequire } from "node:module"; const pg = createRequire("/app/package.json")("pg");
const { buildPoolConfig } = await import("/app/dist/apps/api/src/db-config.js");
const { GitHubSource } = await import("/app/dist/apps/api/src/acquisition/github-source.js");
const out = { db: {}, github: {}, image: {} };
const fs = await import("node:fs");
out.image.workerEntrypoint = fs.existsSync("/app/dist/apps/api/src/worker-main.js");
out.image.structuralStep = fs.existsSync("/app/dist/apps/api/src/analysis/solidity/step.js");
const pool = new pg.Pool(buildPoolConfig(process.env, { max: 1, applicationName: "readonly-precheck", onWarning: () => {} }));
const c = await pool.connect();
try {
  await c.query("BEGIN READ ONLY");
  const q = async (k, sql) => { try { out.db[k] = (await c.query(sql)).rows; } catch (e) { out.db[k] = `error ${e.code ?? ""}: ${e.message}`; await c.query("ROLLBACK"); await c.query("BEGIN READ ONLY"); } };
  await q("role", "SELECT current_user, session_user, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user");
  await q("nonSystemRoles", "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1");
  await q("ownerOfResearchTables", "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('workflow_runs','workflow_steps','repo_snapshots','hypotheses','hypothesis_evaluations') ORDER BY 1");
  await q("migrations", "SELECT name FROM schema_migrations ORDER BY name");
  await q("discoveryTable", "SELECT to_regclass('public.discovery_sources')::text AS discovery_sources");
  await q("runsByType", "SELECT workflow_type, status, count(*)::int FROM workflow_runs GROUP BY 1,2 ORDER BY 1,2");
  await q("counts", "SELECT (SELECT count(*) FROM workflow_steps)::int AS steps, (SELECT count(*) FROM repo_snapshots)::int AS snapshots, (SELECT count(*) FROM hypotheses)::int AS hypotheses, (SELECT count(*) FROM hypothesis_evaluations)::int AS evaluations, (SELECT count(*) FROM research_blobs)::int AS blobs");
  await q("sessions", "SELECT application_name, count(*)::int FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1 ORDER BY 1");
  await q("dbSize", "SELECT pg_size_pretty(pg_database_size(current_database())) AS size");
  await c.query("ROLLBACK");
} finally { c.release(); await pool.end(); }
// GitHub through the deployed client (SSRF-guarded fetch, no token, exactly what the worker would use). Read-only GETs.
const gh = new GitHubSource({});
const t0 = Date.now();
try {
  const id = await gh.getRepository("OpenZeppelin", "ethernaut"); out.github.identity = id;
  const cm = await gh.resolveCommit("OpenZeppelin", "ethernaut", "d05643a40aa98c45d66247c69ffceab8f44dd8cb"); out.github.commit = cm;
  const tree = await gh.getTree("OpenZeppelin", "ethernaut", cm.treeSha);
  out.github.tree = { sha: tree.sha, truncated: tree.truncated, nonDirectoryEntries: tree.entries.filter((e) => e.type !== "tree").length };
} catch (e) { out.github.error = `${e.name}: ${e.message}`; }
try {
  const r = await fetch("https://api.github.com/rate_limit", { headers: { "user-agent": "agentsmith-precheck" } });
  const j = await r.json(); out.github.rateLimitCore = j.resources?.core;
} catch (e) { out.github.rateLimitError = e.message; }
try {
  const r = await fetch("https://codeload.github.com/OpenZeppelin/ethernaut/tar.gz/d05643a40aa98c45d66247c69ffceab8f44dd8cb", { method: "HEAD", headers: { "user-agent": "agentsmith-precheck" } });
  out.github.codeloadHead = { status: r.status, contentLength: r.headers.get("content-length") };
} catch (e) { out.github.codeloadError = e.message; }
out.github.elapsedMs = Date.now() - t0;
console.log(JSON.stringify(out, null, 1));
