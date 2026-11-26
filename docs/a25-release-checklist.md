# A25 production release checklist (prepared 2026-11-26; NOT approved, nothing deployed)

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
