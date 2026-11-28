# DRAFT: option D, the worker reaches the database only through the API

- **Status:** draft, local and disposable only (written 2026-11-28). Nothing here has been applied to any shared database, and remote
  mode is off unless a worker is started with `WORKER_STORE=api` and the API with `WORKER_API_ENABLED=true`.
- **Why:** Fly Managed Postgres refuses every GRANT/REVOKE (docs/a7-worker-grants.md), so the restricted worker role cannot exist.
  In option D the worker holds **no database credential**. The API, which already holds the owner connection, performs each research
  read and write for it, through an explicit allow-list of operations, authorised by a run-scoped capability token.
- **Tables:** `worker_capability_tokens` (only the SHA-256 of the secret; run-bound; expiring; revocable; never deleted) and
  `worker_api_requests` (append-only idempotency record, written in the same transaction as each state-changing call).
- **Tests:** `apps/api/src/integration/worker-api.integration.test.ts` (real API process and real worker process; scoping, leases,
  validation, audit, idempotency, start-up refusal) and `apps/api/src/worker-remote.test.ts`.
- **To promote:** move `0015_worker_capability_tokens.sql` into `db/migrations/` under the next free number, add both tables to
  `db/runtime-grants.json` (an empty privilege list: the runtime role never needs them), update the two tests that pin the migration
  list (`acquisition.integration.test.ts`, `research-memory-draft.integration.test.ts`), delete this directory.

## Code map

| Piece | File |
|---|---|
| The port (types only) | `apps/api/src/research-port.ts` |
| Direct implementation (unchanged SQL) | `dbResearchReads` in `analysis/solidity/step.ts`, `pipelineReads` in `pipeline.ts`, `WorkflowWorker`, `ResearchStore` |
| Remote implementation | `apps/api/src/worker-api-client.ts` |
| API routes, authorisation, audit, idempotency | `apps/api/src/worker-api.ts` |
| Tokens (mint, revoke, parse, redact) | `apps/api/src/worker-tokens.ts`; CLI `worker-token-main.ts`; operator routes `POST /v1/research/runs/:id/worker-tokens`, `POST /v1/research/worker-tokens/:id/revoke` |
| Remote runtime and settings | `apps/api/src/worker-remote.ts`, entry `worker-remote-main.ts` (selected by `worker-main.ts`) |

## Token delivery (never through a chat session)

Implemented: the operator mints with the CLI on a machine that already holds the owner connection and pipes the result straight
into the worker app's secrets. The CLI refuses to write the token to a terminal; human-readable output goes to stderr.

```sh
node dist/apps/api/src/worker-token-main.js mint --run <run uuid> --by <operator> --ttl-hours 24 \
  | fly secrets import --stage -a <worker app>
fly machine run ... -e WORKER_STORE=api -e WORKER_API_URL=http://<api app>.internal:8081   # the token is NOT in -e
```

Residual exposure, from best to worst:

| Delivery | Who can read the token |
|---|---|
| **Fly OIDC (not implemented)**: the worker machine fetches a Fly-signed OIDC token from its local `/.fly/api` socket; the API verifies issuer, org, app and machine id and maps that machine to the run server-side. | No static secret exists. Anyone who can execute code **on that machine** can mint OIDC tokens while it runs (as with any machine identity). Needs JWKS fetching and caching in the API, and a server-side machine-to-run binding. |
| **Fly secret (implemented path)** | Decrypted into the machine's environment at boot: readable by any process on the machine (including the code the worker analyses, if it ever escaped; the Slither runner already gets a minimal environment, and the worker deletes `WORKER_API_TOKEN` from its own environment after reading it), by anyone with `fly ssh console` on the worker app, and by Fly. Not shown by `fly secrets list` or the machine config. |
| Machine env (`fly machine run -e WORKER_API_TOKEN=...`) | Additionally stored in plain text in the machine config: anyone with read access to the app sees it with `fly machine status -d`. **Do not use.** |

In every case the token is bounded: one run, at most 7 days (24 h default), revocable at once, and dead as soon as the run finishes.

## Network

The worker routes are registered only when `WORKER_API_ENABLED=true`, and answer **only** on a second listener of the same API process
(`WORKER_API_HOST`, default `fly-local-6pn`, and `WORKER_API_PORT`, default 8081). A request for a worker route that arrives on the
public listener gets 404 (tested). Enforcement on Fly: bind to `fly-local-6pn` (the machine's 6PN address, reachable only inside the
organisation's WireGuard mesh) and **do not** list 8081 in any `[[services]]` block of the API's fly.toml, so fly-proxy never forwards
public traffic to it. Add `<api app>.internal` to `HUB_ALLOWED_HOSTS` if that is set. Residual: every machine in the Fly organisation can
reach 6PN addresses, so the token, not the network, is the authorisation; 6PN only removes the public internet from the attack surface.
