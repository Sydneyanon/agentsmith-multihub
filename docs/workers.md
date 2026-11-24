# Workflow worker

`WorkflowWorker` is the database-backed execution primitive. It claims and records work; task handlers remain separate and narrowly scoped.

- Claims one eligible step in sequence order using `FOR UPDATE SKIP LOCKED`.
- Uses expiring leases so abandoned work can be reclaimed.
- Increments attempts on claim and enforces a configured retry ceiling.
- Requires the current lease owner to heartbeat or complete a step.
- Writes audit events for claims, success and failure.
- Marks the parent run successful only after every step succeeds.

## First executable handler

The first separately runnable worker process is `npm run worker:intake`. It polls only for the `resolve_source` step and ignores every other step key. It performs deterministic URL normalization / idea intake bookkeeping and persists the result through the lease-checked completion path.

This handler performs **no network request**, repository clone, source download, host scan, transaction, PoC execution or active test. The output explicitly records `network_access_performed: false`, `execution_mode: passive_only` and `authorization_status: unverified`.

The remaining intake steps stay queued until their own reviewed handlers exist. The worker must not claim arbitrary future steps or pretend that a queued step has executed.

## Running locally

Set `DATABASE_URL` to a database with the reviewed migrations applied, then run:

```sh
npm run worker:intake
```

The process uses a distinct pool and worker identity. SIGINT/SIGTERM stop polling and close the pool. Do not start this worker against production until migrations and tests have been run and the database has been backed up.

## Next handler requirements

Every new handler must have a finite step-key allowlist, bounded input/output, explicit timeouts, durable evidence references, idempotent side effects and tests. Any active test must load a current verified scope and the required approval. Unknown steps remain unclaimed until a handler is explicitly registered.
