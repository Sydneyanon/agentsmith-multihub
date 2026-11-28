import { canonicalJson } from "./research-state.js";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  MAX_BLOB_BYTES, ResearchConflictError, ResearchStore, claimFingerprint, decodeUtf8Strict, diffHypothesis, diffManifestRow,
  extractSpan, manifestSha256, sha256Hex, splitLines,
} from "./research-state.js";

describe("line semantics", () => {
  it("splits on LF only and ignores one final empty element", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("\n")).toEqual([""]);
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("a\n\n\nb")).toEqual(["a", "", "", "b"]);
  });

  it("keeps carriage returns as part of the line", () => {
    expect(splitLines("x\r\ny\r\n")).toEqual(["x\r", "y\r"]);
  });

  it("extracts 1-based inclusive ranges and refuses ranges that do not exist", () => {
    const text = "one\ntwo\nthree\n";
    expect(extractSpan(text, 1, 1)).toBe("one");
    expect(extractSpan(text, 2, 3)).toBe("two\nthree");
    expect(extractSpan(text, 1, 4)).toBeNull();
    expect(extractSpan(text, 0, 1)).toBeNull();
    expect(extractSpan(text, 3, 2)).toBeNull();
    expect(extractSpan(text, 1.5, 2)).toBeNull();
  });

  it("rejects bytes that are not valid UTF-8", () => {
    expect(() => decodeUtf8Strict(Buffer.from([0xff, 0xfe, 0x41]))).toThrow();
    expect(decodeUtf8Strict(Buffer.from("héllo 日本", "utf8"))).toBe("héllo 日本");
  });
});

describe("manifest hash", () => {
  const stored = (path: string, blob: string) => ({ path, blobSha256: blob, skipReason: null });
  const a = "a".repeat(64);
  const b = "b".repeat(64);

  it("is independent of input order and sorts paths by UTF-8 bytes", () => {
    const entries = [stored("z.sol", a), stored("B.sol", b), stored("a.sol", a), stored("é.sol", b)];
    expect(manifestSha256(entries)).toBe(manifestSha256([...entries].reverse()));
    // byte order: "B" (0x42) < "a" (0x61) < "z" (0x7a) < "é" (0xc3 0xa9)
    const expectedBody = `B.sol\t${b}\na.sol\t${a}\nz.sol\t${a}\né.sol\t${b}\n`;
    expect(manifestSha256(entries)).toBe(sha256Hex(Buffer.from(expectedBody, "utf8")));
  });

  it("records skipped files with their reason and distinguishes them from stored ones", () => {
    const skipped = { path: "big.bin", blobSha256: null, skipReason: "oversize" };
    expect(manifestSha256([skipped])).toBe(sha256Hex(Buffer.from("big.bin\tskipped:oversize\n", "utf8")));
    expect(manifestSha256([skipped])).not.toBe(manifestSha256([{ ...skipped, skipReason: "binary" }]));
  });

  it("hashes an empty manifest as the empty string", () => {
    expect(manifestSha256([])).toBe(sha256Hex(Buffer.from("", "utf8")));
  });

  it("changes when any path or blob changes", () => {
    const base = manifestSha256([stored("a.sol", a)]);
    expect(manifestSha256([stored("a2.sol", a)])).not.toBe(base);
    expect(manifestSha256([stored("a.sol", b)])).not.toBe(base);
  });
});

describe("claim fingerprint", () => {
  const input = {
    snapshotId: "s1", family: "reentrancy", claim: "withdraw sends value before updating state",
    generator: { kind: "deterministic_rule" as const, id: "r1", version: "1" },
    spans: [{ spanId: "b", role: "primary" }, { spanId: "a", role: "supporting" }],
  };

  it("does not depend on span order", () => {
    expect(claimFingerprint(input)).toBe(claimFingerprint({ ...input, spans: [...input.spans].reverse() }));
  });

  it("depends on the claim, the generator, the family, the snapshot and the cited spans", () => {
    const base = claimFingerprint(input);
    expect(claimFingerprint({ ...input, claim: "a different claim text" })).not.toBe(base);
    expect(claimFingerprint({ ...input, family: "access-control" })).not.toBe(base);
    expect(claimFingerprint({ ...input, generator: { ...input.generator, version: "2" } })).not.toBe(base);
    expect(claimFingerprint({ ...input, snapshotId: "s2" })).not.toBe(base);
    expect(claimFingerprint({ ...input, spans: input.spans.slice(0, 1) })).not.toBe(base);
  });

  it("leaves roles out of the identity, so a retry that changes only a role is compared and rejected, not duplicated", () => {
    const swapped = input.spans.map((span) => ({ ...span, role: span.role === "primary" ? "supporting" : "primary" }));
    expect(claimFingerprint({ ...input, spans: swapped })).toBe(claimFingerprint(input));
  });
});

describe("store guards that need no database", () => {
  it("refuses a blob over the size limit before touching the database", () => {
    const store = new ResearchStore({} as Pool);
    expect(() => store.putBlob({ stepId: "s", workerId: "w" }, Buffer.alloc(MAX_BLOB_BYTES + 1))).toThrow(/exceeds/);
  });

  it("refuses an operator recording a review under someone else's identity or as a model", async () => {
    const store = new ResearchStore({} as Pool);
    const base = {
      hypothesisId: "h", mode: "blinded_independent_assessment" as const,
      reviewerSaw: { claim: true, evidence_spans: true, generator_rationale: false, generator_identity: false, prior_evaluations: false, prior_reviews: false },
      inputSha256: "a".repeat(64), verdict: "supports" as const, rationale: "r",
    };
    await expect(store.recordReview({ kind: "operator", operatorId: "alice" }, { ...base, reviewerKind: "human", reviewerId: "bob" })).rejects.toThrow(/own identity/);
    await expect(store.recordReview({ kind: "operator", operatorId: "alice" }, { ...base, reviewerKind: "model", reviewerId: "alice" })).rejects.toThrow(/own identity/);
  });
});


describe("retry comparison helpers", () => {
  const stored = {
    family: "solidity-low-level-call", claim: "The call precedes the update.", rationale: "State changes after the call.",
    required_checks: ["trace the target"], alternative_explanations: ["a guard exists"],
    generator_kind: "deterministic_rule", generator_id: "rule-x", generator_version: "1", generator_reservation_id: null,
    supersedes_id: null, spans: [{ span_id: "s1", role: "primary" }, { span_id: "s2", role: "supporting" }],
  };
  const requested = {
    family: stored.family, claim: stored.claim, rationale: stored.rationale, requiredChecks: ["trace the target"],
    alternativeExplanations: ["a guard exists"], generator: { kind: "deterministic_rule" as const, id: "rule-x", version: "1" },
    supersedesId: null, spans: [{ spanId: "s2", role: "supporting" }, { spanId: "s1", role: "primary" }],
  };

  it("finds no difference in an identical retry, whatever the span order", () => {
    expect(diffHypothesis(stored, requested)).toEqual([]);
  });

  it("names every immutable field that a changed retry alters", () => {
    expect(diffHypothesis(stored, { ...requested, rationale: "different" })).toEqual(["rationale"]);
    expect(diffHypothesis(stored, { ...requested, requiredChecks: ["other"] })).toEqual(["required checks"]);
    expect(diffHypothesis(stored, { ...requested, requiredChecks: [] })).toEqual(["required checks"]);
    expect(diffHypothesis(stored, { ...requested, alternativeExplanations: ["x", "y"] })).toEqual(["alternative explanations"]);
    expect(diffHypothesis(stored, { ...requested, supersedesId: "h0" })).toEqual(["supersedes"]);
    expect(diffHypothesis(stored, { ...requested, generator: { ...requested.generator, reservationId: "r1" } })).toEqual(["generator reservation"]);
    expect(diffHypothesis(stored, { ...requested, spans: [{ spanId: "s1", role: "supporting" }, { spanId: "s2", role: "supporting" }] })).toEqual(["evidence"]);
    expect(diffHypothesis(stored, { ...requested, rationale: "x", supersedesId: "h0" })).toEqual(["rationale", "supersedes"]);
  });

  const row = { blob_sha256: "a".repeat(64), git_blob_sha: null, size_bytes: "12", classification: "source", skip_reason: null };
  const wanted = { blobSha256: "a".repeat(64), gitBlobSha: null, sizeBytes: 12, classification: "source", skipReason: null };

  it("treats an identical manifest row as the same and names each differing field otherwise", () => {
    expect(diffManifestRow(row, wanted)).toEqual([]);
    expect(diffManifestRow(row, { ...wanted, blobSha256: "b".repeat(64) })).toEqual(["blob"]);
    expect(diffManifestRow(row, { ...wanted, sizeBytes: 13 })).toEqual(["size"]);
    expect(diffManifestRow(row, { ...wanted, classification: "test" })).toEqual(["classification"]);
    expect(diffManifestRow(row, { ...wanted, gitBlobSha: "c".repeat(40) })).toEqual(["git blob id"]);
    expect(diffManifestRow(row, { ...wanted, blobSha256: null, skipReason: "oversize" })).toEqual(["blob", "skip reason"]);
  });

  it("explains a conflict without leaking content", () => {
    const error = new ResearchConflictError("manifest row", "src/A.sol", ["blob", "size"]);
    expect(error.message).toContain("src/A.sol");
    expect(error.message).toContain("blob, size");
    expect(error.name).toBe("ResearchConflictError");
  });
});

describe("canonicalJson (how snapshot reports are compared on a retry)", () => {
  it("is independent of object key order at every depth, because PostgreSQL jsonb returns keys in its own order", () => {
    const a = { z: 1, a: { y: [1, { q: 1, b: 2 }], c: "x" }, m: null };
    const b = { m: null, a: { c: "x", y: [1, { b: 2, q: 1 }] }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
  it("still tells different values apart, including array order, types and nulls", () => {
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: { b: 1 } })).not.toBe(canonicalJson({ a: { b: 2 } }));
  });
});
