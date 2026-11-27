# Consolidated approval request — first real research run

Date: 2026-11-27. Supersedes the A1–A9 table in `docs/operational-recovery.md` §4 (release `24f833d` / `sha256:3d67f9a1…`,
which is withdrawn because it does not contain the analyzer root-cause fix).

**Release:** commit `5d6ccd1587ea6e5fb8a7bd683f9ddc174bc8f68c`
**Image:** `registry.fly.io/agentsmith-hub@sha256:b3a6327ebea6c1d45a92132041fd5d5361cd7ad9e9a7da0c5ca17325f8ee1a27` (tag `hub-5d6ccd1587ea`)
Status: Implemented, Tested, Integrated, **Released** (built, smoke test 39/39, pushed to the registry, pushed image checked against
the tested layer). **Not deployed.** Nothing in production has changed.
Migrations shipped: 0001–0007, 0011, 0012, 0013, 0014 (0008 and all drafts are excluded from the image, so they can't be applied from it).

> **Release candidate choice (added after the GitHub token integration).** A second candidate exists:
> commit `d09d0c2`, image `registry.fly.io/agentsmith-hub@sha256:b52ce901d3325c101d63b2840160cc2b22b63257f68c14da1e1068e3e6a2d5e0`
> (smoke test 41/41, pushed, **not deployed**). On top of `5d6ccd1` it adds the hardened GitHub token handling and the live check
> (`docs/github-token.md`), the storage-reference reentrancy improvement (analyzer `structural-solidity/2`), and analyzer/build
> labelling in every dossier. Its migrations are identical: 0001–0007, 0011, 0012–0014. Every command below works with either
> image: set `IMG` to the one you approve. **Owner decision:** keep the frozen `5d6ccd1`, or approve `d09d0c2`.

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

## 2. Approval request

`IMG=registry.fly.io/agentsmith-hub@sha256:b52ce901d3325c101d63b2840160cc2b22b63257f68c14da1e1068e3e6a2d5e0`
(release baseline `d09d0c2` per `deploy/release.json`; it supersedes `5d6ccd1` / `sha256:b3a6327e…`. Run `npx tsx scripts/release-check.ts` before and after each step.)

**Every numbered action needs your explicit approval.** Approving one action does not approve the next. I run each action only
after the previous one has been verified, and I stop and report on any unexpected result. Actions marked **you** need your own Fly
credentials (creating a database user). I cannot do them.

Costs: no AI is used anywhere on this path ($0 against the $25/month gateway). Fly compute for one-off machines is a few cents each.
A machine left running (A9 only) is roughly $3–4/month each at shared-cpu-1x/512 MB. Database growth is small (kilobytes to a few
megabytes for one repository snapshot).

### A1 — Deploy the release to the API  · approval: deploy
- **Command:** `fly deploy --config fly.hub.toml --image $IMG --ha=false`
- **Consequence:** the API machine late-meadow-8506 restarts on build `5d6ccd1` (seconds of downtime). Until A3, engine status shows
  0012–0014 as `schema.missing`, which is an attention reason only; the API works without them.
- **Verify:** `/health/ready` 200; `/v1/engine/status` build commit `5d6ccd1…`.
- **Reversible:** yes, fully. `fly deploy --config fly.hub.toml --image registry.fly.io/agentsmith-hub@sha256:95c65bb0d39d4af04060d210500cc4312e9e992d12941073fcdad7cf13ebd6c8 --ha=false` (rehearsed, works even after A3).

### A2 — Move the collector to the same image  · approval: deploy
- **Command:** `fly machine update 8747e47a1501d8 --app agentsmith-hub --image $IMG --yes`
- **Consequence:** the hourly collector runs the new code; its schedule and sources are unchanged (still community board only).
- **Verify:** the next hourly run is recorded.
- **Reversible:** yes. The same command with `@sha256:faef363a35bca3c63a4d7a8f7e685fbd63a20329551dba3118882a975d28d0f9` (rehearsed).

### A3 — Apply migrations 0012–0014 to production  · approval: production migration
- **Command** (identical to how 0011 was applied; the host is read from the machine's own `DATABASE_URL`, so no credential leaves Fly):
  `fly machine run $IMG --app agentsmith-hub --region syd --rm --restart no --entrypoint sh -- -c 'host=$(node -e "process.stdout.write(new URL(process.env.DATABASE_URL).hostname)"); DIRECT_DATABASE_URL="$DATABASE_URL" MIGRATE_CONFIRM_REMOTE_HOST="$host" node dist/scripts/migrate.js'`
- **What it changes:** it creates exactly four new, empty tables and seven indexes. Nothing existing is altered, and no data is migrated.
  - **0012:** `bounty_research_links`, which links a programme, a repository and a research run (one per programme/repo/ref).
  - **0013:** `repository_monitors` and `repository_monitor_checks` (tracked repositories and an append-only check log).
  - **0014:** `bounty_repository_mappings`, which records a programme's repository with its source URL, evidence, verification status and GitHub id.
  - **Foreign keys:** only into `bounty_programs` and `workflow_runs`, with ON DELETE CASCADE from those parents.
- **Expected output:** exactly three lines, `Applied 0012_bounty_research_link.sql`, `Applied 0013_repository_monitor.sql` and
  `Applied 0014_repository_mappings.sql`. Anything else means I stop.
- **Verify:** engine status `schema.missing = []`.
- **Reversible:** yes. Preferred: leave the tables and stop the producers. Removal is the data-preserving drop and restore rehearsed in §1.2.

### A4 — Enable Sherlock and HackenProof as sources  · approval: source activation
- **Commands:** `POST /v1/bounties/sources/sherlock/enable` and `POST /v1/bounties/sources/hackenproof/enable` (operator token).
- **Consequence:** each hourly collection also reads those platforms' public programme listings. There is no account, no API key and
  no login, and robots.txt is checked on every fetch. Their programmes become `official_confirmed` and can become eligible.
  Immunefi stays disabled and Cantina stays blocked.
- **Verify:** next collection shows both sources `fetched`. I report the **production** eligible count as measured; it is not assumed
  to be 168.
- **Reversible:** yes. `POST …/disable`; already-collected programmes remain as history.

### A5 — (optional, recommended) GitHub token  · approval: secret
- **Command:** `fly secrets set GITHUB_TOKEN=<fine-grained token, public repositories read-only, no permissions> --stage --app agentsmith-hub`
  (you create the token; I never see it if you run this yourself).
- **Consequence:** raises GitHub's rate limit from 60 to 5,000 requests/hour for repository verification and acquisition.
- **Reversible:** yes. `fly secrets unset GITHUB_TOKEN --app agentsmith-hub`.

### A6 — One enrichment pass, then a dry run of the bridge  · approval: production write (mapping rows only)
- **Commands:**
  1. `fly machine run $IMG dist/apps/api/src/bounties/enrich-main.js --max 10 --app agentsmith-hub --region syd --rm --restart no`
  2. `fly machine run $IMG dist/apps/api/src/bounties/promote-main.js --dry-run --structural --max 3 --app agentsmith-hub --region syd --rm --restart no`
- **Consequence:**
  - **Pass 1** reads up to 10 eligible programmes' official pages (robots-checked), extracts repository links and verifies each
    against GitHub. It writes rows to `bounty_repository_mappings` only. An unverifiable repository is recorded as `deferred`, never
    as verified.
  - **Pass 2** writes nothing; it lists the candidate repositories.
- **Then you choose** one repository from the dry-run list for A8.
- **Reversible:** yes. Mapping rows can be deleted; the table is new.

### A7 — Create the restricted worker database user  · approval: database user + grants
- **Commands:**
  1. **you:** `fly mpg users create <cluster id> --username agentsmith_worker --role reader`
  2. **you:** `fly secrets set WORKER_DATABASE_URL=<that user's connection string> --stage --app agentsmith-hub`
  3. **me, dry run:** `fly machine run $IMG --app agentsmith-hub --region syd --rm --restart no -e RUNTIME_ROLE=agentsmith_worker -e RUNTIME_ROLE_READONLY_MEMBERSHIPS=reader -e RUNTIME_GRANTS_ALLOW_ABSENT=true -e RUNTIME_GRANTS_DRY_RUN=true --entrypoint sh -- -c 'host=$(node -e "process.stdout.write(new URL(process.env.DATABASE_URL).hostname)"); DIRECT_DATABASE_URL="$DATABASE_URL" MIGRATE_CONFIRM_REMOTE_HOST="$host" node dist/scripts/apply-runtime-grants.js'`.
     I show you the printed plan.
  4. **me, for real:** the same command without `RUNTIME_GRANTS_DRY_RUN=true`, only after you've seen the plan.
- **Consequence:** a database user that can read, and can insert or update only the tables listed in `db/runtime-grants.json`. It
  cannot own, create, delete, truncate or disable triggers. The API keeps its existing connection unchanged.
- **Reversible:** yes. `fly mpg users delete …agentsmith_worker`; `fly secrets unset WORKER_DATABASE_URL --app agentsmith-hub`.

### A8 — The first research run  · approval: production write + worker activation
- **Commands:**
  1. `fly machine run $IMG dist/apps/api/src/bounties/promote-main.js --structural --max 1 --app agentsmith-hub --region syd --rm --restart no`
     This creates **exactly one** queued run for the repository you chose; I confirm the run id and repository before step 2.
  2. `fly machine run $IMG dist/apps/api/src/worker-main.js --app agentsmith-hub --region syd --name research-run-1 --vm-size shared-cpu-1x --vm-memory 512 --restart no --env STRUCTURAL_ANALYSIS_ENABLED=true --env HUB_REQUIRE_RESTRICTED_DB_ROLE=true --env WORKER_ONLY_RUN_ID=<that run id> --env WORKER_EXIT_WHEN_RUN_DONE=true`
- **Consequence:** one worker, confined as in §1.3, does four things:
  - acquires the repository at the pinned commit from GitHub;
  - seals the snapshot;
  - runs structural analysis and the execution challenge;
  - builds the dossier.
  It then exits. Nothing is executed from the repository, nothing is deployed or called on-chain, and nothing is submitted anywhere.
- **Verify:** four steps `succeeded`; snapshot sealed with its commit and manifest hash; dossier coverage status; 0 model-usage events.
- **Reversible:** yes. `fly machine stop research-run-1`; cancel the run; delete its link row. The run's records remain as history.

### A9 — Recurring schedules  · approval: requested separately, after you've reviewed the A8 dossier
The enrich, bridge, monitor and persistent-worker machines printed by `scripts/fleet-plan.ts`. **This is not part of this approval.**

## 3. Labelling the first run: analyzer version used

| | |
|---|---|
| build commit | `d09d0c23c39110df4725a8e049e967c124d43a35` |
| image | `sha256:b52ce901d3325c101d63b2840160cc2b22b63257f68c14da1e1068e3e6a2d5e0` (tag `hub-d09d0c23c391`) |
| analyzer | `structural-solidity/2 (specialists 1 + storage-reference writes, execution validators 1)` |
| hypothesis generator | `solidity-structural-specialists@1` |
| includes | citation root-cause fix, coverage records, storage-reference writes, GitHub token hardening |
| excludes | APEX (not implemented), Slither and Foundry (not in the image), the protocol-invariant proposal |

- **How the run records it:** the analysis step records `analyzer` and `analyzer_build` (commit and image tag) from
  `build-info.json`, and the dossier prints them.
- **After A8:** I also enter the run in `docs/research-runs.md`.
- **It is not proof that APEX works.** It is the deterministic structural analyzer only.

## 4. What A8 can and cannot prove

- **It can prove:** the whole pipeline running unattended in production on a real bounty repository, with an evidence-verified,
  commit-pinned dossier whose coverage is stated honestly.
- **It cannot prove semantic vulnerability detection.** The structural analyzer has recall 0 on the eight semantic classes of
  benchmark-b v3. A dossier with no confirmed vulnerability is the expected first outcome.
