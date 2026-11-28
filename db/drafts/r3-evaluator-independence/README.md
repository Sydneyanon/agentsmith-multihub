# DRAFT migration: R3 enforced generator/evaluator independence

- **Status:** draft only, written 2026-11-28 (`docs/architecture/integrated-research-architecture.md` §3.2, §6.2, component R3).
  **Applying it to any non-throwaway database needs the owner's R3 decision** (§12 item 2) and, because it tightens the T-144 outcome
  rule, the T-144 draft applied first (A4b). It is independent of the A29 draft (0010) and is tested with and without it.
- **Why here:** the migration runner reads only `db/migrations/`, so nothing in this directory can be applied by accident, and the release
  image build removes `db/drafts`.

## What it changes, and why

| change | why |
|---|---|
| new table `analysis_identities(actor_id, role, analysis_family, method)`, append-only, seeded with every known generator and evaluator | independence is a property of the **analysis family** (the substrate whose errors are shared), not of the id. The structural specialists and the execution validators both read code through `agentsmith-solidity-parser` (different methods: `structural-pattern-rules` vs `bounded-execution`); Slither is `slither-ir`; Foundry is `evm-execution`; attended Claude capabilities are `claude-model`. The seed mirrors `apps/api/src/analysis-identity.ts` row for row (unit-tested). |
| trigger `hypothesis_evaluations_independence` (BEFORE INSERT on the 0007 table) | refuses an evaluation whose `evaluator_id` is the hypothesis's `generator_id`, for every outcome. Today this is enforced in code (`ResearchStore.recordEvaluation`) but not in the database, so a write that bypasses the store could still record it. `no-independent-validator` (an abstention) stays allowed. |
| views `evaluation_independence` (per evaluation: `relation` = `cross_family` / `same_family` / `unknown_family` / `abstention`) and `hypothesis_independence` (per hypothesis, latest evaluation per evaluator) | lets the dossier and the loop read, from the database, whether agreement is cross-family evidence or same-family corroboration. An unlisted evaluator or generator is `unknown_family` and never counts. |
| `hypothesis_outcome_rules()` (T-144) replaced: `confirmed` needs a basis `supports` evaluation with `relation = cross_family` (was: `evaluator_id <> generator_id`). All other rules byte-identical. | same-family agreement (e.g. an execution validator supporting a structural specialist's lead) must not satisfy confirmation. |

**Not changed:** `hypothesis_status` (0007). It never derives a confirmed or supported state from evaluations (a `supports` evaluation
leaves status `unreviewed`; only reviews move it further), so no same-family agreement reaches it, and its semantics stay as they are.
`refuted` (T-144) is unchanged: it may rest on a `contradicts` evaluation of any family, because an executed counterexample is a basis for a
human decision regardless of who ran it; the human outcome is still required.

## Production implications (if applied)

- Rows: one seeded reference table (16 rows). No existing row is changed. The trigger adds one indexed lookup per evaluation insert.
- Behaviour: an evaluation by the claim's own generator is refused by the database (the code already refuses it). A human `confirmed`
  outcome whose only technical basis is a same-family evaluation (today: an execution validator on a specialist lead) is refused; it needs
  a cross-family evaluation (e.g. `foundry-forge` on a specialist lead, or an execution validator on a Slither lead).
- A new evaluator or generator must be added to `analysis_identities` (by a migration) before its evaluations can count toward
  `confirmed`; until then it is `unknown_family`, which fails closed.
- Grants: the runtime role needs `SELECT` on the table and both views (`runtime-grants.draft.json`), because the outcome rule reads
  `evaluation_independence` with the inserting role's privileges.

## Rollback

`0015_evaluator_independence.rollback.sql` drops the views, the trigger and its function, the helper function and the table, and restores
`hypothesis_outcome_rules()` exactly as 0009 defines it. Tested: the catalog fingerprint after rollback equals the one before the draft.
Only valid while no evaluation or outcome decision depends on the identities table in a way that must be kept.

## Tests

`apps/api/src/integration/evaluator-independence-draft.integration.test.ts` (throwaway databases, owner and restricted runtime role) and
`apps/api/src/analysis-identity.test.ts` (seed equals the code registry).

## To promote it (after the R3 decision and A4b)

Promote T-144 first; move `0015_evaluator_independence.sql` into `db/migrations/` under the next free number; merge
`runtime-grants.draft.json` into `db/runtime-grants.json`; delete this directory.
