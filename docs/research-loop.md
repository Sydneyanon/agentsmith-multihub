# The research loop: first end-to-end vertical slice (2026-11-27)

**Status:** implemented on branch `claude/agentsmith-multihub-assessment-j5j4q3`; tested on throwaway local databases only. **Nothing is
deployed, no migration is applied to any persistent database, no worker is activated and nothing is scheduled.** It conforms to T-149
(one `repository_research` workflow), extends the T-051 priority engine in place (T-052), implements the A28 decision-record design as
the A29 draft, and uses the T-144 memory draft. It is aligned with the T-040 opportunity model and builds on 0008; it is not a parallel
model.

## 1. Verified state before this work (read-only reconciliation, 2026-11-27)

| Item | Finding | Classification |
|---|---|---|
| Default branch | `main` = `b50ff6f` (2026-11-25). No PR has been merged | authoritative for "merged" only |
| Deployed code | Fly `agentsmith-hub` release **v6**, image `sha256:7f99bf27…`, built from **`837aeb9`** with migrations **0001–0007**; machine `2870320f99dd68` stopped (auto-stop); no worker | implemented + verified (deployed) |
| Branch of record | `claude/structural-validation-and-workflow` = `fd1fcab` = `main` + 123 commits; contains all 20 open draft PRs (#1–#20 are stacked; #20's head is 49 commits behind it). The assigned branch was `main` + 2 and is now fast-forwarded to `fd1fcab` (no history rewritten) | authoritative for "built" |
| Tags | `structural-candidate-1..3` (e155702, b95529f, b4fb9a6), all ancestors | historical |
| Schema | `db/migrations` 0001–0008; production has 0001–0007 (0008 discovery not deployed); drafts: T-144 `0009` (A4b), now A29 `0010` | 0008 implemented-not-deployed; drafts designed-not-applied |
| API and Control Room | engine status, research API, Control Room (CR1/CR2), A33 | implemented + verified (deployed at 837aeb9) |
| Worker runtime | legacy intake chain; `repository_research` acquisition; structural analysis behind `STRUCTURAL_ANALYSIS_ENABLED`; discovery monitor behind `DISCOVERY_ENABLED` and per-source enablement | implemented, not activated (A26) |
| Discovery and intake | 0008 sources, observations, opportunities, events, human approval; one adapter (`github_org_repos`) | implemented-not-deployed |
| Priority engine | T-050/T-051 `priority/` (score, policy, coverage, outcomes, replay, from-model) | implemented, offline only (not wired to anything) |
| Research memory | T-144 draft (coverage, effort, outcomes with DB-enforced rules) | designed; draft tested; blocked by A4b |
| Decision records | A28 design | designed-not-implemented (now drafted, A29) |
| Tests | `npm run verify` at `fd1fcab`: 863 unit, 261 integration as owner, 261 as restricted role, all passing | verified |

**The `main` = `b50ff6f` versus `837aeb9`/`fd1fcab` discrepancy** is resolved by the release record, not by recency: `main` is only the
base of an unmerged stack. The deployed image's `build-info.json` names `837aeb9`, which is an ancestor of `fd1fcab`. So `fd1fcab` is
the code of record, `837aeb9` is what runs, and `main` lags both because the owner has merged nothing (no merge without approval).

**Other discrepancies found:**
1. **A second opportunity scorer.** `discovery/priority.ts` gives 0008 rows a simple 0–100 ordering (+40 repository, +40 fresh, +10
   keyword). It is not the T-051 engine. The loop does not use it (it scores with `priority/score.ts`); consolidation is T-198.
2. **T-191 status text** says the owner instructed "no migration file"; the register row for A28 says "plus a migration draft on
   disposable DBs only". The new A29 draft lives in `db/drafts/` (the runner cannot apply it) and is applied only to throwaway databases,
   which is within this task's "no production migrations" instruction. The owner should confirm (A29 review).
3. **Selection by policy vs T-040.** T-040 says a discovered program is inert until a human selects it. The slice therefore has the
   policy *rank and recommend*; a human selects (step 3), through the existing `approveOpportunity` path.

**The single biggest blocker** to an autonomous loop was that nothing could *remember* or *decide*: there was no durable place for
decisions, coverage or outcomes (A28 design-only; T-144 draft unapplied), and no code connected priority → assignment → results → memory
→ next action. Every component existed in isolation. This slice closes that gap in code; applying the two drafts (A4b + A29) is now the
blocker to running it anywhere persistent.

## 2. What the slice does, end to end

| # | Step | Owner | Implementation |
|---|---|---|---|
| 1 | Opportunity enters | human (manual import) or adapter | `registerManualOpportunity`: a `manual_import` source (DB forbids enabling it, so it is never polled), an `operator_supplied` observation holding the claims, the 0008 identity deduplicated by `canonical_key`; a second sighting is a new observation on the same row |
| 2 | Provenance recorded and verified | **AgentSmith** (records and enforces); verdicts by a human | `recordVerification`: human `verified` events per check (program official, repository official, scope, eligibility) with evidence; the DB rejects a verification by the monitor or the policy, and a "verified" without evidence |
| — | Prioritise | **AgentSmith** | `rankOpportunities`: screens out unverified, possible duplicates (same verified repository as an earlier opportunity) and ineligible items, each with a reason and an `assessed` event (never deleted, never blocking a human); scores the rest with T-051; **recommends** one; creates no work |
| 3 | Repository selected | human | `selectOpportunity`: AgentSmith refuses a repository not verified as official and in scope; the human decision record, the existing `approved`/`queued` events and the acquisition run are one transaction |
| 4 | Sealed snapshot created or loaded | worker (existing acquisition) | `acquire_repository` seals a commit-pinned snapshot; an assignment re-seals the same version in its own run and the specialist checks commit + manifest hash |
| 5 | Project and research state mapped | **AgentSmith** | `mapAndAssign`: protocol model (P1–P3) from the sealed sources, stored content-addressed; coverage memory per component content hash, across snapshots |
| 6 | Target selected, with reason | **AgentSmith** | component priority (`priority/component.ts`, T-052): unexplored specialist classes at this hash, entry points, outward calls, unguarded writes, cost; every point named and explained; one slot; every 5th decision in a scope explores (seeded, recorded rule) |
| 7 | Research assignment created | **AgentSmith** | a `repository_research` run (`acquire_repository` → `investigate_target` → `challenge_target`), pinned to the decided commit and component hashes, created in the same transaction as the decision, linked from the chosen candidate |
| 8 | Specialist executes | worker (structural specialists) | `investigate_target` refuses a changed component version; stores only leads on the target component, with hash-verified evidence spans |
| 9 | Structured results return | specialist | step output: targets, classes examined, lead ids, counts by class, model hash, effort; never source text |
| 10 | Evidence and independent challenge recorded | **AgentSmith** | `challenge_target` runs the independent evaluators on exactly this assignment's leads; `ingestInvestigation` builds a per-lead account in three planes |
| 11 | Outcome to durable memory | **AgentSmith** | coverage per target × class (`examined`, or `not_modelled` for classes with no specialist), effort per step, both linked to the decision; idempotent |
| 12 | Next action from updated state | **AgentSmith** | `mapAndAssign(…, "follow_up")`: request human review of leads supported by an independent evaluator (once each); assign the next component; when every component is examined, record "complete" and return to the registry |

**Three provenance planes, never mixed** (`accountFor`): (1) the claim and its generator (a deterministic rule today; a model later);
(2) evidence only from evaluators different from the generator ("no independent validator" abstentions are not evidence); (3) human
reviews and outcomes. A machine never produces an outcome: `hypothesis_outcomes` is human-only, and the database refuses "confirmed"
without a human adjudication review **and** independent supporting evidence (T-144 rules, exercised by the test).

**Outcome ledger** (`outcomeLedger`): confirmed, refuted, inconclusive, duplicate and missed come only from human outcomes; **unexplored**
is the count of component × class pairs not examined at their current version, and includes the classes AgentSmith has no specialist for.
Machine leads without a human outcome are counted separately as *unadjudicated*, never as an outcome.

**Classes not modelled** (`engine/classes.ts`): arithmetic precision, accounting invariants, oracle manipulation, economic incentives and
liveness. They are recorded as `not_modelled`, so the memory says "nobody looked" rather than implying a clean result: the structural
analyzer cannot see these classes, and the memory records that blind spot explicitly.

## 3. Records (A29 draft, `db/drafts/a29-engine-loop/`)
- `research_decisions` and `research_decision_candidates` as designed in A28, append-only, with: a stored, hashed policy for every
  policy decision; features that must cite a source or state why they are unknown; `selected` consistent with the action; the resulting
  run created no earlier than the decision and the resulting step inside that run.
- Deviations from A28 (recorded here): actions `recommend` (opportunity level: the policy ranks, a human selects),
  `request_human_review` and `complete`; a candidate `reason` column; `human` decisions must be `manual`.
- `research_coverage.decision_id` and `research_effort.decision_id` (A28 §2.3).
- On 0008, aligned with T-040: `manual_import` sources that cannot be enabled; `provenance_kind` and `claims` on observations;
  `verified` (human only, with evidence) and `assessed` (policy only, with a decision) event kinds; the 0008 state guard is unchanged,
  so only human events move an opportunity's state.
- Exact rollback to 0001–0008 + T-144 (tested by catalog fingerprint). The runtime role gets SELECT and INSERT only on the new tables.

## 4. Safety properties (tested)
- Nothing runs unless invoked. There is no scheduler, no route and no worker wiring that starts the loop. Workers claim the two new
  steps only when `STRUCTURAL_ANALYSIS_ENABLED` **and** `ENGINE_LOOP_ENABLED` are exactly `true` (both off everywhere).
- In production the new code is inert: the tables do not exist there, and the image build removes `db/drafts`.
- Passive only: the specialist reads a sealed snapshot; nothing is executed, fetched, signed or sent. No model is called and no budget
  is spent. Manual import sources can never be polled.
- No frozen benchmark or label is read or changed (the fixture is `eval/dev/contracts`, read-only, as other tests use it).

## 5. Not done, and why
- **Operator entry point: done (T-199, 2026-11-27).** `npm run loop -- <command>`; see §7.
- **No Control Room panel** for "why this target", coverage and outcomes (A28 §5); read-only, after the tables exist (T-200).
- **Re-acquisition per assignment**: snapshots belong to their run (0007), so each assignment downloads and re-seals the same commit.
  Blobs are content-addressed, so storage is not duplicated, but the download is. A within-database snapshot copy would remove it.
- **Policy evaluation** (T-192's offline evaluation on corpus 5) is not run; weights are the stated v1 values, not tuned.
- APEX and Weirdness specialists plug in as further generators and evaluators through the same records; none is implemented here.
- The discovery adapter path still uses its own simple scorer (T-198).

## 6. Approvals the next controlled step needs
1. **A29** (review this draft; owner to confirm drafting it was in bounds) and **A4b** (T-144), to apply both to a named environment.
2. **A38 (new):** run one operator-invoked loop cycle on a non-production database against one manually registered public opportunity:
   stages invoked by a person through the T-199 CLI, one worker with both switches on for the duration, no scheduler, no paid models.
3. **A26** if that worker runs on Fly (production compute) rather than locally.

## 7. Operator CLI (T-199)
`npm run loop -- help`. One command per stage:
- **Read-only:** `status`, `next`, `registry`, `show-decision`, `ledger`, `leads`.
- **Human:** `register`, `verify`, `select`, `adjudicate`.
- **AgentSmith:** `rank`, `map`, `ingest`.
- **Execution:** `run-assignment`.

Rules (all tested in `engine-cli.integration.test.ts`):
- **Dry run by default, and genuinely non-persistent** (hardened 2026-11-27).
  - **Database:** the stage runs in a transaction that is always rolled back.
  - **Sequences:** they are not transactional, so every sequence the preview advanced is set back (reported if another session moved it).
  - **Everything else:** the stage runs under a side-effect guard that refuses any network request (the outbound fetch), subprocess or
    file write (the tool runners) and fails loudly.
  - **Tested:** the database fingerprint, sequences included, is identical after a dry run of every write command; no tool working
    directory is created. Mutation checks confirm the tests catch a missing sequence reset and a disabled guard.
  - The output prints the decision, its ranked candidates, score contributions and reasons. Only `--execute` with
    `--confirm <database name>`, or the name typed at the prompt, commits.
- **One run only.** `run-assignment` runs the steps of the named run once, in-process, and claims only that run's steps. Acquisition
  ALWAYS needs `--allow-network`; without it nothing is claimed and the repository source is never built (tested; the real GitHub path
  is not exercised by any test). There is no daemon, no poll, no scheduler and no Fly worker.
- **Disposable databases only.**
  - The URL comes from `--database-url` or `RESEARCH_LOOP_DATABASE_URL`; `DATABASE_URL` is ignored.
  - The host must be loopback.
  - The name must be `agentsmith_test_*` or `agentsmith_scratch_*`.
  - A production marker in the environment refuses.
  - The drafts must already be present: the tool never applies a migration.
  - A remote database, and so A38, is refused.
  - The password is never printed.
- **`next`** derives the next action from the recorded state alone, with who acts (AgentSmith, operator or human) and why. The test drives
  the whole loop by following `next`.
- Capabilities and their integration: `docs/specialist-capabilities.md`.
