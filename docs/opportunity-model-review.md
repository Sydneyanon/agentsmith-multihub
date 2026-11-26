# Review of the T-040 opportunity-model design, before any T-041 migration

Status: **review for owner approval. Nothing here is written as a migration, applied or enabled.** The owner did not approve T-041 on
2026-11-26 and asked for this review of `docs/opportunity-model-design.md` (T-040) first. Each section states what the design
already settles, what this review found missing or inconsistent, and a recommendation. Section 9 lists the decisions needed before
T-041 starts.

Basis of this review: the T-040 design text, migration `0008_discovery.sql`, `db/runtime-grants.json`, `apps/api/src/discovery/*`
(the only code that reads or writes the 0008 tables: `monitor.ts`, `store.ts`, `step.ts`, `api.ts`), `docs/database-migrations.md`
and the T-051 scorer in `apps/api/src/priority/`. **Not verified here:** whether 0008 is applied to any hosted database, and how many
rows it holds. The backfill below is therefore designed to be correct for both an empty and a populated 0008.

## 1. Summary of findings

| # | Area | Finding | Severity for T-041 |
|---|---|---|---|
| F1 | Schema | `opportunity` is keyed by `(project, program)`, but project identity is unknown at discovery time; the design does not say what a newly discovered program's project is | blocking: must be decided |
| F2 | Identity | A merge of two projects has no defined representation; with append-only tables, rows pointing at the losing project cannot be rewritten | blocking |
| F3 | Provenance | "Each field carries `source_observation_id`" is not a schema; doubling every column is fragile | needs a decision |
| F4 | Lifecycle | 0008's guard forbids changing a human decision, the design requires "reopening is an explicit human event"; the two conflict | blocking |
| F5 | Lifecycle | 0008 uses state `approved`, the design uses `selected`; no mapping is written | minor, decide once |
| F6 | Lifecycle | "Absence is not closure" needs to know whether a read was complete; observations do not record completeness | needs a column |
| F7 | Lifecycle | `ended` (deadline passed) implies a clock-driven writer, i.e. a scheduled job; that conflicts with "no new polling" | design change: derive, do not write |
| F8 | Dedupe | "unique per (repository, commit) at snapshot level and per (project, intent) at run level" cannot be enforced in `research_link` as drawn | needs a separate constraint |
| F9 | Scoring | `priority_assessment` is underspecified relative to the T-051 output now implemented (policy version, input hash, contributions, exploration flag) and has no allocation record | align with T-051 |
| F10 | Backfill | A GitHub-organisation repository is not a bounty program; backfilling each 0008 row as a `program` mislabels it | needs a program kind |
| F11 | Backfill / rollback | The runner is forward-only with no down-migrations, and append-only triggers prevent correcting a bad backfill by DELETE | needs expand/contract plan and pre-apply checks |
| F12 | Compatibility | Four modules and the grants manifest depend on 0008 names; replacing `bounty_opportunities` with a new table breaks all of them at once | recommend extending in place |
| F13 | Security | Human events remain forgeable by the runtime role (S1); T-061 is a prerequisite for trusting "human" in production, as the design says | unchanged, keep visible |

## 2. Schema

**Settled by the design:** separate `source`, `observation`, `program`, `program_version`, `project`, `repository`,
`program_repository`, `opportunity`, `opportunity_event`, `research_link`, `priority_assessment`; append-only history; no
platform-specific columns on core tables.

**F1, project at discovery time.** Recommendation: every new program gets a **provisional project of its own** in the same transaction
(`project.kind = 'provisional'`). Corroborated links or a human merge later attach programs to an existing project (F2). This keeps
`opportunity.project_id` NOT NULL, avoids nullable identity columns and never merges on name similarity.

**F3, field-level provenance.** Recommendation: **one observation per `program_version`** (`program_version.observation_id NOT NULL`).
Every field in a version then has exactly one source by construction. A version is never assembled from several observations; a human
correction is itself an `operator_supplied` observation that produces a new version. The extracted claims are typed columns where they
are queried (reward min/max/currency, open/end timestamps, standing vs time-boxed, KYC, paused) plus `claims jsonb` for the rest and
`text_sha256` for the original text. No per-field observation columns.

**F9, `priority_assessment`.** Align it with what T-051 already produces, so nothing is invented later:
`id, opportunity_id, policy_version, inputs_sha256, score numeric(5,2), contributions jsonb, flags text[], exploration_candidate boolean,
unexplored_share numeric, assessed_at`, append-only. Add **`priority_allocation`** (`id, policy_version, seed, slots, created_at`) and
`priority_allocation_item` (`allocation_id, opportunity_id, slot_kind 'exploit'|'explore', rank`), so every exploration pick can be
audited and replayed from its seed. These two are needed by T-052/T-057 comparisons and cost little now.

**Not in T-041:** `research_coverage` and `hypothesis_outcomes` (T-144) depend on structural component hashes and outcome adjudication;
they belong in their own later migration, reviewed separately.

## 3. Provenance

Settled and sound: claims not facts; `provenance_kind` (`fetched` / `operator_supplied`) on observations; hash and extracted fields by
default; failed reads recorded, never fabricated. Additions:

- **F6:** `discovery_observations.completeness` (`complete`, `partial`, `unknown`; existing rows backfilled as `unknown`). An
  *absence* is recorded only from a `complete` read. A partial or unknown read never produces `absent_observed`.
- `observation.adapter_version`: the extractor that produced the claims, so a parser change is traceable to the versions it produced.
- A **scope claim is never a testing authorisation**; the design says this, and T-041 should add a test proving no code path reads a
  scope claim when deciding on active testing.

## 4. Identity resolution

Settled: exact repository identity (lower-cased `host/owner/name`); program identity per platform; **no merge on name similarity**;
uncertain matches become `possible_duplicate` suggestions.

**F2, merges.** Recommendation: a merge is an append-only `project_merge` row (`from_project, into_project, basis, actor_kind,
actor_id, observation_id`), and the canonical project of any row is resolved through a view that follows merges (cycles refused by a
trigger; one hop at a time; a project can be merged away once). No row is rewritten. A merge whose basis is `human_confirmed` requires
`actor_kind = 'human'`; corroborated automatic merges require two independent observations (the program-to-organisation and
organisation-to-program links named in the design). **Un-merge** is a new `project_split` event, not a deletion. All this is subject to
S1: a "human" merge is only as trustworthy as the runtime role until T-061.

Repository renames: an `alias` claim (`repository_alias(from_key, to_key, observation_id)`), never a guess; identical treatment.

## 5. Lifecycle history

Settled: lifecycle derived from append-only events; close, pause and end never delete research; decisions cannot be silently reverted.

- **F4, reopening.** 0008's trigger refuses any state change once `approved`, `queued` or `dismissed`. Recommendation: keep that guard
  for *every* change except one: a `reopened` event with `actor_kind = 'human'` lets a `dismissed` opportunity return to `discovered`.
  `approved`/`queued` are never reopened; a new research intent is a new run linked to the same opportunity. The guard is extended, not
  removed, and the existing restricted-role tests stay.
- **F5, naming.** Keep the stored value `approved` (existing rows, guard and API) and call it "selected" only in documentation and UI.
  Renaming a stored state value in an append-only table is a needless risk.
- **F7, `ended`.** Do not write `ended` from a clock. Derive "ended" in the read model from the current version's end timestamp
  compared with the reader's `now`. Only a *source* saying closed, paused or resumed produces an event. This keeps T-041 free of any
  scheduled job or polling.
- New event types: `paused`, `resumed`, `absent_observed`, `reopened`, `merged`, `possible_duplicate`, `linked_research`. Existing
  types and their checks are unchanged.

## 6. Backfill (0008 to the new model)

Recommended mapping, inside the migration transaction, idempotent, with in-migration count checks that RAISE (and so roll the whole
migration back) on any mismatch:

| 0008 row | becomes |
|---|---|
| `bounty_opportunities` row (`github:owner/repo`) | one `repository` (`github:owner/repo`), one provisional `project`, one `program` of **`kind = 'repository_listing'`** (F10: not a bounty program, flagged so the priority engine and UI never treat it as one), one `program_version` pointing at the latest observation that mentioned it (or a synthetic `operator_supplied` "backfill" observation when none can be identified, labelled as such) |
| the opportunity itself | **the same row and the same `id`** (section 8), with new `project_id` and `program_id` columns filled |
| `opportunity_events` | unchanged; same rows, same `seq`, same actors |
| `queued` events with `research_run_id` | one `research_link` each |
| `priority_score`, `priority_reasons` | kept as legacy projection columns; the first `priority_assessment` rows are written by the scorer later, not by the migration (no invented history) |

Checks inside the migration: number of opportunities before = after; every opportunity has exactly one program, project and repository;
every `queued` event has a `research_link`; no event row changed (compare a hash of the event table before and after).

## 7. Rollback

The runner is forward-only and records checksums; there are no down-migrations, and append-only triggers block corrective DELETEs (F11).
Recommendation, **expand/contract**:

1. **T-041 is expand-only:** create tables, add nullable-then-backfilled columns, add event types. **No DROP, no RENAME, no type change, no
   removed constraint.** The current code keeps working against the expanded schema unchanged. That is the rollback: redeploying the
   previous application version needs no schema change.
2. **Contract later**, in a separate migration after a soak and owner approval: dropping legacy columns (`details`, `repository_candidates`,
   `priority_*`) only once nothing reads them.
3. **Before any hosted apply:** a recoverable backup (already policy), the migration run first against a restored copy, and a written
   emergency reverse script kept in `db/` but **not** in `db/migrations`, exercised by an integration test on a disposable database so it
   is known to work.
4. Because the backfill cannot be corrected by DELETE afterwards, its checks run inside the migration and the integration tests include a
   populated-0008 round trip.

## 8. Compatibility

Current dependants of 0008: `discovery/monitor.ts` (writes opportunities, events, observations), `discovery/store.ts` (reads and the
human decisions), `discovery/step.ts`, `discovery/api.ts`, `db/runtime-grants.json` (and the grants test that fails on any table missing
from it), and the guard function `bounty_opportunity_guard_state`.

**F12, recommendation: extend `bounty_opportunities` in place as the `opportunity` table** rather than create a new one. Every foreign
key, guard, grant and query keeps working; the design's "opportunity replaces today's row" is achieved by adding columns, not by
replacing the table. A view named `opportunity` can provide the new name to new code. The monitor path writes the new columns from T-042
onward; until then the migration's backfill and a database default (provisional project/program per new row, created by a trigger)
keep new rows complete, so old code cannot produce rows that violate the new model.

Scores: 0008 stores `priority_score integer 0..100`; T-051 produces two decimals. Keep the integer as a projection (rounded) and the
exact value in `priority_assessment`.

## 9. Decisions needed before T-041 starts

| # | Decision | Recommendation |
|---|---|---|
| D1 | Provisional project per new program (F1) | yes |
| D2 | Merges as append-only `project_merge` rows resolved through a view; split as a new event (F2) | yes |
| D3 | One observation per program version; typed columns plus `claims jsonb` (F3) | yes |
| D4 | Allow only a human `reopened` event to return a `dismissed` opportunity to `discovered` (F4) | yes |
| D5 | Keep stored state name `approved` (F5) | yes |
| D6 | Derive `ended` at read time; no clock-driven writer (F7) | yes |
| D7 | Extend `bounty_opportunities` in place; expand-only T-041; contract later (F11, F12) | yes |
| D8 | Include `priority_assessment` and `priority_allocation` in T-041, aligned with T-051 (F9) | yes |
| D9 | Keep T-144 tables out of T-041 | yes |

## 10. Tests T-041 must include (in addition to the design's section 14)

- Populated-0008 backfill round trip: counts, one-to-one mapping, untouched event hashes, `repository_listing` kind.
- Old application code (the current `discovery/*` module) passing its existing integration tests unchanged against the expanded schema.
- Merge: no row rewritten, cycle refused, merged-away project cannot merge again, human merge requires a human actor.
- Reopen: only `dismissed` → `discovered`, only by a human `reopened` event; `approved`/`queued` still immutable.
- Absence only from a `complete` observation.
- Grants manifest updated and the restricted-role suite green; a mutation spec over the new guards.
- The emergency reverse script applied to a disposable database restores the pre-migration schema and data.

## 11. What this review does not do

It does not write SQL, does not change `opportunity-model-design.md`'s approved status (it has none yet), does not touch any hosted
database, and does not resolve S1. Once the owner decides D1 to D9, the design document is updated and T-041 can start as a migration
**draft** with tests, still unapplied.
