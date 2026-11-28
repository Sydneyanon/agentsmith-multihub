import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { researchCandidates } from "../bounties/queries.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

const field = (value: unknown) => ({ value, source: "immunefi", authority: 10, observedAt: "2026-11-27T00:00:00Z", conflicts: [] });
const resolved = (url: string, repos: string[]) => JSON.stringify({ projectName: field("D"), officialUrl: field(url), otherUrls: field(repos), maxReward: field(1_000_000), assetTypes: field(["Smart contract"]), chains: field(["Ethereum"]) });

describe.skipIf(skipIntegration)("candidate repository mapping over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  beforeAll(async () => {
    db = await migratedTestDatabase();
    await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ('immunefi:mapped','Mapped','mapped',$1::jsonb,'active','official_confirmed')`, [resolved("https://immunefi.com/bug-bounty/mapped/information", ["https://github.com/acme/mapped"])]);
    await owner().query(`INSERT INTO bounty_programs (canonical_key, project_name, name_key, resolved, status, verification) VALUES ('immunefi:gap','Gap','gap',$1::jsonb,'active','official_confirmed')`, [resolved("https://immunefi.com/bug-bounty/gap/information", [])]);
  });
  afterAll(async () => { await db?.drop(); });

  it("exposes resolved repositories and flags programmes with a mapping gap", async () => {
    const cands = await researchCandidates(db.pool) as Array<Record<string, unknown>>;
    const mapped = cands.find((c) => c.key === "immunefi:mapped")!;
    const gap = cands.find((c) => c.key === "immunefi:gap")!;
    expect(mapped.has_repository).toBe(true);
    expect(mapped.repositories).toEqual(["acme/mapped"]);
    expect(gap.has_repository).toBe(false);      // engine-suitable but no repository resolved -> a mapping gap to enrich
    expect(gap.repositories).toEqual([]);
  });
});
