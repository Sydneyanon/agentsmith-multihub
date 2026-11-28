import { describe, expect, it } from "vitest";
import { rejectUncitableFindings } from "./pipeline.js";
import { analyzeSources, type Finding } from "./specialists.js";

const VAULT = `pragma solidity ^0.8.20;
contract Vault {
    mapping(address => uint256) public bal;
    function withdraw() external {
        uint256 a = bal[msg.sender];
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok);
        bal[msg.sender] = 0;
    }
}`;

describe("findings may only cite lines that exist in the snapshot", () => {
  const sources = [{ path: "c/Vault.sol", text: VAULT }];
  const real = analyzeSources(sources).findings;

  it("keeps a finding whose every span exists", () => {
    expect(real.length).toBeGreaterThan(0);
    expect(rejectUncitableFindings(real, sources)).toEqual({ kept: real, problems: [] });
  });

  it("rejects (and reports) a finding citing a line beyond the file, without touching the others", () => {
    const broken: Finding = { ...real[0]!, spans: [...real[0]!.spans, { file: "c/Vault.sol", lineStart: 157, lineEnd: 157, role: "supporting" }] };
    const other: Finding = { ...real[0]!, function: "other" };
    const r = rejectUncitableFindings([broken, other], sources);
    expect(r.kept).toEqual([other]);
    expect(r.problems).toEqual([expect.stringMatching(/^finding rejected \(analyzer attribution error\): reentrancy Vault\.withdraw cites c\/Vault\.sol:157/)]);
  });

  it("rejects a citation of a file that is not in the snapshot", () => {
    const ghost: Finding = { ...real[0]!, spans: [{ file: "c/Missing.sol", lineStart: 1, lineEnd: 1, role: "primary" }] };
    expect(rejectUncitableFindings([ghost], sources).kept).toEqual([]);
  });
});
