# Workflow worker

`WorkflowWorker` is the database-backed execution primitive. It claims and records work; task handlers remain separate and narrowly scoped.

- Claims one eligible step in sequence order using `FOR UPDATE SKIP LOCKED`.
- Uses expiring leases so abandoned work can be reclaimed.
- Increments attempts on claim and enforces a configured retry ceiling.
- Requires the current lease owner to heartbeat or complete a step.
- Writes audit events for claims, success and failure.
- Marks the parent run successful only after every step succeeds.

## Executable intake handlers

The separate process is started with `npm run worker:intake`. It claims only these explicitly registered steps:

1. `resolve_source`: deterministic URL normalization or idea intake bookkeeping. It performs no network request.
2. `identify_project`: for recognized GitHub repository URLs only, performs one read-only request to the fixed `api.github.com/repos/{owner}/{repo}` endpoint and stores a bounded metadata snapshot in the append-only `source_snapshots` table, with SHA-256 hash and workflow-step provenance.
3. `locate_official_repositories`: despite the legacy step key, this handler currently samples the user-supplied GitHub repository; it does not assert that the repository is official. It reads the recursive Git tree from the fixed GitHub API, selects at most 20 likely text/source files from a fixed extension allowlist, excludes common generated/vendor directories, and fetches at most 48 KB per file and 512 KB total from `raw.githubusercontent.com`. The tree response is capped at 2 MB. It persists the bounded source sample as an immutable snapshot and returns only a file inventory and hashes in workflow output.

The GitHub handlers reject redirects, use bounded timeouts, enforce streaming response-size limits and validate response shapes. Snapshot persistence checks the current worker lease, deduplicates identical captures and refuses update/delete through a database trigger. The source sampler never executes repository code, installs dependencies, runs tests, scans hosts, accesses private repositories, performs transactions or submits reports. The repository tree is treated as untrusted input.

Both handlers preserve `execution_mode: passive_only` and `authorization_status: unverified`. Public repository metadata is not evidence of bounty authorization. Idea inputs and non-GitHub URLs are marked not applicable for this particular metadata lookup; later workflow steps remain queued until their own reviewed handlers exist.

## Running locally

Set `DATABASE_URL` to a database with the reviewed migrations applied, then run:

```sh
npm run worker:intake
```

The process uses a distinct pool and worker identity. SIGINT/SIGTERM stop polling and close the pool. Do not start this worker against production until migrations and tests have been run and the database has been backed up.

## Next handler requirements

Every new handler must have a finite step-key allowlist, bounded input/output, explicit timeouts, durable evidence references, idempotent side effects and tests. Any active test must load a current verified scope and the required approval. Unknown steps remain unclaimed until a handler is explicitly registered.
