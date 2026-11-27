# Operational recovery — from built components to a working research engine

2026-11-27. Release candidate **`24f833d`** — image `registry.fly.io/agentsmith-hub@sha256:3d67f9a1d5d58b83811c0ce90e468fdeadb353dc59dd52d9846c2941110570ea`
(pushed to the registry; **not deployed**; smoke test 39/39 with migrations 0012–0014 applied inside the image).

## 1. Retrospective — how the research pipeline stayed idle

### Evidence

| fact | evidence |
|---|---|
| The research worker has been deployable for 2.5 days and was never run in production | `worker-main.ts` added 11-25 10:55 (04cb8ff); acquisition 11-25 15:27; structural pipeline 11-26 07:27 (3e9af26). `fly machines list`: only the API and the collector exist. `docs/r1-runtime-role.md`: restricted worker user "NOT applied to production". |
| Production releases went to UI work only | Fly releases v8–v15 (8 releases since the first bounty release v7 at 07:47): Research Home redesign, warm machine, Matrix theme, digital rain, polish, TV board, login field, header/footer colours. None shipped 0012–0014, a schedule or a worker. v12 was a failed release (a password value the server rejects, crash-looping the API for minutes). |
| The collector drifted 31 commits | It was created by `fly machine run … --schedule hourly --name bounty-collector` (`docs/a42-release-runbook.md`), outside the `app` process group. Every later `fly deploy` printed "Updating … 2870320f99dd68 [app]" only. No release step named the collector. It still runs `c3cb953`. |
| 0012–0014 were excluded by design and never put to the owner | Each migration's header says "excluded from the production image… ships only on an approved deploy". Every image this session built used `HUB_RELEASE_EXTRA_MIGRATIONS=0011` only. The readiness runbook (6c60949, 14:49) covers 0012/0013 and has **zero** mentions of 0014 (added 3e0aa0e, 15:41). |
| Services were written without schedules | `enrich-main.ts`, `promote-main.ts` and `monitor-main.ts` each say "NOT scheduled in production yet" in their own header. No machine definition existed for them until `deploy/fleet.json` (24f833d). |
| Integration tests were reported as operational progress | "A–H autonomous integration demonstration" (053fbae) and "the autonomous discover→research→rescan loop" (d4201b6) were tests against fixtures. Production had zero programmes able to reach them. |
| Defects only real data reveals sat undiscovered | The first live rehearsal (today) found five defects in hours: enrichment ignored eligibility; GitHub refusals were silent; trailing full stops in repository names; monitor rescans never analysed; one uncitable finding aborted a whole repository's analysis. |

### Causes (mine, not circumstances)

1. **I never converted "no deploy / no migration / no worker without approval" into an approval request.** Those constraints were legitimate. My failure was to keep building behind them instead of presenting, as soon as a first run was possible, a short and complete request for the minimum to start. By 6c60949 (14:49) everything for a controlled first run existed except repository mapping. The first consolidated request is this document.
2. **No release process covered machines outside `fly deploy`.** The collector was created by hand and never added to a release checklist, so drift was invisible.
3. **"Excluded until approved" was the default with no pending-release list.** Each migration was parked individually, and nothing tracked "these are waiting to ship".
4. **I followed the most recent request instead of the critical path.** UI requests got built and deployed the same hour (five UI deploys between 16:00 and 20:21), while the pipeline's blockers stayed in a list of "owner decisions".
5. **I described tests as capability.** Words like "autonomous loop", "demonstrated" and "proven" for fixture tests let an idle production system look further along than it was.

### Time spent that did not move research forward

- Hub look and feel: 9 web commits and 5 production releases (Matrix theme, rain, polish, icons, login field, TV board).
- Dashboards for data that could not yet exist: lifecycle (f6c4edb, a9b6bdf), coverage (02fe251) and enrichment metrics (bf6c17d) before any programme could be researched.
- Full Immunefi reconciliation (30ea6c7) for a source that stays disabled.
- Benchmark v1–v3 and the B3 runner (six commits): valuable measurement, but done before the engine had investigated anything.

### Missed milestones (what should have happened)

| milestone | possible from | what should have happened |
|---|---|---|
| M1 one controlled research run in production | 11-26 (worker + structural pipeline + R1 prepared) | request: create the R1 user, start one scoped worker, run one known repository |
| M2 bridge released with the collector aligned | 11-27 10:31 (38f904a) | release 0012 to both machines; enable Sherlock/HackenProof |
| M3 approval request from the readiness audit | 11-27 14:49 (6c60949) | this document, eight hours earlier |
| M4 enrichment released | 11-27 15:41 (3e0aa0e) | add 0014 to the same release, rehearse live once |

### Rules adopted to stop this recurring

- **Status vocabulary** (§2) on every component; "complete" is never used.
- **`deploy/fleet.json` + `scripts/fleet-plan.ts`**: the declared fleet on one release image; the read-only planner exits 1 whenever production differs, naming each machine, command and approval.
- **Every feature lists its production dependencies when it is written** (migration, schedule, secret, gate), and each stays on the pending-release list until deployed.
- **Approval requests are raised as soon as the next operational step needs one**, kept separate from progress reports.

## 2. Status board (Implemented → Tested → Integrated → Released → Deployed → Operationally verified)

| stage | I | T | Int | Rel | Dep | Op | blocker |
|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Community-board collection | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — (388 programmes, hourly) |
| Sherlock / HackenProof collection | ✔ | ✔ | ✔ live rehearsal | ✔ | ✔ code | ✘ | sources disabled (A4) |
| Immunefi | ✔ | ✔ | — | ✔ | ✔ code | ✘ by policy | written-terms approval; visible via community board only |
| Cantina | ✔ | ✔ | — | ✔ | ✔ code | ✘ by policy | robots.txt disallows; community board only |
| Eligibility | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 0 eligible is the correct result without official sources |
| Repository discovery (enrichment) | ✔ | ✔ | ✔ live extraction | ✘ fixes in RC | code only | ✘ | 0014 (A3), schedule (A5) |
| GitHub repository verification | ✔ | ✔ stubs | ✘ live | — | — | ✘ | cannot reach GitHub API from this container; proven in A6 |
| Bridge → research runs | ✔ | ✔ | ✔ runtime test | code only | code only | ✘ | 0012 (A3), schedule (A5) |
| Monitor → rescans | ✔ | ✔ | ✔ | ✘ `--structural` in RC | code only | ✘ | 0012/0013 (A3), schedule (A5) |
| Worker / research execution | ✔ | ✔ | ✔ runtime test, both roles | ✔ in image | ✘ no machine | ✘ | R1 user + worker machine (A7) |
| Commit-pinned acquisition + sealing | ✔ | ✔ | ✔ incl. one real bounty repository locally | ✔ | ✘ | ✘ | worker |
| Analysis → challenge → dossier | ✔ | ✔ | ✔ runtime test | ✘ robustness fix in RC | ✘ | ✘ | worker |
| AI adjudication (budget gateway) | ✔ | ✔ | ✘ | — | — | ✘ | no production model adapter; not needed for the first runs |
| Benchmark-b v3 + runner | ✔ | ✔ | n/a (offline) | — | — | — | measurement tooling, not a production component |

## 3. Recovery plan

**Phase A — release readiness (done locally, needs approval to deploy).** Release `24f833d`: all pipeline fixes, the monitor `--structural`
option, the analysis robustness fix, the fleet declaration. Migrations 0012–0014 are additive (4 new empty tables, no `ALTER`, no
dependency on 0008) and verified on the exact production shape and inside the image. Rollback: previous digests (API
`sha256:95c65bb0…`, collector `sha256:faef363a…`), then drop the four new tables.

**Phase B — source activation.** Enable Sherlock and HackenProof. Expected effect, from the live rehearsal: official listings (HackenProof
~333, Sherlock ~41) become `official_confirmed`; community-board records for the same programmes merge into them by canonical key.
Eligible rises from 0 to roughly 150–170 (rehearsal: 168, of which ~61 Solidity/EVM). Immunefi (143) and Cantina (46) records stay
`community_reported`/needs_verification; nothing is weakened to raise the count. Exact numbers are measured after the first collection.

**Phase C — repository acquisition.** One enrichment pass (`--max 10`) proves live GitHub verification, which is the one stage never proven.
Then a bridge dry run lists candidate repositories, and you pick the first.

**Phase D — research execution.** R1 worker user and grants; one worker machine scoped to one run, concurrency one, restricted role
enforced (`HUB_REQUIRE_RESTRICTED_DB_ROLE=true`). The success criterion is a sealed commit-pinned snapshot and an evidence-verified
dossier, whether or not it contains a vulnerability. Then schedules (`deploy/fleet.json`) for ten repositories at a time.

**In parallel (no approval needed):** reproduce the analyzer's cross-file attribution error; reentrancy through storage pointers; the
first semantic capability (invariants / accounting / state transitions, validated by execution), scored blind against benchmark-b v3
(recall 0 today).

## 4. Consolidated approval request — minimum to begin real research

Each line is a separate approval. Order matters; each step is verified before the next.

| # | action | exact change | rollback |
|---|---|---|---|
| **A1** | Deploy release `24f833d` to the API | `fly deploy --config fly.hub.toml --image registry.fly.io/agentsmith-hub@sha256:3d67f9a1d5d58b83811c0ce90e468fdeadb353dc59dd52d9846c2941110570ea --ha=false` | redeploy `@sha256:95c65bb0d39d4af04060d210500cc4312e9e992d12941073fcdad7cf13ebd6c8` |
| **A2** | Align the collector on the same image | `fly machine update 8747e47a1501d8 --app agentsmith-hub --image …@sha256:3d67f9a1… --yes` (schedule unchanged) | same command with `@sha256:faef363a35bca3c63a4d7a8f7e685fbd63a20329551dba3118882a975d28d0f9` |
| **A3** | Apply 0012–0014 to production | `scripts/migrate.ts` with `MIGRATE_CONFIRM_REMOTE_HOST` (as for 0011) | drop the 4 new tables + their `schema_migrations` rows |
| **A4** | Enable Sherlock and HackenProof | `POST /v1/bounties/sources/sherlock/enable`, `…/hackenproof/enable` | `…/disable` |
| **A5** | *(after A6–A8 succeed)* schedule enrichment / bridge / monitor | the three `fly machine run` commands printed by `scripts/fleet-plan.ts` | `fly machine destroy` each |
| **A6** | One enrichment pass + bridge dry run | one-off machine: `enrich-main.js --max 10`; then `promote-main.js --dry-run --structural --max 3` | `DELETE FROM bounty_repository_mappings` (new table) |
| **A7** | Worker user and grants (R1) | **you run** `fly mpg users create <cluster> --username agentsmith_worker --role reader`, set `WORKER_DATABASE_URL` with `fly secrets set … --stage`; then `apply-runtime-grants.js` dry run, then real | `fly mpg users delete agentsmith_worker`; `fly secrets unset WORKER_DATABASE_URL` |
| **A8** | First research run | `promote-main.js --structural --max 1` (one repository you choose from A6), then one worker machine with `WORKER_ONLY_RUN_ID=<run>`, `WORKER_EXIT_WHEN_RUN_DONE=true`, `STRUCTURAL_ANALYSIS_ENABLED=true`, `HUB_REQUIRE_RESTRICTED_DB_ROLE=true` | stop the machine; cancel the run |
| *(optional)* **A9** | `GITHUB_TOKEN` (fine-grained, public read only) | `fly secrets set GITHUB_TOKEN=…` | `fly secrets unset GITHUB_TOKEN` |

No model is called on this path ($0 against the $25/month gateway). Immunefi stays disabled. Nothing is submitted anywhere.
Research is passive static analysis of public code; any lead is a hypothesis for human review.

## 5. Research outcome measures (production baseline today)

| measure | today |
|---|---|
| programmes discovered (by source) | 388 (community board 388; Sherlock 0; HackenProof 0) |
| officially verified / eligible | 0 / 0 |
| repositories discovered / verified | 0 / 0 |
| snapshots sealed | 0 |
| research runs started / completed | 0 / 0 |
| hypotheses generated / reproduced | 0 / 0 |
| validated vulnerabilities / false positives | 0 / 0 |
| cost per research run | n/a (deterministic path: $0) |
| benchmark-b v3 (8 semantic classes) | recall 0, false-positive rate 0 |
