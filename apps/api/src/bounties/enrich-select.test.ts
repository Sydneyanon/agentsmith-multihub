import { describe, expect, it } from "vitest";
import { rankEnrichmentCandidates } from "./enrich.js";

const res = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v, source: "x", authority: 3, observedAt: "", conflicts: [] }]));
const row = (id: string, fields: Record<string, unknown>, verification = "official_confirmed") => ({ id, resolved: res(fields), verification });
const hp = (slug: string) => `https://hackenproof.com/programs/${slug}`;

describe("enrichment candidate selection", () => {
  it("only spends fetches on ELIGIBLE programmes on a platform enrichment may read", () => {
    const ids = rankEnrichmentCandidates([
      row("web", { projectName: "WebCo", maxReward: 1e5, officialUrl: hp("webco"), assetTypes: ["Websites & apps"] }),          // out of engine scope
      row("cex", { projectName: "Cex", maxReward: 1e5, officialUrl: hp("cex"), technologies: ["CEX", "Web"] }),                   // no smart-contract scope
      row("unconfirmed", { projectName: "U", maxReward: 1e5, officialUrl: hp("u"), technologies: ["Solidity"] }, "community_reported"), // not official
      row("immunefi", { projectName: "I", maxReward: 1e6, officialUrl: "https://immunefi.com/bug-bounty/i/information", chains: ["Ethereum"] }), // platform not enrichable
      row("ok", { projectName: "Ok", maxReward: 1e4, officialUrl: hp("ok"), technologies: ["DeFi", "Solidity"] }),
    ]);
    expect(ids).toEqual(["ok"]);
  });

  it("orders Solidity/EVM programmes first, non-EVM last, then by reward", () => {
    const ids = rankEnrichmentCandidates([
      row("move-big", { projectName: "M", maxReward: 9e6, officialUrl: hp("m"), technologies: ["Move", "Smart contract"] }),
      row("sol-small", { projectName: "S1", maxReward: 1e4, officialUrl: hp("s1"), technologies: ["Solidity"] }),
      row("sol-big", { projectName: "S2", maxReward: 5e5, officialUrl: "https://audits.sherlock.xyz/bug-bounties/56", chains: ["Ethereum", "Arbitrum"] }),
      row("unknown", { projectName: "U", maxReward: 2e6, officialUrl: hp("u2"), assetTypes: ["Smart contract"] }),
      row("mixed", { projectName: "X", maxReward: 3e6, officialUrl: hp("x"), technologies: ["Solidity", "Rust"] }),
    ]);
    expect(ids).toEqual(["sol-big", "sol-small", "mixed", "unknown", "move-big"]);
  });
});
