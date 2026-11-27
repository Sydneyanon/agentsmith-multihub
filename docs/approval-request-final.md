# Consolidated approval request — first real research run

Date: 2026-11-27. Supersedes the A1–A9 table in `docs/operational-recovery.md` §4 (release `24f833d` / `sha256:3d67f9a1…`,
which is withdrawn because it does not contain the analyzer root-cause fix).

**Release:** commit `5d6ccd1587ea6e5fb8a7bd683f9ddc174bc8f68c`
**Image:** `registry.fly.io/agentsmith-hub@sha256:b3a6327ebea6c1d45a92132041fd5d5361cd7ad9e9a7da0c5ca17325f8ee1a27` (tag `hub-5d6ccd1587ea`)
Status: Implemented, Tested, Integrated, **Released** (built, smoke test 39/39, pushed to the registry, pushed image checked against
the tested layer). **Not deployed.** Nothing in production has changed.
Migrations shipped: 0001–0007, 0011, 0012, 0013, 0014 (0008 and all drafts are excluded from the image, so they can't be applied from it).

## 1. The three checks you asked for

### 1.1 Analyzer citation error: root cause found and fixed (commit 5d6ccd1)

- **Root cause.** In `apps/api/src/analysis/solidity/trace.ts`, a call-chain frame recorded the *callee's definition file* together
  with the *caller's call-site line*. When a contract called an inherited internal function defined in another file, the
  citation pointed at line N of the wrong file. In the real repository this produced "lines 157-157 do not exist in
  …/PerpEngineState.sol". Two consumers were affected, and both are now correct: the supporting spans of specialist findings, and the
  call-edge evidence in the protocol model.
- **Fix.** A frame is the call site, so both the file and the line come from the caller (`file: ctx.file`).
- **Regression test.** `chain-attribution.test.ts` uses a Base.sol (7 lines) and a Child.sol (about 156 lines) that calls the inherited `_notify`.
  It failed 3 of 3 checks before the fix and passes all 3 after it.
- **No silent incompleteness.** Every dossier now carries a coverage record that is included in its content hash. The record is
  `complete`, `partial`, `not_analysable` or `not_analysed`, and it lists the problems found. A dossier that is not complete says,
  near the top, "**This is NOT a complete investigation of the snapshot.**" Three cases are covered:
  - A malformed Solidity file is now detected (by a delimiter-balance check) instead of parsing to nothing silently.
  - Any residual uncitable finding is rejected and listed as a problem, not stored.
  - A repository with no Solidity is reported NOT ANALYSABLE, not clean.
  All three cases are tested end to end through the real worker.
- **No scoring drift.** Every frozen corpus (dev, heldout, heldout2–4, benchmark-b v3) scores identically before and after the fix.
- **Suites.** Typecheck clean. Unit tests: 1002 passed. Integration tests: 369 of 369, as the owner and twice as the restricted role.

### 1.2 Rollback procedures, rehearsed after records exist

The rollbacks were rehearsed on disposable databases that hold the production schema shape and contain records in all four new tables.

| step | rollback | evidence |
|---|---|---|
| **A1** API release | `fly deploy --config fly.hub.toml --image registry.fly.io/agentsmith-hub@sha256:95c65bb0d39d4af04060d210500cc4312e9e992d12941073fcdad7cf13ebd6c8 --ha=false` | Old API code (5633897) was run against a database with 0012–0014 applied and populated. Every endpoint returned 200 (`/health/ready`, `/public/bounties.json`, `/bounties/tv`, `/v1/bounties*`, `/v1/research/overview`). Engine status lists the extra migrations as `schema.unknown`, which is informational and raises no attention reason. **A1 can be rolled back without rolling back A3.** |
| **A2** collector | `fly machine update 8747e47a1501d8 --app agentsmith-hub --image registry.fly.io/agentsmith-hub@sha256:faef363a35bca3c63a4d7a8f7e685fbd63a20329551dba3118882a975d28d0f9 --yes` | Old collector code (c3cb953) ran against the same database and recorded its collection run normally. |
| **A3** migrations 0012–0014 | **Preferred: leave the tables in place and stop the producers** (destroy the enrich, bridge, monitor and worker machines). The tables are new and additive, and no pre-existing code reads them (see A1). **Only if removal is required:** export the four tables' data, then drop the four tables and their `schema_migrations` rows in one transaction. Restoring means re-running the migrate runner and then restoring the data. | Rehearsed on a populated copy. Before: pre-existing-table fingerprint `b95a81a22d437673`, new-table data fingerprint `2afd8077d7f6df8d`. The export was 3,445 bytes. After the drop, the pre-existing fingerprint was **unchanged** and the migration count went from 11 to 8. After the re-migrate and restore, the new-table fingerprint was `2afd8077d7f6df8d` again (**byte-identical**) and the pre-existing fingerprint was still unchanged. |
| **A4** sources | `POST /v1/bounties/sources/sherlock/disable`, `…/hackenproof/disable` | Collected programmes remain as history. Also stop the bridge so that nothing new is promoted. |

What happens to production records in each case:

- **Research records live in pre-existing tables** (`workflow_runs`, `workflow_steps`, `repo_snapshots`, hypotheses, evidence).
  Dropping 0012–0014 does not touch them; the rehearsal fingerprint proves it. They remain as commit-pinned history.
- **Foreign keys point only from the new tables to `bounty_programs` and `workflow_runs`**, with ON DELETE CASCADE. Deleting a run
  therefore removes its link row, but nothing in the new tables can delete anything older.
- **Partial failure during A3.** The runner applies each file in its own transaction, under an advisory lock, with a checksum guard.
  If, say, 0013 fails, 0012 stays committed and 0013 leaves no trace. Engine status then lists 0013 and 0014 as `schema.missing`,
  which raises an attention reason but does not block the API. Once the cause is fixed, re-running the same command applies
  only the remaining files.
- **Producing the export in production** is the one step that cannot run from inside the image, which has no `pg_dump`. You would
  run it from your own computer through `fly mpg proxy`. Because the preferred rollback (leave the tables, stop the producers) needs
  no export, this path is only for the case where removal is truly required.
- **A bad research run** is handled by stopping its machine, cancelling the run, and deleting its link row. Queued steps without a
  worker wait harmlessly.

### 1.3 The first worker is confined to its run

- **Assigned run only.** `WORKER_ONLY_RUN_ID=<run>` adds `workflow_run_id = $run` to the claim SQL. If the id does not exist, the
  worker exits with code 66 before claiming anything. With `WORKER_EXIT_WHEN_RUN_DONE=true`, it exits once that run finishes.
  - Tested end to end: two decoy research runs, whose steps this worker's step keys *could* claim, stayed `queued` with
    attempt 0 and no snapshot while the scoped worker completed its own run.
- **Least-privilege role.** The worker connects with `WORKER_DATABASE_URL` (the `agentsmith_worker` user from A7: role `reader`
  plus the grants in `db/runtime-grants.json`).
  - `HUB_REQUIRE_RESTRICTED_DB_ROLE=true` checks the role **before** any claim. A role that could own, create, delete, truncate
    or disable triggers stops the worker with exit code 78, and nothing is claimed. This was tested, including the case where
    the worker is handed the owner role.
  - The full integration suite passes when run as the restricted role.
- **Concurrency one.**
  - The worker is one process with one sequential loop (`await execute(step)` per claim).
  - The bridge-to-dossier test observed at most one running step across **all** runs.
  - Only one worker machine is created, and it has `--restart no`.
- **No other work.**
  - `ENGINE_LOOP_ENABLED` is unset, so the claimable step keys are limited to intake and analysis; the engine/discovery steps are excluded.
  - `DISCOVERY_ENABLED` is unset, so there is no discovery scheduler.
  - No model adapter exists, so the run costs $0 and the $25/month gateway is never exercised.

### 1.4 Counts are local rehearsal results, not production

The **168 eligible programmes** (Sherlock 12, HackenProof 156) and the **~61 Solidity/EVM** programmes come from a live collection
into a **disposable local database**. **They are not production counts.** Production today has 388 programmes, all
`community_reported`, and 0 eligible. Production counts will be measured after A4, and they may differ: listings change, and the
production collector's network differs from this container's.

## 2. Approval request — execute in order, verifying each step before the next

`IMG=registry.fly.io/agentsmith-hub@sha256:b3a6327ebea6c1d45a92132041fd5d5361cd7ad9e9a7da0c5ca17325f8ee1a27`

| # | approval | exact command | verify | rollback |
|---|---|---|---|---|
| **A1** | deploy | `fly deploy --config fly.hub.toml --image $IMG --ha=false` | `/health/ready` 200; `/v1/engine/status` build commit `5d6ccd1`; `schema.missing` = 0012–0014 until A3 | §1.2 A1 |
| **A2** | deploy | `fly machine update 8747e47a1501d8 --app agentsmith-hub --image $IMG --yes` (schedule unchanged) | next hourly collection recorded | §1.2 A2 |
| **A3** | production migration | `fly machine run $IMG --app agentsmith-hub --region syd --rm --restart no -e MIGRATE_CONFIRM_REMOTE_HOST=<database host> --entrypoint sh -- -c 'DIRECT_DATABASE_URL="$DATABASE_URL" exec node dist/scripts/migrate.js'` | output is exactly `Applied 0012_…`, `Applied 0013_…`, `Applied 0014_…`; engine status `schema.missing=[]` | §1.2 A3 |
| **A4** | source activation | `POST /v1/bounties/sources/sherlock/enable` and `…/hackenproof/enable` | next collection: both sources `fetched`; production eligible count > 0 (measured, not assumed) | §1.2 A4 |
| **A5** | secret (optional, recommended) | `fly secrets set GITHUB_TOKEN=… --stage` (fine-grained, public-repository read only, no scopes) | enrichment `deferred` = 0 | `fly secrets unset GITHUB_TOKEN` |
| **A6** | production write (mapping rows only) + read-only dry run | `fly machine run $IMG dist/apps/api/src/bounties/enrich-main.js --max 10 --app agentsmith-hub --region syd --rm --restart no`, then `fly machine run $IMG dist/apps/api/src/bounties/promote-main.js --dry-run --structural --max 3 --app agentsmith-hub --region syd --rm --restart no` | per-programme log; mappings with `official_documentation` and a GitHub id; dry run lists the candidates **for you to choose one** | `DELETE FROM bounty_repository_mappings` (new table only) |
| **A7** | worker user and grants | **you run** `fly mpg users create <cluster> --username agentsmith_worker --role reader`, then `fly secrets set WORKER_DATABASE_URL=… --stage`; I run `apply-runtime-grants.js` with `RUNTIME_ROLE=agentsmith_worker RUNTIME_ROLE_READONLY_MEMBERSHIPS=reader RUNTIME_GRANTS_ALLOW_ABSENT=true`, first with `RUNTIME_GRANTS_DRY_RUN=true`, then for real | dry-run plan shown to you; grants gate passes | `fly mpg users delete agentsmith_worker`; `fly secrets unset WORKER_DATABASE_URL` |
| **A8** | production write + **worker activation** | `fly machine run $IMG dist/apps/api/src/bounties/promote-main.js --structural --max 1 --app agentsmith-hub --region syd --rm --restart no` (creates exactly one run for the repository you chose), then `fly machine run $IMG dist/apps/api/src/worker-main.js --app agentsmith-hub --region syd --name research-run-1 --vm-size shared-cpu-1x --vm-memory 512 --restart no --env STRUCTURAL_ANALYSIS_ENABLED=true --env HUB_REQUIRE_RESTRICTED_DB_ROLE=true --env WORKER_ONLY_RUN_ID=<run> --env WORKER_EXIT_WHEN_RUN_DONE=true` | four steps succeeded; snapshot sealed at an exact commit; dossier with its coverage status; 0 model-usage events | `fly machine stop research-run-1`; cancel the run; delete its link row |
| **A9** | deploy + production writes (later) | the schedules printed by `scripts/fleet-plan.ts`: enrich daily `--max 10`, bridge hourly `--structural --max 2`, monitor daily `--structural --max 5`, persistent worker | outcome metrics | `fly machine destroy` each; the collector is unaffected |

A9 is requested only **after** A8 has produced a dossier and you have reviewed it. Nothing is submitted anywhere. Immunefi
stays disabled, and Cantina stays blocked. Research is passive static analysis of public code at a pinned commit. Any lead is a
hypothesis for your review, never a finding until it has been independently reproduced and you have approved it.

## 3. What A8 can and cannot prove

- **It can prove:** the whole pipeline running unattended in production on a real bounty repository, with an evidence-verified,
  commit-pinned dossier whose coverage is stated honestly.
- **It cannot prove semantic vulnerability detection.** The structural analyzer has recall 0 on the eight semantic classes of
  benchmark-b v3. A dossier with no confirmed vulnerability is the expected first outcome.
