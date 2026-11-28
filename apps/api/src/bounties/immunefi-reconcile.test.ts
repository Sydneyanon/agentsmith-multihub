import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reconcileImmunefi, renderReconciliationMarkdown } from "./immunefi-reconcile.js";
import type { ImmunefiProgram } from "./adapters.js";

const FIXTURE = fileURLToPath(new URL("./testing/fixtures/immunefi-public-api-2026-11-27.json.gz", import.meta.url));
const feed = (): ImmunefiProgram[] => JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString("utf8"));

describe("Immunefi reconciliation: every record is accounted for", () => {
  it("balances: invalid + duplicate + valid == total, on the committed fixture", () => {
    const r = reconcileImmunefi(feed(), "fixture");
    expect(r.total_received).toBe(12);
    expect(r.invalid_records + r.duplicate_records + r.valid_parsed).toBe(r.total_received);
    expect(r.checksum.balances).toBe(true);
    expect(r.programmes).toHaveLength(r.total_received); // nothing discarded: one disposition per raw record
  });

  it("the eligibility tiers partition the valid set", () => {
    const r = reconcileImmunefi(feed(), "fixture");
    const sum = r.eligibility.eligible + r.eligibility.needs_verification + r.eligibility.out_of_engine_scope + r.eligibility.ineligible;
    expect(sum).toBe(r.valid_parsed);
    expect(r.checksum.tiers_sum).toBe(r.valid_parsed);
  });

  it("reproduces the committed fixture's exact tallies", () => {
    const r = reconcileImmunefi(feed(), "fixture");
    expect(r).toMatchObject({
      total_received: 12, invalid_records: 0, duplicate_records: 0, valid_parsed: 12,
      paused: 0, invite_only: 0, with_reward: 12, without_reward: 0,
      with_smart_contract_assets: 12, without_smart_contract_assets: 0,
      with_github_urls: 10, github_url_total: 53, with_other_asset_types: 9,
      engine_suitable: 12, excluded_by_classifier: 0,
      eligibility: { eligible: 12, needs_verification: 0, out_of_engine_scope: 0, ineligible: 0 },
    });
  });

  it("explains every GitHub-linked programme: each cites real repos and a tier", () => {
    const r = reconcileImmunefi(feed(), "fixture");
    expect(r.github_linked).toHaveLength(10);
    for (const d of r.github_linked) {
      expect(d.github_repos.length).toBeGreaterThan(0);
      expect(d.github_repos.every((u) => /github\.com\//i.test(u))).toBe(true);
      expect(d.eligibility_tier).toBe("eligible");     // Immunefi official + smart-contract + reward
      expect(d.engine_suitable).toBe(true);
      expect(d.canonical_key).toMatch(/^immunefi:/);
    }
  });

  it("accounts for invalid and duplicate records without discarding them", () => {
    const base = feed();
    const synthetic: ImmunefiProgram[] = [
      ...base,
      { project: "No slug here" } as ImmunefiProgram,                 // invalid: no slug
      { slug: base[0]!.slug, project: "Dup of first" } as ImmunefiProgram, // duplicate slug
    ];
    const r = reconcileImmunefi(synthetic, "fixture+2");
    expect(r.total_received).toBe(14);
    expect(r.invalid_records).toBe(1);
    expect(r.duplicate_records).toBe(1);
    expect(r.valid_parsed).toBe(12);
    expect(r.checksum.balances).toBe(true);
    expect(r.programmes).toHaveLength(14);
    expect(r.programmes.filter((p) => p.disposition === "invalid_no_slug")).toHaveLength(1);
    expect(r.programmes.filter((p) => p.disposition === "duplicate_slug")).toHaveLength(1);
  });

  it("renders a deterministic Markdown report with the required sections", () => {
    const md = renderReconciliationMarkdown(reconcileImmunefi(feed(), "fixture"));
    expect(md).toContain("# Immunefi reconciliation");
    expect(md).toContain("Disposition of every record");
    expect(md).toContain("Eligibility tiers");
    expect(md).toContain("GitHub-linked programmes, explained");
    expect(md).toContain("balances: true");
  });
});
