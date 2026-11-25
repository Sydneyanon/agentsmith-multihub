/**
 * Shared by the local visual tools (hub-screenshots, hub-layout-check). Creates a disposable database on the LOOPBACK
 * Postgres named by TEST_DATABASE_URL, writes SYNTHETIC records through the real ResearchStore (nothing here is a real
 * repository or finding), serves the built hub from dist/web on an ephemeral local port, and removes everything on close.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { chromium, type Browser } from "playwright-core";
import { registerBearerAuth } from "../apps/api/src/auth.js";
import { registerHubStatic } from "../apps/api/src/hub-static.js";
import { registerResearchRoutes } from "../apps/api/src/research-api.js";
import { assertIntegrationConfigured, migratedTestDatabase, seedRun } from "../apps/api/src/integration/harness.js";
import { ResearchFixture, VAULT } from "../apps/api/src/integration/research-helpers.js";

const LEGACY = ["resolve_source", "identify_project", "locate_official_repositories", "establish_authorization", "map_attack_surface", "generate_hypotheses", "independent_challenge", "prepare_research_brief"];
const filler = (name: string, lines: number) => Array.from({ length: lines }, (_, i) => `// SYNTHETIC ${name} line ${i + 1}`).join("\n") + "\n";

export interface Demo {
  base: string; token: string;
  ids: { project: string; snapshot: string; hypothesis: string; span: string };
  routes: Array<[string, string]>;
  close(): Promise<void>;
}

export async function startDemo(): Promise<Demo> {
  assertIntegrationConfigured();
  const token = randomBytes(36).toString("base64url");
  const db = await migratedTestDatabase();
  const fx = new ResearchFixture(db);
  const app = Fastify({ logger: false });
  try {
    registerBearerAuth(app, token);
    registerResearchRoutes(app, db.pool);
    registerHubStatic(app, { assetsDir: resolve("dist/web") });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    async function legacy(value: string, finished: boolean) {
      const { runId, stepIds } = await seedRun(db.pool, LEGACY);
      await db.pool.query("UPDATE workflow_runs SET input = $2::jsonb, status = $3 WHERE id = $1", [runId, JSON.stringify({ kind: "idea", value, source: "user" }), finished ? "succeeded" : "running"]);
      const done = finished ? LEGACY.length : 5;
      for (let i = 0; i < done; i += 1) await db.pool.query("UPDATE workflow_steps SET status='succeeded', attempt=1, output='{\"status\":\"ok\"}'::jsonb, completed_at=now() WHERE id=$1", [stepIds[i]]);
      if (!finished) await db.pool.query("UPDATE workflow_steps SET status='running', attempt=1, lease_owner='worker-a', lease_expires_at=now()+interval '2 minutes' WHERE id=$1", [stepIds[5]]);
      await db.pool.query("INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id, reason) VALUES ('user','intake.created','workflow_run',$1::text,(SELECT correlation_id FROM workflow_runs WHERE id=$1::uuid),'User submitted a research lead')", [runId]);
      await db.pool.query("INSERT INTO audit_events (actor, action, entity_type, entity_id, correlation_id) VALUES ('worker-a','workflow_step.claimed','workflow_step',$1::text,(SELECT correlation_id FROM workflow_runs WHERE id=$2::uuid))", [stepIds[0], runId]);
    }
    await legacy("SYNTHETIC lead: staking vault idea", false);
    await legacy("SYNTHETIC lead: bridge audit notes", true);

    const ctx = await fx.step();
    await db.pool.query("UPDATE workflow_runs SET input = $2::jsonb, status = 'running' WHERE id = $1", [ctx.runId, JSON.stringify({ kind: "idea", value: "SYNTHETIC demo: fixture vault research run", source: "user" })]);
    const snapshotId = await fx.store.createSnapshot(ctx.lease, { repository: "synthetic/demo-vault", commitSha: fx.commit(), refName: "main", acquisitionReport: {
      // SYNTHETIC: shaped like a real acquisition report (docs/repository-acquisition.md) so the dashboard's Acquisition panel is exercised; nothing here was acquired.
      report_version: 1, tool: { name: "agentsmith-repository-acquisition", version: "5.2.0" }, acquired_at: "2026-01-02T03:04:05.000Z",
      source: { host: "github.com", full_name: "synthetic/demo-vault", requested_ref: "main", commit_sha: "0".repeat(40), tree_sha: "1".repeat(40) },
      archive: { sha256: "c".repeat(64), compressed_bytes: 18_432, uncompressed_bytes: 61_440, entries: 12 },
      completeness: { status: "partial", unrepresentable_total: 1, unrepresentable: [{ path: "docs/odd\\u{9}name.md", reason: "tab_or_newline", kind: "file", git_sha: "9".repeat(40), size: 12 }] },
      counts: { tree_entries: 12, manifest_rows: 10, stored: 9, stored_bytes: 16_000, skipped_by_reason: { oversize: 1, symlink: 1, submodule: 1 }, lfs_pointers: 1, symlinks: 1, submodules: 1, case_collisions: 0 },
      symlinks: [{ path: "docs/latest", target: "../../outside/notes.md", escapes_root: true }],
      submodules: [{ path: "lib/dep", commit_sha: "2".repeat(40), url: "https://example.invalid/dep.git" }],
      lfs_pointers: [{ path: "assets/video.bin", oid: "b".repeat(64), size: 9_000_000 }],
      verification: { method: "synthetic demo record", manifest_sha256: "d".repeat(64) },
    } });
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

    const list = (await (await fetch(`${base}/v1/research/projects`, { headers: { authorization: `Bearer ${token}` } })).json()) as { items: Array<{ id: string }> };
    const ids = { project: list.items[0]!.id, snapshot: snapshotId, hypothesis: h1, span: fn };
    const routes: Array<[string, string]> = [
      ["home", "#/home"], ["projects", "#/projects"], ["project", `#/projects/${ids.project}`],
      ["repository-list", "#/repository"], ["repository", `#/repository/${snapshotId}?path=${encodeURIComponent("contracts/Vault.sol")}`],
      ["hypotheses", "#/hypotheses"], ["hypothesis", `#/hypotheses/${h1}`], ["evidence-list", "#/evidence"], ["evidence", `#/evidence/${fn}`],
      ["activity", "#/activity"], ["later", "#/reviews"],
    ];
    return { base, token, ids, routes, close: async () => { await app.close(); await db.drop(); } };
  } catch (error) {
    await app.close(); await db.drop();
    throw error;
  }
}

export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.HUB_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  return chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
}
