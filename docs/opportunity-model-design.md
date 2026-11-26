# Unified opportunity model: design (T-040)

Status: **design only. No migration is written, no code changes, nothing is applied or enabled.** It needs owner review and approval before T-041 (migration draft). It implements ROADMAP decisions A to D and H: many sources, one model, discovery before scanning, no duplicate pipelines.

## 1. Problem
`bounty_opportunities` (migration `0008`) holds one row per `github:owner/repo`, fed by one adapter. It cannot represent: the same project appearing on Immunefi, Code4rena and GitHub; a program with several repositories; a program that pauses or ends; scope, rewards and deadlines as dated claims; a pasted URL; or the link from a program to its research. Adding sources to it would create parallel, disconnected pipelines.

## 2. Principles
1. **Everything a source says is a claim with provenance** (which source, which observation, when, content hash). Nothing is "verified" until a human confirms it, and verification is itself a recorded event.
2. **Append-only history; current state is derived.** Observations and events are never updated; projections are conveniences.
3. **One identity per real-world thing**: a *project* has *programs* (platform listings), *repositories* and *research*; it is researched once, however many sources list it.
4. **Discovery is separate from selection and from research.** A discovered program is inert until a human selects it; selection queues passive acquisition only.
5. **Sources are interchangeable adapters**; the model has no platform-specific columns on its core tables.
6. **No source access without an approved method** (ROADMAP A, `immunefi-scout.md`). Manual import is a first-class source.

## 3. Entities
| Entity | Meaning | Key | Notes |
|---|---|---|---|
| `source` | a configured way of learning things (adapter + config + access method + health) | `source_key` | exists today as `discovery_sources`; gains `access_method` (`official_api`, `permitted_poll`, `manual_import`, `url_intake`) and `terms_status` (recorded, not inferred) |
| `observation` | one attempt or one operator-supplied input: what was read, when, hash, size, outcome | uuid | append-only; today `discovery_observations`; adds `provenance_kind` (`fetched`, `operator_supplied`) so supplied text is never labelled retrieved |
| `program` | one platform listing of a bounty or contest | `(platform, platform_program_id)` | e.g. an Immunefi slug, a Code4rena contest, a Sherlock contest, a Cantina competition, a GitHub-org listing, a project's own bounty page |
| `program_version` | a dated snapshot of a program's claims: reward range, deadlines, standing vs time-boxed, eligibility, KYC, testing restrictions, scope text, links | `(program_id, version)` | built from observations; append-only; each field carries `source_observation_id` |
| `project` | the real-world protocol/team | uuid | the dedupe anchor; many programs and repositories attach to one project |
| `repository` | a repository identity | canonical `github:owner/repo` (other hosts later) | one row per repo regardless of how many programs cite it |
| `program_repository` | a claim that a program uses a repository, with signal and confidence | `(program_id, repository_id, signal)` | claims, not facts; confirmation is an event |
| `opportunity` | the unit the operator ranks and selects: a program viewed as research work, linked to its project | uuid | replaces today's row; one per `(project, program)` |
| `opportunity_event` | append-only lifecycle and decisions | seq | actor kind `monitor` or `human` (see security note) |
| `research_link` | opportunity to `repository_research` runs and snapshots (commit SHA) | `(opportunity_id, run_id)` | the connection to 5.1/5.2 |
| `priority_assessment` | a transparent score with its per-feature reasons and the inputs used | uuid | written by the scorer (placeholder now; the Adaptive Research Priority Engine later); append-only |

## 4. Identity and deduplication
- **Repository identity** is exact: canonical host/owner/name, lower-cased; moved or renamed repositories are an explicit `alias` claim, never a guess.
- **Project identity** is established by corroborated links, in this order of strength: a program page linking to the repository owner organisation **and** the organisation linking back; the same repository in two programs; a human-confirmed merge. **Name similarity alone never merges.** An uncertain match is recorded as a `possible_duplicate` suggestion and shown to the operator; it does not merge and does not block research.
- **Program identity** is per platform and stable across versions (the Immunefi slug, the contest id), so a changed program updates one program, not many.
- **No duplicate research pipelines:** `research_link` is unique per `(repository, commit_sha)` at the snapshot level and per `(project, intent)` at the run level; selecting a second program of an already-researched project returns the existing research with the new program attached.

## 5. Lifecycle
Program lifecycle (derived from events, from the claims in successive versions): `discovered` -> `active` -> `updated` (any material claim changed) -> `paused` -> `active` (resumed) -> `ended` (deadline passed or removed) / `closed` (source says closed). Opportunity lifecycle adds the human decisions: `selected` -> `queued` (research run created) -> `researching` ... , or `dismissed`. Rules:
- A source's "closed", "paused" or "ended" **never deletes** research, snapshots or decisions; it adds an event and lowers priority.
- A decided opportunity cannot be silently reverted (today's database guard, generalised); reopening is an explicit human event.
- Disappearance from a listing is an *observation of absence*, recorded as such and not as "closed" unless the source says so (avoids false closures from a failed or partial read).
- `paused` and `ended` are modelled explicitly (backlog T-134); Immunefi exposes pause/end fields, other sources differ.

## 6. Provenance and snapshots
Every field of a `program_version` points to the `observation` it came from. An observation stores the request description, status, content hash, size and outcome; the body is kept only when the source's terms and our storage policy allow (default: **hash and extracted fields only**, matching today). Operator-supplied input (pasted text, an imported list, a URL's page text supplied by hand) is stored as an observation with `provenance_kind = operator_supplied`. Retrieval failures and inaccessible sources are recorded as failed observations; the system **never fabricates content** and asks for pasted text or an alternative official link.

## 7. Scope, reward, deadlines, eligibility, restrictions
Held as typed claim fields on `program_version` (reward min/max/currency/text, open and end timestamps, standing/time-boxed, KYC, entry fee, geographic or eligibility text, allowed and prohibited testing text, in-scope and out-of-scope assets with their own repository/commit claims) plus the **original text** hash. A scope claim has `status`: `claimed` (from a source) or `confirmed_by_human` (with who and when). **Active testing is never authorised by any of these fields**; the existing scope guard and authorization gate decide, and they require confirmed scope. Exact commit SHA is not a program field: it is fixed at acquisition (5.2) and recorded on the snapshot linked from `research_link`; a program claim of "scope at commit X" is stored as a claim to compare against.

## 8. Source mapping
| Source | Provides | Access (ROADMAP A) | Maps to |
|---|---|---|---|
| Immunefi | slug, project, reward, dates, paused / invite-only flags, language, assets with added-at, GitHub links | **unresolved**: permission needed for polling; manual import and official repositories available | program + versions; repositories as claims |
| Code4rena | contests and their repositories | GitHub organisation via the existing adapter; platform pages after terms review | program (contest) + repository |
| Sherlock | contests, judging repositories | GitHub organisation; platform interface after terms review (unconfirmed whether contests still run) | program + repository |
| Official GitHub organisations / repositories | repository list, archive state, topics | documented GitHub API (existing adapter) | repository + weak program signal |
| Cantina, HackenProof, project pages | per terms review (T-024) | unresolved | as above |
| Pasted URLs (X posts, GitHub, platform pages, announcements, disclosures) | whatever the operator supplies or the permitted fetch returns | manual (X is a human-fed channel, not a crawler) | observation (`operator_supplied` or `fetched`), then extraction proposals awaiting confirmation |
| Hunt engine (if kept as a feeder, T-138) | its target backlog | import contract | observations `operator_supplied`, claims unverified |

## 9. How it feeds the rest
- **Discovery before scanning:** the opportunity list is populated and maintained before any repository is selected; selection reads from it.
- **Adaptive Research Priority Engine:** consumes program versions, repository and snapshot facts, and research outcomes to write `priority_assessment` rows with per-feature reasons. No probabilities; the scorer in 0008 is replaced behind the same interface.
- **Phase 5.2:** `research_link` calls the existing run creation; selection stays a human action.
- **Phase 5.3 / 5.4+:** read the confirmed repository and snapshot; they never read raw discovery claims as facts.
- **Control Room:** every panel reads these tables only (source health from observations; new/changed from events; priorities from assessments; research from links and runs). Nothing displayed without a stored row.

## 10. Migration path from `0008` (outline, not written)
1. New migration `0009` (additive): `project`, `repository`, `program`, `program_version`, `program_repository`, `research_link`, `priority_assessment`, new event types, `access_method` and `terms_status` on sources, `provenance_kind` on observations.
2. Backfill: each existing `bounty_opportunities` row becomes one `program` (platform from its source), one `repository`, one `opportunity`; events keep their sequence and actors; the existing `queued` runs become `research_link` rows.
3. The `0008` projection table either stays as a compatibility view or is replaced after the API is moved; this is decided in T-041 with its own tests.
4. All new tables follow the same rules as 0008: append-only triggers, least-privilege grants listed in `db/runtime-grants.json`, restricted-role tests, a mutation spec. Nothing is applied to production without approval.

## 11. Security notes
- **Human decisions are not tamper-proof today** (S1): a compromised runtime role could insert a forged human event. This design keeps the event actor fields but does not claim to fix that; T-061 (a separate role/function for human events) is a prerequisite for relying on "human approved" in production.
- Untrusted text from sources is size-capped, NUL-stripped, never rendered as HTML, and links are derived from canonical identities rather than trusted from payloads (as in 5.0 after review).
- Source access follows the adapter conduct policy (T-136): identifying user agent, robots.txt, caps, rates, kill switch, no evasion.
- No adapter in this design is approved to run; enabling any source in production remains an owner decision gated by S1, S2 and the Fly billing restriction.

## 12. Acceptance criteria for this design (review checklist)
- Two sources listing the same project produce one project and one research pipeline (section 4).
- A paused or ended program keeps its research and records an event (section 5).
- Every displayed program field traces to an observation (section 6).
- Pasted text and fetched text are never confused (sections 6 and 8).
- No claim of scope authorises testing (section 7).
- The 0008 data migrates without loss (section 10).

## 13. Open questions for the owner
1. Immunefi access route (T-022) and what to do about the Hunt engine's existing hourly source (S4, T-138).
2. Keep program page text bodies, or hashes and extracted fields only?
3. Is a project the right top-level unit, or should "program" stay the unit the operator selects with project as an annotation?
4. Should the Hunt engine's target backlog be imported as a seed (T-135/T-138)?

## 14. Tests that T-041 must include
Real-Postgres tests for every invariant above (merge rules, no-delete on close, absence is not closure, reverting a decision, provenance links), restricted-role runs, hostile-input tests, backfill round-trip, and a mutation spec in the style of `scripts/mutations/discovery.json`.
