# First controlled production release of the secure foundation (PREPARED, NOT EXECUTED)

Status as of 2026-11-25. **Nothing in this document has been executed.** No PR is merged, nothing is deployed, no production migration, role, credential or DNS change has been made, and `hunt.agentsmithdesk.xyz` has not been touched. Every step marked **[approval]** needs the owner's explicit, separate approval at the time.

Goal: put the reviewed security fixes (review findings 1-5) and the foundation PRs they sit on into production at `https://hub.agentsmithdesk.xyz`, with the research engine **idle**, preserving production data, with a tested rollback. Task 5.3 is not part of this and is not required.

## 1. What would be released
Source of truth is the stacked draft PRs. Tips at the time of writing (each tip is verified by `npm run verify` incl. both integration runs, and by its mutation spec, on exactly that tree; the **final** release commit must be re-verified and recorded here when chosen):

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
| 6. Startup role guard must not block boot on a database outage (found by the stack review) | #17 | `claude/fix-startup-guard-db-outage` | the head of PR #17; **this is the release-candidate tip** |

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
- **CI cannot cover the stack even if billing is fixed**: `.github/workflows/ci.yml` triggers only for pull requests targeting `main`; every PR in this stack targets another branch, and the workflow runs neither the integration tests nor the build-output checks.
- No independent CI result exists (`ci.yml` present; Actions billing block recorded). All evidence is local.
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
