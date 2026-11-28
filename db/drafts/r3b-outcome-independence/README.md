# DRAFT R3b: cross-family confirmation in the T-144 outcome rule

- **Status:** draft only (2026-11-28). It is the remainder of the former R3 draft after **R3a was promoted to
  `db/migrations/0016_research_independence.sql`** (analysis identities, the trigger refusing a self-evaluation, the
  `evaluation_independence` and `hypothesis_independence` views). R3a needs only 0007; R3b does not.
- **Why it stays a draft:** it replaces `hypothesis_outcome_rules()`, a function the T-144 draft (`db/drafts/t144-research-memory`,
  0009) defines. It cannot exist without 0009, so **it ships with 0009, after it**, under the owner's T-144 (A4b) and R3 decisions.
- **Requires:** 0016 (it reads `evaluation_independence`) and the T-144 draft. Independent of the A29 draft (0010).

## What it changes

| change | why |
|---|---|
| `hypothesis_outcome_rules()` (T-144) replaced: `confirmed` needs a basis `supports` evaluation with `relation = cross_family` in `evaluation_independence` (was: `evaluator_id <> generator_id`). All other rules byte-identical to 0009. | same-family agreement (an execution validator supporting a structural specialist's lead: both read code through the AgentSmith parser) is corroboration, not independent confirmation. |

`refuted` is unchanged: it may rest on a `contradicts` evaluation of any family (an executed counterexample is a basis for a human
decision whoever ran it); the human outcome is still required.

## Grants

None of its own. The rule reads `evaluation_independence` with the inserting role's privileges; `db/runtime-grants.json` already grants
`SELECT` on it (0016).

## Rollback

`r3b_outcome_independence.rollback.sql` restores `hypothesis_outcome_rules()` exactly as 0009 defines it. Tested: the catalog fingerprint
after rollback equals the one before R3b (`apps/api/src/integration/evaluator-independence-draft.integration.test.ts`).

## To promote (after A4b and the R3 decision)

Promote T-144 (0009) first; move `r3b_outcome_independence.sql` into `db/migrations/` under the next free number after 0009's promotion;
delete this directory.
