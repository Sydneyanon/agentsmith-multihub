import { describe, expect, it } from "vitest";
import { classifyStepError, LeaseLostError, StepError } from "./step-errors.js";
import { isWorkerApiRequest, TokenBucket } from "./worker-api.js";
import { RunTerminalError, WorkerApiClient, WorkerTokenRejectedError } from "./worker-api-client.js";
import { remoteStepKeys, remoteWorkerSettings } from "./worker-remote.js";
import { parseWorkerToken, redactWorkerTokens } from "./worker-tokens.js";

const TOKEN = `wct1_${"0123456789abcdef".repeat(2)}_${"Zz-_".repeat(10)}abc`;
const ok = { WORKER_STORE: "api", WORKER_API_URL: "http://agentsmith-api.internal:8081", WORKER_API_TOKEN: TOKEN };

describe("option D: remote worker settings", () => {
  it("accepts the opt-in settings and never echoes the token", () => {
    const s = remoteWorkerSettings(ok);
    expect(s.tokenId).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(parseWorkerToken(TOKEN)).toEqual({ tokenId: s.tokenId, secret: TOKEN.slice(38) });
  });
  it("refuses any database URL or libpq variable, by name or by value", () => {
    for (const extra of [{ DATABASE_URL: "postgres://x" }, { WORKER_DATABASE_URL: "x" }, { DIRECT_DATABASE_URL: "x" }, { PGHOST: "db" }, { PGPASSWORD: "p" }, { ANALYTICS_DB_URL: "x" }, { HARMLESS_NAME: "postgresql://u:p@h/d" }]) {
      expect(() => remoteWorkerSettings({ ...ok, ...extra }), JSON.stringify(extra)).toThrow(/database connection settings are present/);
    }
    try { remoteWorkerSettings({ ...ok, DATABASE_URL: "postgres://u:hunter2@h/d" }); } catch (e) { expect((e as Error).message).not.toContain("hunter2"); expect((e as Error).message).not.toContain(TOKEN); }
  });
  it("refuses a missing or malformed token, plaintext to public hosts and URLs carrying credentials", () => {
    expect(() => remoteWorkerSettings({ ...ok, WORKER_STORE: "db" })).toThrow(/WORKER_STORE=api/);
    expect(() => remoteWorkerSettings({ ...ok, WORKER_API_TOKEN: "abc" })).toThrow(/not a worker capability token/);
    expect(() => remoteWorkerSettings({ ...ok, WORKER_API_URL: "http://api.example.com" })).toThrow(/must be https/);
    expect(() => remoteWorkerSettings({ ...ok, WORKER_API_URL: "https://u:p@api.example.com" })).toThrow(/credentials/);
    expect(remoteWorkerSettings({ ...ok, WORKER_API_URL: "https://api.example.com" }).apiUrl).toBe("https://api.example.com/");
  });
  it("asks only for repository_research steps, gated by the same switches as the direct worker", () => {
    expect(remoteStepKeys({})).toEqual(["acquire_repository"]);
    expect(remoteStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", ENGINE_LOOP_ENABLED: "true" })).toEqual(["acquire_repository", "analyze_structure", "challenge_leads", "build_dossier"]);
  });
  it("redacts anything token-shaped", () => {
    expect(redactWorkerTokens(`failed with Bearer ${TOKEN} here`)).toBe("failed with Bearer wct1_[redacted] here");
  });
});

describe("option D: the operator bearer check delegates exactly the worker operation paths", () => {
  it("matches POST on exact operation paths only", () => {
    expect(isWorkerApiRequest("POST", "/internal/worker/v1/claim")).toBe(true);
    expect(isWorkerApiRequest("POST", "/internal/worker/v1/claim?x=1")).toBe(true);
    for (const [m, u] of [["GET", "/internal/worker/v1/claim"], ["POST", "/internal/worker/v1/claim/"], ["POST", "//internal/worker/v1/claim"], ["POST", "/internal/worker/v1/query"], ["POST", "/internal/worker/v1/"], ["POST", "/v1/research/overview"], ["POST", "/INTERNAL/worker/v1/claim"]] as const) {
      expect(isWorkerApiRequest(m, u), `${m} ${u}`).toBe(false);
    }
  });
  it("rate-limits per token", () => {
    let t = 0; const b = new TokenBucket(2, 3, () => t);
    expect([b.take("a"), b.take("a"), b.take("a")]).toEqual([0, 0, 0]);
    expect(b.take("a")).toBeGreaterThan(0); expect(b.take("b")).toBe(0);
    t += 1000; expect(b.take("a")).toBe(0);
  });
});

describe("option D: client failure semantics", () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const lease = { stepId: "00000000-0000-4000-8000-000000000001", workerId: "w" };
  it("retries transient failures with the SAME idempotency key, then succeeds", async () => {
    const keys: string[] = []; let n = 0;
    const c = new WorkerApiClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, sleep: async () => undefined, fetchImpl: async (_u, init) => {
      keys.push(String((init!.headers as Record<string, string>)["idempotency-key"])); n += 1;
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) return reply(503, { ok: false, error: "database_unavailable" });
      return reply(200, { ok: true, result: { sha256: "x", sizeBytes: 1 } });
    } });
    expect(await c.putBlob(lease, Buffer.from("x"))).toEqual({ sha256: "x", sizeBytes: 1 });
    expect(keys.length).toBe(3); expect(new Set(keys).size).toBe(1);
  });
  it("maps refusals: token -> stop, run finished -> stop, lease -> LeaseLostError; never puts the token in a message", async () => {
    const answer = (status: number, error: string) => new WorkerApiClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, fetchImpl: async () => reply(status, { ok: false, error, message: `echo ${TOKEN}` }) });
    await expect(answer(401, "token_revoked").claimNext(["acquire_repository"])).rejects.toBeInstanceOf(WorkerTokenRejectedError);
    await expect(answer(403, "run_terminal").claimNext(["acquire_repository"])).rejects.toBeInstanceOf(RunTerminalError);
    await expect(answer(409, "lease_not_held").putBlob(lease, Buffer.from("x"))).rejects.toBeInstanceOf(LeaseLostError);
    expect(await answer(409, "lease_not_held").heartbeat(lease.stepId)).toBe(false);
    const e = await answer(422, "rejected").putBlob(lease, Buffer.from("x")).catch((x: unknown) => x as Error);
    expect(classifyStepError(e).kind).toBe("permanent"); expect((e as Error).message).not.toContain(TOKEN.slice(38));
  });
  it("after exhausted retries the call is retryable and the step can no longer complete", async () => {
    let calls = 0;
    const c = new WorkerApiClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, attempts: 2, sleep: async () => undefined, fetchImpl: async () => { calls += 1; return reply(500, { ok: false, error: "internal_error" }); } });
    const e = await c.createEvidenceSpan(lease, { snapshotId: lease.stepId, path: "a.sol", lineStart: 1, lineEnd: 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StepError); expect(classifyStepError(e).kind).toBe("retryable");
    const before = calls;
    await expect(c.complete(lease.stepId, { status: "x" })).rejects.toThrow(/not completed/);
    expect(calls).toBe(before); // refused locally: nothing was sent
  });
});
