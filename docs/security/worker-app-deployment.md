# Separate worker app: deployment design (owner-approved direction 2026-11-28; PREPARED, nothing created)

## Topology
| | `agentsmith-hub` (existing) | `agentsmith-worker` (new) |
|---|---|---|
| holds | `DATABASE_URL` (owner), `API_BEARER_TOKEN`, `GITHUB_TOKEN`, `WORKER_DATABASE_URL` (the unused A7 reader, see below) | **one** secret: the run-scoped worker token |
| inbound | public hub (443) and the **private** worker API listener `fly-local-6pn:8081` (no `[[services]]` entry, so not public) | none |
| outbound | Postgres, GitHub (D2 verification) | `agentsmith-hub.internal:8081` (6PN), GitHub (archive download) |
| config | `fly.hub.toml`: adds `WORKER_API_ENABLED=true`, `WORKER_API_HOST=fly-local-6pn`, `WORKER_API_PORT=8081` | `fly.worker.toml` |

## Fixes found while preparing it (dev branch)
- **Host guard.** The private listener forwards requests into the same app, so the public host guard returned **421** for a worker
  calling `agentsmith-hub.internal`. The fix exempts only requests that arrived on the private port **and** target
  `/internal/worker/v1/`. Same path on the public port: still 421. Another path on the private port: still 421.
  Test: `host-guard-private.test.ts`, run over real sockets. It failed before the fix and passes after.
- **Worker identity on 6PN.** Any machine in the organisation can reach 6PN addresses, so the network is not the authorisation; the
  run-scoped token is (D, unchanged).

## Token delivery on Fly: an honest limit
On Fly, a static secret is decrypted into the machine at boot. D6 keeps the token out of the worker's **process** environment by
reading it from a file. Fly's two file mechanisms differ:
- `--file-secret /run/secrets/worker-token=WORKER_RUN_TOKEN` writes an app secret to the file. **Unverified:** whether Fly also places
  that secret in the machine's environment. If it does, the token sits in the environment under `WORKER_RUN_TOKEN`. That is outside
  the worker's own process tree only if Fly's init does not pass it on.
- `--file-local` embeds the file in the machine config. **Unverified:** who can read it back through the Machines API.

**Before any real token is used**, a harmless check in the new app with a **dummy** value must establish which mechanism keeps the
value out of the worker's process environment and out of readable machine config. The worker already refuses `WORKER_API_TOKEN` in its
environment, and that check will be extended to refuse **any** environment variable whose value equals the file's token. Until the
check passes, the remaining exposure is the one already documented (`docs/security/worker-api-operations.md`): one run, 24 h, revocable,
quota-bounded. **Fly machine OIDC** (no static secret) remains the better design and is not built.

## The A7 reader user
`agentsmith_worker` and `WORKER_DATABASE_URL` (created 2026-11-27) are **not used by D**. They should be removed: delete the Fly MPG user
and unset the secret. That needs approval and is listed as a gate below.

## Deployment sequence (each step needs its own approval; nothing below has been run)
| # | step | gate |
|---|---|---|
| W1 | `fly apps create agentsmith-worker --org <org>` (no machines) | create app |
| W2 | dummy-secret check: stage a dummy secret, run one throwaway machine that prints only *whether* the dummy appears in `/proc/1/environ`, `/proc/self/environ` and the machine config, then destroy the machine and unset the dummy | production test |
| W3 | (with the release) the hub deploy carries `WORKER_API_ENABLED=true` on the private listener | deploy |
| W4 | mint one run-scoped token for the created USX run, on a hub machine, piped into the worker app's secret store (never displayed) | secret |
| W5 | one worker machine: `fly machine run <release image> --app agentsmith-worker --region syd --restart no --file-secret … --env WORKER_ONLY_RUN_ID=<run> --env WORKER_EXIT_WHEN_RUN_DONE=true -- dist/apps/api/src/worker-main.js` | worker activation |
| W6 | after the run: revoke the token (`POST /v1/research/worker-tokens/:id/revoke`), unset the secret, destroy the machine | cleanup |
