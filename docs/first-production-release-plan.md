# First controlled production release of the secure foundation (RELEASE 1 DEPLOYED 2026-11-26; sections 0-9 are the plan, section 10 the record)

Status as of 2026-11-26: **Release 1 was deployed on 2026-11-26** with the owner's explicit approval of the exact image digest (record in section 10). Sections 0-9 are the plan as approved and are kept as written; where they say "pending" or "not executed", section 10 supersedes them. No PR is merged; no production migration, secret, role, credential or DNS change was made; `hunt.agentsmithdesk.xyz` was only read.

Goal: put the reviewed security fixes (review findings 1-5) and the foundation PRs they sit on into production at `https://hub.agentsmithdesk.xyz`, with the research engine **idle**, preserving production data, with a tested rollback. Task 5.3 is not part of this and is not required.

## 0. Release checklist (record to be completed; every PENDING item blocks the release)
Owner decisions 2026-11-25: independent review, official Fly documentation, CI correction and a genuine Docker build are approved as *work*; deployment, merge, production migration, DNS and role/credential changes are **not** approved.

| # | Item | Status / value |
|---|---|---|
| 1 | **Exact release commit** | **FROZEN as a release candidate, not approved:** `7eed70f6c7f304bb9df5bc213783b588a1b6b7bc` (head of PR #19 `claude/independent-review-fixes`). Verified locally on exactly this commit (item 5). Any later commit makes it a different candidate. Docs-only commits recording results may follow it; they do not change the code or the build context. |
| 2 | **Exact image digest** | **PRODUCED (Docker-less build, see 5d):** `registry.fly.io/agentsmith-hub@sha256:c0eaf87d35e26af4bae688e9209959f263fb92d6a6d623901bb87f706048f577` (tag `rc-7eed70f6c7f3`, pushed 2026-11-26 03:48Z, amd64/linux). Deploy by this digest, never by tag. |
| 3 | **Genuine Docker build** | **NOT PERFORMED; owner accepted the Docker-less artifact for Release 1 (2026-11-26).** The image was assembled by `scripts/hub-image.sh` (hand-reproduced Dockerfile stages onto the pinned base), not built from the Dockerfile by a real builder. The permanent genuine-build pipeline will be set up when a build route is available (GitHub Actions is not usable on this account). |
| 4 | **CI** | **NOT USED, not a gate (owner decision 2026-11-25: GitHub Actions will not work for this account).** The basis for release 1 is local verification on the exact release commit (item 5) plus the genuine Docker build (item 3). PR #18 (workflow correction) is optional and may be closed unmerged; recorded for the facts only: runs 120-123 were triggered and ended in 2-5 s with no steps or logs. Accepted residual risk: no independent execution of the tests. |
| 5 | **Local verification of the release commit** | On `7eed70f` (clean tree, Postgres 16.15 confirmed reachable before and after): `npm run verify` six steps PASS; unit **619** / 35 files; integration **197** / 10 files; restricted-role integration **197** / 10 files; browser layout **221**; Docker-less image smoke **31/31** (layer diff_id `cf4f0598...`, local only); docs mutation spec 7/7. A first run of the same commit failed entirely because the local Postgres had stopped (connection refused, an environmental failure, discarded and re-run after restart). Code mutation specs (SSRF 31, auth 7, lockout 9, roles 11, image 12, guard 5, CI 12, review fixes 24, acquisition 65) were run on `5e4fb82`; `7eed70f` differs from it only in `hub-image-smoke.sh` and docs. |
| 6 | **Authentication verification (post-deploy)** | `/v1/*` 401 without token; unauthenticated malformed JSON to `/v1/intake` 401 (not 400/413); valid token 200 immediately after a burst of wrong tokens (never 429); other Host 421; token absent from logs. All scripted in section 6 and mirrored in the CI `image` job. |
| 7 | **Database verification (post-deploy)** | `/health/ready` 200; `schema_migrations` still exactly seven checksummed rows (no migration runs); row counts unchanged from the pre-deploy snapshot; no role, grant or credential change; startup log shows the expected non-restricted-role warning. |
| 8 | **Rollback target and procedure** | Previous release `registry.fly.io/agentsmith-hub:hub-b5bc4b548c2e`, digest `sha256:69978a782c724de2ef37a974aeb32cf909ac968d6de3e8fdc5e5aa07f28e02a8` (commit `b5bc4b5`); procedure in section 8; rehearsed locally 18/18, **not on Fly**. Re-read the live release at deploy time. |
| 9 | **Known residual risks** | See section 0a. |

### 0a. Residual risks accepted for release 1 (explicit)
1. **R1, production database role: the app keeps running as the table owner `schema_admin`. ACCEPTED TEMPORARILY by the owner for Release 1 on 2026-11-26.** A compromise of the application could disable the append-only triggers, rewrite or delete research data, or drop tables (review finding 4). PR #14 builds the least-privilege role, but it is **not applied** and no production role or credential is changed. Accepting this means: the engine stays idle so it produces no research data (production data is never seeded; the pre-deploy counts in item 7 show what exists), the exposed surface is the authenticated API only, and the role rollout follows as a separate approval. The startup log will warn about it every boot.
2. R2: the SSRF client has never contacted a real third party and has known should-fix items from independent review (signal not honoured during DNS, no own handshake timeout). Not reachable in release 1: no worker, no code path fetches a URL.
3. R3: all verification is local; CI has not run; no genuine Docker build yet.
4. R4: Fly proxy peer range and `Fly-Client-IP` semantics: docs say the header is the client IP "from the perspective of Fly Proxy" and call `X-Forwarded-For` spoofable; the app trusts neither by default. Throttling is per shared peer until configured.
5. R5: single machine, no HA, database auto-pauses after 15 minutes without connections (Developer plan: no PgBouncer, 20 connections).
6. R6: Fly builders and registry storage are documented as free today, with a stated possibility of future charges.

## 1. What would be released
Source of truth is the stacked draft PRs. Tips at the time of writing (each tip was verified by `npm run verify` incl. both integration runs and by its mutation spec on the identical tree **immediately before squashing**, not re-run on the squashed SHA except where `docs/stack-review-2026-11-25.md` section 4 says so; the full suite was re-run on the stack tips recorded there; the **final** release commit must be re-verified and recorded in checklist item 1):

| Layer | PR | Branch | Tip |
|---|---|---|---|
| Foundation: hub UI + API alpha (5.1 research state, ...) | #7-#9 | `claude/hub-dashboard-alpha` and ancestors | already reviewed earlier; **the currently deployed code is `b5bc4b5`** |
| Acquisition 5.2 (engine code, idle without a worker) | #10 | `claude/task5-2-repository-acquisition` | `8e0121d` (GitHub's PR head was stuck at `a0c96e3` for hours; **reconciled** by an idempotent PR update, see `docs/stack-review-2026-11-25.md` section 1) |
| 1. SSRF-safe outbound requests | #11 | `claude/fix-ssrf-source-url-validator` | `8f5cbdc` |
| 2. Auth before body parsing, default-deny | #12 | `claude/fix-auth-before-body-parsing` | `fd60659` |
| 3. No lockout of the operator, no spoofable proxy trust | #13 | `claude/fix-lockout-and-proxy-trust` | `1908c97` |
| 4. Least-privilege runtime DB role (grants manifest, startup guard) | #14 | `claude/fix-db-least-privilege` | `32669e7` |
| 5. Image without tests/dev code | #15 | `claude/fix-production-image-minimisation` | `746478e` |
| Docs, roadmap, this plan | #16 | `claude/docs-roadmap-and-release-plan` | `ad5ab5f` |
| 6. Startup role guard must not block boot on a database outage (found by the stack review) | #17 | `claude/fix-startup-guard-db-outage` | `91806bc` |
| CI: all stacked PRs, disposable-Postgres integration, genuine Docker build job | #18 | `claude/ci-stacked-prs-and-docker-build` | `e9c25cd` (its first CI run failed to start, see checklist item 4) |
| 7. Fixes from the independent review (temp-schema shadowing blocker, SSRF timeouts/seams, token quality, image test gaps, docs) | #19 | `claude/independent-review-fixes` | head of PR #19; **this is the current release-candidate tip** (not yet approved) |

Release candidate = the tip of the last PR in the chain after the owner's combined stack review. No merge is needed to build it (the image is built from a commit), but the owner decides whether the stack is merged first.

**Idle engine:** the deployment keeps the single `app` process group (no `worker`). `/v1/intake` can still queue workflow runs, which stay `queued` with no worker to claim them. Acquisition code is present but cannot run. No `GITHUB_TOKEN`, no model/gateway configuration, no new secrets. (A queued intake is harmless but visible; the operator should avoid submitting links until a worker is approved.)

## 2. Migrations
**None.** `db/migrations` still holds `0001`-`0007`, identical to what production already applied. PR #14 adds `db/runtime-grants.json` and a grants script, which are not migrations. Pre-flight (read-only, **[approval]** because it touches the production DB): confirm `schema_migrations` has exactly the seven checksummed rows. If it does not, stop.

## 3. Permissions and configuration
| Item | Release 1 (this plan) | Later, separately approved |
|---|---|---|
| `DATABASE_URL` | unchanged (`schema_admin`); the server logs a startup warning that the role is not least-privilege (expected) | switch to the runtime role (`docs/db-roles.md` steps 1-4) |
| New secrets | none | runtime role password (generated, never printed) |
| `HUB_REQUIRE_RESTRICTED_DB_ROLE` | unset (false) | `true` after the switch |
| `HUB_TRUSTED_PROXY_CIDRS` | unset: trust nothing; throttling keyed by the socket peer | set only after the real peer range is read from logs (`docs/fly-proxy-topology.md`) |
| DB role creation | **not done**; whether the Fly MPG user may `CREATE ROLE` is **unknown** | needed for stage 2 |
| `fly.hub.toml` | unchanged | unchanged |

Staged DB-role rollout (each stage separately approved, each reversible): (1) release the code; (2) create the role and apply grants; (3) switch `DATABASE_URL` and redeploy; (4) require the restricted role. Releasing the code first is safe because the new code works with either role (proved by the rehearsal below). The startup role check runs only after the server is listening (PR #17); the earlier version (PR #14) ran it before `listen` and would have made an unreachable or paused database stop the server booting.

## 4. Costs
No new billable resource. Same single `app` Machine (shared-cpu-1x, 512 MB, `auto_stop_machines` on), same Managed Postgres Developer cluster, free shared IPv4/IPv6, one certificate. List prices recorded in `docs/hub-production-plan.md` section 2 (about $7.69/month for app + database; **list prices as of that doc, not re-verified in this pass**). A deploy replaces the Machine's image; the build is done locally with `crane`, no paid builder. The retained previous image costs registry storage only (not itemised by Fly in the references reviewed).

## 5. Build, verify, deploy (not executed)
Preconditions: owner has completed the combined stack review; PR #10 display reconciled; release commit chosen, working tree clean, `npm run verify` green on that exact commit with `TEST_DATABASE_URL` set (both integration runs), all mutation specs killed on it; no secrets in the diff.

1. **[approval]** Build on the release commit: `scripts/hub-image.sh build` then `verify` (chroot smoke, 31 checks incl. no tests/dev code in the image, non-root, verified DB TLS, 401/200/421, CSP/HSTS, lockout semantics). Record the commit, `diff_id`, and base digest `sha256:12f54caf...`. A real `docker build` is preferred if a Docker host or Fly remote builder becomes available; the Docker-less path is **not** equivalent to a real build and must be reported as such.
2. **[approval]** Push: `scripts/hub-image.sh push` (needs `FLY_API_TOKEN`; never printed) to `registry.fly.io/agentsmith-hub:hub-<12 hex>`; record the pushed digest and confirm it matches the tested layer.
3. **[approval]** Record the rollback target before touching anything: current image `registry.fly.io/agentsmith-hub:hub-b5bc4b548c2e`, digest `sha256:69978a782c724de2ef37a974aeb32cf909ac968d6de3e8fdc5e5aa07f28e02a8` (from `docs/hub-production-plan.md` section 12; re-read from `fly status`/`fly releases` at release time).
4. **[approval]** `fly deploy --config fly.hub.toml --app agentsmith-hub --image <new ref> --ha=false`. Explicit `--app`; never `fly.toml`.

### 5a. Options for a genuine Docker build (researched 2026-11-25; nothing run, nothing billed)
Sources: Fly docs read from `docs.fly.io` (`flyctl/cmd/fly_deploy`, `about/pricing`, `reference/builders`); GitHub facts are from general knowledge and **not verified in this session**.

| Option | What it does | Cost | Limits / needs approval |
|---|---|---|---|
| A. GitHub Actions `image` job (PR #18) | `docker build` of the repository Dockerfile on a hosted runner, content checks, production-mode container probe. Produces a runner-local image id, not a registry digest, and publishes nothing. | Repository is public; hosted standard runners are documented as free for public repositories (unverified here). No billing change made. | **Currently blocked: the first run failed to start** (checklist item 4). The owner must read the run annotation / billing page. |
| B. Fly remote builder, build only | `fly deploy --build-only --push --image-label <label> --app agentsmith-hub --config fly.hub.toml` (all flags in the flyctl docs: `--build-only` "Build but do not deploy", `--push` "Push image to registry after build is complete", `--remote-only` is the default, Depot is the default builder). Prints the pushed image reference and digest; it deploys nothing. | Docs: "App builders and registry image storage: No charge ... currently free", with a warning that charges may start in future with notice. The docs do **not** say whether a builder app/Machine appears in the organisation. | Pushes an image into the production app's registry namespace (no deploy), uses `FLY_API_TOKEN`: **needs owner approval.** Gives the registry digest that item 2 requires. |
| C. A Docker host the owner controls | `docker build`, then push with crane/docker. | Owner's own machine. | The owner has said no such machine is available. |
| D. Docker-less layer build (current) | Hand-assembled layer on the pinned base; chroot smoke test. | None. | Not a genuine build (documented differences); used for the two existing releases. |

Recommendation: use A for repeatable evidence once Actions runs, and B (after approval) to produce the exact release image and its registry digest; deploy only with `--image registry.fly.io/agentsmith-hub@sha256:<that digest>`. Until B or A succeeds, item 3 stays PENDING.

### 5b. Platform facts read from the official Fly docs (2026-11-25)
- `Fly-Client-IP`: "The IP address of the client from the perspective of Fly Proxy" (not stated whether a client-supplied value is overwritten). `X-Forwarded-For`: a list whose rightmost entry is the app's own shared or dedicated IP; "must be treated with caution to avoid spoofing". No fixed peer address range is documented. The design (trust nothing by default, `Fly-Client-IP` only from configured CIDRs) is consistent with this; the range must still be read from logs after an approved deploy.
- Managed Postgres: PostgreSQL 16, 17 and 18 are supported (default 17); users are created with `fly mpg users create --role schema_admin|writer|reader` (also in the Machines API: create-user, update-user-role). **The privileges behind each role are not documented**, and the default user is `fly-user`. So a least-privilege runtime login should be created through this supported mechanism, and whether `writer`/`reader` users satisfy the PR #14 checks (no membership in provider group roles, no ownership) must be tested before the rollout. The runbook assumed `CREATE ROLE` by SQL; that is now the fallback, not the plan.
- Developer plan: $4 per 30 days incl. storage; no PgBouncer; 20 direct connections shared by all clients; auto-pause after 15 minutes with no client connections, waking on the next connection (this is why the startup role check must not block boot). Pool max is 5 in the app.
- Egress: the docs describe static egress IPs (`fly ips allocate-egress`, extra cost, per region) for allow-listing; **no outbound firewall or egress allow-list for Machines is documented**. Egress filtering would therefore have to be application-level on Fly (as implemented) unless Fly adds a control.
- Builders: see option B.

### 5c. Fly build-only attempt (owner-approved 2026-11-25; failed; evidence)
Command (from a clean `git archive` export of `7eed70f`, not a branch): `fly deploy --build-only --push --image-label rc-7eed70f6c7f3 --app agentsmith-hub --config fly.hub.toml --remote-only`, flyctl v0.5.17. Run twice (the second with `SSL_CERT_FILE` explicitly set to the session CA bundle, verification never disabled). Both failed at the same point, before any build: `connecting to Depot builder ... failed to list workers: Unavailable ... authentication handshake failed: tls: failed to verify certificate: x509: certificate signed by unknown authority`.
- **Cause (inferred):** flyctl reaches the Depot builder with a direct gRPC/TLS connection; this development environment forces outbound HTTPS through a TLS-intercepting proxy whose documentation lists gRPC and non-443 TLS as unsupported ("report, do not work around"). It is a limit of this environment, not of Fly or of the repository.
- **Nothing changed (read-only checks before and after):** one machine `2870320f99dd68`, state `stopped`, image `hub-b5bc4b548c2e`, last update `2026-11-25T23:26:56Z` both times; app version 2; releases 2 and 2; only app in the org `agentsmith-hub`; registry tags `hub-b5bc4b548c2e`, `hub-dd28d27ed085` (no `rc-` tag was pushed).
- A local Docker daemon **can** run in this sandbox (dockerd 29.9.3, overlay2) and pulled `node:22-alpine` (today's tag resolves to `sha256:1314fb30...`, not the `sha256:12f54caf...` used for both production releases). A genuine `docker build` of the **unmodified** Dockerfile still cannot pass `npm ci` here, because build containers do not trust the intercepting proxy's CA; trusting it would require changing the Dockerfile or the base image, so the result would not be the release image. I did not do that.
- **Remaining options** (each needs a decision): (1) the owner runs the same single command from any machine with unrestricted internet and a flyctl login, then pastes the printed digest here for recording; (2) the owner allows unrestricted network access for this session only (an environment setting, not a production one) and the command is retried unchanged; (3) accept the Docker-less layer build used for both earlier releases, with its documented differences, as the release artifact (not a genuine build); (4) Fly's legacy builder (`--depot=false`) creates a builder app/Machine in the organisation: a billable resource, not approved, and likely blocked here too.

**Third attempt, with unrestricted network (owner-approved for this session only, 2026-11-26).** The environment's network was switched to unrestricted, the identical command was run once from a fresh `git archive` export of `7eed70f` (the filtering was confirmed gone: `example.com` answered 200), and it failed with **exactly the same error** at the same step (`connecting to Depot builder ... x509: certificate signed by unknown authority`). So the interception is not about the allowlist; flyctl's builder connection is still being intercepted by the session's proxy, and I did not unset the proxy or disable verification (the proxy documentation forbids both). The environment was **reverted immediately** to the exact saved allowlist (18 hosts, package managers and MCP allowed); `example.com` is blocked again. Nothing was built or pushed. Read-only check afterwards: app version 2, releases 2, image on the machine still `hub-b5bc4b548c2e`, registry tags unchanged (no `rc-` tag). **One difference to note:** the machine's state read `started` with `updated_at 2026-11-26T01:21:47Z` (it was `stopped`, `2026-11-25T23:26:56Z`). The app has `auto_start_machines`, so a request to the hub (a visitor or scanner; none was made by this work) wakes it; image, version and release count did not change, so this is a wake, not a deployment.
Remaining routes for a genuine build: only (1) the owner's or someone's machine with normal internet, or a different hosted shell with Fly login; or the Docker-less artifact (option 3). Fly's builder cannot be reached from this environment.

**Packaged external run.** `scripts/release-build-external.sh` performs the one build-only run from any trusted shell with normal internet and a Fly login: it clones the repository, checks out and **refuses anything but** `7eed70f6c7f304bb9df5bc213783b588a1b6b7bc`, exports it with `git archive`, snapshots production read-only, runs exactly the approved command, reads the pushed digest from the registry, snapshots production again, and prints a block to paste back. It never deploys, edits the Dockerfile, uses the legacy builder or touches TLS settings; it takes no token as an argument (`fly auth login`). It was dry-run here against the real commit (checkout verified, 197 files, production snapshots read and compared; the machine had returned to `stopped` by then). The digest-reading call was validated against the existing `hub-b5bc4b548c2e` tag (the same digest `crane` reports). After the paste-back I will (1) record the digest in checklist item 2, (2) pull the image from the registry and compare every file under `/app/dist` and `/app/db` byte-for-byte with a build of the same commit made here, and (3) re-check production read-only.

### 5d. Release-candidate image (owner-authorised Docker-less build, 2026-11-26)
Built from a detached worktree at exactly `7eed70f6c7f304bb9df5bc213783b588a1b6b7bc` (tracked tree clean) with `scripts/hub-image.sh build|verify|push` and `HUB_IMAGE_TAG=rc-7eed70f6c7f3`.
- **Registry digest:** `sha256:c0eaf87d35e26af4bae688e9209959f263fb92d6a6d623901bb87f706048f577` (manifest 1646 bytes); the tag resolves to it when read back.
- **Pinned base:** `node:22-alpine` linux/amd64 manifest `sha256:12f54cafa58d0e96554ae05871e29663ff7241836377dc9a7916449b8adb062c`, the same base as both earlier releases. Read back: the first 4 layers of the pushed image equal that base's 4 layers exactly; config labels carry `org.opencontainers.image.revision=7eed70f6...` and `org.opencontainers.image.base.digest=sha256:12f54caf...`.
- **Deterministic layer:** the application layer's uncompressed diff_id is `sha256:cf4f059891e58a927be7fd38cf82cddaa0cad83254885a60912a97462f754d44` on four separate builds of this commit (including the build that was pushed); the pushed 5th layer's compressed digest `sha256:2938fe599d13...` equals the local `app.tar.gz`, and the config's last diff_id equals the tested diff_id. Image config: amd64, linux, user `node`, workdir `/app`, `NODE_ENV=production`, cmd `npm start`, entrypoint `docker-entrypoint.sh`, port 8080 (10 push-time checks pass).
- **Tested == pushed:** the image was pulled back **by digest**, exported, and `scripts/hub-image-smoke.sh` run on that filesystem: **31 passed, 0 failed** (Node v22.23.5, non-root, verified database TLS with a throw-away CA, 401/421/429, valid token not locked out, CSP/HSTS, no tests/dev code in the image). Every one of the 2928 files under `/app` is byte-identical (sha256 manifest) to the locally tested layer.
- **Production before and after (read-only):** app version 2, one machine `2870320f99dd68` (`stopped`), image `hub-b5bc4b548c2e`, 2 releases, both times. Registry: the two existing tags keep their digests (`hub-b5bc4b548c2e` = `sha256:69978a78...`, `hub-dd28d27ed085` = `sha256:2c526ac1...`); the only change is the new tag `rc-7eed70f6c7f3`. Nothing deployed, restarted, or changed (no secret, database, DNS or machine change).
- **What this is not:** not a genuine Dockerfile build. The Dockerfile's COPY/ignore/layer semantics and `npm ci` inside Alpine were reproduced by hand (`npm ci` ran on the host's glibc Node; no native modules). Fly runtime behaviour is untested until a deployment.

## 6. Post-deploy verification (read-only; each result recorded)
1. `fly status`: one Machine started, health check passing, image digest equals the pushed digest.
2. `https://hub.agentsmithdesk.xyz/health/live` 200 and `/health/ready` 200 (database reachable; allow up to 30 s if the cluster wakes).
3. DNS resolves the three existing records; TLS 1.3, certificate hostname-matching and unexpired.
4. `/` 302 to `/hub/` with no body; `/hub/` 200 with CSP strict, HSTS without `includeSubDomains`, nosniff, no-referrer.
5. Authentication: `/v1/research/overview` 401 without a token; **401 (not 400/413) for an unauthenticated malformed-JSON POST to `/v1/intake`**; 200 with the token; a wrong-token burst yields 429 for wrong tokens **and the valid token still returns 200 immediately after**.
6. Other Hosts and `agentsmith-hub.fly.dev` answer 421.
7. Database: dashboard shows the pre-existing data unchanged (counts compared with a pre-deploy snapshot taken in step 0 of this list).
8. Logs: no token or URL secrets; startup warning about the non-restricted DB role present (expected in release 1); note the logged `remoteAddress` values, which are now real socket peers (input for `HUB_TRUSTED_PROXY_CIDRS`).
9. Browser/iPhone check of the dashboard (owner) using `docs/hub-production-plan.md` section 9.
10. Hunt unaffected: `hunt.agentsmithdesk.xyz` still answers as before (one read-only GET; no change made).
11. Resource check: still one Machine, no worker, no new volume/database/IP; no model usage.

Stop conditions: any failed step above, a new migration appearing, unexpected 5xx, or any DB error: roll back (section 8) and report; do not retry blindly.

## 7. Open items that block the release decision
- ~~PR #10 display discrepancy~~ **Resolved 2026-11-25**: GitHub's PR #10 head ref was stale (`a0c96e3`, hours after the branch moved to `8e0121d`); an idempotent update of the PR's base to its existing value made GitHub re-sync (`refs/pull/10/head` now `8e0121d`). No history change. See `docs/stack-review-2026-11-25.md`.
- ~~CI~~ **Not a gate** (owner decision: GitHub Actions will not work for this account). Evidence is local; accepted.
- No independent execution of the tests exists (accepted, see checklist item 4).
- **Real Docker build never performed** (Docker-less equivalent only).
- Unverified: Fly MPG PostgreSQL version and `CREATE ROLE` ability; Fly peer range; `Fly-Client-IP` overwrite semantics; real GitHub response path of the new SSRF client; network egress filtering.
- Deployed commits are not tagged in git. Recommended (owner-approved, no history change): lightweight tags for `b5bc4b5` (current) and the release commit.
- Combined stack review not yet held; no PR merged.

## 8. Rollback
Trigger: any stop condition in section 6, or the owner's call. Procedure **[approval]**:
1. `fly deploy --config fly.hub.toml --app agentsmith-hub --image registry.fly.io/agentsmith-hub:hub-b5bc4b548c2e --ha=false` (pin by digest if the tag is not trusted).
2. Repeat verification steps 1-7 of section 6 against the old build (note the old build has the old behaviours: valid token can be locked out, `/v1` unknown paths 404).
3. No database action: this release has no migration, so there is nothing to undo. Secrets are unchanged by release 1; if stage 3 of the role rollout was applied, also restore the previous `DATABASE_URL` secret (kept until stage 4 is accepted).

**Rehearsed locally** (`scripts/rollback-rehearsal.sh`, disposable loopback database, 18 of 18 checks passed on 2026-11-25): a database migrated by the new code with the runtime role restricted was served by (a) the new build as the restricted role, (b) the previous release `b5bc4b5` as the restricted role, (c) `b5bc4b5` as the owner role (rolling `DATABASE_URL` back too). Each served readiness, the dashboard, 401 without / 200 with the token, accepted an intake and listed workflows including those written by the other build. **What this does not prove**: behaviour on Fly, on Fly Managed Postgres, or through Fly's proxy; it does not rehearse `fly deploy` itself.

## 9. Not part of release 1
Worker process, `GITHUB_TOKEN`, model gateway, Task 5.3, DNS changes, token rotation, `HUB_TRUSTED_PROXY_CIDRS`, runtime DB role stages 2-4, merging PRs.

## 10. Release 1 deployment record (2026-11-26)
**Approved and deployed:** commit `7eed70f6c7f304bb9df5bc213783b588a1b6b7bc`, image `registry.fly.io/agentsmith-hub@sha256:c0eaf87d35e26af4bae688e9209959f263fb92d6a6d623901bb87f706048f577` (tag `rc-7eed70f6c7f3`, Docker-less build, not a genuine Dockerfile build; see 5d). Command (exactly as approved): `fly deploy --config fly.hub.toml --app agentsmith-hub --image registry.fly.io/agentsmith-hub@sha256:c0eaf87d... --ha=false`, started 03:57:56Z, machine update succeeded and healthy at 03:58:15Z (about 20 s). Fly release **3**, id `B4kyPlJaaLqkxH0vR4x3nOja5`, status complete; app version 3, status `deployed`; one machine `2870320f99dd68`, region `syd`, health check `servicecheck-00-http-8080` passing.

**Pre-deployment checks (all passed):** the tag resolved to the approved digest; app was `agentsmith-hub`; state captured (version 2, release 2 id `1RNM1g3ppxjNQH98b6QbNleM`, image `hub-b5bc4b548c2e`); the rollback image `sha256:69978a78...` is present in the registry; no migration differences between the deployed and the candidate commit and no non-comment difference in `fly.hub.toml`; the production `API_BEARER_TOKEN` passes the new startup validation (checked **inside the machine, printing only pass/fail**; the token was never read out, printed or stored).

**Post-deployment verification (unauthenticated, from the development environment):**
| Check | Result |
|---|---|
| Fly reports the exact approved digest | PASS |
| Machine started and health check passing | PASS |
| `/health/live` 200 | PASS |
| `/health/ready` 200 (`postgres: ok`) | PASS |
| HTTPS certificate valid | PASS as reported by Fly (`fly certs show`: Issued, Let's Encrypt, expires in about 2 months). **Not independently handshake-verified:** this environment's proxy re-terminates TLS. |
| `/` redirects to `/hub/` (302, empty body) | PASS |
| Security headers present: HSTS (no includeSubDomains), strict CSP with no `unsafe-inline`/`unsafe-eval`, `nosniff`, `no-referrer`, `same-origin` CORP | PASS |
| Unauthenticated `/v1/research/overview` and `/v1/workflows` 401 | PASS |
| Unauthenticated malformed JSON `POST /v1/intake` 401 (not 400) | PASS |
| Foreign `Host` and the default `agentsmith-hub.fly.dev` hostname 421 | PASS |
| Hunt unaffected (`hunt.agentsmithdesk.xyz`: HTTP 200, 79,441 bytes, body sha256 identical before and after, `Server: Caddy`) | PASS (read-only GETs) |
| Logs contain no secrets (last 100 lines: 0 `Bearer`, 0 authorization values, 0 long token-like strings, 0 credentialed database URLs) | PASS (limited to the 100 lines Fly returns) |
| Startup role warning present (`database runtime role is not least-privilege: role owns 108 relation(s)...`) | PASS (expected, evidence of R1) |
| No unexpected database changes: read-only counts in all 32 tables identical before and after (non-empty: `budget_policies` 9, `schema_migrations` 7); migration ledger still 7 rows, last `0007_research_state.sql` (checksum `2ec89f696c90...`) | PASS |
| Secrets, DNS, Hunt, infrastructure untouched | PASS: only `fly deploy --image` was run against the app; secrets list unchanged in name (`API_BEARER_TOKEN`, `DATABASE_URL`, digests `abd50322e5d030dc`, `ad6c38468611a6f0` recorded for future comparison); one app, one machine; no worker; no DNS or database change |
| Authenticated login, wrong-token burst, valid token not locked out, dashboard data | **NOT TESTED by me** (the owner holds the token and will test from an iPhone) |

**Outstanding limitations (explicit):**
1. **R1: the application still runs as the database owner role `schema_admin`** (temporarily accepted by the owner). This is **not tamper-proof database protection**: a compromised application could disable the append-only triggers and rewrite or delete data. The startup log states it on every boot.
2. **The Fly organisation is on a trial: the machine log says "Trial machine stopping. To run for longer than 5m0s, add a credit card" and the machine stopped itself 5 minutes after waking before this deployment.** The hub will therefore stop after about 5 minutes of running and restart on the next request (auto-start); the in-memory throttle resets on every stop. This is a billing state of the account that this work did not change; resolving it needs the owner.
3. The image is a Docker-less build; no CI; the SSRF client and acquisition code are present but idle (no worker); the shared-gateway throttle bucket means about 10 invalid requests in 5 minutes make wrong-token attempts read 429 (the valid token is never throttled).
4. The authenticated checks are the owner's.

**Bearer token rotation (owner-approved, 2026-11-26, after deployment).** The owner's saved token was rejected by the live hub: the log showed the dashboard's requests (batches of four) answered 401 from 04:09:32Z and, once about ten had been rejected, 429 for wrong tokens; the cause (typo, prefix or a different token) was not determined. At the owner's explicit approval the secret `API_BEARER_TOKEN` was replaced (`fly secrets import` from stdin; the value never appeared on a command line or in output): secret digest `abd50322e5d030dc` -> `344cad7dd2f9ea08`; `DATABASE_URL` digest unchanged (`ad6c38468611a6f0`); the image digest stayed `sha256:c0eaf87d...`; app version 4, machine healthy. Verified once from the development environment (new token 200 on `/v1/research/overview` and `/v1/research/projects`, no token 401, `/health/ready` 200, no token or Bearer string in the last 100 log lines). The new token was delivered to the owner once as a file card containing only the token; the owner confirmed it saved and that login works; the local copy was then securely deleted. The old token no longer works.

**Rollback (not needed):** `fly deploy --config fly.hub.toml --app agentsmith-hub --image registry.fly.io/agentsmith-hub@sha256:69978a782c724de2ef37a974aeb32cf909ac968d6de3e8fdc5e5aa07f28e02a8 --ha=false`; no database action.

