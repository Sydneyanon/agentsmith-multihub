import { describe, expect, it } from "vitest";
import { LeaseLostError, StepError, classifyStepError, httpStatusError } from "./step-errors.js";

const resp = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });

describe("httpStatusError", () => {
  it("treats 5xx, 408 and 429 as retryable", () => {
    for (const status of [500, 502, 503, 408, 429]) expect(httpStatusError("GitHub API", resp(status)).retryable).toBe(true);
  });

  it("treats 404, 401 and a plain 403 as permanent", () => {
    for (const status of [404, 401, 403, 422]) expect(httpStatusError("GitHub API", resp(status)).retryable).toBe(false);
  });

  it("treats a 403 as a retryable rate limit only with rate-limit evidence", () => {
    expect(httpStatusError("GitHub API", resp(403, { "retry-after": "30" }))).toMatchObject({ retryable: true, retryAfterSeconds: 30 });
    expect(httpStatusError("GitHub API", resp(403, { "x-ratelimit-remaining": "0" })).retryable).toBe(true);
    expect(httpStatusError("GitHub API", resp(403, { "x-ratelimit-remaining": "12" })).retryable).toBe(false);
  });

  it("derives the wait from the rate-limit reset and caps it", () => {
    const reset = String(Math.floor(Date.now() / 1000) + 90);
    const waited = httpStatusError("GitHub API", resp(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }));
    expect(waited.retryAfterSeconds).toBeGreaterThan(80);
    expect(waited.retryAfterSeconds).toBeLessThanOrEqual(90);
    expect(httpStatusError("GitHub API", resp(429, { "retry-after": "99999" })).retryAfterSeconds).toBe(300);
  });

  it("keeps the original message wording", () => {
    expect(httpStatusError("Raw GitHub", resp(503), " for README.md").message).toBe("Raw GitHub returned HTTP 503 for README.md");
  });
});

describe("classifyStepError", () => {
  it("identifies lease loss separately from failures", () => {
    expect(classifyStepError(new LeaseLostError("Step lease lost"))).toEqual({ kind: "lease_lost" });
  });

  it("honours explicit StepError retry semantics", () => {
    expect(classifyStepError(new StepError("x", true, 12))).toEqual({ kind: "retryable", category: "upstream_http", retryAfterSeconds: 12 });
    expect(classifyStepError(new StepError("x", false))).toEqual({ kind: "permanent", category: "upstream_http" });
  });

  it("treats connection-level database and network errors as retryable", () => {
    expect(classifyStepError(Object.assign(new Error("boom"), { code: "57P01" })).kind).toBe("retryable");
    expect(classifyStepError(Object.assign(new Error("boom"), { code: "08006" })).kind).toBe("retryable");
    expect(classifyStepError(Object.assign(new Error("boom"), { code: "40P01" })).kind).toBe("retryable");
    expect(classifyStepError(new Error("Connection terminated unexpectedly")).kind).toBe("retryable");
    expect(classifyStepError(new Error("timeout exceeded when trying to connect")).kind).toBe("retryable");
    expect(classifyStepError(Object.assign(new Error("x"), { code: "ECONNRESET" })).kind).toBe("retryable");
    expect(classifyStepError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) })).kind).toBe("retryable");
    expect(classifyStepError(new TypeError("fetch failed")).kind).toBe("retryable");
    expect(classifyStepError(Object.assign(new Error("t"), { name: "TimeoutError" })).kind).toBe("retryable");
  });

  it("fails closed: data, validation and integrity errors are permanent", () => {
    expect(classifyStepError(Object.assign(new Error("dup"), { code: "23505" }))).toMatchObject({ kind: "permanent" });
    expect(classifyStepError(new Error("Referenced source snapshot is missing or its content hash does not match workflow evidence")).kind).toBe("permanent");
    expect(classifyStepError(new Error("GitHub API redirect rejected by source-fetch policy")).kind).toBe("permanent");
    expect(classifyStepError(new Error("Source response exceeded configured byte limit")).kind).toBe("permanent");
    expect(classifyStepError("a string").kind).toBe("permanent");
    expect(classifyStepError(undefined).kind).toBe("permanent");
  });
});
