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
4. `establish_authorization`: records the authorization state as unverified unless a later reviewed workflow supplies current scope evidence and explicit approval. It always blocks active testing in this intake path; a public repository or submitted URL is not authorization.
5. `map_attack_surface`: runs deterministic, versioned-in-code pattern rules over the bounded source snapshot. It records candidate code-surface leads (for example, external Solidity entry points, low-level calls, `tx.origin`, dynamic evaluation and process execution) in a separate immutable snapshot. These are review leads only, not vulnerability findings or proof of exploitability.
6. `generate_hypotheses`: turns recognized surface leads into structured, evidence-linked investigation questions with concrete verification checks and alternative explanations. Each remains `unverified_hypothesis`; no finding is promoted and no independent review is claimed.
7. `independent_challenge`: applies a deterministic counter-review checklist to each hypothesis. It asks what could make the signal benign, what source context is missing, and what evidence is needed before acceptance. It reports `status: checklist_applied` with `review_kind: deterministic_checklist`, `reviewer: null` and `independent_review_completed: false`; it is not an independent human or model review and never verifies or rejects a hypothesis. With no hypotheses it reports `not_applicable`.
8. `prepare_research_brief`: combines repository metadata, bounded source provenance, authorization state, surface leads, hypotheses and counter-review requirements into an immutable preliminary research brief. It explicitly states that no vulnerability is verified and that the brief is not submission-ready.

The GitHub handlers reject redirects, use bounded timeouts, enforce streaming response-size limits, renew the worker lease during multi-file retrieval and validate response shapes. Downstream mapping, hypothesis generation and counter-review compare every referenced snapshot's stored SHA-256 with the hash carried by the preceding workflow output; missing, malformed or mismatched references fail closed. Research briefs report three separate things: `completeness` (which pipeline stages produced output: `all_stages_executed`, `not_applicable_stages` or `partial_pipeline`), `research_completeness` (`not_assessable`, `no_leads_in_bounded_sample` or `preliminary_unreviewed`) and `verification` (always `independent_review_completed: false` until a real human or model review exists). A succeeded step or run means the handler executed; it never means the research is complete or verified. Briefs also carry a `provenance` block that lists any steps marked `seeded_synthetic`. Snapshot persistence checks the current worker lease, deduplicates identical captures and refuses update/delete through a database trigger. The source sampler never executes repository code, installs dependencies, runs tests, scans hosts, accesses private repositories, performs transactions or submits reports. The repository tree is treated as untrusted input.

All intake handlers preserve `execution_mode: passive_only` and `authorization_status: unverified`. Public repository metadata is not evidence of bounty authorization. Idea inputs and non-GitHub URLs are marked not applicable for GitHub-specific acquisition; their authorization state is still explicitly recorded, and the mapper reports not applicable if no source sample exists.

## Failure handling and retries

The loop (`worker-loop.ts`) never crashes on a database error in reap, claim or failure recording; it backs off (1 s doubling to 30 s, reset on success) and polls again. Idle pooled-connection errors are logged, not fatal.

Step failures are classified (`step-errors.ts`) and unknown errors fail closed as permanent:

| Class | Examples | Behaviour |
|---|---|---|
| retryable | HTTP 5xx/408/429, rate-limited 403 (`Retry-After` or `x-ratelimit-remaining: 0`), network or timeout errors, transient database errors | re-queued via `fail(retryable=true)` until `maxAttempts` (3); the loop then waits 5 s doubling to 120 s, or the server's `Retry-After` hint (max 300 s) |
| permanent | other HTTP statuses (incl. plain 403/404), redirects, size limits, malformed data, evidence-hash mismatch, anything unclassified | step and run marked failed |
| lease lost | the worker no longer owns the step | nothing is recorded; lease expiry returns the step to the queue |

At the attempt ceiling the stored reason says `retry limit reached: attempt N of M` and the SQL marks the step and run failed. Original error messages are preserved. If a failure cannot be recorded because the database is down, the worker retries the write three times and then leaves the lease to expire; the step is reclaimed and the attempt count still advances. On SIGINT/SIGTERM the in-flight step finishes, no further step is claimed and the pool is closed.

Limits: retry backoff is per worker process (another worker may claim a re-queued step sooner), and queue SQL behaviour is covered by mocked tests only until database integration tests exist.

## Running locally

Set `DATABASE_URL` to a database with the reviewed migrations applied, then run:

```sh
npm run worker:intake
```

The process uses a distinct pool and worker identity. SIGINT/SIGTERM stop polling and close the pool. Do not start this worker against production until migrations and tests have been run and the database has been backed up.

## Next handler requirements

Every new handler must have a finite step-key allowlist, bounded input/output, explicit timeouts, durable evidence references, idempotent side effects and tests. Any active test must load a current verified scope and the required approval. Unknown steps remain unclaimed until a handler is explicitly registered.
