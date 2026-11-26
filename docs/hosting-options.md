# Hosting the Control Room: Fly account status, real cost and alternatives (2026-11-27)

**Status: investigation only.** Nothing was upgraded, purchased, started or deployed. All Fly reads used the existing token,
read-only. Prices were read live on 2026-11-27 from each provider's public pricing page or API (sources at the end). Not Vercel.

## 1. Current Fly account state (read-only, 2026-11-27)
| Item | State |
|---|---|
| Organisation | personal (`Tsk`), one member |
| Billing (Fly API) | `billingStatus: TRIAL_ACTIVE`, `isCreditCardSaved: false`, `billable: false`, credit balance $0.00 |
| App `agentsmith-hub` | **suspended** |
| Machine `2870320f99dd68` (shared-cpu-1x, 512 MB, syd) | **stopped**. Event log: started 20:54:07Z and stopped by request at 20:59:07Z (exactly 5 minutes), the trial limit seen before |
| Releases | v3 (Release 1), v4 (token rotation), v5 (2026-11-26 06:41Z): all the same image digest `sha256:c0eaf87d…`. v5 is a redeploy of the same image, not a code change |
| Managed Postgres `agentsmith-hub-db` | `ready`, plan `dev-256` (Developer), region syd |

**Conclusion:** without a card the account stays on a trial and cannot keep the Control Room reachable. The machine stops after 5
minutes and the app is now suspended. Fly's Free plan gives a one-time $1 credit that expires after 7 days. After that, no new
resources can be created until a card is added.

**Update 2026-11-27 (later):** the owner added a card. The Fly API now reports `billingStatus: CURRENT`, `isCreditCardSaved: true`,
`billable: true`. The app is `deployed` (no longer suspended); the machine was started by a user action at 22:22:53Z and still runs
Release 1. Read-only checks: `/health/live` 200, `/health/ready` 200 (database wake about 4 s), `/v1/*` 401 without the token. The
5-minute trial stop should no longer apply; auto-stop when idle is still configured. Nothing was deployed or changed by this check.

## 2. Fly pricing that applies (fly.io/docs/about/pricing, /about/free-plan, /postgres/developer-plan)
- **Machines** (base prices quoted for Ashburn; **Sydney carries a 1.269× markup** in Fly's own price table):
  - shared-cpu-1x 256 MB: $2.19/month always-on, so **$2.78 in syd**;
  - 512 MB: $3.69, so **$4.68 in syd**.
  - Billed per second while running.
  - A stopped machine costs $0.15/GB-month of root filesystem (cents).
- **Managed Postgres, Developer plan: $4 per 30 days.**
  - Storage included (1–5 GB); up to 20 connections.
  - Two nodes of 256 MB with failover.
  - **Auto-pause when nothing is connected.** The first query after a pause waits for the wake-up, recorded earlier at about 25 s.
  - Daily backup **kept for 1 day only**.
  - Billed while it exists, including while paused.
  - The next plan up (Basic) is $38/month.
- **Free plan with a card:**
  - $5 of usage every month, covering machines and one Developer Postgres;
  - limits: 3 machines, community support, no dedicated IPv4;
  - **if a month's usage goes over $5, the organisation moves to Pay As You Go and the whole month is billed at standard rates from
    the first cent.**
- **Network:** shared IPv4 and IPv6 are free; the first 10 certificates are free; outbound data costs $0.04/GB in Asia Pacific. The
  Control Room's 15-second polling is roughly 10 MB per hour that a tab is open, so cents per month.

## 3. Realistic monthly cost of keeping the existing Control Room on Fly (Sydney)
| Mode | App | Database | Other | **Monthly** | What you get |
|---|---|---|---|---|---|
| A. As configured now (auto-stop, wakes on request), light use (about 2 h/day open) | ~$0.40 | $4.00 | ~$0.05 | **~$4.45, so $0 inside the $5 Free-plan credit** (card required) | Reachable any time, but every first visit waits for the machine and the database to wake (seconds to ~25 s) |
| A'. Same, heavier use (tab left open, more than ~1.2 h/day on average beyond the database) | $0.60–4.68 | $4.00 | — | **$5–9**: crossing $5 bills the whole month | as A |
| B. Always on, 512 MB (current size) | $4.68 | $4.00 | ~$0.05 | **≈ $8.75** | No machine cold start; the **database still auto-pauses** on the Developer plan when idle |
| C. Always on, 256 MB | $2.78 | $4.00 | ~$0.05 | **≈ $6.85** | as B; needs a test on Fly first. Locally the server uses ~80 MB RSS idle and after 1,000 Control Room requests |
| D. Always on, no database pause | $4.68 | $38.00 (Basic) | — | **≈ $43** | not justified for an idle engine |
| Later: plus the first worker (A26), 512 MB always on | +$4.68 | — | — | **≈ $13.40** with B | the worker can also run on demand only (cents) |

Domain and DNS costs are unchanged by any option. All figures are USD before any tax.

**Data-safety note:** with real research data, the Developer plan's 1-day backup is not enough. A scheduled `pg_dump` to separate
storage is needed whichever host is chosen; that is a design item, not a cost driver.

## 4. Alternatives (not Vercel), prices read 2026-11-27
| Option | Monthly (USD unless stated) | Region near you | Fit and trade-offs |
|---|---|---|---|
| **Linode / Akamai Nanode 1 GB**, app and Postgres on one VM | **$5** + $2 backups = **$7** (1 TB transfer included) | Sydney (`ap-southeast`) and Melbourne; Sydney at the standard price | Always on, no cold starts, predictable. We run the OS, Postgres, TLS (e.g. Caddy) and backups ourselves. **The Linode credential in this environment is rejected ("Invalid Token")**, so the account could not be inspected. Must stay separate from the Hunt server |
| Linode + Managed PostgreSQL (smallest) | $5 + $16 = **$21** | Sydney | Less database operations work |
| **DigitalOcean** Basic droplet | **$4** (512 MiB) / **$6** (1 GiB); managed PostgreSQL from **$15.15** | Sydney listed | Like Linode; 512 MiB is tight for Node plus Postgres, so 1 GiB is realistic (~$6 plus backups) |
| **Hetzner** Cloud (cost-optimised) | from **€5.99/month excl. VAT** (per-location price not verified) | Singapore listed; no Australian location | Cheapest compute, but furthest from Australia; self-managed like Linode |
| **Render** | Starter web service **$7** (512 MB) + Postgres **$6** (256 MB) = **$13** | Sydney not shown on the page read | Managed platform, little operations work; dearest of the small options |
| **Railway** Hobby | **$5 minimum**, including $5 of usage (memory $0.00000386/GB-s, about $10/GB-month; CPU $0.00000772/vCPU-s; egress $0.05/GB) | regions not verified | Small app plus Postgres likely within ~$5–8 by usage; free tier sleeps services |

## 5. Assessment
- **Cheapest with no migration work:** keep Fly, add a card (Free plan), keep auto-stop. About $0–5/month, but cold starts of up to
  ~25 s on the first visit, and a risk of the whole month being billed (~$5–9) if usage passes $5.
- **Continuously responsive on the existing stack:** Fly always-on, **~$8.75/month** (or **~$6.85** if 256 MB passes a test). The
  Developer database still pauses when idle; only Basic ($38) removes that.
- **Most control for a similar price:** a $5–7 VM in Sydney (Linode or DigitalOcean). This costs a one-off migration:
  - a host build and run procedure (systemd or a container);
  - TLS;
  - Postgres setup;
  - backups;
  - DNS cut-over;
  - new runbooks and smoke tests.

  Each step is a production change needing approval. It is also more operations work every month (OS and Postgres patching).
- **Not recommended now:** Fly Basic Postgres ($38), Render ($13) and the managed-database options ($15–21). They cost more without
  helping an idle engine.

**A25 stays ready** (candidate `837aeb9`, `docs/a25-release-checklist.md`). It deploys to whichever Fly arrangement is chosen. A
different host needs its own release plan.

## Sources (read 2026-11-27)
- Fly: `fly.io/docs/about/pricing/`, `/about/free-plan/`, `/about/free-waiver/`, `/postgres/developer-plan/`, `/mpg/`.
- Fly API, read-only: organisation billing fields, app status, machine event log, releases, MPG list. `fly platform vm-sizes` API
  gives $1.94/month base for shared-cpu-1x 256 MB; the docs give $2.19 per 30 days. The docs figure is used above.
- Linode public API: `/v4/linode/types`, `/v4/databases/types`, `/v4/regions`.
- `www.digitalocean.com/pricing/droplets`, `/pricing/managed-databases`; `www.hetzner.com/cloud/`, `/cloud/cost-optimized/`;
  `render.com/pricing`; `railway.com/pricing`. These four hosts were added to this environment's network allowlist for this
  read-only check, with the owner's approval at the prompt.
