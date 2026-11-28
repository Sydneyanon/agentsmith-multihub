import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { intakeStepKeys } from "./worker-runtime.js";

/**
 * ARCHITECTURAL GAP TESTS for T-149 (docs/unified-research-workflow.md section 8).
 *
 * Every test here is EXPECTED TO FAIL today (`it.fails`): it states the target behaviour of the one research workflow, and the suite stays
 * green only while the gap exists. When an implementation closes a gap, that test starts passing, `it.fails` then FAILS the suite, and the
 * test must be flipped to a normal `it` in the same change. This makes progress impossible to claim without the behaviour, and impossible
 * to miss when it arrives.
 */
const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const migrations = () => readdirSync(join(root, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => read(join("db", "migrations", f))).join("\n");

describe("T-149 architectural gaps (expected to fail until closed)", () => {
  it.fails("GAP 1 (AC1): a URL intake ends in the one research run type with a sealed-snapshot acquisition step", () => {
    const intake = read("apps/api/src/intake.ts");
    expect(intake).toMatch(/repository_research|createRepositoryResearchRun|acquire_repository/);
  });

  it.fails("GAP 2 (AC2): the worker no longer schedules the legacy template stages that keep hypotheses outside the research store", () => {
    const keys = intakeStepKeys({});
    for (const legacy of ["locate_official_repositories", "map_attack_surface", "generate_hypotheses", "independent_challenge", "prepare_research_brief"]) expect(keys).not.toContain(legacy);
  });

  it.fails("GAP 3 (AC3): a human review can be recorded through the API", () => {
    const api = read("apps/api/src/research-api.ts");
    expect(api).toMatch(/app\.post\(\s*["'`]\/v1\/research\/hypotheses\/:id\/reviews/);
  });

  it.fails("GAP 4 (AC3): outcomes, including missed and duplicate, have a durable record with the confirmation rule", () => {
    const sql = migrations();
    expect(sql).toMatch(/CREATE TABLE hypothesis_outcomes/);
    expect(sql).toMatch(/'confirmed'.*'refuted'.*'inconclusive'.*'duplicate'.*'missed'/s);
  });

  it.fails("GAP 5 (AC4): there is one snapshot system; nothing writes the legacy source_snapshots table", () => {
    for (const f of ["apps/api/src/worker.ts", "apps/api/src/worker-runtime.ts"]) expect(read(f)).not.toMatch(/INSERT INTO source_snapshots/);
  });

  it.fails("GAP 6 (AC5): a protocol model (5.3) is stored per snapshot", () => {
    expect(migrations()).toMatch(/CREATE TABLE protocol_models/);
  });

  it.fails("GAP 7 (P7): a finding can only exist for a confirmed outcome", () => {
    expect(migrations()).toMatch(/ALTER TABLE findings ADD COLUMN hypothesis_outcome_id/);
  });

  it.fails("GAP 8 (5.1): research coverage distinguishes examined from unexplored components", () => {
    expect(migrations()).toMatch(/CREATE TABLE research_coverage/);
  });
});

describe("facts the T-149 design relies on (these must PASS; if one fails, the design must be revisited)", () => {
  it("discovery approval already creates a repository_research run", () => {
    expect(read("apps/api/src/discovery/store.ts")).toMatch(/createRepositoryResearchRunIn/);
  });
  it("the active-testing gate depends on the 0001 program, scope, asset and approval tables (so program identity must reuse them)", () => {
    const g = read("apps/api/src/scope-guard.ts");
    for (const t of ["programs", "program_scope_versions", "program_assets", "approvals"]) expect(g).toMatch(new RegExp(`\\b${t}\\b`));
  });
  it("the 0001 findings and knowledge tables have no writers in application code (safe to repurpose or deprecate)", () => {
    const src = readdirSync(join(root, "apps", "api", "src"), { recursive: true }).map(String).filter((f) => f.endsWith(".ts") && !/\.test\.ts$|integration/.test(f));
    for (const f of src) expect(read(join("apps/api/src", f))).not.toMatch(/INSERT INTO (findings|finding_evidence|verification_reviews|knowledge_items|knowledge_links)\b/);
  });
});
