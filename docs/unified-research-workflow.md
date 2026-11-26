# T-149: One research workflow (architectural authority)

**Status: DESIGN, APPROVED as the architectural authority (A16, 2026-11-26). Implementation stages remain individually gated (section 10).**
- No implementation, no migration, no production change.
- When approved, this document is the authority for identities, schemas, provenance and the research lifecycle. Every other design
  (5.0 discovery, T-040/T-041, T-144 memory, 5.3 protocol representation, the Priority Engine, APEX, Weirdness, domain packs) conforms
  to it or records a conflict here.
- Basis: branch `claude/structural-validation-and-workflow` (audit state `d61b22b`); `docs/roadmap-reconciliation-2026-11-26.md`.

Supporting designs that conform to this one:
- `docs/discovery-intake-design.md` (5.0)
- `docs/research-memory-design.md` (5.1 / T-144)
- `docs/protocol-representation-design.md` (5.3)
- `docs/acquisition-verification-2026-11-26.md` (5.2)
- `docs/opportunity-model-review.md` and `docs/opportunity-model-decisions.md` (T-040/T-041, amended by section 6.1 below)

---

## 1. The one lifecycle

```
OBSERVE                         UNDERSTAND                                    HYPOTHESISE / INVESTIGATE
 sources ─┐                      ┌──────────────────────────────────────┐      ┌──────────────────────────────┐
 URL      ├─► observation ─► opportunity ─► project/program/repository ─► │ research_run (repository_research)   │
 manual  ─┘   (claim+prov.)   (ranked)      identity (verified)         │  1 acquire  → repo_snapshot (sealed)  │
                 ▲                │                                      │  2 map      → protocol_model (5.3)    │
                 │                │ human selects (approve)              │  3 analyse  → hypotheses + evidence   │
   Priority ◄────┼────────────────┘                                      │     (specialists, tools, APEX, Weird.)│
   Engine  ◄─────┼──── coverage, outcomes, effort ◄──────────┐           │  4 challenge→ evaluations (independent)│
 (IMPROVE)       │                                           │           │  5 review   → human reviews           │
                 │                                REMEMBER   │           │  6 outcome  → hypothesis_outcomes     │
                 │                     research memory (T-144): outcomes,│  7 dossier  → dossier (from records)  │
                 └──────── monitor (change) ◄──── coverage, effort, adjudications, contributions ◄──────┘
                                                                 CHALLENGE / VERIFY
```

Stage by stage. Each is a workflow step of one run type, `repository_research`, writing only to the shared store:

| # | Stage (loop verb) | Input | Output record(s) | Writer plane |
|---|---|---|---|---|
| 0 | **Intake** (Observe) | source poll (disabled), discovery approval, URL, manual import | `discovery_observations` → `bounty_opportunities` + events | system / human |
| 1 | **Identify** (Understand) | opportunity | project, program (`programs`), repository identity, `program_repository` claims | system claims, human confirmation |
| 2 | **Select** (Prioritise) | ranked opportunities | `priority_assessment`; human `approved` event → research run | engine ranks, **human selects** |
| 3 | **Acquire** | repository + ref | `repo_snapshots` (sealed, commit-pinned, manifest, per-file git object ids) | system |
| 4 | **Map** (Understand) | sealed snapshot | `protocol_model` (5.3), function-level index | system (deterministic, versioned) |
| 5 | **Analyse** (Hypothesise / Investigate) | snapshot + protocol model + memory | `hypotheses`, `hypothesis_evidence`, `research_coverage`, `research_effort`, `hypothesis_contributions` | generated plane |
| 6 | **Challenge** | hypothesis | `hypothesis_evaluations` (+ counterexample artifact) | independent-evidence plane (evaluator ≠ generator) |
| 7 | **Review** (Verify) | hypothesis + evaluations | `hypothesis_reviews` (blinded or disclosed) | human plane |
| 8 | **Outcome** (Remember) | reviews + evaluations | `hypothesis_outcomes` (confirmed, refuted, inconclusive, duplicate, missed), `ground_truth_adjudications` | human plane (database rules) |
| 9 | **Dossier** | stored records only | dossier (content-hashed) | system |
| 10 | **Improve** | outcomes, coverage, effort | Priority Engine inputs; evidence-gated learning (T-056, preregistered) | offline, gated |

**Invariants of the lifecycle:**
- **L1.** There is exactly one research run type. Every entry point ends at stage 3. No hypothesis exists outside `hypotheses`, and no
  code-derived record exists without a sealed snapshot.
- **L2.** Stages 5–6 may run several producers (specialists, toolchain, APEX, Weirdness). They all write the same tables under their own
  component identity (`hypothesis_contributions`, `generator_kind/id/version`). None keeps private state that others cannot read.
- **L3.** Only stage 8, with an independent supporting evaluation **and** a human `supports` review, can produce `confirmed`.
- **L4.** Selection (stage 2) is a human act until the owner decides otherwise. The Priority Engine ranks; it does not select.
- **L5.** Passive only. Active testing needs the existing fail-closed gate (`scope-guard.ts`: active program, verified scope version,
  in-scope asset, approved non-expired approval) and is out of scope for this design.

## 2. Current state: two pipelines and a dormant third model (evidence)

| | Intake chain (legacy) | `repository_research` (structural) | Migration 0001 domain model |
|---|---|---|---|
| Entry | `POST /v1/intake` (URL or idea) | discovery approval (`approveOpportunity` → `createRepositoryResearchRunIn`) or a direct run | none |
| Steps | resolve_source → identify_project (1 GitHub API call) → locate_official_repositories (**samples ≤20 files by branch name, unpinned**) → establish_authorization (always `unverified`) → map_attack_surface (**10 regex rules**) → generate_hypotheses (**9 templates**) → independent_challenge (**checklist**, no refutation) → prepare_research_brief | acquire_repository (**sealed, commit-pinned, verified**) → analyze_structure → challenge_leads → build_dossier (switch `STRUCTURAL_ANALYSIS_ENABLED`, default off) | — |
| Snapshot store | `source_snapshots` (0006): JSON content per URL, hash-linked, immutable | `repo_snapshots` + `repo_snapshot_files` + `research_blobs` (0007) | — |
| Hypotheses | inside **step output JSON** | `hypotheses` / evidence / evaluations / reviews (0007) | `findings`, `finding_evidence`, `verification_reviews` (**no writers**) |
| Programs and scope | not created | not linked | `programs`, `program_scope_versions`, `assets`, `program_assets`, `approvals`: **used by the active-testing gate** (`scope-guard.ts`), no API creates them |
| Memory | none | 0007 records | `knowledge_items`, `knowledge_links` (**no writers**) |
| Level (reconciliation scale) | 4 (scaffolding, honestly labelled) | 4 (one real repository, development) | 2/3 (schema; gate tested) |

**Conclusion.** The structural pipeline is the correct spine: sealed snapshots, the research store, real analysis and challenge. The
intake chain contributes only its front end (URL classification, project identification). The 0001 program and scope tables are the
correct home for **program and scope identity**, because the active-testing gate already depends on them. T-040's proposal to create a
new `program` table would duplicate them, so it is **amended** (section 6.1).

## 3. Canonical identities

| Identity | Canonical record | Key | Notes |
|---|---|---|---|
| Source | `discovery_sources` (0008, extended) | `source_key` | Adds `access_method`, `terms_status` (T-040) |
| Observation | `discovery_observations` (0008, extended) | uuid | Adds `provenance_kind` (fetched/operator_supplied), `completeness`, `adapter_version` |
| Program (a bounty or contest listing) | **`programs` (0001, extended)** | `(platform, platform_program_id)` unique | Adds `platform_program_id`, `project_id`, `first_observation_id`. `status` (draft/active/paused/closed) stays the gate's status |
| Program claims over time | **`program_scope_versions` (0001, extended)** | `(program_id, version)` | `scope_document` holds the claims; adds `observation_id`, `claims_status` (claimed / confirmed_by_human). `verified_at/by` stays the human confirmation the gate requires |
| Project (the real-world protocol) | `projects` (new) + `project_merges` (new, append-only) | uuid | D1/D2: provisional per program, merged by evidence or a human, never by name |
| Repository | `repositories` (new) + `repository_aliases` | `host/owner/name` lower-cased | One row per repository, however many programs cite it |
| Program ↔ repository | `program_repositories` (new) | `(program_id, repository_id, signal)` | Claims with confidence; confirmation is an event |
| Asset in scope | `assets` / `program_assets` (0001) | existing | A repository-at-commit asset links `repositories` + commit; no second asset model |
| Opportunity (what is ranked and selected) | `bounty_opportunities` (0008, extended in place, D7) | uuid | Adds `program_id`, `project_id`; events unchanged |
| Research run | `workflow_runs` with `workflow_type='repository_research'` | uuid | The only research run type. Intake runs become front-end runs that hand over (section 5) |
| Commit and snapshot | `repo_snapshots` (0007) | uuid; `(repository, commit_sha)` + manifest hash | **The only snapshot system.** Adds `repository_id` |
| Protocol model (5.3) | `protocol_models` (new) + content blob in `research_blobs` | `(snapshot_id, model_version)` | Deterministic, derived, re-buildable |
| Hypothesis, evidence, evaluation, review | 0007 tables | existing | Unchanged meaning |
| Outcome, coverage, effort, adjudication, contribution | T-144 tables | | `research-memory-design.md` |
| Finding (a confirmed, reportable vulnerability) | **`findings` (0001, repurposed, additive)** | uuid | Adds `hypothesis_outcome_id NOT NULL` (on new rows) and `snapshot_id`: a finding row can only exist for a **confirmed** outcome; `status` keeps the disclosure states (verified → reported → resolved). 0001 has no writers, so no existing row conflicts; checked by the migration (section 5) |

## 4. Provenance rules (apply to every table, enforced where the database can)

- **P1. Code claims are pinned.** Any record about code names a sealed `repo_snapshots` row (commit SHA, manifest hash) and, where it
  concerns a component, the component's content hash.
- **P2. Source claims are attributed.** Any record derived from a source names its `discovery_observations` row, including
  operator-supplied input. Nothing is labelled fetched that was pasted.
- **P3. Three planes.** Generated (analyzers, models, APEX, Weirdness, specialists), independent evidence (evaluator ≠ generator,
  enforced) and human adjudication (`*_kind = 'human'` with an identity) never mix. A model can never write a human-plane row.
- **P4. Append-only.** Corrections are new rows that supersede; existing triggers are reused.
- **P5. Versioned producers.** Every generated or evaluated record carries producer kind, id and version; every derived artifact
  carries its builder version and input hashes.
- **P6. Content addressing.** Bytes live once in `research_blobs`; records point by SHA-256.
- **P7. Confirmation rule.** Only L3 produces `confirmed`. A `findings` row requires a `confirmed` outcome.
- **P8. Honest absence.** Not examined, abstained, not modelled and out of scope are distinct records, never inferred from silence.
- **S1 caveat (unchanged).** "Human" rows are only as trustworthy as the runtime role until T-061.

## 5. Convergence and migration of existing records (no loss of history)

**Expand → dual-path → switch → contract.** Each stage is a separate, approved, expand-only migration; nothing is dropped until a later
contract step that has its own approval.

| Existing thing | Fate | How history is preserved |
|---|---|---|
| Intake steps `resolve_source`, `identify_project` | **Kept** as the intake front end; `identify_project` writes a project, repository and opportunity claim, then **creates a `repository_research` run** (handover) | Old runs untouched |
| `locate_official_repositories` (unpinned sampling), `map_attack_surface` (regex), `generate_hypotheses` (templates), `independent_challenge` (checklist), `prepare_research_brief` | **Kept running until replaced (owner condition, A18 deferred).** They are switched off only after the new intake path passes the **behavioural-equivalence tests** below; code is removed only at the contract step | Historical runs, step outputs and `source_snapshots` stay **readable**. Template hypotheses are **preserved as historical records**, presented as `legacy_template`, **non-validated**: never a hypothesis in the research store, never evidence, never an outcome, never a learning input |
| `establish_authorization` | Folded into the run as a **passive authorization record** that reads the 0001 scope tables (still `unverified` until a human confirms scope) | — |
| `source_snapshots` (0006) | **Frozen**: no new writers after the switch; remains as historical evidence | Rows immutable (existing trigger) |
| 0001 `programs`, scope, assets, approvals | **Extended** (canonical program and scope identity) | Additive columns |
| 0001 `findings`, `finding_evidence`, `verification_reviews` | `findings` **repurposed additively** (confirmed-only); `finding_evidence` and `verification_reviews` **deprecated** in favour of 0007 evidence and reviews | The migration first **asserts these tables are empty** and aborts otherwise, so nothing is silently reinterpreted |
| 0001 `knowledge_items`, `knowledge_links` | **Deprecated** in favour of T-144 memory | Same emptiness assertion |
| 0008 discovery tables | **Extended in place** (D7) | Events unchanged; hash checked |
| 0007 research store | **Unchanged meaning**; adds `repository_id` to snapshots | — |

**Behavioural-equivalence tests (gate for A18).** For every input the old chain accepts (GitHub repository URL, GitHub URL with a path or ref, X post URL, web URL, free-text idea), the new path must:
- accept or decline it **identically**;
- reach the same project and repository identity (GitHub cases);
- produce a sealed snapshot of a superset of the files the old chain sampled;
- surface at least the old chain's rule families as coverage or leads (the regex families are a floor, not the target);
- leave non-GitHub inputs with an explicit, recorded "cannot acquire yet" outcome instead of silently dropping them.

The old stages are switched off only when all of these pass on development fixtures and on the approved real repository.

**Rollback.** Every expand step leaves the old code working: the previous release runs against the expanded schema. The switch is a
configuration flag; turning it back restores the old scheduling. Contract steps (drops) are separate and late.

## 6. Conflicts found and how they are resolved

### 6.1 T-040 `program` vs 0001 `programs` (amends T-040 and the D1–D9 brief)
T-040 proposed new `program` and `program_version` tables. 0001 already has `programs` and `program_scope_versions`, used by the
active-testing gate. **Resolution:** reuse and extend the 0001 tables; `program_version` becomes `program_scope_versions` with an
`observation_id`.
- D1, D2 and D4–D9 are unaffected.
- **D3 is restated:** "one observation per scope version".

This is recorded as new decision **D10**. It needs owner confirmation.

### 6.2 Further conflicts
| Conflict | Resolution |
|---|---|
| `findings` vs `hypothesis_outcomes` | A finding is a confirmed outcome plus disclosure state; `findings` references the outcome (section 3) |
| Intake runs vs research runs | Intake becomes a front end that hands over; one research run type |
| Template "independent_challenge" vs real challenge | Retired; challenge means an evaluation by an evaluator ≠ generator |
| `opportunity_events` "approved" vs selection | Selection is the human `approved` event that creates the research run (unchanged) |

## 7. How later capabilities attach (one context, one memory)

| Capability | Reads | Writes | Must not |
|---|---|---|---|
| 5.4 structural analysis | snapshot, protocol model | hypotheses, evidence, coverage, effort | keep state outside the store |
| 5.4B toolchain (Slither, Foundry, ...) | snapshot | evaluations as independent evidence, or hypotheses as a tool generator | run outside the sandbox design; execute repository code on the host |
| 5.5 specialists | protocol model, memory | hypotheses (per specialist identity), contributions | — |
| 5.5A Weirdness | protocol model, coverage, outcomes | hypotheses or anomaly signals as contributions | have a private store (definition pending) |
| 5.6 challenge and review | hypotheses, evidence | evaluations, reviews | judge its own hypotheses (enforced) |
| 5.7 dossiers | stored records only | dossier | fetch or infer |
| 5.8 benchmarks | frozen corpora; adjudications | results, registry | tune on sealed sets |
| Priority Engine | opportunities, coverage, outcomes, effort | `priority_assessment`, `priority_allocation` | select or steer (L4) |
| Control Room | everything, read-only | none | — |
| APEX | protocol model, memory (refutations, misses, coverage gaps) | hypotheses, contributions, counterexamples | own a memory (T-151 must conform) |
| Domain packs (MD) | domain-specific protocol model behind the same interfaces | same tables | — |

## 8. Gap tests
`apps/api/src/architecture-gaps.test.ts` holds **expected-failing** tests (`it.fails`). Each states the target behaviour and fails
today, so the suite stays green while the gap exists. When a gap is closed, its test must be flipped to a normal `it`.

## 9. Acceptance criteria for T-149 implementation (when approved)
- **AC1.** URL intake, discovery approval and manual import all end in one `repository_research` run with a sealed snapshot. Gap test 1.
- **AC2.** No new hypothesis is written outside `hypotheses`; the retired legacy steps are not scheduled. Gap test 2.
- **AC3.** A human review can be recorded through the API, and an outcome through T-144, with P3 and P7 enforced in the database.
  Gap tests 3 and 4.
- **AC4.** A single program identity (0001 extended) and a single snapshot system (0007); `source_snapshots` gets no new rows after the
  switch. Gap test 5.
- **AC5.** A protocol model exists per snapshot and is consumed by analysis. Gap test 6.
- **AC6.** Every legacy run, step output and `source_snapshots` row remains readable after migration; event hashes are unchanged.
- **AC7.** The full verify passes as owner and restricted role; mutation specs cover the new guards.

## 10. Staged implementation plan (each stage gated as shown)

| Stage | Content | Gate |
|---|---|---|
| S0 | This design, gap tests, conforming designs (done in this cycle) | Owner approval of T-149 (A16) and D10 |
| S1 | T-144 migration **draft** (memory): **done 2026-11-26** in `db/drafts/t144-research-memory/` (14 throwaway-database tests, 10/10 rule mutants killed). T-041 migration draft (identity, amended per D10): waits for D1–D9 | T-144: A4 (approved). T-041: A5–A13. **Each draft is applied to production only by its own later decision** (A4b, A21) |
| S2 | Human-review and outcome API (stages 7–8), with S1 caveat visible | S1 drafts approved |
| S3 | Intake handover: `identify_project` creates the research run; the legacy stages are switched off **only after the behavioural-equivalence tests pass** | A18 (**deferred**) |
| S4 | Protocol model v1 (5.3), **incremental**: P1–P3 first (`docs/protocol-model-p1-p3-plan.md`). Each step must produce evidence-backed output **and** have at least one real consumer that measurably uses it; stop/go review after P3 | A20 (approved for design and staged plan) |
| S5 | Live 5.2 check through the GitHub API (T-010) | A15 (environment) |
| S6 | Apply migrations anywhere other than disposable databases | Separate approval per environment |
| S7 | Contract step (drop retired code; deprecate empty tables) | Separate approval, after soak |
