import { describe, expect, it } from "vitest";
import { metric, redactText, sanitizePayload } from "./operations-api.js";

describe("operations metrics and redaction", () => {
  it("a metric is measurable only with a recorded numerator and a positive denominator", () => {
    const base = { key: "k", label: "l", unit: "files", kind: "processing" as const, source: "s", basis: "verified" as const };
    expect(metric({ ...base, numerator: 3, denominator: 4 }).measurable).toBe(true);
    expect(metric({ ...base, numerator: 3, denominator: null }).measurable).toBe(false);
    expect(metric({ ...base, numerator: null, denominator: 4 }).measurable).toBe(false);
    expect(metric({ ...base, numerator: 0, denominator: 0 }).measurable).toBe(false);
    expect(metric({ ...base, numerator: 3, denominator: 4, measurable: false }).measurable).toBe(false);
  });

  it("removes tokens by shape and by key from stored payloads, keeps token ids, omits content fields and caps sizes", () => {
    const wct = `wct1_${"a".repeat(32)}_${"B".repeat(43)}`;
    const pat = "github_pat_" + "11ABCDEFG0" + "y".repeat(40);
    const clean = JSON.stringify(sanitizePayload({ token_id: "b".repeat(32), reason: `failed with Bearer ${wct} and ${pat}`, token: "plain-secret-value", nested: { authorization: "Basic xyz", url: "https://user:pw@host.example/x" },
      structural_map: { huge: true }, list: Array.from({ length: 40 }, (_, i) => i), long: "x".repeat(2000) }));
    expect(clean).not.toContain(wct); expect(clean).not.toContain("B".repeat(43)); expect(clean).not.toContain(pat); expect(clean).not.toContain("plain-secret-value");
    expect(clean).not.toContain("Basic xyz"); expect(clean).not.toContain("user:pw");
    expect(clean).toContain("b".repeat(32)); // a token id is not a secret
    expect(clean).toContain("[omitted: large or content field]"); expect(clean).toContain("… 15 more");
    expect(redactText(`see ${wct}`)).not.toContain(wct);
  });
});
