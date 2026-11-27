import { describe, expect, it } from "vitest";
import { classifyTags, communityBoard, hackenproof, parseBoard, parseHackenproofPage, parseSherlock, sherlock, ADAPTERS } from "./adapters.js";
import { canonicalFromUrl, nameKey, normaliseUrl } from "./canonical.js";
import { classifyXUrl, cleanTitle, embeddedData, extractOpportunities, htmlToDocument, parseOembed } from "./extract.js";
import { assertPublicHttpUrl, createHttpGet, robotsAllows } from "./http.js";
import { amountsIn, parseTierText, usdComparable } from "./money.js";
import { scoreProgramme, SCORING_VERSION } from "./rank.js";
import { resolveProgramme, type ObservationInput } from "./resolve.js";
import { BOARD_JSON, EMPTY_HP_PAGE, fakeHttp, fixture, HACKENPROOF_HTML, SHERLOCK_HTML, standardRoutes } from "./testing/fixtures.js";
import { BountyError } from "./types.js";

const ctx = () => ({ robots: new Map<string, string | null>(), sleep: async () => undefined });

describe("source adapters on real captured content (2026-11-27)", () => {
  it("community board: every listing is extracted with attribution, rewards as stated and nothing invented", () => {
    const b = parseBoard(JSON.parse(BOARD_JSON()));
    expect(b.items).toHaveLength(388);
    expect(b.declaredCounts).toEqual({ Immunefi: 143, Cantina: 46, Sherlock: 41, HackenProof: 158 });
    const root = b.items.find((i) => i.sourceRef === "immunefi:rootstocklabs")!;
    expect(root).toMatchObject({ projectName: "RootstockLabs", platform: "Immunefi", officialUrl: "https://immunefi.com/bug-bounty/rootstocklabs/information", maxReward: 200000, rewardCurrency: "USD", kycRequired: true, rewardType: "percentage_capped" });
    expect(root.tiers[0]).toMatchObject({ severity: "critical", asset: "Blockchain dlt", min: 10000, max: 200000 });
    const monolith = b.items.find((i) => i.sourceRef === "sherlock:287")!;
    expect(monolith.otherUrls).toEqual(["https://mantis.inverse.finance/bounties/inversefinance/monolith-stablecoin-factory"]);
    expect(monolith.tiers.every((t) => t.min === null && t.max === null)).toBe(true); // "Stake $250" is a deposit, not a reward
    expect(monolith.submissionFee).toEqual({ amount: 250, note: "refundable stake per report" });
    const uni = b.items.find((i) => i.programmeName === "Uniswap")!;
    expect(uni.projectName).toBe("Uniswap Labs");
    expect(uni.tiers.every((t) => t.max === null)).toBe(true); // "See program" is not an amount
  });
  it("community board: missing fields stay null and malformed or duplicate listings are reported, not guessed", () => {
    const b = parseBoard({ programs: [{ p: "Immunefi", id: "x", name: "X", tags: [], tiers: [] }, { p: "Immunefi", id: "x", name: "X again" }, { id: "nope" }] });
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ maxReward: null, officialUrl: null, rewardCurrency: null, kycRequired: null, unresolved: ["maxReward", "officialUrl"] });
    expect(b.problems).toEqual(["duplicate listing immunefi:x in one file", "skipped a listing without platform, id or name"]);
    expect(() => parseBoard({ nothing: true })).toThrow(/no programs array/);
  });
  it("Sherlock: the listing data embedded in the page is read, including tiers from the programme's own text", () => {
    const s = parseSherlock(SHERLOCK_HTML());
    expect(s.items).toHaveLength(41);
    const usual = s.items.find((i) => i.sourceRef === "sherlock:56")!;
    expect(usual).toMatchObject({ projectName: "Usual Labs", officialUrl: "https://audits.sherlock.xyz/bug-bounties/56", maxReward: 16000000, rewardCurrency: "USDC", categories: ["Stablecoins", "Tokenization"] });
    expect(usual.tiers[0]).toMatchObject({ severity: "critical", max: 16000000 });
    expect(usual.tiers[1]).toMatchObject({ severity: "high", min: null, max: null }); // "Discretionary"
    expect(() => parseSherlock("<html>changed layout</html>")).toThrow(/does not contain the bug-bounties listing data/);
  });
  it("HackenProof: server-rendered cards give name, link, status, dates and the stated maximum", () => {
    const h = parseHackenproofPage(HACKENPROOF_HTML());
    expect(h).toHaveLength(10);
    expect(h.find((x) => x.sourceRef === "hackenproof:redstone-smart-contracts")).toMatchObject({ projectName: "RedStone", maxReward: 250000, statusClaim: "active", launchedAt: "2026-10-22", sourceUpdatedAt: "2026-10-30" });
    expect(parseHackenproofPage(EMPTY_HP_PAGE)).toEqual([]);
  });
  it("tags are split into chains, asset types and technologies without dropping unknown ones", () => {
    expect(classifyTags(["ETH", "Arbitrum", "Smart Contracts", "Websites & apps", "Solidity", "Lending", "smart contracts"])).toEqual({ chains: ["Ethereum", "Arbitrum"], assetTypes: ["Smart Contracts", "Websites & apps"], technologies: ["Solidity", "Lending"] });
  });
});

describe("adapter fetch behaviour", () => {
  it("a fetched source reports complete listings; an empty answer is ok-but-empty, not failure and not 'everything closed'", async () => {
    const ok = await communityBoard.retrieve(fakeHttp(standardRoutes()), ctx());
    expect(ok).toMatchObject({ ok: true, complete: true, pages: 1 });
    const empty = await communityBoard.retrieve(fakeHttp({ ...standardRoutes(), "https://bug-bounty-board.vercel.app/programs.json": { body: '{"programs":[]}', contentType: "application/json" } }), ctx());
    expect(empty).toMatchObject({ ok: true, complete: false, items: [] });
  });
  it("server errors and rate limits are retryable failures; a changed page layout is a non-retryable failure", async () => {
    const r500 = await sherlock.retrieve(fakeHttp({ ...standardRoutes(), "https://audits.sherlock.xyz/bug-bounties": { status: 503, body: "" } }), ctx());
    expect(r500).toMatchObject({ ok: false, httpStatus: 503, retryable: true });
    const r429 = await communityBoard.retrieve(fakeHttp({ ...standardRoutes(), "https://bug-bounty-board.vercel.app/programs.json": { status: 429, body: "" } }), ctx());
    expect(r429).toMatchObject({ ok: false, retryable: true });
    const changed = await sherlock.retrieve(fakeHttp({ ...standardRoutes(), "https://audits.sherlock.xyz/bug-bounties": { body: "<html></html>" } }), ctx());
    expect(changed).toMatchObject({ ok: false, retryable: false });
  });
  it("robots.txt is honoured before fetching: a disallow stops the request", async () => {
    const http = fakeHttp({ ...standardRoutes(), "https://audits.sherlock.xyz/robots.txt": { body: "User-agent: *\nDisallow: /bug-bounties\n", contentType: "text/plain" } });
    expect(await sherlock.retrieve(http, ctx())).toMatchObject({ ok: false });
    expect(http.calls).toEqual(["https://audits.sherlock.xyz/robots.txt"]);
  });
  it("HackenProof paginates politely until a page has no new programmes", async () => {
    const sleeps: number[] = [];
    const http = fakeHttp(standardRoutes());
    const r = await hackenproof.retrieve(http, { robots: new Map(), sleep: async (ms) => { sleeps.push(ms); } });
    expect(r).toMatchObject({ ok: true, complete: true, pages: 2 });
    expect(sleeps).toEqual([2000]);
  });
  it("blocked sources never fetch", async () => {
    const http = fakeHttp({});
    for (const k of ["immunefi", "cantina"]) { expect(ADAPTERS[k]!.blocked).toMatch(/robots|Terms/); expect(await ADAPTERS[k]!.retrieve(http, ctx())).toMatchObject({ ok: false, retryable: false }); }
    expect(http.calls).toEqual([]);
  });
});

describe("rewards and identity", () => {
  it("amounts are read only where written", () => {
    expect(amountsIn("up to $2.5M for criticals, $10,000 for highs")).toEqual([2500000, 10000]);
    expect(amountsIn("250,000 USDC max")).toEqual([250000]);
    expect(amountsIn("Discretionary")).toEqual([]);
    expect(parseTierText("$10,000 – $200,000 (10% of funds at risk)")).toEqual({ min: 10000, max: 200000 });
    expect(parseTierText("$2,500 flat")).toEqual({ min: 2500, max: 2500 });
    expect(parseTierText("See program")).toEqual({ min: null, max: null });
    expect(usdComparable(100, "USDC + rEUL")).toBe(100);
    expect(usdComparable(100, "EUL")).toBeNull();
    expect(usdComparable(100, null)).toBeNull();
  });
  it("canonical keys come only from recognised programme URLs", () => {
    expect(canonicalFromUrl("https://immunefi.com/bug-bounty/hyperlane/information/")?.key).toBe("immunefi:hyperlane");
    expect(canonicalFromUrl("https://www.cantina.security/bounties/f9df94db-c7b1-434b-bb06-d1360abdd1be")?.key).toBe("cantina:f9df94db-c7b1-434b-bb06-d1360abdd1be");
    expect(canonicalFromUrl("https://audits.sherlock.xyz/bug-bounties/287")?.key).toBe("sherlock:287");
    expect(canonicalFromUrl("https://hackenproof.com/programs/redstone-smart-contracts")?.key).toBe("hackenproof:redstone-smart-contracts");
    expect(canonicalFromUrl("https://immunefi.com/")).toBeNull();
    expect(canonicalFromUrl("https://evil.example/bug-bounty/hyperlane")).toBeNull();
    expect(normaliseUrl("https://twitter.com/foo/status/123?s=20&t=abc#x")).toBe("https://x.com/foo/status/123");
    expect(nameKey("Uniswap Labs Bug Bounty")).toBe(nameKey("uniswap"));
    expect(nameKey("Aave")).not.toBe(nameKey("Aavegotchi"));
  });
});

describe("extraction from pages and posts (synthetic inputs)", () => {
  const roundup = `<html><head><title>Weekly bounty roundup</title><script>alert(1)</script></head><body>
    <h1>New bug bounties this week</h1>
    <ul>
      <li><a href="https://immunefi.com/bug-bounty/hyperlane/information/">Hyperlane</a> — up to $2,500,000</li>
      <li><a href="https://audits.sherlock.xyz/bug-bounties/287?utm_source=x">Monolith Stablecoin Factory</a> pays up to $20,000</li>
      <li>Acme Protocol bug bounty: up to $50k, details at https://acme.example/security/bug-bounty</li>
      <li>Our team went to a conference in Lisbon.</li>
    </ul></body></html>`;
  it("one page gives several opportunities; unrelated text gives none; scripts are ignored", () => {
    const d = htmlToDocument(roundup, "https://news.example/roundup");
    expect(d.title).toBe("Weekly bounty roundup");
    const ex = extractOpportunities({ ...d, baseUrl: "https://news.example/roundup", author: null, publishedAt: null }, "https://news.example/roundup");
    expect(ex.items.map((o) => [o.projectName, o.officialUrl, o.maxReward])).toEqual([
      ["Hyperlane", "https://immunefi.com/bug-bounty/hyperlane/information", 2500000],
      ["Monolith Stablecoin Factory", "https://audits.sherlock.xyz/bug-bounties/287", 20000],
      ["Acme Protocol", "https://acme.example/security/bug-bounty", 50000],
    ]);
    expect(ex.items[2]!.unresolved).toContain("platform");
    expect(extractOpportunities({ text: "We shipped v2 today. Thanks everyone!", links: [], baseUrl: null, author: null, publishedAt: null, title: null }, "t").items).toEqual([]);
  });
  it("a real listing page imported as a web page: every item is a linked programme, no card text becomes a fake programme", () => {
    const d = htmlToDocument(HACKENPROOF_HTML(), "https://hackenproof.com/programs");
    const ex = extractOpportunities({ ...d, baseUrl: "https://hackenproof.com/programs", author: null, publishedAt: null, title: d.title }, "https://hackenproof.com/programs");
    expect(ex.items.length).toBeGreaterThanOrEqual(10);
    expect(ex.items.every((o) => canonicalFromUrl(o.officialUrl)?.platform === "hackenproof")).toBe(true);
    expect(ex.items.map((o) => o.projectName)).not.toContain("Up to");
  });
  it("an X thread pasted as text: several opportunities, each attributed to the thread", () => {
    const thread = "🧵 Top bug bounties this week:\n1. @LidoFinance bug bounty — up to $2M on Immunefi https://immunefi.com/bug-bounty/lido/\n2) Kamino: up to $1.5M https://audits.sherlock.xyz/bug-bounties/77\n3. GM everyone, coffee time\n4. ZetaChain bounty up to $150k";
    const ex = extractOpportunities({ text: thread, links: [], baseUrl: "https://x.com/someone/status/1", author: "@someone", publishedAt: null, title: null }, "https://x.com/someone/status/1");
    expect(ex.items.map((o) => [o.projectName, o.platform, o.maxReward])).toEqual([["LidoFinance", "Immunefi", 2000000], ["Kamino", "Sherlock", 1500000], ["ZetaChain", null, 150000]]);
    expect(ex.items.every((o) => o.sourceAuthor === "@someone")).toBe(true);
  });
  it("X URLs are classified; oEmbed responses give text, author and date", () => {
    expect(classifyXUrl("https://twitter.com/immunefi/status/1861111111111111111?s=20")).toMatchObject({ kind: "x_post", handle: "immunefi" });
    expect(classifyXUrl("https://x.com/immunefi")).toMatchObject({ kind: "x_profile" });
    expect(classifyXUrl("https://x.com/home")).toBeNull();
    expect(classifyXUrl("https://example.com/immunefi")).toBeNull();
    const d = parseOembed(JSON.parse(fixture("x-oembed-jack-20.json")), "https://x.com/jack/status/20");
    expect(d).toMatchObject({ text: "just setting up my twttr", author: "jack (@jack)", publishedAt: "2006-03-21" });
    expect(extractOpportunities(d, "x").items).toEqual([]);
  });
  it("shortened links that cannot be expanded are reported", () => {
    const ex = extractOpportunities({ text: "Hyperlane bug bounty up to $2.5M immunefi.com/bug-bounty/hy…", links: [{ href: "https://t.co/abc", text: "immunefi.com/bug-bounty/hy…" }], baseUrl: null, author: null, publishedAt: null, title: null }, "x");
    expect(ex.unresolvedLinks).toHaveLength(1);
  });
});

describe("any pasted link: pages built by JavaScript and single programme pages (synthetic inputs)", () => {
  const spa = `<html><head><title>Bounties | Example Directory</title><meta property="og:description" content="Live bug bounty programmes">
    <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"programs":[
      {"name":"Hyperlane","url":"https://immunefi.com/bug-bounty/hyperlane/information/","maxBounty":2500000},
      {"name":"Usual","url":"https://audits.sherlock.xyz/bug-bounties/56","tvl":9000000000},
      {"name":"Not a programme","url":"https://example.org/blog/post"}]}}}</script>
    <script type="application/ld+json">{"@type":"WebPage","name":"Example Directory"}</script>
    <script>window.evil = "alert(1)"</script></head><body><div id="root"></div></body></html>`;
  it("reads the data a JavaScript page carries (JSON is parsed, never run); rewards only from bounty-named fields", () => {
    const e = embeddedData(spa, "https://dir.example/");
    expect(e.lines).toContain("Live bug bounty programmes");
    expect(e.lines).toContain("Hyperlane: reward up to $2,500,000 https://immunefi.com/bug-bounty/hyperlane/information/");
    expect(e.lines).toContain("Usual https://audits.sherlock.xyz/bug-bounties/56"); // tvl is not a reward
    const d = htmlToDocument(spa, "https://dir.example/");
    const ex = extractOpportunities({ ...d, baseUrl: "https://dir.example/", author: null, publishedAt: null }, "p", { page: "https://dir.example/" });
    expect(ex.items.map((o) => [o.projectName, o.officialUrl, o.maxReward])).toEqual([
      ["Hyperlane", "https://immunefi.com/bug-bounty/hyperlane/information", 2500000],
      ["Usual", "https://audits.sherlock.xyz/bug-bounties/56", null],
    ]);
  });
  it("a single programme or security page is one opportunity named from its title; its own links are not other programmes", () => {
    const page = `<html><head><title>Acme Finance Bug Bounty Program | Acme</title></head><body><h1>Security</h1>
      <p>Our bug bounty pays up to $75,000 for critical smart contract vulnerabilities.</p><p>High: $10,000.</p>
      <a href="/security#scope">Scope</a></body></html>`;
    const d = htmlToDocument(page, "https://acme.example/security");
    const ex = extractOpportunities({ ...d, baseUrl: "https://acme.example/security", author: null, publishedAt: null }, "p", { page: "https://acme.example/security" });
    expect(ex.items.map((o) => [o.projectName, o.officialUrl, o.maxReward, o.rewardType])).toEqual([["Acme Finance", "https://acme.example/security", 75000, "up_to"]]);
    const own = `<html><head><title>Usual Labs Bug Bounty - Sherlock</title></head><body><a href="https://audits.sherlock.xyz/bug-bounties/56?tab=submission">Report a bug</a></body></html>`;
    const d2 = htmlToDocument(own, "https://audits.sherlock.xyz/bug-bounties/56");
    const ex2 = extractOpportunities({ ...d2, baseUrl: "https://audits.sherlock.xyz/bug-bounties/56", author: null, publishedAt: null }, "p", { page: "https://audits.sherlock.xyz/bug-bounties/56" });
    expect(ex2.items.map((o) => [o.projectName, o.officialUrl])).toEqual([["Usual Labs", "https://audits.sherlock.xyz/bug-bounties/56"]]);
  });
  it("says so when a page mentions a bounty but carries no data, instead of inventing one", () => {
    const shell = `<html><head><title>Bug bounties built for the AI era | Cantina</title></head><body><div id="app"></div></body></html>`;
    const d = htmlToDocument(shell, "https://www.cantina.security/bounties");
    const ex = extractOpportunities({ ...d, baseUrl: "https://www.cantina.security/bounties", author: null, publishedAt: null }, "p", { page: "https://www.cantina.security/bounties" });
    expect(ex.items).toEqual([]);
    expect(ex.pageNote).toMatch(/carries no programme data in its HTML/);
  });
  it("cleans page titles into names", () => {
    expect(cleanTitle("RedStone Smart Contracts: Program Info | HackenProof")).toBe("RedStone Smart Contracts");
    expect(cleanTitle("Usual Labs Bug Bounty - Sherlock")).toBe("Usual Labs");
    expect(cleanTitle("Bug Bounty | Somewhere")).toBeNull();
    expect(cleanTitle(null)).toBeNull();
  });
});

const obs = (o: Partial<ObservationInput> & Pick<ObservationInput, "sourceKey" | "sourceKind" | "authority">): ObservationInput => ({
  id: `${o.sourceKey}-1`, listed: true, firstObservedAt: "2026-11-27T00:00:00.000Z", lastObservedAt: "2026-11-27T00:00:00.000Z", sourceUrl: null, fields: {}, ...o,
});
const NOW = new Date("2026-11-27T12:00:00.000Z");

describe("verification and status", () => {
  it("official information wins, a different community figure is kept as a conflict and blocks 'confirmed'", () => {
    const r = resolveProgramme([
      obs({ sourceKey: "community-board", sourceKind: "community_index", authority: 4, fields: { projectName: "Kamino", maxReward: 1500000, rewardCurrency: "USD" } }),
      obs({ sourceKey: "sherlock", sourceKind: "official_platform", authority: 3, fields: { projectName: "Kamino", maxReward: 1000000, rewardCurrency: "USD" } }),
    ], NOW);
    expect(r.resolved.maxReward).toMatchObject({ value: 1000000, source: "sherlock", conflicts: [{ value: 1500000, source: "community-board" }] });
    expect(r.verification).toBe("conflicting");
    expect(r.status).toBe("active");
  });
  it("USD-pegged currencies are not a conflict, and a post that disagrees is recorded without downgrading the official record", () => {
    const r = resolveProgramme([
      obs({ sourceKey: "sherlock", sourceKind: "official_platform", authority: 3, fields: { projectName: "U", maxReward: 16000000, rewardCurrency: "USDC" } }),
      obs({ sourceKey: "x", sourceKind: "social", authority: 5, fields: { projectName: "U", maxReward: 20000000, rewardCurrency: "USD" } }),
    ], NOW);
    expect(r.resolved.rewardCurrency!.conflicts).toEqual([]);
    expect(r.resolved.maxReward!.conflicts).toEqual([{ value: 20000000, source: "x", authority: 5 }]);
    expect(r.verification).toBe("official_confirmed");
  });
  it("community-only stays community-reported; an old official check is stale; a delisting is recorded", () => {
    expect(resolveProgramme([obs({ sourceKey: "community-board", sourceKind: "community_index", authority: 4, fields: { projectName: "A", maxReward: 5 } })], NOW))
      .toMatchObject({ verification: "community_reported", status: "reported_active", needsVerification: true });
    expect(resolveProgramme([obs({ sourceKey: "sherlock", sourceKind: "official_platform", authority: 3, lastObservedAt: "2026-11-20T00:00:00.000Z", fields: { projectName: "A", maxReward: 5 } })], NOW))
      .toMatchObject({ verification: "official_stale" });
    expect(resolveProgramme([obs({ sourceKey: "sherlock", sourceKind: "official_platform", authority: 3, listed: false, fields: { projectName: "A" } })], NOW))
      .toMatchObject({ status: "no_longer_listed" });
    expect(resolveProgramme([obs({ sourceKey: "hackenproof", sourceKind: "official_platform", authority: 3, fields: { projectName: "A", statusClaim: "closed" } })], NOW))
      .toMatchObject({ status: "closed", verification: "official_confirmed" });
  });
  it("a post alone never becomes active or confirmed; an operator correction wins and says so", () => {
    expect(resolveProgramme([obs({ sourceKey: "x", sourceKind: "social", authority: 5, fields: { projectName: "Z", maxReward: 150000 } })], NOW))
      .toMatchObject({ verification: "social_reported", status: "requires_verification" });
    const r = resolveProgramme([
      obs({ sourceKey: "community-board", sourceKind: "community_index", authority: 4, fields: { projectName: "A", maxReward: 5 } }),
      obs({ sourceKey: "operator", sourceKind: "operator", authority: 0, fields: { statusClaim: "closed", maxReward: 7 } }),
    ], NOW);
    expect(r).toMatchObject({ status: "closed" });
    expect(r.statusBasis).toMatch(/operator correction/);
    expect(r.resolved.maxReward).toMatchObject({ value: 7, source: "operator", conflicts: [{ value: 5 }] });
  });
});

describe("ranking", () => {
  const confirmed = resolveProgramme([obs({ sourceKey: "sherlock", sourceKind: "official_platform", authority: 3, fields: { projectName: "Usual", maxReward: 16000000, rewardCurrency: "USDC", tiers: [{ severity: "critical", asset: null, text: "$16M", min: 16000000, max: 16000000 }], officialUrl: "https://audits.sherlock.xyz/bug-bounties/56", chains: ["Ethereum"], assetTypes: ["Smart contract"], sourceUpdatedAt: "2026-11-20" } })], NOW);
  it("is deterministic and explains every component", () => {
    const a = scoreProgramme(confirmed, { now: NOW, firstSeenAt: NOW.toISOString(), sourceCount: 1 });
    expect(scoreProgramme(confirmed, { now: NOW, firstSeenAt: NOW.toISOString(), sourceCount: 1 })).toEqual(a);
    expect(a.version).toBe(SCORING_VERSION);
    expect(a.components.reward.score).toBe(100); expect(a.components.credibility.score).toBe(100); expect(a.components.completeness.score).toBe(100);
    expect(a.explanation.join("\n")).toMatch(/reward 100 × 0.35: stated maximum 16,000,000 USD-equivalent/);
  });
  it("never invents a reward: unknown or non-dollar amounts are not scored, and too little data gives no priority", () => {
    const none = resolveProgramme([obs({ sourceKey: "x", sourceKind: "social", authority: 5, fields: { projectName: "Z" } })], NOW);
    const s = scoreProgramme(none, { now: NOW, firstSeenAt: NOW.toISOString(), sourceCount: 1 });
    expect(s.components.reward).toEqual({ score: null, why: "no maximum reward is stated" });
    expect(s.components.suitability.score).toBeNull();
    const eul = resolveProgramme([obs({ sourceKey: "community-board", sourceKind: "community_index", authority: 4, fields: { projectName: "E", maxReward: 100000, rewardCurrency: "EUL" } })], NOW);
    expect(scoreProgramme(eul, { now: NOW, firstSeenAt: NOW.toISOString(), sourceCount: 1 }).components.reward.score).toBeNull();
  });
  it("a recovery bounty is not ranked as a vulnerability opportunity", () => {
    const rec = resolveProgramme([obs({ sourceKey: "hackenproof", sourceKind: "official_platform", authority: 3, fields: { projectName: "Bitmart Post-Incident Forensics Bounty Hunt", maxReward: 58000000, rewardCurrency: "USD", assetTypes: ["Smart contract"] } })], NOW);
    const s = scoreProgramme(rec, { now: NOW, firstSeenAt: NOW.toISOString(), sourceCount: 1 });
    expect(s.priority).toBe(40); expect(s.components.suitability.score).toBe(5);
    expect(s.explanation.join("\n")).toMatch(/capped at 40/);
  });
});

describe("URL safety", () => {
  it.each([
    ["http://localhost/x", "private_host"], ["https://127.0.0.1/", "ip_literal"], ["https://[::1]/", "ip_literal"], ["https://169.254.169.254/latest/meta-data", "ip_literal"],
    ["https://metadata.google.internal/", "private_host"], ["file:///etc/passwd", "unsupported_protocol"], ["ftp://example.com/", "unsupported_protocol"],
    ["https://user:pass@example.com/", "credentials_in_url"], ["https://example.com:8443/", "port_blocked"], ["https://intranet/", "private_host"], ["not a url", "invalid_url"],
  ])("%s is refused (%s)", (url, code) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(expect.objectContaining({ code }));
  });
  it("a redirect to a private destination is refused at the hop", async () => {
    const get = createHttpGet({ NODE_ENV: "test" }, { fetchImpl: (async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } })) as typeof fetch });
    await expect(get("https://public.example/start")).rejects.toMatchObject({ code: "ip_literal" });
  });
  it("oversized responses are cut off, and the development proxy transport is refused in production", async () => {
    const get = createHttpGet({ NODE_ENV: "test" }, { fetchImpl: (async () => new Response("x".repeat(5000))) as typeof fetch });
    await expect(get("https://public.example/big", { maxBytes: 1000 })).rejects.toMatchObject({ code: "response_too_large" });
    expect(() => createHttpGet({ NODE_ENV: "production", BOUNTY_TRANSPORT: "env-proxy" })).toThrow(BountyError);
  });
  it("robots.txt rules follow RFC 9309 longest-match", () => {
    expect(robotsAllows(fixture("x-robots.txt"), "/immunefi/status/1").allowed).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /oembed\n", "/oembed").allowed).toBe(false);
    expect(robotsAllows(fixture("cantina-robots.txt"), "/api/v0/bounties").allowed).toBe(false);
    expect(robotsAllows(fixture("cantina-robots.txt"), "/bounties").allowed).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /a\nAllow: /a/b\n", "/a/b/c").allowed).toBe(true);
    expect(robotsAllows("", "/anything").allowed).toBe(true);
  });
});
