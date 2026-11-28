# C4 gap reconciliation, experience records, and the first two model templates

**Status: ASSESSMENT AND DESIGN ONLY. Nothing here is approved or implemented.** Written 2026-11-28 against commit `97137c7`.
Documentation only: no code, test, schema, secret, image or deployment was changed; nothing was installed, downloaded or executed;
no network call was made. The held-out corpora (`eval/heldout*`, `eval/benchmark-b`, `eval/heldout5`) were not opened.

**Status words used:** *designed*, *implemented*, *tested*, *integrated*, *demonstrated*, *independently reviewed*,
*operationally verified*, *production deployed*. For a table, three more labels: **applied** (in `db/migrations`), **draft** (in
`db/drafts`, applied only on throwaway databases) and **no writer** (the table exists and no application code writes to it).

**Evidence.** Every gap in Part A was re-checked in the source at `97137c7` and is cited as `file: symbol`. "Applied" means the
migration file is in `db/migrations`. Whether it is applied **in production**, and whether any research run has executed there, are
operator facts recorded in `engine-inventory-and-coordination.md`; they were not re-checked here.

"The plan" is `docs/architecture/c4-c5-tools-and-reproduction-plan.md`. Its step numbers (1–19) and approval numbers (1–21) are
used as written there.

---

## Summary

1. **All 14 gaps of the plan are open today.** Each was re-verified in the code. None has been closed, because the plan is a
   plan: nothing in it was built.
2. **The plan assigns a closing step to 11 of the 14.** Three have no numbered step: **A12** (large raw output is dropped; a
   design exists in the plan's 2.7 but no step implements it), **A13** (Foundry never emits `contradicts`; step 13 *decides* the
   rule, no step implements it) and **A14** (the worker app reuses the hub image; steps 8, 14 and 15 create a different image and
   app, which makes A14 irrelevant rather than closing it, and `fly.worker.toml` stays as it is).
3. **Closing a gap with a stand-in is not closing it.** For most of the gaps the plan's closing step is "dev-only". Those steps
   can show the code path with stand-ins. For every gap that concerns real tool behaviour, closure is *demonstrated* only at step
   9 or 10, with a checksum-verified forge, which needs owner approval.
4. **Sixteen further gaps were found** (Part A.2). The most consequential: the Foundry step keeps only the first run's stdout and
   no stderr or exit code; the evaluation's input hash does not include the compiler or tool, so a re-run with another compiler
   collides with the first; the repository's own tests can run beside the generated one; and the test-author check is by id, not
   by analysis family.
5. **Experience records: of the owner's 14 items, 4 are held by applied tables, 4 only partly, and 6 not at all** without a draft
   or a new record. The missing six are the ones learning depends on: experiments *not* performed and why, reproduction results,
   the final outcome, failure attribution, lessons, and which later decisions a lesson influenced.
6. **What cannot be reconstructed afterwards must exist before the first real investigation:** decisions and non-actions (draft
   0010), outcomes and coverage (draft 0009 with R3b), predictions registered before the experiment, and the reasons an engine did
   not run. The recommended approval order puts these first.
7. **Of the eight outcome types the owner lists, two can be captured in production today in a weak form** (inconclusive;
   disproved only as "contradicted in a bounded model"), **one partly** (a decision not taken, at opportunity level only), and
   **five cannot** (confirmed, failed reproduction, incorrect prediction, unsuccessful strategy, missed opportunity).
8. **The learning threshold stays as `docs/ml-readiness.md` states it:** at least 200 adjudicated real-code outcomes, with
   positives from at least 30 independent code families, before any learned ranker. Nothing here lowers it. Today's count is 0.

---

# Part A. Reconciliation of the 14 gaps

## A.1 The 14 gaps, re-verified

**Every row's status is OPEN.** "Dev-only" and "approval" are the plan's own classes: *dev-only* is code and tests in a
development branch with stand-ins; *approval* is an explicit owner decision before the step.

| # | gap | evidence in the code at `97137c7` | plan step that closes it | how closure will be demonstrated | dev-only or approval | status |
|---|---|---|---|---|---|---|
| **A1** | The version check trusts a string | `engine/tools/run-tool.ts: toolVersion` takes the first match of `/(\d+\.\d+\.\d+)/` in `--version` output. `engine/tools/foundry.ts: runForgeTest` compares it with `FOUNDRY_VERSION` and nothing else | **1** (run-time re-hash; `tool_checksum_mismatch`), **2** (fill the lock) | a binary printing `1.5.1` whose SHA-256 is not in the lock is refused. With stand-ins this shows the check; with the real binary at step 9 it shows the pin | step 1 dev-only; step 2 **approval** (outbound hosts) | **open** |
| **A2** | No binary checksum anywhere | no code in `engine/tools/` or `tool-host/` reads a tool binary to hash it; `sha256` in `run-tool.ts` is applied to inputs and outputs only | **1**, **2**; real at **9** | the tool manifest in an evaluation carries `binary_sha256` values equal to the committed lock (the plan's acceptance criterion 6) | as A1; step 9 **approval** | **open** |
| **A3** | Foundry gets no dependencies and no remappings | `foundry.ts: runForgeTest` writes `src = "."`, `libs = ["lib"]`, no `remappings`. `engine/reproduction.ts: processFoundryValidateStep` reads only `repo_snapshot_files` of the run's own snapshot, `path LIKE '%.sol'` | **4** | a fixture with a submodule import compiles when the C3 dependency files and `usableRemappings` are materialised; without them it is `missing_dependency`. **Real compile only after step 9** | dev-only (stand-in); real: **approval** | **open** |
| **A4** | The generated `foundry.toml` does not state the safety settings | the generated file sets `src`, `test`, `libs`, `offline`, `solc` only (`foundry.ts`, the `toml` string) | **3** | the generated config contains `ffi = false`, `fs_permissions = []`, no RPC keys; the canary tests of step 9 call `vm.ffi` and the file cheatcodes and fail | dev-only to write; the canary is **approval** (step 9) | **open** |
| **A5** | Limits are a timeout and an output buffer only | `tool-host/exec.ts: execFixed` passes `timeout` and `maxBuffer` (32 MiB default) to `execFile`; nothing else | **6** | a test contract that allocates without bound ends as `memory_limit`; a fork bomb ends at the process limit. Needs a real process, so step 9 or later | dev-only to implement; demonstration **approval** | **open** |
| **A6** | A timeout kills one process | `execFixed`: `killSignal: "SIGKILL"` on the direct child; no process group, no cgroup | **6** | after a forced timeout no descendant of the tool process is alive | as A5 | **open** |
| **A7** | One solc for everything | `processFoundryValidateStep` reads one `AGENTSMITH_SOLC_BIN`; `runForgeTest` writes that single path into the config. **The solc binary's version is never checked at all** (only forge's is) | **5** | a pure function selects the highest pinned version satisfying every pragma; a `0.7` fixture returns `unsupported_compiler_version` until a `0.7` build is in the lock | dev-only; each added solc version is **approval** (plan approval 4) | **open** |
| **A8** | The round needs draft tables | `reproduction.ts: reproduceInputSchema` requires `decisionId`; `importTest` and `processFoundryValidateStep` both `INSERT INTO research_effort` (draft 0009, with the `decision_id` column of draft 0010) | **12** | the reproduction step runs on a database with only the applied migrations | dev-only; release is **approval** | **open**. **Note:** the plan closes it by *removing* the dependency ("decision recorded in the step output for the first slice"), not by promoting the drafts. See Part B.4: that choice means the first reproductions carry no decision record |
| **A9** | The round needs direct database access | `processFoundryValidateStep` calls `ctx.pool.query` five times (lines 101–138) and builds its `ResearchStore` on `ctx.pool` | **11** | the tools machine holds no database credential and the reproduction completes through the worker API | dev-only to implement; **approval** of the D1 exception before release (plan approval 10; proposal P2) | **open** |
| **A10** | Option D has no place for a Foundry result | `worker-api.ts: RESEARCH_STEP_KEYS` has no reproduction key; `OPERATIONS.record_evaluation` always throws 403 `evaluations_are_api_derived` | **11** | a strictly typed report is accepted, a report with an outcome field is refused, and `record_evaluation` is still refused | as A9 | **open** |
| **A11** | One reproduction round per run | `reproduction.ts: reproductionRoundUsed`; `0001_initial.sql`: `UNIQUE (workflow_run_id, step_key)` on `workflow_steps` | **12** (an ordinal step key) | a second round on the same run is created and completes | dev-only | **open** |
| **A12** | Large raw output is dropped | `processFoundryValidateStep`, line 129: the blob is stored only when `Buffer.byteLength(r1.rawOutput) <= 1_048_576`, else `null`. 0007 limits a blob to 1 MiB | **none numbered.** The plan's 2.7 designs truncation with the full digest recorded | an oversized output is stored as a prefix with `truncated: true` and the full-stream digest; the verdict is `inconclusive` if the parsed part is incomplete | dev-only once a step exists | **open; NOT closed by any numbered step** |
| **A13** | Foundry never emits `contradicts` | `reproduction.ts`, line 114: the recorder's type is `"supports" \| "weakens" \| "inconclusive"`; line 134 writes `weakens` for a passing refutation | **13** *decides* the rule. No step implements it | under an approved rule, the fixed twin is recorded as `contradicts` on real Foundry; if declined, as `weakens`, with the acceptance criterion reworded first | **approval** (plan approval 9; proposal P1) | **open; a policy decision, not a defect. NOT closed by any implementation step** |
| **A14** | The worker app reuses the hub image | `fly.worker.toml`, `[build]`: "The same release image as the hub". `tsconfig.build.json` excludes `**/tool-host/**`, so that image cannot start a process | **8, 14, 15** create a separate tools image and app. `fly.worker.toml` is not changed | a tools machine built from the tools image passes the smoke test of step 9 and the checks of step 16 | **approval** for each (build, publish, app, machine) | **open; superseded rather than closed.** The worker app still cannot run tools, which is acceptable only if the decision of plan approval 6 is "separate app" |

**Reading of the table.**
- Steps 1 and 3–7 and 11–12 are dev-only. They can make the code right. They cannot *demonstrate* anything about real tools.
- The first step that demonstrates any of A1–A7 is **step 9**, the first real Foundry execution, which needs approval to download
  and install binaries.
- A stand-in result is never evidence of closure. The plan says so; this table applies it per gap.

## A.2 Further gaps found while re-verifying

Each was checked in the code. "In the plan?" says whether the plan mentions it and whether a numbered step covers it.

| # | gap | evidence | in the plan? | consequence | closing action (proposed) |
|---|---|---|---|---|---|
| **B1** | The repository's own tests can run beside the generated test | `foundry.ts: FORGE_ARGS` is `test --offline --json --match-test <pattern>`; the workspace holds every `.sol` file of the snapshot, including the repository's `test/` tree | mentioned in 3.7 (`--match-path`, leave out `test/` and `script/`); **no numbered step** (step 3 covers configs and scripts) | untrusted repository tests whose names match are executed; their results enter the verdict (every matched test must pass) | add to step 3: `--match-path` for the generated file, and exclude repository test and script trees unless imported |
| **B2** | Only the first run's stdout is kept; stderr, exit code and the second run's raw output are not stored | `reproduction.ts`, lines 129–130: the blob is `r1.rawOutput`; the `tool` object holds parsed `results` and `second_run_results` | 3.6 lists raw output for four executions; stderr and exit codes are not mentioned | the owner's rule "preserve all raw outputs" is not met; a compile error's text survives only as a 2000-character tail in the rationale | the report of proposal P2 (every stream of every run); the same for the direct path |
| **B3** | The evaluation's input hash omits the compiler, the tool, the config and the dependencies | `reproduction.ts`, line 113: `sha256(manifest \| tests \| match \| intent)` | described in 2.9; **no numbered step** | the 0015 idempotency key is (hypothesis, evaluator, version, input hash). A re-run with a different solc has the same key: the same outcome silently returns the first evaluation, a different outcome is a conflict (`research-state.ts: recordEvaluation`) | include tool-lock hash, solc version, config hash, dependency manifest digest, oracle hash and rule version in the hashed input |
| **B4** | Who declares what "pass" means | `reproduction.ts: testImportSchema`: `intent: "demonstrate" \| "refute"` is supplied by the test author; there is no oracle, control or cheatcode check | yes: 3.3, step 7 | the author decides whether a passing test is `supports` or `weakens` | registered oracles (`docs/proposals/c5-oracle-and-independence.md`) |
| **B5** | The test-author check is by id, not by analysis family | `reproduction.ts: appendReproductionIn` and `importTest` compare `generator_id === author.id`. `claude-reproducer` is not in `analysis-identity.ts: ANALYSIS_IDENTITIES` | the rule is stated (3.3 rule 7; approval 15 for the role); **no step implements the family check in code** | a `claude-hunter` claim tested by `claude-reproducer` and run by Foundry is `cross_family` in `evaluation_independence` | a family table for authors in code (no migration); the `test_author` role by migration later |
| **B6** | Foundry evaluations are recorded without a provenance row | the `record` helper in `processFoundryValidateStep` calls `store.recordEvaluation` with no `provenance` argument | partly: 3.6 "Labelling"; approval 16 | no `evaluation_provenance` row; the dossier shows such an evaluation as `worker_reported` even on the direct path; the raw output is linked only from the step output | P2 draft A (an honest `recorded_by` value), or a deliberate "no row" rule that is written down |
| **B7** | Both status views keep only each evaluator's latest evaluation | `0007: hypothesis_status` and `0016: hypothesis_independence` use `DISTINCT ON (hypothesis_id, evaluator_id)` ordered by the latest event | no | a later `inconclusive` re-run by `foundry-forge` hides an earlier `supports` in both views | a write rule: an operational failure on a re-run is recorded in the step output, not as a new evaluation (oracle document, OD-8) |
| **B8** | The derived status calls every evaluator's result a "static check" | `0007: hypothesis_status` yields `contradicted_by_static_check` / `weakened_by_static_check` for any evaluator | no | a Foundry result would be labelled as static | presentation shows the evaluator family; a view change is a migration |
| **B9** | In draft 0009 a human `refuted` may rest on a `contradicts` of any family | `db/drafts/t144-research-memory/0009_research_memory.sql: hypothesis_outcome_rules`; draft R3b tightens `confirmed` only | no | a parser-family `contradicts` (bounded model) can ground a `refuted` label | a change to the R3b **draft**, decided with it |
| **B10** | Availability is a declaration, not a probe | `engine/capabilities.ts: availability` returns "available" when the environment variables are set | listed in the plan's 1.1 table, **not among the 14**; step 1 adds the run-time re-hash but does not change `availability` | `/v1/engine/components` can report a tool as available when the binary is absent or wrong | derive availability from the last successful checksum-verified run, or label it "configured" |
| **B11** | The `foundry-forge` capability advertises classes no template will cover | `capabilities.ts`: `classes: [...STRUCTURAL_CLASSES, ...NOT_MODELLED_CLASSES]` | no | the registry says Foundry can evaluate accounting and oracle-manipulation leads; with a template author it cannot | advertise only the (class, mechanism) pairs with a registered oracle |
| **B12** | The failure classification was written against a stand-in | `foundry.ts: runForgeTest` decides `compile_failed` by the regular expression `/Compiler run failed\|Error \(/` on stderr and stdout; `parseForgeJson` assumes a JSON shape never seen from a real forge | yes: Part 7 | a real compile failure may be reported as `output_invalid`, or the reverse | corrected at step 9 from real output |
| **B13** | The plan's `contradicts` wording conflicts with a dev label | plan 3.4 against `eval/dev/labels.json`: `Bank.withdrawBad` is `vulnerable: true, exploitable: false`, and would satisfy "rejected by the contract itself; the oracle did not fire" | the plan notes the case in 5.1 and does not reconcile it with 3.4 | a true pattern claim would be recorded as contradicted | the refutation-witness rule (proposal P1; oracle document, section 7) |
| **B14** | A lessons writer is not "release only" | `db/runtime-grants.json` grants the runtime role `SELECT` only on `knowledge_items` and `knowledge_links`. `0001_initial.sql` defines no append-only trigger on them and no link to hypotheses, outcomes or decisions. `architecture-gaps.test.ts` asserts no application code inserts into them | `intelligence-model-compatibility.md` Part 6 says "release only (table exists)" | a lessons writer needs either the API's owner connection or a grant change, and the table is mutable today | Part B.3, addition 5 |
| **B15** | The first reproductions would carry no decision and no effort record | plan step 12: "decision recorded in the step output for the first slice" | it is the plan's own choice | "why this lead was reproduced and that one was not" would be JSON in a step output, outside the decision records, and not comparable with later data | approve drafts 0009 and 0010 before the first real investigation (Part B.4) |
| **B16** | The real-binary tests do not run by default | per the plan's 1.1, the Slither real-binary test "is skipped unless installed", and Foundry is "tested only with the stand-in" | yes | a green test suite says nothing about real tools | the step 9 smoke test, recorded with binary hashes |

**None of B1–B16 is closed.** B1, B3 and B5 are described by the plan and assigned to no step; they should be added to steps 3, 1
and 7 respectively. B7–B11 and B14 are not in the plan.

---

# Part B. Experience records

## B.1 The owner's 14 items, mapped

For each item: where it is held today, and what kind of record that is. **"Applied" describes the schema. Per the inventory, no
research run has executed in production, so every applied research table is empty of real investigations.**

| # | what every investigation should retain | applied table or field | draft | no writer / missing | verdict |
|---|---|---|---|---|---|
| 1 | **The initial question** | `workflow_runs.input` (the repository and ref submitted), `created_by`; `audit_events`. For a bounty-linked run, the link of 0012 | `research_decisions` (0010): a `level = 'repository'`, `decided_by_kind = 'human'`, `mode = 'manual'` decision with `rationale` | **missing:** a structured statement of what is being asked ("is X exploitable", "audit the vault"). Today the run input says *which code*, not *what question* | **partly** |
| 2 | **Protocol and snapshot identity** | `repo_snapshots` (repository, `commit_sha`, `manifest_sha256`), `repo_snapshot_files`, `snapshot_verifications` (0015: commit, tree, verified against GitHub). Programme identity: 0011–0014 | `snapshot_dependencies`, `package_snapshots` (c3); the dependency manifest is already a blob cited from the step output | — | **held** |
| 3 | **The model version used** | For engines: `hypotheses.generator_version`, `hypothesis_evaluations.evaluator_version`, the analyze step output's `analyzer` and `analyzer_build {commit, image}`. For the protocol model: `shared_model_schema`, `shared_model_sha256` in the step output (implemented in development). For an AI model: `hypothesis_reviews.model_provider`, `model_name`, `model_prompt_version`; `model_usage_events` (0001) | `attended_model` kind with a prompt-pinned version (0010); `research_decisions.policy_sha256` | **missing:** the exact model id a provider returned for a call; any learned-model artefact hash (no learned model exists) | **partly** (complete for deterministic engines) |
| 4 | **Hypotheses generated** | `hypotheses`, `hypothesis_evidence`, `evidence_spans`, `hypothesis_events` (0007). Lead keys in the producing step's output | `hypothesis_leads` (c2), an index | — | **held** |
| 5 | **Engines selected, and engines NOT selected with why** | selected: `workflow_steps` rows by `step_key`, and the run input flags. Not selected, in part: Slither's abstention code in its step output; `no-independent-validator` evaluations; APEX abstentions in the shadow record | `research_decision_candidates` (0010). **But its `candidate_kind` has no engine value;** the engine choice is recorded as a *feature* (`capability_values`) on the chosen component (`engine/loop.ts: chooseCapability`), and only for capabilities that were available | **missing:** an engine that was not even a candidate because it was unavailable or not enabled, with the reason | **partly** |
| 6 | **Experiments performed, and NOT performed with why** | performed: `workflow_steps`, `hypothesis_evaluations` | `research_decision_candidates` with `defer`, `skip_*`, `request_human_review` and `reason`; `research_coverage` with `abstained`, `not_modelled`, `out_of_scope` and `reason_code` (0009) | on the production path nothing records an experiment that was not run | **draft only** for the "not performed" half |
| 7 | **Evidence, supporting and contradictory** | `hypothesis_evaluations` (`supports`, `weakens`, `contradicts`, `inconclusive`), `evaluation_evidence`, `evaluation_provenance` (0015), all append-only. Both sides are kept per engine in `lead-identity.ts: Investigation.contradictions` | `hypothesis_evaluations.artifact_sha256` (0009) | — | **held** |
| 8 | **Independent evaluation** | `analysis_identities`, `evaluation_independence`, `hypothesis_independence` (0016); the self-evaluation trigger | R3b (family-level rule for `confirmed`) | the test author's family; the execution tier (proposal P2) | **held at id level; partly at family level** |
| 9 | **Reproduction results** | none on the production path: no reproduction step exists there | the round in `reproduction.ts` needs 0009 and 0010 | real Foundry has never run; every recorded result so far is from a stand-in, which does not count | **missing** |
| 10 | **The final outcome** | none. `hypothesis_status` never says confirmed | `hypothesis_outcomes` (0009), human-only, with `supersedes_id`; R3b | — | **draft only** |
| 11 | **Uncertainty** | the `inconclusive` outcome; `Epistemic` status and `not_computed` sections in the shared model blob; `unresolved_questions`; the dossier's `limitations`; `knowledge_items.confidence` (no writer) | `Feature.unknown_reason` in decision candidates (0010); `selection_probability` | **missing:** a structured abstention reason on an evaluation (today a rationale prefix); a probability on any prediction (no prediction record) | **partly** |
| 12 | **Failure attribution** | none | `missed_in_runs`, `ground_truth_adjudications` (0009) record *that* something was missed or mislabelled, not *why* | **missing:** a cause vocabulary and a record of the cause | **missing** |
| 13 | **Lessons** | `knowledge_items`, `knowledge_links` (0001): **applied, no writer** | — | no writer; no link to outcomes; mutable; runtime role cannot insert (gap B14) | **no writer** |
| 14 | **The subsequent decisions influenced** | none | `research_decision_candidates.features` requires a `source` on every feature: a lesson id can be that source | **missing:** nothing reads lessons, so nothing can cite one | **missing** |

**Count:** held by applied tables: 2, 4, 7 and (at id level) 8. Partly: 1, 3, 5, 11. Draft only, no writer or missing: 6 (the
"not performed" half), 9, 10, 12, 13, 14.

## B.2 Which outcome types can be captured today

"Today" means with the applied migrations only (0001–0016), on the production path.

| outcome type | captured today? | how, or what is missing |
|---|---|---|
| **confirmed** | **no** | needs `hypothesis_outcomes` (0009) with R3b, a human adjudication review, and a cross-family `supports`. The nearest today is `hypothesis_independence.independently_supported`, which is not a label |
| **disproved** | **weakly** | a `contradicts` evaluation by a bounded validator can be recorded today. It is a counterexample **in a bounded model sharing the generator's parser**, not a disproof on bytecode. A human `refuted` needs 0009. A Foundry `contradicts` needs proposal P1 and a reproduction path |
| **inconclusive** | **yes, as an evaluation** | `inconclusive` with a rationale; `no-independent-validator`. As a human outcome: no (0009). A structured reason is missing |
| **failed reproduction** | **no** | no reproduction step on the production path. With the drafts it is an `inconclusive` evaluation with a failure code plus the step output; "no test written" is step output only. Must be kept distinct from `consequence_not_demonstrated`, which is not a failure (oracle document, section 7) |
| **incorrect prediction** | **no** | no prediction record exists anywhere. Nothing is registered before an experiment |
| **unsuccessful strategy** | **no** | needs a decision (0010), its cost (`research_effort`, 0009) and its outcome or coverage. A run that produced nothing is visible; the strategy it embodied is not recorded |
| **missed opportunity** | **no** | needs `missed_in_runs` and the `missed` outcome category (0009), plus the coverage row that claimed the component was examined |
| **decision not taken** | **partly** | at opportunity level a human `dismissed` event exists in `opportunity_events` (0008, applied). At repository, component, function and hypothesis level: draft 0010 only |

**So today the system can record what it claimed and what a bounded model said about it. It cannot record that it was right,
that it was wrong, what it chose not to do, or what it failed to find.**

## B.3 Minimal additions

Reuse of existing structures only. **No new memory subsystem, no new store, no vector index.** The one rule from
`intelligence-model-compatibility.md` 3.2 is kept: one claim store (0007), one issue identity (the lead key), one decision record
(0010), one lessons table (`knowledge_items`).

### Additions that need no migration (code and release only)

| # | addition | reuses | closes item |
|---|---|---|---|
| 1 | **The question.** A `question` object in `workflow_runs.input` (`text`, `asked_by`, `kind`), validated by the intake schema | `workflow_runs.input` (jsonb) | 1 |
| 2 | **Engines not run, with the reason,** in the output of the step that would have scheduled them: `engines_not_run[] {engine, version, reason_code, detail}` with reasons such as `not_enabled_for_run`, `tool_unavailable`, `unsupported_class`, `budget` | `workflow_steps.output`; the pattern of Slither's `abstention {code, detail}` | 5 |
| 3 | **A structured abstention document** per abstaining evaluation, cited by hash from the rationale prefix `abstained:<code>@<file:line>` | `research_blobs`; option A of the inventory's 4.5 | 11 |
| 4 | **A prediction record, as a blob:** `{shared_model_sha256, lead_key or model element, question, predicted, predictor@version, probability or abstain}`, its hash written into the **input** of the step that will test it, so it exists before the experiment; resolved in that step's output | `research_blobs`, `workflow_steps.input`/`output` | the "incorrect prediction" outcome type |
| 5 | **The reproduction evaluation document** with oracle, controls, limitation codes and every raw-output digest | `research_blobs`, `evaluation_provenance.output_blob_sha256` | 9 (with C4/C5) |
| 6 | **Exact model id** returned by a provider, recorded where a review is written | `hypothesis_reviews.model_name` already exists; the rule is to store the returned id, not the requested alias | 3 |

### Additions that are migrations (draft descriptions only; nothing is written or applied here)

| # | migration | content | exists as |
|---|---|---|---|
| M1 | **Research memory** | `hypothesis_outcomes`, `research_coverage`, `research_effort`, `missed_in_runs`, `ground_truth_adjudications`, `external_references`, `hypothesis_evaluations.artifact_sha256` | draft `db/drafts/t144-research-memory/0009_research_memory.sql` |
| M2 | **Outcome independence** | replaces `hypothesis_outcome_rules`: `confirmed` needs a cross-family `supports`. Proposed additions to the draft: `refuted` on a cross-family `contradicts` (gap B9); an execution-tier condition (proposal P2, draft C) | draft `db/drafts/r3b-outcome-independence`; ships with M1, after it |
| M3 | **Decisions and non-actions** | `research_decisions`, `research_decision_candidates`, the decide-before-acting trigger, `decision_id` on coverage and effort. **The draft also bundles** the opportunity-registry changes and the `attended_model` kind | draft `db/drafts/a29-engine-loop/0010_engine_loop.sql`; requires M1 |
| M4 | **Engine as a decision candidate** (a small change to the M3 draft before it is applied) | add `capability` to `research_decision_candidates.candidate_kind`, so "engine considered and not chosen, with the reason" is a row, not a feature on another row | **new; a change to a draft** |
| M5 | **Lessons, on the existing table** | on `knowledge_items`: an append-only trigger (reusing `research_reject_mutation`); a check on `item_type` for the lesson and attribution types; nullable `lead_key`, `hypothesis_outcome_id`, `decision_id`, `shared_model_sha256`; a rule that a lesson cites an outcome. Plus an INSERT grant, or writes through the API's owner connection | **new.** Requires M1 and M3 for the references |
| M6 | **Lead index** | `hypothesis_leads`, `lead_investigations` | draft `db/drafts/c2-lead-identity` |
| M7 | **Dependency records** | `snapshot_dependencies`, `package_snapshots` | draft `db/drafts/c3-dependency-records` |
| M8 | **Honest provenance value** for worker-reported execution; optional `execution_tier` | `evaluation_provenance.recorded_by` check widened | proposal P2, draft A |
| M9 | **Oracle registry** | `oracle_registrations`; `oracle_sha256` on evaluations | oracle document, 4.2 |
| M10 | **Learning view** | `research_decision_examples`, labels only from `hypothesis_outcomes` | designed in `research-decision-records.md` 2.4; in no draft |

**Failure attribution and lessons without M5, to start.** A lesson can be written by the API's owner connection as a
`knowledge_items` row with: `item_type = 'lesson/1'` or `'failure-attribution/1'`; `source_uri` in a fixed form naming the outcome
and the lead key; `source_hash` equal to the SHA-256 of a structured body stored in `research_blobs`; `supersedes_id` for a
correction. That works on the applied schema. It is weaker than M5: nothing stops an edit, and the link is a string. Use it only
until M5.

**"Subsequent decisions influenced" needs no table.** Draft 0010 already requires a `source` on every decision feature. A policy
that uses a lesson cites the lesson's id as that source. "Which decisions did this lesson influence" is then a query over
`research_decision_candidates.features`. The requirement is a rule, not a schema: **a lesson may affect a decision only through a
cited feature.**

**A proposed cause vocabulary for failure attribution** (a design, to be fixed with the owner before use; `docs/analyzer-failure-classes.md`
exists and was not re-read for this document):
`wrong_anchor`, `wrong_class`, `parser_misread`, `model_section_missing`, `unsupported_feature_not_predicted`, `oracle_not_applicable`,
`oracle_too_strict`, `oracle_too_loose`, `template_defect`, `dependency_missing`, `compiler_unsupported`, `not_selected_low_score`,
`not_selected_budget`, `not_selected_engine_unavailable`, `duplicate_not_detected`, `human_error`, `unknown`. Attribution is
assigned by a human; `unknown` is always allowed.

## B.4 Order of approval, so that the first real investigations already produce learnable data

**The governing fact:** some records can be added later and backfilled; others cannot be reconstructed once the investigation has
happened.

| cannot be reconstructed afterwards | can be added later without loss |
|---|---|
| what was considered and not chosen, with the features and score at the time (M3, M4) | the lead index: the keys are already in step outputs (M6) |
| the probability with which an exploration pick was made (M3) | dependency tables: the manifest blob holds the content (M7) |
| a prediction made before the experiment (addition 4) | lessons and attribution: written by a human after the outcome (M5) |
| why an engine did not run (addition 2; M4) | the learning view: derived (M10) |
| the oracle version an evaluation ran under (addition 5; M9 optional) | |
| what was examined and with what coverage result (M1) | |
| the model and engine versions (already recorded) | |

**Recommended order.** Each is a separate approval.

| order | approve | why here |
|---|---|---|
| **0** | Release of additions 1–6 (no migration) | they cost nothing in schema and make every run's question, non-runs, abstentions and predictions visible from the first run |
| **1** | **M1 + M2 together** (0009 with R3b) | a human cannot record `confirmed`, `refuted`, `inconclusive`, `duplicate` or `missed` without them; coverage rows must be written **during** the run. Without M1 the first investigation ends with no outcome on record |
| **2** | **M3, with M4 folded in before it is applied** | decisions must be written before the work they cause (the draft's own trigger enforces that order), so this cannot follow the first run. The owner should note that 0010 bundles the opportunity registry and the `attended_model` kind; approving M3 approves those too unless the draft is split first |
| **3** | The C4/C5 approvals (the plan's Part 8) and proposals P1 and P2; M8 before any production reproduction | reproduction results (item 9) |
| **4** | M5 | when the first adjudicated outcome exists and a lesson is about to be written. Until then, the no-migration form |
| **5** | M6, M7, M9, M10 | when cross-run lookup, dependency queries, oracle enforcement or a training export is actually needed |

**The one thing to avoid:** running the first real investigations on the applied schema alone, with decisions "in the step
output for the first slice" (the plan's step 12, gap B15). Those investigations would be the most expensive data the project
ever produces and would be missing exactly the fields a learner needs: the alternatives, their features, and the reason for each
non-action. If steps 1 and 2 above cannot be approved first, the first runs should be treated as **demonstrations, not training
data**, and labelled so.

## B.5 The threshold is unchanged

`docs/ml-readiness.md` §5.3 stands as written: **at least 200 adjudicated real-code outcomes, with positives from at least 30
independent code families, before a tree ranker is trained**; a code-family split; a preregistered metric; shadow mode beside the
rule policy; promotion only by owner approval. "Adjudicated" means a human `hypothesis_outcomes` row resting on independent
evidence. Engine output, a Foundry `supports` without a human outcome, a stand-in result and a corpus label are not such outcomes.
The current count is 0. Nothing in this document proposes training, shadow deployment or any use of a learned model.

---

# Part C. Per-model templates for the first two capabilities

**DESIGN ONLY.** These are templates, filled in for the first two capabilities in the owner's suggested order. Neither describes
a learned model: both start as deterministic code and records. Nothing here is implemented beyond what is cited as existing.

## C.1 Protocol understanding (assets, accounting, invariants, actors)

| field | content |
|---|---|
| **Purpose** | state what the protocol *is* in terms every other capability can read: what assets it holds, which state records who is owed what, which relations must hold, and who can act. Today the shared model has the structure (contracts, functions, state, permissions) and lacks exactly these four: `assets_accounting`, `invariants` and `actors_permissions.actors` are `not_computed` (`shared-model.ts`) |
| **Inputs** | the sealed snapshot's sources; the C3 dependency manifest and dependency sources; the existing sections of `agentsmith-shared-protocol-model/1`. Nothing from any generator's claims |
| **Outputs** | three sections under a **new schema version** `agentsmith-shared-protocol-model/2`: `assets_accounting` (assets held, ledger variables, aggregate variables, the candidate relation between them), `invariants` (candidate relations, each with its origin and its check status), `actors` (the accounts that matter, derived from roles and entry points). Each is `computed` with provenance or `not_computed` with a reason; never absent, never an empty list standing for "none" |
| **Versioning** | the schema version; the builder version (`shared-model-builder/N`); the document's SHA-256. A change to any rule is a new builder version. An old model is never rewritten: it is a blob |
| **Provenance** | per fact: source file, line range, the rule that produced it, and the epistemic status (`parsed`, `derived`, `verified`, `unknown`). The model records its inputs' hashes and the dependency manifest digest. Every consumer records the model hash it read (`modelReadRecord`) |
| **Uncertainty** | a candidate relation is **`derived`, never `verified`,** until an execution-family evaluator has checked it on bytecode with controls. A relation the builder cannot decide is an entry in `unresolved_questions`. An unsupported construct in the region is listed in `unsupported_features`. A model (learned or prompted) may only **propose** a relation as an unresolved question; it may never write a fact |
| **Evaluation criteria** | per section: precision and recall of facts against a **human-written reference model** of each protocol, sealed before the builder is frozen. For relations: the **false-invariant rate** on controls where the relation legitimately does not hold. For actors: agreement with the reference actor set. Reported with the abstention rate beside every figure. **Baselines:** `protocol-model/3` alone; the P2 state roles alone |
| **Relation to shared memory** | it is the shared protocol state, not a memory of its own. It is stored once per sealed snapshot in `research_blobs` and cited by hash from every hypothesis-producing step, decision (`protocol_model_sha256`), prediction, evaluation document and lesson. It supplies the oracle targets that the reproduction step may read (and that is recorded as `measurement_target_from_model`) |
| **Failure mode** | (1) a wrong relation presented as an invariant, which then produces false leads or, worse, a wrong oracle; (2) a wrong role holder, which makes the "unprivileged" actor privileged; (3) silent omission, an empty section read as "no assets"; (4) a model too large for the 1 MiB blob limit (`SHARED_MODEL_BLOB_LIMIT`), whose behaviour on a real protocol is unverified; (5) a second, private model growing inside another engine |
| **Measurable improvement criterion** | on reference models of protocols **nobody on the project inspected**, version *N+1* has higher recall of reference facts in the three sections than version *N*, with a false-invariant rate on controls that is not higher, at a preregistered threshold. Until such references exist (10–20 protocols are suggested in `intelligence-model-compatibility.md` Part 5; today there are 0), the only claim available is "computes these sections on the dev fixtures", which demonstrates mechanism |

## C.2 Linked experience memory (including non-actions and failure records)

| field | content |
|---|---|
| **Purpose** | one memory of what was asked, investigated, found, refuted, skipped, predicted, missed and learned, joined by issue identity, so that a later investigation can ask "have we seen this, what did we do, what did we decide not to do, and were we right" |
| **Inputs** | the existing records: runs and steps (0001); hypotheses, evaluations, reviews, events (0007); provenance and idempotency keys (0015); analysis identities (0016); lead keys in step outputs (`lead-identity.ts`); and, when approved, decisions and candidates (0010), outcomes, coverage, effort and misses (0009), lessons (`knowledge_items`), prediction blobs |
| **Outputs** | no new store. **Read models only:** the investigation per lead key and snapshot (`investigationsOfSnapshot`, existing); the lead's history across commits (`leadHistory`, existing); and three to add as queries: the non-actions for a lead or component with their reasons; the failure record for a lead (refuted, missed, failed reproduction, incorrect prediction) with its attributed cause; the lessons citing a lead key, class or model element |
| **Versioning** | the lead-key schema (`agentsmith-lead-key/1`); each record's own generator, evaluator, policy and oracle versions; the migration that introduced each table. A change to the key derivation is a new key schema, and old keys remain valid for old records |
| **Provenance** | every row already names its run, its step and its actor, and is append-only (0007 triggers). A decision names its policy hash and the model hash; a candidate's features each name a source; an outcome names its basis evaluations and review; a lesson names the outcome it rests on |
| **Uncertainty** | absence is explicit: coverage `abstained` / `not_modelled` with a reason code (0009), `Feature.unknown_reason` (0010), `inconclusive` evaluations. A retrieval answer distinguishes "no record" from "recorded as not examined". The key has a stated over-merge limit: two distinct issues of one class in one function share a key (`lead-identity.ts`), and it ignores component content, so "the code changed under this lead" is not visible from the key alone |
| **Evaluation criteria** | **integrity:** every stored key re-derives from its anchor (already checked by `investigationsOfSnapshot`). **Retrieval:** precision and recall of "have we seen this lead" on a sealed set of known repeats across commits. **Over-merge rate:** distinct issues sharing a key. **Completeness of the trail:** the share of adjudicated outcomes for which the question, the decision, the alternatives not taken, the evidence for and against, the reproduction result and the outcome can all be retrieved. **Baseline:** `claim_fingerprint` (per snapshot and generator) |
| **Relation to shared memory** | it **is** the shared memory. The rule it enforces on every other capability: write to exactly one of the existing records; never keep a private table, cache or file of "what I learned" |
| **Failure mode** | (1) **survivorship:** only what was chosen is recorded, so every later statistic is biased. This is the state today, because non-actions need draft 0010. (2) A lesson recorded without an adjudicated outcome behind it becomes folklore. (3) A lesson scored on the target it came from. (4) Engine output read back as if it were an outcome. (5) An unindexed scan of step outputs that becomes too slow to use, so people stop asking. (6) Mutable lessons (`knowledge_items` has no append-only trigger today) |
| **Measurable improvement criterion** | first, a completeness figure, not an accuracy figure: **for the first N real investigations, the share for which all 14 of the owner's items are retrievable** (today that share is 0, since several items have no record). Then, once repeats exist: retrieval recall on a sealed repeat set at a preregistered threshold with an over-merge rate below a preregistered bound. Whether memory *improves research decisions* is a later question, answerable only against the rule baseline after the 200 / 30 threshold of `ml-readiness.md` is met |

---

## What this document could not establish

- **Production state.** Which migrations are applied in production, whether any run has executed there, and whether the worker
  listener is enabled are taken from the repository's documents.
- **Real tool behaviour.** No gap whose closure depends on real Foundry or Slither behaviour (A3, A4, A5, A6, B12) can be judged
  until step 9.
- **Whether draft 0010 can be split** without rewriting it; its six parts were read, not tested apart.
- **Whether `knowledge_items` is still unused in every environment.** The assertion comes from `architecture-gaps.test.ts` and a
  search of `apps/api/src`; the test was not run.
- **The contents of `docs/analyzer-failure-classes.md`,** which may already contain a cause vocabulary that should replace the one
  proposed in B.3.
- **Counts in Part B.1** ("held", "partly") are judgements about fit, made from the schema. They are not measurements.
