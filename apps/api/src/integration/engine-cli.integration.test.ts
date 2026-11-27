import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { EXIT, parseArgs, resolveTarget, runCli, type CliIo } from "../engine/cli.js";
import { applyDrafts } from "./drafts.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const corpus = join(__dirname, "..", "..", "..", "..", "eval", "dev", "contracts");

describe("research-loop CLI target guard (no database needed)", () => {
  const t = (url: string, env: Record<string, string> = {}) => () => resolveTarget(parseArgs(["status", "--database-url", url]), env);
  it("accepts only a loopback, disposably named postgres database", () => {
    expect(t("postgres://u:secret@127.0.0.1:5432/agentsmith_scratch_one")()).toMatchObject({ name: "agentsmith_scratch_one", host: "127.0.0.1" });
    expect(t("postgres://u:p@db.internal:5432/agentsmith_scratch_one")).toThrow(/not loopback/);
    expect(t("postgres://u:p@agentsmith-db.flycast:5432/agentsmith_test_x")).toThrow(/not loopback/);
    expect(t("postgres://u:p@localhost/agentsmith")).toThrow(/not named as disposable/);
    expect(t("postgres://u:p@localhost/postgres")).toThrow(/not named as disposable/);
    expect(t("mysql://u:p@localhost/agentsmith_test_x")).toThrow(/postgres/);
    expect(t("postgres://u:p@localhost/agentsmith_test_x", { HUB_DATA_KIND: "production" })).toThrow(/production/);
    expect(t("postgres://u:p@localhost/agentsmith_test_x", { FLY_APP_NAME: "agentsmith-hub" })).toThrow(/production/);
  });
  it("ignores DATABASE_URL and never echoes the password", async () => {
    const out: string[] = [];
    const io: CliIo = { out: (l) => out.push(l), err: (l) => out.push(l), env: { DATABASE_URL: "postgres://u:hunter2@127.0.0.1/agentsmith_test_x" } };
    expect(await runCli(["status"], io)).toBe(EXIT.usage);
    expect(out.join("\n")).toMatch(/DATABASE_URL is deliberately ignored/);
    out.length = 0;
    expect(await runCli(["status", "--database-url", "postgres://u:hunter2@10.0.0.5/agentsmith_test_x"], io)).toBe(EXIT.refused);
    expect(out.join("\n")).not.toContain("hunter2");
  });
  it("rejects unknown commands with help", async () => {
    const out: string[] = [];
    expect(await runCli(["deploy"], { out: (l) => out.push(l), err: (l) => out.push(l), env: {} })).toBe(EXIT.usage);
    expect(out.join("\n")).toMatch(/unknown command deploy/);
  });
});

describe.skipIf(skipIntegration)("research-loop CLI on a throwaway database", () => {
  let db: TestDatabase; let bare: TestDatabase; let fx: GitFixture; let dir: string;
  let lines: string[] = [];
  const io = (extra: Partial<CliIo> = {}): CliIo => ({ out: (l) => lines.push(l), err: (l) => lines.push(l), env: {}, source: new FakeSource(fx), ...extra });
  const cli = async (args: string[], extra: Partial<CliIo> = {}) => { lines = []; const code = await runCli([...args, "--database-url", db.url], io(extra)); return { code, text: lines.join("\n") }; };
  const exec = (args: string[]) => cli([...args, "--execute", "--confirm", db.name]);
  const json = async (args: string[]) => { const r = await exec([...args, "--json"]); expect(r.code, r.text).toBe(EXIT.ok); return JSON.parse(r.text) as Record<string, unknown>; };
  const count = async (table: string) => Number((await db.ownerPool.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  const OP = ["--operator", "owner-test"];
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await migratedTestDatabase(); await applyDrafts(db); bare = await migratedTestDatabase();
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "vaults" });
    dir = mkdtempSync(join(tmpdir(), "loop-cli-"));
  });
  afterAll(async () => { fx?.cleanup(); rmSync(dir, { recursive: true, force: true }); await db?.drop(); await bare?.drop(); });

  it("refuses a database without the drafts, and never applies them", async () => {
    lines = [];
    expect(await runCli(["status", "--database-url", bare.url], io())).toBe(EXIT.refused);
    expect(lines.join("\n")).toMatch(/drafts are not present.*never applies migrations/);
    expect((await bare.ownerPool.query("SELECT to_regclass('research_decisions') t")).rows[0].t).toBeNull();
  });

  it("register: dry run keeps nothing; --execute needs a matching confirmation", async () => {
    const file = join(dir, "opp.json");
    writeFileSync(file, JSON.stringify({ source: { key: "community-board", displayName: "Community board (manual)" }, canonicalKey: "community:acme-vaults", platform: "community", title: "Acme vaults", referenceUrl: "https://example.org/board/acme", claims: { maxRewardUsd: 50000, repositories: ["acme/vaults"] } }));
    const dry = await cli(["register", "--file", file, ...OP]);
    expect(dry.code).toBe(EXIT.ok); expect(dry.text).toMatch(/DRY RUN/); expect(dry.text).toMatch(/new opportunity/);
    expect(await count("bounty_opportunities")).toBe(0); expect(await count("discovery_observations")).toBe(0);
    expect((await cli(["register", "--file", file, ...OP, "--execute"])).code).toBe(EXIT.refused);            // no confirmation, not interactive
    expect((await cli(["register", "--file", file, ...OP, "--execute", "--confirm", "agentsmith_test_wrong"])).code).toBe(EXIT.refused);
    expect(await count("bounty_opportunities")).toBe(0);
    // interactive confirmation: typing the database name commits
    const r = await cli(["register", "--file", file, ...OP, "--execute"], { prompt: async () => db.name });
    expect(r.code, r.text).toBe(EXIT.ok); expect(r.text).toMatch(/EXECUTE \(confirmed\)/);
    expect(await count("bounty_opportunities")).toBe(1);
    ids.opp = String((await db.ownerPool.query("SELECT id FROM bounty_opportunities")).rows[0].id);
  });

  it("verify, rank and select: the ranking shows candidates and reasons; a human selects", async () => {
    for (const [check, subject] of [["program_official", "acme"], ["repository_official", "acme/vaults"], ["scope_includes_repository", "acme/vaults"], ["eligibility", "acme"]]) {
      const r = await exec(["verify", "--opportunity", ids.opp!, "--check", check!, "--subject", subject!, "--verdict", "verified", "--method", "read the official page", "--evidence-url", "https://example.org/official/acme", ...OP]);
      expect(r.code, r.text).toBe(EXIT.ok);
    }
    expect((await exec(["verify", "--opportunity", ids.opp!, "--check", "eligibility", "--subject", "acme", "--verdict", "verified", "--method", "m", "--evidence-url", "http://insecure", ...OP])).code).toBe(EXIT.usage);
    const before = await count("research_decisions");
    const dry = await cli(["rank"]);
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.text).toMatch(/decision .* level=opportunity mode=exploit by=policy:research-policy\/0/);
    expect(dry.text).toMatch(/recommend\s+\d+(\.\d+)?\s+opportunity:/);
    expect(dry.text).toMatch(/not a probability/);
    expect(await count("research_decisions")).toBe(before); // dry run: the decision was shown, not kept
    const ranked = await json(["rank"]);
    expect(ranked.recommended).toBe(ids.opp); ids.rankDecision = String(ranked.decisionId);
    const next = await cli(["next"]);
    expect(next.text).toMatch(/\[human\] select --opportunity/);
    expect((await exec(["select", "--opportunity", ids.opp!, "--repository", "evil/repo", ...OP])).code).toBe(EXIT.failed); // not verified: refused by AgentSmith
    const sel = await json(["select", "--opportunity", ids.opp!, "--repository", "acme/vaults", "--basis", ids.rankDecision!, ...OP]);
    ids.acq = String(sel.acquisitionRunId);
  });

  it("run-assignment: dry run lists the steps and runs nothing; --execute runs exactly that run once", async () => {
    const dry = await cli(["run-assignment", "--run", ids.acq!]);
    expect(dry.text).toMatch(/would execute, in order, once/); expect(dry.text).toMatch(/acquire_repository \(queued\)/);
    expect((await db.ownerPool.query("SELECT status FROM workflow_steps WHERE workflow_run_id = $1", [ids.acq])).rows[0].status).toBe("queued");
    const r = await exec(["run-assignment", "--run", ids.acq!]);
    expect(r.code, r.text).toBe(EXIT.ok); expect(r.text).toMatch(/acquire_repository: succeeded/); expect(r.text).toMatch(/next: map --run/);
  });

  it("map, run, ingest, show-decision and leads expose the decision, its candidates, evidence and the next action", async () => {
    const preview = await cli(["map", "--run", ids.acq!]);
    expect(preview.text).toMatch(/level=component/); expect(preview.text).toMatch(/investigate .* component:contracts\//);
    expect(await count("research_coverage")).toBe(0);
    const m = await json(["map", "--run", ids.acq!]);
    const inv = (m.assignment as { runId: string }).runId; ids.inv = inv;
    expect((await exec(["run-assignment", "--run", inv])).code).toBe(EXIT.ok);
    const ing = await exec(["ingest", "--run", inv]);
    expect(ing.text).toMatch(/memory: 12 coverage rows, 2 effort rows/); expect(ing.text).toMatch(/next: map --run .* --follow-up/);
    const shown = await cli(["show-decision", "--id", String(m.decisionId), "--verbose"]);
    expect(shown.text).toMatch(/unexplored .*specialist classes not examined/); expect(shown.text).toMatch(/feature content_sha256: \{"value":"[0-9a-f]{64}","source":"protocol model/);
    const leads = await cli(["leads", "--run", inv]);
    if ((leads.text.match(/machine=/g) ?? []).length > 0) { expect(leads.text).toMatch(/evidence span: contracts\/.*:\d+-\d+/); expect(leads.text).toMatch(/claim \(deterministic_rule:solidity-structural-specialists\)/); }
    const nx = await cli(["next"]); expect(nx.text).toMatch(new RegExp(`\\[agentsmith\\] map --run ${inv} --follow-up`));
  });

  it("adjudicate: plane 3 is human-only and the database refuses an unearned 'confirmed'", async () => {
    const h = (await db.ownerPool.query("SELECT h.id FROM hypotheses h JOIN workflow_runs r ON r.id = h.workflow_run_id WHERE r.id = $1 LIMIT 1", [ids.inv])).rows[0]?.id as string | undefined;
    if (!h) return;
    const bad = await exec(["adjudicate", "--hypothesis", h, "--category", "confirmed", "--rationale", "no basis", ...OP]);
    expect(bad.code).toBe(EXIT.failed); expect(bad.text).toMatch(/confirmed requires/);
    const ok = await exec(["adjudicate", "--hypothesis", h, "--category", "refuted", "--review-verdict", "rejects", "--rationale", "test adjudication", ...OP]);
    expect(ok.code, ok.text).toBe(EXIT.ok);
    expect((await db.ownerPool.query("SELECT category, decided_by FROM hypothesis_outcomes WHERE hypothesis_id = $1", [h])).rows).toEqual([{ category: "refuted", decided_by: "owner-test" }]);
  });

  it("following `next` alone drives the loop until only human decisions and `rank` remain", async () => {
    for (let i = 0; i < 80; i++) {
      const actions = JSON.parse((await cli(["next", "--json"])).text) as Array<{ command: string; who: string }>;
      const step = actions.find((x) => x.who !== "human" && x.command !== "rank");
      if (!step) { expect(actions.some((x) => x.command === "rank" || x.who === "human")).toBe(true); break; }
      const r = await exec(step.command.split(" "));
      expect(r.code, `${step.command}\n${r.text}`).toBe(EXIT.ok);
    }
    const status = await cli(["status"]);
    expect(status.text).toMatch(/ledger acme\/vaults@/);
    const snap = String((await db.ownerPool.query("SELECT id FROM repo_snapshots ORDER BY created_at LIMIT 1")).rows[0].id);
    const ledger = JSON.parse((await cli(["ledger", "--snapshot", snap, "--json"])).text) as { unexplored: number; notModelled: number; refuted: number };
    expect(ledger.unexplored).toBe(ledger.notModelled); expect(ledger.notModelled).toBeGreaterThan(0);
    const last = (await db.ownerPool.query("SELECT id FROM research_decisions WHERE level = 'follow_up' ORDER BY created_at DESC LIMIT 1")).rows[0].id as string;
    expect((await cli(["show-decision", "--id", last])).text).toMatch(/No component has a specialist class left/);
  });
});
