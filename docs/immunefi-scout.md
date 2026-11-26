# Immunefi scout: investigation, requirement and access position (2026-11-26)

Purpose: preserve the capability the owner saw working earlier (collecting Immunefi bounty opportunities into an opportunity list **before** any repository is scanned), find out what is actually known about it, and fix the permanent requirement and the permitted ways to meet it. Nothing here approves polling, implementation, migration, deployment or spending.

## 1. Investigation: what exists and what does not

| Question | Finding | Basis |
|---|---|---|
| Is scout code or a test in this repository, any branch, or its git history? | **No.** No file, commit message or code mentioned Immunefi or a scout before the Phase 5.0 work of 2026-11-26. (The only "scout" in code is the workflow step label `repository_scout` in `intake.ts`, which locates repositories for an already-submitted intake; it is not opportunity discovery.) | `git grep` over every local and remote branch; `git log --all -S"immunefi" -i` (first hit is my 5.0 commit `247aded`); file-name history search. |
| Is it in the earlier working sessions of this project? | **Not in any record I can read.** The saved transcript of the first multihub session has zero mentions of Immunefi or scout. The user's own earlier "scout" session is not retrievable from this environment. | transcript search; session list (other listed sessions belong to unrelated projects and were not opened). |
| Does evidence of a scout exist anywhere? | **Yes, as output only**, in the owner's public status board repository `Sydneyanon/hunt` (read-only clone; nothing modified). `status.json` carries a `scout` block, a `scout_search` block, a `sweep` block and a `contests` list. | `git show` over its 113 commits. |

### What the Hunt status board shows (outputs, not method)
- A scout described as covering **"~20 platforms + X"**, with a search list of 13 named sources: Immunefi, Sherlock, Cantina, Code4rena, CodeHawks, Guardian, HackenProof, CertiK Hunt, HackerOne, Mantis, SpecSiege, **bugbounty.fyi** (a third-party aggregator) and X. Operating window 07:00-23:00 AEDT with an "overnight pause".
- Two recorded sweeps, both on **2026-11-23** (06:30 and 11:05 AEDT). The `newest` list of the second sweep names Immunefi programs (Immutable, AAVE, BENQI, Sei) and a Guardian contest. **No later sweep is recorded in the 113 commits up to 2026-11-26**, so the repository shows no evidence of repeated checking; whether the scout ran elsewhere is unknown.
- Per-program fields it kept: id, name, platform, chain/technology, reward text (`pays`), open/end dates (`open`, `end`), `standing` (ongoing vs time-boxed), size (`nsloc`), a program URL, and a *hunt* status (`STALLED`, `COMPLETE`, `SKIPPED`, `FLAGGED`, `AWAITING ACCEPTANCE`). Sweep rows also carried dates, pool, "code" (e.g. language, size and a public GitHub short SHA for one Guardian contest), entry requirements (KYC, application) and a URL.
- Immunefi entries use program-page URLs (`immunefi.com/bug-bounty/<slug>/information/`, an `audit-competition` URL) and, for Alchemix v3, a **bugbounty.fyi** address, so at least one entry came through an aggregator rather than Immunefi.

### What I could NOT establish (so it is not claimed)
Which endpoint, page, API or feed the scout used; whether it used `immunefi.com/public-api/bounties.json`; whether authentication was involved; how new versus existing programs were distinguished; whether checks were repeated automatically; whether results were stored persistently (the board is a sanitised projection, not an opportunity store); whether it identified official repositories (only the single Guardian row shows a code location); whether it detected paused or closed programs (its statuses describe the *hunt*, not the program's lifecycle); whether it deduplicated across platforms. Where the code lives is unknown: possibly on the owner's server (the Hunt site is served from a private host per `existing-hunt-board-integration.md`) or in a private repository I did not open (`Sydneyanon/AgentSmith` appears to be a different, unrelated project and is outside this task's scope). **Owner action: tell me where the scout source or transcript is (T-130).**

### Reusable and to improve
- Reusable now: the *shape* of what a program record needs (platform, chain, reward, dates, standing/time-boxed, size, URL, entry requirements, code location/commit) and the Hunt contest-board vocabulary; the platform list as the starting source inventory; the observed behaviour "sweep first, then hunt".
- Not reusable as evidence of a working method: the board itself (a projection), and anything about access method or permission.
- Needs improvement for permanence: durable storage with history; explicit lifecycle (new, updated, paused, closed); provenance per field; official-repository verification; cross-source deduplication; rate-limited, permitted access; health and failure handling.

## 2. Immunefi access and permission (verified 2026-11-26 from Immunefi's own pages, one fetch each)
| Question | Position |
|---|---|
| Is `https://immunefi.com/public-api/bounties.json` officially documented? | **No official documentation found** on the pages read (Terms of Use, Rules, robots.txt). It is described only by a third-party aggregator. Its status as a supported interface is **unverified**. |
| Does it exist and return data? | Yes: one request during this research returned HTTP 200, JSON, about 6.3 MB, a single array of program objects (fields include `slug`, `project`, `maxBounty`, `launchDate`, `endDate`, `updatedDate`, `isPaused`, `pausedAt`, `githubUrl`, `websiteUrl`, `assets`, `inviteOnly`, `kyc`, `programType`). Only the first chunk was read and nothing was stored. No authentication was needed. |
| Do the Terms permit automated polling? | **The Terms on their face do not.** Section 4 prohibits using "any robot, spider, or other similar automatic device, process, or means to access the Website for any purpose" and use that could "overburden" the site; the Rules prohibit "Automated testing of services that generates significant amounts of traffic". No rate, caching or storage allowance was found. About 16,000 characters of the Terms were not read verbatim. |
| Is there an approved researcher-facing API or feed? | None found. |
| Is written permission required? | Required for **polling**, in the sense that nothing found grants it; ask Immunefi (T-022). The agent will not contact Immunefi. |
| robots.txt | `Allow: /` for all agents (this is not permission under the Terms). |

**Position:** a scout having retrieved listings before is *not* authorisation for permanent automated polling. Immunefi stays a permanent, highest-priority source, but **no automated access to immunefi.com or its JSON file is built or run** until the owner records an approved access method.

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
