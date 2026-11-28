# Bounty intelligence collection (Workstream A)

Status 2026-11-27: **built, tested, and demonstrated end to end against real sources on a local database and server.
Not deployed. Production shows nothing until the activation approval in section 7 is given.**

This system is separate from the private research engine. It collects public programme information only. It never creates a
research run, scans or probes a target, submits anything, or calls an AI model.

## 1. What exists

| Part | Where | State |
|---|---|---|
| Central data model: sources, observations, programmes, field history, duplicate candidates, versioned scores, collection runs and per-source checks, imports | `db/migrations/0011_bounty_intelligence.sql` | Written; applied locally only. Depends on nothing outside itself, so it applies to production's 0001–0007 **without 0008** (shown in section 4) |
| Source adapters | `apps/api/src/bounties/adapters.ts` | Community board, Sherlock and HackenProof work on live data; Immunefi and Cantina are registered as blocked and never fetched |
| Pipeline: fetch, extract, normalise, match, resolve, store, delist, score | `collect.ts`, `store.ts`, `resolve.ts`, `rank.ts` | Working |
| Manual import (URL and pasted text, X included) | `import.ts`, `extract.ts` | Working |
| Operator API (bearer) | `GET /v1/bounties`, `/overview`, `/health`, `/imports`, `/duplicates`, `/:id`; `POST /v1/bounties/imports`, `/collect`, `/:id/corrections`, `/duplicates/:id/merge or reject` | Working |
| Public read-only feed | `GET /public/bounties.json` (60 s in-memory cache; programme facts and provenance links only) | Working |
| Public dashboard | `/bounties/` (`apps/web/src/public-bounties.ts`) | Working |
| Operator screens | hub `#/bounties/import`, `/health`, `/duplicates`, `/records` | Working |
| One-shot collector (what a schedule runs) | `npm run bounties:collect` (`dist/apps/api/src/bounties/collect-main.js`) | Working |

## 2. Sources and access (checked 2026-11-27)

| Source | Method | Access finding | Default |
|---|---|---|---|
| Community board, bug-bounty-board.vercel.app | `GET /programs.json` (the board's own data file) | No terms published; robots.txt answers 404, which means no restriction. Owner approved it as a first-class source on 2026-11-27 | **enabled** |
| Sherlock | `GET audits.sherlock.xyz/bug-bounties` (reads the listing data embedded in the public page; 1 request) | robots.txt disallows nothing; no terms page found (404 at sherlock.xyz/terms and audits.sherlock.xyz/terms) | off, **owner decision** |
| HackenProof | `GET hackenproof.com/programs?page=N` (35 pages, 2 s apart, every 6 h) | robots.txt `Allow: /`. The terms give a personal-use licence and forbid reproducing or publishing Content without written permission | off, **owner decision** (internal use looks acceptable; public display is the question) |
| Immunefi | none | Terms of Use section 4 forbid robots and automated access | **blocked**; its programmes arrive through the community board and stay "community report" |
| Cantina | none | The listing is built in the browser from `/api/`, which robots.txt disallows | **blocked**; its programmes arrive through the community board |
| X | pasted text (any post, thread or profile) | x.com robots.txt: `Disallow: /` for all crawlers. publish.x.com robots.txt: `Disallow: /oembed`. Threads and profiles need the paid API | Automatic retrieval **off**. The single-post oEmbed path is built and tested on a recorded response, but stays off unless the owner decides otherwise |

Requests identify themselves with a generic agent string (`bounty-collector/1.0 …`); `BOUNTY_USER_AGENT` can add contact details.
Every fixed source honours robots.txt before fetching, per RFC 9309 (a 4xx answer means allowed; a 5xx answer or no answer means do not crawl).

## 3. Rules the pipeline enforces

- **Identity:** two listings are one programme only when their platform programme URLs give the same key (for example `immunefi:hyperlane` or `sherlock:56`).
  - A name-only opportunity, such as an X post without a link, joins a programme only when exactly one programme has exactly that normalised name.
  - Same-name programmes on different platforms become **possible duplicates** for review, never merged automatically.
  - A merge keeps every source observation.
- **Authority**, from strongest to weakest: operator correction, official platform, community board, X, other.
  - Each field shows the most authoritative value, and every differing value is kept as a conflict.
  - A conflict from an official or community source sets the programme to "Sources disagree".
  - A post that disagrees is recorded but cannot downgrade an official confirmation.
  - USD-pegged currencies (USD, USDC, USDT and similar) do not conflict with each other.
- **Verification states:**
  - "Official · confirmed" means an official listing was seen by AgentSmith within 48 hours.
  - The other states are "official, check stale", "community report", "X post only", "unverified" and "sources disagree".
  - Immunefi and Cantina programmes stay "community report", because AgentSmith does not fetch those platforms.
- **Status:**
  - Active, paused or closed is taken only from what an official listing states.
  - Community listings are labelled "Listed (community)".
  - A programme missing from a **complete** listing is marked "no longer listed".
  - An empty answer, or a listing that shrinks by more than half, delists nothing.
  - Every change is appended to the programme's history.
- **Nothing is invented:**
  - Rewards are read only where written. "See program", "Discretionary" and stakes give no amount.
  - Missing fields stay empty and are listed as unresolved.
- **Ranking (`bounty-rank/1`)** is deterministic, and every component is explained:
  - reward attractiveness (log scale, USD-comparable currencies only);
  - programme credibility;
  - technical suitability for smart-contract research;
  - information completeness;
  - freshness.

  It never estimates exploitability, chance of payment or competition. A missing component is left out and the explanation says so. Post-incident recovery and forensics bounties are capped at priority 40, because they are not vulnerability opportunities. A change of method gets a new version, and previous scores are kept.
- **Runs:**
  - Each source runs in its own transaction, so one failure never stops the others.
  - Failures back off: interval × 2^failures, up to 24 h, or the server's Retry-After.
  - A database advisory lock stops two runs overlapping, and a crashed run is closed as failed after an hour.
  - Repeating a run over unchanged content adds nothing.
- **Import safety:**
  - Only public https URLs are fetched. Localhost, private and internal names, IP literals, credentials, non-standard ports and other protocols are refused.
  - Production uses the SSRF-guarded fetcher: DNS is pinned, private and metadata addresses are refused, and every redirect hop is re-checked.
  - At most 3 redirects, a 2 MB body cap and a 30 s timeout. robots.txt is honoured, nothing downloaded is executed, links are never followed recursively, and an import never triggers another import.
  - Platform links are resolved through the platform's own adapter (one listing refresh per platform per import), never by scraping programme pages.

## 3a. "Paste any link" (added 2026-11-27)

How a pasted link is read depends on what it is:

| Input | How it is read |
|---|---|
| A recognised programme URL (Immunefi, Sherlock, HackenProof, Cantina, Code4rena, Mantis, CodeHawks) | Identity comes from the URL itself. An enabled platform's listing is refreshed once. Immunefi is never fetched (terms) |
| A web page with programme links | One opportunity per linked programme |
| A single programme or project security page | One opportunity named from the page title, with the largest reward stated in a bounty or reward sentence |
| A page built by JavaScript | Read from the data it carries (meta tags, JSON-LD, Next.js page data, server-component data). JSON is parsed, never run. A reward is read only from a field named bounty, reward, payout or prize |
| A page with no programme data in its HTML (Cantina's listing) | Reported as such, with "paste the visible text"; nothing is invented |
| Pasted text, an X post or thread | Line by line, several opportunities per post, attributed to the author and URL |

Line-by-line "name + amount" extraction is for posts and pasted text only. On real pages it produced junk names ("Range of", "Up to"), found on HackenProof pages, so pages never use it.

**Owner decision: `BOUNTY_IMPORT_FETCH_POLICY`.** The default is `respect`.
- **`respect`:** robots.txt applies to pasted links too, and X is not fetched.
- **`user_initiated`:** a pasted link is one retrieval you asked for, like opening it in a browser, so robots.txt (which governs crawlers) does not block it. X posts are read through X's documented oEmbed endpoint, and short links (t.co, bit.ly, …) are expanded by reading one redirect each. Each such fetch is labelled in the import report.
- **Under both settings:**
  - one page per submission, no link following beyond short-link expansion;
  - no login, no CAPTCHA bypass, an honest user agent;
  - X threads beyond the first post, and X profiles, still need pasted text (no API access);
  - automated collection always respects robots.txt.

Live checks (default policy, real pages, 2026-11-27):
- `audits.sherlock.xyz/bug-bounties/56` gives "Usual Labs".
- `hackenproof.com/programs/redstone-smart-contracts` gives "RedStone Smart Contracts", up to $250,000.
- `cantina.xyz/bounties` gives nothing, with the honest note that its data is loaded by the browser.

## 4. Evidence from real sources (local database `bounty_e2e`, 2026-11-27)

The transport here was the development proxy transport (`BOUNTY_TRANSPORT=env-proxy`), because this sandbox reaches the internet only
through an HTTPS proxy. That transport is refused in production, where the guarded transport is used. Sherlock and HackenProof were
enabled **in this local database only**.

| Run (UTC) | Source | Pages | Bytes | Listings | Added | Matched to existing | Unchanged | Need verification |
|---|---|---|---|---|---|---|---|---|
| 05:26:53 (fresh database) | community board | 1 | 189,973 | 388 | 388 | 0 | 0 | 388 |
| | HackenProof | 35 | 9,507,723 | 332 | 174 | 158 | 0 | 5 |
| | Sherlock | 1 | 510,636 | 41 | 0 | 41 | 0 | 0 |
| 05:28:14 (repeat) | community board | 1 | 189,973 | 388 | 0 | 0 | 388 | 191 |
| | HackenProof | 35 | 9,507,574 | 332 | 0 | 0 | 332 | 5 |
| | Sherlock | 1 | 510,636 | 41 | 0 | 0 | 41 | 0 |
| 05:30:38 (after a resolution fix) | all three | | | 761 | 0 | 0 | 761 | |

**Result: 562 unique programmes from 761 listings.**
- 373 are officially confirmed: 41 Sherlock and 332 HackenProof. Of the 332, 61 are marked closed and 31 paused by HackenProof itself.
- 189 are community-only: the board's Immunefi and Cantina listings, which these platforms' terms or robots.txt keep AgentSmith from confirming.
- 11 possible duplicates are open for review, for example "1inch" programmes on both HackenProof and Immunefi.

Immunefi and Cantina were never contacted.

**Earlier observation:** two runs at about 05:21 recorded HackenProof as **failed (timeout)**, while the board and Sherlock were saved.
- The source backed off as designed, and the next run succeeded.
- The 25-page cap first used for HackenProof hid a real gap: the listing has more than 250 programmes. The cap is now 60; the end of the list is detected when pages repeat.

**Imports through the authenticated API:**

| Input | Result |
|---|---|
| `https://hackenproof.com/programs?page=7` (a real listing page) | retrieved; 19 opportunities; 0 added; 19 matched by programme URL |
| `https://audits.sherlock.xyz/bug-bounties/56` | matched "Usual Labs", officially confirmed; not fetched again |
| `https://immunefi.com/bug-bounty/hyperlane/information/` | matched; never fetched; stays "community report" |
| `https://bug-bounty-board.vercel.app/` | refreshed the board: 388 listings, 0 added |
| `https://x.com/immunefi/status/…` | **blocked**, with the reason and the instruction to paste the text |
| `https://x.com/immunefi` (profile) | **blocked**: profiles need the paid API |
| X thread URL plus pasted text (**synthetic**, labelled in the text itself) | 3 opportunities: 2 matched by platform link, 1 new, marked "X post only" and "needs verification", attributed to the post's author and URL |
| `https://localhost/admin` | refused, 400 `private_host` |
| a GitHub URL that does not exist | **failed** (HTTP 403 from GitHub); reported as failed, not as zero found |

The two synthetic X records exist only in this local database.

**Production-like migration check:** a database with exactly 0001–0007 and then 0011 applied (no 0008) collected the board with production defaults (board only): 388 programmes, the two blocked sources skipped, Sherlock and HackenProof disabled.

**Browser** (Playwright/Chromium against the local server; screenshots in `docs/bounty-screenshots/`):
- 563 records were served and 558 shown by default (recovery bounties hidden until asked for).
- Filtering by Ethereum and sorting by highest reward gave 80 records in descending reward order.
- Search, the detail view, official and source links, the "why this priority" breakdown, and the error state when the feed fails all worked.
- On a phone viewport (iPhone 13) there is no horizontal overflow.
- In the hub, a pasted-thread import was submitted and its report shown; the health and duplicates screens rendered.
- There were no console errors and no CSP violations.

## 5. Tests

| Command | Kind | Result |
|---|---|---|
| `npx vitest run apps/api/src/bounties` | unit: parsers on **real captured pages** (fixtures dated 2026-11-27), money, identity, extraction, resolution, ranking, URL safety, robots.txt | 38 passed |
| `npx vitest run apps/web/test/public-bounties.test.ts` | unit (jsdom): dashboard filters, sorting, rendering, error state | 3 passed |
| `TEST_DATABASE_URL=… npm run test:integration` (bounty file) | integration on real Postgres with a fixture transport: first run, cross-source dedup, idempotency, isolated failure and backoff, empty versus delisted, shrink guard, history, conflicts, imports (multi-item, failures, X blocked or pasted, blocked platform), corrections, merge, API auth and public feed | 12 passed (owner role and restricted runtime role) |
| live runs in section 4 | **real-source end-to-end** | as recorded |

Full repository verification (`TEST_DATABASE_URL=<loopback Postgres> npm run verify`, 2026-11-27): **exit 0**.
- lockfile, typecheck and build pass.
- Unit tests: 52 files, 931 passed, 1 skipped.
- Integration tests on real Postgres: 22 files, 310 passed.
- The same 310 also pass as the restricted runtime role.

This is a local run, not independent CI. The disposable test role is non-superuser with CREATEDB, CREATEROLE and `pg_signal_backend`: the integration suite's connection-termination test assumes the test role is not a superuser.

## 6. Deployment readiness (prepared, not done)

1. **Release image**: the existing `scripts/hub-image.sh` with `HUB_RELEASE_LAST_MIGRATION=0007 HUB_RELEASE_EXTRA_MIGRATIONS=0011`.
   - It ships 0001–0007 and 0011, and excludes 0008 and the drafts. `dist/build-info.json` records both lists.
2. **Migration**: the release's migration step applies 0011 only. It creates the 9 `bounty_*` tables and seeds the source registry, with the board enabled and everything else off or blocked. It changes no existing table.
3. **Deploy** the new image to `agentsmith-hub`. The new public routes are `/bounties/` and `/public/bounties.json`; everything under `/v1/bounties` stays behind the bearer token.
4. **First collection**: `POST /v1/bounties/collect` from the hub (Bounties → Collection health → Collect now), or run `npm run bounties:collect` once.
5. **Schedule**: a Fly scheduled machine on the same image and app secrets, running the collector once an hour:
   `fly machine run <image> --app agentsmith-hub --schedule hourly --region syd --vm-size shared-cpu-1x --vm-memory 512 --restart no -- node dist/apps/api/src/bounties/collect-main.js`.
   - It is not the research worker and claims no research step. Sources not yet due are skipped, so the hourly start is harmless for HackenProof's 6-hour interval.
6. **Cost**:
   - no new service and no AI calls;
   - the scheduled machine runs about 5–60 s per hour (about 2–3 minutes when HackenProof is due), a few cents a month on Fly's shared-cpu pricing (estimate, not measured);
   - the database grows by a few MB.
7. **Rollback**: stop the scheduled machine and redeploy the previous image. The tables can stay; nothing else reads them.

## 7. Approval needed to activate (A42)

One approval covers the first four steps of section 6: building, migrating (0011 only), deploying, and the hourly scheduled collector with the community board as the only enabled source.

Separate owner decisions:
- (a) enable Sherlock;
- (b) enable HackenProof, including whether its data may appear on the public page;
- (c) whether a user-initiated single X post may use oEmbed despite publish.x.com's robots.txt;
- (d) whether to link the new page from the Hunt status page.

The Hunt page is published by the separate Hunt engine's own commits to `Sydneyanon/hunt`, which MultiHub work must not change; nothing there was touched.
