import { readFileSync } from "node:fs";
import pg, { type Pool, type PoolClient } from "pg";
import { ACQUIRE_STEP_KEY, processAcquireRepositoryStep } from "../acquisition/step.js";
import { GitHubSource, type RepositorySource } from "../acquisition/github-source.js";
import { ResearchStore } from "../research-state.js";
import { WorkflowWorker } from "../worker.js";
import { POLICY_SHA256, RESEARCH_POLICY_V0 } from "./decisions.js";
import { accountFor, ingestInvestigation, mapAndAssign, outcomeLedger, rankOpportunities, recordHumanOutcome, sameVersionSnapshots, selectOpportunity } from "./loop.js";
import { readRegistry, recordVerification, registerManualOpportunity, type CheckKind } from "./registry.js";
import { CHALLENGE_TARGET_STEP_KEY, dispatchEngineStep, ENGINE_STEP_KEYS, producerOutput } from "./steps.js";
import { withDryRun } from "./effects.js";
import { brief, exportSnapshot, importChallenge, importSpecialist } from "./attended.js";
import { compareSpecialists } from "./compare.js";
import { ATTENDED_CHALLENGE_STEP_KEY, ATTENDED_STEP_KEY } from "./capabilities.js";

/**
 * T-199: the operator interface to the research loop. One explicit command per stage; nothing runs by itself.
 *
 * Safety rules (all enforced here, all tested):
 * - DRY RUN BY DEFAULT. A write command runs the real stage inside a transaction that is rolled back, and prints what WOULD be recorded.
 *   Only `--execute` with `--confirm <database name>` (or the name typed at an interactive prompt) commits.
 * - Executing an assignment's steps also needs `--execute` and the confirmation; acquiring from GitHub additionally needs `--allow-network`.
 *   Steps run once, in this process, for the named run only: no daemon, no polling, no scheduler, no Fly worker.
 * - DISPOSABLE DATABASES ONLY: the database URL comes from `--database-url` or RESEARCH_LOOP_DATABASE_URL (never DATABASE_URL); the
 *   host must be loopback; the database name must start with `agentsmith_test_` or `agentsmith_scratch_`; a production marker in the
 *   environment refuses; and the T-144 + A29 drafts must already be present (this tool never applies a migration). A38 is not runnable.
 * - Credentials are never printed: the database is shown as name@host.
 */
export type CliIo = {
  out: (line: string) => void; err: (line: string) => void; env: Record<string, string | undefined>;
  /** interactive confirmation; absent when stdin is not a terminal */
  prompt?: (question: string) => Promise<string>;
  /** builds the repository source for acquisition. Called ONLY in an executed run-assignment that passed --allow-network; the default
   *  builds the real GitHub client. Tests inject a local fixture and count the calls. */
  sourceFactory?: () => RepositorySource;
};
export const EXIT = { ok: 0, usage: 2, refused: 3, failed: 1 } as const;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DISPOSABLE_NAME = /^agentsmith_(test|scratch)_[a-z0-9_]{1,50}$/;
const WRITE_COMMANDS = new Set(["register", "verify", "rank", "select", "map", "ingest", "adjudicate", "export-snapshot", "import-specialist", "import-challenge"]);
const EXEC_COMMANDS = new Set(["run-assignment"]);
const READ_COMMANDS = new Set(["status", "next", "registry", "show-decision", "ledger", "leads", "brief", "compare"]);

class Refusal extends Error { constructor(m: string) { super(m); this.name = "Refusal"; } }
class Usage extends Error { constructor(m: string) { super(m); this.name = "Usage"; } }

type Args = { command: string; flags: Record<string, string | true> };
export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv; const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!; if (!a.startsWith("--")) throw new Usage(`unexpected argument ${a}`);
    const key = a.slice(2); const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true; else { flags[key] = next; i++; }
  }
  return { command: command ?? "help", flags };
}
const str = (a: Args, k: string, required = true): string | undefined => {
  const v = a.flags[k]; if (typeof v === "string") return v;
  if (v === true) throw new Usage(`--${k} needs a value`); if (required) throw new Usage(`--${k} is required`); return undefined;
};

export type Target = { url: string; name: string; host: string };
/** Validates the target BEFORE connecting. Never returns or prints the password. */
export function resolveTarget(a: Args, env: CliIo["env"]): Target {
  if (env["HUB_DATA_KIND"] === "production" || env["FLY_APP_NAME"]) throw new Refusal("this environment is marked as production (HUB_DATA_KIND/FLY_APP_NAME); the research-loop CLI runs only against disposable local databases");
  const url = str(a, "database-url", false) ?? env["RESEARCH_LOOP_DATABASE_URL"];
  if (!url) throw new Usage("give --database-url or RESEARCH_LOOP_DATABASE_URL (DATABASE_URL is deliberately ignored)");
  let u: URL; try { u = new URL(url); } catch { throw new Usage("the database URL is not a valid URL"); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Usage("the database URL must be postgres://");
  const host = u.hostname.toLowerCase(); const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!LOOPBACK.has(host)) throw new Refusal(`host ${host} is not loopback; only a local disposable database is allowed (a remote database is A38 and is not enabled)`);
  if (!DISPOSABLE_NAME.test(name)) throw new Refusal(`database "${name}" is not named as disposable (agentsmith_test_* or agentsmith_scratch_*)`);
  return { url, name, host };
}

async function checkDatabase(pool: Pool, t: Target): Promise<void> {
  const r = (await pool.query<{ db: string; addr: string | null; dec: string | null; cov: string | null; pk: boolean; prod: boolean }>(
    `SELECT current_database() AS db, host(inet_server_addr()) AS addr, to_regclass('research_decisions')::text AS dec, to_regclass('research_coverage')::text AS cov,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'discovery_observations' AND column_name = 'provenance_kind') AS pk,
            EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'engine_production_marker') AS prod`)).rows[0]!;
  if (r.db !== t.name) throw new Refusal("connected database name differs from the URL");
  if (r.addr !== null && !["127.0.0.1", "::1"].includes(r.addr)) throw new Refusal(`the server reports address ${r.addr}, which is not loopback`);
  if (r.prod) throw new Refusal("this database carries a production marker");
  if (!r.dec || !r.cov || !r.pk) throw new Refusal("the T-144 and A29 drafts are not present in this database. This tool never applies migrations; apply the drafts only to a disposable database (they await review: A4b, A29)");
}

/**
 * Preview (dry run). Database: the real stage runs on ONE connection inside an outer transaction that is always rolled back; each
 * BEGIN/COMMIT/ROLLBACK the stage issues becomes a savepoint, so the stage behaves exactly as it would and nothing it writes survives.
 * Sequences are not transactional in PostgreSQL, so every sequence the preview advanced is set back afterwards (only if nobody else moved
 * it meanwhile; otherwise it is reported). Everything else: the stage runs under the dry-run side-effect guard, so any network request,
 * subprocess or file write it attempts is refused and the preview fails loudly instead of acting.
 */
export type PreviewReport = { sequencesRestored: string[]; sequencesNotRestored: string[]; refusedEffects: Array<{ effect: string; what: string }> };
export async function preview<T>(pool: Pool, fn: (p: Pool) => Promise<T>, report?: (r: PreviewReport) => void): Promise<T> {
  const client = await pool.connect(); const stack: string[] = []; let n = 0;
  const seqs = async (c: Pick<PoolClient, "query">) => new Map((await c.query<{ name: string; last_value: string | null; start_value: string }>(
    "SELECT quote_ident(schemaname) || '.' || quote_ident(sequencename) AS name, last_value::text, start_value::text FROM pg_sequences")).rows.map((r) => [r.name, r]));
  const query = (text: unknown, params?: unknown[]) => {
    const sql = typeof text === "string" ? text.trim().toUpperCase() : "";
    if (sql === "BEGIN") { const sp = `cli_preview_${++n}`; stack.push(sp); return client.query(`SAVEPOINT ${sp}`); }
    if (sql === "COMMIT") { const sp = stack.pop(); return client.query(sp ? `RELEASE SAVEPOINT ${sp}` : "SELECT 1"); }
    if (sql === "ROLLBACK") { const sp = stack.pop(); return client.query(sp ? `ROLLBACK TO SAVEPOINT ${sp}` : "SELECT 1"); }
    return (client.query as (t: unknown, p?: unknown[]) => Promise<unknown>)(text, params);
  };
  const wrapped = { query, release: () => undefined } as unknown as PoolClient;
  const fake = { query, connect: async () => wrapped, on: () => fake } as unknown as Pool;
  const before = await seqs(client);
  await client.query("BEGIN");
  const guarded = withDryRun(() => fn(fake));
  const out: PreviewReport = { sequencesRestored: [], sequencesNotRestored: [], refusedEffects: guarded.attempts };
  try { return await guarded.result; }
  finally {
    const reached = await seqs(client).catch(() => new Map());
    await client.query("ROLLBACK").catch(() => undefined);
    for (const [name, r] of reached) {
      const b = before.get(name); if (!b || b.last_value === r.last_value) continue;
      try {
        const now = (await client.query<{ v: string | null }>(`SELECT last_value::text v FROM pg_sequences WHERE quote_ident(schemaname) || '.' || quote_ident(sequencename) = $1`, [name])).rows[0]?.v ?? null;
        if (now !== r.last_value) { out.sequencesNotRestored.push(`${name} (moved by another session)`); continue; }
        if (b.last_value === null) await client.query("SELECT setval($1::regclass, $2::bigint, false)", [name, b.start_value]);
        else await client.query("SELECT setval($1::regclass, $2::bigint, true)", [name, b.last_value]);
        out.sequencesRestored.push(name);
      } catch { out.sequencesNotRestored.push(`${name} (no privilege to reset)`); }
    }
    client.release(); report?.(out);
  }
}

async function confirmed(a: Args, t: Target, io: CliIo, what: string): Promise<boolean> {
  if (a.flags["execute"] !== true) return false;
  const given = typeof a.flags["confirm"] === "string" ? a.flags["confirm"] : io.prompt ? (await io.prompt(`${what} on ${t.name}@${t.host}. Type the database name to confirm: `)).trim() : null;
  if (given === null) throw new Refusal("--execute needs --confirm <database name> when not run interactively");
  if (given !== t.name) throw new Refusal("confirmation does not match the database name; nothing was written");
  return true;
}

// -------------------------------------------------------------------------------------------------------------- rendering

const short = (s: string) => (/^[0-9a-f-]{36}$/.test(s) ? s.slice(0, 8) : s);
type CandRow = { rank: number; candidate_kind: string; candidate_ref: string; action: string; reason: string; selected: boolean; score_components: Record<string, unknown>; features: Record<string, unknown>; resulting_run_id: string | null };
function renderCandidates(io: CliIo, rows: readonly CandRow[], verbose: boolean): void {
  for (const c of rows) {
    const score = typeof c.score_components["score"] === "number" ? String(c.score_components["score"]).padStart(6) : "     -";
    io.out(`  ${String(c.rank).padStart(2)}. ${c.selected ? "*" : " "} ${c.action.padEnd(20)} ${score}  ${c.candidate_kind}:${short(c.candidate_ref)}  ${c.reason}${c.resulting_run_id ? `  -> run ${short(c.resulting_run_id)}` : ""}`);
    if (!verbose) continue;
    const contributions = (c.score_components["contributions"] ?? []) as Array<{ feature: string; raw: string; points: number; reason: string }>;
    for (const k of contributions) io.out(`        ${k.feature.padEnd(16)} ${String(k.points).padStart(7)}  ${k.raw}  (${k.reason})`);
    for (const [k, v] of Object.entries(c.features)) io.out(`        feature ${k}: ${JSON.stringify(v)}`);
  }
}
async function renderDecision(io: CliIo, db: Pick<Pool, "query">, id: string, verbose: boolean): Promise<Record<string, unknown>> {
  const d = (await db.query<{ id: string; level: string; mode: string; decided_by_kind: string; decided_by: string; rationale: string; snapshot_id: string | null; explore_rule: string | null; policy_sha256: string | null; created_at: Date }>(
    "SELECT id, level, mode, decided_by_kind, decided_by, rationale, snapshot_id, explore_rule, policy_sha256, created_at FROM research_decisions WHERE id = $1", [id])).rows[0];
  if (!d) throw new Usage(`no decision ${id}`);
  const rows = (await db.query<CandRow>("SELECT rank, candidate_kind, candidate_ref, action, reason, selected, score_components, features, resulting_run_id FROM research_decision_candidates WHERE decision_id = $1 ORDER BY rank", [id])).rows;
  io.out(`decision ${d.id}  level=${d.level} mode=${d.mode} by=${d.decided_by_kind}:${d.decided_by}${d.policy_sha256 ? ` policy=${d.policy_sha256.slice(0, 12)}` : ""}${d.snapshot_id ? ` snapshot=${short(d.snapshot_id)}` : ""}`);
  io.out(`  why: ${d.rationale}`); if (d.explore_rule) io.out(`  exploration rule: ${d.explore_rule}`);
  io.out(`  candidates (* = selected; score is the explained 0-100 rank score, not a probability):`);
  renderCandidates(io, rows, verbose);
  return { decision: d, candidates: rows };
}

// -------------------------------------------------------------------------------------------------------------- next action

export type NextAction = { command: string; who: "agentsmith" | "human" | "operator" | "attended"; reason: string };
/** What the loop should do next, from the recorded state alone. Read-only. */
export async function nextActions(db: Pick<Pool, "query">): Promise<NextAction[]> {
  const out: NextAction[] = [];
  const runs = (await db.query<{ id: string; created_by: string; status: string; keys: string[]; statuses: string[]; done: boolean; engine: boolean }>(
    `SELECT r.id, r.created_by, r.status, array_agg(s.step_key ORDER BY s.sequence) keys, array_agg(s.status ORDER BY s.sequence) statuses, bool_and(s.status = 'succeeded') done,
            bool_or(s.step_key = ANY($1::text[])) engine
       FROM workflow_runs r JOIN workflow_steps s ON s.workflow_run_id = r.id WHERE r.workflow_type = 'repository_research' GROUP BY r.id ORDER BY r.created_at`, [[...ENGINE_STEP_KEYS, ATTENDED_STEP_KEY, ATTENDED_CHALLENGE_STEP_KEY]])).rows;
  for (const r of runs) {
    const failed = r.status === "failed";
    if (failed) { out.push({ command: `show the failure: SELECT error FROM workflow_steps WHERE workflow_run_id = '${r.id}'`, who: "operator", reason: `run ${short(r.id)} failed; nothing downstream will use it` }); continue; }
    const firstPending = r.keys[r.statuses.findIndex((x) => x !== "succeeded")];
    if (!r.done && (firstPending === ATTENDED_STEP_KEY || firstPending === ATTENDED_CHALLENGE_STEP_KEY)) {
      const imp = firstPending === ATTENDED_STEP_KEY ? "import-specialist" : "import-challenge";
      out.push({ command: `brief --run ${r.id}  ->  export-snapshot --run ${r.id} --dir <empty dir>  ->  run the specialist in an attended Claude Code session  ->  ${imp} --run ${r.id} --file <result.json> --operator <you>`, who: "attended",
        reason: `assignment ${short(r.id)} waits for an attended specialist (interactive only; never run by a worker)` });
      continue;
    }
    if (!r.done) { out.push({ command: `run-assignment --run ${r.id}`, who: "operator", reason: `${r.engine ? "specialist assignment" : "acquisition"} ${short(r.id)} has steps waiting (${r.keys.join(" -> ")})` }); continue; }
    if (r.engine) {
      const ingested = Number((await db.query<{ n: string }>("SELECT (SELECT count(*) FROM research_coverage WHERE workflow_run_id = $1) + (SELECT count(*) FROM research_effort WHERE workflow_run_id = $1) n", [r.id])).rows[0]!.n) > 0;
      if (!ingested) { out.push({ command: `ingest --run ${r.id}`, who: "agentsmith", reason: `assignment ${short(r.id)} finished; its results are not in memory yet` }); continue; }
    }
    const followed = Number((await db.query<{ n: string }>("SELECT count(*) n FROM research_decisions WHERE context_run_id = $1", [r.id])).rows[0]!.n) > 0;
    if (!followed) out.push({ command: `map --run ${r.id}${r.engine ? " --follow-up" : ""}`, who: "agentsmith", reason: r.engine ? `assignment ${short(r.id)} is in memory; choose the next action from the updated state` : `snapshot of run ${short(r.id)} is sealed and not yet mapped` });
  }
  const reviews = (await db.query<{ ref: string }>(
    `SELECT DISTINCT c.candidate_ref ref FROM research_decision_candidates c WHERE c.action = 'request_human_review'
      AND NOT EXISTS (SELECT 1 FROM hypothesis_outcomes o WHERE o.hypothesis_id::text = c.candidate_ref) ORDER BY 1`)).rows;
  for (const h of reviews) out.push({ command: `leads --hypothesis ${h.ref}  then  adjudicate --hypothesis ${h.ref} --category <refuted|inconclusive|duplicate|confirmed> --review-verdict <...> --rationale "..." --operator <you>`, who: "human", reason: "supported by an independent evaluator; only a human can decide its outcome" });
  if (out.length) return out;
  const rec = (await db.query<{ ref: string; decision: string }>(
    `SELECT c.candidate_ref ref, d.id decision FROM research_decisions d JOIN research_decision_candidates c ON c.decision_id = d.id
      WHERE d.level = 'opportunity' AND d.decided_by_kind = 'policy' AND c.action = 'recommend' ORDER BY d.created_at DESC LIMIT 1`)).rows[0];
  if (rec) {
    const state = (await db.query<{ state: string }>("SELECT state FROM bounty_opportunities WHERE id = $1", [rec.ref])).rows[0]?.state;
    if (state === "discovered") return [{ command: `select --opportunity ${rec.ref} --repository <a verified repository> --operator <you> --basis ${rec.decision}`, who: "human", reason: "the policy recommended this opportunity; selection is a human decision (T-040)" }];
  }
  return [{ command: "rank", who: "agentsmith", reason: "no assignment is open: rank the registry (register or verify opportunities first if it is empty)" }];
}

// -------------------------------------------------------------------------------------------------------------- commands

const HELP = `AgentSmith research loop: operator CLI (T-199). Dry run unless --execute --confirm <database name>.
Target: --database-url postgres://...@localhost/agentsmith_scratch_x  (or RESEARCH_LOOP_DATABASE_URL). Loopback, disposable name, drafts present.
Read-only:   status | next | registry | show-decision --id <uuid> [--verbose] | ledger --snapshot <uuid> | leads --run <uuid> | leads --hypothesis <uuid>
Human:       register --file <json> --operator <id>
             verify --opportunity <uuid> --check <program_official|repository_official|scope_includes_repository|eligibility> --subject <s>
                    --verdict <verified|unverified|contradicted> --method <text> --evidence-url <https://...> [--evidence-sha256 <hex>] --operator <id>
             select --opportunity <uuid> --repository <owner/repo> --operator <id> [--basis <decision uuid>] [--note <text>]
             adjudicate --hypothesis <uuid> --category <refuted|inconclusive|duplicate|confirmed> --rationale <text> --operator <id>
                    [--review-verdict <supports|rejects|needs_more_evidence|inconclusive>] [--duplicate-of <uuid>]
AgentSmith:  rank | map --run <uuid> [--follow-up] | ingest --run <uuid>
Execution:   run-assignment --run <uuid> [--allow-network]   (dry run lists the steps; --execute runs them once, here, for that run only)
Attended:    brief --run <uuid> | export-snapshot --run <uuid> --dir <empty dir> | compare --snapshot <uuid>
             import-specialist --run <uuid> --file <result.json> --operator <id> [--tokens N] [--duration-ms N]
             import-challenge  --run <uuid> --file <result.json> --operator <id> [--tokens N] [--duration-ms N]
             (attended specialists are available only with AGENTSMITH_ATTENDED_OPERATOR set: interactive Claude Code sessions, never workers)
Common:      --json  --verbose  --execute  --confirm <database name>`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let a: Args;
  try { a = parseArgs(argv); } catch (e) { io.err(String((e as Error).message)); io.err(HELP); return EXIT.usage; }
  if (a.command === "help" || a.flags["help"]) { io.out(HELP); return EXIT.ok; }
  if (!WRITE_COMMANDS.has(a.command) && !EXEC_COMMANDS.has(a.command) && !READ_COMMANDS.has(a.command)) { io.err(`unknown command ${a.command}`); io.err(HELP); return EXIT.usage; }
  let pool: Pool | null = null;
  try {
    const t = resolveTarget(a, io.env);
    pool = new pg.Pool({ connectionString: t.url, max: 4, application_name: "agentsmith-loop-cli/1" }); pool.on("error", () => undefined);
    await checkDatabase(pool, t);
    const json = a.flags["json"] === true; const verbose = a.flags["verbose"] === true;
    const emit = (o: unknown) => { if (json) io.out(JSON.stringify(o, null, 2)); };
    const write = WRITE_COMMANDS.has(a.command);
    const execute = (write || EXEC_COMMANDS.has(a.command)) ? await confirmed(a, t, io, `${a.command} will write`) : false;
    if (!json) io.out(`[${t.name}@${t.host}] ${a.command}: ${write || EXEC_COMMANDS.has(a.command) ? (execute ? "EXECUTE (confirmed)" : "DRY RUN (nothing is kept; add --execute --confirm <database name>)") : "read-only"}`);
    const p = pool;
    const stage = <T>(fn: (db: Pool) => Promise<T>): Promise<T> => (execute ? fn(p) : preview(p, fn, (r) => {
      if (json) return;
      io.out(`dry run: database changes rolled back; sequences reset: ${r.sequencesRestored.length}${r.sequencesNotRestored.length ? `; NOT reset: ${r.sequencesNotRestored.join(", ")}` : ""}; side effects refused: ${r.refusedEffects.length ? r.refusedEffects.map((e) => `${e.effect} (${e.what})`).join(", ") : "none attempted"}`);
    }));
    const operator = () => { const o = str(a, "operator")!; if (!/^[A-Za-z0-9._@-]{2,100}$/.test(o)) throw new Usage("--operator must be a plain identifier"); return o; };

    switch (a.command) {
      case "status": {
        const reg = await readRegistry(p);
        const dec = (await p.query<{ level: string; n: string }>("SELECT level, count(*) n FROM research_decisions GROUP BY level ORDER BY level")).rows;
        const runs = (await p.query<{ status: string; n: string }>("SELECT status, count(*) n FROM workflow_runs WHERE workflow_type = 'repository_research' GROUP BY status ORDER BY status")).rows;
        const snaps = (await p.query<{ id: string; repository: string; commit_sha: string }>("SELECT DISTINCT ON (repository, commit_sha, manifest_sha256) id, repository, commit_sha FROM repo_snapshots WHERE sealed_at IS NOT NULL ORDER BY repository, commit_sha, manifest_sha256, created_at")).rows;
        const ledgers = []; for (const s of snaps) ledgers.push({ snapshot: s.id, repository: s.repository, commit: s.commit_sha, ledger: await outcomeLedger(p, s.id, io.env) });
        const next = await nextActions(p);
        if (json) emit({ policy: { version: RESEARCH_POLICY_V0.version, sha256: POLICY_SHA256 }, registry: reg.map((e) => ({ id: e.id, key: e.canonicalKey, state: e.state, lastAssessment: e.lastAssessment })), decisions: dec, runs, ledgers, next });
        else {
          io.out(`policy ${RESEARCH_POLICY_V0.version} (${POLICY_SHA256.slice(0, 12)})`);
          io.out(`registry: ${reg.length} opportunit${reg.length === 1 ? "y" : "ies"}`); for (const e of reg) io.out(`  ${short(e.id)} ${e.state.padEnd(10)} ${e.canonicalKey}  ${e.lastAssessment ? `[${e.lastAssessment.assessment}: ${e.lastAssessment.reason}]` : ""}`);
          io.out(`decisions: ${dec.map((d) => `${d.level}=${d.n}`).join(" ") || "none"}`); io.out(`runs: ${runs.map((r) => `${r.status}=${r.n}`).join(" ") || "none"}`);
          for (const l of ledgers) io.out(`ledger ${l.repository}@${l.commit.slice(0, 10)}: ${Object.entries(l.ledger).map(([k, v]) => `${k}=${v}`).join(" ")}`);
          io.out("next:"); for (const n of next) io.out(`  [${n.who}] ${n.command}\n      because ${n.reason}`);
        }
        return EXIT.ok;
      }
      case "next": {
        const next = await nextActions(p);
        if (json) emit(next); else for (const n of next) io.out(`[${n.who}] ${n.command}\n    because ${n.reason}`);
        return EXIT.ok;
      }
      case "registry": {
        const reg = await readRegistry(p);
        if (json) emit(reg); else for (const e of reg) {
          io.out(`${e.id} ${e.state} ${e.canonicalKey} "${e.title}" observations=${e.observations}`);
          io.out(`  claims: ${JSON.stringify(e.claims)}`);
          for (const c of e.checks) io.out(`  verified-event: ${c.check} ${c.subject} = ${c.verdict}`);
          if (e.lastAssessment) io.out(`  policy: ${e.lastAssessment.assessment} (${e.lastAssessment.reason})`);
        }
        return EXIT.ok;
      }
      case "show-decision": { const r = await renderDecision(json ? { ...io, out: () => undefined } : io, p, str(a, "id")!, verbose); emit(r); return EXIT.ok; }
      case "ledger": {
        const l = await outcomeLedger(p, str(a, "snapshot")!, io.env);
        if (json) emit(l); else io.out(Object.entries(l).map(([k, v]) => `${k}=${v}`).join("  ") + "\n(confirmed..missed are human outcomes only; unadjudicatedLeads are machine evidence, not outcomes)");
        return EXIT.ok;
      }
      case "leads": {
        let ids: string[];
        const h = str(a, "hypothesis", false);
        if (h) ids = [h];
        else {
          const run = str(a, "run")!;
          const o = await producerOutput(p, run);
          ids = (o?.status === "succeeded" ? (o.output?.["hypothesis_ids"] as string[] | undefined) : undefined) ?? [];
        }
        const acc = await accountFor(p, ids);
        const detail = (await p.query<{ id: string; claim: string; spans: Array<{ path: string; line_start: number; line_end: number }> | null }>(
          `SELECT h.id, h.claim, (SELECT jsonb_agg(jsonb_build_object('path', s.path, 'line_start', s.line_start, 'line_end', s.line_end) ORDER BY he.role, s.path) FROM hypothesis_evidence he JOIN evidence_spans s ON s.id = he.span_id WHERE he.hypothesis_id = h.id) spans
             FROM hypotheses h WHERE h.id = ANY($1::uuid[])`, [ids])).rows;
        const merged = acc.map((x) => ({ ...x, claimText: detail.find((d) => d.id === x.hypothesisId)?.claim ?? "", spans: detail.find((d) => d.id === x.hypothesisId)?.spans ?? [] }));
        if (json) emit(merged); else for (const l of merged) {
          io.out(`${l.hypothesisId} ${l.family}  machine=${l.machineStatus}  human=${l.human.outcome ?? "none"}`);
          io.out(`  claim (${l.claim.generatorKind}:${l.claim.generatorId}): ${l.claimText}`);
          for (const s of l.spans) io.out(`  evidence span: ${s.path}:${s.line_start}-${s.line_end}`);
          for (const e of l.evidence) io.out(`  independent evaluation: ${e.evaluatorId} -> ${e.outcome}`);
          if (l.human.reviews.length) io.out(`  human reviews: ${l.human.reviews.join(", ")}`);
        }
        return EXIT.ok;
      }
      case "register": {
        const raw = JSON.parse(readFileSync(str(a, "file")!, "utf8")) as Record<string, unknown>;
        const r = await stage((db) => registerManualOpportunity(db, { ...raw, recordedBy: operator() } as never));
        if (json) emit({ ...r, executed: execute }); else io.out(`${r.created ? "new opportunity" : "new sighting of existing opportunity"} ${r.id} (observation ${r.observationId})`);
        return EXIT.ok;
      }
      case "verify": {
        const sha = str(a, "evidence-sha256", false); const url = str(a, "evidence-url")!;
        if (!url.startsWith("https://")) throw new Usage("--evidence-url must be https");
        if (sha && !/^[a-f0-9]{64}$/.test(sha)) throw new Usage("--evidence-sha256 must be 64 hex characters");
        const v = { opportunityId: str(a, "opportunity")!, check: str(a, "check")! as CheckKind, subject: str(a, "subject")!, verdict: str(a, "verdict")! as "verified", method: str(a, "method")!,
          evidence: [{ kind: "official_source", ref: url, ...(sha ? { sha256: sha } : {}) }], humanId: operator() };
        await stage((db) => recordVerification(db, v));
        if (json) emit({ recorded: v, executed: execute }); else io.out(`human verification ${v.check} ${v.subject} = ${v.verdict} by ${v.humanId}`);
        return EXIT.ok;
      }
      case "rank": {
        const r = await stage(async (db) => {
          const res = await rankOpportunities(db, new Date());
          if (res.decisionId && !json) await renderDecision(io, db, res.decisionId, verbose);
          return res;
        });
        if (json) emit({ ...r, executed: execute }); else if (!r.decisionId) io.out("no open opportunity to rank");
        else io.out(r.recommended ? `recommended for HUMAN selection: ${r.recommended}  (next: select --opportunity ${r.recommended} --repository <verified repo> --operator <you>${execute ? ` --basis ${r.decisionId}` : ""})` : "nothing is eligible; see the reasons above");
        return EXIT.ok;
      }
      case "select": {
        const r = await stage((db) => selectOpportunity(db, { opportunityId: str(a, "opportunity")!, repository: str(a, "repository")!, humanId: operator(), basisDecisionId: str(a, "basis", false) ?? null, ...(str(a, "note", false) ? { note: str(a, "note")! } : {}) }));
        if (json) emit({ ...r, executed: execute }); else io.out(`human decision ${r.decisionId}: acquisition assignment ${r.acquisitionRunId}${r.reused ? " (already queued; reused)" : ""} for ${r.repository}\nnext: run-assignment --run ${r.acquisitionRunId}`);
        return EXIT.ok;
      }
      case "map": {
        const r = await stage(async (db) => {
          const res = await mapAndAssign(db, str(a, "run")!, a.flags["follow-up"] === true ? "follow_up" : "component", io.env);
          if (!json) await renderDecision(io, db, res.decisionId, verbose);
          return res;
        });
        if (json) emit({ ...r, executed: execute });
        else io.out(r.assignment ? `assignment ${r.assignment.runId}: ${r.assignment.capability} -> ${r.assignment.targets.length} target(s), led by ${r.assignment.target} (${r.assignment.mode})\nnext: run-assignment --run ${r.assignment.runId}` : r.exhausted ? "snapshot exhausted for the available specialists; next: rank" : "no assignment created");
        if (!json && r.reviewRequests.length) io.out(`sent for human review: ${r.reviewRequests.join(", ")}`);
        return EXIT.ok;
      }
      case "ingest": {
        const r = await stage((db) => ingestInvestigation(db, str(a, "run")!));
        if (json) emit({ ...r, executed: execute });
        else {
          io.out(`${r.capability}${r.toolFailure ? ` FAILED (${r.toolFailure}): recorded as abstained, not as examined` : ""}: ${r.alreadyIngested ? "already in memory" : `memory: ${r.coverageRows} coverage rows, ${r.effortRows} effort rows`} (decision ${r.decisionId})`);
          for (const l of r.leads) io.out(`  lead ${short(l.hypothesisId)} ${l.family}: machine=${l.machineStatus}; evidence=${l.evidence.map((e) => `${e.evaluatorId}:${e.outcome}`).join(",") || "none"}; human=${l.human.outcome ?? "none"}`);
          io.out(`next: map --run ${r.runId} --follow-up`);
        }
        return EXIT.ok;
      }
      case "adjudicate": {
        const hid = str(a, "hypothesis")!; const human = operator(); const category = str(a, "category")! as "refuted";
        if (!["refuted", "inconclusive", "duplicate", "confirmed"].includes(category)) throw new Usage("--category must be refuted, inconclusive, duplicate or confirmed");
        const verdict = str(a, "review-verdict", false) as ("supports" | "rejects" | "needs_more_evidence" | "inconclusive" | undefined);
        const rationale = str(a, "rationale")!;
        const r = await stage(async (db) => {
          let reviewId: string | null = null;
          if (verdict) reviewId = await new ResearchStore(db).recordReview({ kind: "operator", operatorId: human }, { hypothesisId: hid, reviewerKind: "human", reviewerId: human, mode: "disclosed_adjudication",
            reviewerSaw: { claim: true, evidence_spans: true, generator_rationale: true, generator_identity: true, prior_evaluations: true, prior_reviews: true }, inputSha256: "0".repeat(64), verdict, rationale });
          const independent = (await db.query<{ id: string }>("SELECT e.id FROM hypothesis_evaluations e JOIN hypotheses h ON h.id = e.hypothesis_id WHERE e.hypothesis_id = $1 AND e.evaluator_id <> h.generator_id", [hid])).rows.map((x) => x.id);
          const outcomeId = await recordHumanOutcome(db, { hypothesisId: hid, category, decidedBy: human, rationale, basisEvaluationIds: independent, basisReviewId: reviewId, duplicateOfHypothesis: str(a, "duplicate-of", false) ?? null });
          return { reviewId, outcomeId };
        });
        if (json) emit({ ...r, executed: execute }); else io.out(`human outcome ${category} recorded for ${hid} by ${human} (the database enforces the confirmation rules)`);
        return EXIT.ok;
      }
      case "brief": {
        const b = await brief(p, str(a, "run")!);
        if (json) emit(b); else io.out(JSON.stringify(b, null, 2));
        return EXIT.ok;
      }
      case "compare": {
        const c = await compareSpecialists(p, str(a, "snapshot")!);
        if (json) emit(c);
        else {
          for (const [k, v] of Object.entries(c.capabilities)) io.out(`${k.padEnd(34)} examined ${v.components} component(s), ${v.classes.length} class(es); ${v.leads} lead(s); unique finds ${c.uniqueFinds[k] ?? 0}`);
          for (const x of c.clusters) io.out(`  ${x.contract}.${x.function || "*"} [${x.class}] found by ${x.foundBy.map((f) => f.capability).join(", ")}${x.examinedNotFoundBy.length ? `; examined, not found by ${x.examinedNotFoundBy.join(", ")}` : ""}; technical supports ${x.evidence.technicalSupports}; model reviews ${JSON.stringify(x.evidence.modelReviews)}; human ${x.evidence.humanOutcome ?? "none"}`);
          io.out("(examined-not-found is a candidate miss for that capability; it becomes the outcome 'missed' only through a human)");
        }
        return EXIT.ok;
      }
      case "export-snapshot": {
        const run = str(a, "run")!; const dir = str(a, "dir")!;
        if (!execute) { const n = (await p.query<{ n: string }>("SELECT count(*) n FROM repo_snapshot_files f JOIN workflow_steps s ON (s.output->>'snapshot_id')::uuid = f.snapshot_id WHERE s.workflow_run_id = $1 AND s.step_key = $2 AND s.status = 'succeeded'", [run, ACQUIRE_STEP_KEY])).rows[0]!.n; if (json) emit({ run, dir, files: Number(n), executed: false }); else io.out(`would write ${n} hash-checked files of the sealed snapshot to ${dir} (must be empty); nothing written`); return EXIT.ok; }
        const r = await exportSnapshot(p, run, dir);
        if (json) emit({ ...r, executed: true }); else io.out(`wrote ${r.files} files (manifest ${r.manifestSha256.slice(0, 12)}) to ${dir}; give the specialist that directory only`);
        return EXIT.ok;
      }
      case "import-specialist": case "import-challenge": {
        const run = str(a, "run")!; const raw = JSON.parse(readFileSync(str(a, "file")!, "utf8")) as unknown;
        const tokens = str(a, "tokens", false); const dur = str(a, "duration-ms", false);
        const meta = { operator: operator(), tokens: tokens ? Number(tokens) : null, durationMs: dur ? Number(dur) : null };
        if (a.command === "import-specialist") {
          const r = await stage((db) => importSpecialist(db, run, raw, meta));
          if (json) emit({ ...r, executed: execute }); else io.out(`${r.capability}: ${r.stored} claim(s) stored as plane 1 (attended model); rejected ${JSON.stringify(r.rejected)}; examined ${r.classesExamined.join(", ")}\nnext: run-assignment --run ${run} (independent validators), then ingest`);
        } else {
          const r = await stage((db) => importChallenge(db, run, raw, meta));
          if (json) emit({ ...r, executed: execute }); else io.out(`${r.reviews} blinded review(s) recorded (opinions, not evidence); unknown claim ids ${r.unknownClaims}\nnext: ingest --run ${run}`);
        }
        return EXIT.ok;
      }
      case "run-assignment": {
        const run = str(a, "run")!;
        const steps = (await p.query<{ step_key: string; status: string; sequence: number }>("SELECT step_key, status, sequence FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [run])).rows;
        if (!steps.length) throw new Usage(`no run ${run}`);
        const allowed = new Set([ACQUIRE_STEP_KEY, ...ENGINE_STEP_KEYS, ATTENDED_STEP_KEY, ATTENDED_CHALLENGE_STEP_KEY]);
        const foreign = steps.filter((s) => !allowed.has(s.step_key));
        if (foreign.length) throw new Refusal(`run ${run} has steps this tool does not execute (${foreign.map((s) => s.step_key).join(", ")}); only acquisition and research-loop assignments`);
        const pending = steps.filter((s) => s.status !== "succeeded");
        if (!execute) { if (json) emit({ run, wouldExecute: pending, executed: false }); else { io.out(`would execute, in order, once, for run ${run} only:`); for (const s of pending) io.out(`  ${s.sequence}. ${s.step_key} (${s.status})`); if (pending.some((s) => s.step_key === ACQUIRE_STEP_KEY)) io.out("  acquisition reads the repository from GitHub: needs --allow-network (public, read-only)"); io.out("dry run: no step was claimed, no tool started, no network used"); } return EXIT.ok; }
        // acquisition is the only step that uses the network: it always needs --allow-network, and the source is built only after that check
        let source: RepositorySource | undefined;
        if (pending.some((s) => s.step_key === ACQUIRE_STEP_KEY)) {
          if (a.flags["allow-network"] !== true) throw new Refusal("acquisition needs --allow-network (it reads one public repository from GitHub); nothing was executed");
          source = (io.sourceFactory ?? (() => new GitHubSource({})))();
        }
        const workerId = `loop-cli-${process.pid}`; const worker = new WorkflowWorker(p, workerId, 600, 1);
        const done: Array<{ step: string; status: string }> = [];
        for (;;) {
          const s = await worker.claimNext([ACQUIRE_STEP_KEY, ...ENGINE_STEP_KEYS], run); if (!s) break;
          try {
            if (s.step_key === ACQUIRE_STEP_KEY) await processAcquireRepositoryStep({ pool: p, worker, workerId, source: source! }, s);
            else if (!(await dispatchEngineStep({ pool: p, worker, workerId, env: io.env }, s))) throw new Error(`no handler for ${s.step_key}`);
            done.push({ step: s.step_key, status: "succeeded" });
          } catch (e) {
            await worker.fail(s.id, e instanceof Error ? e.message.slice(0, 500) : "step failed", false).catch(() => undefined);
            done.push({ step: s.step_key, status: "failed" }); break;
          }
        }
        const after = (await p.query<{ step_key: string; status: string }>("SELECT step_key, status FROM workflow_steps WHERE workflow_run_id = $1 ORDER BY sequence", [run])).rows;
        if (json) emit({ run, executed: done, steps: after });
        const waiting = after.find((s) => s.status !== "succeeded" && (s.step_key === ATTENDED_STEP_KEY || s.step_key === ATTENDED_CHALLENGE_STEP_KEY));
        if (waiting && !done.some((d) => d.status === "failed")) { if (json) return EXIT.ok; for (const d of done) io.out(`  ${d.step}: ${d.status}`); io.out(`waiting for an attended specialist (${waiting.step_key}): brief --run ${run}`); return EXIT.ok; }
        if (!json) { for (const d of done) io.out(`  ${d.step}: ${d.status}`); const inv = after.some((s) => s.step_key === CHALLENGE_TARGET_STEP_KEY); io.out(after.every((s) => s.status === "succeeded") ? `next: ${inv ? `ingest --run ${run}` : `map --run ${run}`}` : "the run did not finish; see the step error"); }
        return after.every((s) => s.status === "succeeded") ? EXIT.ok : EXIT.failed;
      }
    }
    return EXIT.usage;
  } catch (e) {
    if (e instanceof Refusal) { io.err(`REFUSED: ${e.message}`); return EXIT.refused; }
    if (e instanceof Usage) { io.err(e.message); return EXIT.usage; }
    io.err(`failed: ${e instanceof Error ? e.message : String(e)}`); return EXIT.failed;
  } finally { await pool?.end().catch(() => undefined); }
}

/** Exported for the test: the version scope helper is shared with the loop. */
export { sameVersionSnapshots };
