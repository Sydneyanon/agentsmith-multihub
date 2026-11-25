import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ResearchConflictError, sha256Hex } from "../research-state.js";
import { assertIntegrationConfigured, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";
import { BLINDED_SAW, RULE, ResearchFixture } from "./research-helpers.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const FK = /violates foreign key constraint/;

describe.skipIf(skipIntegration)("research state: provenance across runs, safe retries and evaluation provenance (real Postgres)", () => {
  let db: TestDatabase;
  let fx: ResearchFixture;
  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await migratedTestDatabase();
    fx = new ResearchFixture(db);
  });
  afterAll(async () => { await db?.drop(); });

  /** Two complete, unrelated runs, each with a sealed snapshot, a span and a hypothesis. */
  async function twoRuns() {
    const a = await fx.sealedSnapshot();
    const b = await fx.sealedSnapshot();
    const spanA = await fx.span(a, 5);
    const spanB = await fx.span(b, 5);
    const hypA = await fx.hypothesis(a, [spanA]);
    const hypB = await fx.hypothesis(b, [spanB]);
    return { a, b, spanA, spanB, hypA, hypB };
  }

  const count = async (table: string) => Number((await db.pool.query(`SELECT count(*) FROM ${table}`)).rows[0]!.count);

  describe("the database refuses records that mix runs (raw SQL, no application code involved)", () => {
    it("snapshots: the producing and sealing steps must belong to the snapshot's run", async () => {
      const { a, b } = await twoRuns();
      await expect(db.pool.query(
        "INSERT INTO repo_snapshots (workflow_run_id, produced_by_step_id, source_host, repository, commit_sha) VALUES ($1,$2,'github.com','x/y',$3)",
        [a.runId, b.lease.stepId, fx.commit()])).rejects.toThrow(FK);
      const building = await fx.rawSnapshot();
      await expect(db.ownerPool.query("UPDATE repo_snapshots SET sealed_at = now(), sealed_by_step_id = $2 WHERE id = $1", [building, b.lease.stepId])).rejects.toThrow(FK);
      await expect(db.ownerPool.query("UPDATE repo_snapshots SET sealed_at = now() WHERE id = $1", [building])).rejects.toThrow(/must name the sealing step/);
      await expect(fx.rawSeal(building)).resolves.toBeTruthy(); // its own step may seal it
    });

    it("manifest rows: cannot be added to another run's snapshot, nor by another run's step", async () => {
      const { a, b } = await twoRuns();
      const building = await fx.rawSnapshot();
      const owner = fx.owner(building);
      const blob = await fx.rawBlob(Buffer.from("x"));
      const insert = (run: string, step: string, snapshot = building) => db.pool.query(
        "INSERT INTO repo_snapshot_files (snapshot_id, workflow_run_id, produced_by_step_id, path, blob_sha256, size_bytes, classification) VALUES ($1,$2,$3,'a.sol',$4,1,'source')",
        [snapshot, run, step, blob]);
      await expect(insert(b.runId, b.lease.stepId)).rejects.toThrow(FK); // run B's step writing a run B row into run A's snapshot
      await expect(insert(owner.runId, b.lease.stepId)).rejects.toThrow(FK); // right run, wrong step
      await expect(insert(b.runId, owner.stepId)).rejects.toThrow(FK); // right step, wrong run
      await expect(insert(owner.runId, owner.stepId)).resolves.toBeTruthy();
      void a;
    });

    it("evidence spans: must carry the snapshot's run and a step of that run", async () => {
      const { a, b } = await twoRuns();
      const blob = sha256Hex(Buffer.from(await textOf(a.snapshotId)));
      const insert = (run: string, step: string | null) => db.pool.query(
        `INSERT INTO evidence_spans (workflow_run_id, produced_by_step_id, snapshot_id, path, blob_sha256, line_start, line_end, excerpt_sha256)
         VALUES ($1,$2,$3,'contracts/Vault.sol',$4,1,1,$5)`, [run, step, a.snapshotId, blob, sha256Hex("// SPDX-License-Identifier: MIT")]);
      await expect(insert(b.runId, b.lease.stepId)).rejects.toThrow(FK);
      await expect(insert(a.runId, b.lease.stepId)).rejects.toThrow(FK);
      await expect(insert(a.runId, a.lease.stepId)).resolves.toBeTruthy();
    });

    it("hypotheses: snapshot, producing step and superseded hypothesis must all be in the hypothesis's run", async () => {
      const { a, b, hypB } = await twoRuns();
      const insert = (run: string, step: string | null, snapshot: string, supersedes: string | null = null) => db.pool.query(
        `INSERT INTO hypotheses (workflow_run_id, produced_by_step_id, snapshot_id, supersedes_id, family, claim, rationale, generator_kind, generator_id, generator_version, claim_fingerprint)
         VALUES ($1,$2,$3,$4,'x-family','A cross-run claim for the test.','r','human','alice','1',$5)`, [run, step, snapshot, supersedes, sha256Hex(`x${fx.next()}`)]);
      await expect(insert(b.runId, b.lease.stepId, a.snapshotId)).rejects.toThrow(FK); // run B pinning run A's snapshot
      await expect(insert(a.runId, b.lease.stepId, a.snapshotId)).rejects.toThrow(FK); // run A claim made by run B's step
      await expect(insert(a.runId, a.lease.stepId, a.snapshotId, hypB)).rejects.toThrow(FK); // superseding another run's claim
    });

    it("evidence links: hypothesis, span and step must share one run", async () => {
      const { a, b, spanA, hypA } = await twoRuns();
      const extra = await fx.span(a, 6);
      const link = (run: string, step: string | null) => db.pool.query(
        "INSERT INTO hypothesis_evidence (hypothesis_id, span_id, workflow_run_id, produced_by_step_id, role) VALUES ($1,$2,$3,$4,'supporting')", [hypA, extra, run, step]);
      await expect(link(b.runId, a.lease.stepId)).rejects.toThrow(FK); // the span and hypothesis are run A's, the link claims run B
      await expect(link(a.runId, b.lease.stepId)).rejects.toThrow(FK);
      await expect(link(a.runId, a.lease.stepId)).resolves.toBeTruthy();
      void spanA;
    });

    it("evaluations: run and producing step must match the hypothesis, and the step is mandatory", async () => {
      const { a, b, hypA } = await twoRuns();
      const insert = (run: string, step: string | null) => db.pool.query(
        `INSERT INTO hypothesis_evaluations (workflow_run_id, hypothesis_id, produced_by_step_id, evaluator_id, evaluator_version, outcome, rationale, input_sha256)
         VALUES ($1,$2,$3,'e','1','inconclusive','r',$4)`, [run, hypA, step, sha256Hex(`e${fx.next()}`)]);
      await expect(insert(b.runId, b.lease.stepId)).rejects.toThrow(FK); // another run's evaluation of this hypothesis
      await expect(insert(a.runId, b.lease.stepId)).rejects.toThrow(FK); // another run's step
      await expect(insert(a.runId, null)).rejects.toThrow(/null value in column "produced_by_step_id"/);
      await expect(insert(a.runId, a.lease.stepId)).resolves.toBeTruthy();
    });

    it("evaluation evidence: evaluation, span and step must share one run", async () => {
      const { a, b, hypA } = await twoRuns();
      const span = await fx.span(a, 7);
      const evaluation = await fx.evaluate(a, hypA, "weakens", [span]);
      const other = await fx.span(a, 8);
      const link = (run: string, step: string) => db.pool.query(
        "INSERT INTO evaluation_evidence (evaluation_id, span_id, workflow_run_id, produced_by_step_id) VALUES ($1,$2,$3,$4)", [evaluation, other, run, step]);
      await expect(link(b.runId, a.lease.stepId)).rejects.toThrow(FK);
      await expect(link(a.runId, b.lease.stepId)).rejects.toThrow(FK);
      await expect(link(a.runId, a.lease.stepId)).resolves.toBeTruthy();
    });

    it("reviews and events: carry the hypothesis's run", async () => {
      const { a, b, hypA } = await twoRuns();
      const review = (run: string, step: string | null) => db.pool.query(
        `INSERT INTO hypothesis_reviews (workflow_run_id, hypothesis_id, produced_by_step_id, reviewer_kind, reviewer_id, review_mode, reviewer_saw, input_sha256, verdict, rationale)
         VALUES ($1,$2,$3,'human','zed','blinded_independent_assessment',$4::jsonb,$5,'supports','r')`, [run, hypA, step, JSON.stringify(BLINDED_SAW), sha256Hex(`r${fx.next()}`)]);
      await expect(review(b.runId, null)).rejects.toThrow(FK);
      await expect(review(a.runId, b.lease.stepId)).rejects.toThrow(FK);
      await expect(review(a.runId, null)).resolves.toBeTruthy();
      const withdraw = (run: string) => db.pool.query(
        "INSERT INTO hypothesis_events (workflow_run_id, hypothesis_id, event_type, actor_kind, actor_id, reason) VALUES ($1,$2,'withdrawn','human','zed','Cross-run withdrawal.')", [run, hypA]);
      await expect(withdraw(b.runId)).rejects.toThrow(FK);
      await expect(withdraw(a.runId)).resolves.toBeTruthy();
    });
  });

  describe("schema contract: every record is tied to its run by a composite key", () => {
    // Several constraints overlap (for example the event log re-checks an evaluation's run), so removing one key can
    // be masked at runtime. This reads the catalog and pins each key, so no single link can be dropped unnoticed.
    const RUN_SCOPED = ["repo_snapshots", "evidence_spans", "hypotheses", "hypothesis_evaluations", "hypothesis_reviews", "workflow_steps"];
    const TABLES = ["repo_snapshots", "repo_snapshot_files", "evidence_spans", "hypotheses", "hypothesis_evidence", "hypothesis_evaluations",
      "evaluation_evidence", "hypothesis_reviews", "hypothesis_events"];
    const EXPECTED = [
      "repo_snapshots(produced_by_step_id,workflow_run_id)->workflow_steps(id,workflow_run_id)",
      "repo_snapshots(sealed_by_step_id,workflow_run_id)->workflow_steps(id,workflow_run_id)",
      "repo_snapshot_files(snapshot_id,workflow_run_id)->repo_snapshots(id,workflow_run_id)",
      "repo_snapshot_files(produced_by_step_id,workflow_run_id)->workflow_steps(id,workflow_run_id)",
      "evidence_spans(snapshot_id,workflow_run_id)->repo_snapshots(id,workflow_run_id)",
      "evidence_spans(produced_by_step_id,workflow_run_id)->workflow_steps(id,workflow_run_id)",
      "hypotheses(snapshot_id,workflow_run_id)->repo_snapshots(id,workflow_run_id)",
      "hypotheses(produced_by_step_id,workflow_run_id)->workflow_steps(id,workflow_run_id)",
      "hypotheses(supersedes_id,workflow_run_id)->hypotheses(id,workflow_run_id)",
      "hypothesis_evidence(hypothesis_id,workflow_run_id)->hypotheses(id,workflow_run_id)",
      "hypothesis_evidence(span_id,workflow_run_id)->evidence_spans(id,workflow_run_id)",
      "hypothesis_evidence(produced_by_step_id,workflow_run_id)->workflow_steps(id,workflow_run_id)",
      "hypothesis_evaluations(hypothesis_id,workflow_run_id)->hypotheses(id,workflow_run_id)",
      "hypothesis_evaluations(produced_by_step_id,workflow_run_id)->workflow_steps(id,workflow_run_id)",
      "evaluation_evidence(evaluation_id,workflow_run_id)->hypothesis_evaluations(id,workflow_run_id)",
      "evaluation_evidence(span_id,workflow_run_id)->evidence_spans(id,workflow_run_id)",
      "evaluation_evidence(produced_by_step_id,workflow_run_id)->workflow_steps(id,workflow_run_id)",
      "hypothesis_reviews(hypothesis_id,workflow_run_id)->hypotheses(id,workflow_run_id)",
      "hypothesis_reviews(produced_by_step_id,workflow_run_id)->workflow_steps(id,workflow_run_id)",
      "hypothesis_events(hypothesis_id,workflow_run_id)->hypotheses(id,workflow_run_id)",
      "hypothesis_events(evaluation_id,workflow_run_id)->hypothesis_evaluations(id,workflow_run_id)",
      "hypothesis_events(review_id,workflow_run_id)->hypothesis_reviews(id,workflow_run_id)",
    ];

    it("links every research record to its parents and its writing step through (id, workflow_run_id), and through nothing weaker", async () => {
      const rows = (await db.pool.query<{ fk: string; ref: string }>(
        `SELECT c.conrelid::regclass::text || '(' || (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) || ')->' ||
                c.confrelid::regclass::text || '(' || (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) || ')' AS fk,
                c.confrelid::regclass::text AS ref
         FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY($1::text[])`, [TABLES])).rows;
      const toRunScopedParents = rows.filter((row) => RUN_SCOPED.includes(row.ref)).map((row) => row.fk).sort();
      expect(toRunScopedParents).toEqual([...EXPECTED].sort());
    });

    it("keeps the producing step mandatory exactly where a deterministic act wrote the record", async () => {
      const nullable = (await db.pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
        `SELECT table_name, column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name IN ('produced_by_step_id','workflow_run_id') AND table_name = ANY($1::text[])`, [TABLES])).rows;
      const required = new Set(["repo_snapshots", "repo_snapshot_files", "hypothesis_evaluations", "evaluation_evidence"]);
      for (const row of nullable) {
        if (row.column_name === "workflow_run_id") expect(row.is_nullable, `${row.table_name}.workflow_run_id`).toBe("NO");
        else expect(row.is_nullable === "NO", `${row.table_name}.produced_by_step_id mandatory`).toBe(required.has(row.table_name));
      }
    });
  });

  describe("a worker holding a valid lease for one run cannot write against another run's records", () => {
    it("through the store: every write is refused and nothing is left behind", async () => {
      const { a, b, spanA, hypA } = await twoRuns();
      const building = await fx.store.createSnapshot(a.lease, { repository: "acme/building", commitSha: fx.commit() });
      const before = { spans: await count("evidence_spans"), files: await count("repo_snapshot_files"), hyps: await count("hypotheses"),
        evals: await count("hypothesis_evaluations"), reviews: await count("hypothesis_reviews"), events: await count("hypothesis_events") };
      const blob = await fx.store.putBlob(b.lease, Buffer.from("intruder"));

      await expect(fx.store.createEvidenceSpan(b.lease, { snapshotId: a.snapshotId, path: "contracts/Vault.sol", lineStart: 2, lineEnd: 2 })).rejects.toThrow(FK);
      await expect(fx.store.addSnapshotFiles(b.lease, building, [{ path: "i.sol", classification: "source", sizeBytes: blob.sizeBytes, blobSha256: blob.sha256 }])).rejects.toThrow(FK);
      await expect(fx.store.sealSnapshot(b.lease, building)).rejects.toThrow(/does not exist in this step's run/);
      await expect(fx.store.createHypothesis(b.lease, {
        snapshotId: a.snapshotId, family: "x-family", claim: "A claim by the wrong run's worker.", rationale: "r", generator: RULE, spans: [{ spanId: spanA, role: "primary" }] })).rejects.toThrow(FK);
      await expect(fx.evaluate(b, hypA, "inconclusive", [])).rejects.toThrow(FK);
      await expect(fx.store.recordReview({ kind: "step", lease: b.lease }, {
        hypothesisId: hypA, reviewerKind: "human", reviewerId: "zed", mode: "disclosed_adjudication", reviewerSaw: { ...BLINDED_SAW, generator_rationale: true },
        inputSha256: sha256Hex("q"), verdict: "supports", rationale: "r" })).rejects.toThrow(FK);

      expect({ spans: await count("evidence_spans"), files: await count("repo_snapshot_files"), hyps: await count("hypotheses"),
        evals: await count("hypothesis_evaluations"), reviews: await count("hypothesis_reviews"), events: await count("hypothesis_events") }).toEqual(before);
      expect((await fx.pool.query("SELECT sealed_at FROM repo_snapshots WHERE id = $1", [building])).rows[0]!.sealed_at).toBeNull();
    });

    it("operator reviews and withdrawals are recorded in the hypothesis's own run", async () => {
      const { a, hypA } = await twoRuns();
      const review = await fx.review(hypA, "alice");
      expect((await fx.pool.query("SELECT workflow_run_id, produced_by_step_id FROM hypothesis_reviews WHERE id = $1", [review])).rows[0]).toEqual({ workflow_run_id: a.runId, produced_by_step_id: null });
      await fx.store.withdraw("alice", hypA, "Run-scoped withdrawal.");
      expect((await fx.pool.query("SELECT DISTINCT workflow_run_id FROM hypothesis_events WHERE hypothesis_id = $1", [hypA])).rows).toEqual([{ workflow_run_id: a.runId }]);
      await expect(fx.store.withdraw("alice", "00000000-0000-4000-8000-000000000999", "A hypothesis that does not exist.")).rejects.toThrow(/does not exist/);
    });
  });

  describe("evaluation provenance", () => {
    it("records the run, the producing step and the evidence's run explicitly, all equal to the hypothesis's", async () => {
      const { a, hypA } = await twoRuns();
      const span = await fx.span(a, 6);
      const evaluation = await fx.evaluate(a, hypA, "weakens", [span]);
      const row = (await fx.pool.query("SELECT workflow_run_id, produced_by_step_id, hypothesis_id FROM hypothesis_evaluations WHERE id = $1", [evaluation])).rows[0]!;
      expect(row).toEqual({ workflow_run_id: a.runId, produced_by_step_id: a.lease.stepId, hypothesis_id: hypA });
      const hyp = (await fx.pool.query("SELECT workflow_run_id FROM hypotheses WHERE id = $1", [hypA])).rows[0]!;
      expect(hyp.workflow_run_id).toBe(row.workflow_run_id);
      expect((await fx.pool.query("SELECT workflow_run_id, produced_by_step_id FROM evaluation_evidence WHERE evaluation_id = $1", [evaluation])).rows).toEqual([{ workflow_run_id: a.runId, produced_by_step_id: a.lease.stepId }]);
      const event = (await fx.pool.query("SELECT workflow_run_id FROM hypothesis_events WHERE evaluation_id = $1", [evaluation])).rows[0]!;
      expect(event.workflow_run_id).toBe(a.runId);
    });

    it("keeps every record of one hypothesis in a single run", async () => {
      const { a, hypA } = await twoRuns();
      await fx.evaluate(a, hypA, "inconclusive", []);
      await fx.review(hypA, "alice");
      const runs = (await fx.pool.query(
        `SELECT DISTINCT run FROM (
           SELECT workflow_run_id AS run FROM hypotheses WHERE id = $1
           UNION ALL SELECT workflow_run_id FROM hypothesis_evidence WHERE hypothesis_id = $1
           UNION ALL SELECT workflow_run_id FROM hypothesis_evaluations WHERE hypothesis_id = $1
           UNION ALL SELECT workflow_run_id FROM hypothesis_reviews WHERE hypothesis_id = $1
           UNION ALL SELECT workflow_run_id FROM hypothesis_events WHERE hypothesis_id = $1) r`, [hypA])).rows;
      expect(runs).toEqual([{ run: a.runId }]);
    });
  });

  describe("hypothesis retries must be identical", () => {
    async function base(over: Record<string, unknown> = {}) {
      const ctx = await fx.sealedSnapshot();
      const span = await fx.span(ctx, 5);
      const second = await fx.span(ctx, 6);
      const input = {
        snapshotId: ctx.snapshotId, family: "solidity-low-level-call", claim: `Retry subject number ${fx.next()}.`, rationale: "The original rationale.",
        requiredChecks: ["trace the target"], alternativeExplanations: ["a guard exists"], generator: RULE,
        spans: [{ spanId: span, role: "primary" as const }, { spanId: second, role: "supporting" as const }], ...over,
      };
      const first = await fx.store.createHypothesis(ctx.lease, input);
      return { ctx, input, first, span, second };
    }

    it("returns the existing hypothesis for an identical retry", async () => {
      const { ctx, input, first } = await base();
      expect(first.created).toBe(true);
      expect(await fx.store.createHypothesis(ctx.lease, input)).toEqual({ id: first.id, created: false });
      expect(await fx.store.createHypothesis(ctx.lease, { ...input, spans: [...input.spans].reverse() })).toEqual({ id: first.id, created: false });
    });

    it("rejects a retry whose rationale, checks, alternatives, supersession, reservation or evidence roles changed", async () => {
      const { ctx, input, first, span } = await base();
      const attempt = (over: Record<string, unknown>) => fx.store.createHypothesis(ctx.lease, { ...input, ...over } as never);
      await expect(attempt({ rationale: "A rewritten rationale." })).rejects.toThrow(ResearchConflictError);
      await expect(attempt({ rationale: "A rewritten rationale." })).rejects.toThrow(/different rationale/);
      await expect(attempt({ requiredChecks: ["something else"] })).rejects.toThrow(/different required checks/);
      await expect(attempt({ alternativeExplanations: [] })).rejects.toThrow(/different alternative explanations/);
      await expect(attempt({ supersedesId: first.id })).rejects.toThrow(/different supersedes/);
      await expect(attempt({ generator: { ...RULE, reservationId: await fx.reservation() } })).rejects.toThrow(/different generator reservation|check constraint/);
      await expect(attempt({ spans: [{ spanId: span, role: "supporting" }, { spanId: input.spans[1]!.spanId, role: "primary" }] })).rejects.toThrow(/different evidence/);
      // the stored hypothesis is untouched by all of those attempts
      const row = (await fx.pool.query("SELECT rationale, required_checks, alternative_explanations, supersedes_id FROM hypotheses WHERE id = $1", [first.id])).rows[0]!;
      expect(row).toEqual({ rationale: "The original rationale.", required_checks: ["trace the target"], alternative_explanations: ["a guard exists"], supersedes_id: null });
      expect((await fx.pool.query("SELECT count(*)::int AS n FROM hypotheses WHERE snapshot_id = $1", [ctx.snapshotId])).rows[0]!.n).toBe(1);
    });

    it("treats a changed claim, family, generator version or evidence set as a different claim, not a retry", async () => {
      const { ctx, input, first, span } = await base();
      const ids = new Set([first.id]);
      for (const over of [{ claim: "A different claim entirely, with new words." }, { family: "access-control" },
        { generator: { ...RULE, version: "2" } }, { spans: [{ spanId: span, role: "primary" as const }] }]) {
        const made = await fx.store.createHypothesis(ctx.lease, { ...input, ...over });
        expect(made.created).toBe(true);
        ids.add(made.id);
      }
      expect(ids.size).toBe(5);
    });

    it("rejects a model retry that carries a different reservation", async () => {
      const ctx = await fx.sealedSnapshot();
      const span = await fx.span(ctx, 5);
      const reservation = await fx.reservation();
      const model = { kind: "model" as const, id: "provider/model", version: "p1", reservationId: reservation };
      const input = { snapshotId: ctx.snapshotId, family: "solidity-low-level-call", claim: "A model-generated claim for retry.", rationale: "r", generator: model, spans: [{ spanId: span, role: "primary" as const }] };
      const first = await fx.store.createHypothesis(ctx.lease, input);
      expect(await fx.store.createHypothesis(ctx.lease, input)).toEqual({ id: first.id, created: false });
      await expect(fx.store.createHypothesis(ctx.lease, { ...input, generator: { ...model, reservationId: await fx.reservation() } })).rejects.toThrow(/different generator reservation/);
    });
  });

  describe("manifest retries must be identical", () => {
    async function building() {
      const ctx = await fx.step();
      const snapshotId = await fx.store.createSnapshot(ctx.lease, { repository: "acme/retry", commitSha: fx.commit(), refName: "main", acquisitionReport: { files: 2 } });
      const a = await fx.store.putBlob(ctx.lease, Buffer.from("alpha"));
      const b = await fx.store.putBlob(ctx.lease, Buffer.from("beta!"));
      const rows = [
        { path: "src/A.sol", classification: "source", sizeBytes: a.sizeBytes, blobSha256: a.sha256 },
        { path: "big.bin", classification: "other", sizeBytes: 9_000_000, skipReason: "oversize" },
      ];
      await fx.store.addSnapshotFiles(ctx.lease, snapshotId, rows);
      return { ctx, snapshotId, a, b, rows };
    }

    it("accepts an identical retry before and after sealing, adding nothing", async () => {
      const { ctx, snapshotId, rows } = await building();
      await fx.store.addSnapshotFiles(ctx.lease, snapshotId, rows);
      await fx.store.sealSnapshot(ctx.lease, snapshotId);
      await fx.store.addSnapshotFiles(ctx.lease, snapshotId, rows); // a crashed step retried after sealing
      expect((await fx.pool.query("SELECT count(*)::int AS n FROM repo_snapshot_files WHERE snapshot_id = $1", [snapshotId])).rows[0]!.n).toBe(2);
    });

    it("rejects a retry that changes the blob, size, classification, git id or skipped/stored status of an existing row", async () => {
      const { ctx, snapshotId, a, b } = await building();
      const retry = (row: Record<string, unknown>) => fx.store.addSnapshotFiles(ctx.lease, snapshotId, [row as never]);
      await expect(retry({ path: "src/A.sol", classification: "source", sizeBytes: b.sizeBytes, blobSha256: b.sha256 })).rejects.toThrow(/different blob/);
      await expect(retry({ path: "src/A.sol", classification: "test", sizeBytes: a.sizeBytes, blobSha256: a.sha256 })).rejects.toThrow(/different classification/);
      await expect(retry({ path: "src/A.sol", classification: "source", sizeBytes: a.sizeBytes, blobSha256: a.sha256, gitBlobSha: "c".repeat(40) })).rejects.toThrow(/different git blob id/);
      await expect(retry({ path: "src/A.sol", classification: "source", sizeBytes: 77, skipReason: "binary" })).rejects.toThrow(ResearchConflictError);
      await expect(retry({ path: "big.bin", classification: "other", sizeBytes: 9_000_001, skipReason: "oversize" })).rejects.toThrow(/different size/);
      await expect(retry({ path: "big.bin", classification: "other", sizeBytes: 9_000_000, skipReason: "binary" })).rejects.toThrow(/different skip reason/);
      await expect(retry({ path: "big.bin", classification: "other", sizeBytes: a.sizeBytes, blobSha256: a.sha256 })).rejects.toThrow(ResearchConflictError);
      const stored = (await fx.pool.query("SELECT blob_sha256, classification, size_bytes FROM repo_snapshot_files WHERE snapshot_id = $1 AND path = 'src/A.sol'", [snapshotId])).rows[0]!;
      expect(stored).toEqual({ blob_sha256: a.sha256, classification: "source", size_bytes: String(a.sizeBytes) });
    });

    it("reports the conflict (not a sealing error) for a conflicting retry after sealing, and still refuses genuinely new files", async () => {
      const { ctx, snapshotId, a, b } = await building();
      await fx.store.sealSnapshot(ctx.lease, snapshotId);
      await expect(fx.store.addSnapshotFiles(ctx.lease, snapshotId, [{ path: "src/A.sol", classification: "source", sizeBytes: b.sizeBytes, blobSha256: b.sha256 }])).rejects.toThrow(ResearchConflictError);
      await expect(fx.store.addSnapshotFiles(ctx.lease, snapshotId, [{ path: "new.sol", classification: "source", sizeBytes: a.sizeBytes, blobSha256: a.sha256 }])).rejects.toThrow(/is sealed/);
    });

    it("applies a retry atomically: one conflicting row means none of the new rows are added", async () => {
      const { ctx, snapshotId, a, b } = await building();
      await expect(fx.store.addSnapshotFiles(ctx.lease, snapshotId, [
        { path: "fresh.sol", classification: "source", sizeBytes: a.sizeBytes, blobSha256: a.sha256 },
        { path: "src/A.sol", classification: "source", sizeBytes: b.sizeBytes, blobSha256: b.sha256 },
      ])).rejects.toThrow(ResearchConflictError);
      expect((await fx.pool.query("SELECT 1 FROM repo_snapshot_files WHERE snapshot_id = $1 AND path = 'fresh.sol'", [snapshotId])).rowCount).toBe(0);
    });

    it("rejects a request that lists one path twice with different content", async () => {
      const { ctx, snapshotId, a, b } = await building();
      await expect(fx.store.addSnapshotFiles(ctx.lease, snapshotId, [
        { path: "dup.sol", classification: "source", sizeBytes: a.sizeBytes, blobSha256: a.sha256 },
        { path: "dup.sol", classification: "source", sizeBytes: b.sizeBytes, blobSha256: b.sha256 },
      ])).rejects.toThrow(/listed twice with different content in one request/);
    });

    it("applies the same rule to a snapshot retry: same commit with a different ref or report is a conflict", async () => {
      const { ctx } = await building();
      const commit = fx.commit();
      const id = await fx.store.createSnapshot(ctx.lease, { repository: "acme/same", commitSha: commit, refName: "main", acquisitionReport: { n: 1 } });
      expect(await fx.store.createSnapshot(ctx.lease, { repository: "acme/same", commitSha: commit, refName: "main", acquisitionReport: { n: 1 } })).toBe(id);
      await expect(fx.store.createSnapshot(ctx.lease, { repository: "acme/same", commitSha: commit, refName: "dev", acquisitionReport: { n: 1 } })).rejects.toThrow(/different ref name/);
      await expect(fx.store.createSnapshot(ctx.lease, { repository: "acme/same", commitSha: commit, refName: "main", acquisitionReport: { n: 2 } })).rejects.toThrow(/different acquisition report/);
    });
  });

  async function textOf(snapshotId: string): Promise<string> {
    const row = (await fx.pool.query<{ content: Buffer }>(
      `SELECT b.content FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256
       WHERE f.snapshot_id = $1 AND f.path = 'contracts/Vault.sol'`, [snapshotId])).rows[0]!;
    return row.content.toString("utf8");
  }
});
