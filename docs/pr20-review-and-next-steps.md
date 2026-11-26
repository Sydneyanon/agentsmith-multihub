# PR #20 review, live-check status, worker readiness, platform assessment

Date: 2026-11-26. Status: **design and evidence only. Nothing here was deployed, migrated, enabled or merged.**

## A. Independent review of Phase 5.0 (self-review, second pass)

Honesty note: this is a second, adversarial pass by the same agent that wrote the code, not a review by a different party. It reads every
file of the module (`0008_discovery.sql`, `discovery/*.ts`, `acquisition/step.ts` refactor, grants). A reviewer who did not write the code is still outstanding.

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | `bounty_opportunities` is UPDATE-able by the runtime role, so the monitor (or any bug) could set `state` to `approved`/`queued`/`dismissed` with no human event behind it, or revert a human decision to `discovered`. The CHECK on `opportunity_events` protected only the log, not the projection. | Material (human-approval boundary) | Trigger `bounty_opportunities_guard_state` (migration 0008): such a state requires a matching **human** event of the same type; a decided opportunity cannot return to `discovered`. Tests + 3 mutants. |
| 2 | An upstream archive of a **queued** opportunity overwrote its state with `closed`, losing the link to its research run, and a repeat approval then failed with `invalid_state` instead of returning the existing run. | Material (idempotency) | Closure of a queued/approved opportunity records the `closed` event and zeroes the score but keeps the state. Test + mutant. |
| 3 | The API "check now" ignored the interval entirely, so repeated calls could hammer api.github.com (and burn the unauthenticated 60/h limit). | Moderate | A 60 s floor on the human action (`minForceGapSeconds`); the scheduler path is unchanged. Tests + 2 mutants. |
| 4 | Priority score uses `created_at`, but unchanged items are not re-scored, so a score can age without refresh. | Low | Not changed: ordering is advisory and the doc already says so. Noted. |
| 5 | No back-off after consecutive failures (a failing source is retried every `min_interval_seconds`, minimum 5 min). | Low | Not changed; `consecutive_failures` is recorded for a later back-off. |
| 6 | Approved runs record `source: "user"` in the run input; the discovery origin is only in `opportunity_events`/audit. | Low | Not changed; provenance is recoverable from the events table. |
| 7 | A closed (archived) repository that is later un-archived stays `closed`. | Low | Not handled; documented limitation. |

Checks that found no defect: SSRF (host is a code constant, org name is regex-validated, `redirect: manual`, goes through the pinned client, no
credentials sent); scheduler race (advisory lock + re-check, tested); append-only tables (UPDATE/DELETE triggers; runtime role has no TRUNCATE); approval atomicity
(decision, queued run, audit and projection in one transaction, row-locked); reuse of 5.2 (`createRepositoryResearchRunIn` is the only run-creation path, no
duplicated workflow logic).

Evidence after the fixes (local, Postgres 16): `npm run verify` all six steps pass; discovery integration 28 tests (also as the restricted runtime role);
mutation spec **29/29 killed** (23 original + 6 new; two first survived, which exposed two missing assertions, now added).

## B. Live GitHub response-shape check: NOT performed

Approved by the owner, but this sandbox cannot do it. A direct request to `https://api.github.com/orgs/code-423n4` returns 403 from the egress proxy with
"sessions are bound to their configured repositories. Use repository-scoped endpoints". I did not try to work around the restriction. The GitHub MCP tools are
scoped to this repository only. The check therefore needs an environment that can reach api.github.com (the owner's machine, or an environment allowlisting it).

Proposed single read-only command for that environment (no token, no writes):

    curl -sS -D headers.txt -o body.json -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
      'https://api.github.com/orgs/code-423n4/repos?type=public&sort=created&direction=desc&per_page=100'

Then record only: HTTP status, timestamp, `x-ratelimit-remaining`, `etag` presence, array length, and which of the fields the adapter reads
(`name, full_name, html_url, description, archived, fork, private, created_at, pushed_at, topics`) are present/typed as the zod schema assumes. Do not keep the body.
Owner identity: confirm the organisation is the one linked from code4rena.com/docs.code4rena.com before relying on it; searches show repositories such as
`code-423n4/2026-02-jupiter-lend` and `...-findings` under it, and the naming looks like `YYYY-MM-<project>[-findings]` (inferred from examples, not documented).
Note for the first source: `-findings` repositories are submission repositories, not the code under audit; the adapter's `requireDatePrefix` would accept both,
so the first source should be reviewed by a human before enabling (the approval step already makes the human pick the repository).

## C. Worker and least-privilege role readiness (design only)

Roles (already built, not applied to production): `db/runtime-grants.json` + `scripts/apply-runtime-grants.ts` give a runtime role SELECT/INSERT/UPDATE only on
listed tables (discovery tables included), no DDL, no TRUNCATE, no DELETE on append-only tables, TEMP revoked, search_path pinned. The schema owner
(`schema_admin`) stays migration-only. Plan: create `agentsmith_runtime` (LOGIN, member of no other role), run the grants script as owner, put its URL in a
separate Fly secret used only by the worker (and later the API), keep `DIRECT_DATABASE_URL` for migrations only.

Unverified, must be checked before rollout: whether Fly Managed Postgres lets `schema_admin` CREATE ROLE / GRANT (its privileges are undocumented), and
whether the role guard accepts the managed provider's role layout. This is the same R1 blocker.

Worker deployment: same image, second process group (`worker`, running the existing worker entry point), no public ports, `DISCOVERY_ENABLED`
unset until approved. Needs egress to `api.github.com` and (for acquisition) `codeload.github.com`. Constraints: the Fly org is on a trial that stops machines after
5 minutes, so a persistent worker needs the owner to add billing; the Developer-plan database auto-pauses after 15 min idle and allows 20 connections (a worker
holds a few). Minimum cost: one always-on smallest shared-CPU machine plus the existing database; I have not verified current Fly prices, so I will not quote a number: the owner should read the Fly pricing page before approving. No activation proposed.

## D. Source-by-source assessment (from web search results only; official pages were unreachable from the sandbox)

Nothing below has been verified against the platforms' own pages from this environment. Every "unconfirmed" must be checked before any adapter is written.

| Source | Machine-readable interface found | Terms signal | Status / recommendation |
|---|---|---|---|
| Code4rena | Public GitHub org `code-423n4` (works with the existing adapter). No API documented in search results; docs at docs.code4rena.com (`llms.txt` exists). | GitHub ToS/API limits apply; no extra platform restriction seen. | **Best first source.** Adapter exists. Verify shape live (B). |
| Sherlock | Judging repos under GitHub org `sherlock-audit` (`YYYY-MM-project-judging`, inferred); docs index at docs.sherlock.xyz/llms.txt; contest listings are web pages. Docs paths suggest contests may have been replaced by "Audit Engine" (unconfirmed). | Not reviewed. | Judging repos are created after a contest, so this finds past/late contests; confirm whether contests still run before investing. |
| Immunefi | A third-party aggregator describes an unauthenticated JSON catalogue at `immunefi.com/public-api/bounties.json` (not confirmed from Immunefi). | Researcher terms/rules list automated testing "that generates significant amounts of traffic" without authorisation as prohibited; full Terms of Use not read. | Candidate for **one low-frequency read** only after the owner reads the Terms and confirms the endpoint; otherwise ask Immunefi. No scraping. |
| Cantina | Documented REST API, but for **client organisations** (their own repos/reports); only the Client API Reference is the supported surface. | Competitions ToU defer to general terms (not read). | Not a discovery source for outside researchers as far as found. Needs the general terms and possibly a Cantina contact. |
| HackenProof | Public program listing pages; docs `llms.txt`; no public API or feed found. | Scraping policy not found. | Do not scrape. Ask HackenProof or read their Terms; GitHub/other signals instead. |
| X (Twitter) | Official API is pay-per-use (third-party figures about $0.005 per post read, with caps). | Developer terms on automated monitoring not read. | **Paid service: needs owner approval before anything.** Treat as a separate, optional later source; low-signal and costly relative to the others. |

Adapter design (already how the code is arranged): `discovery_sources.adapter` is a CHECK-constrained name; each adapter supplies a config schema, a URL builder with a
code-constant host allowlist, a response parser returning `NormalizedOpportunity[]`, and nothing else; monitoring, dedupe, events, scoring, approval and the 5.2 hand-off are
adapter-independent. A new platform therefore needs: one migration line widening the adapter CHECK, one adapter module, and tests on recorded fixtures. A host must be added
to a per-adapter allowlist deliberately (today `GITHUB_API_ORIGIN` is a single constant; generalising it to a per-adapter constant is the first refactor, not yet done).

## E. Destination reminder

A GitHub org monitor is a foundation, not autonomous bounty discovery. Still missing: platform adapters (pending the terms review above), a live worker, notifications and a
dashboard, then 5.3 mapping, tool runs, hypothesis generation and outcome learning.

## Decisions still needed from the owner

1. Run the one-line live check (B) from a machine that can reach GitHub, or approve an environment allowlisting `api.github.com` for this session.
2. Read/approve the Immunefi and HackenProof terms before any adapter; approve or decline X (paid).
3. Fly billing and the R1 role rollout before any worker.
