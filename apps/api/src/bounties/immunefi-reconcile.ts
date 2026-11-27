/**
 * Immunefi reconciliation (task 2). Accounts for EVERY record in the Immunefi public-api feed and explains where each one goes:
 * which are valid, invalid, duplicate, paused, invite-only, reward-bearing, smart-contract scoped, GitHub-linked, and which tier the
 * eligibility classifier assigns. It never silently discards data — every raw record lands in exactly one disposition, and the valid
 * ones additionally carry attribute flags and an eligibility tier. The function is pure (feed in, accounting out) so it is fully
 * reproducible and testable against a committed fixture; a separate CLI runs it against the live feed to produce the dated report.
 *
 * This module does NOT enable Immunefi collection. Reconciliation is read-only analysis of the feed; the adapter stays disabled until
 * the Terms-of-Use question is resolved in writing (docs/source-access-decisions.md).
 */
import { parseImmunefi, type ImmunefiProgram as ImmunefiProgramRecord } from "./adapters.js";
import { canonicalFromUrl } from "./canonical.js";
import { classifyEligibility, type Eligibility } from "./eligibility.js";
import type { Resolution, ResolvedField } from "./resolve.js";
import type { ExtractedOpportunity } from "./types.js";

export type ProgrammeDisposition = {
  slug: string;
  project: string;
  disposition: "valid" | "invalid_no_slug" | "duplicate_slug";
  paused: boolean;
  invite_only: boolean;
  has_reward: boolean;
  max_reward: number | null;
  has_smart_contract_asset: boolean;
  has_other_asset_type: boolean;
  github_repos: string[];
  canonical_key: string | null;
  eligibility_tier: Eligibility["tier"] | null;
  engine_suitable: boolean;
  eligibility_reasons: string[];
};

export type ImmunefiReconciliation = {
  generated_for: string;              // the feed URL or fixture name the caller reconciled
  total_received: number;
  invalid_records: number;            // no usable slug
  duplicate_records: number;          // a slug already seen earlier in the feed
  valid_parsed: number;
  // attribute tallies over the VALID set (these overlap by design; each is defined independently)
  paused: number;
  invite_only: number;
  with_reward: number;
  without_reward: number;
  with_smart_contract_assets: number;
  without_smart_contract_assets: number;
  with_github_urls: number;
  github_url_total: number;
  with_other_asset_types: number;
  // eligibility partition over the VALID set (sums to valid_parsed)
  eligibility: Record<Eligibility["tier"], number>;
  engine_suitable: number;
  excluded_by_classifier: number;     // out_of_engine_scope + ineligible
  // the GitHub-linked programmes, explained one by one
  github_linked: ProgrammeDisposition[];
  // the complete per-programme record, so nothing is discarded
  programmes: ProgrammeDisposition[];
  problems: string[];                 // parser notes (skips, duplicates) verbatim
  checksum: { accounted: number; balances: boolean; tiers_sum: number };
};

const AUTHORITY_OFFICIAL = 10;

/** Build the minimal Resolution the eligibility classifier reads, treating the Immunefi feed as its (official) single source. */
function resolutionFor(o: ExtractedOpportunity, verification: Resolution["verification"]): Resolution {
  const now = o.sourceUpdatedAt ?? new Date(0).toISOString();
  const field = (value: unknown): ResolvedField => ({ value, source: "immunefi", authority: AUTHORITY_OFFICIAL, observedAt: now, conflicts: [] });
  const resolved: Record<string, ResolvedField> = {
    projectName: field(o.projectName),
    programmeName: field(o.programmeName),
    officialUrl: field(o.officialUrl),
    maxReward: field(o.maxReward ?? undefined),
    assetTypes: field(o.assetTypes),
    categories: field(o.categories),
    technologies: field(o.technologies),
    chains: field(o.chains),
  };
  return {
    projectName: o.projectName, resolved, status: o.statusClaim === "paused" ? "paused" : "active", statusBasis: "immunefi public-api",
    verification, lastVerifiedAt: now, needsVerification: verification !== "official_confirmed", reasons: [],
  };
}

export function reconcileImmunefi(programs: ImmunefiProgramRecord[], generatedFor: string): ImmunefiReconciliation {
  if (!Array.isArray(programs)) throw new Error("the public-api response is not a JSON array");
  // Disposition pass: mirror the parser's skip/duplicate rules so every raw record is accounted for exactly once.
  const seen = new Set<string>();
  const dispositions: ProgrammeDisposition[] = [];
  const bySlug = new Map<string, ImmunefiProgramRecord>();
  for (const raw of programs) {
    const slug = raw && typeof raw.slug === "string" ? raw.slug : "";
    const project = (raw?.project && String(raw.project).trim()) || slug || "(no slug)";
    if (!slug) { dispositions.push(blank(slug, project, "invalid_no_slug")); continue; }
    if (seen.has(slug)) { dispositions.push(blank(slug, project, "duplicate_slug")); continue; }
    seen.add(slug); bySlug.set(slug, raw);
    dispositions.push(blank(slug, project, "valid"));
  }
  // Extraction + classification over the valid set, reusing the production parser and classifier.
  const { items, problems } = parseImmunefi(programs);
  const byRef = new Map(items.map((o) => [o.sourceRef, o] as const));
  for (const d of dispositions) {
    if (d.disposition !== "valid") continue;
    const raw = bySlug.get(d.slug)!;
    const o = byRef.get(`immunefi:${d.slug}`);
    if (!o) continue; // parser and disposition agree on validity; defensive only
    d.paused = raw.isPaused === true;
    d.invite_only = raw.inviteOnly === true;
    d.max_reward = o.maxReward;
    d.has_reward = o.maxReward !== null;
    d.has_smart_contract_asset = o.assetTypes.includes("Smart contract");
    d.has_other_asset_type = o.assetTypes.some((a) => a !== "Smart contract");
    d.github_repos = o.otherUrls.filter((u) => /github\.com\//i.test(u));
    const canonical = canonicalFromUrl(o.officialUrl);
    d.canonical_key = canonical?.key ?? null;
    // The Immunefi feed is an official platform: a listed programme is official confirmation of existence (status aside).
    const elig = classifyEligibility(resolutionFor(o, "official_confirmed"));
    d.eligibility_tier = elig.tier; d.engine_suitable = elig.engineSuitable; d.eligibility_reasons = elig.reasons;
  }

  const valid = dispositions.filter((d) => d.disposition === "valid");
  const tier = (t: Eligibility["tier"]) => valid.filter((d) => d.eligibility_tier === t).length;
  const eligibility = { eligible: tier("eligible"), needs_verification: tier("needs_verification"), out_of_engine_scope: tier("out_of_engine_scope"), ineligible: tier("ineligible") };
  const invalid = dispositions.filter((d) => d.disposition === "invalid_no_slug").length;
  const duplicate = dispositions.filter((d) => d.disposition === "duplicate_slug").length;
  const tiersSum = eligibility.eligible + eligibility.needs_verification + eligibility.out_of_engine_scope + eligibility.ineligible;

  return {
    generated_for: generatedFor,
    total_received: programs.length,
    invalid_records: invalid,
    duplicate_records: duplicate,
    valid_parsed: valid.length,
    paused: valid.filter((d) => d.paused).length,
    invite_only: valid.filter((d) => d.invite_only).length,
    with_reward: valid.filter((d) => d.has_reward).length,
    without_reward: valid.filter((d) => !d.has_reward).length,
    with_smart_contract_assets: valid.filter((d) => d.has_smart_contract_asset).length,
    without_smart_contract_assets: valid.filter((d) => !d.has_smart_contract_asset).length,
    with_github_urls: valid.filter((d) => d.github_repos.length > 0).length,
    github_url_total: valid.reduce((n, d) => n + d.github_repos.length, 0),
    with_other_asset_types: valid.filter((d) => d.has_other_asset_type).length,
    eligibility,
    engine_suitable: valid.filter((d) => d.engine_suitable).length,
    excluded_by_classifier: eligibility.out_of_engine_scope + eligibility.ineligible,
    github_linked: valid.filter((d) => d.github_repos.length > 0),
    programmes: dispositions,
    problems,
    checksum: { accounted: invalid + duplicate + valid.length, balances: invalid + duplicate + valid.length === programs.length, tiers_sum: tiersSum },
  };
}

function blank(slug: string, project: string, disposition: ProgrammeDisposition["disposition"]): ProgrammeDisposition {
  return { slug, project, disposition, paused: false, invite_only: false, has_reward: false, max_reward: null, has_smart_contract_asset: false, has_other_asset_type: false, github_repos: [], canonical_key: null, eligibility_tier: null, engine_suitable: false, eligibility_reasons: [] };
}

/** A compact, deterministic Markdown rendering of a reconciliation, for the committed report. */
export function renderReconciliationMarkdown(r: ImmunefiReconciliation): string {
  const L: string[] = [];
  L.push(`# Immunefi reconciliation`, "", `Source: \`${r.generated_for}\`  `, `Every record is accounted for in exactly one disposition; the valid set also carries attribute tallies and an eligibility tier.`, "");
  L.push(`## Disposition of every record (partition)`, "", `| Disposition | Count |`, `|---|--:|`,
    `| Total received | ${r.total_received} |`, `| Invalid (no slug) | ${r.invalid_records} |`, `| Duplicate slug | ${r.duplicate_records} |`, `| Valid parsed | ${r.valid_parsed} |`,
    `| **Accounted (balances: ${r.checksum.balances})** | **${r.checksum.accounted}** |`, "");
  L.push(`## Attributes of the ${r.valid_parsed} valid programmes (overlapping)`, "", `| Attribute | Count |`, `|---|--:|`,
    `| Paused | ${r.paused} |`, `| Invite-only | ${r.invite_only} |`, `| With a reward | ${r.with_reward} |`, `| Without a reward | ${r.without_reward} |`,
    `| With smart-contract assets | ${r.with_smart_contract_assets} |`, `| Without smart-contract assets | ${r.without_smart_contract_assets} |`,
    `| With GitHub repository URLs | ${r.with_github_urls} (|urls| = ${r.github_url_total}) |`, `| With other asset types (web/DLT) | ${r.with_other_asset_types} |`, "");
  L.push(`## Eligibility tiers of the ${r.valid_parsed} valid programmes (partition, sum ${r.checksum.tiers_sum})`, "",
    `> **Framing — this is a _potential_, not a live count.** The classifier is run here treating the Immunefi feed as an official,`,
    `> confirmed source (so a smart-contract-scoped, reward-bearing programme can reach \`eligible\`). Immunefi direct collection is`,
    `> **disabled** pending written Terms confirmation, so today these programmes are NOT in the system as official_confirmed; they`,
    `> appear only via the community board as \`community_reported\` → \`needs_verification\`. The tiers below show what Immunefi would`,
    `> contribute **if** it were enabled. Note \`engine-suitable\` counts a programme whose scope lists a chain even without a`,
    `> \`smart_contract\` asset type, so it (${r.engine_suitable}) can exceed "with smart-contract assets" (${r.with_smart_contract_assets}).`, "",
    `| Tier | Count |`, `|---|--:|`,
    `| eligible (data-ready) | ${r.eligibility.eligible} |`, `| needs_verification | ${r.eligibility.needs_verification} |`,
    `| out_of_engine_scope | ${r.eligibility.out_of_engine_scope} |`, `| ineligible | ${r.eligibility.ineligible} |`,
    `| engine-suitable (sc scope + official URL) | ${r.engine_suitable} |`, `| excluded by classifier | ${r.excluded_by_classifier} |`, "");
  L.push(`## The ${r.with_github_urls} GitHub-linked programmes, explained`, "");
  for (const d of r.github_linked) {
    L.push(`- **${d.project}** (\`${d.slug}\`) — tier \`${d.eligibility_tier}\`, engine-suitable: ${d.engine_suitable}; reward ${d.max_reward ?? "none"}; canonical \`${d.canonical_key}\`; repos: ${d.github_repos.join(", ")}`);
  }
  if (r.problems.length) { L.push("", `## Parser notes`, ""); for (const p of r.problems) L.push(`- ${p}`); }
  return L.join("\n") + "\n";
}
