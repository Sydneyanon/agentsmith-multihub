# Discovery → research bridge (task 5) and programme lifecycle (task 4)

This connects bounty-programme **discovery** to the existing **vulnerability-research** pipeline, so an eligible programme flows into
research automatically — without a second scanning pipeline and without manual target feeding. It reuses the acquisition layer's
`createRepositoryResearchRunIn`; it adds no new research engine.

## What was already there (reused, not duplicated)

- **Run creation**: `createRepositoryResearchRunIn(client, { repository, ref? }, …)` (`apps/api/src/acquisition/step.ts`) — creates a
  `repository_research` workflow run + `acquire_repository` step, composable into a caller transaction.
- **Passive, commit-pinned, manifest-hashed acquisition**: `acquireRepository` + `ResearchStore` (sealed snapshots).
- **Worker** (`worker-main.ts` → `worker-runtime.ts`): claim/lease/dispatch loop, gated OFF by default (`STRUCTURAL_ANALYSIS_ENABLED`,
  `ENGINE_LOOP_ENABLED`). Nothing runs until the worker is activated (a separate owner decision).
- **AI budget**: every model call goes through `AiBudgetGateway.execute` ($25/mo caps in `budget_policies`). The bridge never calls a
  model, so it cannot spend; the worker inherits the budget automatically for any step it runs.
- **Eligibility**: `classifyEligibility` tiers a programme (`ineligible` → `out_of_engine_scope` → `needs_verification` → `eligible`).
- **Candidate feed**: `researchCandidates` / `GET /v1/bounties/candidates`.

## What this adds

1. **`db/migrations/0012_bounty_research_link.sql`** — `bounty_research_links` (programme → repository → `workflow_run_id`, with
   reason/provenance). **Excluded from the production image** (like 0008); it ships only on an approved deploy.
2. **`repo-resolve.ts`** — turns a programme's resolved record (officialUrl + otherUrls) into GitHub `owner/name` targets. This was the
   biggest gap the audit found: nothing previously mapped a programme to a repository.
3. **`lifecycle.ts`** — a deterministic, evidence-based programme state machine (task 4): `discovered → officially_verified →
   scope_retrieved → smart_contract_target_confirmed → reward_confirmed → eligible_for_research → queued_for_scan → scanning →
   scanned → finding_under_review → completed`, plus side states `needs_verification / out_of_engine_scope / ineligible / paused /
   unavailable / source_restricted`. Discovery is never conflated with eligibility; each milestone requires all earlier ones.
4. **`promote.ts`** — `promoteEligibleProgrammes(pool, opts)`: the bridge. For each **eligible** programme (and only eligible — a
   community-reported lead is never promoted), it resolves repositories, skips ones already linked, **reuses** an existing run when
   another programme already covers the same repository+ref (no re-analysis), otherwise creates a new run and records the link in the
   same transaction. Bounded by `maxNewRuns`. `--dry-run` decides without creating.
5. **`promote-main.ts`** (`npm run bounties:promote`) — one promotion pass, then exit.

## Repository de-duplication (task 6)

- A programme already linked to a run for `(repository, ref)` is skipped (`already_linked`).
- A repository already covered by another programme's non-failed run is **reused** — a provenance link to the existing run is recorded
  instead of dispatching a second run on the same code.
- Commit-level change detection and the per-commit "already analysed" check build on the acquisition layer's sealed, commit-pinned
  snapshots and the existing `research_coverage` (component-level) memory; the bridge's repository-level reuse is the first gate.

## How spending stays bounded (task 5)

The bridge creates only **queued** runs and calls no model. All AI spend is behind the worker + `AiBudgetGateway` ($25/mo global,
daily, per-workflow and per-tier caps), which this code does not touch. `maxNewRuns` bounds how many runs a single pass can create.

## Repository intelligence & incremental rescanning (task 6)

`repo-intel.ts` provides cross-run knowledge the per-run `findSnapshot` could not:
- `analysedCommits(repo)` / `hasAnalysedCommit(repo, commit)` / `latestSealedSnapshot(repo)` — which commits of a repository any run has
  already sealed.
- `changedFilesBetween(base, head)` — the added/removed/modified files between two sealed snapshots, by git blob identity: the set an
  incremental rescan should analyse instead of repeating the whole repository.
- `planRepositoryResearch(repo, headCommit)` — the decision a repository monitor makes: `already_analysed` (skip), `full` (never seen),
  or `incremental` (analyse files changed since the latest sealed baseline).

The bridge already uses `latestSealedSnapshot` to reuse a run that analysed a repository via any path (not only a bounty link).

## The repository monitor — the autonomous loop (migration 0013)

`monitor.ts` closes the loop. For every repository the bridge has linked, `monitorRepositories` resolves the live HEAD of the default
branch (reusing the acquisition `RepositorySource.getRepository` / `resolveCommit`), runs `planRepositoryResearch`, and — when the
commit is new — automatically queues an incremental (or first-pass) `repository_research` run at that exact commit, linking it to the
owning programmes. No human initiates any of it. State lives in `repository_monitors` (last observed HEAD, outcome, backoff) with an
append-only `repository_monitor_checks` log (0013; excluded from the production image like 0008/0012).

Guarantees, all covered by `repo-monitor.integration.test.ts` on real Postgres:
- **Full cycle demonstrated**: an eligible programme is promoted → its repo is mapped → first run queued → the repo is sealed at commit
  A (worker, simulated) → the monitor sees HEAD = B → it queues an incremental rescan at B with a provenance link, decision
  `incremental`, baseline A. End to end, no manual step.
- **Idempotent**: a second pass at the same HEAD creates no duplicate (`already_queued`).
- **fetch ≠ researched**: fetching HEAD never marks a repo analysed; `up_to_date` requires a sealed snapshot at that commit.
- **Failure handling**: a deleted/inaccessible repo → `unavailable` and monitoring disabled; a rate-limit/timeout/5xx → backoff honouring
  `Retry-After`, kept enabled, retried next pass; repeated failures eventually disable it.
- **Bounded**: `maxRescans` caps runs created per pass; only queued runs are created (no model calls).

The injected edges (so the loop is testable without live GitHub / the worker) are HEAD resolution (the GitHub source) and snapshot
sealing (the worker). In production both are real: `monitor-main.ts` (`npm run bounties:monitor`) uses the real `GitHubSource`, and the
worker seals snapshots. The loop is **built and exercised**, but **not scheduled in production** (needs 0012+0013 deployed and the worker
active — owner decisions).

## Worker reliability (audited — already robust, no change)

The existing worker was audited for the autonomy concerns (stuck/lost jobs, duplicate execution, recovery). It already: reclaims steps
whose lease expired (`status='running' AND lease_expires_at < now()`), claims with `FOR UPDATE … SKIP LOCKED` (no duplicate execution),
reaps exhausted leases, extends leases by heartbeat, backs off exponentially on infrastructure failure, and bounds retry attempts —
all covered by `worker-loop.test.ts` / `worker.ts`. No change was warranted; this is recorded so it is not re-audited blindly.

## Current operational state (honest)

- Implemented and tested (unit + real-Postgres integration). **Not deployed** (0012 is out of the production image).
- With Sherlock/HackenProof/Immunefi direct collection disabled, there are **zero** `eligible` programmes today (the 388 board
  programmes are `community_reported` → `needs_verification`), so the bridge would promote **nothing**. It becomes active only once a
  source that yields officially-confirmed programmes is enabled **and** a deploy ships 0012 — both owner decisions.
- The research **worker** is still off; even with runs queued, nothing is analysed until worker activation is approved.
