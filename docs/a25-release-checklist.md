# A25 production release checklist (prepared 2026-11-26; APPROVED and DEPLOYED 2026-11-26 as release v6, see section 11)

**Proposed release candidate: commit `837aeb9b48ed9c0b439b10a3dc236be177592ce8`** on `claude/structural-validation-and-workflow`.
Later commits that change only `docs/` do not change what is built, but the image records its commit. Build from exactly this commit
(`git checkout --detach 837aeb9`) so that the verified layer is the one deployed.

**Currently deployed:** Release 1, commit `7eed70f`, image `registry.fly.io/agentsmith-hub@sha256:c0eaf87d35e26af4bae688e9209959f263fb92d6a6d623901bb87f706048f577`
(app version 4 after the token rotation). Release 1 already contains review fixes 1–5 (`docs/first-production-release-plan.md`, section 10).

## 1. Exact commits and files included
- `7eed70f..837aeb9`: 65 commits; 490 files changed in the repository, most of them docs, evaluation corpora and tests, which are not in the image.
- **What reaches the image** (the build copies `apps`, `scripts`, `db` and the package files, compiles to `dist/`, and ships only `dist/`
  and `db/`):

| Area | Files | In production after A25 |
|---|---|---|
| Control Room and engine status (A24, A33) | `apps/api/src/engine-status.ts` (new); `app.ts`, `server.ts`, `config.ts` (`HUB_DATA_KIND`), `db-config.ts` (session name), `research-api.ts` (shaped step errors); web: `live.ts`, `view-control.ts`, `view-architecture.ts` (new), `main.ts`, `router.ts`, `types.ts`, `vocab.ts`, `view-projects.ts`, `view-repository.ts`, `styles.css` | **Active** (read-only) |
| Discovery API (5.0) | `apps/api/src/discovery/*` | Routes registered. Without migration 0008 every one answers `503 discovery_not_installed`; nothing is fetched or written |
| Structural analysis P1–P3, validators, challenge (5.3–5.6) | `apps/api/src/analysis/solidity/*` | **Inert**: runs only inside a worker step; no worker exists |
| Priority (5.0/5.3) | `apps/api/src/priority/*` | **Inert**: no route or worker uses it in production |
| Worker | `worker-main.ts`, `worker-runtime.ts`, `acquisition/step.ts` | **Inert**: `fly.hub.toml` defines the `app` process group only |
| Database | `db/migrations/0001`–`0007` **only** (see 3); `db/runtime-grants.json` (file only, not applied) | no schema change |
| Config | `fly.hub.toml`: adds `HUB_DATA_KIND = "production"` | the Control Room shows "Production data" |

The full list is `git diff --name-status 7eed70f..837aeb9 -- apps/api/src apps/web db fly.hub.toml`.

## 2. The five existing review fixes
All five are **already in production** since Release 1 (`7eed70f`) and remain in this candidate unchanged. Each fix commit is an
ancestor of `837aeb9`: `8f5cbdc`, `fd60659`, `1908c97`, `32669e7`, `746478e`, plus the follow-ups `91806bc` and `7eed70f`.

| # | Fix | In candidate | Production state |
|---|---|---|---|
| 1 | SSRF-safe outbound requests | yes | deployed; no code path fetches without a worker (and discovery returns 503) |
| 2 | Auth before body parsing, default-deny | yes; the new route is covered by the route-coverage test | deployed |
| 3 | No operator lockout, no spoofable proxy trust | yes | deployed |
| 4 | Least-privilege runtime role (grants manifest, startup guard) | yes (code) | **code deployed; the role rollout (R1) is NOT applied**. The app still runs as the owner role, temporarily accepted by the owner. A25 does not change this |
| 5 | Minimal image (no tests or dev code) | yes; smoke-checked | deployed |

**Correction on record:** in my previous report I wrote that A25 "also carries review fixes 1–5 (not deployed)". That was wrong: it
came from a stale note in `hub-production-plan.md`, now corrected.

## 3. Is migration 0008 required? **No.**
- No A25 feature needs it:
  - engine status reports discovery as "not installed";
  - the Control Room shows that state and never calls the discovery routes;
  - the discovery routes answer 503.
- **0008 is not in the release image.** `scripts/hub-image.sh` now requires `HUB_RELEASE_LAST_MIGRATION` and is run with `0007`. It
  removes `0008_discovery.sql` and the whole `db/drafts/` directory (the T-144 draft) from the image, and records them in
  `dist/build-info.json` as `migrations_excluded: ["0008_discovery.sql"]`. So the image's migration runner cannot apply an unapproved
  migration even if someone ran it.

## 4. Any other migration or schema change? **None.**
- Production's ledger is 7 rows (`0001`–`0007`). The image ships exactly those 7, so there is no drift.
- No secret change. No role or grant change (`db/runtime-grants.json` changed in the repository, but applying grants is R1 / a
  separate approval and is not part of A25).
- One new runtime visible to the database: the API names its connections `agentsmith-api/1` (`application_name`). This is not a schema
  change.
- **Pre-flight (read-only, part of A25):** confirm `schema_migrations` still has exactly the 7 checksummed rows. Stop if not.

## 5. Rollback
- `fly deploy --config fly.hub.toml --app agentsmith-hub --image registry.fly.io/agentsmith-hub@sha256:c0eaf87d35e26af4bae688e9209959f263fb92d6a6d623901bb87f706048f577 --ha=false`
- **No database action**: A25 makes no database change.
- `HUB_DATA_KIND` is ignored by the old image.
- Trigger: any failed post-deploy check below, or any unexpected database change.

## 6. Authentication, roles and read-only behaviour
- Same bearer token (unchanged secret), same default-deny hook, same lockout and host guard.
- Every `/v1/*` route, including `GET /v1/engine/status`, returns 401 without the token. The route-coverage test pins the public
  allow-list: `/`, `/health/*` and `/hub*` only.
- New routes:
  - `GET /v1/engine/status`: read-only; no secrets, environment values or raw errors (tested); shaped failure messages only.
  - Discovery routes (5.0): include operator POSTs. All answer 503 without 0008.
- Project detail now returns shaped step errors (A33).
- No new write path is usable in production. The existing `POST /v1/intake` (Release 1) can still create a queued run, which nothing
  executes because there is no worker.
- **Database role:** unchanged (owner role, R1 accepted). With the owner role the Control Room can read the migration ledger. Under
  the future restricted role it will say "not readable" (A30 deferred, as instructed).

## 7. Will the deployed page show truthful production data? **Yes**, checked against the release build
The release layer was built from `837aeb9`, served from a fresh database migrated with the image's own 7 migrations, with
`HUB_DATA_KIND=production`. `GET /v1/engine/status` returned:
- engine `idle`, reasons none;
- data `production`;
- build commit `837aeb9b48ed` (from `build-info.json`);
- 7 of 7 migrations applied; nothing missing or unknown;
- discovery not installed;
- no workers and no leases;
- queue empty; runs none; last run, success and failure none;
- 0 hypotheses; human-confirmed findings not recorded.

Discovery returned 503, and engine status without a token returned 401. The token did not appear in the response.

Production's research tables were empty at the last read (only `budget_policies` 9 and `schema_migrations` 7), so production will
show the same idle state. Nothing is seeded. The demo or synthetic data path exists only in `scripts/hub-demo.ts`, against disposable
local databases.

## 8. Verification done on the candidate
| Check | Result |
|---|---|
| `npm run verify` (lockfile, typecheck, unit, build, integration as owner and as restricted role) | PASS: 863 unit, 261 integration ×2 |
| Release image build with `HUB_RELEASE_LAST_MIGRATION=0007` | layer diff_id `221d68e8d450924c…`; 3,362 files; 0008 and drafts excluded |
| Image smoke test (chroot of the real base layers, node user, TLS-verified Postgres with a throwaway CA) | **31 passed, 0 failed** |
| Engine status from the release build on an empty 0001–0007 database | as in 7 |
| Hub layout check (6 viewports × 12 screens) | PASS (on the A24 commit; the A33 and A25 changes do not touch layout) |

## 9. Deployment procedure (to run only after A25 approval)
1. `git checkout --detach 837aeb9`.
2. `HUB_RELEASE_LAST_MIGRATION=0007 scripts/hub-image.sh build`, then `verify`, then `push` (push needs `FLY_API_TOKEN`). Record
   the pushed digest.
3. Pre-flight: the ledger has 7 rows; capture the current release (version, image digest) for rollback.
4. `fly deploy --config fly.hub.toml --app agentsmith-hub --image registry.fly.io/agentsmith-hub@<digest> --ha=false`.
5. Post-deploy checks:
   - Fly reports the digest; health 200; `/hub/` 200;
   - `/v1/*` returns 401 without the token, foreign Host returns 421, headers unchanged;
   - `/v1/engine/status` with the token shows idle, production, the build commit and 7 of 7 migrations;
   - the database row counts are identical before and after;
   - no token in the logs;
   - Hunt unaffected (read-only GET).
6. The owner opens the Control Room on an iPhone (authenticated checks are the owner's).

## 10. Known limitations to accept or resolve
- **Machine wake-ups:** the 15-second refresh keeps the auto-stopping machine and the database awake while a tab is open. The
  machine stops when no tab is open. The last record showed the Fly organisation on a trial that stops machines after about 5
  minutes. That billing state is the owner's to resolve; with it, the page may show "stale" between restarts.
- **R1** remains (owner role).
- The image is a Docker-less build (as in Release 1).
- **A26 is not part of A25.** After A25 is released and verified, I will propose the first controlled worker run separately: program,
  repository and commit, permitted activities, resource limits and stop conditions.

## 11. A25 deployment record (2026-11-26, owner-approved for candidate `837aeb9`, Option 1: auto-stop kept)
**Approval:** the owner approved A25 for `837aeb9`, with Fly auto-stop kept, no sizing change, migrations 0001–0007 only and not
applied, no grant or secret change, and no worker. The owner added a card earlier the same day; Fly billing is `CURRENT`.

| Step | Result |
|---|---|
| Pre-flight state | release v5 = Release 1 digest `sha256:c0eaf87d…`; rollback image confirmed present in the registry |
| Pre-flight database (read-only transaction inside the machine) | 32 tables; non-empty only `budget_policies` 9 and `schema_migrations` 7; ledger 0001–0007 (0007 checksum `2ec89f696c90`), identical to the Release 1 record |
| Build from the exact commit | `git checkout --detach 837aeb9`; `HUB_RELEASE_LAST_MIGRATION=0007`; layer diff_id `221d68e8d450924c…` (identical to the verified candidate); 0008 and drafts excluded |
| Image smoke test | 31 passed, 0 failed |
| Push | `registry.fly.io/agentsmith-hub@sha256:7f99bf270b0178274680281a80f85836a561567f377d46b8c4d6e2be7ba29e16` (tag `hub-837aeb9b48ed`); pushed config and last layer match the tested layer |
| Deploy | `fly deploy --config fly.hub.toml --app agentsmith-hub --image …@sha256:7f99bf27… --ha=false`, 22:28:24Z–22:29:33Z; **release v6** complete; machine `2870320f99dd68` updated (shared-cpu-1x 512 MB, syd, unchanged); `auto_stop_machines = "stop"`, `min_machines_running = 0` unchanged |
| Health | `/health/live` 200, `/health/ready` 200; health check passing since 22:29:53Z (one failure at 22:29:48Z during boot, before the server listened) |
| Website | `/` 302 to `/hub/`; `/hub/` and assets 200; the Control Room module is served; CSP, HSTS, nosniff, no-referrer and CORP headers unchanged |
| Authentication | `/v1/engine/status`, `/v1/research/overview`, `/v1/research/projects`, `/v1/discovery/sources` all 401 without a token and with a wrong token; default `agentsmith-hub.fly.dev` hostname 421 |
| Engine status (authenticated, run inside the machine with its own token; the token was never printed or stored) | 200; engine `idle`, no reasons; `data_kind: production`; build `837aeb9b48ed…` from `build-info.json`; 7 of 7 migrations, none missing or unknown; discovery not installed; no workers, no leases; queue empty; no runs; last run, success and failure none; 0 hypotheses; 0 protocol models; human-confirmed not recorded; token not in the response |
| Other routes | `/v1/research/projects` 200 with 0 items; `/v1/research/overview` 200; `/v1/discovery/sources` 503 `discovery_not_installed` |
| Database after deploy | read-only snapshot **identical** to the pre-flight snapshot (no migration ran, no data changed) |
| Logs (last 100 lines) | 0 `Bearer`, 0 database URLs; the only long strings are the public image digest; the expected R1 warning is present |
| Auto-stop | the machine stopped after deploy and woke on the first request (Option 1 working) |
| Hunt | `hunt.agentsmithdesk.xyz` 200 (read-only GET) |

**Not done (by instruction):** no migration, no grant, role or secret change, no worker, no research run. **Rollback** remains:
`fly deploy --config fly.hub.toml --app agentsmith-hub --image registry.fly.io/agentsmith-hub@sha256:c0eaf87d35e26af4bae688e9209959f263fb92d6a6d623901bb87f706048f577 --ha=false`
(no database action).

**Owner check outstanding:** opening the Control Room on the iPhone with the token.
