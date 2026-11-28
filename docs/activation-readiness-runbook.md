# Activation readiness & first-target runbook

Baseline **c515da0**. This is the pre-activation audit and the exact, ordered runbook to go live — with rollback for every step.
Nothing here has been deployed or activated. Evidence below was produced locally against disposable Postgres and a locally-built image;
production Neon was not touched.

## Three statuses we keep separate (per the owner's distinction)

| Capability | Status now |
|---|---|
| **Autonomous orchestration** (discover→map→research→detect commit→rescan) | **Built + demonstrated** in real-Postgres integration tests (GitHub HEAD and worker sealing injected) |
| **Scheduled production monitoring + worker execution** | **Not started** — no worker machine; bridge/monitor not scheduled; 0012/0013 not deployed |
| **A live discovery → verified vulnerability** | **Not achieved** — zero live runs; zero findings |

Do not report orchestration as live production. These stay separate in every report.

## Readiness evidence (checks run for this audit)

1. **Migration compatibility — PASS.** 0012 and 0013 applied cleanly on top of the exact production schema (0001–0007 + 0011, **without
   0008**). New tables (`bounty_research_links`, `repository_monitors`, `repository_monitor_checks`) created; discovery (0008) tables
   stay absent, as in production. The migrations are additive (new tables only) and reference tables that already exist in production.
2. **Deployment compatibility — PASS.** The image builds at c515da0 and passes **39/39** production smoke checks locally (not pushed).
   It ships 0001–0007 + 0011 and **excludes** 0008/0012/0013 — so a deploy ships the new *code* but not the new *schema*; the new API
   endpoints are deploy-safe and return zeros until 0012/0013 are applied.
3. **Source configuration — VERIFIED.** `sherlock` and `hackenproof`: built, tested, `enabled=false`, `owner_decision_required`
   (authorised, awaiting enable). `immunefi`: `blocked_terms` (stays disabled). `cantina`: `blocked_robots` (board only).
   `community-board`: enabled, hourly.
4. **Collection → eligibility — PASS, with a blocking gap.** Enabling Sherlock + HackenProof on the fixtures and collecting yields
   **19 officially-confirmed eligible programmes** (up from 0) out of 388. **But `with_repositories = 0`** — see the blocker below.
5. **AI budget — VERIFIED.** `budget_policies` (enabled) enforce: global **$25/month (pause)**, global $1/day, per-workflow $0.50,
   per-tier monthly ($5/$15/$5), and per-call caps. Every model call goes through `AiBudgetGateway.execute`.
6. **Worker / queue flow — AUDITED.** The worker claims structural/engine steps only with `STRUCTURAL_ANALYSIS_ENABLED=true` **and**
   `ENGINE_LOOP_ENABLED=true` (both off by default). No worker machine exists; only the API machine and the hourly `bounty-collector`.
   The bridge and monitor are CLIs (`bounties:promote`, `bounties:monitor`), not yet scheduled machines.

## THE BLOCKER: programme → repository mapping is empty

Enabling Sherlock + HackenProof produces eligible programmes, but **none has a GitHub repository resolved**, so the bridge would create
**zero research runs**. The Sherlock/HackenProof adapters read listing-level data (name, reward, platform URL), **not** each programme's
in-scope repositories (those live on the programme's detail page). Only Immunefi's public-api carries in-scope GitHub repos — and
Immunefi is disabled pending Terms. Result: **deploy + enable + worker alone will not start a single live research run.**

Resolution paths (pick before/at activation):
- **(a) Per-programme enrichment** — extend the Sherlock/HackenProof adapters (or a new enrichment step) to fetch each programme's
  detail page and extract in-scope repository URLs, respecting robots/terms. New code; the biggest remaining build.
- **(b) Immunefi** — its feed already maps 113 repos; enabling it (after written Terms approval) immediately yields repo-mapped eligible
  programmes. Owner/legal decision.
- **(c) Controlled manual first target** — operator web-imports one eligible programme with a known, permitted public repo (or uses a
  controlled educational repo) to exercise the full live pipeline now, independent of auto-mapping. Recommended for the first exercise.

## Activation sequence (operator actions; each with rollback)

> Guardrail: the worker must run as the **restricted runtime role** (R1), never the DB owner, so it cannot bypass evidence
> immutability. The runtime-grants manifest already covers the new tables (`repository_monitors` SELECT/INSERT/UPDATE,
> `*_checks`/`bounty_research_links` SELECT/INSERT); the restricted-role integration gate passes.

1. **Deploy the code.** Build + verify + push the c515da0 image (as in the A42 runbook), `fly deploy --config fly.hub.toml`. New
   dashboard tabs appear showing zeros; nothing new runs yet.
   *Rollback:* `fly deploy … --image <previous digest>` (the prior release digest).
2. **Apply migrations 0012 + 0013 to production Neon.** Via the migrate runner with `DIRECT_DATABASE_URL` and the remote-host confirm
   guard (as A42 applied 0011). They are additive and empty on arrival.
   *Rollback:* they create only new, empty tables — `DROP TABLE repository_monitor_checks, repository_monitors, bounty_research_links;`
   and delete their `schema_migrations` rows. No existing data is touched.
3. **Re-apply runtime grants.** Run `apply-runtime-grants` with `RUNTIME_GRANTS_ALLOW_ABSENT` off now that the tables exist, so the
   restricted role gets the new-table privileges.
   *Rollback:* re-run against the previous manifest.
4. **Resolve the repository-mapping blocker** (one of (a)/(b)/(c) above). For a first exercise, (c): operator imports one permitted
   programme with a known repo.
5. **Enable Sherlock + HackenProof.** `POST /v1/bounties/sources/sherlock/enable` and `/hackenproof/enable` (bearer). The enable control
   refuses blocked sources, so Immunefi/Cantina cannot be enabled by mistake. HackenProof's public-display guard is already in place.
   *Rollback:* `POST …/disable`.
6. **Schedule the bridge and monitor** as hourly Fly machines (mirroring `bounty-collector`): `bounties:promote` then `bounties:monitor`.
   Keep `--max` small at first.
   *Rollback:* `fly machine destroy` the scheduled machines; the collector keeps running.
7. **Activate the worker** on a single controlled target: one Fly machine running `worker:intake` with
   `STRUCTURAL_ANALYSIS_ENABLED=true`, `ENGINE_LOOP_ENABLED=true`, `DATABASE_URL` = the **restricted** role, and the budget emergency
   stop available. Start with the controlled first target only.
   *Rollback:* `fly machine stop/destroy` the worker; queued steps simply wait.

## Controlled first-target exercise (design, not executed)

Goal: exercise the complete live path once, measurably, within budget, on a permitted/controlled target — **not** a live third-party
bounty until scope + permission are confirmed.

1. Pick a controlled, permitted repository (operator-owned, or a known educational target such as a DeFiVulnLabs contract) and
   web-import it as one eligible programme with that repo.
2. Run `bounties:promote --max 1` → one `repository_research` run is created with a provenance link.
3. Start the worker on that run only. It acquires + seals the snapshot, then runs the deterministic first pass (structural analyzer +
   Slither); model calls stay behind the $0.50/workflow and $25/month caps — watch `model_usage_events`.
4. Success criteria: the programme moves discovered → eligible → queued_for_scan → scanning → scanned, a sealed snapshot exists, a
   first-pass result is stored with evidence, and spend < caps. The **coverage** tab should show `researched = 1`.
5. Then push a new commit to the controlled repo and run `bounties:monitor` → it must queue an incremental rescan at the new commit. This
   is the first *live* demonstration of the cycle (vs. the integration-test demonstration).

## Remaining manual / permission / operational actions (owner)

- Decide to deploy (step 1) and apply 0012/0013 (step 2).
- Choose the mapping-blocker resolution: build enrichment (a), approve Immunefi Terms (b), or run a controlled manual first target (c).
- Approve enabling Sherlock + HackenProof (step 5).
- Approve worker activation and its budget (step 7).
- Keep Immunefi disabled until written Terms approval.
- No deployment, source enable, or worker activation happens without the owner; none was done here.

## What is NOT a blocker (confirmed)

Migrations, image build/verify, least-privilege grants, budget enforcement, source config, and the orchestration code are all ready.
The one true blocker to a *useful* first live run is repository mapping (above). Everything else is an operator decision, not more code.
