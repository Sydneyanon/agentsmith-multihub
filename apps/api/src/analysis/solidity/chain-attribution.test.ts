import { describe, expect, it } from "vitest";
import { analyzeSources } from "./specialists.js";
import { buildProtocolModel, type Evidence } from "./protocol-model.js";

/**
 * Regression for a citation error first seen on a real bounty repository: a derived contract (long file) calls an inherited helper
 * (short base file) that makes the external call. The call-chain frame recorded the CALLEE's file with the CALLER's call-site line,
 * so the analyzer cited e.g. "Base.sol:157" in a file with 20 lines. A frame is a call SITE: its file must be the caller's file.
 */
const BASE = `pragma solidity ^0.8.20;
interface IRecv { function ping() external; }
abstract contract Base {
    mapping(address => uint256) public bal;
    modifier tracked() { _; }
    function _notify(address r) internal { IRecv(r).ping(); }
}`;
const filler = Array.from({ length: 150 }, (_, i) => `    // ${i}`).join("\n");
const CHILD = `pragma solidity ^0.8.20;
import "./Base.sol";
contract Child is Base {
${filler}
    function withdraw(address r) external tracked {
        require(bal[msg.sender] > 0);
        _notify(r);
        bal[msg.sender] = 0;
    }
}`;
const sources = [{ path: "c/Base.sol", text: BASE }, { path: "c/Child.sol", text: CHILD }];
const lines = new Map(sources.map((s) => [s.path, s.text.split("\n")]));
const callSite = CHILD.split("\n").findIndex((l) => l.includes("_notify(r);")) + 1;

describe("call-chain attribution across files", () => {
  it("every span the analyzer cites names a line that exists in that file", () => {
    const { findings } = analyzeSources(sources);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) for (const s of f.spans) expect(s.lineStart, `${f.class} cites ${s.file}:${s.lineStart}`).toBeLessThanOrEqual(lines.get(s.file)!.length);
  });

  it("the frame for an inherited helper points at the call site in the caller's file", () => {
    const f = analyzeSources(sources).findings.find((x) => x.class === "reentrancy" && x.function === "withdraw")!;
    expect(f).toBeDefined();
    expect(f.chain).toContainEqual(expect.objectContaining({ fn: "_notify", file: "c/Child.sol", line: callSite }));
    expect(lines.get("c/Child.sol")![callSite - 1]).toContain("_notify(r);");
  });

  it("protocol-model call-edge evidence cites the call site, not the callee's file", () => {
    const edges = buildProtocolModel(sources).model.callEdges as Array<{ to: string; kind: string; evidence: Evidence | null }>;
    const internal = edges.filter((e) => e.kind === "internal" && e.to.endsWith("._notify") && e.evidence);
    expect(internal.length).toBeGreaterThan(0);
    for (const e of edges) if (e.evidence) expect(e.evidence.lineEnd, `${e.to} evidence ${e.evidence.file}:${e.evidence.lineStart}`).toBeLessThanOrEqual(lines.get(e.evidence.file)!.length);
    expect(internal[0]!.evidence).toMatchObject({ file: "c/Child.sol", lineStart: callSite });
  });
});
