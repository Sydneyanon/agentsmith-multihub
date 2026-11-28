# Live hub visibility for the first USX run (2026-11-28; code study of `dev/research-readiness` at abe25a9)

Rule: every status shown comes from a stored record. Nothing is simulated or inferred.
- The hub refreshes by polling (`apps/web/src/live.ts`) and prints the server's computation time with each view.
- A failed refresh shows "stale since …", never "live".
- The Control Room shows "running" only for a step whose lease is live (`view-control.ts`, `/v1/engine/status`).

Status key:
- **VISIBLE:** recorded and rendered in the hub today.
- **RECORDED:** stored, but not rendered, or rendered only as a generic audit line.
- **NOT RECORDED:** not stored at all.

| stage | record (real event) | endpoint | hub view | status |
|---|---|---|---|---|
| programme collection | `bounty_collection_runs`, `bounty_source_checks`, `bounty_programs` | `/v1/bounties/*`, `/public/bounties.json` | Bounties tab, public page, TV board | **VISIBLE** |
| repository verification | `bounty_repository_mappings` (source URL, evidence, GitHub id, verification status) | `/v1/bounties/enrichment`, `/v1/bounties/:id` | Bounties tab (enrichment) | **VISIBLE** |
| programme → run link (targeted promotion) | `bounty_research_links` (programme, repository, ref = pinned commit, run) | none for the link itself | not shown on the research side | **RECORDED** |
| run created, with official scope | `workflow_runs.input` (`ref`, `bounty_scope`); audit `repository_research.created` | `/v1/research/projects/:id`, `/v1/research/activity` | Projects; Activity (audit line) | VISIBLE for the run; **the scope is RECORDED but not shown** |
| each stage claimed, succeeded or failed | `workflow_steps` (status, lease, output); audit `workflow_step.claimed`, `.succeeded`, `.failed`, `.lease_exhausted` | `/v1/research/projects/:id`, `/v1/engine/status`, `/v1/research/activity` | Projects (steps), Control Room (live lease, queue), Activity | **VISIBLE** |
| snapshot sealed at a commit | `repo_snapshots` (commit, manifest, `sealed_at`), `repo_snapshot_files` | `/v1/research/snapshots[/:id]`, `/files`, `/file` | Repository view (files, manifest) | **VISIBLE** |
| D2: GitHub verification of the uploaded content | the verification evidence D2 will store (resolved commit, tree, per-file result) | to be added | — | **NOT RECORDED** (D2 in progress) |
| analysis stages and coverage | the `analyze_structure` output (contracts, functions, problems, protocol-model hash); the dossier's `coverage` | `/v1/research/projects/:id`, `/v1/research/snapshots/:id/dossier` | Projects (step output); **coverage is not rendered** | **RECORDED** |
| hypothesis generation | `hypotheses`, `hypothesis_evidence`, `evidence_spans`; trigger event `registered` | `/v1/research/hypotheses[/:id]`, `/v1/research/evidence[/:id]`, `/v1/research/activity` | Hypotheses, Evidence, Activity | **VISIBLE** |
| tool execution (Slither, when enabled) | the `slither_scan` step (status, outcome or abstention code); the dossier's `coverage.external_tools` | as above | step status visible; **abstention and tool details are not rendered** | **RECORDED** |
| validation | `hypothesis_evaluations` (evaluator, outcome, rationale); trigger event `evaluation_recorded`; the `hypothesis_status` view | `/v1/research/hypotheses/:id`, `/v1/research/activity` | Hypotheses (status, assessment), Activity | **VISIBLE**. Analysis families and same- versus cross-family relations (foundations D) are **not yet rendered**. |
| D1: API-run validation, and the worker's untrusted proposals | evaluations recorded by the API; proposals stored separately (D1, in progress) | to be confirmed | — | in progress |
| reproduction | none on the production path: Foundry is unavailable there, and the dossier says `reproduction: "none"` | dossier | — | **NOT RECORDED in production** (honestly absent) |
| evidence recording | `evidence_spans` (hash-verified), `research_blobs` | `/v1/research/evidence[/:id]` | Evidence | **VISIBLE** |
| final assessment (dossier) | the `build_dossier` step output (content hash, leads, status counts); dossier JSON with coverage, analyzer and build, `bounty_scope`, per-lead `assessment`, `origin`, supporting and contradicting evidence, `scope_status`, limitations | `/v1/research/snapshots/:id/dossier` | Architecture view renders **only the architecture section** | **RECORDED: the dossier body is not rendered** |
| D: worker API calls | `audit_events` `worker_api.*` (accepted, refused, replayed: token id, operation, step, outcome) | `/v1/research/activity` | Activity (generic audit lines) | will be RECORDED and shown generically once D is merged |

## Gaps to close before the run, so it can be watched end to end
1. **Dossier view** (web only; no new data): render
   - coverage status and problems, plus external tools and abstentions;
   - analyzer and build identity;
   - the bounty scope (evidence, hash, counts);
   - per lead: the assessment verdict, the **in or out of scope** label, origin (generator and family), and supporting and
     contradicting evidence with family relations;
   - reproduction, shown as "none" when there is none;
   - uncertainty and limitations.

   Source: `/v1/research/snapshots/:id/dossier`, which already returns these fields.
2. **Programme link and scope on the project page:** the `bounty_research_links` row (programme, pinned commit) and
   `input.bounty_scope`. This needs one read-only addition to `/v1/research/projects/:id`.
3. **D2 verification evidence and D1 provenance:** shown once D's fixes define the records. This is planned after D's merge, so
   the views read the final fields.

**Order:** these are small and read-only. They are built after D's fixes land on the dev branch, because D1–D3 change what the dossier
records. They are then checked with a local rehearsal: the targeted USX-like integration fixture, a real API process and the hub in a
browser, with screenshots of each stage taken from real records.
