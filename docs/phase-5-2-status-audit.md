# Phase 5.2 Repository Acquisition: status audit (2026-11-26)

Purpose: establish what is actually built, tested, deployed and still unverified before Phase 5.0 builds on it, so nothing is duplicated and nothing is claimed that was not shown. Method: re-read the code and design (`docs/repository-acquisition.md`), re-run the acquisition tests today, re-check where acquisition can be triggered, and compare with the 5.2 approval requirements. Self-audit by the author; the independent review of 2026-11-25 covered the SSRF client that acquisition now uses, not the acquisition module.

## Verdict
| Question | Answer |
|---|---|
| Is the module implemented? | **Yes.** `apps/api/src/acquisition/` (limits, errors, path rules, strict tar reader with bounded gunzip, hardened GitHub source, planner, orchestrator, workflow step handler; about 1,100 lines of source and 950 of tests plus fixtures). One additive method on `ResearchStore`, no migration, no new table. |
| Is it tested? | **Yes, locally.** Today: 262 unit tests in `acquisition/` and `net/` (7 files), 23 integration tests against a disposable Postgres, passing both as the owner and as the restricted runtime role; mutation harness 65/65 killed, 0 survived (run on the exact release-candidate code); full suite 619 unit + 197 integration. Real git repositories, loopback HTTP servers, crash injection. |
| Has it ever run against real GitHub? | **No.** No live acquisition has ever been made. `GitHubSource` is validated against servers imitating the documented API and strict `zod` response shapes; a mismatch fails closed (`unexpected_response`). It now also goes through the SSRF-pinned client (`net/safe-fetch`), which has also never met GitHub. |
| Is it deployed? | **The code ships in the Release 1 image, idle.** The production app has one `app` process and **no worker**; acquisition only runs inside a worker. |
| Can anything trigger it? | **No path exists.** `createRepositoryResearchRun` is called only by tests: there is no HTTP endpoint, CLI or discovery step that creates `repository_research` runs. (By design: 5.3 Discover was to create them; 5.0 below will.) |
| Is it merged? | No: it lives in draft PR #10 and the stack above it (nothing is on `main`). |
| Can I verify it live from this environment? | **No.** The development sandbox allows only specific hosts; `api.github.com` and `codeload.github.com` are not among them, and the SSRF client connects directly (it ignores the sandbox proxy). A real-shape check would need those two hosts allowed for a throw-away local run (owner decision, no production effect). |

## Requirements from the 5.2 approval, with evidence
| # | Requirement | Where it is met | Evidence | Gap |
|---|---|---|---|---|
| 1 | Resolve to an immutable commit SHA | `github-source.ts` resolves the ref once; everything after addresses the SHA; a 40-hex ref must match exactly | "moving ref resolved once", full-SHA verification tests | live API shape |
| 2 | Complete repository | planner accounts for every tree entry before any download; archive may contain nothing the tree lacks | `plan.test.ts`, tampered/missing/extra/swapped tests | repos over 20,000 entries are refused, not truncated |
| 3 | Provenance | commit, tree id, archive SHA-256, acquisition report on the snapshot | report tests, integration read-back | report is not covered by the seal hash (documented) |
| 4 | Content-addressed blobs and manifest in the existing 5.1 schema | `ResearchStore`; no migration | real-Postgres tests; database parity table of paths | none |
| 5 | Seal | seal only after the whole archive verifies; hash recomputed by the database | seal/short-circuit/refusal tests | none |
| 6 | Hostile input | strict streaming tar reader (traversal, links, devices, sparse, GNU long names, bad checksums, truncation, trailing data, non-UTF-8), nothing written to a filesystem | about 60 hostile-archive cases; mutation 65/65 | real-world archives from GitHub (live) |
| 7 | Never execute, install, run or build | no child process, no filesystem writes; content stored as text | design + build-output test forbids process spawning in the image | none |
| 8 | Size, count, path, archive limits | enforced while streaming; bounded gunzip; wall clock | bomb, oversize, many-small-entries, stall tests | memory about 322 MB peak on a 15,000-file synthetic repo vs a 512 MB machine |
| 9 | Symlinks, submodules, LFS explicit | recorded as inert data, never followed or fetched | dedicated tests | submodule/LFS recursion deferred (decision) |
| 10 | Idempotent retries | resume to the same snapshot and manifest; changed retry refused without writing | crash injection at three points | none |
| 11 | Failures leave no partial or misleading snapshot | nothing reaches the database before verification; partial sealing only by explicit option | failure-path integration tests | policy on partial snapshots feeding dossiers is open |
| T | No live third-party target, disposable loopback Postgres only | all tests | `net/outbound` scan, harness refusals | none |

## What 5.2 still needs before it is "done"
1. **A first live acquisition** against one small public repository to confirm the real GitHub response shapes through the real client (owner decision on the target and on hosts: `api.github.com`, `codeload.github.com`). A throw-away local run needs no production change.
2. **A way to create runs** (5.0 supplies it; see below).
3. **A worker in production**, which is not free of preconditions: (a) the Fly account is on a trial whose machines stop after 5 minutes, so a worker cannot run continuously until billing is resolved by the owner; (b) a worker would run as the database owner role (R1) until the least-privilege role rollout is approved and done; (c) memory headroom on a 512 MB machine is tight for large repositories.
4. **Owner decisions still open:** optional `GITHUB_TOKEN` (unauthenticated limit is 60 API requests per hour; an acquisition uses four), policy for partial snapshots, scoped acquisition for very large repositories.

## What Phase 5.0 should reuse (do not duplicate)
`createRepositoryResearchRun` and the `repository_research` workflow; the lease-based worker and `audit_events`; `resolveSourceReference` and the SSRF-pinned `outboundFetch` for every outbound request; the scope guard and the existing intake pipeline (`link_or_idea_intake`) for human-in-the-loop authorisation; the research API and dashboard for display.
