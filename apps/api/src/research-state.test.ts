import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  MAX_BLOB_BYTES, ResearchStore, claimFingerprint, decodeUtf8Strict, extractSpan, manifestSha256, sha256Hex, splitLines,
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

  it("depends on the claim, the generator, the snapshot and the evidence", () => {
    const base = claimFingerprint(input);
    expect(claimFingerprint({ ...input, claim: "a different claim text" })).not.toBe(base);
    expect(claimFingerprint({ ...input, generator: { ...input.generator, version: "2" } })).not.toBe(base);
    expect(claimFingerprint({ ...input, snapshotId: "s2" })).not.toBe(base);
    expect(claimFingerprint({ ...input, spans: input.spans.slice(0, 1) })).not.toBe(base);
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
