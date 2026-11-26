# Recovered Hunt-scout design and field mappings (reference only)

Status: **a record so the prior work is not lost. It is not code, not an approved adapter, and it authorises no polling.** Source: the saved event history of the earlier Hunt-engine session (`huntd`), read 2026-11-26; the source files themselves were not available (see `immunefi-scout.md`). Everything below is "as recorded in that history", not independently re-verified against the deployed engine.

## 1. Workflow (to preserve)
Discover opportunities first -> persist and deduplicate -> verify program, project, scope and repository -> prioritise -> acquire the exact repository snapshot -> research. In the MultiHub architecture the first four steps belong to Phase 5.0 and feed the unified opportunity model (`opportunity-model-design.md`); acquisition is Phase 5.2.

## 2. Behaviours recorded for the Hunt scout
| Behaviour | Recorded detail | MultiHub treatment |
|---|---|---|
| Source access | one GET of `immunefi.com/public-api/bounties.json` (JSON, size cap in code), plus Sherlock `audits.sherlock.xyz/api/contests` and Code4rena `code4rena.com/api/v1/audits` as JSON, and HTML parsing for Cantina and HackenProof | **Not adopted as-is.** Each source needs a recorded access method and terms review first (ROADMAP A). Immunefi: unresolved. |
| Cadence | sweep about hourly, retry about 10 minutes when nothing was readable | a per-source rate set by the approved access method, with back-off and a kill switch |
| Politeness | RFC 9309 `robots.txt` reader with its own agent name; response size caps; errors never half-parsed | keep, and add: honest contactable user agent; robots.txt is necessary but **never treated as permission** |
| Persistence | sqlite on a persistent volume; targets `listed` (backlog) or promoted to a hunt | PostgreSQL unified model with append-only observations and events |
| Change detection | new program by launch date; new assets by `addedAt` and a hash of the asset set; keys `immunefi:<slug>:<launch>`, `immunefi-list:<slug>`, `immunefi-assets:<slug>:<hash>` | program identity = `(platform, platform_program_id)`; changes become `program_version` rows and events |
| Filters | drop paused, invite-only and ended programs (and, by option, by language or minimum bounty) | **do not drop**: record them with explicit `paused`/`ended`/`invite_only` state so history is kept and the Control Room can show them; filtering is a view, not discarding |
| Repository identification | from `githubUrl` and asset links; for new-code detection only the new assets' own links; multi-repo programs noted | repository claims with signal and confidence; confirmation by a human; never merged by name similarity |
| Rules | imported, never marked verified | `claimed` until a human confirms (design section 7) |
| Hunt promotion | fresh program (about 45 days) or new assets (about 14 days) with a repository found | becomes an input to the priority assessment, not a hard rule |

## 3. Field mapping: Immunefi JSON -> unified model
Field names are those observed in the first element of the file and used by the Hunt scout. Meaning of undocumented fields is inferred from their names and is **unverified**; none is a documented interface.

| Immunefi field | Model destination | Note |
|---|---|---|
| `slug` | `program.platform_program_id` | stable program identity |
| `project` | `project` name claim; `program.title` | project identity is established by corroborated links, not by this name alone |
| `launchDate` | `program_version.opened_at` | |
| `endDate` | `program_version.ends_at` | an ended program is recorded, not dropped |
| `updatedDate` | observation metadata | may signal change; not trusted alone |
| `maxBounty`, `rewards`, `rewardsPool` | reward claims | currency and exact meaning unverified |
| `isPaused`, `pausedAt`, `pausedMessage` | lifecycle `paused` event | explicit state (T-134) |
| `inviteOnly`, `kyc`, `eligibilityCriteria` | eligibility claims | |
| `language`, `projectType`, `productType`, `programType`, `ecosystem` | technology / type claims | |
| `assets[]` (`type`, `addedAt`, target) | scope claims and `program_repository` / asset claims | smart-contract assets with an added-at date drive "new code" detection; asset-set hash gives change detection |
| `githubUrl` | repository candidate claim | a claim; corroboration and human confirmation required |
| `websiteUrl` | project corroboration signal | |
| `outOfScopeAndRules`, `knownIssues`, `prioritizedVulnerabilities`, `impacts` | rules / restrictions claims | **never verified**; original text hash stored |
| `audits` | prior-review claims | |
| `description`, `programOverview` | text claims (size-capped) | untrusted text: stripped and never rendered as HTML |

## 4. Sherlock and Code4rena JSON (recorded, unverified)
The Hunt scout read `audits.sherlock.xyz/api/contests` and `code4rena.com/api/v1/audits` as JSON and treated them as listing contests with repositories. Field names were not recovered here. Both are subject to the same rule: no polling until each platform's terms and an access method are recorded (T-023). Their GitHub organisations remain readable through the existing documented-API adapter.

## 5. What to reuse versus rebuild
Reuse as design: the table above. Rebuild in MultiHub: everything in code, so that observations, events, provenance, grants and tests follow the platform's rules. The recovered tests and saved page fixtures (if the owner provides them, T-130) should seed adapter test fixtures.
