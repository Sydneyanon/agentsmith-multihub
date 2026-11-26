# Immunefi scout: investigation, requirement and access position (2026-11-26)

Purpose: preserve the capability the owner saw working earlier (collecting Immunefi bounty opportunities into an opportunity list **before** any repository is scanned), find out what is actually known about it, and fix the permanent requirement and the permitted ways to meet it. Nothing here approves polling, implementation, migration, deployment or spending.

## 1. Investigation: what the earlier scout was and how it worked

**Correction (second pass, 2026-11-26).** The first pass searched only this repository and concluded the method was unrecoverable. The scout was built in a **separate earlier session on a separate project**, the Hunt engine (`huntd`, a Python standard-library daemon with a sqlite database, deployed by the owner to a Linode server). That session's saved event history is readable. **The scout's source files themselves are not available to me** (they lived in that session's container and on the deployed server; no GitHub repository I can see contains them). What follows is what the saved history verifies, with its limits.

### Verified from that session's saved history
| Question | Finding |
|---|---|
| How did it obtain Immunefi listings? | One HTTP GET of **`https://immunefi.com/public-api/bounties.json`**, parsed as JSON (size cap 40 MB in code; the file was 6,302,240 bytes, HTTP 200, `application/json`, no authentication) |
| When was it found? | An exploratory probe on 2026-11-24 about 05:02 UTC tried the Immunefi, Sherlock, Code4rena and HackenProof endpoints in turn. Sherlock (`audits.sherlock.xyz/api/contests`) and Code4rena (`code4rena.com/api/v1/audits`) also answered JSON; HackenProof's guessed API returned 404 and was handled by parsing HTML pages instead. That probe sent a generic browser-style user agent string; the engine afterwards used its own identifier (`huntd/1.0`). AgentSmith's rule is the opposite: any approved access identifies itself honestly (section 2, position). |
| Was it repeated or one-off? | **Repeated by design:** a scheduler swept every 60 minutes (window 0-24h), retried in about 10 minutes when no source could be read, and respected `robots.txt` using an RFC 9309 reader after the first version wrongly self-blocked. The summary of that session recorded the first real scheduled sweep as not yet verified. |
| Was the list persistent? | **Yes:** targets were stored in a sqlite database on a Linode volume (so redeploys did not wipe it), exposed to the owner through an admin-token API (`/api/hunter/targets`) with fields including id (`immunefi-<slug>`), name, status, rank, audit, nsloc, launched, assets_at and repository. Programs were kept as `listed` (backlog) or promoted to a hunt. |
| What did it extract? | Program name, slug, launch date, max bounty, KYC, language, paused / invite-only flags, end date, the program's assets (type and `addedAt`), and repository links from `githubUrl` and the assets; rules were imported but **never marked verified**. Keys were of the form `immunefi:<slug>:<launch>`, `immunefi-list:<slug>` and `immunefi-assets:<slug>:<hash>`. |
| Did it detect new, paused, closed or changed programs? | Paused, invite-only and ended programs were filtered out; new programs and new assets (within 14 days) were detected by date and asset hash; a fresh program (within 45 days) with a repository found became a hunt candidate. Whether it recorded the *transition* to paused/closed as an event is not established. |
| Did it identify official repositories? | Yes, as claims: from `githubUrl` and asset links; for new-code detection only the new assets' own links were accepted. Multi-repository programs were noted, not resolved. |
| Cross-source deduplication? | Not established beyond per-source keys. |
| Code and tests? | The summary of that session records a Python test suite (158 passing at that point) with saved real-page fixtures, but I cannot see it. |

### Not recovered (so not claimed)
The source files; the earliest manual scouting before 2026-11-24 05:00 UTC; whether Immunefi's **Terms of Use** were read at that time (only `robots.txt`, which allows all, is recorded in the history I read; roughly the 05:00-06:12 UTC window and the final 30 minutes of a two-day session were read); the real state of the deployed scout today (it may still be polling Immunefi hourly; see section 4, issue S4).

### Correction to the first pass
The Hunt status board (`Sydneyanon/hunt`) shows two sweeps dated 2026-11-23, which is **before** the Hunt engine session existed. Those sweep blocks are best read as coming from the owner's earlier pipeline, not from this scout, so they are not evidence of how it worked. The earlier "~20 platforms plus X" figure belongs to that board and is likewise not a verified property of the scout.

### Reuse and improvement
- **Reuse (as design, not code):** the JSON-first approach; the field set above; `listed` backlog versus hunt promotion; asset-hash change detection; filters for paused, invite-only and ended programs; claims-never-verified for rules; RFC 9309 `robots.txt` handling; response-size caps; honest, identifying user agent; retry-when-nothing-readable behaviour.
- **Improve for AgentSmith:** polling only where an access method is approved; the unified model with lifecycle events (including paused and ended transitions); per-field provenance; cross-source identity; a single owner of discovery (see S4); health status and failure back-off; no dependence on a single operator's server.

## 2. Immunefi access and permission (verified 2026-11-26 from Immunefi's own pages, one fetch each)
| Question | Position |
|---|---|
| Is `https://immunefi.com/public-api/bounties.json` officially documented? | **No official documentation found** on the pages read (Terms of Use, Rules, robots.txt). It is described only by a third-party aggregator. Its status as a supported interface is **unverified**. |
| Does it exist and return data? | Yes: one request during this research returned HTTP 200, JSON, about 6.3 MB, a single array of program objects (fields include `slug`, `project`, `maxBounty`, `launchDate`, `endDate`, `updatedDate`, `isPaused`, `pausedAt`, `githubUrl`, `websiteUrl`, `assets`, `inviteOnly`, `kyc`, `programType`). Only the first chunk was read and nothing was stored. No authentication was needed. |
| Do the Terms permit automated polling? | **The Terms on their face do not.** Section 4 prohibits using "any robot, spider, or other similar automatic device, process, or means to access the Website for any purpose" and use that could "overburden" the site; the Rules prohibit "Automated testing of services that generates significant amounts of traffic". No rate, caching or storage allowance was found. About 16,000 characters of the Terms were not read verbatim. |
| Is there an approved researcher-facing API or feed? | None found. |
| Is written permission required? | Required for **polling**, in the sense that nothing found grants it; ask Immunefi (T-022). The agent will not contact Immunefi. |
| robots.txt | `Allow: /` for all agents (this is not permission under the Terms). |

**Position:** a scout having retrieved listings before (it did, see section 1: it read the JSON file, hourly, with `robots.txt` honoured) is *not* authorisation for permanent automated polling. Immunefi stays a permanent, highest-priority source, but **no automated access to immunefi.com or its JSON file is built or run** until the owner records an approved access method. Any approved access identifies itself honestly (a real, contactable user agent), honours `robots.txt` and any agreed rate, and never disguises the client or evades limits.

Disclosure: the one research fetch above was a single read-only GET made by an assistant sub-agent to check the status, content type and field names. It is not a precedent for polling.

### Approved-access options (owner chooses; each keeps Immunefi in the same opportunity model)
| Option | What it is | Status |
|---|---|---|
| 1. Written permission | Immunefi confirms in writing that the file (or another interface) may be polled, at a stated rate, with caching/storage terms. Then a normal adapter with conditional requests, a low fixed rate, health status and a kill switch. | Preferred; needs the owner to ask (T-022). |
| 2. Manual import | The operator pastes program URLs (General URL intake) or supplies a snapshot/export; the system stores it as **operator-supplied** with its hash and time, and extracts fields from that. A human action, not polling. | Available once T-032/T-132 exist; the owner should still decide whether a manually downloaded copy of the JSON file is within the Terms. |
| 3. Official repositories/pages | Immunefi programs' own public GitHub organisations or project bounty pages, through the permitted GitHub adapter or manual URL intake. | Works today for GitHub organisations (partial coverage). |
| 4. Third-party aggregators (for example bugbounty.fyi) | Another party's data. | **Not approved**: their terms are unread, and aggregators are secondary sources. |

## 3. The permanent requirement: discover first, scan later
AgentSmith must know what opportunities exist before it decides what code to research. The workflow, and where each step stands today:

| # | Step | State today |
|---|---|---|
| 1 | Discover available Immunefi opportunities | **Not built** (blocked on the access decision above) |
| 2 | Populate and maintain a persistent opportunity list | Partly: `bounty_opportunities` exists but is GitHub-only (T-040/T-041) |
| 3 | Detect new, updated, **paused** and closed opportunities | new/updated/closed exist for GitHub; **paused is not modelled** (T-134) |
| 4 | Verify project and bounty information | Not built; claims stay unverified until a human confirms |
| 5 | Identify official repository links | Candidate links only; Immunefi's `githubUrl`/assets would be *claims* needing corroboration |
| 6 | Deduplicate across sources | Not built (T-042); same-project-one-pipeline is a permanent rule |
| 7 | Prioritise | Placeholder scorer only; Adaptive Research Priority Engine is future work (T-050/T-051) |
| 8 | Select an opportunity | Exists: human approval in 5.0 (guard has the known integrity limit, below) |
| 9 | Acquire and pin at an exact commit (5.2) | Implemented but never run against real GitHub |
| 10 | Normal research pipeline | 5.3+ not built |

Immunefi is **a source feeding the unified opportunity model**, never a separate research system. It shares provenance, history, deduplication, priority, acquisition, mapping and the Control Room with Code4rena, Sherlock, GitHub organisations and manually supplied URLs. Dependencies: 5.1 (research records, snapshots) and 5.2 (acquisition) are prerequisites for step 9 onward; discovery itself needs only the opportunity model and an approved access method. Code4rena and Sherlock are siblings: each has its own adapter and terms review; where they publish through GitHub organisations the existing adapter already covers part of that.

## 4. Outstanding security issues (kept visible)
- **S1: forged human decisions.** A compromised runtime database role can INSERT `opportunity_events` rows (including a fabricated "human" event) and can UPDATE or INSERT `discovery_sources` with `enabled = true`. The current approval mechanism is **not tamper-proof**: "human" means "the holder of the single operator bearer token", and it must not be described otherwise. Closing it needs a separate role/function for human decisions (T-061), which depends on the database role design (S2).
- **S2: R1.** Production still runs as the schema-owner role; the Fly Managed Postgres role capabilities for a least-privilege runtime role are unverified (T-060).
- **S3:** no production discovery source or worker may be activated until S1 and S2, the Fly billing restriction and the access decisions above are resolved by the owner.
- **S4: possible existing automated polling by the Hunt engine.** The earlier scout was designed to sweep Immunefi's JSON file every hour. If the deployed Hunt engine is still running it, automated polling of Immunefi is **already happening outside this repository**, against the same terms question. Nothing in this repository started it and I have not probed the Hunt service. Owner decision needed: whether to pause that scout's Immunefi source until access is settled, and which system owns discovery so MultiHub does not add a second poller (T-138).
