# Phase 5.0: autonomous bounty discovery and source monitoring

Status: implemented as a draft PR, **not deployed, not migrated, not enabled**. Migration `0008_discovery.sql` has only ever run on disposable local databases.

## What it does (and deliberately does not do)
It watches **public** sources for new bounty and audit-contest opportunities, records exactly what each source said and when, scores them with a transparent rule, and lets a **human** turn one into a passive research job. It never contacts a project, tests anything, submits anything or spends money. Approving an opportunity only queues a `repository_research` run, which is the passive acquisition of Phase 5.2 (reads a public repository, executes nothing).

## Flow
1. A human registers a **source** (`POST /v1/discovery/sources`). It is created **disabled**. A human enables it (`POST .../enable`); each action is audited.
2. In a worker started with `DISCOVERY_ENABLED=true`, a scheduler creates one `source_monitoring` run per enabled source whose interval has elapsed and that has no pending run (advisory lock plus re-check, so racing schedulers create one). With the switch off, or no enabled source, nothing is ever fetched.
3. The `monitor_source` step makes **one** `GET` to `api.github.com` (the host is a constant in code; configuration cannot change it) through the SSRF-pinned client, `redirect: manual`, 15 s timeout, 1 MiB body cap, conditional on the stored `ETag` (an unchanged listing costs no rate limit). Every attempt, successful or not, writes an append-only **observation** (URL, status, body hash and size, never the body).
4. Items are validated against the documented API shape (`zod`; anything else fails closed as `bad_shape`), filtered (public non-fork repositories of the configured organisation, name prefix, optional `YYYY-MM-` convention), normalised, deduplicated by canonical key (`github:owner/repo`), scored and stored. New items, material changes (not `pushed_at` churn) and archival produce append-only **events** (`discovered`, `updated`, `closed`).
5. A human lists opportunities (`GET /v1/discovery/opportunities`), reads one with its events, and either **approves** a candidate repository or **dismisses** it. Approval records the decision, creates one `repository_research` run and writes the audit record in **one transaction**; repeating it returns the same run. Only a repository the monitor proposed as a candidate can be chosen, and a database rule stops a `monitor` actor from ever recording a human decision.

## Adapters
| Adapter | Status |
|---|---|
| `github_org_repos` (platforms that publish one public repository per contest in a GitHub organisation, for example a `code-423n4`-style organisation) | Implemented against the **documented** GitHub REST API (`GET /orgs/{org}/repos`). Never run against real GitHub (see limits). |
| Platform websites and feeds (Immunefi, Sherlock, Cantina, HackenProof, CodeHawks, HackerOne, Bugcrowd, Hats, aggregators) | **Not implemented.** Their page and API shapes were not observable from the development environment (its network allow-list excludes them) and scraping needs a terms-of-service review per site. Writing parsers blind would produce confident-looking code that has never met the real markup. Each needs: live shape verification, a ToS and robots check, and the owner's go-ahead. |
| X (Twitter) posts | Unchanged: classified, never fetched (`docs/x-bounty-link-intake.md`). |

## Safety properties (each covered by a test; mutation evidence in `scripts/mutations/discovery.json`)
- Off by default, twice: `DISCOVERY_ENABLED` must be exactly `true` **and** a human must have enabled a source; a disabled source is never fetched, even by a manual "check now".
- One fixed host; organisation names validated so they cannot alter the URL; no credentials sent; redirects refused; body capped; every failure classified (`rate_limited`, `forbidden`, `http_error`, `redirect_refused`, `response_too_large`, `bad_json`, `bad_shape`, `timeout`, `network_error`, `bad_config`) and recorded without creating opportunities.
- Provenance: every opportunity event points at the observation that caused it; observations and events are append-only for every role, including the owner (triggers).
- A human decision is a human actor, always audited; approval cannot choose a repository the monitor did not propose; dismissed, closed or already queued opportunities behave as specified.
- Least privilege: the four new tables are in `db/runtime-grants.json` with INSERT/UPDATE only where the code needs it; the discovery suite passes as the restricted runtime role.
- No other network path: a source-scan test forbids `fetch`, `http(s).request`, `net.connect` and `child_process` in the module, and the SSRF client remains the only outbound route.

## Not built yet
Dashboard screens (API only for now); removal detection (an item that disappears from a listing is left as it was); notifications; platform-site adapters; X ingestion; the Adaptive Research Priority Engine (the scorer is an explained rule, not learning); automatic approval (there is none, by design).

## To use it in production (none of this is approved)
1. The owner approves applying migration `0008` to the production database (an additive migration: four new tables; the app role needs the grants in `db/runtime-grants.json`).
2. A worker must run, which today is blocked: the Fly trial stops machines after 5 minutes, and a worker would run as the owner database role (R1) until the least-privilege role rollout.
3. The owner enables a source and, optionally, provisions `GITHUB_TOKEN` (60 unauthenticated API requests per hour is ample for hourly polling of a few organisations).
4. A first live check of the real response shape against one organisation, from an environment whose network allows `api.github.com` (owner decision).

## Evidence and honest limits
- Unit: 11 (adapter, hostile configuration, scoring, gating scan). Integration (disposable Postgres): 25, also passing as the restricted runtime role. Mutations: 23 of 23 killed.
- **Test-first caveat:** for this slice the implementation was written before its tests (the earlier fixes in this stack were test-first); the mutation run is what shows the tests actually bite. One real defect was found by the database tests: the first migration used a regular-expression repetition count PostgreSQL does not allow (`{3,300}`; the limit is 255).
- **Never exercised against real GitHub.** The documented-shape tests cannot show that GitHub's real responses match; a mismatch fails closed.
- Self-authored; no independent review of this module yet.
