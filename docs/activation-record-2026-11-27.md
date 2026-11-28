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
