import { describe, expect, it } from "vitest";
import { validate } from "./validate.js";

const sha = (i: number) => i.toString(16).padStart(40, "0");
function sample(otherOnly: number) {
  const entries = Array.from({ length: 21 }, (_, i) => ({ id: `c5-${String(i).padStart(2, "0")}`, kind: i < 14 ? "vulnerable" : "post_fix_control", repository: `org/r${i}`, commit_sha: sha(i + 1), tree_sha: sha(i + 100),
    in_scope_paths: ["src/"], code_family: "none", report_published: "2026-08-01", prior_knowledge_risk: false, ...(i >= 14 ? { control_of: `c5-${String(i - 14).padStart(2, "0")}` } : {}) }));
  const findings = Array.from({ length: 14 }, (_, i) => ({ entry: entries[i]!.id, finding_id: `H-${i}`, report_url: `https://example.invalid/${i}`, severity: "high",
    class: i < 14 - otherOnly ? "reentrancy" : "other:SECRET-CLASS", mappable: true, locations: [{ file: "src/SECRET.sol", contract: "C", function: "SECRETFN" }], fix_commit: sha(i + 200) }));
  return { sel: { version: "corpus5-selection/1", selector: "t", selected_at: "2026-11-26T00:00:00Z", entries }, gt: { version: "corpus5-ground-truth/1", findings, controls: [] } };
}

describe("corpus 5 blind validator", () => {
  it("accepts a hand-back that meets the brief's rules", () => {
    const { sel, gt } = sample(0);
    // 12 entries with claimed classes and 8 with other-only findings need 20 vulnerable entries; build that shape
    const entries = Array.from({ length: 30 }, (_, i) => ({ ...sel.entries[0]!, id: `c5-${String(i).padStart(2, "0")}`, repository: `org/r${i}`, commit_sha: sha(i + 1), kind: i < 20 ? "vulnerable" : "clean_control" }));
    const findings = Array.from({ length: 20 }, (_, i) => ({ ...gt.findings[0]!, entry: entries[i]!.id, class: i < 12 ? "access-control" : "other:oracle" }));
    expect(validate({ ...sel, entries } as never, { ...gt, findings } as never).errors).toEqual([]);
  });
  it("reports rule violations by position and count only, never ground-truth content", () => {
    const { sel, gt } = sample(2);
    const r = validate(sel as never, gt as never);
    expect(r.errors).toContain("rules: entries with only other-class findings: 2 (< 8)");
    expect(JSON.stringify(r)).not.toMatch(/SECRET|example\.invalid/);
  });
  it("refuses excluded repositories, duplicate ids and controls that name no entry", () => {
    const { sel, gt } = sample(0);
    sel.entries[1] = { ...sel.entries[1]!, repository: "crytic/not-so-smart-contracts" };
    sel.entries[2] = { ...sel.entries[2]!, id: sel.entries[0]!.id };
    sel.entries[15] = { ...sel.entries[15]!, control_of: "c5-99" };
    const r = validate(sel as never, gt as never);
    expect(r.errors).toEqual(expect.arrayContaining(["selection.entries[1]: excluded repository", "selection.entries[2]: duplicate id", "selection.entries[15]: control_of names no entry"]));
  });
});
