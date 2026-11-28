import { describe, expect, it } from "vitest";
import { classifyStepError, LeaseLostError, StepError } from "./step-errors.js";
import { asRefusal, COMPLETE_SCHEMAS, isWorkerApiRequest, OPERATIONS, TokenBucket } from "./worker-api.js";
import { derivedIdempotencyKey, RunTerminalError, WorkerApiClient, WorkerApiRefusedError, WorkerTokenRejectedError } from "./worker-api-client.js";
import { remoteStepKeys, remoteWorkerSettings } from "./worker-remote.js";
import { parseWorkerToken, redactWorkerTokens } from "./worker-tokens.js";

const TOKEN = `wct1_${"0123456789abcdef".repeat(2)}_${"Zz-_".repeat(10)}abc`;
const ok = { WORKER_STORE: "api", WORKER_API_URL: "http://agentsmith-api.internal:8081", WORKER_API_TOKEN_FILE: "/run/secrets/worker-token" };
/** D6: the token comes from a file (or stdin); these fakes stand in for the filesystem */
const files = (content: Record<string, string>) => { const removed: string[] = []; return { removed, io: { readFile: (p: string) => { if (!(p in content)) throw Object.assign(new Error("nope"), { code: "ENOENT" }); return content[p]!; }, unlink: (p: string) => { removed.push(p); } } }; };
const fromFile = (env: Record<string, string | undefined>, token = `${TOKEN}\n`) => remoteWorkerSettings(env, files({ "/run/secrets/worker-token": token }).io);

describe("option D: remote worker settings", () => {
  it("accepts the opt-in settings with the token in a FILE, unlinks it, and never echoes the token", () => {
    const f = files({ "/run/secrets/worker-token": `${TOKEN}\n` });
    const s = remoteWorkerSettings(ok, f.io);
    expect(s.tokenId).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(s.token).toBe(TOKEN); expect(s.tokenSource).toBe("file");
    expect(f.removed).toEqual(["/run/secrets/worker-token"]); expect(s.tokenFileRemoved).toBe(true);
    expect(parseWorkerToken(TOKEN)).toEqual({ tokenId: s.tokenId, secret: TOKEN.slice(38) });
    // a read-only secret mount cannot be unlinked: the start continues, and says so
    expect(remoteWorkerSettings(ok, { readFile: () => TOKEN, unlink: () => { throw new Error("EROFS"); } }).tokenFileRemoved).toBe(false);
  });
  it("D6: reads the token from stdin with WORKER_API_TOKEN_FILE=-", () => {
    const s = remoteWorkerSettings({ ...ok, WORKER_API_TOKEN_FILE: "-" }, { readStdin: () => `${TOKEN}\n` });
    expect([s.token, s.tokenSource, s.tokenFileRemoved]).toEqual([TOKEN, "stdin", null]);
  });
  it("D6: REFUSES to start when WORKER_API_TOKEN is set in the environment (even with a file), without echoing it", () => {
    for (const value of [TOKEN, "", "x"]) {
      let message = "";
      try { fromFile({ ...ok, WORKER_API_TOKEN: value }); } catch (e) { message = (e as Error).message; }
      expect(message, JSON.stringify(value)).toMatch(/WORKER_API_TOKEN is set in the environment/);
      expect(message).not.toContain(TOKEN.slice(38));
    }
    expect(() => remoteWorkerSettings({ WORKER_STORE: "api", WORKER_API_URL: ok.WORKER_API_URL }, files({}).io)).toThrow(/WORKER_API_TOKEN_FILE is required/);
    expect(() => remoteWorkerSettings(ok, files({}).io)).toThrow(/could not be read from WORKER_API_TOKEN_FILE \(ENOENT\)/);
  });
  it("D6: REFUSES to start when the token is present in the environment under ANY name (e.g. a platform secret export), naming the variable only", () => {
    let message = "";
    try { fromFile({ ...ok, WORKER_RUN_TOKEN: TOKEN }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/also present in the environment as WORKER_RUN_TOKEN/);
    expect(message).not.toContain(TOKEN.slice(10));
    expect(() => fromFile({ ...ok, UNRELATED: "something else" })).not.toThrow();
  });
  it("refuses any database URL or libpq variable, by name or by value", () => {
    for (const extra of [{ DATABASE_URL: "postgres://x" }, { WORKER_DATABASE_URL: "x" }, { DIRECT_DATABASE_URL: "x" }, { PGHOST: "db" }, { PGPASSWORD: "p" }, { ANALYTICS_DB_URL: "x" }, { HARMLESS_NAME: "postgresql://u:p@h/d" }]) {
      expect(() => fromFile({ ...ok, ...extra }), JSON.stringify(extra)).toThrow(/database connection settings are present/);
    }
    try { fromFile({ ...ok, DATABASE_URL: "postgres://u:hunter2@h/d" }); } catch (e) { expect((e as Error).message).not.toContain("hunter2"); expect((e as Error).message).not.toContain(TOKEN); }
  });
  it("refuses a missing or malformed token, plaintext to public hosts and URLs carrying credentials", () => {
    expect(() => fromFile({ ...ok, WORKER_STORE: "db" })).toThrow(/WORKER_STORE=api/);
    expect(() => fromFile(ok, "abc")).toThrow(/not hold a worker capability token/);
    expect(() => fromFile({ ...ok, WORKER_API_URL: "http://api.example.com" })).toThrow(/must be https/);
    expect(() => fromFile({ ...ok, WORKER_API_URL: "https://u:p@api.example.com" })).toThrow(/credentials/);
    expect(fromFile({ ...ok, WORKER_API_URL: "https://api.example.com" }).apiUrl).toBe("https://api.example.com/");
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

describe("option D: D7 derived idempotency keys and D4 final refusals", () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const step = { id: "00000000-0000-4000-8000-000000000001", attempt: 2 };
  it("derives the same key for the same (step, attempt, operation, body) in a NEW client (a restarted worker), and a different one per attempt", async () => {
    const seen: string[] = [];
    const mk = () => { const c = new WorkerApiClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, fetchImpl: async (_u, init) => { seen.push(String((init!.headers as Record<string, string>)["idempotency-key"])); return reply(200, { ok: true, result: { sha256: "x", sizeBytes: 1 } }); } }); c.adoptStep(step); return c; };
    await mk().putBlob({ stepId: step.id, workerId: "w" }, Buffer.from("same bytes"));
    await mk().putBlob({ stepId: step.id, workerId: "w" }, Buffer.from("same bytes"));
    await mk().putBlob({ stepId: step.id, workerId: "w" }, Buffer.from("other bytes"));
    expect(seen[0]).toBe(seen[1]); expect(seen[2]).not.toBe(seen[0]);
    expect(seen[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(derivedIdempotencyKey(step.id, 2, "put_blob", { a: 1 })).not.toBe(derivedIdempotencyKey(step.id, 3, "put_blob", { a: 1 }));
    expect(derivedIdempotencyKey(step.id, 2, "put_blob", { a: 1 })).not.toBe(derivedIdempotencyKey(step.id, 2, "complete", { a: 1 }));
  });
  it("a quota refusal is final even as 429: never retried, permanent for the loop", async () => {
    for (const [status, error] of [[429, "read_quota_exceeded"], [429, "processing_budget_exhausted"], [413, "storage_quota_exceeded"], [413, "processing_limit_exceeded"]] as const) {
      let calls = 0;
      const c = new WorkerApiClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, attempts: 5, sleep: async () => undefined, fetchImpl: async () => { calls += 1; return reply(status, { ok: false, error, message: "no" }); } });
      const e = await c.putBlob({ stepId: step.id, workerId: "w" }, Buffer.from("x")).catch((x: unknown) => x);
      expect(e, error).toBeInstanceOf(WorkerApiRefusedError); expect(calls, error).toBe(1); expect(classifyStepError(e).kind).toBe("permanent");
    }
  });
  it("reports the run's status on run_terminal, so a cancelled run stops the worker with its own exit code", async () => {
    const c = new WorkerApiClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, fetchImpl: async () => reply(403, { ok: false, error: "run_terminal", run_status: "cancelled" }) });
    const e = await c.claimNext(["acquire_repository"]).catch((x: unknown) => x as RunTerminalError);
    expect(e).toBeInstanceOf(RunTerminalError); expect((e as RunTerminalError).runStatus).toBe("cancelled");
  });
});

describe("option D: D5 refusal mapping and D1/D3 surface", () => {
  it("maps pool and connect timeouts to a RETRYABLE 503 before the generic 'rejected' mapping (they are plain Errors)", () => {
    for (const m of ["timeout exceeded when trying to connect", "Connection terminated unexpectedly", "connect ECONNREFUSED 127.0.0.1:5432"]) {
      const r = asRefusal(new Error(m)); expect([r.status, r.code], m).toEqual([503, "database_unavailable"]);
    }
    expect(asRefusal(new Error("some validation message")).status).toBe(422);
    expect(asRefusal(new TypeError("x")).status).toBe(500);
  });
  it("D1: record_evaluation exists only to be refused; D3: every research step key has a strict completion schema", async () => {
    await expect(OPERATIONS.record_evaluation!.run({} as never, {}, null)).rejects.toMatchObject({ status: 403, code: "evaluations_are_api_derived" });
    expect(Object.keys(COMPLETE_SCHEMAS).sort()).toEqual(["acquire_repository", "analyze_structure", "build_dossier", "challenge_leads", "slither_scan"]);
    const snap = "00000000-0000-4000-8000-000000000001";
    for (const key of ["analyze_structure", "challenge_leads", "build_dossier"]) {
      expect(COMPLETE_SCHEMAS[key]!.safeParse({ status: { analyze_structure: "structure_analyzed", challenge_leads: "leads_challenged", build_dossier: "dossier_built" }[key], snapshot_id: snap }).success, key).toBe(true);
      expect(COMPLETE_SCHEMAS[key]!.safeParse({ status: "x", snapshot_id: snap, authorization_status: "authorized" }).success, key).toBe(false);
    }
  });
});

