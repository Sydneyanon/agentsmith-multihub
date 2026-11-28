// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyFilters, boot, DEFAULT_FILTERS, money, type Feed, type Programme } from "../src/public-bounties.js";

const prog = (o: Partial<Programme>): Programme => ({
  id: o.project ?? "x", key: null, project: "X", programme: null, platform: null, official_url: null, max_reward: null, currency: null, reward_type: null, reward_source: null, reward_conflicts: 0,
  tiers: [], chains: [], asset_types: [], technologies: [], categories: [], kyc: null, fee: null, launched: null, source_updated: null, status: "reported_active", status_basis: "", verification: "community_reported",
  priority: null, components: null, explanation: [], first_seen: "2026-11-27T00:00:00Z", last_checked: null, last_verified: null, updated: "2026-11-27T00:00:00Z", sources: [], ...o,
});
const LIST = [
  prog({ project: "Alpha", max_reward: 1e6, currency: "USD", priority: 70, chains: ["Ethereum"], verification: "official_confirmed", status: "active", sources: [{ source: "sherlock", url: null, listed: true }], first_seen: "2026-11-20T00:00:00Z" }),
  prog({ project: "Beta", max_reward: 5e6, currency: "USDC", priority: 60, chains: ["Solana"], sources: [{ source: "community-board", url: null, listed: true }], first_seen: "2026-11-26T00:00:00Z" }),
  prog({ project: "Gamma", max_reward: null, priority: null, verification: "social_reported", status: "requires_verification", sources: [{ source: "x", url: null, listed: true }] }),
  prog({ project: "Bitmart Post-Incident Forensics Bounty Hunt", max_reward: 58e6, currency: "USD", priority: 40 }),
];

describe("public bounty dashboard", () => {
  it("sorts by priority, reward and discovery date; unknown rewards and priorities go last, never treated as numbers", () => {
    expect(applyFilters(LIST, DEFAULT_FILTERS).map((p) => p.project)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(applyFilters(LIST, { ...DEFAULT_FILTERS, sort: "reward" }).map((p) => p.project)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(applyFilters(LIST, { ...DEFAULT_FILTERS, sort: "discovered" })[0]!.project).toBe("Gamma");
  });
  it("filters by chain, source, verification, minimum reward and search; recovery bounties are hidden unless asked for", () => {
    expect(applyFilters(LIST, { ...DEFAULT_FILTERS, chain: "ethereum" }).map((p) => p.project)).toEqual(["Alpha"]);
    expect(applyFilters(LIST, { ...DEFAULT_FILTERS, source: "x" }).map((p) => p.project)).toEqual(["Gamma"]);
    expect(applyFilters(LIST, { ...DEFAULT_FILTERS, verification: "needs" }).map((p) => p.project)).toEqual(["Beta", "Gamma"]);
    expect(applyFilters(LIST, { ...DEFAULT_FILTERS, minReward: 2e6 }).map((p) => p.project)).toEqual(["Beta"]);
    expect(applyFilters(LIST, { ...DEFAULT_FILTERS, q: "gam" }).map((p) => p.project)).toEqual(["Gamma"]);
    expect(applyFilters(LIST, { ...DEFAULT_FILTERS, includeRecovery: true, sort: "reward" })[0]!.project).toMatch(/Bitmart/);
    expect(money(null, null)).toBe("not stated"); expect(money(2500000, "USDC")).toBe("$2.5M USDC"); expect(money(100000, "EUL")).toBe("100k EUL");
  });
  it("renders real records with honest labels, and an error instead of data when the feed fails", async () => {
    const feed: Feed = { generated_at: "2026-11-27T06:00:00Z", scoring_version: "bounty-rank/1", programmes: LIST,
      overview: { total: 4, active_official: 1, officially_listed: 1, without_official_source: 3, new_7d: 4, changed_7d: 0, needs_verification: 3, last_successful_collection: { source_key: "community-board", last_success_at: "2026-11-27T05:59:00Z" } },
      sources: [{ key: "community-board", name: "Community board", kind: "community_index", enabled: true, access_status: "permitted", access_note: "", last_success_at: "2026-11-27T05:59:00Z", programmes: 3, last_outcome: "fetched" }] };
    const root = document.createElement("div");
    await boot(root, (async () => new Response(JSON.stringify(feed), { status: 200 })) as typeof fetch);
    expect(root.querySelectorAll(".bcard")).toHaveLength(3);
    expect(root.textContent).toContain("Official · confirmed"); expect(root.textContent).toContain("X post only"); expect(root.textContent).toContain("reward not stated");
    expect(root.querySelector("a.btn-import")?.getAttribute("href")).toBe("/hub/#/bounties/import");
    (root.querySelector(".bcard") as HTMLElement).click();
    expect(root.querySelector(".detail")?.textContent).toContain("WHY THIS PRIORITY");
    const broken = document.createElement("div");
    await boot(broken, (async () => new Response("{}", { status: 503 })) as typeof fetch);
    expect(broken.querySelector("[role=alert]")?.textContent).toMatch(/could not be loaded: the feed answered HTTP 503/);
    expect(broken.querySelectorAll(".bcard")).toHaveLength(0);
  });
});
