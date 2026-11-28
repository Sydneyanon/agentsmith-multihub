# Option D: operating the worker API (the worker holds no database credential)

- **Status:** release candidate, local and disposable testing only (2026-11-28). Nothing here has been applied to a shared database.
  Remote mode is off unless a worker is started with `WORKER_STORE=api` and the API with `WORKER_API_ENABLED=true`.
- **Migrations:** `db/migrations/0015_worker_api.sql` (promoted from the former draft `db/drafts/d-worker-api`, plus the D4 and D7
  tables) and `db/migrations/0016_research_independence.sql` (R3a). Rollbacks: `db/rollbacks/`. Neither is in an approved release;
  `deploy/release.json` is unchanged and the owner approves releases.
- **Why:** Fly Managed Postgres refuses every GRANT/REVOKE (docs/a7-worker-grants.md), so a restricted worker role cannot exist. In
  option D the worker holds **no database credential**; the API, which already holds the owner connection, performs each read and write
  for it through an explicit allow-list of operations, authorised by a run-scoped capability token. The fixes D1-D7 and their tests are
  listed in `docs/security/worker-architecture-decision.md`.

## Tables (0015)

| table | what | written by |
|---|---|---|
| `worker_capability_tokens` | SHA-256 of each token's secret; run-bound; expiring; revocable; never deleted | operator (mint/revoke) on the owner connection |
| `worker_api_requests` | append-only idempotency record, in the same transaction as each state-changing call | API |
| `worker_token_usage` | D4 per-token quota ledger: bytes and blobs stored, bytes read, API processing time; counters only grow | API (`worker-quotas.ts`) |
| `worker_blob_uploads` | D4 which blobs a run's worker uploaded; manifest rows may cite only these | API |
| `hypothesis_evaluation_keys` | D7 one evaluation per (hypothesis, evaluator, version, input hash); written by a trigger for every writer | trigger |
| `evaluation_provenance` | D1 validator identity, version, family, method, input hash, snapshot, who ran it, raw output blob | API, direct worker |
| `snapshot_verifications` | D2 the API's GitHub verification of a worker-uploaded snapshot: resolved commit, tree, counts, per-file results blob, time | API |

## Configuration

API (`server.ts`, `config.ts`): `WORKER_API_ENABLED`, `WORKER_API_HOST` (default `fly-local-6pn`), `WORKER_API_PORT` (default 8081);
`GITHUB_TOKEN` (read-only; the API's own GitHub source for D2); quotas `WORKER_API_QUOTA_BYTES` (256 MiB), `WORKER_API_QUOTA_BLOBS`
(25 000), `WORKER_API_QUOTA_READ_BYTES` (2 GiB), `WORKER_API_QUOTA_PROCESSING_MS` (10 min), `WORKER_API_RATE_PER_SECOND` (200) and
`WORKER_API_RATE_BURST` (400); analysis limits `WORKER_API_COMPUTE_CPU_MS` (20 s), `WORKER_API_COMPUTE_WALL_MS` (30 s),
`WORKER_API_COMPUTE_HEAP_MB` (512) and `WORKER_API_MAX_SNAPSHOT_BYTES` (32 MiB). At most 3 worker-API requests touch the database at
once (the API's pool has 5), so operator routes always have connections; at most 2 analysis children run at once.

Worker (`worker-remote-main.ts`): `WORKER_STORE=api`, `WORKER_API_URL`, and **`WORKER_API_TOKEN_FILE`** (a file holding the token, or `-`
for stdin). **`WORKER_API_TOKEN` in the environment refuses the start (exit 64).** Exit codes: 0 run finished, 64 configuration refused,
77 token refused (expired, revoked, unknown), 78 run cancelled or failed.

## Token delivery (never through a chat session) and the residual exposure (D6)

The operator mints with the CLI on a machine that already holds the owner connection. The CLI refuses to write the token to a terminal.
The worker reads the token ONCE from the file (or stdin) and unlinks the file where the mount allows it; the token is never in the
worker's environment, so `/proc/<pid>/environ` does not hold it and no child process inherits it (the pinned tool runner starts Slither
and forge with `PATH`, `HOME` and `LANG` only). Tested: `adversarial-shared.integration.test.ts` S10.

What remains, from best to worst:

| exposure | who can read the token |
|---|---|
| the worker process's memory | anything that can read that process's memory: the same user with ptrace rights (`/proc/<pid>/mem`), root on the machine, a core dump. The worker runs untrusted archives and tools: a tool escape running as the same user could read it. Mitigation: run tools as a different user (not done). |
| the secret file before it is unlinked | anything that can read the file in the window between machine boot and worker start; a read-only secret mount cannot be unlinked at all (the worker logs `token_file_removed: false`) and the file stays readable for the machine's life. |
| Fly operators and `fly ssh console` | anyone with SSH access to the worker app can read the secret file (or the process memory), and Fly itself can. |
| Fly secret store | a Fly secret is decrypted into the machine's environment at boot by Fly. **Do not deliver the token as a Fly secret environment variable** (the worker refuses it); deliver it as a file (`[[files]]` with a secret, or a one-shot stdin pipe from the operator). |
| machine config (`fly machine run -e`) | stored in plain text in the machine config. **Never.** |

In every case the token is bounded: one run, at most 7 days (24 h default), revocable at once, dead as soon as the run finishes, and
limited by the D4 quotas. A **Fly OIDC** machine identity (no static secret) remains the better design and is not implemented.

## Network

The worker routes are registered only when `WORKER_API_ENABLED=true`, and answer **only** on a second listener of the same API process
(`WORKER_API_HOST`, `WORKER_API_PORT`); on the public listener they are 404 (tested). Bind to `fly-local-6pn` and do not list the port in
any `[[services]]` block. Residual: every machine in the Fly organisation can reach 6PN addresses, so the token, not the network, is the
authorisation.

## Code map

| piece | file |
|---|---|
| the port (types only) | `apps/api/src/research-port.ts` |
| direct implementation (unchanged SQL) | `dbResearchReads` in `analysis/solidity/step.ts`, `pipelineReads` in `pipeline.ts`, `WorkflowWorker`, `ResearchStore` |
| remote implementation (derived idempotency keys) | `apps/api/src/worker-api-client.ts` |
| API routes, authorisation, audit, idempotency, API-side derivation | `apps/api/src/worker-api.ts` |
| D2 GitHub verification | `apps/api/src/acquisition/snapshot-verify.ts` |
| D1/D3 bounded analysis runner | `apps/api/src/analysis/solidity/bounded-compute.ts`, `compute-child.ts` |
| D4 quotas | `apps/api/src/worker-quotas.ts` |
| tokens (mint, revoke, parse, redact) | `apps/api/src/worker-tokens.ts`; CLI `worker-token-main.ts`; operator routes `POST /v1/research/runs/:id/worker-tokens`, `POST /v1/research/worker-tokens/:id/revoke` |
| remote runtime and settings | `apps/api/src/worker-remote.ts`, entry `worker-remote-main.ts` (selected by `worker-main.ts`) |
