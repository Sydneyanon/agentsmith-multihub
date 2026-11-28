# Deployment reconciliation: one release baseline (2026-11-27)

Every value below was re-checked live in this session, using `fly machines list --json`, `git fetch` and `scripts/release-check.ts`.
Nothing was taken from earlier reports.

## 1. Current revisions

| what | commit | image | evidence |
|---|---|---|---|
| GitHub `main` HEAD | `b50ff6f` | — | `git fetch origin main` |
| Working branch HEAD (`claude/agentsmith-multihub-assessment-j5j4q3`, pushed) | `6f1095b` (plus this commit) | — | local and origin agree; working tree clean |
| **API** (`late-meadow-8506`, started) | `5633897` | `sha256:95c65bb0…` | image revision label |
| **Collector** (`bounty-collector` `8747e47a1501d8`, hourly) | `c3cb953` | `sha256:faef363a…` | image revision label |
| Latest built, smoke-tested and pushed release | **`d09d0c2`** | **`sha256:b52ce901d3325c101d63b2840160cc2b22b63257f68c14da1e1068e3e6a2d5e0`** | smoke 41/41; `deploy/release.json` |
| Earlier smoke-tested candidate (superseded) | `5d6ccd1` | `sha256:b3a6327e…` | smoke 39/39 |

Distances (`git rev-list --count`):

| range | commits |
|---|---|
| collector → API | 26 |
| API → release `d09d0c2` | 17 |
| release → branch HEAD | 2, both test and docs only; the image content is identical |
| `main` → release | **183**: neither the release nor the deployed API is on `main` |

Commit details:
- The collector revision `c3cb953` is an ancestor of the API revision `5633897`, which is an ancestor of the release.
- `5633897` already contains the code for 0012–0014. Its API guards every read of those tables (`tableExists`), which is why
  production works today without them. Verified in `bounties/queries.ts` at `5633897`.

## 2. Everything not deployed, by category

### API `5633897` → release `d09d0c2` (17 commits)

| category | commits |
|---|---|
| Research engine | `939e17c` uncitable finding no longer aborts a repository · `5d6ccd1` **citation root cause** + dossier coverage · `bbd903b` analyzer and build named in every dossier, "not evidence of absence" wording |
| Vulnerability detection | `53301db` writes through storage references (analyzer `structural-solidity/2`) · `135c699`, `75e9e50`, `4179e87`, `d72c379`, `697e79c`, `6a939e0`: benchmark-b v1–v3, runner, budget-gated adjudication (eval only; not in the runtime image) |
| APEX and external tools | none |
| Acquisition and repository discovery | `6f1fbc6` enrichment honours eligibility, GitHub refusals deferred, repo-name fix, monitor `--structural` · `63a7e94` GitHub token integration · `d09d0c2` smoke checks for it |
| Database migrations | **none new**. 0012–0014 have been in the tree since before `5633897`, but were not shipped in its image and are not applied. |
| Worker and orchestration | `24f833d` injectable source for the worker, bridge-to-dossier proof, `deploy/fleet.json` + `fleet-plan.ts` |
| UI and dashboard | none |
| Security and infrastructure | `63a7e94` (token handling, redaction) · `24f833d` (fleet declaration) |
| Docs only | `c85e181`, `85db488`, `5454ff0` |

### Collector `c3cb953` → API `5633897` (26 commits; the collector also lacks everything above)

| category | commits |
|---|---|
| Acquisition and repository discovery (bounty pipeline) | `38f904a` discovery → research bridge (0012) · `d4201b6` repository monitor (0013) · `3e0aa0e` enrichment service (0014) · `053fbae` mappings feed the bridge · `a890543`, `0b336fc` repository intelligence and rescan planner · `c515da0` mapping gaps · `ec90958` HackenProof republication guard · `30ea6c7` Immunefi reconciliation · `d671596` Immunefi adapter (**disabled**), eligibility, enable control |
| UI and dashboard | `5633897`, `c124fa7`, `1071994`, `23f383c`, `271974f`, `e468ca6`, `a9b6bdf`, `44051c1`, `f7c3173`, `738723e` (TV board), `bf6c17d`, `02fe251`, `f6c4edb` |
| Security and infrastructure | `60cf128` keep one API machine warm |
| Docs | `6c60949`, `956ecf5` |

### Dependencies and conflicts
- **No migration conflict.** 0012–0014 are additive. The release ships 0001–0007, 0011 and 0012–0014; 0008 and the drafts are
  excluded. Old code tolerates the new tables, and new code tolerates their absence (both rehearsed).
- **Collector compatibility.** The collector runs `collect-main` only. Its schema needs are covered by 0011, which production has.
  Moving it to the release image changes no schedule and no source.
- **API and collector must move together.** After A1 and A2 both run `d09d0c2`, `release-check` shows no `version_mismatch`.
- **`main` is behind.** It is the repository's default branch, but production and every release come from the working branch.
  Merging into `main` needs your instruction, normally through a pull request; I don't push to `main`.
- **Excluded from the release on purpose:**
  - the protocol-invariant detector (`docs/proposals/`, no measured benefit);
  - draft migrations 0009 and 0010 (research memory, engine loop);
  - migration 0008 (discovery);
  - attended Claude capabilities, which are operator-only and never run unattended.

## 3. The one release baseline
`deploy/release.json` records the candidate:
- commit `d09d0c2`, image `sha256:b52ce901…`, smoke 41/41;
- analyzer `structural-solidity/2`, with migrations as listed;
- the critical fixes that every production machine must contain;
- the previous API and collector images, for rollback.

`approved` stays `null` until you approve it.

**Verification:**
- typecheck clean;
- unit tests: 1034 pass;
- integration tests: 370/370, as both the owner and the restricted role;
- image smoke: 41/41;
- migrations: 0012–0014 apply in the image during its smoke test, and the data-preserving rollback was rehearsed.

**Deploy commands** (after approval; `IMG` is the digest above). Rollback for each is to redeploy its previous image, which was
rehearsed:
- **API:** `fly deploy --config fly.hub.toml --image $IMG --ha=false`. Rollback: `…@sha256:95c65bb0d39d4af04060d210500cc4312e9e992d12941073fcdad7cf13ebd6c8`.
- **Collector:** `fly machine update 8747e47a1501d8 --app agentsmith-hub --image $IMG --yes`. Rollback: the same command with `…@sha256:faef363a35bca3c63a4d7a8f7e685fbd63a20329551dba3118882a975d28d0f9`.

Migrations, sources, the worker and the first run are A3–A8 in `docs/approval-request-final.md`, unchanged.

## 4. Live drift report (today)
`npx tsx scripts/release-check.ts` reported 17 items:
- **Release:** `unapproved_release`; `version_mismatch` (API `95c65bb0…`, collector `faef363a…`); `behind_release` for both
  machines, with the exact commands; `release_not_on_main`.
- **Critical fixes:** each of the 4 is missing from both machines (8 items).
- **Fleet:** `missing_machine` for bounty-enrich, bounty-bridge, bounty-monitor and research-worker, each with the approval it needs.
- **Migrations:** `migrations_unchecked`. Supply `--engine-status` with a saved `/v1/engine/status`; the check needs the operator token, which only you hold.
