import type { Pool } from "pg";
import { ResearchStore, sha256Hex, type GeneratorIdentity, type ReviewerSaw, type StepLease } from "../research-state.js";
import { WorkflowWorker } from "../worker.js";
import { seedRun, type TestDatabase } from "./harness.js";

/** A Solidity-like fixture with known line numbers (8 lines; the trailing newline is not a line). */
export const VAULT = [
  "// SPDX-License-Identifier: MIT",
  "pragma solidity ^0.8.20;",
  "contract Vault {",
  "  function withdraw(uint amount) external {",
  '    (bool ok, ) = msg.sender.call{value: amount}("");',
  "    balances[msg.sender] -= amount;",
  "  }",
  "}",
  "",
].join("\n");

export const BLINDED_SAW: ReviewerSaw = {
  claim: true, evidence_spans: true, generator_rationale: false, generator_identity: false, prior_evaluations: false, prior_reviews: false,
};
export const FULL_SAW: ReviewerSaw = {
  claim: true, evidence_spans: true, generator_rationale: true, generator_identity: true, prior_evaluations: true, prior_reviews: true,
};

export const RULE: GeneratorIdentity = { kind: "deterministic_rule", id: "rule-reentrancy", version: "1" };

export class ResearchFixture {
  readonly store: ResearchStore;
  private readonly worker: WorkflowWorker;
  private counter = 0;
  /** run and step that own each raw-built snapshot, so raw SQL in tests can carry the provenance columns */
  private readonly owners = new Map<string, { runId: string; stepId: string }>();

  constructor(readonly db: TestDatabase) {
    this.store = new ResearchStore(db.pool);
    this.worker = new WorkflowWorker(db.pool, "research-writer", 30, 3);
  }

  /** Owner connection: fixture setup and deliberate trigger probes. The store and worker under test use the runtime pool. */
  get pool(): Pool { return this.db.ownerPool; }

  next(): number { return ++this.counter; }

  commit(): string { return this.next().toString(16).padStart(40, "0"); }

  /** A run with one running step held by this fixture's worker. */
  async step(): Promise<{ runId: string; lease: StepLease }> {
    const key = `research_step_${this.next()}`;
    const { runId } = await seedRun(this.pool, [key]);
    const claimed = await this.worker.claimNext([key]);
    if (!claimed) throw new Error("could not claim the fixture step");
    return { runId, lease: { stepId: claimed.id, workerId: "research-writer" } };
  }

  /** A sealed snapshot of the given files (path -> text), built through the store under a step lease. */
  async sealedSnapshot(files: Record<string, string> = { "contracts/Vault.sol": VAULT }) {
    const ctx = await this.step();
    const snapshotId = await this.store.createSnapshot(ctx.lease, { repository: "acme/vault", commitSha: this.commit(), refName: "main" });
    const entries = [];
    for (const [path, text] of Object.entries(files)) {
      const blob = await this.store.putBlob(ctx.lease, Buffer.from(text, "utf8"));
      entries.push({ path, classification: "source", sizeBytes: blob.sizeBytes, blobSha256: blob.sha256 });
    }
    await this.store.addSnapshotFiles(ctx.lease, snapshotId, entries);
    const sealed = await this.store.sealSnapshot(ctx.lease, snapshotId);
    this.owners.set(snapshotId, { runId: ctx.runId, stepId: ctx.lease.stepId });
    return { ...ctx, snapshotId, sealed };
  }

  span(ctx: { lease: StepLease; snapshotId: string }, lineStart: number, lineEnd = lineStart, path = "contracts/Vault.sol") {
    return this.store.createEvidenceSpan(ctx.lease, { snapshotId: ctx.snapshotId, path, lineStart, lineEnd });
  }

  /** A hypothesis with a unique claim, citing the given spans (the first is primary). */
  async hypothesis(
    ctx: { lease: StepLease; snapshotId: string },
    spanIds: string[],
    overrides: { generator?: GeneratorIdentity; claim?: string } = {},
  ): Promise<string> {
    const made = await this.store.createHypothesis(ctx.lease, {
      snapshotId: ctx.snapshotId, family: "solidity-low-level-call",
      claim: overrides.claim ?? `External call before the balance update, case ${this.next()}.`,
      rationale: "The call target receives control before state is updated.",
      requiredChecks: ["Trace the call target"], alternativeExplanations: ["A guard may exist"],
      generator: overrides.generator ?? RULE,
      spans: spanIds.map((spanId, index) => ({ spanId, role: index === 0 ? "primary" as const : "supporting" as const })),
    });
    return made.id;
  }

  evaluate(ctx: { lease: StepLease }, hypothesisId: string, outcome: "supports" | "weakens" | "contradicts" | "inconclusive", spanIds: string[], evaluatorId = "eval-a") {
    return this.store.recordEvaluation(ctx.lease, {
      hypothesisId, evaluatorId, evaluatorVersion: "1", outcome, rationale: `outcome ${outcome}`, spanIds, inputSha256: sha256Hex(`${evaluatorId}${outcome}${this.next()}`),
    });
  }

  review(hypothesisId: string, reviewerId: string, verdict: "supports" | "rejects" | "needs_more_evidence" | "inconclusive" = "supports",
    mode: "blinded_independent_assessment" | "disclosed_adjudication" = "blinded_independent_assessment") {
    return this.store.recordReview({ kind: "operator", operatorId: reviewerId }, {
      hypothesisId, reviewerKind: "human", reviewerId, mode, reviewerSaw: mode === "blinded_independent_assessment" ? BLINDED_SAW : FULL_SAW,
      inputSha256: sha256Hex(`${reviewerId}${verdict}${this.next()}`), verdict, rationale: `verdict ${verdict}`,
    });
  }

  async status(hypothesisId: string): Promise<Record<string, any>> {
    return (await this.store.getStatus(hypothesisId))!;
  }

  /** A gateway reservation row, so model generators and reviewers have something real to reference. */
  async reservation(): Promise<string> {
    const row = await this.pool.query<{ id: string }>(
      "INSERT INTO ai_budget_reservations (provider, model, purpose, tier, reserved_usd) VALUES ('test','test-model','investigation','tier2',0.01) RETURNING id");
    return row.rows[0]!.id;
  }

  async rawBlob(content: Buffer): Promise<string> {
    const sha = sha256Hex(content);
    await this.pool.query("INSERT INTO research_blobs (content_sha256, size_bytes, content) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [sha, content.length, content]);
    return sha;
  }

  /** A building snapshot inserted with raw SQL, owned by a fresh run and step. */
  async rawSnapshot(): Promise<string> {
    const { runId, stepIds } = await seedRun(this.pool, [`raw_${this.next()}`]);
    const id = (await this.pool.query<{ id: string }>(
      "INSERT INTO repo_snapshots (workflow_run_id, produced_by_step_id, source_host, repository, commit_sha) VALUES ($1,$2,'github.com','acme/raw',$3) RETURNING id",
      [runId, stepIds[0], this.commit()])).rows[0]!.id;
    this.owners.set(id, { runId, stepId: stepIds[0]! });
    return id;
  }

  /** Registers the owner of a snapshot built through the store, so raw SQL can carry its provenance. */
  adopt(ctx: { snapshotId: string; runId: string; lease: StepLease }): void {
    this.owners.set(ctx.snapshotId, { runId: ctx.runId, stepId: ctx.lease.stepId });
  }

  owner(snapshotId: string): { runId: string; stepId: string } {
    const owner = this.owners.get(snapshotId);
    if (!owner) throw new Error(`no recorded owner for snapshot ${snapshotId}`);
    return owner;
  }

  /** A manifest row inserted with raw SQL (stored when `blobSha` is set, skipped when `skipReason` is set). */
  async rawInsertFile(snapshotId: string, file: { path: string; blobSha?: string | null; size: number; classification?: string; skipReason?: string | null }) {
    const owner = this.owner(snapshotId);
    await this.pool.query(
      `INSERT INTO repo_snapshot_files (snapshot_id, workflow_run_id, produced_by_step_id, path, blob_sha256, size_bytes, classification, skip_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [snapshotId, owner.runId, owner.stepId, file.path, file.blobSha ?? null, file.size, file.classification ?? "source", file.skipReason ?? null]);
  }

  async rawFile(snapshotId: string, path: string, blobSha: string, size: number, classification = "source") {
    await this.rawInsertFile(snapshotId, { path, blobSha, size, classification });
  }

  /** Seals a raw snapshot as its own step; `extraSet` adds hand-written columns to the same UPDATE. */
  rawSeal(snapshotId: string, extraSet = "", extraParams: unknown[] = []) {
    const owner = this.owner(snapshotId);
    return this.pool.query(
      `UPDATE repo_snapshots SET sealed_at = now(), sealed_by_step_id = $2${extraSet ? `, ${extraSet}` : ""} WHERE id = $1`,
      [snapshotId, owner.stepId, ...extraParams]);
  }

  rawSpan(snapshotId: string, path: string, blobSha: string, lineStart: number, lineEnd: number, excerptSha: string) {
    const owner = this.owner(snapshotId);
    return this.pool.query(
      `INSERT INTO evidence_spans (workflow_run_id, produced_by_step_id, snapshot_id, path, blob_sha256, line_start, line_end, excerpt_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [owner.runId, owner.stepId, snapshotId, path, blobSha, lineStart, lineEnd, excerptSha]);
  }

  /** Runs SQL with one named trigger switched off, to simulate corruption that normal writes cannot produce. */
  async withTriggerDisabled<T>(table: string, trigger: string, fn: () => Promise<T>): Promise<T> {
    await this.pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    try { return await fn(); } finally { await this.pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); }
  }
}
