# Production plan: private hub at https://hub.agentsmithdesk.xyz (PREPARED, NOT DEPLOYED)

**Decision recorded:** the owner has confirmed `https://hub.agentsmithdesk.xyz` as the permanent production address. The root domain `agentsmithdesk.xyz` does not serve the hub and nothing here depends on it (so not being able to fetch the root page blocks nothing). Only the `hub` name is used.

Nothing in this document has been executed. No app, machine, volume, database, certificate, secret or DNS record has been created or changed. Every step below that touches the outside world needs the owner's explicit approval first.

Evidence gathered on 2026-11-25 from this session (egress was limited to GitHub, `fly.io` documentation and, later, `api.linode.com`): current PR heads, the repository, Fly's public pricing and DNS documentation, and local runs. **Not** inspected, because credentials or network access were missing: any live Fly account, any Linode account (the injected token was rejected with `Invalid Token`), the live DNS zone, the live Hunt or hub hosts. See `docs/hub-retirement-audit.md`.

## 1. Target and boundaries
- One private, authenticated dashboard plus its protected research API on one hostname: `hub.agentsmithdesk.xyz` (fixed). The app enforces this: with `HUB_ALLOWED_HOSTS` set, any other `Host` (the platform's default hostname, a spoofed header, another domain pointed at the same address) gets `421` before any route runs; only `/health/live` and `/health/ready` are exempt because the platform calls them with its own host.
- The public Hunt site (`hunt.agentsmithdesk.xyz`, separate repository) stays independent: no shared hostname, cookie, deployment, database or DNS record. The hub sets HSTS **without** `includeSubDomains`, so the hub's policy cannot reach Hunt or the root domain.
- No model calls and no AI gateway are enabled by deploying the hub. No active security testing is authorised or possible from it.

## 2. Hosting options, with actual list prices
Prices are the providers' published list prices fetched today; Fly states that Machine prices vary by region, and the repository's region is `syd`, so confirm the Sydney price before approving.

### Option A: Fly.io (what the repository is already prepared for)
| Item | List price | Needed |
|---|---|---|
| Machine, shared-cpu-1x, 512 MB (`app` group), started | $3.69/month (billed per second while running; stopped Machines pay only $0.15/GB-month of root filesystem) | yes |
| Managed Postgres, Developer plan (shared-1x, 256 MB, storage included, HA and backups included, no connection pooling) | $4.00/month | yes, for any data |
| Shared IPv4 and IPv6 | $0 | yes |
| TLS certificate for one hostname | free (first 10 single-hostname certificates free, then $0.10/month) | yes |
| Dedicated IPv4 | $2/month | only if A records are chosen instead of CNAME |
| Outbound data | $0.02/GB (North America, Europe), more in Asia Pacific | negligible for one operator |
| Worker Machine (`worker` group, 512 MB, always on) | $3.69/month | **not** needed for the hub; a later, separate decision |

**Estimate: about $7.69/month for the hub (app $3.69 + database $4.00)**, less if the app Machine mostly sleeps (`min_machines_running = 0`), about $11.38/month if the worker is later added. Add a small allowance for regional price differences. The Developer database tier auto-pauses and can take about 25 seconds to wake, so the first request after idle can be slow; the app's connect timeout is already 30 s.

**Blocker the owner must decide:** Fly requires a card on file and the owner has told us an old Fly bill is unpaid. Do not create anything on Fly until that is resolved by the owner, and do not treat this section as approval.

### Option B: a small VPS (Linode is the one hosting API that was connected to this session)
Public plan list prices from `api.linode.com/v4/linode/types`: Nanode 1 GB $5/month, 2 GB $12/month, 4 GB $24/month. This option has no managed database: Postgres, TLS (for example Caddy), backups, patching and a firewall are all ours to run, and backup add-on pricing was not fetched. Sharing a VPS with Hunt would break the independence requirement. Whether Hunt or the "old hub" already runs on Linode is **unknown**: the account could not be read.

### Recommendation
Fly (Option A) is the shortest safe path because the configuration, process groups, runbook, connection-safety code and release order already exist and were reviewed. It is gated only on the owner's billing decision. If the owner would rather not use Fly at all, Option B needs a new, reviewed hardening and backup plan first, so it is longer.

## 2a. Can the existing hosting be reused, or is something new needed?
| Existing thing | Reuse? | Why |
|---|---|---|
| The Fly **provider and organisation** | Yes, if the owner resolves billing | Same account, no new vendor. |
| The repository's Fly **configuration, Dockerfile, process-group design, runbook, connection-safety code** | Yes | Already reviewed and tested; `fly.hub.toml` is derived from the same pattern. |
| The Fly **app `agentsmith-multihub`** named in `fly.toml` | **No, not without proof** | Its contents are unknown (not inspectable from this session). Reusing it risks colliding with whatever it holds, and a separate app gives an independent release history and an instant, harmless rollback (`scale to 0`). It becomes a retirement candidate only after the owner's read-only inventory (see the audit). |
| The staging app `agentsmith-multihub-staging` | No | Staging stays staging; it was probably never created. |
| Hunt's hosting (the `hunt` host) | **No** | Independence is a requirement; sharing a host, cookie scope or database would couple them. |
| Any existing database | No | The hub gets its own database; reusing an old one would mix old data with the new schema. |

**Conclusion:** the existing hosting *arrangement* (Fly, the repo's configs and procedure) is reusable; the existing *resources* are not, and a new, separate Fly app plus a new Managed Postgres cluster is needed. Fly app names are global, so `agentsmith-hub` is a proposal that must be confirmed available at creation time; the hostname is not negotiable.

**Hosting requirements for `hub.agentsmithdesk.xyz`:** HTTPS with a certificate for exactly this hostname (Fly issues Let's Encrypt certificates automatically); a way to receive HTTP/1.1 and HTTP/2 over the public internet on a stable name; a Postgres 16-compatible database; a secret store for two secrets; per-app deploy and rollback; no shared state with Hunt.

**DNS requirements:** the ability to add (and, if one exists, remove) records named `hub` in the `agentsmithdesk.xyz` zone, at the zone's DNS provider (**unknown to this session**: the owner must say who it is and grant access when we reach that step). Specifically one routing record for `hub` plus one ownership or challenge record for `hub` (section 8). **CAA caveat:** if the zone has a CAA record at the apex that does not permit Let's Encrypt, certificate issuance will fail; the owner should check for CAA records in the zone export. This cannot be checked from here.

## 3. Required configuration
Committed file: `fly.hub.toml` (app group only, HTTPS forced, liveness check `/health/live`, no secrets; guarded by `apps/api/src/hub-deploy.test.ts`). The app name `agentsmith-hub` is a **proposal**: Fly app names are global and availability is unknown.

| Variable | Kind | Value / rule |
|---|---|---|
| `NODE_ENV` | env (in toml) | `production` (also switches HSTS on) |
| `HOST`, `PORT` | env (in toml) | `0.0.0.0`, `8080` |
| `LOG_LEVEL` | env (in toml) | `info` |
| `DATABASE_CONNECT_TIMEOUT_MS` | env (in toml) | `30000` |
| `API_BEARER_TOKEN` | **secret** | generated with `openssl rand -base64 48`; the server refuses short, header-unsafe or repetitive tokens at startup |
| `DATABASE_URL` | **secret** | the Postgres connection string for the app; TLS verification stays on |
| `DIRECT_DATABASE_URL` | **not an app secret** | used only by the migration command, from the operator's machine, never stored on the app |
| `HUB_ALLOWED_HOSTS` | env (in toml) | `hub.agentsmithdesk.xyz` (exact hostnames only, no wildcard, port or scheme; the server refuses to start on an invalid value) |
| `HUB_ASSETS_DIR` | optional | unset: the image serves `dist/web` |
| `AI_BUDGET_EMERGENCY_STOP` | optional | leave `false`; no model calls exist in this build |

## 4. Authentication and session requirements
Current state (alpha): single operator, one bearer token, kept in `sessionStorage`, sent as `Authorization: Bearer`, never in a URL; failed attempts lock out with `429`; strict CSP; research data only behind `/v1/*`. Limits and the proposed multi-user model are in `docs/hub-auth.md`.

Requirements to go live as a private hub, in order:
1. A generated token in the host's secret store, known only to the owner; rotate it on any suspicion (`fly secrets set` restarts the app).
2. TLS only with HSTS on the hub hostname (done in code; HSTS is on when `NODE_ENV=production`).
3. **Owner decision needed:** accept the single-shared-token alpha for a private, single-operator hub, or require the proposed identity-aware login first. This plan assumes the former is acceptable only while the hub holds no real research records and only the owner uses it; Task 5.6 (recording reviews) requires named operator identity, so the identity work becomes mandatory before reviews are recorded.
4. No session expiry exists beyond closing the tab (the token is tab-scoped). A server-side session with an idle and absolute timeout belongs to the identity work; the acceptance checklist below records the current behaviour honestly rather than assuming one.

## 5. Health checks
- `GET /health/live`: process liveness, no database, no data. Used by Fly. Verified locally against the production build.
- `GET /health/ready`: database reachability. Not used as a restart trigger (a sleeping database must not restart the app). Use it in smoke tests.
- Hub-level: `GET /hub/` returns 200 with the CSP and HSTS headers; `GET /v1/research/overview` returns 401 without the token and 503 `database_not_configured` with the token but no database (both verified locally in the production-mode simulation).

## 6. Database requirements
PostgreSQL 16-compatible, migrations `0001`-`0007` (`npm run db:migrate`, `DIRECT_DATABASE_URL` only, refuses non-loopback hosts unless explicitly confirmed, advisory-locked, checksummed). No Neon. Tests never use a hosted database. The hub shows honest empty states until the pipeline writes records, so an empty migrated database is a valid first state. Production research data is never seeded.

## 7. Build and release steps (each needs approval; verify flyctl syntax against current docs before running)
1. Owner: resolve billing, create the empty app `agentsmith-hub`, an app-scoped deploy token, and the secret `API_BEARER_TOKEN`. Create the Managed Postgres cluster only after approving its cost.
2. Release 1, app only, no database yet: `fly deploy --config fly.hub.toml --app agentsmith-hub --ha=false`. Expect one `app` Machine, healthy, no worker. Because the app only answers its own hostname, smoke-test before DNS exists through a tunnel with the right header: `fly proxy 8080:8080 --app agentsmith-hub` then `curl -H 'Host: hub.agentsmithdesk.xyz' http://127.0.0.1:8080/hub/` (verify syntax). Expect `/health/live` 200, `/hub/` 200, `/v1/*` 401 without the token, and 421 for any other `Host`.
3. Attach the database: set `DATABASE_URL` as a secret. From the operator's machine run the migration with `DIRECT_DATABASE_URL` through a Fly proxy (see `docs/fly-staging-runbook.md` steps 5 to 8 for the exact, reviewed procedure). Then `/health/ready` must report postgres ok.
4. Certificate and DNS: `fly certs add hub.agentsmithdesk.xyz --app agentsmith-hub`, add the DNS records it prints (section 8), then `fly certs show` until issued.
5. Run the iPhone acceptance checklist (section 9) and the Hunt independence check.
6. Add the worker only by a separate, later, approved release.

CI cannot run (GitHub Actions billing). The release gate is the local `npm run verify`, `npm run hub:layout-check`, and the checks above, none of which is independent CI.

## 7a. Go-live command sheet (syntax checked against flyctl v0.5.17 `--help`; none of it has been run)
Approved by the owner on 2026-11-25: create the separate app, its separate database, and deploy the private hub; Fly charges understood. Still requires approval at the time: any DNS change (the exact records are shown first), any deletion (none is part of this release).
Prerequisite: a Fly credential in the session (`FLY_API_TOKEN`) and a Fly account whose billing allows creating apps. If Fly refuses for billing or any account-level reason, stop and report the exact message; no workaround.

1. `fly apps create agentsmith-hub --org <org>` (if the name is taken, stop and report; do not silently pick another).
2. `fly mpg create --name agentsmith-hub-db --org <org> --region syd --plan Dev-256 --pg-major-version 16` (**the plan must be named: without it the default is Basic at $38/month**; the CLI prints the plan's monthly price: record it; if `syd` is not offered or `Dev-256` is not the $4 plan, stop and report; the connection string it prints is never copied anywhere).
3. Secrets, staged so nothing deploys yet: generate the token locally into a variable that is never echoed, then `fly secrets set --stage --app agentsmith-hub API_BEARER_TOKEN=<generated>`; the token is handed to the owner once, through the Fly dashboard or a channel the owner chooses, never in chat history, a file, a log or git.
4. `fly mpg attach <cluster id> --app agentsmith-hub` sets `DATABASE_URL` (prints the string: do not log it).
5. `fly deploy --config fly.hub.toml --app agentsmith-hub --ha=false`. Checks: release succeeded, one `app` Machine healthy, no worker, `/health/live` 200 (through `fly proxy 8080:8080 --app agentsmith-hub` and `Host: hub.agentsmithdesk.xyz`), `/health/ready` reports postgres ok (allow 30 s for a paused cluster to wake), TLS verification stays on (if it fails: stop and report; never set `DATABASE_SSL_VERIFY=false`).
6. Migration, only after confirming the target is the new empty cluster (list its tables, expect none): `fly mpg proxy <cluster id>` gives a loopback endpoint on 127.0.0.1:16380; run `npm run db:migrate` locally with `DIRECT_DATABASE_URL` pointing at that loopback endpoint, or run it inside the app Machine as in `docs/fly-staging-runbook.md` step 8 with `MIGRATE_CONFIRM_REMOTE_HOST`. Expect seven migrations applied.
7. `fly certs add hub.agentsmithdesk.xyz --app agentsmith-hub`, then show the owner the exact DNS records it prints.
8. Owner adds the records. `fly certs check hub.agentsmithdesk.xyz --app agentsmith-hub` until issued.
9. Run the acceptance checklist (section 9) and confirm Hunt still responds.
Open unknowns that only a real attempt reveals: whether the remote builder is reachable from the session's network policy (extra hosts may need allowing), whether the Developer plan is offered in `syd`, and whether the token's scope covers Managed Postgres.

## 8. DNS: proposed changes (NOT applied)
Current state of `hub.agentsmithdesk.xyz`: **unknown**. This session's resolver is filtered (`example.com` and the `xyz` zone itself return no such domain), so its answers are not evidence of the real zone. The owner's zone export is needed (see the audit).

| Record | Proposed value | Known now? |
|---|---|---|
| `hub` CNAME (recommended, a subdomain; Fly's documentation recommends CNAME for subdomains) | the app's unique `.fly.dev` hostname, printed by `fly certs add` and shown in the dashboard (it would be `agentsmith-hub.fly.dev` only if that exact app name is created: unconfirmed) | **No**, until the app and certificate exist |
| `hub` A and AAAA (alternative) | the addresses printed by `fly certs add` after `fly ips allocate` (a dedicated IPv4 costs $2/month) | **No** |
| Certificate proof | `_acme-challenge.hub` CNAME **or** `_fly-ownership.hub` TXT, whichever `fly certs add` prints | **No**, never invented |
| Anything already named `hub` | a CNAME cannot coexist with other record types at the same name, so an existing `hub` A, AAAA, TXT or CNAME record would have to be listed and retired first, by owner approval | **Unknown** |

Not touched, by construction: the apex, `www`, `hunt`, MX, SPF, DKIM, DMARC and every other record. If the host turns out to be a VPS instead, the single change is one `hub` A record to the VPS's IPv4 address, unknown until it exists.

## 9. iPhone-first live acceptance checklist
Run on a real iPhone in Safari, on cellular as well as Wi-Fi. Record pass, fail or not-run for each; screenshots go in the PR, never tokens.
1. Open `https://hub.agentsmithdesk.xyz`: lock icon present, certificate is for this hostname, the unlock screen appears, no mixed-content or console errors (Settings, Safari, Advanced, Web Inspector from a Mac, if available).
2. Unauthenticated: visit `https://hub.agentsmithdesk.xyz/v1/research/overview` directly: must be `401`, with no data. Repeat with a wrong token ten times: the eleventh attempt must return `429`.
3. Unlock with the real token: the Research Home loads; the token is not in the address bar or history.
4. Close the tab and reopen: the unlock screen returns (tab-scoped token). Tap Lock: the same.
5. Navigation: all six tabs work, the tab bar stays at the bottom, nothing hides behind it, no text overlaps or clips, rotate to landscape and back: the repository map redraws.
6. Empty states: with an empty database each section explains why it is empty and names the task that fills it; no sample data appears.
7. Error state: with the database paused or unreachable, sections show the honest error and Retry works.
8. Repository and hypothesis views: only meaningful once records exist (Tasks 5.2 and 5.5). Until then record "not testable" and do not seed production data.
9. CSP and headers (from a computer): `curl -I https://hub.agentsmithdesk.xyz/hub/` shows the CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security` without `includeSubDomains`.
10. Hunt independence: `https://hunt.agentsmithdesk.xyz` loads and behaves exactly as before the change, before and after DNS and certificate steps.
11. Session expiry: record what actually happens (tab-scoped, no server-side expiry yet) and whether that is acceptable.

## 10. Rollback
- Application: `fly releases --app agentsmith-hub`, then redeploy the previous image (`fly deploy --image <previous image reference> --config fly.hub.toml --app agentsmith-hub`) (verify syntax). Migrations are forward-only: the rollback for a bad migration is a restore from the database's backup, so take a backup point before migrating.
- Emergency stop: `fly scale count 0 --app agentsmith-hub` takes the hub offline without deleting anything (verify). Rotating `API_BEARER_TOKEN` revokes access immediately.
- DNS: remove or repoint only the single `hub` record (and its certificate-proof record). Nothing else is ever edited, so Hunt and the root domain cannot be affected by a rollback.
- Data: nothing in the hub writes research records except future tasks; the one write today is project creation through intake.

## 11. Shortest safe path to live
1. Owner decides the host (Fly or not) and resolves billing. 2. Owner runs the read-only inventory in the audit and approves the exact retirement list. 3. Owner accepts or changes the single-token access decision. 4. Approved release 1, database, migration, certificate, DNS, in that order (section 7). 5. Acceptance checklist. 6. Only then consider retiring old resources, each by explicit approval.
