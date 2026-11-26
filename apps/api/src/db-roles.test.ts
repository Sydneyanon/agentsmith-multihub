import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

import pg from "pg";
import { runRoleGuard, type RoleAssessment } from "./db-roles.js";

describe("startup role guard must not turn a database outage into a boot failure", () => {
  const ok: RoleAssessment = { ok: true, problems: [] };
  const bad: RoleAssessment = { ok: false, problems: ["role owns 33 relation(s) in schema public"] };
  const harness = () => {
    const log = { warn: [] as string[], fatal: [] as string[], sleeps: [] as number[] };
    return { log, options: (require: boolean, extra: object = {}) => ({ require, warn: (m: string) => log.warn.push(m), fatal: (m: string) => log.fatal.push(m), sleep: async (ms: number) => { log.sleeps.push(ms); }, ...extra }) };
  };

  it("a real unreachable database (connection refused) only warns when the restricted role is not required, and never throws", async () => {
    const h = harness();
    const pool = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 1000 });
    try { await expect(runRoleGuard(pool, h.options(false, { attempts: 2 }))).resolves.toBeUndefined(); } finally { await pool.end(); }
    expect(h.log.fatal).toEqual([]);
    expect(h.log.warn.join(" ")).toMatch(/could not verify the database runtime role/);
  });
  it("retries a failed check (a paused database waking up) and then reports the verdict", async () => {
    const h = harness(); let n = 0;
    await runRoleGuard({} as pg.Pool, h.options(false, { attempts: 4, assess: async () => { if (++n < 3) throw new Error("timeout"); return bad; } }));
    expect(n).toBe(3);
    expect(h.log.sleeps.length).toBe(2);
    expect(h.log.warn.join(" ")).toMatch(/not least-privilege.*owns 33/);
    expect(h.log.fatal).toEqual([]);
  });
  it("a bad role is fatal only when required, and immediately (no retries)", async () => {
    const h = harness(); let n = 0;
    await runRoleGuard({} as pg.Pool, h.options(true, { assess: async () => { n += 1; return bad; } }));
    expect(n).toBe(1);
    expect(h.log.fatal.join(" ")).toMatch(/not least-privilege/);
  });
  it("when required and the role can never be verified, it fails closed after the attempts", async () => {
    const h = harness();
    await runRoleGuard({} as pg.Pool, h.options(true, { attempts: 3, assess: async () => { throw new Error("down"); } }));
    expect(h.log.fatal.join(" ")).toMatch(/could not verify/);
    expect(h.log.sleeps.length).toBe(2);
  });
  it("reports every failed attempt, so a slow outage is visible long before the final verdict", async () => {
    const h = harness();
    await runRoleGuard({} as pg.Pool, h.options(false, { attempts: 3, assess: async () => { throw new Error("connect ETIMEDOUT"); } }));
    expect(h.log.warn.filter((m) => /attempt \d\/3 failed.*ETIMEDOUT/.test(m)).length).toBe(2);
    expect(h.log.warn.join(" ")).toMatch(/after 3 attempts/);
  });
  it("server.ts handles idle pool errors and caps the time a fatal exit can wait for open requests", () => {
    const src = readFileSync(join(__dirname, "server.ts"), "utf8");
    expect(src).toMatch(/pool\?\.on\("error"/);
    expect(src).toMatch(/setTimeout\(\(\) => process\.exit\(1\), \d+\)\.unref\(\)/);
  });
  it("a good role is silent", async () => {
    const h = harness();
    await runRoleGuard({} as pg.Pool, h.options(true, { assess: async () => ok }));
    expect(h.log.warn).toEqual([]); expect(h.log.fatal).toEqual([]);
  });
  it("server.ts starts listening BEFORE the guard runs and does not await it", () => {
    const src = readFileSync(join(__dirname, "server.ts"), "utf8");
    const listen = src.indexOf("await app.listen");
    const guard = src.indexOf("runRoleGuard(");
    expect(listen).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(listen);
    expect(src).not.toMatch(/await\s+(enforceRuntimeRole|runRoleGuard)/);
  });
});
