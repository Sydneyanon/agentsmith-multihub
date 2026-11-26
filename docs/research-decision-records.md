# Decision, coverage and outcome records: design (A28, T-191), 2026-11-26

**Status: design only (A28, approved 2026-11-26).** The SQL below is a specification inside this document. It is **not** a migration
file and is not applied anywhere. Turning it into a migration draft and applying it are separate decisions (A29). It builds on the T-144
research-memory draft (`db/drafts/t144-research-memory/`; design approved as A4, application A4b unapproved) and on T-149. It adds
only what neither has: **the decision itself**.

## 1. What already exists, and is reused rather than duplicated
| Need | Record | Where |
|---|---|---|
| Work done (who, when, lease, attempt, error) | `workflow_runs`, `workflow_steps`, `audit_events` | 0001, applied |
| Leads and their evidence | `hypotheses`, `hypothesis_evidence`, `evidence_spans` | 0007, applied |
| Challenges and reviews | `hypothesis_evaluations`, `hypothesis_reviews`, `hypothesis_events` | 0007, applied |
| **Coverage** (component × class × method × result, with absence explicit) | `research_coverage` | T-144 draft |
| **Effort and cost** per step, method and component (model spend by reservation) | `research_effort` → `ai_budget_reservations` | T-144 draft; 0003 |
| **Outcomes** (confirmed, refuted, inconclusive, duplicate, missed), human-decided, with DB-enforced independence rules | `hypothesis_outcomes`, `missed_in_runs` | T-144 draft |
| Ground-truth disputes (corpus labels or hypotheses) | `ground_truth_adjudications` | T-144 draft |
| Public prior knowledge (audits, disclosures), for duplicate risk | `external_references` | T-144 draft |
| Protocol model (features) | `research_blobs` via the analyze step's `protocol_model_sha256` | 0007 + P1–P3 |

**Positive-label rule (inherited from T-144 and kept).** `hypothesis_outcomes.category = 'confirmed'` requires both:
- a human `disclosed_adjudication` review with verdict `supports`;
- a `supports` evaluation by an evaluator independent of the generator.

Nothing in this design creates another way to confirm a finding.

## 2. What is missing: the decision
No record today says **what the system (or a person) chose to work on, from which alternatives, on what basis, and what it chose not
to do**. Without that, no policy can be evaluated and no ranking model can be trained without the selection bias described in
`docs/ml-readiness.md` §3.

### 2.1 `research_decisions` (one row per choice point; append-only)
```sql
CREATE TABLE research_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level text NOT NULL CHECK (level IN ('opportunity','repository','component','function','path','follow_up')),
  context_run_id uuid REFERENCES workflow_runs(id),            -- the run in which the choice is made (NULL for opportunity level)
  snapshot_id uuid REFERENCES repo_snapshots(id),              -- required for component/function/path levels
  protocol_model_sha256 text REFERENCES research_blobs(content_sha256), -- the model whose facts were used as features
  decided_by_kind text NOT NULL CHECK (decided_by_kind IN ('policy','human')),
  decided_by text NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 200),          -- 'policy-v0' or the operator id
  policy_sha256 text REFERENCES research_blobs(content_sha256),                  -- the exact rule set (stored as a blob); NULL for human
  mode text NOT NULL CHECK (mode IN ('exploit','explore','manual')),
  explore_rule text CHECK (explore_rule IS NULL OR length(explore_rule) <= 200),  -- how an exploration pick was made (recorded rule, e.g. "every 5th, uniform among never-examined")
  budget_reservation_id uuid REFERENCES ai_budget_reservations(id),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),           -- concise, shown on the Control Room; never model chain of thought
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (level IN ('opportunity','repository') OR snapshot_id IS NOT NULL),
  CHECK (decided_by_kind = 'human' OR policy_sha256 IS NOT NULL),
  CHECK (mode <> 'explore' OR explore_rule IS NOT NULL)
);
```

### 2.2 `research_decision_candidates` (every alternative considered, chosen or not; append-only)
```sql
CREATE TABLE research_decision_candidates (
  decision_id uuid NOT NULL REFERENCES research_decisions(id),
  rank integer NOT NULL CHECK (rank >= 1),
  candidate_kind text NOT NULL CHECK (candidate_kind IN ('opportunity','repository','component','function','path','hypothesis')),
  candidate_ref text NOT NULL CHECK (length(candidate_ref) BETWEEN 1 AND 1000),   -- opportunity id, owner/repo, model element id (e.g. 'Vault.withdraw(uint256)'), path id, hypothesis id
  features jsonb NOT NULL,      -- {name: {value, source, unknown_reason?}}: every feature cites where it came from; unknown is explicit, never 0
  score_components jsonb NOT NULL, -- the score vector (value, cost, novelty, duplicate_risk, change, class_gap, history), each with its basis
  selected boolean NOT NULL,
  selection_probability numeric CHECK (selection_probability IS NULL OR (selection_probability > 0 AND selection_probability <= 1)), -- for exploration picks; enables unbiased evaluation
  action text NOT NULL CHECK (action IN ('investigate','defer','skip_duplicate_risk','skip_out_of_scope','skip_budget','skip_low_value')),
  resulting_run_id uuid REFERENCES workflow_runs(id),         -- set at creation when the action created work
  resulting_step_id uuid REFERENCES workflow_steps(id),
  PRIMARY KEY (decision_id, rank),
  UNIQUE (decision_id, candidate_ref),
  CHECK (selected = (action = 'investigate')),
  CHECK (jsonb_typeof(features) = 'object' AND jsonb_typeof(score_components) = 'object')
);
```
Non-actions are rows too (`selected = false`, with an action such as `skip_duplicate_risk`). That is how "meaningful non-actions" are
remembered.

### 2.3 Links to coverage and outcomes (proposed additions to the T-144 draft, not a parallel table)
- `research_coverage.decision_id uuid REFERENCES research_decisions(id)`: which decision caused the examination.
- `research_coverage.model_element text`: the P1 function id or P3 path id, so coverage is per function, not only per file and class.
- `research_effort.decision_id uuid REFERENCES research_decisions(id)`: cost attributed to the decision.

No new outcome table. Outcomes stay in `hypothesis_outcomes` and reach a decision through
`hypothesis → workflow run → decision candidate (resulting_run_id)` and through coverage.

### 2.4 The learning view (read-only; what ML-1 would train and evaluate on)
```sql
CREATE VIEW research_decision_examples AS
SELECT d.id AS decision_id, d.level, d.mode, d.policy_sha256, c.candidate_ref, c.rank, c.selected, c.selection_probability, c.features, c.score_components,
       (SELECT jsonb_agg(DISTINCT o.category) FROM hypotheses h JOIN hypothesis_outcomes o ON o.hypothesis_id = h.id
         WHERE h.workflow_run_id = c.resulting_run_id) AS outcomes,
       (SELECT jsonb_agg(DISTINCT rc.result) FROM research_coverage rc WHERE rc.decision_id = d.id AND rc.model_element = c.candidate_ref) AS coverage,
       (SELECT sum(e.wall_ms) FROM research_effort e WHERE e.decision_id = d.id) AS wall_ms
FROM research_decisions d JOIN research_decision_candidates c ON c.decision_id = d.id;
```
Labels in this view are only `hypothesis_outcomes` rows, so the T-144 independence rules hold automatically. Corpus labels never
enter it.

## 3. Rules (enforced in the database where possible)
1. **Append-only.** Both new tables reuse `research_reject_mutation()` (0007). A correction is a new decision that cites the old one in
   its rationale.
2. **Decide before acting.** `resulting_step_id`, when set, must name a step created no earlier than the decision (trigger).
3. **Provenance of features.** Every feature has a `source`: a model hash plus element, a table and id, or an external reference id.
   A feature without a source is rejected (trigger checks that each value object has `source` or `unknown_reason`).
4. **Unknown is not zero.** The policy may not substitute a default for an unknown feature; the score component records "unknown".
5. **Human choices are recorded too.** An operator submitting a repository through intake writes a `decided_by_kind = 'human'`,
   `mode = 'manual'` decision. Today's only "decisions" then become data.
6. **No chain of thought.** `rationale` is a concise explanation (bounded length). Model specialists' internal reasoning is never
   stored.
7. **Access.** Same as hypotheses: runtime role INSERT and SELECT; no UPDATE or DELETE. Visible only through the authenticated API.

## 4. Who writes what (when the pieces exist)
| Writer | Records | Precondition |
|---|---|---|
| Intake (operator submission) | a human decision at repository level, with one selected candidate | A29 |
| Policy v0 step (`decide_next`, T-192) | policy decisions at component/function level, with all candidates, chosen and skipped | A29, T-192, A26 |
| Specialists | `research_coverage` (examined / abstained / not modelled) per model element; `research_effort` | A4b (T-144), A29 |
| Human reviewer (T-149 S2) | `hypothesis_reviews`, `hypothesis_outcomes` | S2 API (unapproved), A4b |

## 5. Control Room (read-only additions, after the tables exist)
- **"Why this target"**: the latest decisions, each with its rationale, score components (unknowns shown as unknown), the
  alternatives skipped and why, and the mode (exploit, explore or manual).
- **Coverage map** per snapshot: examined, abstained and not modelled, by function and class.
- **Outcomes**: confirmed (0 today), refuted, inconclusive, duplicate and missed, each linked to the decision that led to it.
- **Cost**: per decision, per investigation and per confirmed discovery.

## 6. Tests the migration draft must have (when A29's draft is written)
- Append-only for both tables, for the owner and the restricted role.
- Rejection of:
  - a feature without a source;
  - a policy decision without `policy_sha256`;
  - a component-level decision without a snapshot;
  - `selected` inconsistent with the action;
  - a resulting step created before the decision.
- The learning view returns outcome labels only from `hypothesis_outcomes`.
- Rollback leaves 0001–0008 and the T-144 tables intact.
- Compatibility: existing API routes unchanged.

## 7. Order of approvals this implies
A4b (T-144 draft applied) and A29 (this design as a migration) are both needed before any decision, coverage or outcome is recorded.
They can be applied together as one reviewed change, or A29 can wait for S2. Neither is part of A25.
