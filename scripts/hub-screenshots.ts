/**
 * Local visual walkthrough of the hub. Creates a disposable database on the LOOPBACK Postgres named by TEST_DATABASE_URL,
 * writes SYNTHETIC records through the real ResearchStore (labelled synthetic: nothing here is a real repository or finding),
 * serves the built hub on an ephemeral local port, screenshots it with Chromium, and drops the database.
 *
 *   npm run build && TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres npm run hub:screenshots -- <outDir>
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { chromium } from "playwright-core";
import { registerBearerAuth } from "../apps/api/src/auth.js";
import { registerHubStatic } from "../apps/api/src/hub-static.js";
import { registerResearchRoutes } from "../apps/api/src/research-api.js";
import { sha256Hex } from "../apps/api/src/research-state.js";
import { assertIntegrationConfigured, migratedTestDatabase, seedRun } from "../apps/api/src/integration/harness.js";
import { ResearchFixture, VAULT } from "../apps/api/src/integration/research-helpers.js";

const outDir = resolve(process.argv[2] ?? "docs/hub-screenshots");
const TOKEN = "demo-token-".padEnd(40, "x");
const LEGACY = ["resolve_source", "identify_project", "locate_official_repositories", "establish_authorization", "map_attack_surface", "generate_hypotheses", "independent_challenge", "prepare_research_brief"];

const filler = (name: string, lines: number) => Array.from({ length: lines }, (_, i) => `// SYNTHETIC ${name} line ${i + 1}`).join("\n") + "\n";

async function main(): Promise<void> {
  assertIntegrationConfigured();
  const db = await migratedTestDatabase();
  const fx = new ResearchFixture(db);
  const app = Fastify({ logger: false });
  try {
    registerBearerAuth(app, TOKEN);
    registerResearchRoutes(app, db.pool);
    registerHubStatic(app, { assetsDir: resolve("dist/web") });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    // legacy passive-pipeline projects (SYNTHETIC inputs)
    async function legacy(value: string, finished: boolean) {
      const { runId, stepIds } = await seedRun(db.pool, LEGACY);
      await db.pool.query("UPDATE workflow_runs SET input = $2::jsonb, status = $3 WHERE id = $1", [runId, JSON.stringify({ kind: "idea", value, source: "user" }), finished ? "succeeded" : "running"]);
      const done = finished ? LEGACY.length : 5;
      for (let i = 0; i < done; i += 1) await db.pool.query("UPDATE workflow_steps SET status='succeeded', attempt=1, output='{\"status\":\"ok\"}'::jsonb, completed_at=now() WHERE id=$1", [stepIds[i]]);
      if (!finished) await db.pool.query("UPDATE workflow_steps SET status='running', attempt=1, lease_owner='worker-a', lease_expires_at=now()+interval '2 minutes' WHERE id=$1", [stepIds[5]]);
      await db.pool.query("INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason) VALUES ('user','intake.created','workflow_run',$1::text,(SELECT correlation_id FROM workflow_runs WHERE id=$1::uuid),'User submitted a research lead')", [runId]);
      await db.pool.query("INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id) VALUES ('worker-a','workflow_step.claimed','workflow_step',$1::text,(SELECT correlation_id FROM workflow_runs WHERE id=$2::uuid))", [stepIds[0], runId]);
      return runId;
    }
    await legacy("SYNTHETIC lead: staking vault idea", false);
    await legacy("SYNTHETIC lead: bridge audit notes", true);

    // research state written through the real store (SYNTHETIC repository)
    const ctx = await fx.step();
    await db.pool.query("UPDATE workflow_runs SET input = $2::jsonb, status = 'running' WHERE id = $1", [ctx.runId, JSON.stringify({ kind: "idea", value: "SYNTHETIC demo: fixture vault research run", source: "user" })]);
    const snapshotId = await fx.store.createSnapshot(ctx.lease, { repository: "synthetic/demo-vault", commitSha: fx.commit(), refName: "main", acquisitionReport: { note: "synthetic" } });
    const files: Array<[string, string, string]> = [
      ["contracts/Vault.sol", "source", VAULT], ["contracts/Staking.sol", "source", filler("Staking", 140)], ["contracts/Bridge.sol", "source", filler("Bridge", 90)],
      ["contracts/lib/Math.sol", "source", filler("Math", 30)], ["test/Vault.t.sol", "test", filler("VaultTest", 70)], ["test/Staking.t.sol", "test", filler("StakingTest", 40)],
      ["foundry.toml", "config", filler("config", 6)], ["docs/README.md", "docs", filler("readme", 25)], ["lib/forge-std/Test.sol", "vendored", filler("forge", 160)],
    ];
    const entries = [];
    for (const [path, classification, text] of files) {
      const blob = await fx.store.putBlob(ctx.lease, Buffer.from(text, "utf8"));
      entries.push({ path, classification, sizeBytes: blob.sizeBytes, blobSha256: blob.sha256 });
    }
    entries.push({ path: "assets/video.bin", classification: "other", sizeBytes: 9_000_000, skipReason: "oversize" } as never);
    await fx.store.addSnapshotFiles(ctx.lease, snapshotId, entries as never);
    await fx.store.sealSnapshot(ctx.lease, snapshotId);
    const c = { ...ctx, snapshotId };
    fx.adopt(c);
    const call = await fx.span(c, 5); const update = await fx.span(c, 6); const fn = await fx.span(c, 4, 7);
    const stake = await fx.span(c, 20, 24, "contracts/Staking.sol"); const bridge = await fx.span(c, 10, 12, "contracts/Bridge.sol");
    const h1 = await fx.hypothesis(c, [fn, call], { claim: "withdraw() sends ETH before it reduces the caller's balance, so a receiving contract can call withdraw() again." });
    const h2 = await fx.hypothesis(c, [update], { claim: "The balance update uses unchecked arithmetic that could wrap." });
    const h3 = await fx.hypothesis(c, [stake], { claim: "Reward accrual reads a stale total supply after a transfer." });
    const h4 = await fx.hypothesis(c, [bridge], { claim: "The bridge accepts the same message id twice." });
    await fx.evaluate(c, h2, "weakens", [fn]);
    await fx.evaluate(c, h1, "inconclusive", []);
    await fx.review(h1, "operator-1", "supports", "blinded_independent_assessment");
    await fx.review(h1, "operator-1", "supports", "disclosed_adjudication");
    await fx.review(h3, "operator-1", "needs_more_evidence", "blinded_independent_assessment");
    await fx.store.withdraw("operator-1", h4, "Superseded by a narrower claim.");

    mkdirSync(outDir, { recursive: true });
    const executablePath = process.env.HUB_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
    const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
    const open = async (width: number, height: number, mobile: boolean) => {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
      await context.addInitScript((t) => sessionStorage.setItem("agentsmith.hub.token", t), TOKEN);
      return context;
    };
    const idOf = async (path: string) => (await (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { items: Array<{ id: string }> }).items[0]!.id;
    const [projectId, hypId, spanId] = [await idOf("/v1/research/projects"), h1, fn];
    const problems: string[] = [];
    const shots: Array<[string, string]> = [
      ["home", "#/home"], ["projects", "#/projects"], ["project", `#/projects/${projectId}`], ["repository", `#/repository/${snapshotId}?path=${encodeURIComponent("contracts/Vault.sol")}`],
      ["hypotheses", "#/hypotheses"], ["hypothesis", `#/hypotheses/${hypId}`], ["evidence", `#/evidence/${spanId}`], ["activity", "#/activity"], ["later", "#/reviews"],
    ];
    for (const [label, width, height, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]] as const) {
      const context = await open(width, height, mobile);
      const page = await context.newPage();
      for (const [name, hash] of shots) {
        await page.goto(`${base}/hub/${hash}`);
        await page.reload();
        await page.waitForSelector(".content .view, .content .home-grid", { timeout: 10_000 });
        await page.waitForFunction(() => !document.querySelector(".state-loading"), undefined, { timeout: 10_000 });
        // Layout check: nothing may widen the page or poke out of the viewport (code blocks and tables scroll inside their own box).
        const overflow = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const bad: string[] = [];
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(".content *, .topbar *, .tabbar *"))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            let scroller = false;
            for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") { scroller = true; break; } }
            if (!scroller && (r.right > vw + 1 || r.left < -1)) bad.push(`${el.tagName.toLowerCase()}.${el.className} right=${Math.round(r.right)}`);
          }
          return { pageWider: document.documentElement.scrollWidth > vw, bad: bad.slice(0, 5) };
        });
        if (overflow.pageWider || overflow.bad.length) { problems.push(`${label}-${name}: ${JSON.stringify(overflow)}`); }
        if (mobile) await page.evaluate(() => { const t = document.querySelector<HTMLElement>(".tabbar"); if (t) { t.style.position = "absolute"; t.style.top = `${document.documentElement.scrollHeight - t.offsetHeight}px`; } });
        await page.screenshot({ path: join(outDir, `${label}-${name}.png`), fullPage: true });
      }
      await context.close();
    }
    const locked = await browser.newContext({ viewport: { width: 390, height: 700 }, deviceScaleFactor: 2 });
    const lockedPage = await locked.newPage();
    await lockedPage.goto(`${base}/hub/`);
    await lockedPage.waitForSelector(".unlock-card");
    await lockedPage.screenshot({ path: join(outDir, "phone-locked.png") });
    await browser.close();
    console.log(`wrote screenshots to ${outDir}`);
    console.log(problems.length ? `LAYOUT PROBLEMS:\n${problems.join("\n")}` : "layout check: no horizontal overflow on any screenshotted page");
    if (problems.length) process.exitCode = 1;
  } finally {
    await app.close();
    await db.drop();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
