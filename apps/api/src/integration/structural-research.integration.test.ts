import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireRepository } from "../acquisition/acquire.js";
import { FakeSource } from "../acquisition/testing/fake-source.js";
import { buildGitFixture, type GitFixture } from "../acquisition/testing/git-fixture.js";
import { buildDossier, renderDossierMarkdown, runChallenge, runStructuralAnalysis } from "../analysis/solidity/pipeline.js";
import { ResearchStore, type StepLease } from "../research-state.js";
import { WorkflowWorker } from "../worker.js";
import { assertIntegrationConfigured, migratedTestDatabase, seedRun, skipIntegration, type TestDatabase } from "./harness.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
const corpus = join(__dirname, "..", "..", "..", "..", "eval", "heldout", "contracts");
const OUT = process.env.DOSSIER_OUT;

/** A whole run on an independently authored corpus: real git fixture -> real acquisition -> sealed snapshot -> structural analysis -> execution challenge -> dossier. */
describe.skipIf(skipIntegration)("structural research run over real Postgres", () => {
  let db: TestDatabase; let fx: GitFixture; let store: ResearchStore;
  beforeAll(async () => {
    assertIntegrationConfigured(); db = await migratedTestDatabase(); store = new ResearchStore(db.pool);
    fx = buildGitFixture(readdirSync(corpus).sort().map((n) => ({ path: `contracts/${n}`, content: readFileSync(join(corpus, n), "utf8") })), { owner: "acme", repo: "corpus" });
  });
  afterAll(async () => { fx?.cleanup(); await db?.drop(); });

  async function run() {
    const { runId } = await seedRun(db.ownerPool, ["acquire_repository", "analyze_structure", "challenge_leads"]);
    const worker = new WorkflowWorker(db.pool, "structural", 300, 3);
    const lease = async (key: string): Promise<StepLease> => { const s = await worker.claimNext([key]); if (!s) throw new Error(`cannot claim ${key}`); return { stepId: s.id, workerId: "structural" }; };
    const l1 = await lease("acquire_repository");
    const acq = await acquireRepository({ store, source: new FakeSource(fx), now: () => new Date("2026-11-26T00:00:00Z") }, l1, { repository: "acme/corpus", ref: "main" });
    await worker.complete(l1.stepId, { status: "sealed" });
    const l2 = await lease("analyze_structure");
    const analysis = await runStructuralAnalysis(db.pool, store, l2, acq.snapshotId);
    await worker.complete(l2.stepId, { status: "analyzed", hypotheses: analysis.stored.length });
    const l3 = await lease("challenge_leads");
    const validations = await runChallenge(db.pool, store, l3, acq.snapshotId, analysis.stored);
    await worker.complete(l3.stepId, { status: "challenged" });
    return { runId, snapshotId: acq.snapshotId, analysis, validations };
  }

  it("produces a verified, evidence-linked dossier from stored records only", async () => {
    const r = await run();
    expect(r.analysis.problems).toEqual([]); expect(r.analysis.stored.length).toBeGreaterThan(10);
    const d = await buildDossier(db.pool, store, r.snapshotId);
    expect(d.snapshot.verified).toBe(true);
    expect(d.entries.every((e) => e.evidence.length > 0 && e.evidence.every((x) => x.verified && x.text.length > 0))).toBe(true);
    // reentrancy leads carry an execution verdict; every other class is explicitly unchallenged
    const re = d.entries.filter((e) => e.class === "reentrancy");
    expect(re.length).toBe(4);
    for (const e of re) expect(e.evaluations.map((v) => v.evaluator)).toEqual(["reentrancy-execution-validator"]);
    const verdicts = re.flatMap((e) => e.evaluations.map((v) => v.outcome)).sort();
    expect(verdicts).toEqual(["supports", "supports", "weakens", "weakens"]); // two validated by execution, two refuted under checked 0.8 arithmetic
    for (const e of d.entries.filter((x) => x.class !== "reentrancy")) {
      expect(e.evaluations.map((v) => v.evaluator)).toEqual(e.class === "tx-origin" ? ["no-independent-validator"] : [`execution-challenge-${e.class}`]); // tx.origin has no independent method and says so
    }
    expect(d.entries.some((e) => e.class === "access-control" && e.evaluations[0]!.outcome === "supports")).toBe(true);
    // status comes from the database view: a refuted lead is `weakened_by_static_check`; nothing is called reviewed or confirmed
    expect(d.entries.filter((e) => e.class === "reentrancy" && e.evaluations[0]!.outcome === "weakens").every((e) => e.status === "weakened_by_static_check")).toBe(true);
    expect(d.entries.some((e) => /confirm|verified vulnerability/i.test(e.status ?? ""))).toBe(false);
    expect(renderDossierMarkdown(d)).toMatch(/No human review is recorded/);
    if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, "dossier.json"), JSON.stringify(d, null, 2)); writeFileSync(join(OUT, "dossier.md"), renderDossierMarkdown(d)); }
  });

  it("is reproducible: a second full run over the same commit gives the same dossier content", async () => {
    const a = await buildDossier(db.pool, store, (await run()).snapshotId);
    const b = await buildDossier(db.pool, store, (await run()).snapshotId);
    expect(a.content_sha256).toBe(b.content_sha256);
  });

  it("fails closed for a snapshot that does not exist", async () => {
    await expect(buildDossier(db.pool, store, "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });
});
