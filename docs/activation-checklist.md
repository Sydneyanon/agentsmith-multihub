# Activation checklist — bounty sources → research dossiers

Date: 2026-11-27. **Execution order and commands: see `docs/approval-request-final.md`.** Supersedes the activation sequence in `docs/activation-readiness-runbook.md` (which predates enrichment/0014
and over-states the worker switches). Release candidate: commit `939e17c`, built and smoke-verified locally (39/39), **not pushed**.

Every step marked **[APPROVAL]** changes production and waits for the owner. Nothing below has been done in production.

## 0. Current production (measured, read-only)

| | value |
|---|---|
| API machine image | `5633897` (hub UI); collector machine image `c3cb953` (original A42 release, 31 commits behind) |
| Schema | 0001–0007 + 0011 |
| Sources | community-board only; sherlock/hackenproof `enabled=false` (`owner_decision_required`); immunefi `blocked_terms`; cantina `blocked_robots` |
| Programmes | 388, all `community_reported` → 0 eligible (correct: eligibility requires official confirmation) |
| Mapped / acquired / runs / dossiers | 0 / 0 / 0 / 0 — no tables (0012–0014), no scheduled jobs, no worker |

## 1. Migrations 0012–0014 (additive only)

| migration | creates | touches existing data? |
|---|---|---|
| 0012 | `bounty_research_links` (programme ↔ repository ↔ research run, unique per programme/repo/ref; FKs → `bounty_programs`, `workflow_runs`, cascade from those parents) + 3 indexes | no |
| 0013 | `repository_monitors` (tracked repo, last HEAD, backoff) and `repository_monitor_checks` (append-only check log) + 1 index | no |
| 0014 | `bounty_repository_mappings` (programme ↔ repository with source URL, evidence, verification status, confidence, GitHub id) + 3 indexes | no |

No `ALTER` of any existing table, no data migration, no dependency on 0008. Runtime grants for all four tables are already in
`db/runtime-grants.json`. Verified: applied cleanly on the exact production shape (0001–0007 + 0011) in a disposable database, and
inside the release-candidate image during its smoke test.

## 2. Production changes, in order

| # | change | gate | verify | rollback |
|---|---|---|---|---|
| P1 | Push the release image (commit 939e17c+, `HUB_RELEASE_EXTRA_MIGRATIONS=0011,0012,0013,0014`) | **[APPROVAL: deploy]** | `scripts/hub-image.sh push` config checks | none needed (registry only) |
| P2 | Deploy it to the API machine **and** update the `bounty-collector` machine to the same image (schedule unchanged) | **[APPROVAL: deploy]** | `/v1/engine/status` build commit; collector next run `fetched` | redeploy previous digests: API `sha256:95c65bb0…`, collector `sha256:faef363a…` |
| P3 | Apply 0012–0014 to production (`scripts/migrate.ts`, `MIGRATE_CONFIRM_REMOTE_HOST`), then `scripts/apply-runtime-grants.ts` | **[APPROVAL: production migration]** | engine status `schema.applied` = expected; grants gate | `DROP TABLE repository_monitor_checks, repository_monitors, bounty_repository_mappings, bounty_research_links;` + delete their `schema_migrations` rows (all new and empty) |
| P4 | Enable `sherlock` and `hackenproof` (`POST /v1/bounties/sources/{key}/enable`) | **[APPROVAL: source activation]** | next collection: both `fetched`; eligible count > 0 | `POST …/disable`; collected rows remain as history |
| P5 | Optional Fly secret `GITHUB_TOKEN` (fine-grained, public-read only, no scopes) | **[APPROVAL: secret]** | enrichment `deferred` = 0 | `fly secrets unset GITHUB_TOKEN` (falls back to 60 req/h unauthenticated) |
| P6 | One manual enrichment pass: `enrich-main.js --max 10` (writes mapping rows only) | **[APPROVAL: production write]** | per-programme log; mappings with `official_documentation` | `DELETE FROM bounty_repository_mappings` (new table) |
| P7 | Bridge dry run: `promote-main.js --dry-run --structural --max 3` | read-only, bundle with P6 | candidate repositories listed for owner review | — |
| P8 | Bridge: `promote-main.js --structural --max 1` → exactly one queued run | **[APPROVAL: production write]** | one `bounty_research_links` row; run queued | cancel the run; delete the link row |
| P9 | One worker machine: `worker-main.js`, `STRUCTURAL_ANALYSIS_ENABLED=true`, **`ENGINE_LOOP_ENABLED` unset**, `DATABASE_URL` = restricted runtime role, `WORKER_ONLY_RUN_ID=<P8 run>`, `WORKER_EXIT_WHEN_RUN_DONE=true` | **[APPROVAL: worker activation]** | run steps succeed; sealed snapshot; dossier | `fly machine stop/destroy`; queued steps wait harmlessly |
| P10 | Schedules: enrichment **daily** `--max 10`; bridge hourly `--structural --max 2`; monitor daily `--structural --max 5`; worker persistent, concurrency 1 | **[APPROVAL: deploy/infra]** | outcome metrics (§6) | destroy the scheduled machines; collector unaffected |

Notes: the worker needs only `STRUCTURAL_ANALYSIS_ENABLED` for bridge/monitor runs (the engine loop and its 0008 discovery model are
not involved). No model is called anywhere on this path: the research pipeline is deterministic, so the $25/month gateway is not
exercised and cannot be exceeded. The image has no Slither/Foundry: research is the structural analyzer only. Immunefi stays disabled.

## 3. Verified locally (no approval needed, done)

- **Release candidate** `939e17c` with 0012–0014: image builds; smoke test 39/39; migrations apply inside the image.
- **Schema rehearsal**: production shape + 0012–0014 in a disposable database.
- **Live official collection** (disposable DB): HackenProof 333 listings, Sherlock 41 → **168 eligible** (Sherlock 12, HackenProof
  156). By declared stack: ~61 Solidity/EVM, 66 clearly non-EVM (Move/Cairo/Rust…), 41 unclear.
- **Live enrichment** (official pages, robots-checked): extraction found candidate repositories for 8 of the top 10 Solidity
  programmes. GitHub identity verification could not complete from this container (its proxy refuses the GitHub API for
  repositories not attached to the session); **live verification must be proven in P6**.
- **Acquisition of a real bounty repository** at a pinned commit through the real worker dispatcher succeeded locally (transport:
  local clone). Its analysis step then failed on an analyzer attribution error — now contained (see §5).
- **Defects found and fixed** (commits `6f1fbc6`, `939e17c`): enrichment ignored eligibility; GitHub refusals were silent;
  trailing full stop in extracted repo names; monitor rescans never analysed; one uncitable finding aborted a whole repository.

## 4. Safest first batch

- **Programmes**: Sherlock/HackenProof, officially confirmed, Solidity/EVM-tagged, top of the enrichment ranking. Live candidates
  with repositories extracted from their official pages include Cap (Sherlock), DeXe, Nado, MetaMask Validator Staking, Layer3,
  SmarDex and 1inch (HackenProof).
- **First research run**: **one** repository, chosen by the owner from the P7 dry-run list, that (a) was verified against GitHub in
  P6, (b) is explicitly in the programme's published scope, (c) is Solidity, (d) is modest in size.
- Research is passive static analysis of public code only: nothing is deployed, called on-chain or submitted. Any lead is a
  hypothesis for human review, never reported without independent reproduction and owner approval.

## 5. Known limitations going in

- Structural analyzer only: perfect on simple syntactic patterns, recall 0 on the eight semantic classes (benchmark-b v3).
- The inheritance-related attribution error was root-caused and fixed in `5d6ccd1` (call-chain frames used the callee's file with
  the caller's line). Any residual uncitable finding is still rejected and listed, and every dossier states its coverage.
- Eligibility does not check language; ~66 eligible programmes are non-EVM. Enrichment ranks them last; a repository-level
  Solidity gate is not yet implemented.
- Enrichment keeps no record of "no repository" attempts, so schedule it daily, not hourly, until an attempt log exists.

## 6. First end-to-end demonstration (success criteria)

After P1–P9, for one programme, every stage evidenced by stored records:
1. programme collected from an official source (`official_confirmed`, eligible);
2. repository extracted from the official page and **verified against GitHub** (`official_documentation`, GitHub id stored);
3. bridge link + queued run created automatically;
4. snapshot acquired and **sealed at an exact commit** (manifest hash);
5. structural analysis + challenge completed (problems listed, not hidden);
6. **dossier** built from stored records only, with every cited span re-verified;
7. no model calls, $0 spent; coverage tab shows the repository as researched.

## 7. Outcome metrics (baseline today, production)

| metric | now |
|---|---|
| programmes automatically discovered | 388 |
| official programmes verified | 0 |
| repositories automatically identified | 0 |
| repositories acquired | 0 |
| research runs completed | 0 |
| hypotheses generated | 0 |
| vulnerabilities reproduced / validated findings | 0 / 0 |
| false-positive rate (benchmark-b v3, synthetic) | 0 (recall 0) |
