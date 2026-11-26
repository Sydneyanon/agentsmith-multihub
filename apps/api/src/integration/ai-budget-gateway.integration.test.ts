import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiBudgetGateway, type ModelAdapter } from "../ai-budget-gateway.js";
import { migratedTestDatabase, seedRun, skipIntegration, type TestDatabase } from "./harness.js";

/**
 * The AI budget gateway against real Postgres, with a local fake adapter (no provider, no network, no spend).
 * Added by the independent review: this write path was not covered by any integration test, so the least-privilege role
 * (TEST_RUNTIME_ROLE=1) had never been shown to support it.
 */
describe.skipIf(skipIntegration)("AI budget gateway over real Postgres", () => {
  let db: TestDatabase; let runId: string;
  beforeAll(async () => {
    db = await migratedTestDatabase();
    ({ runId } = await seedRun(db.pool, ["gateway_probe"]));
    await db.ownerPool.query(
      `INSERT INTO ai_model_prices (provider, model, price_version, input_usd_per_million_tokens, output_usd_per_million_tokens,
         max_input_tokens, max_output_tokens, enabled, reviewed_by, reviewed_at)
       VALUES ('fake','fake-model','v1', 1, 4, 1000, 500, true, 'test-reviewer', now())`);
  });
  afterAll(async () => { await db?.drop(); });

  const adapter = (generate: ModelAdapter["generate"]): ModelAdapter => ({ provider: "fake", model: "fake-model", generate });

  it("reserves, calls the adapter, settles actual cost and records usage", async () => {
    const gateway = new AiBudgetGateway(db.pool, false);
    const result = await gateway.execute({
      task: "classify", workflowRunId: runId, promptVersion: "p1", request: { system: "s", user: "u" },
      adapter: adapter(async () => ({ text: "ok", inputTokens: 100, outputTokens: 50 })),
    });
    expect(result.status).toBe("completed");
    const res = await db.ownerPool.query("SELECT status FROM ai_budget_reservations WHERE id = $1", [(result as { reservationId: string }).reservationId]);
    expect(res.rows[0]!.status).toBe("reconciled");
    expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM model_usage_events")).rows[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it("charges the full reservation when the provider call fails, and rethrows", async () => {
    const gateway = new AiBudgetGateway(db.pool, false);
    await expect(gateway.execute({
      task: "classify", workflowRunId: runId, promptVersion: "p1", request: { system: "s", user: "u" },
      adapter: adapter(async () => { throw new Error("provider exploded"); }),
    })).rejects.toThrow("provider exploded");
    const rows = await db.ownerPool.query("SELECT status FROM ai_budget_reservations ORDER BY created_at");
    expect(rows.rows.map((r) => r.status)).toContain("failed_charged");
  });

  it("blocks without a reviewed price and under the emergency stop, writing nothing", async () => {
    const gateway = new AiBudgetGateway(db.pool, false);
    const before = (await db.ownerPool.query("SELECT count(*)::int AS n FROM ai_budget_reservations")).rows[0]!.n;
    const noPrice = await gateway.execute({ task: "classify", workflowRunId: runId, promptVersion: "p1", request: { system: "s", user: "u" },
      adapter: { provider: "fake", model: "unpriced", generate: async () => ({ text: "x", inputTokens: 1, outputTokens: 1 }) } });
    expect(noPrice).toMatchObject({ status: "blocked", reason: "reviewed_model_price_unavailable" });
    const stopped = await new AiBudgetGateway(db.pool, true).execute({ task: "classify", workflowRunId: runId, promptVersion: "p1", request: { system: "s", user: "u" },
      adapter: adapter(async () => ({ text: "x", inputTokens: 1, outputTokens: 1 })) });
    expect(stopped).toMatchObject({ status: "blocked", reason: "global_emergency_stop" });
    expect((await db.ownerPool.query("SELECT count(*)::int AS n FROM ai_budget_reservations")).rows[0]!.n).toBe(before);
  });
});
