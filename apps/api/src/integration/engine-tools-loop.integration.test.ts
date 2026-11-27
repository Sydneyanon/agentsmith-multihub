import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { capabilityById } from "../engine/capabilities.js";
import { EXIT, runCli, type CliIo } from "../engine/cli.js";
import { fakeTools, type FakeMode } from "../engine/tools/testing/fake-tools.js";
import "../engine/tools/tool-host/register.js";
import { applyDrafts } from "./drafts.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const corpus = join(__dirname, "..", "..", "..", "..", "eval", "dev", "contracts");
const OP = ["--operator", "owner-test"];
const SLITHER = capabilityById("slither"); const STRUCT = capabilityById("solidity-structural-specialists");

/** A CLI harness bound to one throwaway database and one tool environment. */
function harness(db: TestDatabase, fx: GitFixture, env: Record<string, string>) {
  let lines: string[] = [];
  const io: CliIo = { out: (l) => lines.push(l), err: (l) => lines.push(l), env, sourceFactory: () => new FakeSource(fx) };
  const cli = async (args: string[]) => { lines = []; const code = await runCli([...args, "--database-url", db.url], io); return { code, text: lines.join("\n") }; };
  const exec = (args: string[]) => cli([...args, "--execute", "--confirm", db.name]);
  const json = async (args: string[]) => { const r = await exec([...args, "--json"]); expect(r.code, r.text).toBe(EXIT.ok); return JSON.parse(r.text) as Record<string, unknown>; };
  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.ownerPool.query(sql, p)).rows as T[];
  /** register, verify, rank, select and acquire one opportunity; returns the acquisition run */
  const bootstrap = async (dir: string): Promise<string> => {
    const file = join(dir, `opp-${db.name}.json`);
    writeFileSync(file, JSON.stringify({ source: { key: "board", displayName: "Board (manual)" }, canonicalKey: "board:acme-vaults", platform: "community", title: "Acme vaults", referenceUrl: "https://example.org/acme", claims: { maxRewardUsd: 50000, repositories: ["acme/vaults"] } }));
    const opp = String((await json(["register", "--file", file, ...OP])).id);
    for (const [check, subject] of [["program_official", "acme"], ["repository_official", "acme/vaults"], ["scope_includes_repository", "acme/vaults"], ["eligibility", "acme"]]) {
      expect((await exec(["verify", "--opportunity", opp, "--check", check!, "--subject", subject!, "--verdict", "verified", "--method", "official page", "--evidence-url", "https://example.org/official", ...OP])).code).toBe(EXIT.ok);
    }
    const rank = await json(["rank"]);
    const sel = await json(["select", "--opportunity", opp, "--repository", "acme/vaults", "--basis", String(rank.decisionId), ...OP]);
    expect((await exec(["run-assignment", "--run", String(sel.acquisitionRunId), "--allow-network"])).code).toBe(EXIT.ok);
    return String(sel.acquisitionRunId);
  };
  /** follow `next` until only human decisions and `rank` remain */
  const drive = async (): Promise<string[]> => {
    const done: string[] = [];
    for (let i = 0; i < 120; i++) {
      const actions = JSON.parse((await cli(["next", "--json"])).text) as Array<{ command: string; who: string }>;
      const step = actions.find((x) => x.who !== "human" && x.command !== "rank"); if (!step) return done;
      const r = await exec([...step.command.split(" "), ...(step.command.startsWith("run-assignment") ? ["--allow-network"] : [])]);
      expect(r.code, `${step.command}\n${r.text}`).toBe(EXIT.ok); done.push(step.command.split(" ")[0]!);
    }
    throw new Error("the loop did not settle");
  };
  /** follow `next` (as drive does) until a map decision assigns `capability`; returns that map's result */
  const until = async (capability: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 60; i++) {
      const actions = JSON.parse((await cli(["next", "--json"])).text) as Array<{ command: string; who: string }>;
      const step = actions.find((x) => x.who !== "human" && x.who !== "attended" && x.command !== "rank"); if (!step) throw new Error(`${capability} was never assigned`);
      const args = [...step.command.split(" "), ...(step.command.startsWith("run-assignment") ? ["--allow-network"] : [])];
      if (step.command.startsWith("map")) { const m = await json(args); if ((m.assignment as { capability?: string } | null)?.capability === capability) return m; continue; }
      const r = await exec(args); expect(r.code, `${step.command}\n${r.text}`).toBe(EXIT.ok);
    }
    throw new Error(`${capability} was never assigned`);
  };
  return { cli, exec, json, q, bootstrap, drive, until };
}

describe.skipIf(skipIntegration)("research loop with complementary machines (structural specialists + Slither, stand-in tool)", () => {
  let fx: GitFixture; let dir: string; const dbs: TestDatabase[] = []; const cleanups: Array<() => void> = [];
  const fresh = async () => { const db = await migratedTestDatabase(); await applyDrafts(db); dbs.push(db); return db; };
  // "ok" uses the REAL pinned Slither when this machine has it (AGENTSMITH_SLITHER_BIN / AGENTSMITH_SOLC_BIN); otherwise the recorded-output stand-in
  const real = process.env["AGENTSMITH_SLITHER_BIN"] && process.env["AGENTSMITH_SOLC_BIN"] ? { AGENTSMITH_SLITHER_BIN: process.env["AGENTSMITH_SLITHER_BIN"], AGENTSMITH_SOLC_BIN: process.env["AGENTSMITH_SOLC_BIN"] } : null;
  const tools = (m: FakeMode) => { if (m === "ok" && real) return real; const t = fakeTools(m); cleanups.push(t.cleanup); return { AGENTSMITH_SLITHER_BIN: t.slither, AGENTSMITH_SOLC_BIN: t.solc }; };
  beforeAll(async () => {
    assertIntegrationConfigured();
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "vaults" });
    dir = mkdtempSync(join(tmpdir(), "loop-tools-"));
  });
  afterAll(async () => { fx?.cleanup(); rmSync(dir, { recursive: true, force: true }); cleanups.forEach((c) => c()); for (const d of dbs) await d.drop(); });

  it("dry run of every write command leaves the database byte-identical, sequences included, and starts no tool", async () => {
    const db = await fresh(); const h = harness(db, fx, tools("ok"));
    const fingerprint = async () => {
      const tables = (await h.q<{ t: string }>("SELECT tablename t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map((r) => r.t);
      const parts: string[] = [];
      for (const t of tables) parts.push(`${t}:${(await h.q<{ m: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) m FROM ${t} x`))[0]!.m}`);
      parts.push(JSON.stringify(await h.q("SELECT schemaname, sequencename, last_value::text v FROM pg_sequences ORDER BY 1, 2")));
      return parts.join("\n");
    };
    const toolDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("agentsmith-tool-")).length;
    const dry = async (args: string[], mustResetSequences = false) => {
      const before = await fingerprint(); const dirs = toolDirs();
      const r = await h.cli(args); expect(r.code, r.text).toBe(EXIT.ok);
      if (!args.includes("run-assignment")) expect(r.text).toMatch(/dry run: database changes rolled back; sequences reset: \d+; side effects refused: none attempted/);
      if (mustResetSequences) expect(r.text).toMatch(/sequences reset: [1-9]/); // the preview really advanced a sequence, and it was set back
      expect(await fingerprint()).toBe(before); expect(toolDirs()).toBe(dirs);
    };
    const file = join(dir, "dry.json");
    writeFileSync(file, JSON.stringify({ source: { key: "board", displayName: "Board" }, canonicalKey: "board:dry", platform: "community", title: "Dry", referenceUrl: "https://example.org/dry", claims: { repositories: ["acme/vaults"] } }));
    await dry(["register", "--file", file, ...OP], true); // writes opportunity_events (bigserial): the sequence must be reset
    const opp = String((await h.json(["register", "--file", file, ...OP])).id);
    await dry(["verify", "--opportunity", opp, "--check", "eligibility", "--subject", "acme", "--verdict", "verified", "--method", "m", "--evidence-url", "https://example.org/x", ...OP]);
    for (const [check, subject] of [["program_official", "acme"], ["repository_official", "acme/vaults"], ["scope_includes_repository", "acme/vaults"], ["eligibility", "acme"]]) await h.exec(["verify", "--opportunity", opp, "--check", check!, "--subject", subject!, "--verdict", "verified", "--method", "m", "--evidence-url", "https://example.org/x", ...OP]);
    await dry(["rank"]);
    await dry(["select", "--opportunity", opp, "--repository", "acme/vaults", ...OP]);
    const sel = await h.json(["select", "--opportunity", opp, "--repository", "acme/vaults", ...OP]);
    await dry(["run-assignment", "--run", String(sel.acquisitionRunId), "--allow-network"]);
    await h.exec(["run-assignment", "--run", String(sel.acquisitionRunId), "--allow-network"]);
    await dry(["map", "--run", String(sel.acquisitionRunId)]);
    const m = await h.json(["map", "--run", String(sel.acquisitionRunId)]);
    const inv = (m.assignment as { runId: string }).runId;
    await dry(["run-assignment", "--run", inv, "--allow-network"]); // would start Slither: nothing starts
    await h.exec(["run-assignment", "--run", inv, "--allow-network"]);
    await dry(["ingest", "--run", inv]);
    const lead = (await h.q<{ id: string }>("SELECT id FROM hypotheses LIMIT 1"))[0];
    if (lead) await dry(["adjudicate", "--hypothesis", lead.id, "--category", "inconclusive", "--rationale", "dry", ...OP]);
  });

  it("AgentSmith chooses the specialist per target, Slither leads are challenged by independent validators, and both machines' coverage lands in memory", async () => {
    const db = await fresh(); const h = harness(db, fx, tools("ok"));
    const acq = await h.bootstrap(dir);
    // value = pending classes x relevance / cost: the in-process specialists (7 classes, cost 1) go before Slither (12 classes, cost 2)
    const zero = await h.json(["map", "--run", acq]);
    expect((zero.assignment as { capability: string }).capability).toBe("solidity-structural-specialists@1");
    const first = await h.until("slither@0.11.3");
    const a = first.assignment as { capability: string; targets: string[]; runId: string };
    expect(a.targets.length).toBeGreaterThan(1);                         // whole-compilation-unit tool: one run, every component
    const cands = await h.q<{ action: string; reason: string }>("SELECT action, reason FROM research_decision_candidates WHERE decision_id = $1 AND candidate_kind = 'component'", [first.decisionId]);
    expect(cands.filter((c) => c.action === "investigate").length).toBe(a.targets.length);
    expect(cands.some((c) => /slither@0.11.3 chosen: highest value/.test(c.reason))).toBe(true);
    expect(cands.some((c) => /bundled: slither examines the whole compilation unit/.test(c.reason))).toBe(true);
    expect((await h.exec(["run-assignment", "--run", a.runId, "--allow-network"])).code).toBe(EXIT.ok);
    const [prod] = await h.q<{ output: { status: string; tool: { version: string; raw_output_sha256: string; raw_output_blob: string; input_manifest_sha256: string }; leads: unknown[]; unmapped_detectors: Record<string, number> } }>("SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = 'slither_scan'", [a.runId]);
    expect(prod!.output).toMatchObject({ status: "tool_completed", tool: { version: "0.11.3" } });
    expect(prod!.output.leads.length).toBeGreaterThan(0); expect(prod!.output.unmapped_detectors["solc-version"]).toBeGreaterThan(0);
    expect((await h.q("SELECT 1 FROM research_blobs WHERE content_sha256 = $1", [prod!.output.tool.raw_output_blob])).length).toBe(1); // raw tool output kept, content-addressed
    // plane 1: Slither's claims, anchored to hash-verified spans; plane 2: evaluations by OTHER evaluators only
    const planes = await h.q<{ generator_id: string; evaluator_id: string; outcome: string }>(
      "SELECT h.generator_id, e.evaluator_id, e.outcome FROM hypotheses h JOIN hypothesis_evaluations e ON e.hypothesis_id = h.id WHERE h.workflow_run_id = $1", [a.runId]);
    expect(planes.length).toBeGreaterThan(0);
    for (const p of planes) { expect(p.generator_id).toBe("slither"); expect(p.evaluator_id).not.toBe("slither"); }
    expect(planes.some((p) => p.evaluator_id === "reentrancy-execution-validator")).toBe(true);
    expect((await h.q("SELECT 1 FROM hypotheses h WHERE h.workflow_run_id = $1 AND NOT EXISTS (SELECT 1 FROM hypothesis_evidence x WHERE x.hypothesis_id = h.id)", [a.runId])).length).toBe(0);
    const ing = await h.exec(["ingest", "--run", a.runId]);
    expect(ing.text).toMatch(/^slither@0\.11\.3: memory: \d+ coverage rows, 2 effort rows/m);
    await h.drive();
    // every component examined by BOTH machines at its current hash; what remains unexplored is exactly what nobody can examine here
    const per = await h.q<{ component_path: string; methods: string[] }>("SELECT component_path, array_agg(DISTINCT method ORDER BY method) methods FROM research_coverage WHERE result = 'examined' GROUP BY 1");
    expect(per.length).toBe(a.targets.length);
    for (const p of per) expect(p.methods).toEqual([SLITHER.id, STRUCT.id].sort());
    const snap = String((await h.q<{ id: string }>("SELECT id FROM repo_snapshots ORDER BY created_at LIMIT 1"))[0]!.id);
    const ledger = JSON.parse((await h.cli(["ledger", "--snapshot", snap, "--json"])).text) as { unexplored: number; notModelled: number };
    expect(ledger.unexplored).toBe(ledger.notModelled); expect(ledger.notModelled).toBeGreaterThan(0);
    const status = await h.cli(["status"]); expect(status.text).toMatch(/next:\n\s+\[(agentsmith|human)\]/);
  });

  it("a failed tool is an explicit state: recorded as abstained (not examined), never retried at the same version, and the other machine takes over", async () => {
    const db = await fresh(); const h = harness(db, fx, tools("compile_error"));
    await h.bootstrap(dir);
    const m = await h.until("slither@0.11.3");
    const a = m.assignment as { capability: string; runId: string };
    expect((await h.exec(["run-assignment", "--run", a.runId, "--allow-network"])).code).toBe(EXIT.ok);
    const [prod] = await h.q<{ output: { status: string; failure: { code: string } } }>("SELECT output FROM workflow_steps WHERE workflow_run_id = $1 AND step_key = 'slither_scan'", [a.runId]);
    expect(prod!.output).toMatchObject({ status: "tool_failed", failure: { code: "compile_failed" } });
    const ing = await h.exec(["ingest", "--run", a.runId]);
    expect(ing.text).toMatch(/slither@0\.11\.3 FAILED \(compile_failed\): recorded as abstained, not as examined/);
    const cov = await h.q<{ result: string; reason_code: string | null; n: string }>("SELECT result, reason_code, count(*) n FROM research_coverage WHERE workflow_run_id = $1 AND method = 'slither' GROUP BY 1, 2", [a.runId]);
    expect(cov.map((c) => [c.result, c.reason_code])).toEqual([["abstained", "compile_failed"]]);
    await h.drive();
    const assigned = await h.q<{ cap: string; n: string }>("SELECT input->'assignment'->'capability'->>'id' cap, count(*) n FROM workflow_runs WHERE input ? 'assignment' GROUP BY 1 ORDER BY 1");
    expect(assigned.find((x) => x.cap === "slither")!.n).toBe("1"); // never retried at 0.11.3
    expect(Number(assigned.find((x) => x.cap === STRUCT.id)!.n)).toBeGreaterThan(0);
    expect((await h.q("SELECT 1 FROM research_coverage WHERE method = 'slither' AND result = 'examined'")).length).toBe(0); // no false "clean"
  });

  it("without the pinned binaries Slither is never assigned, and the decision says why", async () => {
    const db = await fresh(); const h = harness(db, fx, {});
    const acq = await h.bootstrap(dir);
    const m = await h.json(["map", "--run", acq]);
    expect((m.assignment as { capability: string }).capability).toBe("solidity-structural-specialists@1");
    const [c] = await h.q<{ features: { capabilities: { value: Array<{ id: string; available: boolean; reason: string }> } } }>("SELECT features FROM research_decision_candidates WHERE decision_id = $1 AND selected LIMIT 1", [m.decisionId]);
    const sl = c!.features.capabilities.value.find((x) => x.id === "slither@0.11.3")!;
    expect(sl.available).toBe(false); expect(sl.reason).toMatch(/AGENTSMITH_SLITHER_BIN/);
    expect(c!.features.capabilities.value.find((x) => x.id === "foundry-forge@1.5.1")).toMatchObject({ available: false, reason: expect.stringMatching(/AGENTSMITH_FORGE_BIN/) });
  });
});
