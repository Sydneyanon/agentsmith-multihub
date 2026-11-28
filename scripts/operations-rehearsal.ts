/**
 * LOCAL rehearsal of the live operations dashboard on REAL records of a disposable database (never production):
 *   a targeted, commit-pinned, bounty-scoped promotion of a USX-like fixture (the targeted-scoped-run fixture pattern) ->
 *   the REAL API process (server.ts, worker routes on, its own GitHub source pointed at a loopback GitHub fake for D2) ->
 *   a REMOTE worker process with no database credential, paused once before challenge_leads -> the hub in Chromium.
 * Screenshots (deviceScaleFactor 2) of the Operations view mid-run, after completion, with the timeline expanded, and the system
 * view; plus the exact progress / timeline / components JSON each screenshot was taken from.
 *
 *   npm run build && TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres npx tsx scripts/operations-rehearsal.ts [outDir]
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { buildGitFixture } from "../apps/api/src/acquisition/testing/git-fixture.js";
import { startLoopbackGitHub } from "../apps/api/src/acquisition/testing/loopback-github.js";
import { promoteEligibleProgrammes } from "../apps/api/src/bounties/promote.js";
import { migratedTestDatabase, REPO_ROOT } from "../apps/api/src/integration/harness.js";
import { launchBrowser } from "./hub-demo.js";

const outDir = resolve(process.argv[2] ?? "docs/research-runs/screenshots");
mkdirSync(outDir, { recursive: true });
const OPERATOR = randomBytes(36).toString("base64url");
const GH_TOKEN = "github_pat_" + "11REHEARSAL" + "q".repeat(71); // the API's GitHub credential, shape only: the GitHub here is a loopback fake
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const until = async (what: string, f: () => Promise<boolean>, ms = 120_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); } };
type Proc = { code: Promise<number | null>; out: () => string; kill: () => void };
function start(script: string, env: Record<string, string>): Proc {
  const child = spawn(`${REPO_ROOT}node_modules/.bin/tsx`, [`${REPO_ROOT}${script}`], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { out += c; });
  return { code: new Promise((r) => child.on("close", (c) => r(c))), out: () => out, kill: () => { child.kill("SIGTERM"); } };
}

const corpus = join(REPO_ROOT, "eval", "dev", "contracts");
const sol = readdirSync(corpus).sort();
const FILES = [...sol.map((f) => ({ path: `src/${f}`, content: readFileSync(join(corpus, f), "utf8") })), ...sol.slice(0, 3).map((f) => ({ path: `test/${f}`, content: readFileSync(join(corpus, f), "utf8") })), { path: "README.md", content: "# usx-like rehearsal fixture (controlled dev corpus)\n" }];

const db = await migratedTestDatabase();
const gh = await startLoopbackGitHub();
const dir = mkdtempSync(join(tmpdir(), "ops-rehearsal-"));
const procs: Proc[] = [];
const browser = await launchBrowser();
const records: Record<string, unknown> = {};
try {
  const owner = db.ownerPool;
  // 1. the targeted, scoped promotion (targeted-scoped-run.integration.test.ts pattern)
  const fx = buildGitFixture(FILES, { owner: "acme", repo: "usx-like" }); gh.add(fx);
  const field = (value: unknown) => ({ value, source: "sherlock", authority: 10, observedAt: "2026-11-28T00:00:00Z", conflicts: [] });
  const resolved = { projectName: field("usx-like"), officialUrl: field("https://audits.sherlock.xyz/bug-bounties/9273"), maxReward: field(100_000), chains: field(["Ethereum"]), technologies: field(["Solidity"]) };
  const prog = (await owner.query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ('sherlock:9273', 'usx-like', 'usx-like', $1::jsonb, 'active', 'official_confirmed') RETURNING id`, [JSON.stringify(resolved)])).rows[0].id;
  await owner.query(`INSERT INTO bounty_repository_mappings (bounty_program_id, repository, source_url, evidence, discovery_method, verification_status, confidence, default_branch, repository_github_id, last_seen_at)
    VALUES ($1, 'acme/usx-like', 'https://audits.sherlock.xyz/bug-bounties/9273', 'https://github.com/acme/usx-like', 'official_page', 'official_documentation', 'high', 'main', 9273, now())`, [prog]);
  const evidence = "docs/research-runs/usx-scope-evidence.md";
  const scope = { programme: "sherlock:9273", in_scope_paths: sol.map((f) => `src/${f}`), evidence, evidence_sha256: createHash("sha256").update(readFileSync(join(REPO_ROOT, evidence))).digest("hex") };
  const promoted = await promoteEligibleProgrammes(owner, { createdBy: "operator@rehearsal", structuralAnalysis: true, maxNewRuns: 1, target: { programme: "sherlock:9273", repository: "acme/usx-like", commit: fx.commitSha, bountyScope: scope } });
  const runId = promoted.actions[0]!.workflowRunId!;
  console.log(`run ${runId} at commit ${fx.commitSha}`);

  // 2. the real API process with the worker routes; its own GitHub source is the loopback fake (D2)
  const ports = { pub: await freePort(), priv: await freePort() };
  const api = start("apps/api/src/server.ts", { NODE_ENV: "test", DATABASE_URL: db.url, API_BEARER_TOKEN: OPERATOR, HOST: "127.0.0.1", PORT: String(ports.pub), LOG_LEVEL: "warn", HUB_DATA_KIND: "test",
    WORKER_API_ENABLED: "true", WORKER_API_HOST: "127.0.0.1", WORKER_API_PORT: String(ports.priv), WORKER_API_GITHUB_TEST_ORIGIN: gh.origin, GITHUB_TOKEN: GH_TOKEN, HUB_ASSETS_DIR: join(REPO_ROOT, "dist", "web") });
  procs.push(api);
  await until("API health", async () => { try { return (await fetch(`http://127.0.0.1:${ports.pub}/health/live`)).ok; } catch { return false; } }, 60_000);
  const base = `http://127.0.0.1:${ports.pub}`;
  const getJson = async (path: string) => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${OPERATOR}` } })).json();
  const minted = await (await fetch(`${base}/v1/research/runs/${runId}/worker-tokens`, { method: "POST", headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" }, body: JSON.stringify({ ttl_seconds: 3600, created_by: "operator@rehearsal" }) })).json() as { token: string; token_id: string };

  // 3. the remote worker: no database credential; token in a file it unlinks; pauses once before challenge_leads
  const tokenFile = join(dir, `token-${randomUUID()}`); writeFileSync(tokenFile, `${minted.token}\n`, { mode: 0o600 });
  const spec = join(dir, "fixture.json"); writeFileSync(spec, JSON.stringify({ owner: "acme", repo: "usx-like", files: FILES }));
  const pause = join(dir, "pause");
  const worker = start("apps/api/src/integration/remote-worker-child.ts", { NODE_ENV: "test", WORKER_STORE: "api", WORKER_API_URL: `http://127.0.0.1:${ports.priv}`, WORKER_API_TOKEN_FILE: tokenFile, STRUCTURAL_ANALYSIS_ENABLED: "true",
    REMOTE_CHILD_FIXTURE: spec, REMOTE_CHILD_DEADLINE_MS: "300000", REMOTE_CHILD_PAUSE_BEFORE: "challenge_leads", REMOTE_CHILD_PAUSE_FILE: pause });
  procs.push(worker);

  const context = await browser.newContext({ viewport: { width: 1120, height: 760 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  await context.addInitScript((t) => sessionStorage.setItem("agentsmith.hub.token", t), OPERATOR);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
  const open = async (p: Page, hash: string) => {
    await p.goto(`${base}/hub/${hash}`);
    await p.reload(); // a same-URL navigation keeps the old page: reload so every panel is fetched now
    await p.waitForSelector(".ops-grid", { timeout: 20_000 });
    await p.waitForSelector(".system-rows", { timeout: 20_000 });
    await p.waitForFunction(() => !document.querySelector(".state-loading"), undefined, { timeout: 20_000 });
    // the decorative matrix-rain canvas only adds PNG noise; hidden through CSSOM (CSP-safe), nothing else on the page changes
    await p.evaluate(() => { document.querySelectorAll<HTMLElement>(".matrix-rain").forEach((c) => c.style.setProperty("display", "none")); window.scrollTo(0, 0); });
  };
  const shot = async (p: Page, name: string, el?: string) => {
    const path = join(outDir, `${name}.png`);
    if (el) await (await p.$(el))!.screenshot({ path }); else await p.screenshot({ path });
    console.log(`${name}.png ${Math.round(statSync(path).size / 1024)} KiB`);
  };
  const capture = async (label: string) => {
    records[label] = { progress: await getJson(`/v1/research/runs/${runId}/progress`), timeline: await getJson(`/v1/research/timeline?run=${runId}&limit=200`), components: await getJson("/v1/engine/components") };
  };

  // (a) mid-run: the worker holds the challenge step's lease and is paused before running it
  await until("worker paused before challenge_leads", async () => existsSync(pause), 180_000);
  await capture("a_midrun");
  await open(page, `#/operations?run=${runId}`);
  await shot(page, "operations-a-midrun");
  await page.evaluate(() => document.querySelector(".ops-validation")?.scrollIntoView({ block: "start" }));
  await shot(page, "operations-a-midrun-validation");

  // resume; the run completes through the API (D1/D3) and the dossier step
  unlinkSync(pause);
  await until("run succeeded", async () => (await owner.query("SELECT status FROM workflow_runs WHERE id = $1", [runId])).rows[0].status === "succeeded", 180_000);
  const code = await Promise.race([worker.code, sleep(30_000).then(() => -1)]);
  console.log(`worker exited ${code}`);
  await capture("b_complete");

  // (b) after completion: the top of the view, then the lower panels
  await open(page, `#/operations?run=${runId}`);
  await shot(page, "operations-b-complete-top");
  await page.evaluate(() => document.querySelector(".ops-protocol_analysis")?.scrollIntoView({ block: "start" }));
  await shot(page, "operations-b-complete-analysis");
  await page.evaluate(() => document.querySelector(".ops-evidence")?.scrollIntoView({ block: "start" }));
  await shot(page, "operations-b-complete-confidence-outcome");
  await page.evaluate(() => document.querySelector(".ops-outcome")?.scrollIntoView({ block: "center" }));
  await shot(page, "operations-b-complete-outcome", ".ops-outcome");

  // (c) the timeline with a progress row, a worker-API row and an evaluation row expanded
  // a string, not a function: tsx would wrap a named inner helper in __name, which the page does not define
  await page.evaluate(`(() => {
    const ds = [document.querySelector(".tl-progress"), document.querySelector(".tl-worker_api"), [...document.querySelectorAll(".tl-hypothesis")].find((x) => x.textContent.includes("evaluation_recorded"))];
    for (const d of ds) if (d) d.open = true;
    document.querySelector(".ops-timeline").scrollIntoView({ block: "start" });
  })()`);
  await shot(page, "operations-c-timeline-expanded");

  // (d) the system view
  await page.evaluate(() => document.querySelector(".ops-system")?.scrollIntoView({ block: "start" }));
  await shot(page, "operations-d-system", ".ops-system");

  // a phone, to show the layout holds at 390 px
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  await phone.addInitScript((t) => sessionStorage.setItem("agentsmith.hub.token", t), OPERATOR);
  const pp = await phone.newPage();
  await open(pp, `#/operations?run=${runId}`);
  await pp.evaluate(() => document.querySelector(".ops-acquisition")?.scrollIntoView({ block: "start" }));
  await shot(pp, "operations-e-phone");
  await phone.close(); await context.close();

  // the exact records behind the screenshots (the token itself never appears: only its id)
  const json = JSON.stringify({ run_id: runId, commit: fx.commitSha, token_id: minted.token_id, captured: records }, null, 1);
  if (json.includes(minted.token) || json.includes(OPERATOR) || json.includes(GH_TOKEN)) throw new Error("a secret appeared in a captured response");
  writeFileSync(join(outDir, "operations-rehearsal-records.json"), json);
  console.log(`records in ${join(outDir, "operations-rehearsal-records.json")} (${Math.round(json.length / 1024)} KiB)`);
  console.log(`api log tail: ${api.out().slice(-600)}`);
} finally {
  for (const p of procs) p.kill();
  await browser.close(); await gh.close(); rmSync(dir, { recursive: true, force: true }); await db.drop();
}
