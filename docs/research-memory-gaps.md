# Research outcomes and memory: what the shared research model records, and the smallest additions (2026-11-26)

Status: **review and proposal only. No migration is written or applied.** One shared research model (5.1) serves every component (structural analysis, specialists, APEX, the Weirdness Engine, independent challenge, the Priority Engine and the Control Room). Nothing here creates a separate memory per specialist or engine.

## 1. What is recorded today (checked against `db/migrations/0007_research_state.sql` and the analysis pipeline)
| Requirement | Recorded today | Where | Gap |
|---|---|---|---|
| Hypotheses and their originating component | **Yes** | `hypotheses.generator_kind/id/version` (e.g. `deterministic_rule` / `solidity-structural-specialists` / `1`) | Only ONE originator; components that *contributed* evidence or a lead (APEX, Weirdness Engine, a specialist) cannot be recorded |
| Supporting evidence | **Yes** | `hypothesis_evidence` with roles primary / supporting / context, each a hash-verified span | none |
| Contradictory evidence | **Partly** | spans cited by an evaluation that `weakens` or `contradicts` (`evaluation_evidence`) | no way to attach contradicting evidence that is not an evaluation (e.g. a human's counter-citation outside a review) |
| Independent challenge results | **Yes, as text** | `hypothesis_evaluations` (`supports` / `weakens` / `contradicts` / `inconclusive`, evaluator id and version, input hash) | the execution trace, scenario parameters and reproducibility data live only in the 8,000-character rationale text; no structured, re-runnable counterexample artifact |
| Human adjudication | **Yes** | `hypothesis_reviews` (`reviewer_kind = human`, `review_mode = disclosed_adjudication`, verdict `supports` / `rejects` / `needs_more_evidence` / `inconclusive`, `reviewer_saw`) | none for the act itself |
| Confirmed / refuted / inconclusive / duplicate outcomes | **No explicit outcome** | `hypothesis_status` derives a status from evaluations and reviews | there is no recorded *outcome* in the owner's five categories; "confirmed" (independently validated **and** human-adjudicated) is not representable as such; **duplicate** (already known or reported) has no representation at all |
| Missed findings | **No** | none | a vulnerability independently discovered later, in code AgentSmith had researched, cannot be linked to the runs that missed it |
| Research time | **Yes, per step** | `workflow_steps.started_at / completed_at` | not per component or per method |
| Computational cost | **Model spend only** | AI budget ledger (reservations) | CPU, wall time and analysis effort are not recorded in a standard form |
| What was investigated | **Partly** | hypotheses; the `analyze_structure` step output carries the structural map (functions, guards, calls, writes) and the analyzer version | no coverage record keyed by component version, vulnerability class and method, so "examined and found nothing" is indistinguishable from "never examined" |
| What remained unexplored | **No** | abstentions appear as `inconclusive` evaluations; unparsed constructs as `problems` in step output | no explicit record of not-modelled code, abstained classes or out-of-scope components |

## 2. The smallest coherent additions (proposed; each needs design and migration approval)
All are append-only, live in the existing 5.1 store, reuse existing ids, and follow the existing least-privilege grants and append-only triggers. Proposed as one task, **T-144 (research outcomes and coverage records)**, using a free ID.

1. **`hypothesis_outcomes`** (append-only): `hypothesis_id`, `category` in the owner's five categories (`confirmed`, `refuted`, `inconclusive`, `duplicate`, `missed`), `decided_by` (human id), `basis` (evaluation ids and review id), `duplicate_of` (hypothesis id or an external reference), `recorded_at`. **Database rule:** `confirmed` requires at least one `supports` evaluation from an evaluator different from the generator **and** a human `disclosed_adjudication` review with verdict `supports`. This is the only place a discovery label is born; learning (T-056) reads only `confirmed` rows. The code-level policy already exists and is tested (`apps/api/src/priority/outcomes.ts`).
2. **Missed findings** reuse (1): a human records a hypothesis (generator `human`) describing the later-discovered vulnerability on the snapshot that was researched, with outcome `missed`, plus `missed_in_runs` (the workflow runs whose coverage included that component). No separate table.
3. **`research_coverage`** (append-only): `snapshot_id`, component path and **content hash** (function-level hash from the structural index), `vulnerability_class`, `method` (analyzer or validator id and version), `result` (`examined`, `abstained`, `not_modelled`, `out_of_scope`), `workflow_run_id`, `effort` (wall ms, CPU ms). Written by the analysis and challenge steps. This one table serves three consumers: the Priority Engine's version-aware saturation (T-052), APEX discovery memory (T-160) and the Control Room's "what was not explored".
4. **Structured counterexamples:** an optional `artifact_sha256` on `hypothesis_evaluations`, pointing at a content-addressed blob (the existing `research_blobs`) holding the trace, scenario parameters and reproduction recipe.
5. **Contributing components:** `hypothesis_contributions` (append-only: hypothesis, component id and version, role `originated` / `contributed_evidence` / `challenged`). Deferred to T-151 (APEX architecture), because its shape depends on how APEX and the Weirdness Engine exchange signals.
6. **Cost convention without a migration:** every analysis step output carries `cost: { wall_ms, cpu_ms, model_usd_reserved }`, checked by a test.

## 3. What this does not do
No per-engine memory; no learning; no automatic "confirmed"; no change to the existing tables' meaning. Until these additions exist, outcomes, missed findings and coverage are **not recorded**, and no report should imply that they are.
