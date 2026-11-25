# Private hub dashboard (alpha): API additions and client design

Status: design for the dashboard alpha, written before the code. Built on the Task 5.1 research-state schema (PR #8, `7c4f9ef`). Local only: no DNS change, deployment, hosted resource or paid service. The public Hunt site is a separate repository and is not touched.

## 1. Principles
1. **The backend is the only source of truth.** The browser renders records returned by the API. It computes no status, verdict, independence or completeness of its own; it only maps backend vocabulary to wording, and shows anything it does not recognise verbatim, marked "unrecognised".
2. **Nothing is invented.** Every list is a query. Where the pipeline has not produced anything yet, the screen says so, and names the later task that will produce it. No sample data ships in the app.
3. **Provenance is always visible.** Automated rules, models and humans are distinct on screen. A blinded assessment and a disclosed adjudication look different and show exactly what the reviewer saw. The words "verified" and "independent" are never used as labels; they appear only inside facts the backend records.
4. **Untrusted text stays text.** Source code, claims, rationales and repository names come from third parties. The client builds the page with `textContent` and never `innerHTML`; a strict content-security policy backs that up.
5. **Read-mostly alpha.** The only write is creating a project through the existing `POST /v1/intake`. Recording reviews and withdrawals needs the review endpoint of Task 5.6 and is not built here.

## 2. What exists today and what the dashboard maps to
| Dashboard section | Backed by | Real data today |
|---|---|---|
| Projects | `workflow_runs` / `workflow_steps` (a project is one intake run) | yes: runs created by `POST /v1/intake`, with the legacy passive pipeline's steps and brief |
| Repository | `repo_snapshots`, `repo_snapshot_files`, `research_blobs` | **no records until Task 5.2 (acquisition) exists**; the screen shows empty states |
| Hypotheses | `hypotheses` + `hypothesis_status` view, evaluations, reviews | **none until Tasks 5.5/5.6**; the screen is built and tested against records written through the real `ResearchStore` |
| Evidence | `evidence_spans` | same |
| Activity | `hypothesis_events` + workflow `audit_events` | workflow audit events today; research events when hypotheses exist |
| Home | counts over all of the above + queue health | yes |

The legacy pipeline's `source_snapshots` and brief (regex leads, template hypotheses, checklist) are shown on the project page, labelled as the legacy passive pipeline, because they are the only research output that exists in real runs today.

## 3. API additions (all `GET`, bearer-protected, JSON, `Cache-Control: no-store`)
Common rules: ids are UUIDs (400 `invalid_id` otherwise); 404 `not_found`; 503 `database_not_configured`; `limit` default 25, max 100 (files: max 1000); `offset` default 0; list responses are `{ items, limit, offset, has_more }`. All queries are parameterised and bounded. The same bearer hook as `/v1/*` applies (401 `unauthorized`, 503 `api_auth_not_configured`).

| Endpoint | Returns |
|---|---|
| `/v1/research/overview` | counts of projects by status; snapshots (sealed/building); evidence spans; hypotheses total and by derived status; evaluations; reviews by mode; events in the last 24 h; pipeline health (queued, running, running with an **expired** lease, failed steps in 7 days, oldest queued age); storage statistics |
| `/v1/research/projects?status=` | runs with input summary (kind, value, source; notes omitted), step progress, snapshot counts, hypothesis counts by status, evaluation and review counts (these drive the stage stepper) |
| `/v1/research/projects/:id` | the above plus notes, step list with errors and lease state, snapshots, legacy evidence snapshots (id, kind, uri, hash) and the legacy brief |
| `/v1/research/snapshots?run=` , `/v1/research/snapshots/:id?verify=1` | snapshot header: repository, commit, ref, sealed state, counts, manifest hash, acquisition report; `verify=1` runs `verify_repo_snapshot` (re-hashes every blob) |
| `/v1/research/snapshots/:id/files?prefix=` | manifest rows: path, classification, size, stored or skipped (with reason), span and hypothesis counts |
| `/v1/research/snapshots/:id/file?path=` | one stored file's text (UTF-8 only, at most 1 MiB), with the spans and hypotheses that cite it; 409 `skipped`, 410 `evicted`, 415 `not_text` |
| `/v1/research/snapshots/:id/surface` | per-file aggregates for the attack-surface map: size, classification, spans, hypotheses by status (at most 5,000 files, `truncated` says so) |
| `/v1/research/hypotheses?run=&snapshot=&status=` | list with derived status, generator, evidence/evaluation/review counts, plus status facets |
| `/v1/research/hypotheses/:id` | full record; evidence spans **resolved from the stored bytes** (`ok` plus text, or the reason it does not resolve); evaluations with their spans; reviews with mode, `reviewer_saw`, input hash, verdict and model fields; the event history |
| `/v1/research/evidence?snapshot=&run=&path=` | spans with citation counts |
| `/v1/research/evidence/:id?context=N` | one span: resolution result, database verification verdict, N lines of context (max 20), and every hypothesis or evaluation that cites it |
| `/v1/research/activity?automation=&before=` | merged timeline of research events and workflow audit events, newest first; each item says whether it is `automated`, `model` or `human` |

**Automation classification.** Research events carry an explicit `actor_kind`. Workflow audit events carry only an actor string: `user` (the intake request) is classed `human`, anything else (worker ids) `automated`. That classification is a documented rule, stated in the response (`automation_basis`), not something the UI infers.

**Status vocabulary.** The API returns the raw derived status from the `hypothesis_status` view. The client wording must never read as verification: `supported_by_review` is "reviewer supports pursuing" and there is no `verified` state.

## 4. Client
- **Stack:** TypeScript compiled by `tsc` to ES modules, static HTML and CSS, no framework, no bundler, no runtime dependency. Served by the existing Fastify server under `/hub/` (an allow-list of files, no directory traversal), so it is same-origin, needs no CORS, and can later sit behind its own hostname without code change. Dev-only additions: `jsdom` (UI tests) and `playwright-core` (screenshots, local only).
- **Routing:** hash routes (`#/projects`, `#/hypotheses/<id>`), so the server needs no catch-all and deep links survive reloads.
- **Authentication (single-operator bootstrap):** the existing bearer token. The user enters it on an unlock screen; it is kept in `sessionStorage` (tab-scoped, cleared on lock) and sent as `Authorization: Bearer`. It never appears in a URL. A 401 returns to the unlock screen; a 503 `api_auth_not_configured` explains the server has no token. This is not multi-user identity; that remains future work.
- **Security headers** on hub assets: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-cache`.
- **States:** every view has loading, empty (explaining which pipeline task produces the data), error (with the HTTP status and retry) and locked states.
- **Layout:** dark navy workstation theme from design tokens. Desktop: sidebar, list-detail panes. Phone: bottom tab bar, single pane with back navigation, horizontally scrollable code. Respects `prefers-reduced-motion`; focus rings visible; targets at least 44 px on touch.
- **Attack-surface map:** a squarified treemap of the snapshot's files (area is size, colour is classification, marks show cited files and hypothesis counts), drawn as SVG from the `/surface` response. It maps only what exists: manifest rows, spans and hypotheses.

## 5. Design 2 mapping (the accepted visual reference)
The reference mock supplies layout and look: dark navy and near-black panels, cyan as the primary accent with amber and green as status colours, a left sidebar, a header with the workspace name, four stat cards, an investigation list beside a detail pane with a stage stepper, and a bottom row of activity, a status donut and a pipeline chart. Its numbers and names are sample data and are **not** reproduced. Where the mock would misstate the system, the hub deviates:

| Mock element | In the hub |
|---|---|
| "Investigations", "Repositories" | "Projects" (one intake run) and "Repository" (the pinned snapshot); same screens, accurate words |
| Stat cards: Active Investigations, Hypotheses, Under Review, Findings | Active projects, Hypotheses (total), **Awaiting review** (status `unreviewed`), **Evidence spans**. No Findings card: no findings pipeline exists |
| Hypothesis states Open / In Review / **Strengthened** / Weakened | The real derived vocabulary only (`unreviewed`, `weakened_by_static_check`, `contradicted_by_static_check`, `supported_by_review`, `rejected_by_review`, `needs_more_evidence`, `review_inconclusive`, `reviews_disagree`, `withdrawn`). "Strengthened" has no counterpart and there is no verified state |
| Stage stepper Discovery, Repository, Understanding, Analysis, Challenge, Review, **Verification** | The same seven slots, each driven by real records for the project: Repository (a sealed snapshot exists), Analysis (hypotheses exist), Challenge (evaluations exist), Review (reviews exist). Discovery and Understanding show "not built" (Tasks 5.3, 5.4). Verification shows "not built" (scoped testing is outside this roadmap stage). A slot is never shown complete without a record |
| Progress percentages | Succeeded steps over total steps of the run, labelled as workflow steps |
| "Research Engine: Operational", Workers 3/3 | A server-computed health state (`idle`, `working`, `attention`) with its reasons (expired leases, failed steps). "Workers" is the number of distinct lease owners holding a live lease, labelled as such, never a configured capacity |
| Current Activity / Next Up | The step currently running and the next queued step of the selected project, from `workflow_steps` |
| Investigation Pipeline bar chart | Workflow steps by status per step key |
| Avatar "SA", notification bell | A lock control only: the single-operator token carries no identity, so no name is shown, and there are no notifications to show |
| Sidebar: Reviews, Findings, Knowledge, System | Shown dimmed with the task that will build them, so the structure matches without implying they work |

## 6. Not in this alpha
Recording reviews or withdrawals (Task 5.6), repository acquisition and discovery (5.2, 5.3), parsing and specialists (5.4, 5.5), the dossier (5.7), the frozen baseline (5.8), multi-user identity, any deployment or DNS, any change to the Hunt site, any model call.

## 7. Alpha status (what works, what waits)
Screenshots in `docs/hub-screenshots/` are produced by `npm run hub:screenshots` from SYNTHETIC records written through the real `ResearchStore` into a throwaway local database. They show what the screens look like with data; no real repository, finding or sample number ships in the app.

| Works now against the real backend | Waits for a later task |
|---|---|
| Unlock, Research Home, Projects (list, detail, create via intake), Activity (automated / model / human, paging), system health | Repository content: acquisition (5.2), so no snapshot exists in a real run yet |
| Repository, Hypotheses, Evidence screens, fully tested against records written through the store | Hypotheses and evidence in real runs: analysis (5.5) |
| Review display: blinded vs disclosed, what the reviewer saw | Recording reviews and withdrawals: review endpoint (5.6) |
| | Reviews, Findings, Knowledge, System sections; multi-user identity; hosting at a separate address |
