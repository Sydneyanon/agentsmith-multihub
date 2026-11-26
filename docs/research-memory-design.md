# Shared research memory: design proposal (T-144)

**Status: design proposal for review, 2026-11-26. Conforms to T-149 (`unified-research-workflow.md`), which is the authority for identities and provenance; a reportable finding is a `findings` row (0001, repurposed) that references a `confirmed` outcome (T-149 section 3).** No migration is written or applied. This extends the gap review in
`docs/research-memory-gaps.md` into a concrete design. It needs design approval, then a separate migration approval.

## 1. Principles
1. **One memory.** Everything lives in the existing 5.1 research store, keyed by the existing identifiers. APEX, the Weirdness Engine,
   specialists, validators and the Priority Engine all read and write the **same** tables, through a component identity; none keeps
   a private store or cache of truth.
2. **Three provenance planes that never mix.** Every record belongs to exactly one, enforced by database constraints:

   | Plane | What it is | Who writes it | Can it make something "confirmed"? |
   |---|---|---|---|
   | **Generated** | hypotheses, leads, coverage claims made by analyzers or models | `generator_kind` ∈ deterministic_rule, model, apex, weirdness, specialist | no |
   | **Independent evidence** | evaluations by a method different from the generator (execution, compiler-backed EVM, independent assessor) | evaluator ≠ generator, enforced | contributes, not alone |
   | **Human adjudication** | a human's recorded decision with what they saw | `reviewer_kind = human` with an identity | required for `confirmed` |

   Model output is never stored as evidence or adjudication. An assessor agent's report (as in `eval/adjudications/`) is
   *independent evidence* with `evaluator_kind = model`, never a human decision.
3. **Append-only with exact provenance.** Every record names the `repo_snapshots` row: repository, commit SHA and manifest hash. Where
   it concerns code, it also names the component content hash. Corrections are new rows that point at what they supersede.
4. **Absence is recorded, not inferred.** "Examined and nothing found", "not examined", "could not model" and "out of scope" are
   different rows.

## 2. Requirement → record

| Must preserve | Record | Notes |
|---|---|---|
| Confirmed findings | `hypothesis_outcomes(category='confirmed')` | Database rule: needs ≥1 `supports` evaluation by an evaluator ≠ generator **and** a human `disclosed_adjudication` review with verdict `supports`. The only place a discovery label is born; T-056 learning reads only these. |
| Refuted hypotheses | `hypothesis_outcomes(category='refuted')` + the refuting evaluations | A refutation by a validator later shown to be wrong (as in corpus 3) is superseded by a new outcome row and a `ground_truth_adjudications` row, never deleted. |
| Inconclusive investigations | `hypothesis_outcomes(category='inconclusive')` + `research_coverage(result='abstained'\|'not_modelled')` | The reason (for example "payable re-entry target not modelled") is structured: `reason_code` plus text. |
| Duplicate findings | `hypothesis_outcomes(category='duplicate', duplicate_of_hypothesis \| duplicate_of_external)` | `duplicate_of_external` points at an `external_references` row (audit report, public disclosure) with provenance and permitted-use fields, as in the audit-data policy. |
| Missed vulnerabilities | a hypothesis with `generator_kind='human'` on the snapshot that was researched, an outcome `missed`, and `missed_in_runs(hypothesis_id, workflow_run_id, coverage_id)` | Links the miss to the coverage rows that claimed the component was examined: the most valuable learning signal, and it stays separate from confirmed. |
| Ground-truth disputes and adjudications | **new** `ground_truth_adjudications` | Subject (a corpus label by corpus manifest sum + file/function/class, or a hypothesis), the disputing source, evidence references (evaluation ids or content-addressed artifacts), outcome (`label_upheld` / `label_overturned` / `ambiguous`), adjudicator kind and identity, human sign-off state. Mirrors `eval/adjudications/*.json` (schema `agentsmith-adjudication/1`), which can be imported verbatim. |
| Research effort and costs | `research_effort(workflow_run_id, step_id, component_id?, method, wall_ms, cpu_ms, model_usd_reserved, model_usd_spent)` | Model spend continues to come from the AI budget ledger (referenced, not duplicated). CPU and wall time come from step output under the convention in the gap review. |
| Examined and unexplored components | `research_coverage(snapshot_id, component_path, component_sha256, vulnerability_class, method, method_version, result, workflow_run_id)` | `result` is one of: examined, abstained, not_modelled, out_of_scope. This is exactly the record the T-052 model (`coverage.ts`) consumes, so coverage logic is shared and not re-implemented. |
| Exact repository and commit provenance | foreign key to `repo_snapshots` (commit SHA, manifest hash) on every row above; `component_sha256` where code is concerned | Audit claims carry their own audited commit, as in the T-052 model. |
| Which component contributed | `hypothesis_contributions(hypothesis_id, component_kind, component_id, component_version, role)` | role: originated, contributed_evidence, challenged, adjudicated. It lets APEX, Weirdness and specialists share credit without separate memories. Its shape is to be confirmed with T-151. |
| Counterexamples | `hypothesis_evaluations.artifact_sha256` → `research_blobs` | Holds the trace, scenario parameters and reproduction recipe, for example the EVM run in `eval/adjudications/`. |

## 3. Database rules (to be enforced by triggers and checks, tested as the restricted role)
- Append-only on every new table, reusing `research_reject_mutation()`.
- `confirmed` requires the conditions above. `missed` requires `generator_kind='human'` and at least one `missed_in_runs` row.
  `duplicate` requires exactly one of the two `duplicate_of` columns.
- An evaluation whose evaluator equals the generator cannot count as independent.
- A `ground_truth_adjudications` row with `adjudicator_kind <> 'human'` cannot have `human_sign_off = 'signed'`.
- Every row's `snapshot_id` must be a sealed snapshot.
- **Security (S1):** "human" rows are only as trustworthy as the runtime role, until T-061 provides a separate role or function for
  human decisions. This design does not claim to fix that.

## 4. Consumers (one shared read path each)
| Consumer | Reads |
|---|---|
| Priority Engine | `research_coverage` (through the T-052 model), `hypothesis_outcomes` (only `confirmed` as labels; the rest as evidence), `research_effort` (cost estimation) |
| APEX (T-151 and later) | coverage gaps, refutations and their counterexamples, missed findings (negative-evidence memory, the gap the prior-art review found still open), contributions |
| Weirdness Engine | the same rows, through `hypothesis_contributions` |
| Control Room | all of the above, read-only |
| Evaluation (5.8) | `ground_truth_adjudications` imported from `eval/adjudications/` |

## 5. Migration outline (not written)
- One additive migration with:
  - `hypothesis_outcomes`, `missed_in_runs`, `external_references`, `ground_truth_adjudications`, `research_coverage`,
    `research_effort`, `hypothesis_contributions`;
  - a nullable `artifact_sha256` on `hypothesis_evaluations`;
  - the grants manifest updated.
- No backfill invents outcomes. Existing hypotheses have **no** outcome row until a human records one.
- Rollback follows the same expand-only approach as the T-041 review: nothing dropped or renamed.

## 6. Decisions for the owner
1. Approve the three-plane separation and the `confirmed` rule as stated.
2. Should `ground_truth_adjudications` also cover disputes about hypotheses, not only corpus labels? Recommended: yes, one table.
3. Should coverage be recorded at function or contract granularity? Recommended: function, with contract as a roll-up view, matching
   the structural index.
4. `hypothesis_contributions` now, or with T-151? Recommended: with T-151; everything else in one migration.
