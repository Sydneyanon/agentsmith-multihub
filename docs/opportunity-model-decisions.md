# T-041 decision brief: D1 to D9 (response to `docs/opportunity-model-review.md` section 9)

**Status: for owner decision, 2026-11-26. No migration is written or applied.** Each decision lists its alternatives, a
recommendation, and the consequences for **identity, provenance, lifecycle, backfill, rollback and compatibility**. Where a choice
does not affect a dimension, the row says "none".

---

## D1. What is a newly discovered program's project?
**Alternatives.**
- (a) A **provisional project per program**, created in the same transaction.
- (b) `project_id` nullable until corroborated.
- (c) Merge immediately on a name match.

**Recommendation: (a).**

| Dimension | Consequence of (a) |
|---|---|
| Identity | Every opportunity always has a project, and identity never depends on name similarity. Duplicates are resolved later by D2. (b) spreads NULL handling into every query; (c) merges different protocols that share a name. |
| Provenance | The project row records `created_from` (the program and observation), so its origin is traceable. |
| Lifecycle | none |
| Backfill | Each existing 0008 row gets one provisional project. Deterministic, and checked by count inside the migration. |
| Rollback | Additive rows only; the old code ignores them. |
| Compatibility | Current discovery code needs no change; a trigger creates the provisional project for rows the old monitor path inserts. |

## D2. How are two projects merged?
**Alternatives.**
- (a) An append-only `project_merge` row, with the canonical project resolved through a view; un-merge is a `project_split` event.
- (b) Rewrite foreign keys to the surviving project.
- (c) A mutable `canonical_project_id` column.

**Recommendation: (a).**

| Dimension | Consequence of (a) |
|---|---|
| Identity | One canonical project per real-world project, computed rather than stored; cycles are refused by a trigger. |
| Provenance | Each merge records its basis (two corroborating observations, or a human) and its actor. (b) and (c) lose the history. |
| Lifecycle | Merges and splits are events in the same append-only log. |
| Backfill | none (no merges exist). |
| Rollback | Undoing a merge is a split event; nothing is rewritten. (b) cannot be undone. |
| Compatibility | Readers use the resolving view; the cost is one join. |

## D3. How is field-level provenance on program versions represented?
**Alternatives.**
- (a) **One observation per version**: typed columns for queried claims, `claims jsonb` for the rest, plus `text_sha256`.
- (b) A per-field `*_observation_id` column for every field.
- (c) An EAV `program_claims` table, one row per field.

**Recommendation: (a).**

| Dimension | Consequence of (a) |
|---|---|
| Identity | A version is identified by (program, version), unchanged. |
| Provenance | Every field has exactly one source by construction. A human correction is an `operator_supplied` observation that produces a new version. (b) doubles the columns and allows mismatches; (c) is flexible but makes every read a pivot. |
| Lifecycle | Material change = a new version, compared field by field. |
| Backfill | Each 0008 row gets one version pointing at the latest observation that mentioned it, or a labelled synthetic "backfill" observation. |
| Rollback | Additive. |
| Compatibility | `details jsonb` remains on the 0008 row as a legacy projection. |

## D4. Can a dismissed opportunity be reopened?
**Alternatives.**
- (a) Only by a **human `reopened` event**, `dismissed` → `discovered`; approved and queued stay immutable.
- (b) Never: create a new opportunity instead.
- (c) Allow any state change.

**Recommendation: (a).**

| Dimension | Consequence of (a) |
|---|---|
| Identity | The opportunity keeps its id and history. (b) forks one identity into two. |
| Provenance | The reopen is a human event with an actor. This is subject to S1: it is only as trustworthy as the runtime role until T-061. |
| Lifecycle | The 0008 guard is **extended by exactly one transition**. Every other "a human decision cannot be changed" rule and its tests stay. |
| Backfill | none |
| Rollback | The guard extension is a function replacement in the same migration. Rolling back means restoring the old function, which is tested. |
| Compatibility | Existing API behaviour is unchanged until a reopen endpoint exists. |

## D5. What is the stored name of the "selected" state?
**Alternatives.**
- (a) Keep `approved` in storage, and say "selected" in docs and UI.
- (b) Rename the stored value to `selected`.

**Recommendation: (a).**

| Dimension | Consequence of (a) |
|---|---|
| Identity | none |
| Provenance | Existing events keep their exact values. (b) would require rewriting append-only rows or carrying two names forever. |
| Lifecycle | One mapping in the read model. |
| Backfill | none |
| Rollback | none needed |
| Compatibility | Full: guard, API and tests unchanged. |

## D6. How does a program become "ended"?
**Alternatives.**
- (a) **Derived at read time** from the current version's end timestamp.
- (b) A scheduled job writes `ended` events.
- (c) Only when the source says so.

**Recommendation: (a)**, plus (c) for source-stated closure.

| Dimension | Consequence of (a) |
|---|---|
| Identity | none |
| Provenance | No event claims something no source said. (b) records a clock's opinion as an event. |
| Lifecycle | Explicit source events still exist for closed, paused and resumed. "Ended" is a view. |
| Backfill | none |
| Rollback | none (no stored state) |
| Compatibility | Needs **no scheduled job and no polling**, in line with the current boundaries. |

## D7. Is `bounty_opportunities` extended in place or replaced?
**Alternatives.**
- (a) **Extend in place** (new nullable-then-backfilled columns, a view named `opportunity`), expand-only now, contract later.
- (b) Create a new `opportunity` table and migrate.
- (c) Keep both in parallel.

**Recommendation: (a).**

| Dimension | Consequence of (a) |
|---|---|
| Identity | Same row ids, so every foreign key, event and research link keeps working. |
| Provenance | The event log is untouched; its hash is checked before and after inside the migration. |
| Lifecycle | The existing guard keeps working (plus the D4 transition). |
| Backfill | Filling columns in place, with in-migration count and hash checks that raise on mismatch. |
| Rollback | **Redeploying the previous app version needs no schema change**, because nothing was dropped or renamed. The emergency reverse script is kept outside `db/migrations` and tested on a disposable database. (b) cannot be rolled back without data copying. |
| Compatibility | All four `discovery/*` modules and the grants manifest work unchanged. (c) creates two sources of truth. |

## D8. Does T-041 include the priority records?
**Alternatives.**
- (a) Include `priority_assessment` and `priority_allocation` in T-041, aligned with the T-051 output.
- (b) Defer them to T-058.

**Recommendation: (a)**, with one addition from the T-057 diagnosis: `priority_allocation` stores the **exploration-quota carry**
(the fractional share carried across periods), so the 20/80 policy can be exercised at small slot counts and audited.

| Dimension | Consequence of (a) |
|---|---|
| Identity | An assessment is keyed to an opportunity and a policy version. |
| Provenance | `inputs_sha256`, the per-feature contributions and the policy version make every score reproducible. Allocations store their seed. |
| Lifecycle | Append-only. The legacy integer `priority_score` stays as a rounded projection. |
| Backfill | **None**: no historical assessment is invented. |
| Rollback | Additive. |
| Compatibility | The tables only record. Nothing reads them to steer, so this does not enable live prioritisation. |

## D9. Do the T-144 research-memory tables belong in T-041?
**Alternatives.**
- (a) **Separate**: T-144 gets its own migration after its own design review (`docs/research-memory-design.md`).
- (b) One combined migration.

**Recommendation: (a).**

| Dimension | Consequence of (a) |
|---|---|
| Identity | The opportunity model (what to research) and research memory (what was found) meet at `research_link` and `repo_snapshots` only. |
| Provenance | Each migration's invariants are reviewed and tested on their own. |
| Lifecycle | none |
| Backfill | Neither invents data. |
| Rollback | Smaller, independent expand-only steps. |
| Compatibility | Either can ship without the other. |

---

**Summary.** The recommended set is D1 (a), D2 (a), D3 (a), D4 (a), D5 (a), D6 (a)+(c), D7 (a), D8 (a) with quota carry, and D9 (a).
- It is entirely **expand-only**: nothing existing is renamed, dropped or rewritten.
- It needs **no scheduled job, no polling and no backfilled judgement**.
- It keeps the S1 limitation visible.

Once the owner decides, T-041 starts as an unapplied migration **draft** with the tests listed in the review's section 10.
