# Execution plan towards one research engine (2026-11-26; conforms to T-149)

**Authority and scope.** Grounded in `docs/roadmap-reconciliation-2026-11-26.md` and the approvals in the decision log. Every milestone
names the evidence that proves it; a design or passing unit tests do not.

**North-star metric:** independently confirmed, **non-duplicate** vulnerabilities per unit of research time and cost (ROADMAP decision M). Reported alongside: duplicate rate, and precision, recall and misses per vulnerability class. It is **not measurable yet**, because
nothing can record a confirmed outcome (T-144 is not applied; there is no review API). Until then progress is shown by the milestone
evidence below and by sealed-corpus measurements.

## 1. Where things stand (evidence, not intent)

| Area | Demonstrated today | Level |
|---|---|---|
| Analyzer (5.4/5.5, seven classes) | Four sealed corpora scored once each. Corpus 4 (2026-11-26): candidate 3 clear labels precision 1.00, recall 0.69; baseline 0.67 / 0.34 | **5 (independent, synthetic corpora)** |
| Challenge (5.6) | Execution validators for six classes; reentrancy cross-checked against EVM ground truth; two validator errors found by adjudication and fixed (V1–V3), confirmed directionally on corpus 4 | 4 |
| Acquisition (5.2) | Clone path reproducible on a real repository (identical manifests and dossiers across independent runs); GitHub API path never live | 4 (clone) / unverified (API) |
| Protocol model (5.3) | **P1 built**: stored per analysis, consumed by the dossier and by Priority Engine coverage units; identical across independent real runs | 4 |
| Research memory (5.1 / T-144) | Design approved; migration **draft** tested on throwaway databases (14 tests, both roles, 10/10 rule mutants) | 2 (draft, not applied) |
| One workflow (T-149) | Design approved as authority; 8 gap tests pin the remaining gaps | 2 |
| Discovery (5.0) | One GitHub-organisation adapter, never live; multi-source not started | 4 / 1 |
| Priority Engine | Fixtures and synthetic replay only; diagnosis recorded | 4 |
| Human review, outcomes, learning | Not operational | 1–3 |

## 2. Milestones in dependency order, with acceptance criteria

| # | Milestone | Depends on | Gate | Accepted when (evidence) |
|---|---|---|---|---|
| M1 | P1 protocol model | — | A20 (P1) ✅ | Done in development (`protocol-model-p1-evidence.md`); **owner stop/go before P2** |
| M2 | T-041 identity migration **draft** (D10 plus D1–D9) | D1–D9 decisions | A5–A13 ⏸ | Throwaway-database tests: 0008 data backfilled losslessly; existing discovery suites pass unchanged; scope guard unchanged; both roles; rollback exact; mutation spec |
| M3 | Human-review and outcome API (T-149 S2) | M2 not required; the T-144 draft **is** required | S2 approval ⏸ | See section 3 |
| M4 | Intake handover (T-149 S3) | M2, M3 | A18 ⏸ (deferred) | Behavioural-equivalence tests pass for every input kind; legacy history readable; gap tests 1, 2, 5 flip |
| M5 | Live 5.2 GitHub API check | — | A15 ⏸ | API-path manifest equals the clone path's `b0d4fb23…` on the same commit; bad ref classified |
| M6 | P2 then P3 (roles, trust boundaries) | M1 review | P2, P3 approvals ⏸ | Per the plan: private derivations deleted, no regression on development data, new class C/G/H fixtures improve |
| M7 | Migrations applied to a real environment (T-144, then T-041) | M2, M3 drafts reviewed | A4b, A21 ⏸ | Applied by the runner with backup; verification and grants checks pass |
| M8 | First adjudicated outcome on real code | M3, M7, a worker | owner (worker, environment) ⏸ | A hypothesis on an approved repository goes through independent evaluation and a human review, and is recorded as an outcome. **This is the first point at which the north-star metric can be measured** |
| M9 | Toolchain sandbox (5.4B) and tool baselines | M1 | sandbox design approval ⏸ | Isolated, resource-limited, audited runner; Slither (and later Foundry) results recorded as evidence and as a comparison baseline on a sealed corpus |
| M10 | Analyzer classes B–H | — | development (no approval needed) | Fixtures written for each class; no regression; **measured only on a new sealed corpus 5** |
| M11 | Priority Engine revised experiment (T-057b) | — | A14 ⏸ | Preregistered; v2 beats changed-code-first and v1 on held-out seeds; synthetic results labelled as such |
| Later | Learning (T-056), Weirdness definition, APEX (T-151), multi-domain | M8, and M6 for the shared representation | owner | Not before the foundation runs on real, adjudicated outcomes |

## 3. T-149 stage S2, the human-review and outcome API: exact scope (NOT approved; for decision)

**What it adds:**
1. `POST /v1/research/hypotheses/:id/reviews`: record a human review (blinded or disclosed) through the existing
   `ResearchStore.recordReview`. Bearer-protected and rate-limited. The reviewer identity comes from the authenticated operator.
2. `POST /v1/research/hypotheses/:id/outcomes`: record an outcome (confirmed, refuted, inconclusive, duplicate, missed) into
   `hypothesis_outcomes`, citing the basis evaluations and review.
3. Read endpoints: a hypothesis's outcomes; coverage and effort for a snapshot.
4. Optionally, `POST /v1/research/adjudications` for ground-truth adjudications.

**Dependencies:**

| Part | Needs | Notes |
|---|---|---|
| (1) reviews | **0007 only** (no new schema) | Could be built and tested **without** the T-144 draft |
| (2)–(4) outcomes, coverage, effort, adjudications | **the T-144 schema** | Locally this means tests on throwaway databases with the **draft applied by the test**, as the draft's own test does. The code would be inert anywhere the draft is not applied |
| All parts | S1 / T-061 | "Human" means the holder of the operator bearer token until a separate role exists for human decisions; the API would say so |

**Proposed separation for approval:**
- **(a)** Build (1) now against 0007, tested on throwaway databases.
- **(b)** Build (2)–(4) behind a switch that is off by default, tested on throwaway databases with the draft applied.
- **(c)** Production use requires A4b (apply T-144) and a deployment decision.

Neither (a) nor (b) applies any migration.

## 4. D1–D9, presented individually (`docs/opportunity-model-decisions.md` has alternatives and consequences per dimension)

| # | Decision | Recommendation | What approving it alone enables |
|---|---|---|---|
| D1 | What is a newly discovered program's project? | A provisional project per program, created with it | Every opportunity has a project from the start; no name-based merges |
| D2 | How are two projects merged? | Append-only merge rows resolved through a view; a split is a new event | Dedupe without rewriting history |
| D3 | Field provenance (restated under D10) | One observation per **scope version**, typed claim columns plus `claims jsonb` | Every displayed program field traces to exactly one observation |
| D4 | Reopening a dismissed opportunity | Only by a human `reopened` event; approved and queued stay immutable | One guarded transition added to the existing guard |
| D5 | Stored name of the selected state | Keep `approved` | No rewrite of existing events |
| D6 | How a program becomes "ended" | Derived at read time from its end date, plus source-stated closure | No scheduled job or polling |
| D7 | Extend or replace `bounty_opportunities` | Extend in place, expand-only | Existing code, events and grants keep working; rollback without schema change |
| D8 | Priority records in T-041 | Include assessments and allocations (with the exploration-quota carry) | Auditable scores; nothing steers |
| D9 | T-144 inside T-041? | Separate migrations | Independent review and rollback |

Each can be approved or changed on its own. The T-041 draft (M2) needs all nine settled, because they shape its tables.

## 5. Parallel tracks (no competing schemas)
- **Track A (foundation):** M2 → M3 → M4 → M7 → M8. Every schema change goes through the T-144 and T-041 drafts only.
- **Track B (evaluation):** done for corpus 4. Next: commission and seal corpus 5 before any further improvement claim. M10 work is
  measured only there.
- **Track C (architecture):** M1 done, stop/go review pending; M6 after approval. Each step must replace a private derivation in a real
  consumer.

**Must not start yet:** learning, live prioritisation, polling, Weirdness, APEX, multi-domain, production changes.
