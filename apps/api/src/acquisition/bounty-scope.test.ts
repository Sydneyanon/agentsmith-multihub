import { describe, expect, it } from "vitest";
import { parseBountyScope, scopeOfPath } from "./bounty-scope.js";

const base = { programme: "sherlock:273", evidence: "docs/research-runs/usx-scope-evidence.md", evidence_sha256: "b".repeat(64) };

describe("bounty scope", () => {
  it("normalises the path list (deduplicated, sorted) and labels exact paths only", () => {
    const s = parseBountyScope({ ...base, in_scope_paths: ["src/USX.sol", "src/BridgedToken.sol", "src/USX.sol"] });
    expect(s.in_scope_paths).toEqual(["src/BridgedToken.sol", "src/USX.sol"]);
    expect(scopeOfPath(s, "src/USX.sol")).toBe("in_scope");
    expect(scopeOfPath(s, "src/cloak/PrivateGatewayCloak.sol")).toBe("out_of_scope");
    expect(scopeOfPath(s, "src/usx.sol")).toBe("out_of_scope"); // exact match: no case folding, no prefix match
    expect(scopeOfPath(s, "src")).toBe("out_of_scope");
  });
  it("refuses paths that leave the repository, empty lists, bad hashes and unknown fields", () => {
    for (const p of ["/etc/passwd", "../x.sol", "src/../x.sol", "src//x.sol", "./src/x.sol", ""]) expect(() => parseBountyScope({ ...base, in_scope_paths: [p] }), p).toThrow();
    expect(() => parseBountyScope({ ...base, in_scope_paths: [] })).toThrow();
    expect(() => parseBountyScope({ ...base, in_scope_paths: ["src/A.sol"], evidence_sha256: "abc" })).toThrow();
    expect(() => parseBountyScope({ ...base, in_scope_paths: ["src/A.sol"], extra: 1 })).toThrow();
  });
});
