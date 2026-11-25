import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRoleName, loadManifest } from "./db-roles.js";

const manifest = loadManifest(join(__dirname, "..", "..", "..", "db", "runtime-grants.json"));
const withPriv = (p: string) => Object.entries(manifest.tables).filter(([, v]) => v.includes(p)).map(([k]) => k).sort();

describe("runtime grants manifest (reviewable pins)", () => {
  it("lets the runtime UPDATE only the four mutable tables, plus row-lock-only hypotheses", () => {
    expect(withPriv("UPDATE")).toEqual(["ai_budget_reservations", "hypotheses", "repo_snapshots", "workflow_runs", "workflow_steps"]);
  });
  it("lets the runtime INSERT only the tables the application writes", () => {
    expect(withPriv("INSERT")).toEqual([
      "ai_budget_reservations", "audit_events", "evaluation_evidence", "evidence_spans", "hypotheses", "hypothesis_evaluations", "hypothesis_events",
      "hypothesis_evidence", "hypothesis_reviews", "model_usage_events", "repo_snapshot_files", "repo_snapshots", "research_blobs", "source_snapshots",
      "workflow_runs", "workflow_steps",
    ]);
  });
  it("never lets the runtime touch the migration ledger or the eviction audit table, and never executes blob eviction", () => {
    expect(manifest.tables.schema_migrations).toEqual([]);
    expect(manifest.tables.research_blob_evictions).toEqual(["SELECT"]);
    expect(manifest.functions_executable).not.toContain("evict_research_blob");
    expect(manifest.functions_denied).toContain("evict_research_blob");
  });
  it("audit_events is append-only by privilege (it has no trigger)", () => {
    expect(manifest.tables.audit_events).toEqual(["SELECT", "INSERT"]);
  });
});

describe("manifest loading is strict", () => {
  const write = (m: unknown) => { const d = mkdtempSync(join(tmpdir(), "grants-")); const f = join(d, "g.json"); writeFileSync(f, JSON.stringify(m)); return f; };
  const base = { schema: "public", functions_executable: [], functions_denied: [], sequences_usable: "all" };
  it("rejects DELETE, TRUNCATE, TRIGGER and REFERENCES anywhere", () => {
    for (const bad of ["DELETE", "TRUNCATE", "TRIGGER", "REFERENCES"]) expect(() => loadManifest(write({ ...base, tables: { t: ["SELECT", bad] } })), bad).toThrow(/must never hold/);
  });
  it("rejects unknown privileges", () => { expect(() => loadManifest(write({ ...base, tables: { t: ["ALL"] } }))).toThrow(/unknown privilege/); });
  it("validates role names", () => {
    expect(assertRoleName("agentsmith_app")).toBe("agentsmith_app");
    for (const bad of [undefined, "", "Ab", "a;drop", "a b", "x".repeat(64), "1abc"]) expect(() => assertRoleName(bad), String(bad)).toThrow();
  });
});
