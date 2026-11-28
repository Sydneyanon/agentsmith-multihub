# Activation record, 2026-11-27 (release d09d0c2, owner-approved)

Release: commit `d09d0c23c39110df4725a8e049e967c124d43a35`, image
`registry.fly.io/agentsmith-hub@sha256:b52ce901d3325c101d63b2840160cc2b22b63257f68c14da1e1068e3e6a2d5e0` (tag `hub-d09d0c23c391`,
confirmed with `crane digest`).

| step | done (UTC) | result | verification |
|---|---|---|---|
| pre-check | 23:1x | 17 drift items (as in `deployment-reconciliation.md`) | `release-check`; health 200 |
| **A1** API deploy | ~23:15 | `late-meadow-8506` on `b52ce901`, revision `d09d0c2` | health live and ready 200; `/bounties/` and `/public/bounties.json` 200; engine status build `d09d0c23c391`; `github.mode=authenticated`; only attention reason was 0012–0014 pending |
| **A2** collector | ~23:18 | `8747e47a1501d8` on `b52ce901`; schedule `hourly` and command unchanged | `fly machine list`; first run completed (below) |
| **A3** migrations | 23:21:35 | exactly `Applied 0012_…`, `0013_…`, `0014_…`; exit 0 | engine status: applied 0001–0007, 0011–0014; missing `[]`; unknown `[]`; state `idle` |
| **A4** sources | ~23:22 | `sherlock` and `hackenproof` set to `enabled, permitted`, with an owner-approval note | collection run `76a05681`: Sherlock **fetched 41** (all matched existing records, now `official_confirmed`). HackenProof **failed**: `blocked_timeout` waiting for response headers; it retries on its own cadence, not forced. Cantina and Immunefi still blocked. |
| GitHub live check | 23:26 | **PASS** | `mode=authenticated`, rate limit 5000 (unauthenticated is 60); remaining fell from 4996 to 4993 across the acquisition, so the token's own quota was consumed. Real acquisition of `octocat/Hello-World` at `7fd1a60b…`, manifest `f847e342…`, complete, in memory. 0 token strings in logs. |
| **A6** enrichment | 23:32 | 10 attempted, 7 enriched, 9 repositories verified, 3 with no repositories, 0 deferred | per-programme log lines; mappings read back from the database (below); all commits pinned with an authenticated read |
| **A7** worker user | 23:36–23:38 | `agentsmith_worker` created (Fly role `reader`); `WORKER_DATABASE_URL` set by `fly mpg attach --variable-name` and deployed. The connection string was never printed into this session (all output discarded). | `fly mpg users list`; `fly secrets list` (digests only); `DATABASE_URL` digest unchanged; API health 200 after the restart; both machines still on `b52ce901` |
| **A7** grants dry run | 23:39 | **failed, nothing changed**: Fly refused one statement with `MPG system roles cannot be modified` (exit 1, the transaction rolled back). Skipped as absent: four 0008 tables (expected). | logs |
| A7 diagnosis | — | **blocked**: a rolled-back statement-by-statement probe was refused by this session's tool permission check as a production action | — |

## Production after these steps
- One release on both machines: `release-check` shows no version mismatch, nothing behind, no missing fix and no missing
  migration.
- Remaining items: the four undeclared jobs and the worker (not authorised); `release_not_on_main`.
- Programmes: 391 total; 41 Sherlock officially confirmed; **12 eligible**.

## 2026-11-28: A7 diagnostic (owner-approved)
All nine revocation classes were refused by Fly (42501 "MPG system roles cannot be modified"), including every per-object
revocation from PUBLIC. The transaction was rolled back, and the privilege fingerprint is identical before and after. **A7 is blocked
on the platform**; see `docs/a7-worker-grants.md` §9–10. A8 has not started.

## 2026-11-28: release ab5ab57 (owner-approved: "I approve production migrations 0015 and 0016 and deploying image c1c14787 to the API and collector.")
Image `registry.fly.io/agentsmith-hub@sha256:c1c14787635418b898c854612689486a104244f39cabd48c18907522cdcaa286` (tag `hub-ab5ab57c0d4c`),
built daemonlessly from `ab5ab57`; migrations shipped 0001–0007, 0011–0016 (0008 and drafts excluded); image smoke test 41/41; pushed image
checked against the tested layer.

| step | done (UTC) | result | verification |
|---|---|---|---|
| migrations | 06:13:14 | exactly `Applied 0015_worker_api.sql`, `Applied 0016_research_independence.sql`; exit 0 | engine status: applied = expected, 0001–0007, 0011–0016 |
| API deploy | ~06:15 | `2870320f99dd68` on `c1c14787`, healthy 1/1 | `/health/live`, `/health/ready`, `/hub/`, `/bounties/`, `/public/bounties.json` 200; engine status build `ab5ab57…`; `/v1/research/timeline`, `/v1/engine/components`, `/v1/research/overview` 200 (read inside the machine, token never printed); Operations view present in the served hub |
| collector | ~06:17 | `8747e47a1501d8` on `c1c14787`; schedule `hourly`, command unchanged | `fly machine list` |

Not done (not approved): worker app, worker tokens, `WORKER_API_ENABLED` (the private worker listener is off), worker activation,
the USX run, removal of the unused `agentsmith_worker` user and `WORKER_DATABASE_URL` secret, merge to main.
Rollback: API and collector to `b52ce901` (old code runs on the migrated schema: the new objects are additive); migrations via
`db/rollbacks/0016_…` then `0015_…` only if required.

## 2026-11-28: release 0d4ee1d (owner mandate "Release, APEX integration and continuous security monitoring", Part A)
Image `registry.fly.io/agentsmith-hub@sha256:185e8251475124daf0ccd8c7fbedf5a53b6b6ebfe69e955687d1494e88cca99b` (tag `hub-0d4ee1d894c1`),
built daemonlessly from `0d4ee1d`; migrations shipped are the same set already applied (0001–0007, 0011–0016), so **no migration was run**.

Pre-release: `0d4ee1d` = tip of `origin/dev/research-readiness`; tree identical to the verified `apex-shadow` branch; changes since
`ab5ab57`: APEX shadow stage (off by default, created only by `--apex-shadow --apex-approved-by` on the approved USX target), panel 6,
tests, docs; no change to `db/`, `fly.hub.toml`, Dockerfile or dependencies. Typecheck 0; unit 1227 passed; integration 458 passed / 1
skipped in both normal and restricted-role modes; hub layout check 257 checks PASS; frozen corpora identical (dev 17/0/0/14, heldout
18/0/0/29, heldout2 31/8/6/51, heldout3 21/1/10/47, heldout4 20/1/18/40, benchmark-b 0/0/8/8); image smoke 41/41; pushed image checked
against the tested layer.

| step | result | verification |
|---|---|---|
| API deploy | `2870320f99dd68` on `185e8251`, healthy 1/1 | engine status build `0d4ee1d…`, schema missing [] unknown []; `/health/*`, `/hub/`, `/bounties/`, `/public/bounties.json` 200; timeline, overview, components 200 (read inside the machine, token never printed); served `view-operations.js` byte-identical to the build |
| collector | `8747e47a1501d8` on `185e8251`; schedule `hourly`, command unchanged | `fly machine list` |
| APEX | components: `apex` **experimental**, off by default; no APEX env on either machine | in-machine read |
| worker listener | **off**: `WORKER_API_ENABLED` unset; port 8081 refuses connections; components: `worker_api` unavailable (routes not registered) | in-machine read |

Not verifiable by the operator session: the unlocked live dashboard (no hub token held). No research run exists in production, so panel 6
has no run to render; its "not enabled for this run" state appears only once a run exists.
