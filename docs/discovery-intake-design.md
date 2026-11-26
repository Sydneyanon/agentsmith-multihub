# 5.0 Multi-source discovery and URL intake (design; conforms to T-149)

**Status: design, 2026-11-26. Nothing here enables polling, scraping or any source.**
- Existing behaviour is documented in `bounty-discovery.md`, `research-intake-and-discovery.md`, `x-bounty-link-intake.md` and
  `immunefi-scout.md`.
- Identities and provenance follow `unified-research-workflow.md` sections 3–4.

## 1. What exists (evidence) and the gap

| Capability | Today | Level | Gap to a real discovery system |
|---|---|---|---|
| Source registry | `discovery_sources` with adapter, config, `enabled` (default false), minimum interval, ETag, failure counter | 4 | No `access_method` or `terms_status`; one adapter value allowed by a CHECK constraint |
| Adapters | `github_org_repos` only: lists an organisation's repositories, redirect-refusing, bounded body, conditional requests, rate-limit classification, back-off | 4 (never live) | No platform adapters (Immunefi blocked; Code4rena, Sherlock, Cantina, HackenProof need terms review); no manual-import adapter |
| Observations | every attempt recorded (hash, size, outcome, error code); body not kept | 4 | No `provenance_kind`, no `completeness`, no adapter version |
| Opportunities | one row per `github:owner/repo`; material-change detection; archive → closed; human approve/dismiss (guarded) → `repository_research` run | 4 | GitHub-shaped; no program, project or scope; no reward or deadline claims; absence is not modelled as such |
| URL intake | URL classification (GitHub/X/web), then the legacy chain | 3 / 2 | No content extraction, no official-link verification, no pasted-text fallback, no platform URL kinds; it does not reach the research store (T-149) |
| Identity and dedupe | `canonical_key` per repository | 3 | No project/program identity, no cross-source dedupe |
| Scope and repository verification | `establish_authorization` always `unverified`; 0001 scope tables used by the active-testing gate, but no API creates them | 2/3 | No way to record a claimed scope from a source, or a human confirmation |
| Health and limits | failure counter, back-off, minimum interval, kill switch (`enabled`), ETag | 4 | No per-source health view or alerting (Control Room) |

## 2. Design

**One intake funnel.** Every entry produces an **observation**, and every observation can produce **claims**. Only claims flow
downstream.

```
adapter poll (disabled) ─┐
URL submission ──────────┼─► discovery_observations (provenance_kind, completeness, adapter_version, hash; body only if terms allow)
manual import / paste ───┘          │
                                    ├─► claims → programs / program_scope_versions (claims_status='claimed'), repositories, program_repositories
                                    └─► bounty_opportunities (+ events) → human approve → repository_research run (T-149 stage 3)
```

- **Adapters** are interchangeable modules with one interface: `observe(source, cursor) → observation + claims[]`. Each declares its
  `access_method`:
  - `official_api`;
  - `permitted_poll` (written permission recorded);
  - `manual_import`;
  - `url_intake`.

  Sources start disabled. Enabling one needs the owner's decision; S3 still stands.
- **Manual URL submission** (the X-link requirement):
  1. `POST /v1/intake` creates a URL observation (`provenance_kind='operator_supplied'` for the URL itself).
  2. For GitHub URLs, identification uses the documented API (stage 1), then hands over to a research run (T-149 S3).
  3. For platform or project pages, a fetch happens only where a fetch policy approves the host; otherwise the operator pastes the
     text, stored with `operator_supplied` provenance.
  4. Extracted claims are **proposals**, shown for human confirmation, never facts.
- **Identity resolution:**
  - Program: `(platform, platform_program_id)`.
  - Repository: exact canonical key, plus aliases.
  - Project: corroborated links only (D1/D2). Name similarity never merges; it raises a `possible_duplicate` event.
- **Updates and duplicates:** a new observation with materially different claims makes a new scope version and an `updated` event.
  A complete read that no longer lists an item gives `absent_observed`, never `closed`. A source that says closed or paused produces
  those events.
- **Scope and repository verification:** claims start as `claimed`. A human confirmation sets `program_scope_versions.verified_at/by`,
  the field the active-testing gate already requires. Repository officialness needs corroboration: the program links the organisation
  and the organisation links back, or a human confirms.
- **Source health:**
  - Per-source minimum interval, back-off on consecutive failures, ETag, bounded bodies, refused redirects.
  - Failures recorded as observations.
  - A Control Room panel reads observations.
  - Conduct policy (T-136): identifying user agent, robots.txt, caps, no evasion.

## 3. What proceeds independently vs waits

| Work | Independent of T-149 approval? |
|---|---|
| Terms and interface review of each platform (documentation only) | yes |
| Manual-import adapter design (file format, provenance) | yes (design) |
| Any table change (`access_method`, `provenance_kind`, programs extension) | **waits**: T-041 (D1–D10) |
| URL-intake handover to `repository_research` | **waits**: T-149 S3 |
| Enabling any source, any polling | **never without owner approval** (S1–S4) |

## 4. Acceptance criteria (for later implementation)
- Two sources listing one project produce one project and one research pipeline.
- Every displayed field traces to an observation.
- Pasted text is never labelled fetched.
- A partial read never closes anything.
- No claim authorises testing.
- A URL submission reaches a sealed snapshot through the one research run type (gap test 1).
