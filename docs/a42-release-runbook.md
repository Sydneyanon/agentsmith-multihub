# A42 release runbook: bounty intelligence in production

**Status:** prepared and verified locally. A42 is **not approved**, so nothing below has been run against production.

**Release candidate:** commit `8368a357e5a6f3b51f071d2d08015a39804646d7`. The image layer built from it has diff_id `2d92fdeb42aa7e130cf55b855ff598a23f432878d3e164c5e2a27e146b370381` (3,402 files, 2.6 MB compressed), and `verify` passes 39/39 on it. The pushed digest is recorded at push time.

## What A42 changes

| Area | Change |
|---|---|
| Database | Migration **0011 only**: 9 new `bounty_*` tables and the source registry seed. No existing table changes. 0008 stays excluded |
| API machine | New image on the same machine; same size, region and auto-stop. New public routes `/bounties/` and `/public/bounties.json`; new operator routes under `/v1/bounties` (bearer-protected) |
| Collector | One Fly **scheduled** machine running `collect-main.js` hourly: the community board only. Not the research worker; claims no research step |
| Sources | Community board **on**. Sherlock, HackenProof and X **off** (owner decisions). Immunefi and Cantina **blocked** |
| Cost | No AI calls. The collector runs seconds per hour on shared-cpu-1x (estimate: a few cents a month) |

## 1. Image (done locally; push is the first A42 step)

```
git checkout <release commit>
export HUB_RELEASE_LAST_MIGRATION=0007 HUB_RELEASE_EXTRA_MIGRATIONS=0011
scripts/hub-image.sh build                  # done: ships 0001-0007 + 0011, excludes 0008, removes drafts
scripts/hub-image.sh verify                 # done: 39/39 smoke checks (TLS-verified loopback Postgres)
scripts/hub-image.sh push                   # A42: needs FLY_API_TOKEN; prints the pushed digest and re-checks it against the tested layer
```

**Local verification results:**
- `scripts/hub-image.sh verify` passes all 39 checks.
- These include the bounty checks:
  - the public page and feed work without a token;
  - only the community board is enabled as shipped;
  - the operator routes need the token;
  - the collector runs inside the image and never contacts a blocked or disabled source.

## 2. Migration 0011 (A42)

**Pre-flight** (read-only, inside the API machine, transaction rolled back):
- `schema_migrations` has exactly 0001–0007 with their recorded checksums;
- no `bounty_*` table exists.

Stop if either differs.

**Apply** with a one-off machine on the new image, so no credential leaves Fly:

```
fly machine run registry.fly.io/agentsmith-hub@<digest> --app agentsmith-hub --region syd --rm --restart no \
  -e MIGRATE_CONFIRM_REMOTE_HOST=<database host> --entrypoint sh -- -c 'DIRECT_DATABASE_URL="$DATABASE_URL" exec node dist/scripts/migrate.js'
```

- The Developer plan has no PgBouncer: `DATABASE_URL` is a direct connection, so the runner's advisory lock and transaction work as tested.
- **Expected output:** `Applied 0011_bounty_intelligence.sql`, and nothing else. The runner applies only the files the image ships, and refuses a changed checksum.

## 3. Deploy (A42)

```
fly deploy --config fly.hub.toml --app agentsmith-hub --image registry.fly.io/agentsmith-hub@<digest> --ha=false
```

## 4. First collection and schedule (A42)

```
# first run, once (same image, community board only by the shipped registry)
fly machine run registry.fly.io/agentsmith-hub@<digest> --app agentsmith-hub --region syd --rm --restart no \
  --entrypoint node -- dist/apps/api/src/bounties/collect-main.js --trigger manual
# hourly schedule
fly machine run registry.fly.io/agentsmith-hub@<digest> --app agentsmith-hub --region syd --schedule hourly \
  --vm-size shared-cpu-1x --vm-memory 512 --restart no --name bounty-collector \
  --entrypoint node -- dist/apps/api/src/bounties/collect-main.js
```

## 5. Acceptance checks (A42; each must pass)

1. `GET https://hub.agentsmithdesk.xyz/health/ready` returns 200.
2. `GET /bounties/` returns 200 with the strict CSP. `GET /public/bounties.json` returns 200 without a token, with `overview.total` of about 388 and the community board's `last_success_at` within the hour.
3. The feed's `sources` show only `community-board` enabled; `sherlock`, `hackenproof` and `x` off; `immunefi` and `cantina` blocked.
4. `/v1/bounties` without a token returns 401. `/v1/bounties/health` with the token shows one successful run, with the board `fetched` and every other source `skipped_*`.
5. `/v1/engine/status` reports the build commit, migrations 0001–0007 and 0011 as expected, and 0008 still missing (unchanged).
6. Second collection (the next hourly run): 0 added, about 388 unchanged (idempotent).
7. `fly machine list` shows the API machine and the scheduled `bounty-collector` only; no worker.
8. The page in a phone-sized viewport has no horizontal overflow.

Only after these pass is the page reported as live.

## 6. Rollback

- `fly machine destroy bounty-collector`.
- `fly deploy … --image registry.fly.io/agentsmith-hub@sha256:7f99bf270b0178274680281a80f85836a561567f377d46b8c4d6e2be7ba29e16` (release v6).
- The 0011 tables can stay: nothing else reads them, and v6 ignores them.

## 7. Not part of A42

- Sherlock, HackenProof or X enablement.
- `BOUNTY_IMPORT_FETCH_POLICY=user_initiated`.
- 0008; R1-apply; A26 or A34; any research worker or investigation.
- Changes to the Hunt page or repository.
