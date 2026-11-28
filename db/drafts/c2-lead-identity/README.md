# DRAFT C2: a database index of the shared lead identity

- **Status:** draft only (2026-11-28). **Not applied anywhere, and not needed for C2 to work.** It was applied and rolled back once on a
  throwaway local database to check that the SQL is valid; it has no integration test of its own.
- **Requires:** 0007. Independent of the other drafts.
- **Needs the owner's approval** before it can become a migration (decision 11 of `docs/architecture/engine-inventory-and-coordination.md`:
  "a cross-run lead index, or R4 `hypothesis_contributions`: choose one").

## What C2 does today, without it

The lead key is derived in code (`apps/api/src/analysis/solidity/lead-identity.ts: leadKey`) from
`(repository, class, file, contract, function)` and stored inside existing JSON: `lead_keys` in the output of the step that produced the
hypothesis (`analyze_structure`, `slither_scan`). Investigations are built from those records, the hypothesis rows and the evaluations.
Each recorded key is re-derived from its recorded anchor on every read and refused if it does not match.

## What the draft would add

| object | why |
|---|---|
| `hypothesis_leads` (one row per hypothesis: key, anchor, the step that recorded it) | **Indexed cross-run lookup.** `leadHistory` scans every step output with `jsonb_array_elements`; that is fine for tens of runs and wrong for thousands. |
| primary key on `hypothesis_id`, append-only trigger | **One key per hypothesis, enforced by the database.** `workflow_steps.output` is written once by the application, but the database does not make it immutable the way it does research records. |
| `hypothesis_leads_guard` | the key must be the key of the anchor stored beside it, checked by the database too. |
| view `lead_investigations` | the grouping the application computes, readable in SQL. |

## What it deliberately does not do

- It does not merge, edit or supersede hypotheses, and it adds nothing to the independence rules (0016 is untouched).
- It does not replace the JSON record: the step output stays the provenance of who recorded the key and when.

## Grants (if promoted)

`SELECT, INSERT` on `hypothesis_leads` and `SELECT` on `lead_investigations` for the runtime role; nothing else.

## Rollback

`c2_lead_identity.rollback.sql` drops the view, the table and the guard function.
