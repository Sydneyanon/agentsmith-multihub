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
