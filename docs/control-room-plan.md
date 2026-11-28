# Live Engine Control Room: audit and shortest safe route (2026-11-26)

**Status (updated 2026-11-26): CR1 and CR2 are implemented on the branch under A24 (`abf76a5`); nothing is deployed or activated.**
Originally: CR1 and CR2 are code changes on the branch and need approval (A24). Deployment (A25), worker activation (A26) and any migration (A27, A21) are separate approvals. T-149
(`docs/unified-research-workflow.md`) is the authority. The Control Room is a **read-only view of the one T-149 lifecycle**. It adds no
lifecycle, protocol model, priority engine or state of its own.

## 1. What exists today (verified in code; production state from `docs/hub-production-plan.md` §12–15)
| Area | Exists | Where |
|---|---|---|
| Hosting | Hub live at `hub.agentsmithdesk.xyz`: app Machine only, **no worker**, Managed Postgres with migrations **0001–0007 recorded as applied**. 0008 (discovery) is not recorded as applied in production. The deployed image predates review fixes 1–5, which are **not deployed**. | `hub-production-plan.md` §12, §15 |
| Auth | One operator bearer token. Tab-scoped `sessionStorage` in the browser. Constant-time compare, invalid-attempt throttling, strict CSP (`connect-src 'self'`), host allow-list (421 otherwise). | `auth.ts`, `hub-static.ts`, `host-guard.ts` |
| Web app | Six sections: Home, Projects, Repository, Hypotheses, Evidence, Activity. Honest empty states that name the task that fills them. "Nothing on this page is sample data". Project detail keeps **legacy passive pipeline output** in its own panel. | `apps/web/src/view-*.ts` |
| Engine overview | `GET /v1/research/overview`: runs by status; snapshots sealed/building; evidence, hypotheses, evaluations and reviews counts; 24 h event counts. Pipeline: queued and running steps, expired leases, **live lease owners**, failed in 24 h / 7 d, oldest queued age, last step success, steps by key and status, a derived health state (`idle` / `working` / `attention`). | `research-api.ts:54` |
| Stage records | Projects (with current and next step), snapshots (commit, files, surface, **dossier**), hypotheses, evidence, merged activity feed (research events + workflow audit), each labelled automated / human / model | `research-api.ts` |
| Discovery | `GET /v1/discovery/sources`, `GET /v1/discovery/opportunities[/:id]` (plus operator POSTs). Not shown in the web app (the nav item says "not built"). | `discovery/api.ts`, `vocab.ts:56` |
| Worker | One runtime that dispatches the legacy intake chain, `repository_research` (acquire; analysis stages behind `STRUCTURAL_ANALYSIS_SWITCH`, off by default) and the discovery monitor. Identity `intake-<machine id>`. Lease heartbeats only while a step runs. | `worker-runtime.ts`, `worker-main.ts`, `worker.ts` |
| Local visual tooling | `scripts/hub-demo.ts` writes **synthetic** records into a disposable loopback database for screenshots only. Never production. | `hub-demo.ts` |

## 2. What is missing for a truthful real-time Control Room
| Gap | Why it matters | Needs |
|---|---|---|
| **No refresh.** Views load once. | Not "real time" | CR1 (web only) |
| **Worker presence is unknown while idle.** A worker with no running step holds no lease, so "no worker" and "worker idle" look the same. | The first question an operator asks | CR2 (read-only, see §4); a heartbeat table later needs a migration (A27) |
| **No build or schema identity on screen** (commit, image, applied migrations, switches) | You cannot tell what code is producing what you see | CR2 |
| **Legacy vs structural not separated at the overview level** (only inside project detail) | The two pipelines coexist (T-149 S3 / A18 unapproved); counts mix them | CR1 using `workflow_type` (existing column); CR2 adds per-type queue counts |
| **Protocol mapping (P1–P3) not shown** although the dossier endpoint serves it | The structural intelligence is invisible | CR1: snapshot dossier view from the existing endpoint |
| **Discovery not shown** | Intake starts there | CR1: read-only panel on the existing GETs, with an honest "not installed" state when 0008 is absent (production today) |
| **Step errors are raw JSON** in project detail | Possible leakage of internal detail | CR2: a shaped error (`code`, `retryable`, `at`, first 200 characters, scrubbed of URLs with credentials and of host:port) |
| Priority | No priority is computed or stored in production; the queue is claim order | Show "claim order (no priority engine in production)". Never invent a priority. T-052–T-058 own it. |
| Validation / review / adjudication / memory | Evaluations and reviews exist as tables; the human-review/outcome API is **unapproved**; adjudications live only in `eval/adjudications/` files; memory tables are empty | Show counts and "not built" states naming the approval that blocks them |

## 3. Honesty rules (acceptance criteria for every Control Room screen)
1. **Live means a live lease or a fresh heartbeat.** Only a step whose lease has not expired is shown as running. Everything else shows
   its recorded state and an absolute time (completed, failed, queued). Nothing is animated unless live.
2. **No simulated records in production.** The production database is never seeded. Every run shows `created_by` and `input.source`.
   If evaluation imports are ever allowed (they are not now), they carry `created_by = 'eval-import'` and a fixed "historical import"
   badge. A demo/synthetic database shows a permanent "SYNTHETIC DATA" banner, driven by a flag the API returns, not by the client.
3. **Idle is a first-class state.** With zero runs, no queued steps and no worker connected, the page says "Engine idle. No worker is
   connected. Nothing is queued." It must not show placeholder charts.
4. **Freshness is visible.** Every panel shows "as of <server time>" from `generated_at`. If a refresh fails or the data is older than
   twice the refresh interval, a "stale since …" banner replaces the live indicator.
5. **Leads are never findings.** Hypotheses show their status (`unreviewed`, evaluated, reviewed). A human-adjudicated confirmed count
   is shown only from signed review records (0 today).
6. **Two pipelines, labelled.** "Structural repository research (T-149)" and "Legacy intake (template hypotheses; retirement under T-149
   S3 awaits approval)" are separate lanes reading the same tables. There is no merged score.

## 4. Design
**CR1: web only (no API change).**
- Poll every 15 s while the tab is visible (`document.visibilityState`); pause when hidden.
- Freshness and stale banners; lanes by `workflow_type` (client-side grouping of the existing projects page).
- A snapshot "Architecture (P1–P3)" view rendering the existing dossier endpoint.
- A read-only discovery panel.
- No new dependencies; CSP unchanged (`connect-src 'self'`).
- **Cost note:** polling keeps the auto-stopping app Machine and the auto-pausing database awake while a tab is open (the plan
  already budgets about $7.69/month for always-on). Polling stops when the tab is hidden or locked.

**CR2: one new read-only endpoint, `GET /v1/engine/status`** (same bearer token; GET only; no secrets), returning:
- `build`: commit SHA and image tag from build-time constants (no environment dump);
- `schema`: applied migration names from the migration ledger (`schema_migrations`);
- `switches`: `STRUCTURAL_ANALYSIS_SWITCH` on/off;
- `data_kind`: `production` or `synthetic`;
- `workers`: currently live lease owners, plus connected workers detected by a read-only `pg_stat_activity` query on the worker's
  `application_name`. Before relying on it, check that the API's database role can see that column for other roles' sessions. If it
  cannot, report "worker presence unknown while idle" (truthful) until a heartbeat table exists (A27);
- `queue`: queued and running steps by `workflow_type` and `step_key`, oldest queued age, expired leases;
- `last`: last run created, last step success, last failure with a **shaped** error;
- `generated_at`.

Tests:
- 401 without a token (route-coverage test);
- a test that the body never contains environment values (token, `DATABASE_URL`) or connection strings;
- empty-database idle state;
- expired-lease, so "running" is not shown as live;
- synthetic flag on.

**Not in scope:** no write endpoints, no SSE/WebSocket (polling is enough and keeps the CSP and auth model unchanged), no new
roles. A read-only viewer role, so the page can be shared without the operator token, belongs to the identity work and needs its own
design.

**Stage → data source map (all existing tables; nothing new):**
| Stage | Source |
|---|---|
| discovery / intake | `discovery_*`, `bounty_opportunities` (0008); `workflow_runs.input` |
| queue | `workflow_steps` (status, lease), claim order |
| acquisition / snapshot identity | `repo_snapshots` (repository, commit, manifest), `repo_snapshot_files` |
| protocol mapping | analyze step output `protocol_model_sha256` → `research_blobs`; dossier endpoint |
| hypotheses / evidence | `hypotheses`, `hypothesis_status`, `evidence_spans`, `hypothesis_evidence` |
| validation / review | `hypothesis_evaluations`, `hypothesis_reviews` |
| adjudication / memory | none in production (shown as not built) |
| worker health | leases, `audit_events`, CR2 presence |

## 5. Shortest safe route to seeing it work on the real site
| Step | What | Approval | What the page will truthfully show |
|---|---|---|---|
| CR1 + CR2 (T-186, T-187) | Implement on the branch; verify; local check against an empty migrated DB and a synthetic one | **A24** (implementation) | locally: idle; synthetic banner in demo |
| CR3 (T-188) | Release to the hub. The release also carries review fixes 1–5 (draft PRs, not deployed) | **A25** (production change; merge/deploy) | production: "Engine idle. No worker connected. 0 runs." This is the truth today |
| CR4 (T-189) | Activate one worker with the structural switch on. Submit one public repository through intake | **A26** (worker activation), plus A15-type network access for GitHub reads | queued → running (live lease) → succeeded stages, snapshot identity, P1–P3 architecture, unreviewed hypotheses |
| CR5 (T-190, optional) | `worker_heartbeats` migration for presence while idle | **A27** (migration) | "worker idle, last heartbeat 12 s ago" |
| Discovery on production | Apply 0008 | **A21-class migration approval** | discovery sources and opportunities |

Until CR4 the production Control Room **cannot** show the engine moving, because no engine runs. CR1–CR3 make that state visible and
honest; they do not create activity.
