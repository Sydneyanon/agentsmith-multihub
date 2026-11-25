# Combined stack review of PRs #7-#17 (2026-11-25)

Scope: dependencies and lineage, migrations, HTTP routes, authentication, outbound network access, worker behaviour, production image, interactions between PRs, evidence quality, release plan, roadmap. **Limits of this review:** the author of PRs #10-#17 also performed it, so it is a self-review plus mechanical checks, not independent assurance. PRs #7-#9 (already deployed as `b5bc4b5` plus one docs commit) were checked for lineage, diff size, routes and migrations, not re-audited line by line. Nothing was deployed, merged, migrated or changed in production; no production network probe was made.

## 1. PR #10 reconciliation: a real GitHub-side sync failure, now cleared
| Observation | Value |
|---|---|
| Remote branch `claude/task5-2-repository-acquisition` (`git ls-remote`, and GitHub API `list_commits` on the branch) | `8e0121d` |
| `refs/pull/10/head` before | `a0c96e3` |
| `refs/pull/10/merge` before | `6ec427d`, parents `5dcf56e` (base) and `a0c96e3` |
| PR API before | head `a0c96e3`, 6 commits, 37 files, +3037; the PR's file list held the acquisition integration test at 308 added lines and no `research-state.test.ts`, i.e. the diff GitHub computed was for `a0c96e3` |
| Ancestry | `a0c96e3` is an ancestor of `8e0121d`; `8e0121d` is one commit ahead (two test files, +27 lines), committed 15:44:22Z, two minutes after `a0c96e3` (15:42:06Z) |
| Age of the inconsistency | the PR's `updated_at` was 15:45:41Z; still stale at 21:46Z (over 6 hours) |
| Other PRs | #11-#16, created later, all displayed their correct heads; #11's *base* showed `8e0121d`, so GitHub's branch ref was right and only PR #10's own head pointer was behind |

Conclusion: **not display lag.** The PR API, the PR refs and the computed diff and merge commit were mutually consistent at `a0c96e3`, and the branch ref was at `8e0121d`: GitHub never advanced the PR's head after the second push. The cause is not observable from here.

Remedy (no history change, no force-push, no close/reopen, no commit): an idempotent update of the PR's base to its *existing* value (`claude/hub-dashboard-alpha`). Within 20 seconds `refs/pull/10/head` was `8e0121d`; the PR API then reported head `8e0121d`, 7 commits, 38 files, +3064/-9, still draft, still `clean`. PR #10's description still quotes the counts from before the later work (451 unit tests); those are historical for that PR, the stack-level counts are in section 5.

## 2. Lineage and migrations
- Each PR's base is the previous PR's head and each branch contains the previous tip: #7 `a595729` > #8 `7c4f9ef` > #9 `5dcf56e` > #10 `8e0121d` > #11 `8f5cbdc` > #12 `fd60659` > #13 `1908c97` > #14 `32669e7` > #15 `746478e` > #16 `ad5ab5f` > #17 (this review's fix).
- The production release `hub-b5bc4b548c2e` is commit `b5bc4b5`, an ancestor of #9's head; `5dcf56e` is only a docs commit on top of it. The first release `dd28d27` is also an ancestor. The rollback target is intact and is **not** the PR #9 tip (a docs-only difference).
- `db/migrations` is byte-identical between the deployed `b5bc4b5` and the stack tip (seven migrations): **no migration is required.** `package-lock.json` and dependencies are unchanged.
- No tags exist for the deployed commits.

## 3. Interaction review
| Area | Check | Result |
|---|---|---|
| HTTP routes | Registered routes at `b5bc4b5` vs the stack tip | Identical: 22 routes (21 GET, one POST `/v1/intake`). No route added by any PR. |
| Authentication | `route-coverage.test.ts` walks every registered route | Public: only health, `/`, `/hub`, `/hub/`, `/hub/assets/<file>`; everything else 401 without a token; host guard still runs first (421 for other hosts, covered by the image smoke). |
| Lockout vs scanners | PR #13 + #12: unknown paths are now 401 and count as failed attempts; behind Fly the peer is a shared gateway, so scanner noise can fill the shared bucket | The valid token is never throttled, so the operator is never locked out; a mistyped token during noise can read `429` instead of `401`. Accepted, documented. |
| Outbound network | Any network call outside `net/` | None (scan test + manual grep). The one path that bypasses the guard (`unguardedFetchForLoopbackFixtures`) throws under `NODE_ENV=production`. |
| Real TLS path of the SSRF client | Local HTTPS server with a throwaway CA, name resolved to loopback | Valid certificate for the requested name: 200, `Host` is the original name; a certificate for a different name is rejected (`Hostname/IP does not match certificate's altnames`). So SNI and identity checks use the hostname, not the pinned IP. Not exercised against a live third party. |
| Worker | Not deployed; worker code unchanged by the fixes except outbound routing | The worker loop and acquisition integration tests pass as the restricted role. `worker-main.ts` does not run the role guard (documented). |
| Restricted role vs code | PR #14 grants vs all application SQL | 188 integration tests pass with the code under test connected as the runtime role. |
| Image | PR #15 build config vs PRs #14/#12 files | `dist/scripts/apply-runtime-grants.js` and `db/runtime-grants.json` are in the image and the script loads there (fails with its normal missing-env error, not a module error). Image smoke 31/31. |
| Secrets | Secret-pattern scan of the diff `b5bc4b5..tip` | None found. |
| Rollback | `scripts/rollback-rehearsal.sh` | 18/18 locally (see the release plan). Not rehearsed on Fly. |

### Findings
| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | **Regression introduced by PR #14:** `server.ts` awaited the role check *before* `listen`. In production an unreachable or paused database (Managed Postgres Developer auto-pauses) made `enforceRuntimeRole` throw, the process called `exit(1)`, and the app never started. The previous release booted without a database and reported readiness honestly. Reproduced: connection refused rejected in 11 ms. | High for release | **Fixed in PR #17** (test-first; check now runs after `listen`, is not awaited, retries, fails closed only when `HUB_REQUIRE_RESTRICTED_DB_ROLE=true`); 5/5 mutations killed. |
| F2 | `.github/workflows/ci.yml` runs only for pull requests targeting `main`; all stack PRs target other branches, so CI would not run on them even with billing fixed. It also does not run integration tests, the build-output test or the image smoke. The only recent run (#119, PR #1) failed in 2 s with no steps, so the cause (billing) is inferred, not shown by the API. | Medium | Open (needs a workflow change and billing). |
| F3 | The Fly documentation host was not resolvable from this session, so Fly proxy behaviour and Managed Postgres role capabilities could not be re-read. | Medium | Open; see section 6. |
| F4 | Shared throttling bucket behind Fly (above). | Low | Accepted. |
| F5 | PR #10's description quotes superseded counts. | Low | Leave (historical); stack counts below. |

## 4. Reconciliation of test evidence
Evidence "pre-squash" means it ran on the identical tree immediately before the branch's work-in-progress commits were squashed into the single pushed commit; it was not re-run on the squashed SHA. The final column is the re-run on the exact stack tip (section 5), which supersedes all of them.

| PR | Verification on the pushed commit | Mutation evidence originally |
|---|---|---|
| #11 SSRF | pre-squash (docs commit added after) | 31/31 pre-squash |
| #12 auth | pre-squash | 7/7 **re-run on the pushed commit `fd60659`** |
| #13 lockout | pre-squash | 9/9 **re-run on the pushed commit `1908c97`** |
| #14 roles | pre-squash | 11/11 pre-squash |
| #15 image | **full verify and image smoke re-run on the pushed commit `746478e`** | 12/12 pre-squash |
| #16 docs | pre-squash | 7/7 pre-squash |
| #17 guard | run on the commit before this document was added | 5/5 on the same tree |

Environmental vs genuine failures during the session: the local Postgres cluster stopped twice, producing connection-refused failures in the integration suites; those runs were **discarded**, the database was restarted and the suites re-run (never counted as passes). One genuine failure was found and fixed during PR #12 (an integration assertion that encoded the old 404 behaviour) and one during PR #13 (a smoke assertion that encoded the old lockout). In this review's runs there were no environmental failures: the database was confirmed reachable before and after (`select 1`).

## 5. Verification on the exact stack tip `ad5ab5f` (PR #16), clean tree, Postgres 16.15 confirmed reachable
| Suite | Result |
|---|---|
| `npm run verify` | lockfile, typecheck, tests, build, integration, restricted integration: all PASS |
| Unit (`npm test`, integration files excluded) | 578 passed / 33 files, 0 skipped, 0 failed |
| Integration (`REQUIRE_INTEGRATION=1`, a missing database fails rather than skips) | 188 passed / 9 files |
| Integration as the restricted runtime role | 188 passed / 9 files |
| Browser layout (Playwright/Chromium, 6 viewports x 11 screens) | 221 checks PASS |
| Image build + chroot smoke (Docker-less) | 31 passed, 0 failed (diff_id `c7b22139...`) |
| Mutation: SSRF 31, auth 7, lockout/proxy 9, db roles 11, image 12, docs 7 | all killed (baselines 131, 53, 72, 29, 9, 10 tests) |
| Mutation: acquisition harness (65) | see PR #17's description (long run; recorded there) |

The same suites are re-run on the final tip (the commit that contains PR #17 and this document); its numbers are in PR #17's description.

## 6. Production-verification gaps
**Real Docker build.** Not possible here (no container runtime, no reachable remote builder). The Docker-less path reproduces the Dockerfile stages onto the pinned base digest and runs the production smoke test in a chroot, which verified contents, non-root, TLS-verified DB connection, headers, auth and startup, but not the Dockerfile's own layering, a container runtime's behaviour, or the Fly machine. Safe options, none touching production: (a) a Docker host or CI runner the owner controls running `docker build` and the same smoke; (b) Fly's remote builder with `--build-only`, which uses a Fly resource and needs approval; (c) accept the Docker-less route with its stated differences for release 1. The two earlier releases were built this way and run correctly in production.

**Independent CI.** Blocked by GitHub Actions billing (inferred) and by the trigger (F2). Needed: billing restored, `pull_request` for all base branches (or a `workflow_dispatch`), a Postgres service for the integration runs, and the build-output test and mutation specs as steps. Until then every result is a local run by the author.

**Fly proxy topology and database roles.** The Fly docs host did not resolve from this session, so nothing new could be read. Known: `X-Forwarded-For` was spoofable in production (single observation); socket-peer range and `Fly-Client-IP` overwrite semantics are unverified; whether the Managed Postgres user can `CREATE ROLE`, the server version and the default user's attributes are unverified (local tests use PostgreSQL 16). Safe ways to close each, all needing approval because they touch production or the session's network allow-list: allow the Fly docs host for this session (read-only documentation); after release 1, read the logged socket peers (no change); a single read-only statement as the app user: `select rolname, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user; show server_version;` and `select has_database_privilege(current_user, current_database(), 'CREATE');` (read-only, but a production database connection).

**Is egress filtering required before 5.3?** Application-layer controls now cover the main risks: every outbound request passes one client that resolves once, requires all answers to be public, pins the connection, verifies the peer, revalidates each redirect, allows only HTTPS/443, and refuses all non-global-unicast IPv6 (which includes Fly's private `fdaa::/16`) and every IPv4 special-use range (including `172.16.0.0/12`), with `.internal` names refused; a test forbids other network paths. What remains is defence in depth against a bug in that code or a future code path that bypasses it, and the fact that Task 5.2 fetched only two allow-listed GitHub hosts while 5.3 will fetch **arbitrary** hosts for the first time. Assessment: egress filtering is **not a prerequisite to implementing and testing 5.3 locally**, but it should be a **decision gate before 5.3 is enabled in production**: either a network-level control (if Fly offers one; unverified here), or the owner's explicit acceptance of application-layer-only protection, plus a real-network test of the client against GitHub first. Also run the worker as its own machine with no inbound service and only the restricted database role.

## 7. Release plan review
- Commits: the chain in section 2; the release candidate is the tip of PR #17 once the owner approves the stack; the final commit must be re-verified and recorded.
- Migrations: none (verified by diff against the deployed commit, section 2).
- Restricted database role: reviewed separately in `docs/db-roles.md`; rollout is four separately approved stages; the code release works with either role (rehearsed 18/18), and F1 had to be fixed for that to hold in production.
- Rollback: previous release `hub-b5bc4b548c2e`, digest `sha256:69978a78...`, is `b5bc4b5` (lineage intact); procedure rehearsed locally only.
- External actions and costs: image push to Fly's registry (`FLY_API_TOKEN`, storage only), `fly deploy` (replaces the existing Machine image; no new billable resource; about $7.69 per month list price for app and database, not re-verified); read-only production checks. Role stages 2-4 add a database role and a secret (no direct cost). Nothing in release 1 enables a worker, model usage, a GitHub token or DNS change.
- Idle and Hunt: single `app` group, no worker, no `GITHUB_TOKEN`, no gateway; a queued intake stays queued. Hunt is only read by one GET in the post-deploy check.

## 8. Roadmap verification
`docs/research-intelligence-plan.md` on the PR #16 branch contains section 9 (5.4B Automated Security Toolchain, 5.5A Weirdness Engine, Adaptive Research Priority Engine, 5.9 Live Engine Control Room) and section 10 (dated decision log); the stale-document corrections (`fly.toml`, `fly.hub.toml`, production plan, retirement audit, Hunt doc, README, runtime doc) are in the same commit and guarded by `docs-canonical.test.ts` (10 tests, 7/7 mutations killed). **They are committed to the PR branch only: `origin/main` (`b50ff6f`) contains none of them, so the roadmap is not canonical on `main` until the stack is reviewed and merged.**
