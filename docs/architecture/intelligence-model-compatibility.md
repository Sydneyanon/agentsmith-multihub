# Intelligence-model compatibility assessment: can the 12 capabilities be built on C1–C3?

**Status: assessment only.** Written 2026-11-28 against commit `b8317cc`. No code, schema, migration, secret or deployment was
changed. Nothing was run against production or Fly. No tool was installed and no model was called. The held-out corpora
(`eval/heldout*`, `eval/benchmark-b`, `eval/heldout5`) were not opened.

**This document designs nothing in depth and proposes building nothing now.** It answers one question: do the structures that C1–C3
put in place (the shared protocol model, the lead key and investigations, the dependency manifest) leave room for the owner's
twelve intelligence capabilities, and what would each one need before it could honestly exist?

**Evidence.** Every claim about the code was checked in the source at `b8317cc` and is cited as `file: symbol`. Claims taken from
another document, and not re-verified here, say so.

**Status words** (as in `docs/architecture/integrated-research-architecture.md`): *designed*, *implemented*, *tested*, *integrated*
(it has an invocation path from the research workflow), *released* (in the production image), *deployed* (running where it could
execute), *operationally verified* (it executed in production on a real input, with a checked result). For a table, three more
labels are used: **applied** (in `db/migrations`, applied in production), **draft** (in `db/drafts`, applied only on throwaway
databases), and **no writer** (the table exists and no code writes to it).

---

## Summary

1. **None of the 12 capabilities exists as a learned model today.** No model has been trained, no model has been called in
   production, and no research run has ever executed in production (operator fact recorded in
   `engine-inventory-and-coordination.md`). `docs/ml-readiness.md` concludes that no ML model can be trained honestly today; that
   conclusion still holds.
2. **Three capabilities are partly covered by deterministic code:** protocol understanding (3), linked experience memory (10) and
   the self-model (8). Three more have a deterministic precursor that is not on the production path: attention (1), the action
   policy (12) and the counterfactual model (6, the APEX shadow, which is measurement only). The other six have nothing.
3. **C1–C3 are compatible with all twelve.** The shared model is sectioned, versioned, addressed by hash, and states what it does
   not know. The lead key gives one identity to an issue across engines and commits. Evidence is stored per engine with its
   analysis family. No capability needs these to be rebuilt. Several need them **extended**: two model sections are still
   `not_computed` (`assets_accounting`, `invariants`), and so is the actor set.
4. **The blocking gap is data, not architecture.** Every capability that learns needs labels that only an independent
   reproduction plus a human outcome can produce. There are zero such labels from real runs. The tables that would hold decisions,
   non-actions, coverage and outcomes are drafts.
5. **The order is forced:** reproduction (C4/C5) → decisions and non-actions → rule baselines → lessons writer → prediction
   records → learned components. A learned component built before the step above it has nothing honest to learn from and no
   baseline to beat.

### Status of the 12 capabilities at a glance

| # | capability | learned model today | deterministic code today | first missing thing |
|---|---|---|---|---|
| 1 | Attention | none | precursor, not on the production path: `priority/score.ts`, `priority/component.ts`, `discovery/priority.ts` | decisions with outcomes (draft 0010 + 0009) |
| 2 | Opportunity | none | precursor: opportunity ranking in `engine/loop.ts: rankOpportunities` (needs draft 0010); bounty ranking | outcomes per opportunity |
| 3 | Protocol understanding and state | none | **partial, integrated in development:** `shared-model.ts` (8 of 10 sections computed) | `assets_accounting`, `invariants`, actors |
| 4 | Mechanism and causal | none | none (specialists match patterns; they do not explain) | a model client; cause-labelled outcomes |
| 5 | Future-state | none | none | prediction records registered before the experiment |
| 6 | Counterfactual | none | precursor: APEX explores action sequences (shadow, measurement only) | accounting relations to violate; independent replay |
| 7 | Consequence | none | none (a Foundry `supports` shows a local defect, not its effect) | an oracle that measures effect (C5) |
| 8 | Self-model | none | **partial:** `capabilities.ts` declarations; `unsupported_features` section; abstention codes | calibration data: predicted vs observed, per engine |
| 9 | Failure attribution | none | none | contradictions with a recorded cause; a lessons writer |
| 10 | Linked experience memory | none (and none needed first) | **partial:** 0007 records, `lead-identity.ts` investigations, `leadHistory` | decisions, outcomes, lessons (drafts / no writer) |
| 11 | Discovery | none | none | a baseline of adjudicated models across protocols |
| 12 | Learned action policy | none | precursor: `loop.ts: chooseCapability`, `RESEARCH_POLICY_V0` (needs drafts) | everything above it |

---

## Part 1. What C1–C3 actually provide (verified in code)

Parts 7 and 8 of `engine-inventory-and-coordination.md` describe C1–C3. The points below are the ones the capabilities depend on,
checked against the source. All three are *implemented, tested and integrated* in development. They are **not** released,
deployed or operationally verified, and C3 is off by default.

### 1.1 The shared protocol model (C1)

`apps/api/src/analysis/solidity/shared-model.ts`, schema `agentsmith-shared-protocol-model/1`, builder `shared-model-builder/1`.

| part | fields (as in `SharedProtocolModel`) | status in the document |
|---|---|---|
| identity | `snapshot {repository, commit_sha, manifest_sha256}`; `base {schema, builder, sha256}` (the unchanged `protocol-model/3`); `inputs[] {file, sha256}`; `dependency_manifest_digest` | always present |
| `contracts` | `in_base[]`, `counts {components, deployable, libraries, inheritance_relations}` | computed, `parsed` |
| `functions` | `in_base[]`, `counts {functions, entry_points, call_edges}`, `callers[]` | computed, `derived` |
| `state` | `variables[] {component, variable, type, constant, immutable, roles[], writers[] {function, entry_point, caller_guarded}}` | computed |
| `actors_permissions` | `functions[] {function, entry_point, caller_guarded, modifiers[], guards[]}`; `roles[] {component, variable, holder, strength, transfer, writers[]}`; **`actors`** | computed; `actors` is **`not_computed`** |
| `assets_accounting` | — | **`not_computed`**, with the reason |
| `external_dependencies` | `external_calls[]`, `imports[] {resolution: in_snapshot / dependency / unresolved}`, `dependency_set` | computed; `dependency_set` is `not_computed` when the run has no dependency stage |
| `invariants` | — | **`not_computed`**, with the reason |
| `upgradeability` | `markers[] {kind: delegatecall / proxy_boundary / initializer / implementation_pointer}` | computed |
| `unsupported_features` | `predicted[] {feature, component, function, what}`, `by_feature`; `gate_observations` | computed from syntax; `gate_observations` is `not_computed` in the document and read beside it from the APEX shadow record (`unsupportedFeaturesOfRun`) |
| `unresolved_questions` | `questions[] {question, about, raised_by, blocks[]}` | computed, `unknown` |

Three properties matter for every capability:
- **Every fact has an epistemic status** (`parsed`, `derived`, `verified`, `unknown`) and a location (`file`, `line_start`,
  `line_end`). `verified` is used for exactly one thing: the dependency set's content identity.
- **A section is never absent.** It is `computed` with provenance, or `not_computed` with a reason. An empty list never stands for
  "none".
- **It is read by hash and re-hashed on read** (`verifySharedModel`, `readSharedModelOfRun`). A consumer records what it read
  (`modelReadRecord`).

**A limit to keep in view.** The model is a blob in `research_blobs`, whose size limit is 1 MiB (`SHARED_MODEL_BLOB_LIMIT`; 0007
`size_bytes BETWEEN 0 AND 1048576`). The step output records `shared_model_stored`. A large protocol may exceed the limit; what
happens then was not verified for this document.

### 1.2 The lead key and investigations (C2)

`apps/api/src/analysis/solidity/lead-identity.ts`, schema `agentsmith-lead-key/1`.

- **The key** is derived from `(repository, class, file, contract, function name)` (`LeadAnchor`, `leadKey`). It contains no line
  number, snapshot, commit or generator. This is narrower than the key designed in Part 4.2 of the inventory document, which also
  included a component content hash and a state-reference set: **the implemented key has neither.**
- **It is stored** as `lead_keys[] {hypothesis_id, lead_key}` in the output of the producing step (`analyze_structure`,
  `slither_scan`). There is no table. `db/drafts/c2-lead-identity` (`hypothesis_leads`) is a draft.
- **An investigation** (`Investigation`) groups the hypotheses of one snapshot that share a key. Its fields:
  `contributions[]` (per hypothesis: `generator`, `analysis_family`, `method`, `evidence[]`, `evaluations[]`), `generators[]`,
  `generator_families[]`, `independent_generation`, `corroboration {same_family, cross_family, unknown_family}`,
  `contradictions[]` (kind, both sides, `families`), and `assessment` (`contradicted`, `weakened`, `supported_cross_family`,
  `corroborated_same_family`, `supported_unknown_family`, `open`).
- **Cross-snapshot history** is `leadHistory(repository, key)`, a scan of step outputs.
- **Known limit, stated in the code:** two distinct issues of the same class in the same function share one key.

### 1.3 The dependency manifest (C3)

`apps/api/src/acquisition/dependencies.ts`, schema `agentsmith-dependency-manifest/1`.

`DependencyManifest` holds `parent {repository, commit_sha, tree_sha, manifest_sha256}`, `limits`, `dependencies[]` (source, pin,
tree and file-manifest hashes, status), `remappings[] {context, prefix, target, declared_in, line, resolves_to, available}`,
`packages[]` (recorded with their lockfile pin, never fetched), `limitations[] {code, subject, reason, established_by}` and a
`digest` over all of it. `usableRemappings(m)` returns only remappings whose target is really present.

**Not verified by any real compiler.** C3 was tested with local fixtures and a labelled Slither stand-in only.

### 1.4 The research records (0007, 0015, 0016: applied)

| record | what it gives a capability |
|---|---|
| `hypotheses` (+ `hypothesis_evidence`, `evidence_spans`) | a claim with generator kind, id and version, anchored to hash-verified spans; append-only |
| `hypothesis_evaluations` (+ `evaluation_evidence`) | outcomes `supports`, `weakens`, `contradicts`, `inconclusive`; `actor_kind` is checked to be `deterministic_rule`, so **a model can never write an evaluation** |
| `hypothesis_reviews` | model or human opinion; verdicts `supports`, `rejects`, `needs_more_evidence`, `inconclusive`; a model review must carry provider, model and a budget reservation |
| `hypothesis_events`, `hypothesis_status` | the ordered history; a derived status that never says "confirmed" |
| `analysis_identities`, `evaluation_independence`, `hypothesis_independence` (0016) | analysis family per actor; the trigger that refuses self-evaluation; `cross_family` / `same_family` relations |
| `hypothesis_evaluation_keys`, `evaluation_provenance` (0015) | one evaluation per (hypothesis, evaluator, version, input hash); who recorded it and its raw output blob |

---

## Part 2. The twelve capabilities

Each capability gets the same seven rows. "Reusable" names real modules and tables with their status. "Evaluation" names the
metric, the baseline to beat, what must be preregistered and what the held-out data is.

**Two statements apply to every "Evaluation" row and are not repeated:**
- **Held-out data does not exist yet for any of them.** Corpora 1–4 are development data or spent (`ml-readiness.md` §1). The only
  candidates are corpus 5 (proposed, untouched, needs A22/A23), a new blind real-code corpus (R12, proposed), and **future
  adjudicated runs on code families that were not used for fitting**, split by code family and by time (`ml-readiness.md` §3).
- **Labels are human outcomes resting on independent evidence,** never an engine's own output.

### 2.1 Attention model

*What to look at first inside a protocol: which component, function or question deserves the next unit of effort.*

| | |
|---|---|
| **Needs** | per candidate: structural features, open questions, what was already examined, cost so far, and what happened when similar candidates were examined |
| **C1–C3 provide** | shared model: `functions.counts`, `state.variables[].roles` and `writers[]`, `actors_permissions.functions[].caller_guarded` and `guards[]`, `external_dependencies.external_calls[]`, `upgradeability.markers[]`, `unsupported_features.by_feature`, `unresolved_questions.questions[]`. Lead key: `leadHistory` for "was this looked at before". Investigation: `assessment`, `contradictions[]`. Dependency manifest: `limitations[]` |
| **Missing** | coverage per (component, class, method); effort and cost per candidate; outcomes; the record of what was *not* chosen. No value signal at all: `assets_accounting` is `not_computed`, so nothing says where the money is |
| **Reusable** | `priority/score.ts`, `priority/component.ts` (`COMPONENT_POLICY_V1`), `priority/from-model.ts`, `priority/replay.ts`: implemented, tested, not integrated on the production path. `discovery/priority.ts`: implemented. `research_coverage`, `research_effort`: **draft** (0009). `research_decisions`, `research_decision_candidates` with `features`, `score_components`, `selection_probability`: **draft** (0010). `engine/decisions.ts: Feature` (a value with a source, or `unknown_reason`): implemented |
| **New schema / model / evaluator / learning** | no new schema beyond the drafts. Later: a ranker (`ml-readiness.md` suggests LightGBM over the model's features) and a learning process. Not before the data exists |
| **Connects to investigations and memory** | each ranked candidate is a decision candidate whose `candidate_ref` is a model element or a lead key; the features cite `shared_model_sha256`; the outcome returns through hypothesis → run → candidate (`resulting_run_id`) |
| **Evaluation** | **metric:** confirmed, differentiated discoveries per hour and per dollar; secondary, recall of adjudicated findings in the top-k functions per repository. **Baselines:** random order; claim order; `COMPONENT_POLICY_V1` with weights fixed before scoring. Note `adaptive-priority-engine-design.md` §11 (not re-verified here) reports the priority engine does not beat round-robin on a synthetic replay. **Preregister:** metric, k, budget, split, policy hash. **Bias control:** only chosen candidates get labels, so exploration picks with a recorded `selection_probability` are required |

### 2.2 Opportunity model

*Which programme, repository or change is worth researching at all.*

| | |
|---|---|
| **Needs** | programme facts (scope, reward, eligibility, age), repository facts, duplicate risk, expected cost, and the result of past choices |
| **C1–C3 provide** | little directly; these operate after a repository is chosen. Usable after a first run: `contracts.counts`, `unsupported_features.by_feature` (how much of this protocol the engines can model), `dependency_set.not_acquired[]` and `limitations[]` (will it compile at all), `leadHistory` across commits |
| **Missing** | any outcome per opportunity; public prior-art records for duplicate risk; a measured cost per repository |
| **Reusable** | bounty collector and bounty intelligence (0011–0014: **applied**; the collector is the only component operationally verified). Discovery tables (0008: **applied**). `loop.ts: rankOpportunities, selectOpportunity`: implemented, needs **draft** 0010. `external_references`: **draft** (0009). `docs/opportunity-model-design.md` (design) |
| **New schema / model / evaluator / learning** | no new schema beyond drafts 0009/0010. A learned model is the last thing to add here: opportunities are few, so the label count grows slowest of all |
| **Connects to investigations and memory** | an opportunity-level decision (`level = 'opportunity'`) whose selected candidate creates the run; the run's investigations and outcomes are the opportunity's result. Human selection stays (`RESEARCH_POLICY_V0.opportunity.selection`) |
| **Evaluation** | **metric:** adjudicated, non-duplicate findings per researched opportunity and per dollar. **Baselines:** the human's own picks; newest-first; highest-reward-first. **Preregister:** the screen-out rules and the comparison window. **Held-out:** later opportunities (temporal split) only; there is no corpus for this |

### 2.3 Protocol understanding and state model

*What the protocol is: components, state, actors, assets, the relations that must hold.*

| | |
|---|---|
| **Needs** | sealed sources and dependencies; a representation of state, actors, assets and accounting relations; a statement of what is not understood |
| **C1–C3 provide** | **this is the capability C1 implements, in part.** Computed: `contracts`, `functions`, `state`, `actors_permissions.functions` and `.roles`, `external_dependencies`, `upgradeability`, `unsupported_features.predicted`, `unresolved_questions`. C3 turns unresolved imports into `imports[].resolution = dependency` with a verified content identity |
| **Missing** | `assets_accounting` (**`not_computed`**): assets held, share tokens, relations such as "sum of ledger equals aggregate". `invariants` (**`not_computed`**). `actors_permissions.actors` (**`not_computed`**): APEX still uses a fixed actor set. Cross-contract state: external targets stay as written unless typed inside the snapshot. Token, oracle and price semantics. Dependency sources are acquired but the structural analysis of dependency code was not verified for this document |
| **Reusable** | `shared-model.ts`, `protocol-model.ts`, `state-roles.ts`, `authority.ts`: implemented, tested, integrated in development. `research_blobs`: **applied**. A section blob can be added without a migration (the design in Part 4.1 of the inventory) |
| **New schema / model / evaluator / learning** | **a schema version, not a table:** filling the three missing parts means `agentsmith-shared-protocol-model/2`. Rules first. A model may *propose* an accounting relation only as an `unresolved_questions` entry, never as a fact. A new evaluator is needed to check a proposed relation (APEX or a fuzzer on real bytecode) |
| **Connects to investigations and memory** | every hypothesis, evaluation, decision and lesson cites the model hash it was made against; a lead's anchor names model elements |
| **Evaluation** | **metric:** per-section precision and recall of facts against a human-written reference model of a protocol; for relations, the false-invariant rate on correct-but-asymmetric controls (the measure already used in `apex-first-capability.md` §10.2.2). **Baseline:** `protocol-model/3` alone; P2 roles alone. **Preregister:** the reference models, written and sealed before the builder is frozen. **Held-out:** reference models of protocols nobody on the project inspected |

### 2.4 Mechanism and causal model

*Why a suspected defect would happen: the chain from precondition to effect.*

| | |
|---|---|
| **Needs** | the claim, its spans, the relevant model slice, every evaluation with its family, and outcomes that say which stated cause was right |
| **C1–C3 provide** | the slice: `state.variables[].writers[]`, `functions.callers[]`, `actors_permissions.functions[].guards[]`, `external_dependencies.external_calls[]`. The investigation: `contributions[]` and `contradictions[]` side by side. Hypotheses already carry `required_checks` and `alternative_explanations` (0007 columns) |
| **Missing** | any reasoning component. No `ModelAdapter` exists outside tests; no price row is enabled. A structured "mechanism" record: today a mechanism is free text in `hypotheses.rationale`. Outcomes that distinguish "right for the stated reason" from "right by accident" |
| **Reusable** | `ai-budget-gateway.ts: AiBudgetGateway`, `ai-budget.ts` (`MODEL_ROUTING`): implemented, tested, never activated. `ai_budget_reservations`, `ai_model_prices`, `model_usage_events` (0001–0004): **applied**, no production writer has run. `hypothesis_reviews`: **applied**. Attended specialists in `capabilities.ts` (`claude-path`, `claude-assumptions`): implemented, need **draft** 0010 |
| **New schema / model / evaluator / learning** | a blob schema for a structured mechanism (steps, preconditions, the model elements each step touches); no table. A model client (approval A31). No training: a prompted model first |
| **Connects to investigations and memory** | output is a **review plus proposed experiments**, never an evaluation (0007 forbids it). Proposed experiments become decision candidates. The mechanism blob is cited by the review's `input_sha256` chain |
| **Evaluation** | **metric:** of the mechanisms stated, the share whose independent reproduction succeeded *by the stated path* (the reproduction test encodes the path; see the C5 plan), and the share refuted. **Baseline:** the generator's own rationale with no mechanism step; a no-model run of the same leads. **Preregister:** the prompt version hash, the task tier, the leads. **Held-out:** leads on unseen code families. The budget constraint is real: the tier-3 per-call cap is US$0.10 (`cost-and-model-policy.md`) |

### 2.5 Future-state model

*What state the protocol will be in after a sequence of actions.*

| | |
|---|---|
| **Needs** | a state representation, a transition function, and observed transitions to compare against |
| **C1–C3 provide** | `state.variables[]` with roles and writers; `functions` entry points; `unsupported_features.predicted[]`, which says where a prediction should not be attempted |
| **Missing** | **a prediction record registered before the experiment.** Nothing today stores "the model predicted X" and later "the execution observed Y". No observed transitions on real bytecode (no real Foundry has run). `assets_accounting` for anything about value |
| **Reusable** | the bounded interpreter (`simulate.ts`) and APEX (`apex/engine/*`) already compute future states inside one contract: implemented; APEX is integrated as a measurement-only shadow. `research_blobs` for prediction blobs: **applied**. `hypothesis_evaluation_keys`-style idempotency: **applied** |
| **New schema / model / evaluator / learning** | **a new record is required:** a prediction with `{model_sha256, question, predicted, predictor@version, registered_at}` stored *before* the step that tests it, and resolved afterwards. It can start as a blob cited in a step input (no migration); an indexed table would be a migration needing approval. The evaluator is real execution (C5) |
| **Connects to investigations and memory** | a prediction names a lead key or a model element; its resolution is linked to the evaluation that tested it |
| **Evaluation** | **metric:** exact-match rate on discrete state predictions; calibration (Brier score) where a probability is given; abstention rate reported beside both. **Baseline:** the bounded interpreter's own answer; "state unchanged". **Preregister:** by construction, since the prediction is registered first; plus the scoring rule. **Held-out:** contracts not used to build the interpreter or any model. An interpreter that agrees with itself measures nothing: the observation must come from the EVM |

### 2.6 Counterfactual model

*What would happen if an actor did something else: a different order, caller, amount or token behaviour.*

| | |
|---|---|
| **Needs** | the action space per actor, the relations that should hold, and a way to run the alternative |
| **C1–C3 provide** | `actors_permissions.functions[]` and `.roles[]` (who may call what); `state.variables[].writers[]`; `upgradeability.markers[]`; `unresolved_questions` |
| **Missing** | the derived actor set (`actors` is `not_computed`); the relations to violate (`assets_accounting`, `invariants` are `not_computed`); independent replay of an APEX sequence against real contracts (`apex-first-capability.md` §10.2.5: not started). No reasoning layer chooses which counterfactual is worth running |
| **Reusable** | APEX state explorer, fidelity gate, minimisation (`apex/engine/*`, `apex/shadow*.ts`): implemented and tested on self-authored contracts only; integrated as a shadow for one approved target; never run on real code. `engine/reproduction.ts`: implemented, stand-in tested |
| **New schema / model / evaluator / learning** | question-directed exploration (APEX is given whole contracts today). An APEX identity in `analysis_identities` if it ever evaluates (a new migration). No learning process yet |
| **Connects to investigations and memory** | a counterfactual is an experiment attached to a lead key; its result is an evaluation only after the fidelity gate **and** an independent replay |
| **Evaluation** | **metric:** share of counterexamples that reproduce on the EVM; false-invariant rate; abstention and suppression counts. **Baseline:** APEX baseline strategy against the deep strategy (already recorded on self-authored sets); a random-sequence fuzzer with the same budget. **Preregister:** the budget, the invariant kinds, the controls. **Held-out:** not the self-authored sets, which demonstrate mechanism only (`apex-first-capability.md` §10.3) |

### 2.7 Consequence model

*The practical effect of a suspected vulnerability: who loses what, how much, under which conditions.*

| | |
|---|---|
| **Needs** | assets and their holders; the attacker's reachable actions; a measured effect (balance change, locked funds, broken relation); the conditions that make it real |
| **C1–C3 provide** | structural hints only: `state.variables[].roles` (ledger, aggregate), `external_calls[]` with value, `actors_permissions.roles[]` |
| **Missing** | almost everything. `assets_accounting` is `not_computed`. No evaluation today measures an effect: the existing mapping in `reproduction.ts` says a passing test "demonstrates the local defect; it does not establish live exploitability". The dev corpus shows why this matters: two reentrancy functions are labelled `vulnerable: true, exploitable: false` (`eval/dev/labels.json`). Deployment facts (balances, configuration) are out of scope: there is no RPC and none is approved |
| **Reusable** | `hypothesis_evaluations` + `evaluation_provenance` (raw output blob): **applied**. `engine/tools/foundry.ts`: implemented, stand-in tested only. Bounty intelligence (reward tiers, 0011: **applied**) for a severity mapping |
| **New schema / model / evaluator / learning** | **a new evaluator is the core:** an effect oracle per vulnerability class (attacker profit, invariant violation, funds locked), executed on real bytecode. That is C5. A blob schema for the measured effect. No learned model until many measured effects exist |
| **Connects to investigations and memory** | the measured effect is part of the evaluation's stored output, attached to the lead key; a predicted consequence is a prediction record (2.5) resolved by it |
| **Evaluation** | **metric:** agreement between predicted and measured effect class; for magnitudes, error against the oracle's measurement; share of "structurally vulnerable, not exploitable" cases correctly called. **Baseline:** class-default severity (every reentrancy is critical). **Preregister:** the oracle per class and its thresholds. **Held-out:** fixtures with exploitable and non-exploitable twins that no template was developed on |

### 2.8 Self-model

*What AgentSmith can and cannot do: which engine understands which code, and how reliable each is.*

| | |
|---|---|
| **Needs** | per engine: declared limits, measured availability, where it abstained and why, and its measured reliability on controls |
| **C1–C3 provide** | **partial coverage exists.** `unsupported_features.predicted[]` (predicted from syntax) beside the fidelity gate's observed abstentions (`unsupportedFeaturesOfRun`): a predicted-versus-observed pair. Every `not_computed` section with its reason. `dependency_set.not_acquired[]`, `limitations[]`. Slither abstention codes in the step output |
| **Missing** | reliability per engine on real code (zero adjudicated outcomes). Coverage records (`research_coverage` is a draft). A probe of availability: `capabilities.ts: availability` checks only that an environment variable is set, not that a binary runs. A place for "this engine was wrong here before" |
| **Reusable** | `engine/capabilities.ts` (`CapabilityProfile`: limitations, failure modes, cost units): implemented; its `availability()` is live in `/v1/engine/components` as a reporting declaration. `loop.ts: trackRecords` (`usedInSelection: false`, `MIN_ADJUDICATED = 5`): implemented, needs drafts. Frozen-corpus scores per engine (operator-recorded) |
| **New schema / model / evaluator / learning** | no new schema beyond draft 0009. First a table of measured rates, not a model. A calibration model only after enough predicted-versus-observed pairs |
| **Connects to investigations and memory** | its output is a decision feature ("unsupported_by_model: feature@file:line") and the reason on a non-action; it reads abstentions and contradictions per lead key |
| **Evaluation** | **metric:** precision and recall of predicted abstention against observed abstention; calibration of "this engine will be right" against adjudicated outcomes. **Baseline:** the static declaration in `capabilities.ts`; "always available, always right". **Preregister:** the feature vocabulary and the scoring rule. **Held-out:** code not used to write the syntax predictor |

### 2.9 Failure-attribution model

*When AgentSmith was wrong or missed something: which assumption, engine or decision was responsible.*

| | |
|---|---|
| **Needs** | the full trail of a lead: what each engine claimed, what contradicted it, what was decided and not done, and the final outcome; plus misses found later |
| **C1–C3 provide** | `Investigation.contradictions[]` with both sides and whether they are cross-family; `corroboration`; `leadHistory` across commits; the model hash each engine read (`modelReadRecord`), so "they saw different inputs" can be ruled out |
| **Missing** | human outcomes (`hypothesis_outcomes`: draft). Misses (`missed_in_runs`: draft). Non-actions (draft 0010). A structured cause on a contradiction: today the reason is free text in `rationale`. A writer for lessons |
| **Reusable** | `knowledge_items`, `knowledge_links` (0001): **applied, no writer** (`architecture-gaps.test.ts`, per the inventory). `ground_truth_adjudications`: **draft**. `hypothesis_events`, `audit_events`: **applied**. `docs/analyzer-failure-classes.md` (a hand-written taxonomy; not re-read for this document) |
| **New schema / model / evaluator / learning** | a failure-cause vocabulary (a blob schema or a constrained `item_type` convention for `knowledge_items`; no migration needed to start). A lessons writer (code). No learned model first: attribution by rule over the trail, reviewed by a human |
| **Connects to investigations and memory** | a lesson is a `knowledge_items` row linked through `knowledge_links` to the outcome and keyed by lead key and model hash. `knowledge_items` has no foreign key to hypotheses, so the link must be carried in `source_uri` / `source_hash` or a later schema change (approval) |
| **Evaluation** | **metric:** agreement with a human's attribution on a sealed sample; and, the real test, whether acting on a lesson reduces the same failure on *other* targets. **Baseline:** no attribution; "blame the generator". **Preregister:** the cause vocabulary and the sample. **Leakage rule:** a lesson learned on a target is never scored on that target |

### 2.10 Linked experience memory

*One memory of what was investigated, found, refuted, skipped and learned, linked by issue identity.*

| | |
|---|---|
| **Needs** | a stable identity for an issue; every claim, evaluation, decision and lesson attached to it; history across commits |
| **C1–C3 provide** | **the identity and the grouping exist.** `leadKey`, `lead_keys` in step outputs, `investigationsOfSnapshot`, `leadHistory`, `summariseInvestigations`. Evidence per engine stays separate with its family |
| **Missing** | an index (cross-run lookup scans step outputs; `hypothesis_leads` is a draft). Decisions and non-actions (draft 0010). Outcomes, coverage, effort (draft 0009). Lessons (no writer). The key ignores component content, so "the code changed under this lead" is not visible from the key alone |
| **Reusable** | 0007 research state: **applied**, append-only. 0016 independence: **applied**. `lead-identity.ts`: implemented, tested, integrated in development. Drafts 0009, 0010, c2: **draft**. `knowledge_items`: **applied, no writer** |
| **New schema / model / evaluator / learning** | no new *design*: promotion of existing drafts (each a production migration needing approval). No model is needed for memory itself. Retrieval by similarity would be a later, separate decision |
| **Connects to investigations and memory** | it *is* the memory. The rule to keep: one store (0007), one identity (lead key), one decision record (0010), one lessons table (`knowledge_items`) |
| **Evaluation** | **metric:** integrity (every recorded key re-derives from its anchor, which `investigationsOfSnapshot` already checks); retrieval precision and recall for "have we seen this lead" on a sealed set of known repeats; over-merge rate (distinct issues sharing a key). **Baseline:** `claim_fingerprint` (per snapshot and generator). **Preregister:** the repeat set. **Held-out:** repositories with several commits not used when the anchor was designed |

### 2.11 Discovery model

*Finding relationships nobody declared: an invariant, a dependency between components, a pattern across protocols.*

| | |
|---|---|
| **Needs** | many protocol models to compare; a baseline of normal structure built from adjudicated or published-safe code; a way to test a proposed relation |
| **C1–C3 provide** | a uniform, versioned representation to compare across protocols; `state.variables[].roles`; twin-function structure via `writers[]`; `unresolved_questions` as the place a proposed relation enters |
| **Missing** | a corpus of models (there is one real-repository run, local, and it predates C1). The baseline. `invariants` and `assets_accounting`. An evaluator for a proposed relation on real bytecode. The definition itself: `research-intelligence-plan.md` §5.5A says the Weirdness definition "is not yet written" (as quoted in the inventory) |
| **Reusable** | APEX invariant candidates (measurement only). The unmerged protocol-invariant patch with a recorded null result (`docs/proposals/protocol-invariant-ae048ad.patch`, per the inventory). The frozen-corpus discipline (`eval/LABELS.sha256`, `eval/verify-frozen.sh`) for freezing a baseline |
| **New schema / model / evaluator / learning** | all four, eventually: a section schema for candidate invariants with origin and status; a baseline artefact frozen by hash; an evaluator (fuzzing or Foundry); a learning process over which candidate kinds led to adjudicated outcomes. This is the capability furthest from existing |
| **Connects to investigations and memory** | a discovered relation is a hypothesis (generator identity registered, so independence is checkable) or an unresolved question; never a model fact until independently checked |
| **Evaluation** | **metric:** of proposed relations, the share that are true on controls and the share whose violation is an adjudicated finding; novelty (not already found by a single engine). **Baseline:** APEX's rule-inferred candidates; the null result of the earlier invariant detector. **Preregister:** the candidate kinds and the control set. **Held-out:** protocols outside the baseline, by code family. **Guard:** more candidates is not a result |

### 2.12 Learned action policy

*Which experiment to run next, with which engine, given everything known.*

| | |
|---|---|
| **Needs** | the candidate experiments, their features and costs, the choice made, the alternatives rejected, and the outcome of each choice |
| **C1–C3 provide** | features (as 2.1), the model hash on the decision (`protocolModelSha256` in `DecisionInput`), investigations as the unit a policy acts on |
| **Missing** | all of the training signal: decisions with outcomes do not exist. The rule baseline is not on the production path. Exploration picks with known probabilities, without which evaluation is biased |
| **Reusable** | `engine/loop.ts: chooseCapability, mapAndAssign`; `engine/decisions.ts: openDecision, addCandidates, RESEARCH_POLICY_V0, POLICY_SHA256` (the policy stored as a blob by hash): implemented, tested on throwaway databases, need **draft** 0009/0010 and `ENGINE_LOOP_ENABLED`. The learning view `research_decision_examples` is **designed only** (`research-decision-records.md` §2.4): it is not in either draft |
| **New schema / model / evaluator / learning** | the view (a migration). A policy model and an off-policy evaluator. A promotion process: shadow beside the rule policy, promoted only by owner approval (`ml-readiness.md` §5.4) |
| **Connects to investigations and memory** | it writes decisions; it reads investigations, coverage and lessons; its version hash is on every decision it makes |
| **Evaluation** | **metric:** adjudicated, reproduced findings per unit budget, against the rule policy on the same targets; off-policy estimates using `selection_probability`. **Baselines:** random; fixed step order (today's production path); `research-policy/0` frozen by hash. **Preregister:** metric, budget, targets, the minimum data threshold. **Held-out:** unseen repositories, split by code family. **Rule:** it runs in shadow until it beats the rule policy on held-out data |

---

## Part 3. Common understanding: one protocol model, one experience memory

The twelve capabilities are views of the same two things, not twelve subsystems.

### 3.1 How they share one protocol model

| principle | mechanism today | what each capability must do |
|---|---|---|
| one document per sealed snapshot | `buildSharedModel` in `analyze_structure`; stored once by hash | read it with `readSharedModelOfRun`; never build its own |
| a capability adds a **section**, not a model | `SECTION_KEYS`, `Section<T>` | fill `assets_accounting`, `invariants` or `actors`, or add a section, under a new schema version |
| unknown is explicit | `not_computed` with a reason; `unresolved_questions` | write what it could not determine as a question, not as an absence |
| facts are graded | `Epistemic` on every fact | never raise a fact's status without the independent check that justifies it |
| every output names its input | `modelReadRecord`, `shared_model_sha256` in step outputs | cite the model hash in every prediction, decision, review and lesson |
| a model may propose, not assert | 0007: evaluations are `deterministic_rule` only | a model-proposed relation enters as an unresolved question or a hypothesis with a registered generator identity |

### 3.2 How they share one experience memory

| what is remembered | the one place | status |
|---|---|---|
| claims | `hypotheses` | applied |
| technical evidence, for and against | `hypothesis_evaluations` | applied |
| opinions (model, human) | `hypothesis_reviews` | applied |
| issue identity | lead key in step outputs; `hypothesis_leads` | implemented in code; table is a draft |
| choices and non-choices | `research_decisions`, `research_decision_candidates` | draft |
| coverage, effort, outcomes, misses | 0009 tables | draft |
| predictions | none yet | not designed in detail |
| lessons | `knowledge_items`, `knowledge_links` | applied, no writer |

Each capability reads the memory through the investigation (the lead key) and writes to exactly one of these records. Attention
and the action policy write decisions. Mechanism, future-state, counterfactual and consequence write predictions and reviews, and
cause experiments. Failure attribution writes lessons. The self-model reads abstentions and outcomes and writes decision features.
Discovery writes hypotheses and questions.

### 3.3 Anti-patterns to refuse

1. **A second protocol model.** Any capability that parses the sources into its own representation and reasons from that. (The
   validators and APEX still build an in-memory index from the sealed sources; that is an existing, declared exception, and they
   check and record the shared model's hash. It must not spread.)
2. **A private memory.** A capability-specific table, cache, vector store or file of "what I learned" outside 0007, the decision
   records and `knowledge_items`.
3. **A second notion of a finding.** A "prediction", "anomaly" or "candidate" store that duplicates `hypotheses` with its own
   identity. The legacy intake pipeline's template hypotheses in step output are the standing example to retire.
4. **A model writing evidence.** Any path by which a model's output becomes a `hypothesis_evaluations` row or changes an outcome.
5. **Agreement counted as validation.** Two engines, or two capabilities, agreeing. Same-family agreement is corroboration;
   cross-family agreement between generators is independent generation; neither is a label.
6. **An engine's output used as a label.** Training or scoring on Slither detections, specialist leads, APEX "would have claimed"
   entries or model reviews as if they were outcomes.
7. **A score that hides its parts.** One "confidence" or "understanding" number merging execution progress, coverage, validation
   status and outcomes (the prohibited equations of the inventory, Part 4.12).
8. **Unknown turned into zero.** A missing feature, an uncomputed section or an abstention read as a negative.
9. **Silent replacement.** Updating a policy, prompt, baseline or model in place under the same version label.
10. **Learning on what was inspected.** Scoring on a corpus used for development, or scoring a lesson on the target it came from.
11. **Predictions recorded after the fact.** Any prediction, threshold or criterion written once the result is known.
12. **A capability that cannot abstain.** One forced to answer on code its inputs mark as unsupported or `not_computed`.
13. **A capability that validates itself.** A predictor scoring its own predictions, or a test author derived from the generator
    judging the generator's claim (discussed in the C4/C5 plan).
14. **A capability built ahead of its data.** A learned component with no rule baseline, no held-out set and no labels.

---

## Part 4. The critical learning rules, and what enforces each today

"Enforced" means a mechanism refuses the violation. "Process only" means a document says so and nothing stops it.

| # | rule | enforced today by | gap, and what is needed |
|---|---|---|---|
| 1 | Never train on unverified scanner output as if confirmed | **Partly, by absence.** No training code exists. `hypothesis_status` (0007) never derives "confirmed" from evaluations. `hypothesis_evaluations.actor_kind` is `deterministic_rule` only. In the drafts, the only label table is `hypothesis_outcomes`, whose `decided_by_kind` is checked to be `human` | **Not enforced for training yet, because there is no training.** Needed: the learning view to read labels only from `hypothesis_outcomes` (designed in `research-decision-records.md` §2.4, not in any draft); a rule that any dataset export names its label source |
| 2 | Separate generator and evaluator identities | `analysis_identities` (0016, applied) mirrored by `analysis-identity.ts: ANALYSIS_IDENTITIES`; `generator_id` / `evaluator_id` columns; `capabilities.ts` `kind` | An unlisted id has an unknown family and never counts as independent. **Gap:** the test author has no place in `analysis_identities` (its `role` check allows only generator, evaluator, abstention). APEX and model reviewers have no rows |
| 3 | No self-validation | 0016 trigger `hypothesis_evaluations_independence` (generator id = evaluator id is refused); `ResearchStore.recordEvaluation` (`IndependenceError`); `hypothesis_reviews_guard` (0007) for blinded reviews; `reproduction.ts: appendReproductionIn` and `importTest` refuse an author that produced a claim; worker API refuses every worker-recorded evaluation (`evaluations_are_api_derived`) | Enforcement is at **id** level. At **family** level only the views report it; the rule that `confirmed` needs a cross-family `supports` is draft R3b. Not enforced: a test author of the same family as the generator |
| 4 | Preserve supporting and contradicting evidence | 0007 append-only triggers (`research_reject_mutation`) on hypotheses, evaluations, reviews, events, spans, blobs. `lead-identity.ts: Contradiction` keeps both sides; investigations never merge hypotheses | Known residual, from `worker-architecture-decision.md` S11: the owner connection can disable triggers. A tamper-evident ledger is proposed there, not built |
| 5 | Distinguish confirmed, refuted, weakened, inconclusive | Evaluations: `supports`, `weakens`, `contradicts`, `inconclusive` (0007 check). `Investigation.assessment` keeps six states. `pipeline.ts: challengeOutcome` maps each validator result | `confirmed` and `refuted` are human outcomes and exist only in draft 0009. **In production today nothing can be confirmed or refuted.** "Unsupported by model" is indistinguishable from other `inconclusive` rows without reading the rationale |
| 6 | Record actions and non-actions | **Not enforced in production.** Partial records exist: Slither abstention codes in step output, `no-independent-validator` evaluations, APEX abstentions in the shadow record | Needed: draft 0010 (`research_decision_candidates` with `skip_*`, `defer`), its trigger for "decide before acting", and the selection code on the research path (C6, C7) |
| 7 | Frozen baselines | `eval/LABELS.sha256` and `eval/verify-frozen.sh`; migration checksums (`scripts/migrate.ts` refuses a changed applied migration); `POLICY_SHA256` (the policy stored as a blob); content-addressed `research_blobs` | **Process only for evaluation:** neither `verify-frozen.sh` nor `eval/run-eval.ts` is a CI step (no reference in `.github/workflows` or `package.json` scripts was found). A frozen-baseline record for a rule policy's *score* does not exist |
| 8 | Preregistered criteria | **Process only.** `docs/evaluation-protocol.md` §1 and the corpus-4 freeze-before-score checklist | Needed: a preregistration record (metric, threshold, candidate commit, corpus hash) stored by hash **before** scoring, and a scorer that refuses to run without it |
| 9 | Held-out evaluation before claiming improvement | **Process only**, plus one code rule: `loop.ts: trackRecords` returns `usedInSelection: false` until `MIN_ADJUDICATED` outcomes and an evaluated policy version | Needed: held-out data that exists (corpus 5 or R12, both unapproved); the preregistration record of rule 8 |
| 10 | No silent modification of frozen model versions | For the things that exist: blobs are immutable and checked against their hash (0007); the shared model is re-hashed on read; `generator_version` / `evaluator_version` are on every row; `capabilities.ts: pinnedVersion` puts the prompt hash in an attended specialist's version; a model review must record provider and model | **Not enforced for learned models, because there are none.** Needed: every learned artefact stored by hash, its hash on every prediction and decision it makes, and promotion as a recorded, approved event. A provider can change a hosted model behind a name: record the exact model id returned, and treat a change as a new version |
| 11 | Distinguish predictive accuracy from genuine improvement in research decisions | **Not enforced.** The design supports it: `selection_probability` and `mode = 'explore'` in draft 0010 allow off-policy evaluation | Needed: two preregistered metrics per learned component, one predictive and one decision-level (reproduced, adjudicated findings per unit budget against the rule baseline), and a promotion rule that requires the second |
| 12 | Preserve uncertainty and abstention | `Section` = `computed` or `not_computed` with a reason; `Epistemic` per fact; `decisions.ts: Feature` (`unknown_reason`); outcome `inconclusive`; role `abstention` in `analysis_identities`; Slither failure codes; the APEX fidelity gate (abstain and suppress); a failing Foundry test is `inconclusive`, never a refutation (`reproduction.ts`) | Coverage rows with `abstained` / `not_modelled` are draft 0009. No abstention option exists yet for a predictor, because no predictor exists; it must be part of the prediction record from the start |

---

## Part 5. What data must exist before each capability could honestly be learned

**Today, from real runs: essentially none.** `ml-readiness.md` §1: research decisions, costs and outcomes "none"; human-confirmed
discoveries **0**. No research run has executed in production. The corpus labels are synthetic, single-function and
class-balanced, and measure detection of known shapes only.

The figures below are **rough orders of magnitude**. Only the first is taken from an existing document; the rest are this
document's estimates and should be replaced by a power calculation when a metric is preregistered.

| # | capability | data that must exist | rough amount | exists today |
|---|---|---|---|---|
| 1 | Attention | decision candidates with features, the choice, exploration probabilities, coverage, and adjudicated outcomes on real code | `ml-readiness.md` §5.3: at least **200 adjudicated real-code outcomes, with positives from at least 30 independent code families**, before a tree ranker | 0 |
| 2 | Opportunity | opportunity-level decisions with the eventual result of the research they led to | each label costs a whole research run; tens of researched opportunities before even a rule comparison means anything, hundreds before a model | 0 |
| 3 | Protocol understanding | human-written reference models (assets, relations, actors) of real protocols, sealed before the builder is frozen | 10–20 protocols for rule evaluation; far more for a learned extractor | 0 |
| 4 | Mechanism / causal | leads with a stated mechanism and an independent reproduction that tested that mechanism | on the order of 100 reproduced or refuted leads across classes | 0 (2 corpus reentrancy adjudications, sign-off pending) |
| 5 | Future-state | prediction records registered before execution, resolved by EVM observation | cheap to generate once C5 exists: thousands of transitions; the limit is variety of code families, not count | 0; no prediction record exists |
| 6 | Counterfactual | sequences with an EVM replay result; controls where the relation truly holds | hundreds of replayed sequences; tens of control contracts not self-authored | 0 on real bytecode |
| 7 | Consequence | measured effects per class from an oracle, including "vulnerable, not exploitable" twins | tens per class to check a rule; hundreds for a model | 5 dev labels carry `exploitable`; none measured by execution in this environment |
| 8 | Self-model | predicted-versus-observed abstention pairs; per-engine outcomes on real code | abstention pairs: hundreds are cheap after a few real runs. Reliability: at least `MIN_ADJUDICATED` (5) per capability to *show*, far more to *use* | 0 from real code (self-authored fixtures only) |
| 9 | Failure attribution | adjudicated failures (refuted leads, misses) each with a human-assigned cause | 50–100 attributed failures before a cause vocabulary is stable | 0 |
| 10 | Linked memory | no training data needed; a sealed set of known repeat issues to measure retrieval and over-merging | tens of repositories with several analysed commits | 0 real multi-commit histories |
| 11 | Discovery | shared models of many protocols, with adjudicated status, to form a baseline | at least 30 code families (the same floor as above) for a baseline; more for anything statistical | 0 |
| 12 | Learned action policy | everything in row 1, plus logged decisions under a frozen rule policy with exploration | the row-1 threshold is a minimum; a sequential policy needs more than a ranker | 0 |

**How long this takes is not a modelling question.** At roughly 10 focused model reviews a day under the US$1 daily cap, with one
tools machine and a human adjudicating every outcome, 200 adjudicated real-code outcomes is months of operation, and only after
C4–C6 exist.

---

## Part 6. Dependency-ordered sequence

Each step produces what the next one needs. Nothing here is proposed for immediate build; the C4/C5 plan is the separate
document `c4-c5-tools-and-reproduction-plan.md`.

| order | step | why it must come first | produces | needs approval |
|---|---|---|---|---|
| 1 | **Independent reproduction (C4 tools environment, C5 reproduction tests)** | without a cross-family execution result there is no trustworthy basis for any outcome, so no label | `foundry-forge` evaluations on real bytecode: supported, contradicted, inconclusive | yes: binaries, image, machine |
| 2 | **Decisions and non-actions (promote drafts 0009, 0010, R3b; C6, C7)** | without the record of what was chosen and skipped, outcomes cannot be attributed to choices, and selection bias cannot be corrected | decision candidates with features; coverage; human outcomes | yes: production migrations |
| 3 | **Rule baselines, frozen** | a learned component needs something to beat; the rule policy's score on a preregistered set is that baseline | `research-policy/N` by hash with a recorded held-out score; the attention and action baselines | corpus approval (A22/A23, R12) |
| 4 | **Lessons writer** (`knowledge_items`) | failure attribution and memory need a place where a cause is recorded, gated on an adjudicated outcome | lessons linked to outcomes by lead key | release only (table exists); a foreign-key link would be a migration |
| 5 | **Prediction records** | future-state, consequence, mechanism and counterfactual quality can only be scored if the prediction was registered first | predictions resolved by execution | blob-only start: release; a table: migration |
| 6 | **Learned components**, one at a time, in shadow | only now do labels, baselines, held-out data and prediction records exist | a model version by hash, compared with its rule baseline | owner approval per promotion; A31 for any model call |

In parallel with steps 1–2, and not blocking them: the missing model sections (`assets_accounting`, `invariants`, actors). They
are rule work on C1 and are prerequisites for capabilities 3, 5, 6, 7 and 11.

**Within step 6 the realistic order** is the self-model's measured rates (a table, not a model), then attention (the most data per
run), then the action policy, with mechanism and consequence as prompted-model reviews under the budget caps. Opportunity and
discovery come last: they have the fewest labels and the least definition.

---

## Part 7. What this assessment could not establish

- **Whether C1–C3 are merged.** Part 7 of the inventory says branch `c1-c3` is "not merged"; the history at `b8317cc` contains a
  merge commit for C1–C3. Either way they are not released or deployed.
- **Whether the shared model fits the 1 MiB blob limit on a real protocol.** No real protocol has been modelled with C1.
- **Any production fact.** "No run has executed in production", "tables applied" and component availability are operator facts
  quoted from the inventory, not re-checked.
- **The contents of the held-out corpora and `heldout5`,** which were not opened; statements about them come from other documents.
- **The data amounts in Part 5,** other than the 200 / 30 threshold from `ml-readiness.md`, are estimates.
- **`knowledge_items` having no writer** is taken from the inventory's citation of `architecture-gaps.test.ts`; the test was not
  re-run here.
