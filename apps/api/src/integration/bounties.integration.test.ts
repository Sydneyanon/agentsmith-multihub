import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { AuthFailureLimiter } from "../auth.js";
import { runCollection } from "../bounties/collect.js";
import { runImport } from "../bounties/import.js";
import { publicFeed } from "../bounties/queries.js";
import { addCorrection, decideDuplicate } from "../bounties/store.js";
import { BOARD_JSON, fakeHttp, standardRoutes, type Route } from "../bounties/testing/fixtures.js";
import { migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";

// Fixture transport only: these tests exercise the whole pipeline (fetch -> extract -> match -> resolve -> store -> API) on real Postgres
// without the network. The live runs against the real sources are separate (docs/bounty-intelligence.md).
const TOKEN = "Tq9xV3mZ8pL2wR7kN4bY6cH1dF5gJ0sAeU3iO8tWvXyQ";
const T0 = new Date("2026-11-27T06:00:00.000Z");
const at = (h: number) => () => new Date(T0.getTime() + h * 3600_000);

describe.skipIf(skipIntegration)("bounty intelligence collection over real Postgres", () => {
  let db: TestDatabase;
  const owner = () => db.ownerPool ?? db.pool;
  const count = async (sql: string, args: unknown[] = []) => Number((await owner().query(sql, args)).rows[0].n);
  beforeAll(async () => {
    db = await migratedTestDatabase();
    await owner().query("UPDATE bounty_sources SET enabled = true WHERE source_key IN ('sherlock', 'hackenproof')");
  });
  afterAll(async () => { await db?.drop(); });

  it("a first run collects every source independently and records each stage", async () => {
    const http = fakeHttp(standardRoutes());
    const r = await runCollection(db.pool, { trigger: "test", startedBy: "test", http, now: at(0), sleep: async () => undefined });
    expect(r.status).toBe("succeeded");
    const by = Object.fromEntries(r.checks.map((c) => [c.source, c]));
    expect(by["community-board"]).toMatchObject({ outcome: "fetched", listings: 388, added: 388 });
    expect(by.sherlock).toMatchObject({ outcome: "fetched", listings: 41, added: 0, matched: 41 }); // every Sherlock programme was already known from the board
    expect(by.hackenproof).toMatchObject({ outcome: "fetched", listings: 10 });
    expect(by.immunefi?.outcome).toBe("skipped_blocked"); expect(by.cantina?.outcome).toBe("skipped_blocked");
    expect(http.calls.some((u) => /immunefi|cantina/.test(u))).toBe(false);
    expect(await count("SELECT count(*) AS n FROM bounty_programs")).toBe(388);
    expect(await count("SELECT count(*) AS n FROM bounty_source_checks WHERE run_id = $1", [r.runId])).toBe(5);
  });

  it("deduplicates across sources: one programme, every source kept, official data over community data", async () => {
    const p = (await owner().query("SELECT id, verification, status, resolved FROM bounty_programs WHERE canonical_key = 'sherlock:56'")).rows[0];
    expect(p.verification).toBe("official_confirmed"); expect(p.status).toBe("active");
    expect(p.resolved.maxReward).toMatchObject({ value: 16000000, source: "sherlock" });
    const srcs = (await owner().query("SELECT source_key FROM bounty_observations WHERE program_id = $1 ORDER BY source_key", [p.id])).rows.map((x) => x.source_key);
    expect(srcs).toEqual(["community-board", "sherlock"]);
    const immunefi = (await owner().query("SELECT verification, status FROM bounty_programs WHERE canonical_key = 'immunefi:hyperlane'")).rows[0];
    expect(immunefi).toEqual({ verification: "community_reported", status: "reported_active" }); // Immunefi is never fetched, so never "confirmed"
  });

  it("is idempotent: running again over the same content adds nothing", async () => {
    const r = await runCollection(db.pool, { trigger: "test", startedBy: "test", http: fakeHttp(standardRoutes()), now: at(2), force: true, sleep: async () => undefined });
    expect(r.checks.find((c) => c.source === "community-board")).toMatchObject({ added: 0, updated: 0, unchanged: 388 });
    expect(await count("SELECT count(*) AS n FROM bounty_programs")).toBe(388);
    expect(await count("SELECT count(*) AS n FROM bounty_observations")).toBe(388 + 41 + 10);
  });

  it("a failing source does not stop the others, backs off, and is reported as failed rather than empty", async () => {
    const routes = { ...standardRoutes(), "https://audits.sherlock.xyz/bug-bounties": { status: 503, body: "down" } as Route };
    const r = await runCollection(db.pool, { trigger: "test", startedBy: "test", http: fakeHttp(routes), now: at(4), force: true, sleep: async () => undefined });
    expect(r.status).toBe("partial");
    expect(r.checks.find((c) => c.source === "sherlock")).toMatchObject({ outcome: "failed", error: "HTTP 503" });
    expect(r.checks.find((c) => c.source === "community-board")?.outcome).toBe("fetched");
    const s = (await owner().query("SELECT consecutive_failures, next_attempt_at FROM bounty_sources WHERE source_key = 'sherlock'")).rows[0];
    expect(s.consecutive_failures).toBe(1); expect(s.next_attempt_at.getTime()).toBeGreaterThan(at(4)().getTime());
    expect(await count("SELECT count(*) AS n FROM bounty_observations WHERE source_key = 'sherlock' AND listed")).toBe(41); // nothing delisted by a failure
    const next = await runCollection(db.pool, { trigger: "test", startedBy: "test", http: fakeHttp(standardRoutes()), now: at(4.5), sleep: async () => undefined });
    expect(next.checks.find((c) => c.source === "sherlock")?.outcome).toBe("skipped_not_due");
  });

  it("an empty answer delists nothing; a complete listing without a programme marks it no longer listed and records the change", async () => {
    const empty = { ...standardRoutes(), "https://bug-bounty-board.vercel.app/programs.json": { body: '{"programs":[]}', contentType: "application/json" } as Route };
    const r1 = await runCollection(db.pool, { trigger: "test", startedBy: "test", http: fakeHttp(empty), now: at(6), force: true, sources: ["community-board"], sleep: async () => undefined });
    expect(r1.checks[0]).toMatchObject({ outcome: "empty", delisted: 0 });
    const board = JSON.parse(BOARD_JSON()) as { programs: Array<{ p: string; id: string; max: number }> };
    board.programs = board.programs.filter((x) => !(x.p === "Immunefi" && x.id === "hyperlane"));
    const hyper = (await owner().query("SELECT id FROM bounty_programs WHERE canonical_key = 'immunefi:hyperlane'")).rows[0].id;
    const r2 = await runCollection(db.pool, { trigger: "test", startedBy: "test", http: fakeHttp({ ...standardRoutes(), "https://bug-bounty-board.vercel.app/programs.json": { body: JSON.stringify(board), contentType: "application/json" } }), now: at(7), force: true, sources: ["community-board"], sleep: async () => undefined });
    expect(r2.checks[0]).toMatchObject({ outcome: "fetched", delisted: 1 });
    expect((await owner().query("SELECT status FROM bounty_programs WHERE id = $1", [hyper])).rows[0].status).toBe("no_longer_listed");
    expect((await owner().query("SELECT old_value, new_value FROM bounty_program_changes WHERE program_id = $1 AND field = 'status'", [hyper])).rows).toEqual([{ old_value: "reported_active", new_value: "no_longer_listed" }]);
    // A listing that suddenly shrinks by more than half is not trusted for delisting.
    const tiny = { ...board, programs: board.programs.slice(0, 10) };
    const r3 = await runCollection(db.pool, { trigger: "test", startedBy: "test", http: fakeHttp({ ...standardRoutes(), "https://bug-bounty-board.vercel.app/programs.json": { body: JSON.stringify(tiny), contentType: "application/json" } }), now: at(8), force: true, sources: ["community-board"], sleep: async () => undefined });
    expect(r3.checks[0]!.delisted).toBe(0); expect(r3.checks[0]!.notes.join(" ")).toMatch(/treated as incomplete/);
    // restore the full list (hyperlane relisted)
    await runCollection(db.pool, { trigger: "test", startedBy: "test", http: fakeHttp(standardRoutes()), now: at(9), force: true, sources: ["community-board"], sleep: async () => undefined });
    expect((await owner().query("SELECT status FROM bounty_programs WHERE id = $1", [hyper])).rows[0].status).toBe("reported_active");
  });

  it("a changed reward is recorded in history, and a conflicting community figure is kept and flagged", async () => {
    const board = JSON.parse(BOARD_JSON()) as { programs: Array<{ p: string; id: string; max: number }> };
    board.programs.find((x) => x.p === "Sherlock" && x.id === "56")!.max = 20000000;
    await runCollection(db.pool, { trigger: "test", startedBy: "test", http: fakeHttp({ ...standardRoutes(), "https://bug-bounty-board.vercel.app/programs.json": { body: JSON.stringify(board), contentType: "application/json" } }), now: at(10), force: true, sources: ["community-board"], sleep: async () => undefined });
    const p = (await owner().query("SELECT verification, resolved FROM bounty_programs WHERE canonical_key = 'sherlock:56'")).rows[0];
    expect(p.verification).toBe("conflicting");
    expect(p.resolved.maxReward).toMatchObject({ value: 16000000, source: "sherlock", conflicts: [{ value: 20000000, source: "community-board" }] });
  });

  describe("manual import", () => {
    const roundup = `<html><head><title>Roundup</title></head><body><ul>
      <li><a href="https://audits.sherlock.xyz/bug-bounties/56">Usual</a> up to $16M</li>
      <li><a href="https://immunefi.com/bug-bounty/hyperlane/information/">Hyperlane</a> — up to $2.5M</li>
      <li>NewChain Labs bug bounty: up to $75,000, see https://newchain.example/security</li>
      <li>Ordinary news line with no bounty in it.</li></ul></body></html>`;
    const http = () => fakeHttp({ ...standardRoutes(), "https://news.example/robots.txt": { status: 404, body: "" }, "https://news.example/roundup": { body: roundup },
      "https://gone.example/robots.txt": { status: 404, body: "" }, "https://gone.example/page": { status: 404, body: "nope" },
      "https://closed.example/robots.txt": { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" } });

    it("one page gives several opportunities, matched to existing records where they exist, and the report says so", async () => {
      const r = await runImport(db.pool, http(), { url: "https://news.example/roundup?utm_source=x", submittedBy: "operator" }, at(11));
      expect(r).toMatchObject({ status: "succeeded", urlKind: "web_page", retrieved: true, discovered: 3, added: 1, matched: 2 });
      expect(r.items.map((i) => [i.project, i.outcome, i.matchBasis])).toEqual([["Usual Labs", "matched", "canonical_key"], ["Hyperlane", "matched", "canonical_key"], ["NewChain Labs", "added", "new_record"]]);
      expect(r.needsVerification).toBe(3); // Usual (conflicting since the previous test), Hyperlane (community only), NewChain (one web page)
      const imp = (await owner().query("SELECT submitted_url, submitted_by, status, fetched_at IS NOT NULL AS fetched FROM bounty_imports WHERE id = $1", [r.importId])).rows[0];
      expect(imp).toEqual({ submitted_url: "https://news.example/roundup", submitted_by: "operator", status: "succeeded", fetched: true });
      const again = await runImport(db.pool, http(), { url: "https://news.example/roundup", submittedBy: "operator" }, at(11.1));
      expect(again).toMatchObject({ added: 0, discovered: 3 }); // re-importing does not duplicate
      expect(await count("SELECT count(*) AS n FROM bounty_programs WHERE name_key = 'newchain'")).toBe(1);
    });
    it("failures are reported as failures, never as an empty success", async () => {
      expect(await runImport(db.pool, http(), { url: "https://gone.example/page", submittedBy: "operator" }, at(12))).toMatchObject({ status: "failed", retrieved: false, retrieval: "HTTP 404", discovered: 0 });
      expect(await runImport(db.pool, http(), { url: "https://closed.example/page", submittedBy: "operator" }, at(12))).toMatchObject({ status: "blocked", retrieved: false });
      await expect(runImport(db.pool, http(), { url: "http://169.254.169.254/latest/meta-data", submittedBy: "operator" }, at(12))).rejects.toMatchObject({ code: "ip_literal" });
      await expect(runImport(db.pool, http(), { url: "file:///etc/passwd", submittedBy: "operator" }, at(12))).rejects.toMatchObject({ code: "unsupported_protocol" });
    });
    it("X: fetching is off by default and says why; pasted thread text gives several attributed opportunities through the same pipeline", async () => {
      const blocked = await runImport(db.pool, http(), { url: "https://x.com/bountyfeed/status/1866000000000000001", submittedBy: "operator" }, at(13));
      expect(blocked).toMatchObject({ status: "blocked", urlKind: "x_post", retrieved: false });
      expect(blocked.limitations.join(" ")).toMatch(/robots\.txt.*Paste the post or thread text/);
      const profile = await runImport(db.pool, http(), { url: "https://x.com/bountyfeed", submittedBy: "operator" }, at(13));
      expect(profile).toMatchObject({ status: "blocked", urlKind: "x_profile" });
      const text = "Bounties this week 🧵\n1. Hyperlane bug bounty up to $2.5M https://immunefi.com/bug-bounty/hyperlane/information/\n2. ZetaChain bounty up to $150k\n3. Happy Friday!";
      const r = await runImport(db.pool, http(), { url: "https://x.com/bountyfeed/status/1866000000000000001", text, kind: "x_thread", submittedBy: "operator" }, at(13));
      expect(r).toMatchObject({ status: "succeeded", urlKind: "x_thread", discovered: 2, added: 1, matched: 1 });
      const zeta = (await owner().query("SELECT p.verification, p.status, o.source_key, o.source_author, o.source_url FROM bounty_programs p JOIN bounty_observations o ON o.program_id = p.id WHERE p.name_key = 'zetachain'")).rows[0];
      expect(zeta).toEqual({ verification: "social_reported", status: "requires_verification", source_key: "x", source_author: "@bountyfeed", source_url: "https://x.com/bountyfeed/status/1866000000000000001" });
    });
    it("a platform programme URL for a blocked platform is recorded from the URL without fetching it", async () => {
      const h = http();
      const r = await runImport(db.pool, h, { url: "https://immunefi.com/bug-bounty/brand-new-protocol/information/", submittedBy: "operator" }, at(14));
      expect(r).toMatchObject({ urlKind: "platform_programme", retrieved: false, added: 1 });
      expect(r.limitations.join(" ")).toMatch(/Terms of Use/);
      expect(h.calls.some((u) => u.includes("immunefi.com"))).toBe(false);
    });
  });

  describe("any pasted link: the user-initiated fetch policy (owner decision; default respect)", () => {
    // SYNTHETIC oEmbed response (written for this test, not a real post): same format as the recorded X response in fixtures.
    const postUrl = "https://x.com/bountyfeed/status/1866000000000000009";
    const oembed = JSON.stringify({ url: postUrl, author_name: "Bounty Feed", author_url: "https://x.com/bountyfeed",
      html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">New: Hyperlane bug bounty up to $2.5M <a href="https://t.co/hyp">immunefi.com/bug-bounty/hy…</a></p>&mdash; Bounty Feed (@bountyfeed) <a href="' + postUrl + '">November 26, 2026</a></blockquote>' });
    const routes = () => fakeHttp({ ...standardRoutes(),
      "https://blocked.example/robots.txt": { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" },
      "https://blocked.example/roundup": { body: '<html><head><title>Roundup</title></head><body><a href="https://audits.sherlock.xyz/bug-bounties/56">Usual</a> up to $16M</body></html>' },
      [`https://publish.x.com/oembed?url=${encodeURIComponent(postUrl)}&omit_script=1&dnt=true`]: { body: oembed, contentType: "application/json" },
      "https://t.co/hyp": { status: 301, body: "", location: "https://immunefi.com/bug-bounty/hyperlane/information/" },
      "https://t.co/post": { status: 301, body: "", location: postUrl } });

    it("a page whose robots.txt disallows crawlers: blocked under 'respect', fetched once and labelled under 'user_initiated'", async () => {
      expect(await runImport(db.pool, routes(), { url: "https://blocked.example/roundup", submittedBy: "operator" }, at(13.5), "respect")).toMatchObject({ status: "blocked", retrieved: false });
      const r = await runImport(db.pool, routes(), { url: "https://blocked.example/roundup", submittedBy: "operator" }, at(13.5), "user_initiated");
      expect(r).toMatchObject({ status: "succeeded", retrieved: true, discovered: 1, matched: 1 });
      expect(r.limitations.join(" ")).toMatch(/robots\.txt disallows crawlers here .*user-initiated import policy/);
    });
    it("an X post: read through oEmbed, its t.co links expanded, matched by platform link and attributed to the author", async () => {
      expect(await runImport(db.pool, routes(), { url: postUrl, submittedBy: "operator" }, at(13.6), "respect")).toMatchObject({ status: "blocked" });
      const h = routes();
      const r = await runImport(db.pool, h, { url: postUrl, submittedBy: "operator" }, at(13.6), "user_initiated");
      expect(r).toMatchObject({ status: "succeeded", urlKind: "x_post", retrieved: true, retrieval: "one post through X's oEmbed endpoint", discovered: 1, matched: 1 });
      expect(r.items[0]).toMatchObject({ project: "Hyperlane", matchBasis: "canonical_key" });
      expect(h.calls).toContain("https://t.co/hyp");
      const o = (await owner().query("SELECT source_author, published_at FROM bounty_observations WHERE source_key = 'x' AND source_url = $1", [postUrl])).rows[0];
      expect(o.source_author).toBe("Bounty Feed (@bountyfeed)");
    });
    it("a pasted short link is expanded to the post it points to", async () => {
      const r = await runImport(db.pool, routes(), { url: "https://t.co/post", submittedBy: "operator" }, at(13.7), "user_initiated");
      expect(r).toMatchObject({ urlKind: "x_post", status: "succeeded", matched: 1 });
      expect(r.limitations.join(" ")).toMatch(/short link https:\/\/t\.co\/post expanded to https:\/\/x\.com\/bountyfeed\/status\/1866000000000000009/);
    });
    it("an X profile stays text-only under either policy (no API access)", async () => {
      expect(await runImport(db.pool, routes(), { url: "https://x.com/bountyfeed", submittedBy: "operator" }, at(13.8), "user_initiated")).toMatchObject({ status: "blocked", urlKind: "x_profile" });
    });
  });

  it("corrections are recorded with their author and win, with history; merging duplicates keeps every source", async () => {
    const zeta = (await owner().query("SELECT id FROM bounty_programs WHERE name_key = 'zetachain'")).rows[0].id;
    await expect(addCorrection(db.pool, zeta, { field: "maxReward", value: 200000, note: "", by: "operator" })).rejects.toMatchObject({ code: "note_required" });
    const r = await addCorrection(db.pool, zeta, { field: "maxReward", value: 200000, note: "checked the project's security page", by: "operator" }, at(15)());
    expect(r.resolved.maxReward).toMatchObject({ value: 200000, source: "operator", conflicts: [{ value: 150000, source: "x" }] });
    expect(await count("SELECT count(*) AS n FROM bounty_program_changes WHERE program_id = $1 AND field = 'maxReward'", [zeta])).toBe(1);
    const cand = (await owner().query("SELECT d.id, d.program_a, d.program_b FROM bounty_duplicate_candidates d WHERE d.status = 'open' ORDER BY created_at LIMIT 1")).rows[0];
    expect(cand).toBeTruthy();
    const before = await count("SELECT count(*) AS n FROM bounty_observations WHERE program_id IN ($1, $2)", [cand.program_a, cand.program_b]);
    const m = await decideDuplicate(db.pool, cand.id, "merge", "operator", at(16)());
    expect(await count("SELECT count(*) AS n FROM bounty_observations WHERE program_id = $1", [m.survivor])).toBe(before);
    expect(await count("SELECT count(*) AS n FROM bounty_programs WHERE merged_into = $1", [m.survivor])).toBe(1);
    await expect(decideDuplicate(db.pool, cand.id, "reject", "operator")).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("the API: operator routes need the token, the public feed does not and carries no descriptions or import text", async () => {
    const app = buildApp({ pool: db.pool, apiBearerToken: TOKEN, hubAllowedHosts: [], limiter: new AuthFailureLimiter({ perClientMax: 1000, globalMax: 1000, windowMs: 60_000 }), engineInfo: { expectedMigrations: null }, bounties: { http: fakeHttp(standardRoutes()), publicCacheMs: 0 } });
    try {
      expect((await app.inject({ method: "GET", url: "/v1/bounties" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/v1/bounties/imports", payload: { url: "https://news.example/x" } })).statusCode).toBe(401);
      const auth = { authorization: `Bearer ${TOKEN}` };
      const list = await app.inject({ method: "GET", url: "/v1/bounties?chain=Ethereum&sort=reward&limit=5", headers: auth });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { total: number; items: Array<{ reward: string; resolved: { chains: { value: string[] } } }> };
      expect(body.items).toHaveLength(5);
      expect(body.items.every((i) => i.resolved.chains.value.includes("Ethereum"))).toBe(true);
      const rewards = body.items.map((i) => Number(i.reward)); expect([...rewards].sort((a, b) => b - a)).toEqual(rewards);
      expect((await app.inject({ method: "GET", url: "/v1/bounties?verification=official_confirmed&limit=500", headers: auth })).json().items.every((i: { verification: string }) => i.verification === "official_confirmed")).toBe(true);
      expect((await app.inject({ method: "GET", url: "/v1/bounties?sort=bogus", headers: auth })).statusCode).toBe(400);
      const id = body.items[0] as unknown as { id: string };
      const detail = (await app.inject({ method: "GET", url: `/v1/bounties/${id.id}`, headers: auth })).json();
      expect(detail.observations.length).toBeGreaterThan(0); expect(Array.isArray(detail.changes)).toBe(true);
      const h = (await app.inject({ method: "GET", url: "/v1/bounties/health", headers: auth })).json();
      expect(h.sources.find((s: { source_key: string }) => s.source_key === "immunefi")).toMatchObject({ access_status: "blocked_terms", enabled: false });
      const bad = await app.inject({ method: "POST", url: "/v1/bounties/imports", headers: auth, payload: { url: "https://localhost/admin" } });
      expect(bad.statusCode).toBe(400); expect(bad.json().error).toBe("private_host");
      const pub = await app.inject({ method: "GET", url: "/public/bounties.json" });
      expect(pub.statusCode).toBe(200);
      const feed = pub.json() as { programmes: Array<Record<string, unknown>>; overview: Record<string, number>; sources: unknown[] };
      expect(feed.programmes.length).toBe(feed.overview.total);
      expect(JSON.stringify(feed)).not.toMatch(/"description"|submitted_text|correctionNote|checked the project's security page/);
      expect(feed.programmes[0]).toHaveProperty("explanation");
      const direct = await publicFeed(db.pool) as { programmes: unknown[] };
      expect(direct.programmes.length).toBe(await count("SELECT count(*) AS n FROM bounty_programs WHERE merged_into IS NULL"));
    } finally { await app.close(); } // closes the pool: keep this the last test
  });
});
