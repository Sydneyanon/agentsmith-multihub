import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LeaseLostError } from "../step-errors.js";
import { sha256Hex } from "../research-state.js";
import { assertIntegrationConfigured, expireLease, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";
import { BLINDED_SAW, FULL_SAW, ResearchFixture, VAULT } from "./research-helpers.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ALLOWED_STATUSES = [
  "unreviewed", "weakened_by_static_check", "contradicted_by_static_check", "supported_by_review", "rejected_by_review",
  "needs_more_evidence", "review_inconclusive", "reviews_disagree", "withdrawn",
];

describe.skipIf(skipIntegration)("research state: hypotheses, evaluations, reviews and derived status (real Postgres)", () => {
  let db: TestDatabase;
  let fx: ResearchFixture;
  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await migratedTestDatabase();
    fx = new ResearchFixture(db);
  });
  afterAll(async () => { await db?.drop(); });

  /** A sealed snapshot plus two spans, ready for hypotheses. */
  async function setup() {
    const ctx = await fx.sealedSnapshot();
    return { ...ctx, call: await fx.span(ctx, 5), update: await fx.span(ctx, 6), fn: await fx.span(ctx, 4, 7) };
  }

  describe("hypotheses", () => {
    it("registers a claim with evidence and provenance, and logs the registration event", async () => {
      const ctx = await setup();
      const made = await fx.store.createHypothesis(ctx.lease, {
        snapshotId: ctx.snapshotId, family: "solidity-low-level-call", claim: "The call precedes the balance update in withdraw().",
        rationale: "State is updated after control passes to the caller.", requiredChecks: ["Trace the target"], alternativeExplanations: ["A guard"],
        generator: { kind: "deterministic_rule", id: "rule-reentrancy", version: "1.2" },
        spans: [{ spanId: ctx.call, role: "primary" }, { spanId: ctx.update, role: "supporting" }],
      });
      expect(made.created).toBe(true);
      const row = (await fx.pool.query("SELECT * FROM hypotheses WHERE id = $1", [made.id])).rows[0]!;
      expect(row).toMatchObject({ generator_kind: "deterministic_rule", generator_id: "rule-reentrancy", generator_version: "1.2", snapshot_id: ctx.snapshotId, workflow_run_id: ctx.runId, produced_by_step_id: ctx.lease.stepId });
      expect(row.required_checks).toEqual(["Trace the target"]);
      const events = (await fx.pool.query("SELECT event_type, actor_kind, actor_id FROM hypothesis_events WHERE hypothesis_id = $1 ORDER BY seq", [made.id])).rows;
      expect(events).toEqual([{ event_type: "registered", actor_kind: "deterministic_rule", actor_id: "rule-reentrancy" }]);
      expect(await fx.status(made.id)).toMatchObject({ status: "unreviewed", static_outcome: "none", evaluations: 0, blinded_reviews: 0, adjudications: 0 });
    });

    it("is idempotent: retrying the same claim returns the existing hypothesis", async () => {
      const ctx = await setup();
      const input = {
        snapshotId: ctx.snapshotId, family: "solidity-low-level-call", claim: "A claim made twice for the same evidence.", rationale: "r",
        generator: { kind: "deterministic_rule" as const, id: "rule-x", version: "1" }, spans: [{ spanId: ctx.call, role: "primary" as const }],
      };
      const first = await fx.store.createHypothesis(ctx.lease, input);
      const again = await fx.store.createHypothesis(ctx.lease, input);
      expect(again).toEqual({ id: first.id, created: false });
      expect((await fx.pool.query("SELECT count(*)::int AS n FROM hypothesis_events WHERE hypothesis_id = $1", [first.id])).rows[0]!.n).toBe(1);
    });

    it("requires a primary evidence span by commit time, and leaves nothing behind when it is missing", async () => {
      const ctx = await setup();
      const before = Number((await fx.pool.query("SELECT count(*) FROM hypotheses")).rows[0]!.count);
      const attempt = (spans: Array<{ spanId: string; role: "primary" | "supporting" | "context" }>) => fx.store.createHypothesis(ctx.lease, {
        snapshotId: ctx.snapshotId, family: "solidity-low-level-call", claim: `No primary evidence, attempt ${fx.next()}.`, rationale: "r",
        generator: { kind: "deterministic_rule", id: "rule-x", version: "1" }, spans });
      await expect(attempt([])).rejects.toThrow(/at least one primary evidence span/);
      await expect(attempt([{ spanId: ctx.call, role: "supporting" }])).rejects.toThrow(/at least one primary evidence span/);
      expect(Number((await fx.pool.query("SELECT count(*) FROM hypotheses")).rows[0]!.count)).toBe(before);
    });

    it("accepts evidence only from its own snapshot, and at most 20 spans", async () => {
      const ctx = await setup();
      const other = await fx.sealedSnapshot();
      const foreign = await fx.span(other, 5);
      await expect(fx.hypothesis(ctx, [ctx.call, foreign])).rejects.toThrow(/different snapshot/);
      const longFile = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n");
      const big = await fx.sealedSnapshot({ "contracts/Vault.sol": longFile });
      const spans: string[] = [];
      for (let i = 1; i <= 21; i += 1) spans.push(await fx.span(big, i));
      await expect(fx.hypothesis(big, spans)).rejects.toThrow(/at most 20/);
      await expect(fx.hypothesis(big, spans.slice(0, 20))).resolves.toBeTruthy();
    });

    it("must be pinned to a sealed snapshot", async () => {
      const ctx = await setup();
      const building = await fx.store.createSnapshot(ctx.lease, { repository: "acme/building", commitSha: fx.commit() });
      await expect(fx.pool.query(
        `INSERT INTO hypotheses (workflow_run_id, snapshot_id, family, claim, rationale, generator_kind, generator_id, generator_version, claim_fingerprint)
         VALUES ($1,$2,'x-family','An unsealed snapshot cannot be cited.','r','human','alice','1',$3)`, [ctx.runId, building, sha256Hex("unsealed")])).rejects.toThrow(/sealed snapshot/);
    });

    it("ties a model generator to a gateway reservation, and forbids one on other generators", async () => {
      const ctx = await setup();
      const reservation = await fx.reservation();
      const model = { kind: "model" as const, id: "provider/model", version: "p1", reservationId: reservation };
      await expect(fx.hypothesis(ctx, [ctx.call], { generator: model })).resolves.toBeTruthy();
      await expect(fx.hypothesis(ctx, [ctx.call], { generator: { ...model, reservationId: undefined as never } })).rejects.toThrow(/check constraint/);
      await expect(fx.hypothesis(ctx, [ctx.call], { generator: { kind: "deterministic_rule", id: "r", version: "1", reservationId: reservation } })).rejects.toThrow(/check constraint/);
      await expect(fx.hypothesis(ctx, [ctx.call], { generator: { ...model, reservationId: "00000000-0000-4000-8000-000000000999" } })).rejects.toThrow(/foreign key/);
    });

    it("is never edited: corrections are new rows that point at the old one", async () => {
      const ctx = await setup();
      const original = await fx.hypothesis(ctx, [ctx.call]);
      await expect(fx.pool.query("UPDATE hypotheses SET claim = 'A rewritten claim goes here.' WHERE id = $1", [original])).rejects.toThrow(/append-only/);
      await expect(fx.pool.query("DELETE FROM hypotheses WHERE id = $1", [original])).rejects.toThrow(/append-only/);
      const made = await fx.store.createHypothesis(ctx.lease, {
        snapshotId: ctx.snapshotId, family: "solidity-low-level-call", claim: "A narrower claim replacing the earlier one.", rationale: "Refined.",
        generator: { kind: "human", id: "alice", version: "1" }, spans: [{ spanId: ctx.fn, role: "primary" }], supersedesId: original,
      });
      expect((await fx.pool.query("SELECT supersedes_id FROM hypotheses WHERE id = $1", [made.id])).rows[0]!.supersedes_id).toBe(original);
      expect((await fx.pool.query("SELECT claim FROM hypotheses WHERE id = $1", [original])).rows[0]!.claim).toContain("External call before");
    });

    it("has no stored status column anywhere", async () => {
      const columns = (await fx.pool.query(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('hypotheses','hypothesis_evaluations','hypothesis_reviews','hypothesis_evidence') AND column_name ~ 'status|state'")).rows;
      expect(columns).toEqual([]);
    });

    it("is refused once the step's lease has expired", async () => {
      const ctx = await setup();
      await expireLease(fx.pool, ctx.lease.stepId);
      await expect(fx.hypothesis(ctx, [ctx.call])).rejects.toBeInstanceOf(LeaseLostError);
    });
  });

  describe("deterministic evaluations (which may abstain)", () => {
    it("lets an evaluator abstain without citing anything, and logs it", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      const evaluation = await fx.evaluate(ctx, h, "inconclusive", []);
      expect(await fx.status(h)).toMatchObject({ status: "unreviewed", static_outcome: "inconclusive", evaluations: 1 });
      const event = (await fx.pool.query("SELECT event_type, actor_kind, actor_id, evaluation_id FROM hypothesis_events WHERE hypothesis_id = $1 AND event_type = 'evaluation_recorded'", [h])).rows[0]!;
      expect(event).toMatchObject({ actor_kind: "deterministic_rule", actor_id: "eval-a", evaluation_id: evaluation });
    });

    it("requires a cited span for supports, weakens and contradicts, and rolls back otherwise", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      for (const outcome of ["supports", "weakens", "contradicts"] as const) {
        await expect(fx.evaluate(ctx, h, outcome, []), outcome).rejects.toThrow(/must cite at least one evidence span/);
      }
      expect((await fx.pool.query("SELECT count(*)::int AS n FROM hypothesis_evaluations WHERE hypothesis_id = $1", [h])).rows[0]!.n).toBe(0);
    });

    it("cannot cite evidence from another snapshot", async () => {
      const ctx = await setup();
      const other = await fx.sealedSnapshot();
      const foreign = await fx.span(other, 5);
      const h = await fx.hypothesis(ctx, [ctx.call]);
      await expect(fx.evaluate(ctx, h, "weakens", [foreign])).rejects.toThrow(/different snapshot/);
    });

    it("is always a deterministic act: an evaluation can never be attributed to a model or a human", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      for (const actor of ["model", "human"]) {
        await expect(fx.pool.query(
          "INSERT INTO hypothesis_evaluations (hypothesis_id, actor_kind, evaluator_id, evaluator_version, outcome, rationale, input_sha256) VALUES ($1,$2,'e','1','inconclusive','r',$3)",
          [h, actor, sha256Hex(actor)])).rejects.toThrow(/check constraint/);
      }
    });

    it("is immutable", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      const id = await fx.evaluate(ctx, h, "weakens", [ctx.fn]);
      await expect(fx.pool.query("UPDATE hypothesis_evaluations SET outcome = 'supports' WHERE id = $1", [id])).rejects.toThrow(/append-only/);
      await expect(fx.pool.query("DELETE FROM evaluation_evidence WHERE evaluation_id = $1", [id])).rejects.toThrow(/append-only/);
    });
  });

  describe("reviews: mode and what the reviewer saw", () => {
    it("records a blinded independent assessment with exactly what was shown", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call], { generator: { kind: "deterministic_rule", id: "rule-x", version: "1" } });
      const id = await fx.review(h, "alice", "supports", "blinded_independent_assessment");
      const row = (await fx.pool.query("SELECT * FROM hypothesis_reviews WHERE id = $1", [id])).rows[0]!;
      expect(row).toMatchObject({ reviewer_kind: "human", reviewer_id: "alice", review_mode: "blinded_independent_assessment", reviewer_saw: BLINDED_SAW, verdict: "supports" });
      expect(await fx.status(h)).toMatchObject({ status: "supported_by_review", blinded_reviews: 1, adjudications: 0 });
    });

    it("records a disclosed adjudication separately from a blinded assessment", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      await fx.review(h, "alice", "rejects", "disclosed_adjudication");
      expect(await fx.status(h)).toMatchObject({ status: "rejected_by_review", blinded_reviews: 0, adjudications: 1 });
      const saw = (await fx.pool.query("SELECT reviewer_saw FROM hypothesis_reviews WHERE hypothesis_id = $1", [h])).rows[0]!.reviewer_saw;
      expect(saw).toEqual(FULL_SAW);
    });

    it("rejects a blinded review that saw anything of the generator's conclusion", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      const attempt = (saw: Record<string, unknown>) => fx.pool.query(
        `INSERT INTO hypothesis_reviews (hypothesis_id, reviewer_kind, reviewer_id, review_mode, reviewer_saw, input_sha256, verdict, rationale)
         VALUES ($1,'human','bob','blinded_independent_assessment',$2::jsonb,$3,'supports','r')`, [h, JSON.stringify(saw), sha256Hex("x")]);
      for (const leak of ["generator_rationale", "generator_identity", "prior_evaluations", "prior_reviews"]) {
        await expect(attempt({ ...BLINDED_SAW, [leak]: true }), leak).rejects.toThrow(/check constraint/);
      }
      await expect(attempt({ ...BLINDED_SAW, claim: false })).rejects.toThrow(/check constraint/);
      await expect(attempt({ ...BLINDED_SAW, evidence_spans: false })).rejects.toThrow(/check constraint/);
      await expect(attempt(BLINDED_SAW)).resolves.toBeTruthy();
    });

    it("requires reviewer_saw to be exactly the six boolean facts", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      const attempt = (saw: unknown) => fx.pool.query(
        `INSERT INTO hypothesis_reviews (hypothesis_id, reviewer_kind, reviewer_id, review_mode, reviewer_saw, input_sha256, verdict, rationale)
         VALUES ($1,'human','carol','disclosed_adjudication',$2::jsonb,$3,'supports','r')`, [h, JSON.stringify(saw), sha256Hex("y")]);
      const { claim, ...missing } = FULL_SAW;
      void claim;
      await expect(attempt(missing)).rejects.toThrow(/check constraint/);
      await expect(attempt({ ...FULL_SAW, extra: true })).rejects.toThrow(/check constraint/);
      await expect(attempt({ ...FULL_SAW, claim: "yes" })).rejects.toThrow(/check constraint/);
      await expect(attempt([true, true])).rejects.toThrow(/check constraint/);
      await expect(attempt(FULL_SAW)).resolves.toBeTruthy();
    });

    it("never lets the generator give a blinded assessment of its own claim", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call], { generator: { kind: "human", id: "alice", version: "1" } });
      await expect(fx.review(h, "alice", "supports", "blinded_independent_assessment")).rejects.toThrow(/cannot be made by the actor that generated/);
      await expect(fx.review(h, "alice", "supports", "disclosed_adjudication")).resolves.toBeTruthy(); // recorded as what it is
      await expect(fx.review(h, "bob", "supports", "blinded_independent_assessment")).resolves.toBeTruthy();
    });

    it("allows model reviews only as blinded assessments carrying a gateway reservation", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      const reservation = await fx.reservation();
      const modelReview = (over: Record<string, unknown> = {}) => fx.store.recordReview({ kind: "step", lease: ctx.lease }, {
        hypothesisId: h, reviewerKind: "model", reviewerId: "provider/reviewer", mode: "blinded_independent_assessment", reviewerSaw: BLINDED_SAW,
        inputSha256: sha256Hex(`m${fx.next()}`), verdict: "inconclusive", rationale: "r",
        model: { provider: "provider", name: "reviewer", promptVersion: "p1", reservationId: reservation }, ...over } as never);
      await expect(modelReview()).resolves.toBeTruthy();
      await expect(modelReview({ model: undefined })).rejects.toThrow(/check constraint/);
      await expect(modelReview({ mode: "disclosed_adjudication", reviewerSaw: FULL_SAW })).rejects.toThrow(/check constraint/);
      await expect(fx.store.recordReview({ kind: "operator", operatorId: "alice" }, {
        hypothesisId: h, reviewerKind: "human", reviewerId: "alice", mode: "blinded_independent_assessment", reviewerSaw: BLINDED_SAW,
        inputSha256: sha256Hex("h"), verdict: "supports", rationale: "r",
        model: { provider: "p", name: "n", promptVersion: "v", reservationId: reservation } })).rejects.toThrow(/check constraint/);
    });

    it("is refused for a step review after the lease expires, and reviews are immutable", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      const id = await fx.review(h, "alice");
      await expect(fx.pool.query("UPDATE hypothesis_reviews SET verdict = 'rejects' WHERE id = $1", [id])).rejects.toThrow(/append-only/);
      await expect(fx.pool.query("DELETE FROM hypothesis_reviews WHERE id = $1", [id])).rejects.toThrow(/append-only/);
      await expireLease(fx.pool, ctx.lease.stepId);
      await expect(fx.store.recordReview({ kind: "step", lease: ctx.lease }, {
        hypothesisId: h, reviewerKind: "human", reviewerId: "dave", mode: "disclosed_adjudication", reviewerSaw: FULL_SAW,
        inputSha256: sha256Hex("z"), verdict: "supports", rationale: "r" })).rejects.toBeInstanceOf(LeaseLostError);
    });
  });

  describe("events: the authoritative history", () => {
    it("cannot be inserted directly except for a human withdrawal", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      const evaluation = await fx.evaluate(ctx, h, "inconclusive", [], "eval-b");
      await expect(fx.pool.query("INSERT INTO hypothesis_events (hypothesis_id, event_type, actor_kind, actor_id) VALUES ($1,'registered','human','mallory')", [h])).rejects.toThrow(/created by recording the underlying record/);
      await expect(fx.pool.query("INSERT INTO hypothesis_events (hypothesis_id, event_type, actor_kind, actor_id, review_id) VALUES ($1,'review_recorded','human','forged',$2)", [h, await fx.review(h, "alice")])).rejects.toThrow(/created by recording the underlying record/);
      await expect(fx.pool.query("INSERT INTO hypothesis_events (hypothesis_id, event_type, actor_kind, actor_id, evaluation_id) VALUES ($1,'evaluation_recorded','deterministic_rule','forged',$2)", [h, evaluation])).rejects.toThrow(/created by recording the underlying record/);
      await expect(fx.store.withdraw("alice", h, "no")).rejects.toThrow(/check constraint/); // reason too short
    });

    it("records a withdrawal once, by a human with a reason, and never edits history", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      await fx.store.withdraw("alice", h, "Superseded by a narrower claim.");
      expect(await fx.status(h)).toMatchObject({ status: "withdrawn", withdrawn: true });
      await expect(fx.store.withdraw("alice", h, "Withdrawing again.")).rejects.toThrow(/duplicate key/);
      await expect(fx.pool.query("INSERT INTO hypothesis_events (hypothesis_id, event_type, actor_kind, actor_id, reason) VALUES ($1,'withdrawn','model','bot','Models cannot withdraw.')", [h])).rejects.toThrow(/check constraint/);
      await expect(fx.pool.query("UPDATE hypothesis_events SET reason = 'edited reason' WHERE hypothesis_id = $1", [h])).rejects.toThrow(/append-only/);
      await expect(fx.pool.query("DELETE FROM hypothesis_events WHERE hypothesis_id = $1", [h])).rejects.toThrow(/append-only/);
    });

    it("keeps one total order across records", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      await fx.evaluate(ctx, h, "weakens", [ctx.fn]);
      await fx.review(h, "alice", "supports");
      await fx.store.withdraw("alice", h, "Done with this one.");
      const types = (await fx.pool.query("SELECT event_type FROM hypothesis_events WHERE hypothesis_id = $1 ORDER BY seq", [h])).rows.map((r) => r.event_type);
      expect(types).toEqual(["registered", "evaluation_recorded", "review_recorded", "withdrawn"]);
      expect(Number((await fx.status(h)).last_event_seq)).toBeGreaterThan(0);
    });
  });

  describe("derived status", () => {
    it("derives each status from the event history", async () => {
      const ctx = await setup();
      const seen = new Set<string>();
      const status = async (h: string) => { const s = (await fx.status(h)).status as string; seen.add(s); return s; };

      const fresh = await fx.hypothesis(ctx, [ctx.call]);
      expect(await status(fresh)).toBe("unreviewed");

      const weak = await fx.hypothesis(ctx, [ctx.call]);
      await fx.evaluate(ctx, weak, "weakens", [ctx.fn]);
      expect(await status(weak)).toBe("weakened_by_static_check");
      await fx.evaluate(ctx, weak, "contradicts", [ctx.fn], "eval-b");
      expect(await status(weak)).toBe("contradicted_by_static_check");
      await fx.evaluate(ctx, weak, "inconclusive", [], "eval-b"); // eval-b abstains on re-evaluation
      expect(await status(weak)).toBe("weakened_by_static_check"); // only eval-a still weakens
      await fx.evaluate(ctx, weak, "supports", [ctx.fn], "eval-a");
      expect(await status(weak)).toBe("unreviewed");
      expect((await fx.status(weak)).static_outcome).toBe("supports");

      for (const [verdict, expected] of [["supports", "supported_by_review"], ["rejects", "rejected_by_review"], ["needs_more_evidence", "needs_more_evidence"], ["inconclusive", "review_inconclusive"]] as const) {
        const h = await fx.hypothesis(ctx, [ctx.call]);
        await fx.review(h, "alice", verdict);
        expect(await status(h), verdict).toBe(expected);
      }

      const disputed = await fx.hypothesis(ctx, [ctx.call]);
      await fx.review(disputed, "alice", "supports");
      await fx.review(disputed, "bob", "rejects");
      expect(await status(disputed)).toBe("reviews_disagree");
      await fx.review(disputed, "alice", "rejects"); // alice's latest verdict now matches bob's
      expect(await status(disputed)).toBe("rejected_by_review");

      const gone = await fx.hypothesis(ctx, [ctx.call]);
      await fx.review(gone, "alice", "supports");
      await fx.store.withdraw("alice", gone, "Withdrawn after discussion.");
      expect(await status(gone)).toBe("withdrawn");

      expect([...seen].sort()).toEqual([...ALLOWED_STATUSES].sort());
      expect(seen.has("verified")).toBe(false);
    });

    it("never lets a review erase contrary static evidence: it flags the conflict", async () => {
      const ctx = await setup();
      const h = await fx.hypothesis(ctx, [ctx.call]);
      await fx.evaluate(ctx, h, "weakens", [ctx.fn]);
      await fx.review(h, "alice", "supports");
      expect(await fx.status(h)).toMatchObject({ status: "supported_by_review", static_outcome: "weakens", static_conflicts_with_review: true });
      const calm = await fx.hypothesis(ctx, [ctx.call]);
      await fx.review(calm, "alice", "supports");
      expect((await fx.status(calm)).static_conflicts_with_review).toBe(false);
    });

    it("never produces a status outside the documented vocabulary, whatever the history", async () => {
      const all = (await fx.pool.query("SELECT DISTINCT status FROM hypothesis_status")).rows.map((r) => r.status as string);
      expect(all.length).toBeGreaterThan(0);
      for (const status of all) expect(ALLOWED_STATUSES).toContain(status);
      expect(all).not.toContain("verified");
    });
  });

  it("cites real text: a hypothesis's evidence resolves to the lines it claims", async () => {
    const ctx = await setup();
    const h = await fx.hypothesis(ctx, [ctx.call, ctx.update]);
    const spans = (await fx.pool.query("SELECT span_id, role FROM hypothesis_evidence WHERE hypothesis_id = $1 ORDER BY role", [h])).rows;
    expect(spans.map((s) => s.role)).toEqual(["primary", "supporting"]);
    const texts = [];
    for (const span of spans) texts.push((await fx.store.resolveSpan(span.span_id)) as { ok: true; text: string });
    expect(texts.every((t) => t.ok)).toBe(true);
    expect(texts.map((t) => t.text.trim())).toEqual([VAULT.split("\n")[4]!.trim(), VAULT.split("\n")[5]!.trim()]);
  });
});
