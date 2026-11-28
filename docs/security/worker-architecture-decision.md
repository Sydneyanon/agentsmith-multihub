# Worker architecture: B′ versus D. Adversarial comparison and recommendation (2026-11-28)

## Evidence
| | B′ (writer role + triggers) | D (API-mediated, no database credential) |
|---|---|---|
| implementation | `157e046` (local branch `worktree-agent-ae427a1a51fd89b5f`) | `b3c1744` (local branch `worktree-agent-affce73ae39ebaaa9`) |
| shared adversarial suite (S1–S12, same ids) | `0afb56d`, 24/24, **re-run by the reviewer** | `cbfb8e8`, 24/24, **re-run by the reviewer** |
| design's own tests (re-run by the reviewer) | 40/40 new; integration 417/417 (both modes) | 16/16 new; unit 1048; integration 389/389 (both modes) |
| independent spot check (reviewer, fresh role with pg_read_all_data + pg_write_all_data) | read the password hashes of **14 roles** (`pg_authid.rolpassword`); `ALTER ROLE CURRENT_USER PASSWORD` succeeded and locked out the old credential | n/a |

All of this ran on disposable local Postgres. Nothing ran on Fly.

## Matrix (P = prevented, V = vulnerable, Pa = partial; compromised worker)
| scenario | B′ | D |
|---|---|---|
| S1 delete research records | P | P |
| S2 alter records or step outcomes | **V**: finished step outputs and run status are rewritable | P |
| S3 tables outside its responsibilities | **V**: budget reservations, bounty programmes, sources (re-enable), mappings (repository replaced), other runs | P |
| S4 arbitrary SQL / reads | **V**: reads all tables, **all role password hashes**, and can switch off its own statement timeout | P; Pa: a cross-run blob is readable when its hash is known (existence oracle) |
| S5 bypass the enforcement | P for triggers; Pa: setval, LOCK, advisory locks, large objects, `information_schema` | P: all token, authorisation, validation, replay and race cases |
| S6 privileges / DDL | **V**: changes its own role password (locks out every worker sharing it) and role settings | P |
| S7a forge the validator's verdict | **V** (plus forged human review and withdrawal) | **V** (no review operation exists, so no forged review) |
| S7b another generator's identity | **V** (model, human, Slither) | P |
| S7c fake commit or content | **V** (any repository) | **V** (the queued repository only) |
| S7d fake "complete" coverage | **V** | **V** |
| S8 another worker's run | **V**: steals leases and writes into other runs | P |
| S9 after cancellation or revocation | **V**: keeps writing, and can un-cancel the run | P |
| S10 secrets / reach | **V**: writes and deletes in **other databases on the cluster** | Pa: the token is still readable in `/proc/<pid>/environ` after it is deleted from the environment |
| S11 compromised owner / API | V: the owner disables triggers and rewrites evidence | V: same through the API's owner connection, plus deleting audit rows and minting tokens |
| S12 recovery | P; observed: a duplicate evaluation after a kill mid-challenge | P (including a lost response after commit); same duplicate evaluation; idempotency keys held only in client memory |

**Measured impact of B′'s ID-counter weakness:** not just availability. Raising and then restoring `hypothesis_events_seq` made a
forged `supports` outrank the validator's later `weakens`: the status changed from `weakened_by_static_check` to `unreviewed/supports`.
The same trick lets a forged human `supports` outrank the reviewer's later `rejects`, giving `supported_by_review`. Lowering the
counter causes key collisions, a denial of service only; no row is overwritten.

**Locking:** an ACCESS EXCLUSIVE lock blocked owner queries until their timeout.

## Security boundaries
| | B′ | D |
|---|---|---|
| worker holds | a cluster-wide read/write database credential | an HTTP URL and a token for one run; **no database credential** |
| API holds | the owner connection (as today) | the owner connection (as today), plus the 21-operation worker interface |
| restriction enforced by | the database (guards, 0007 triggers). **Leases, run scope and run status are enforced only by the worker's own code**, so a compromised worker ignores them | the API (token, run scope, lease, per-step operations, generator and evaluator allow-lists, repository match, idempotency); the database still applies 0007's triggers to the API's statements |
| compromised worker | everything in its credential's reach: other runs, budget, bounty data, sources, cluster-wide reads including password hashes, other databases | appends to its own run, including forged verdicts, content and coverage; storage abuse; it can stall the API (below) |
| compromised API | the whole database (unchanged from today) | the whole database (unchanged from today), plus token minting |
| database enforces evidence invariants independently? | only against non-owners; the owner can disable them | same |
| trusts the worker to behave? | **yes**, for leases, run scope and cancellation | only for the truth of its own run's content and verdicts, which both designs trust |

**Buggy versus compromised:** B′ protects against a buggy worker's deletes and in-place edits, but not its writes after cancellation
(S9). Against a compromised worker it protects only deletes and in-place edits of append-only rows. D protects against both, for
everything outside the run's own appends.

## Recommendation: **D. B′ is rejected.**
B′ fails the compromised-worker threat model on its own terms, because the weaknesses belong to Fly's `writer` role itself and no
trigger can remove them:
- cluster-wide reads, including password hashes;
- self-service role changes;
- other databases;
- a ledger-ordering attack via sequences;
- leases and run scope enforced only by the worker.

D removes the database credential from the machine that handles untrusted archives and tools, and confines a compromised worker to
appends in its own run.

**D is not ready for approval yet.** These fixes are required first, each with its adversarial test re-run:

| # | fix | closes |
|---|---|---|
| D1 | **The API does deterministic validation itself.** The worker may not record evaluations under validator ids; the API runs the execution validators on the sealed snapshot (the stored hypotheses, by id) and records only its own verdicts. | S7a, (b) |
| D2 | **The API verifies content against GitHub.** The API fetches the commit's tree itself (authenticated, read-only) and checks every uploaded file's git blob id against it before sealing. The commit must equal the pinned ref. | S7c |
| D3 | **The API owns analysis outputs.** It either recomputes the structural analysis on the sealed snapshot (deterministic, no execution) or validates each step output against a strict per-step schema. Coverage is derived by the API, never taken from the worker. Trade-off: recomputing means parsing untrusted source text inside the API process, which needs CPU and time limits. | S7d, and `complete` storing arbitrary fields |
| D4 | **Per-token quotas:** bytes, blob count, request rate and read volume. Blobs are scoped to the run for reads, which closes the existence oracle. | storage abuse, S4 partial |
| D5 | **Fix the pool self-deadlock** on raced idempotency keys: write the replay audit on the same connection, and map pool timeouts to retryable 503s. | API stall |
| D6 | **Remove the token from the process environment.** Read it from a file or stdin once, or re-exec without it. Document what remains: Fly operators and SSH access. | S10 partial |
| D7 | **Make evaluations idempotent** (hypothesis, evaluator, input hash), and **persist client idempotency keys** per step. | duplicate evaluation on retry (both designs) |

**Out of scope for this decision; it applies to today's system as well (S11).** The owner connection can bypass every database
invariant. Mitigations to plan separately:
- a tamper-evident evidence ledger: a hash chain over research records, with periodic checkpoints exported outside the database;
- audit events shipped off-database;
- separating the API's runtime role from the migration owner, which Fly's fixed roles currently prevent.

## What approval of D would mean
1. D1–D7 implemented and tested, the shared adversarial suite re-run, and the full suites and frozen corpora checked.
2. D and the dev branch's USX fixes (`d3ffd69`) in one release candidate: smoke-tested, digest recorded, presented for approval.
3. One production migration (the token and request tables), a deploy of the API and collector together, a run-scoped token staged as
   a Fly secret by pipe, and one worker machine with no database URL. Each step needs your approval.

---

## D1–D7 implemented and re-tested (2026-11-28, local and disposable only)

Branch `worktree-agent-ae6d9e15f8afc1bb7`, on `dev/research-readiness` (`abe25a9`) merged with D (`b3c1744`, `cbfb8e8`). Nothing ran on
Fly; nothing was pushed; `deploy/release.json` is unchanged. Operating notes: `docs/security/worker-api-operations.md`.

| fix | what changed | discriminating tests (fail on the merge commit, pass now) |
|---|---|---|
| D1 | `record_evaluation` is always refused (403 `evaluations_are_api_derived`, audited, recorded nowhere: there is no "proposal" table). On `complete` of `challenge_leads` the API runs the execution validators itself, in a bounded child process, on the sealed snapshot, for the stored hypotheses by id (`storedHypothesesFromRecords`), and records the evaluations with provenance (validator id, version, family and method from the API's registry, input hash, snapshot, raw output blob in `evaluation_provenance`). The worker needs no abstention of its own: the API records `no-independent-validator` too. | S7a, S12 (kill mid-challenge), e2e steps 2–3, `worker-remote.test.ts` D1 surface |
| D2 | Before sealing, the API resolves the ref and fetches the recursive tree through its OWN authenticated read-only `GitHubSource`, recomputes the acquisition plan (`buildPlan`, pure), and refuses unless the commit equals the pinned 40-hex ref or the resolved commit, every manifest row matches the plan (paths, classification, size, git blob id; no extra, missing or plan-excluded path), and every stored byte re-hashes on the server to the tree's git blob id (`gitBlobSha1`). Tree-decided skips must equal the plan's; content-decided skips (binary, encoding) are refused for `*.sol` and recorded as UNVERIFIED otherwise. Network failure: retryable 503. Evidence: `snapshot_verifications` plus per-file result blobs. | S7c (7 forgeries, GitHub down), S4 blob smuggling, e2e step 1 |
| D3 | Strict per-step `complete` schemas (extra fields such as `authorization_status` refused). `analyze_structure` is RECOMPUTED by the API (bounded child) and only API-derived `contracts`, `functions`, `problems`, `hypothesis_ids`, `finding_payloads`, `protocol_model_sha256` are stored (`derived_by: "api"`); acquisition and dossier outputs are built by the API from its records. Chosen over "verify the worker's output" because it is simpler and leaves nothing to compare: the worker sends only the snapshot id. The dossier labels every part API-verified/derived or worker-reported (a provenance section, per entry, per evaluation). Exception: the optional Slither stage runs a tool on the worker; its output and leads are stored and shown as WORKER-REPORTED. | S7d, S7b, D-specific "operations beyond their purpose", e2e step 6 |
| D4 | Durable per-token ledger (`worker_token_usage`): bytes and blobs stored (413), bytes read (429), cumulative API processing time (429); request rate (in memory). Per-request limits: snapshot size, CPU time, wall time, heap, answer size (413 `processing_limit_exceeded`). Manifest rows may cite only blobs the run uploaded (one answer for unknown and other-run hashes). All configurable (`WORKER_API_QUOTA_*`, `WORKER_API_COMPUTE_*`). | storage abuse, read volume and processing time, S4 cross-run blob |
| D5 | At most 3 worker-API requests touch the pool (of 5) at once; expensive work (GitHub, analysis) runs before the transaction with no client held; the raced replay audit is written on the same client; refusal audits run only after the client is released; pool/connect timeouts are matched first in `asRefusal` (503). Measured: 10 racing duplicates on a pool of 5 all answer 200 `replayed`, slowest 67 ms; operator GET during the hold 8 ms. | racing duplicates, connect-timeout 503 |
| D6 | The worker reads the token from `WORKER_API_TOKEN_FILE` (or stdin) and unlinks the file; `WORKER_API_TOKEN` in the environment refuses the start (64). `/proc/<pid>/environ` of the worker process tree holds no token (checked on the real worker); the tool runner's child gets `PATH`, `HOME`, `LANG` only. Cancellation stops the worker with exit 78, revocation with 77, nothing written after, the token in no log. Residual exposure: see the operations doc (process memory, the file before unlink or on a read-only mount, Fly operators and SSH, Fly's secret store). | S10, e2e cancellation and revocation, `worker-remote.test.ts` D6 |
| D7 | `hypothesis_evaluation_keys` (0015): one evaluation per (hypothesis, evaluator, version, input hash) for every writer (trigger and primary key); the store returns the existing row, and a changed verdict for the same key is a conflict. Client idempotency keys are derived from (step, attempt, operation, body). Shown: a kill mid-challenge then a retry leaves no duplicate in direct and remote mode; the events before the kill are a prefix of those after (nothing reordered; latest outcomes unchanged); concurrent duplicates write once; a lost answer replays the original result; an API restarted mid-step is correct. | S12, `evaluation-idempotency.integration.test.ts`, worker-api idempotency, e2e step 7 |

**Process spawning in the production build.** D1/D3 need CPU and wall-time limits on the API's own analysis of untrusted Solidity text,
which a single Node event loop cannot enforce. The API therefore starts ONE kind of child: its own Node binary on its own
`compute-child.js`, with a fixed argument list and an environment of `PATH` and `NODE_ENV` only (`bounded-compute.ts`, pinned by
`build-output.test.ts`). This relaxes the earlier property "the hub image cannot start a process at all" (the audit-tool host stays
excluded). It is an owner decision; the alternative is in-process analysis without enforceable CPU limits.

### Migrations (proposed for the release; applied only in disposable databases)

- **0015** `worker_api`: tokens and the idempotency record (from the draft), the quota ledger, the blob-upload index, evaluation keys
  (backfilled; an earlier duplicate stays as history), evaluation provenance, snapshot verifications. Rollback `db/rollbacks/0015_worker_api.rollback.sql`.
- **0016** `research_independence` (R3a): `analysis_identities` (seed = `analysis-identity.ts`, unit-tested), the self-evaluation trigger,
  `evaluation_independence` and `hypothesis_independence` (same-family corroboration and cross-family support in separate columns),
  `SELECT` grants. No dependency on 0008–0010. Rollback `db/rollbacks/0016_research_independence.rollback.sql`.
- **R3b** (the `hypothesis_outcome_rules()` replacement: `confirmed` needs a cross-family `supports`) stays in `db/drafts/r3b-outcome-independence` and ships with 0009.
- **Upgrade test** (`migrations-0015-0016.integration.test.ts`): from the production schema (0001–0007, 0011–0014; no 0008) with research
  data written by today's direct worker plus a duplicate evaluation, the real runner applies 0015 then 0016; every pre-existing table
  (evidence included) has the same data fingerprint after the upgrade, after rolling back 0016, after rolling back 0015 and after
  re-applying; each rollback restores exactly the previous catalog; re-applying gives exactly the upgraded catalog.

### Matrix after the fixes (compromised worker; D)

| scenario | before (`cbfb8e8`) | after |
|---|---|---|
| S1 delete records | P | P |
| S2 alter records or outputs | P | P |
| S3 tables outside its responsibilities | P | P |
| S4 injection / reads beyond the run | P | P |
| S4 cross-run blob / existence oracle | Pa | **P** (D4) |
| S5 authentication, authorisation, validation, replay and races | P | P (races now never 422/500) |
| S6 privileges / DDL | P | P |
| S7a forge the validator's verdict | V | **P** (D1) |
| S7b another generator's identity (analysis stage) | P, with free claim text under its own id | **P** (D3: the stage writes no hypothesis) |
| S7b′ Slither-stage leads | (not tested) | **Pa**: any claim text under `slither`; labelled worker-reported; judged only by the API's validators |
| S7c fake commit or content | V | **P** (D2) |
| S7d fake "complete" coverage | V | **P** (D3) |
| S8 another worker's run | P | P |
| S9 after cancellation or revocation | P | P (the worker exits 78 / 77, nothing written) |
| S10 secrets / reach | Pa (token in /proc environ) | **P** for the environment (D6); residual: process memory, file, Fly operators |
| S11 compromised owner / API | V | **V** (unchanged; out of scope, see above) |
| S12 recovery | P with a duplicate evaluation | **P** (no duplicate; D7) |
| D: `complete` stores arbitrary fields | Pa | **P** (D3) |
| D: `acquisition_report` free JSON | Pa | Pa (worker-reported, bounded by the body limit and the storage quota) |
| D: storage abuse | V | **P** (D4) |
| D: read volume / processing time | (not tested) | **P** (D4) |
| D: pool exhaustion by racing duplicates | V | **P** (D5) |
| D: burst from one token | Pa | Pa (served 3 at a time, operator latency bounded; the rate limit is in memory per process) |

### Remaining weaknesses, and whether they block the release

| weakness | blocking? | why |
|---|---|---|
| S11: the API's owner connection can disable triggers and rewrite evidence, delete audit rows and mint tokens | **no** for this release (it is today's system); **yes** for any claim that the evidence is tamper-proof | D moves no trust to the API that it did not already have. Needs the evidence hash chain with external checkpoints and a separate API runtime role. |
| S7b′: a compromised worker can invent Slither leads (the tool runs on the worker) | no, while the Slither stage is opt-in and labelled | leads are hypotheses, not findings; they are shown as worker-reported and judged only by the API's validators. Running Slither API-side would move tool execution into the API. |
| content-decided skips (binary, encoding) of non-Solidity files cannot be verified without the bytes | no | the analysis reads only `*.sol`, whose content skips are refused; recorded as `skips_unverified`. |
| a branch that moves between acquisition and seal is refused (permanent for that attempt) | no | fails closed; the operator re-queues or pins a commit. |
| the token is still in the worker's memory and in its file until unlinked; Fly operators and SSH can read it | no | bounded to one run, short-lived, revocable, quota-limited; Fly OIDC would remove the static secret. |
| the request rate limit is in memory per API process | no | the durable quotas (bytes, blobs, reads, processing) are in the database; one API machine today. |
| the API now starts a child process (its own analysis runner) | **owner decision** | needed for enforceable CPU limits; narrowly pinned by a build test. |
| independent reproduction: only the forge STAND-IN ran here; real pinned Foundry was not available (running a downloaded forge was not permitted in this environment) | no for D; **yes** before any claim that reproduction works | a real Foundry reproduction remains UNPROVEN. |
