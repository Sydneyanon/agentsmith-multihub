# C5 proposals: two changes to the evidence policy

**Status: TWO SEPARATE PROPOSALS for the owner's approval. Neither is approved. Neither is implemented.** Written 2026-11-28
against commit `97137c7`. Documentation only: no code, test, schema, secret, image or deployment was changed; nothing was
installed, downloaded or executed; no network call was made. The held-out corpora were not opened.

**Status words used:** *designed*, *implemented*, *tested*, *integrated*, *demonstrated*, *independently reviewed*,
*operationally verified*, *production deployed*. Both proposals are **designed** only.

**Evidence.** Current behaviour was re-checked in the source at `97137c7` and is cited as `file: symbol` with line numbers where
they help. Line numbers refer to that commit.

**The two proposals are independent decisions.** Each section below is self-contained and can be approved, declined or deferred
without the other. They interact in one place, which is called out in both: **a `contradicts` derived from worker-reported output**.

| | proposal | changes which existing rule | the plan's approval number |
|---|---|---|---|
| **P1** | The Foundry evaluator may record `contradicts` | `reproduction.ts` never emits it; a passing refutation test yields `weakens` | 9 |
| **P2** | The API may record a `foundry-forge` evaluation whose verdict the API derives from raw, worker-reported tool output | D1: the API refuses every worker-recorded evaluation | 10 |

"The plan" is `docs/architecture/c4-c5-tools-and-reproduction-plan.md`. "The oracle document" is
`docs/proposals/c5-oracle-and-independence.md`.

**The owner's rules both proposals are written under:**
1. a worker never submits a verdict that the API blindly trusts;
2. the API validates the raw output itself and derives the outcome under a registered evaluator and oracle;
3. all raw outputs and provenance are preserved;
4. no universal independence is claimed from a single oracle;
5. independence is about the underlying method, not component names;
6. a stand-in never counts as real reproduction.

---

## Summary

1. **P1, recommendation: approve in a narrow form, default off.** `contradicts` only when a preregistered oracle was applicable,
   every control passed, the attack was actually executed, and a registered **refutation witness** shows the contract's own check
   rejected the claimed mechanism. Oracle non-firing alone stays `weakens`. The evaluation states the narrow proposition it
   refutes. It never says the code is safe.
2. **The plan's wording of the `contradicts` condition is too wide.** As written (plan 3.4) it would mark `Bank.withdrawBad`
   (`vulnerable: true, exploitable: false` in the dev corpus) as contradicted. P1 here replaces that wording.
3. **P2, recommendation: approve in a narrow form, default off, for `foundry-forge` only.** The worker sends raw output and
   manifests and **no outcome field**. The API checks everything it can check, derives the verdict with a pure function, and
   labels the result as worker-reported execution. `record_evaluation` stays refused.
4. **P2 does not make the execution verifiable.** A compromised tools machine can fabricate raw output that passes every API
   check. The API can verify that the *report is consistent with what it asked for*. It cannot verify that the *execution
   happened*. Mitigations reduce this; none removes it.
5. **The one interaction: a forged `contradicts` hides a real lead.** `contradicts` dominates in `hypothesis_status` and in the
   investigation assessment. A forged `supports` wastes a human's time; a forged `contradicts` removes a lead from attention.
   Recommendation: under P2, a single worker-reported execution may yield at most `weakens` for a refutation. `contradicts`
   requires two separately created machines to agree, or a runner the owner operates.
6. **No migration is required to start either.** Three optional migrations are described (draft descriptions only). One of them
   should be decided before any production use of P2: an honest `recorded_by` value.
7. **Both changes can be switched off.** Evaluations already recorded cannot be deleted (0007 is append-only); they are superseded
   by a later evaluation from the same evaluator, which both status views treat as the current one.

---

# P1. Allow the Foundry evaluator to record `contradicts`

## P1.1 Current behaviour

| fact | where |
|---|---|
| The outcome mapping is stated in the module header: "intent `refute`, both runs pass identically → `weakens` (one test cannot prove impossibility, so never `contradicts`)" | `apps/api/src/engine/reproduction.ts`, lines 19–25 |
| The recording helper's type excludes `contradicts`: `outcome: "supports" \| "weakens" \| "inconclusive"` | `reproduction.ts: processFoundryValidateStep`, line 114 |
| The only non-`inconclusive` write is `t.intent === "refute" ? "weakens" : "supports"` | `reproduction.ts`, line 134 |
| A test that fails in both runs is `inconclusive`: "the claim may be false, or the test may be wrong; a failing test is not a refutation" | `reproduction.ts`, line 133 |
| **The intent is declared by the test author.** `intent: z.enum(["demonstrate", "refute"])` is part of the imported test. There is no oracle, no control and no registered meaning of "pass" | `reproduction.ts: testImportSchema` |
| The database allows the value: `outcome IN ('supports','weakens','contradicts','inconclusive')` | `db/migrations/0007_research_state.sql`, `hypothesis_evaluations` |
| **The bounded validators already emit `contradicts`.** A `counterexample` (a control shows the path is executable; the adversarial transaction reverts at an explicit check that negates the mechanism) maps to `contradicts`; "not observed" maps to `weakens` | `analysis/solidity/challenge.ts` (lines 97, 119, 139); `analysis/solidity/pipeline.ts: challengeOutcome` (line 185) |
| `contradicts` dominates the derived status: any evaluator's latest `contradicts` gives `contradicted_by_static_check`, unless a review exists | `0007`, view `hypothesis_status` |
| `contradicts` dominates the investigation: `has("contradicts") ? "contradicted" : …`, whatever the family | `analysis/solidity/lead-identity.ts`, the `assessment` expression |
| In draft 0009, a human `refuted` outcome may rest on **any** `contradicts` evaluation, of any family. Draft R3b tightens `confirmed` to cross-family and leaves `refuted` unchanged | `db/drafts/t144-research-memory/0009_research_memory.sql: hypothesis_outcome_rules`; `db/drafts/r3b-outcome-independence` |

**An asymmetry worth stating.** Today a parser-family validator, running a bounded model that shares the generator's parser, can
record `contradicts`. Foundry, which compiles with solc and executes real bytecode, cannot. The stronger method has the weaker
vocabulary. That is an argument for P1. It is not an argument for a wide P1: the validators earn `contradicts` through a control
and an explicit negating check, and Foundry should have to earn it the same way.

## P1.2 The exact proposed rule

> The API-side outcome derivation for a `foundry-forge` reproduction **may** produce `contradicts` when, and only when, **all** of
> the following hold. If any does not hold, the existing mapping applies unchanged (`weakens` or `inconclusive`).
>
> 1. **Registered oracle, applicable.** The test was produced from a registered oracle version whose applicability conditions
>    hold for the lead's (class, mechanism), and whose registration declares a refutation witness (not `none`).
> 2. **Real, pinned tools.** The forge and solc binaries' hashes equal the committed tool lock. A stand-in never qualifies.
> 3. **Controls passed.** Every control the registration makes mandatory ran to completion, and the oracle did not fire in any.
> 4. **The attack was executed.** The attack run reached the registered mechanism step (the nested call, the unprivileged call,
>    the second initialisation, the failing callee). A run that failed before that step is `inconclusive`.
> 5. **The refutation witness was observed.** The contract's own check rejected the mechanism step, as the registration defines
>    it; and the same step succeeds in the control that differs only in the registered respect (caller, order, or re-entry).
> 6. **The oracle did not fire** in the attack run.
> 7. **Deterministic.** Two identical runs of attack and controls agree on every observation.
> 8. **Author rules.** The test author's analysis family differs from the generator's family, the author read nothing from the
>    forbidden list (oracle document, 6.2), and the generated test passed the static cheatcode allow-list.
> 9. **Execution tier.** The execution was performed by a runner the owner operates, **or** by two separately created tools
>    machines whose reports agree. A single worker-reported execution yields at most `weakens` (see P1.7 and P2).
>
> The evaluation's rationale and stored output state **the narrow proposition refuted** (P1.6), the oracle id, version and hash,
> the witness observed, and the limitation codes. The evaluation cites the lead's primary evidence span, as 0007 requires for
> every outcome other than `inconclusive` (`evaluations_require_evidence`).
>
> The rule is behind a configuration switch that is **off by default**. With it off, behaviour is exactly today's.

**How this differs from the plan (3.4).** The plan's condition is: controls passed; the attack "executed to its end or was
rejected by the contract itself"; the oracle did not fire; the template is "registered as complete for this class". Two changes:

- **"Rejected by the contract itself" is replaced by the refutation witness.** `Bank.withdrawBad` rejects the attack by itself (a
  checked subtraction underflows after the nested withdrawal was *accepted*), the profit oracle does not fire, and the dev label is
  `vulnerable: true`. Under the plan's wording that is `contradicts`. Under this rule it is `weakens` with the reason
  `consequence_not_demonstrated`, because the mechanism step was accepted, not rejected. The oracle document, section 7, has the
  full table.
- **"Class-complete template" is dropped as a condition.** No template can be shown complete for a class; the word would promise
  more than can be verified. The witness is a property of one executed run and can be checked from raw output.

## P1.3 Technical design

No worker involvement is specific to P1: it changes only the pure function that maps observations to an outcome. (What the worker
sends and what the API verifies is P2.3; under the existing direct path the step itself runs the tool.)

| element | design |
|---|---|
| Where the rule lives | one pure function, proposed `deriveReproductionOutcome(observations, registration) → { outcome, reason, scope }`, with a version string that is part of `input_sha256`. No I/O |
| What it reads | per run (attack ×2, each control ×2): compile status; per test: status, revert reason and decoded revert-data kind, and the named observations the template emits (see below) |
| How observations reach it | the template emits each observation as a **separately named test** with a fixed name per oracle version (for example `test_attack_oracle_fired`, `test_attack_mechanism_step_reverted`, `test_attack_mechanism_revert_is_not_panic`, `test_control_honest_completed`, `test_control_oracle_not_fired`). Each is a pass/fail fact. The derivation is then a truth table over test names, which `parseForgeJson` already extracts. No log parsing |
| Refutation witness for reentrancy | the attacker contract performs the nested call with a low-level call, captures the success flag and return data, and exposes them through getters the test asserts on. "Not a Panic" is decided from the 4-byte selector of the revert data, in the EVM |
| Refutation witness for caller checks | a differential: the identical call from the privileged account succeeds (control) and from the unprivileged account reverts |
| Evidence stored | the full raw output of **every** run (attack and controls, both repetitions), stdout and stderr; the observations; the truth-table row selected; the rule version |
| Switch | `REPRODUCTION_CONTRADICTS` (name proposed), default `false`. Read once per step; its value is recorded in the step output |

**What cannot be verified.** Under the direct path (`processFoundryValidateStep`, which needs draft tables and direct database
access, gaps A8 and A9), the step that runs forge also records the evaluation, so the recorder trusts itself. Under option D, see
P2.3. Either way, the derivation cannot tell a correct template from a subtly wrong one: a template bug that makes the nested
call revert for an unrelated reason which is not a Panic would satisfy the witness. The control narrows this (the same call
succeeds without re-entry) and does not close it.

## P1.4 Security implications

| risk | assessment |
|---|---|
| **Suppression of a true lead.** `contradicts` dominates `hypothesis_status` and `Investigation.assessment`. Anyone who can cause a `contradicts` row to be written can take a lead out of attention | this is the main new risk. Today the only writers of `contradicts` are the API's own bounded validators. P1 adds a second source. Condition 9 keeps a single compromised tools machine from being that source |
| **A target that detects the test environment.** Contract code can read chain id, block number, or probe for the cheatcode address, and take a safe path under test | cannot be excluded in a local EVM. It makes a wrong `contradicts` possible on adversarially written code. Recorded as limitation `local_evm_only`; a reason the rationale never says "safe" |
| **Untrusted code execution** | unchanged by P1. It is a property of running forge at all (the plan, 3.7) |
| **A malicious or mistaken test author** | reduced compared with today: the author no longer declares the intent, and the oracle is fixed. With an attended author (`claude-reproducer`), P1 does **not** apply: there is no registered oracle, so condition 1 fails and the outcome stays `weakens` |

## P1.5 Evidence-integrity implications

- **Append-only is unaffected.** A `contradicts` row is one more immutable row with its event (0007).
- **A human outcome can rest on it.** In draft 0009, `refuted` requires "a `contradicts` evaluation or a human `rejects` review".
  After P1, a Foundry `contradicts` can ground a human `refuted`. That is the intended use, and it is why the row must carry its
  scope. **`refuted` still requires a human** (`decided_by_kind = 'human'`); P1 creates no label.
- **A weakness that exists today and P1 makes more relevant:** the 0009 draft accepts a `contradicts` of *any* family as the basis
  of `refuted`, including the parser-family validators. R3b does not change that. See P1.9.
- **Latest wins.** `hypothesis_status` uses each evaluator's latest evaluation. A later `supports` by `foundry-forge` under a
  different oracle replaces an earlier `contradicts` by `foundry-forge`, and the reverse. The stored rows keep both; the derived
  status shows one. The API and dossier must show the evaluator's whole history for a lead, not only the view's row.
- **Mislabel in the view.** The status text is `contradicted_by_static_check` for any evaluator. A Foundry result is not a static
  check. The view cannot change without a migration; the presentation layer must show the evaluator family beside it.

## P1.6 Independence analysis, and what a `contradicts` proves

**Independence.** The same as for a Foundry `supports` (oracle document, section 6): the verdict rests on solc and the EVM; the
anchor, the class and the reach are shared with the generator. One addition specific to refutation: the **direction of shared
error**. If the parser-derived model misidentifies the privileged account, the "unprivileged" attacker may in fact be privileged,
the call succeeds, and the result errs toward `supports` under O-STATE. If it misidentifies the *control's* privileged account,
the control fails and the result is `inconclusive`. A shared parser error does not obviously produce a false `contradicts` under
the differential witnesses; a wrong anchor does (the test refutes something about a function the claim was not about). The
evaluation therefore names the function it tested.

**Why one failing test must not prove impossibility.** A test tries one sequence, with one set of actors, amounts and arguments,
on one compiler configuration, in a local EVM with no other contracts and no deployed state. The claim "this function is
vulnerable" is existential: *some* sequence causes harm. One sequence that causes no harm leaves every other sequence untried.
The reasons a real issue may not reproduce are many and ordinary: a different entry point, a second function, a larger amount, a
token instead of ether, a state the harness did not set up, a compiler setting. This is why `reproduction.ts` records a failing
test as `inconclusive` and a passing refutation as `weakens`, and why that default stays.

**The narrower claim a qualified `contradicts` does prove.** It is a statement about one mechanism step in one executed
configuration:

> "On the sealed source at commit *C*, compiled with solc *V* and settings *S*, in a local EVM: the *registered mechanism step*
> for class *K* (for example, a nested call into `F` from the receiver of `F`'s external call), performed by the registered
> attacker with the registered funding and arguments, **was rejected by a check in the contract**, while the same step succeeded
> in the control that differs only in *D*. The oracle *O* version *n* did not fire."

It refutes the claim **only to the extent the claim asserts that mechanism step is accepted**. For the structural specialists'
claims that is a direct negation: "no caller-authorisation check dominates that statement" is negated by a caller differential;
"any account can call it (again)" is negated by a rejected second call; "a re-entering receiver would see stale state" is negated
when the nested call is rejected on up-to-date state. It does **not** show:

- that the function is safe;
- that no other path, function, amount, actor or token reaches the effect;
- anything about the deployed contract;
- anything about a different class of issue at the same location.

**Proposed fixed wording on every such evaluation:** "CONTRADICTS the claimed mechanism in one executed configuration (details
above). This is not a proof that the function is safe, and it is not a statement about any deployment. A `refuted` outcome needs
a human decision."

## P1.7 Conditions under which `contradicts` is justified, and when it is not

| situation | outcome | why |
|---|---|---|
| all nine conditions of P1.2 hold | `contradicts` | the mechanism step was rejected by the contract, shown against a control |
| oracle did not fire; the mechanism step was **accepted** | `weakens`, reason `consequence_not_demonstrated` | the pattern is present; the registered consequence is absent. **The dev-corpus `vulnerable: true, exploitable: false` case.** Not a contradiction and not a failure |
| oracle did not fire; witness observed; but single worker-reported execution | `weakens`, reason `mechanism_rejected_by_contract` and note "pending re-execution" | condition 9. Upgraded by a new evaluation when a second machine agrees |
| the oracle has no registered witness (O-LOCK, O-INV in general) | `weakens` at most | non-firing of a consequence oracle says nothing about the mechanism |
| the attack run failed before the mechanism step | `inconclusive`, `attack_not_executed` | nothing was tested |
| a control failed, or the oracle fired in a control | `inconclusive` | the harness is not trustworthy for this target |
| the lead's mechanism has no registered oracle | `inconclusive`, `unsupported_class` | — |
| the test came from an attended author, not from a registered oracle | today's mapping (`weakens` for a passing refutation) | condition 1 |
| a stand-in binary | never recorded as a `foundry-forge` evaluation outside test databases | condition 2 |

**Coverage of the claimed mechanism** is what condition 4 and 5 are for. A registration states which mechanism step it exercises.
A lead whose mechanism is a variant the registration does not exercise (cross-function re-entry, a two-step delegatecall target)
is not applicable under condition 1 and is `unsupported_by_model`, not refuted.

## P1.8 Tests required

All can be written with stand-ins and pure functions before any real tool runs. **None of them demonstrates reproduction.**

1. The truth table: every combination of observations maps to exactly one outcome; an unknown combination is `inconclusive`.
2. Oracle non-firing with the mechanism step accepted → `weakens` / `consequence_not_demonstrated`, never `contradicts`.
3. Witness present but a control failed → `inconclusive`.
4. Witness present but the revert data is a Panic → `weakens`.
5. Runs disagree → `inconclusive` / `non_deterministic`.
6. Switch off → no `contradicts` for any input (regression of today's mapping, byte for byte in the rationale).
7. No registered oracle (attended author) → `weakens`, as today.
8. Tool hash not in the lock → no evaluation other than `inconclusive` / `tool_checksum_mismatch`.
9. Condition 9: one worker-reported execution → `weakens`; two agreeing reports → `contradicts`; two disagreeing → `inconclusive`.
10. The evaluation cites a span (0007 `evaluations_require_evidence`); the 0016 self-evaluation trigger still refuses
    `foundry-forge` as its own generator.
11. A later `supports` after a `contradicts`: both rows exist; the dossier shows both.
12. **On real Foundry, after the tools environment is approved (not before):** the section 11 table of the oracle document, in
    particular `Bank.withdrawBad` → `weakens` and `Bank.withdrawCei` → `contradicts`.

## P1.9 Schema impact (draft descriptions only; nothing written or applied)

- **Required: none.** `contradicts` is already an allowed outcome.
- **Optional draft A, a change to the unapplied R3b draft:** in `hypothesis_outcome_rules`, require that a `refuted` outcome
  based on an evaluation cites a `contradicts` whose `relation` is `cross_family` in `evaluation_independence`, or else a human
  `rejects` review. Today's draft accepts any family. This is a change to a draft, so it needs approval as part of the 0009/R3b
  decision, not a new production migration by itself.
- **Optional draft B:** a `hypothesis_status` replacement (or a second view) whose labels do not say "static check" for
  execution-family evaluators. A view change on an applied migration is a new migration.

## P1.10 Rollback

1. Set the switch to off. From that moment no new `contradicts` is derived.
2. Existing `contradicts` rows cannot be deleted or edited (0007). To neutralise one, record a **superseding evaluation** by
   `foundry-forge` for the same hypothesis with outcome `weakens` or `inconclusive` and a rationale that names the superseded
   evaluation and the reason. Both status views use the evaluator's latest evaluation. The superseding row needs a different
   `input_sha256` (0015 idempotency key); the rule version in the hashed input provides it.
3. Any human `refuted` outcome that cited a superseded evaluation must be re-examined by a human and, if needed, superseded in
   `hypothesis_outcomes` (which has `supersedes_id`; draft 0009).
4. The code change is confined to the derivation function and can be reverted.

## P1.11 Alternatives

| alternative | effect | assessment |
|---|---|---|
| **Do not change** | the fixed twin is `weakens`. The plan's acceptance criterion 2 is reworded | safe and simple. Cost: the strongest method cannot record the strongest negative, and a human who wants to record `refuted` must do it on a `rejects` review alone |
| **The plan's rule as written** | `contradicts` whenever the attack was rejected and the oracle did not fire, for a "class-complete" template | **not recommended.** It contradicts true pattern claims (`withdrawBad`) |
| **The narrow rule here** | `contradicts` only with a refutation witness and a trusted or repeated execution | recommended |
| **A new outcome value** (for example `mechanism_rejected`) | precise, and does not dominate status | needs a migration to the `outcome` check, changes to both views, and a new vocabulary everywhere. Not justified yet |
| **Record the witness in the stored output only, keep `weakens`** | the information is preserved; no status effect | a reasonable fallback if P1 is declined. It is what "do not change" plus the oracle document's OD-2 gives |

## P1.12 Recommendation

**Approve the narrow rule, off by default, for implementation and stand-in testing only.** Do not enable it anywhere until: the
oracle registrations for the first classes exist and are reviewed (oracle document, OD-1, OD-12); real Foundry has reproduced the
section 11 table; and the owner has seen the `withdrawBad` and `withdrawCei` results side by side. If the owner prefers the
simplest course, "do not change" together with OD-2 loses little: the witness is still recorded, and a human can still refute.

## P1.13 Approval text

The owner would write, to approve as recommended:

> **Approved (P1, narrow):** the Foundry evaluator may be implemented so that it can derive `contradicts` under the nine
> conditions of P1.2 of `docs/proposals/c5-evidence-policy-changes.md`, including the refutation witness and the execution-tier
> condition. Oracle non-firing alone remains `weakens`. The switch is off by default. This approval covers code and tests in a
> development branch only. Enabling the switch in any environment, and any production run, need separate approval. No migration
> is approved.

To decline:

> **Declined (P1):** Foundry does not record `contradicts`. A passing refutation remains `weakens`. The refutation witness is
> recorded in the evaluation's stored output only. Acceptance criterion 2 of the C4/C5 plan is reworded to expect `weakens`.

---

# P2. Allow the API to record a `foundry-forge` evaluation derived from worker-reported output

## P2.1 Current behaviour

| fact | where |
|---|---|
| **D1:** "nothing about verdicts. The worker records no evaluation at all (`record_evaluation` is always refused)" | `apps/api/src/worker-api.ts`, module header |
| The operation exists only to refuse: `throw new Refusal(403, "evaluations_are_api_derived", "a worker may not record evaluations: the API runs the validators itself and records only its own verdicts")`. Its schema accepts an `outcome`; the body is never used | `worker-api.ts: OPERATIONS.record_evaluation` |
| On `complete` of `challenge_leads`, the API runs the bounded validators itself in a bounded child and records the evaluations with `recordedBy: "api"` | `worker-api.ts: OPERATIONS.complete` (the `prepare` and `run` branches for the challenge step); `pipeline.ts: recordChallenge` |
| **D3:** every `complete` body must pass a strict per-step schema; the stored output is built by the API (`derived_by: "api"`) | `worker-api.ts: COMPLETE_SCHEMAS`, `OPERATIONS.complete` |
| **The stated exception to D3:** the Slither stage runs a tool on the worker; its leads are "WORKER-REPORTED observations", stored with `reported_by: "worker"`. They are **claims** (`create_hypothesis`), never evaluations | `worker-api.ts` header; `slitherOutput` |
| There is no reproduction step under option D: `RESEARCH_STEP_KEYS` has no Foundry key | `worker-api.ts: RESEARCH_STEP_KEYS` |
| The existing Foundry step needs direct database access (`ctx.pool`) and the draft table `research_effort` | `reproduction.ts: processFoundryValidateStep` (lines 101–138) |
| The API cannot run forge. The process host is excluded from the production build | `tsconfig.build.json` (`**/tool-host/**`); `engine/tools/run-tool.ts: loadToolHost` |
| `evaluation_provenance.recorded_by` allows `api`, `direct-worker`, `trusted-runner`. `output_blob_sha256` is `NOT NULL` | `db/migrations/0015_worker_api.sql` |
| The dossier already renders an evaluation with no provenance row as `worker_reported` | `pipeline.ts`, the `recordedBy` mapping |
| Why D1 exists: scenario S7a, "forge the validator's verdict" | `docs/security/worker-architecture-decision.md` |

**The situation in one sentence.** D1 works because the bounded validators are pure code the API can run. Forge is a process that
executes untrusted code, which the API must never run. So a real execution result can only arrive from another machine, and D1 as
written refuses it.

## P2.2 The exact proposed rule

> D1 stays in force, with one narrow, named exception.
>
> **`record_evaluation` remains refused, always.** No worker submits an outcome, for any evaluator.
>
> **Exception.** For the evaluator `foundry-forge` only, and only on a reproduction step created by the API, the API may accept a
> **reproduction report** from the tools machine through one new, strictly typed operation. The report contains raw tool output
> and manifests. It contains **no outcome, verdict, pass/fail summary or rationale**; a report containing any such field is
> refused by the schema and audited.
>
> The API then, itself:
> 1. verifies every field it is able to verify (P2.3, table 2);
> 2. stores every raw output as received, before deriving anything;
> 3. derives the outcome with a deterministic, versioned function from the raw output and the registered oracle;
> 4. records the evaluation as `foundry-forge`, with provenance stating **worker-reported execution, API-derived verdict**, and the
>    execution tier.
>
> A verification failure yields an `inconclusive` evaluation with a code, or a refusal, never a `supports`, `weakens` or
> `contradicts`.
>
> The exception does not extend to any other evaluator, to Slither, or to any future tool without a separate approval.
>
> The operation is behind a configuration switch that is **off by default**. With it off, the operation answers 403 exactly as
> `record_evaluation` does today.

## P2.3 Technical design

### Flow

1. **Authoring (API).** The API's template author writes the tests from the registered oracle, generates the config, selects
   solc, and computes the **expected input digest** over: the snapshot manifest, the dependency manifest digest, the shared-model
   hash, each test file's hash, the config hash, the oracle hash, the tool-lock hash and the derivation-rule version. It stores
   the tests as blobs and writes all of this into the reproduction step's `input` when it creates the step.
2. **Nonce (API).** The API generates a per-run random value for the execution canary and stores only what it needs to check the
   answer.
3. **Fetch (tools machine).** The broker leases the step and fetches sources, dependency sources, tests, config and the expected
   digest through existing read operations.
4. **Execute (tools machine).** It materialises, checks each file against its hash, re-hashes the binaries, runs the attack and
   each control twice, and re-hashes the source tree afterwards.
5. **Report (tools machine → API).** One strictly typed report (below).
6. **Verify, store, derive, record (API).** As in the rule.

### Table 1. What the worker sends

| field | content |
|---|---|
| `step_id`, idempotency key | as every state-changing worker call (0015 `worker_api_requests`) |
| `input_digest_echo` | the digest the machine computed over what it materialised |
| `tool_manifest` | `agentsmith-tool-manifest/1` (the plan, 2.5): image digest; per binary name, reported version and SHA-256; the solc selected; compiler settings; the config hash; the exact argument list; the limits in force; the helper hash |
| `executions[]` | one entry per process run (attack ×2, each control ×2, canary): **raw stdout bytes, raw stderr bytes**, exit code, signal, timed-out flag, wall time, and the SHA-256 of each stream. Large streams as blobs uploaded through the existing `put_blob`, cited by hash |
| `truncations[]` | for any stream over the size limit: the stored prefix length and the SHA-256 of the **full** stream |
| `artifacts[]` | per contract under test: the hash of the compiled runtime bytecode |
| `source_tree_digest_after` | the digest of the source tree after the runs |
| `canary` | the value the canary test computed in the EVM from the nonce |
| `failures[]` | explicit operational codes the broker observed (`tool_checksum_mismatch`, `timeout`, `memory_limit`, …) |

**Not in the schema, and refused if present:** `outcome`, `verdict`, `passed`, `results`, `rationale`, `supports`, any summary of
test status. The schema is `.strict()`, as every existing worker schema is.

### Table 2. What the API verifies itself

| check | against | on failure |
|---|---|---|
| token, run, lease, step key, idempotency | 0015 records, existing middleware | refused, audited |
| schema and sizes; storage and processing quotas (D4) | `worker-quotas.ts` | refused, audited |
| `input_digest_echo` equals the expected input digest | the step's `input`, written by the API at step creation | `inconclusive`, `input_mismatch` |
| the snapshot is sealed and API-verified against GitHub; the dependency manifest digest is the one the API derived | `repo_snapshots`, `snapshot_verifications` (D2), the dependency step output (`derived_by: "api"`) | refused |
| every binary hash in the tool manifest equals the committed tool lock; the tool-lock hash equals the one in the expected digest | the tool lock compiled into the API | `inconclusive`, `tool_checksum_mismatch` |
| the solc version equals the API's own selection; the config hash equals the config the API generated; the argument list equals the fixed list | the step's `input` | `inconclusive`, `manifest_mismatch` |
| each raw stream's SHA-256 equals the hash of the bytes received | recomputed | refused |
| the raw output parses; the suites and tests it names are **exactly** the tests the API authored: none missing, none extra | `parseForgeJson`; the step's `input` | `inconclusive`, `output_invalid` or `foreign_test` |
| exit codes are consistent with the parsed results | the parsed output | `inconclusive`, `output_inconsistent` |
| the two repetitions of each run agree | recomputed | `inconclusive`, `non_deterministic` |
| `source_tree_digest_after` equals the input | the expected digest | `inconclusive`, `sources_modified` |
| the canary value equals the value the API computes from its nonce | the stored nonce | `inconclusive`, `canary_failed` |
| the oracle hash in the expected digest is a registered, non-withdrawn version | the oracle registry | refused |

### How the API derives the outcome

A pure function, no I/O, with a version in the hashed input: parse each raw stdout with `parseForgeJson`; map the fixed test
names to observations; apply the registered oracle's truth table (P1.3; without P1 the table simply has no `contradicts` row).
The same bytes always give the same outcome. The function, its version and the selected row are stored with the evaluation, so
anyone can re-derive the outcome from the stored raw output without the tools machine.

### Table 3. What remains worker-trusted and cannot be verified by the API

| the API must take on trust | why it cannot check |
|---|---|
| that any execution happened at all | the API sees bytes, not a process |
| that the binaries with the reported hashes are the ones that ran | the machine reports its own hashes |
| that the raw output is the output of that execution on those inputs | a machine can write any bytes |
| that the workspace was isolated as designed (no network, no token visible) | the API cannot observe the machine |
| the artifact digests, the image digest, the limits in force, the timings | self-reported |
| `input_digest_echo` | **the API gave the machine everything needed to compute it. A matching echo detects an honest mistake. It is not evidence of execution** |
| the canary | the value is computable without forge by anyone who has the nonce and the test source |

**Stated plainly: a compromised tools machine can fabricate a complete report that passes every check in table 2.** It must
produce consistent fake JSON for tests the API authored, with correct hashes and the canary value. That is a modest amount of
work for an attacker who controls the broker.

### Mitigations

| mitigation | what it adds | what it does not add |
|---|---|---|
| **The verdict is derived by the API** | a worker cannot assert an outcome directly, cannot choose which claim to evaluate, and cannot evaluate with a test of its own. A forgery must be a consistent fake of every run | protection against a careful forger |
| **Strict report schema with no outcome field** | a naive or legacy forged verdict is refused and audited | — |
| **Execution canary** (per-run nonce computed in the EVM) | detects a stand-in, a replayed report from another run, and a broken install | detection of a deliberate forger |
| **Re-execution on a second, separately created machine** with its own token; both reports must agree on every observation and on the raw-output digests after path normalisation | an attacker must compromise two machines, or the image both share | protection if the image or the tool lock is compromised; protection against a target that deterministically escapes the sandbox |
| **Attestation** | a signed statement by the platform of which image ran would bind the report to the image | **not available in this design.** No attestation facility was verified for Fly machines, and none is assumed. Listed so that its absence is explicit |
| **A runner the owner operates** (`trusted-runner`, already an allowed `recorded_by` value) | removes the remote-worker trust question for runs the owner performs locally in the tools container | scale; and it is still the owner's machine, not the API |
| **Labelling as `worker_reported`** | no reader mistakes the result for an API-verified one | integrity |
| **Evidence tier** (below) | rules can require a minimum tier before a result is used | — |
| **Human outcome required** for any label (draft 0009) | a forged result alone never becomes `confirmed` or `refuted` | — |
| **Blast radius:** the token is run-scoped (0015); the machine holds nothing else and is destroyed | a compromise affects one run's evaluations | — |

### Evidence tier (proposed vocabulary, recorded on every reproduction evaluation)

| tier | meaning | may yield |
|---|---|---|
| `stand_in` | a binary whose hash is not in the tool lock | nothing outside test databases. **Never a reproduction** |
| `worker_reported_single` | one tools machine; API-derived verdict | `supports`, `weakens`, `inconclusive`. **Not `contradicts`** |
| `worker_reported_repeated` | two separately created machines agree | all four outcomes |
| `owner_operated` | executed by a runner the owner operates, in the tools container | all four outcomes |
| *(reserved)* `attested` | bound to an image by platform attestation | not available |

The tier is a fact about how the execution was obtained. It is not a confidence score and must not be turned into one.

## P2.4 Security implications

| risk | before P2 | after P2 | mitigation |
|---|---|---|---|
| **S7a: a worker forges a verdict** | closed for evaluations (D1) | **partly re-opened** for `foundry-forge`: a compromised tools machine can forge raw output from which the API derives a verdict | table of mitigations; the tier; the narrow scope (one evaluator, one step kind) |
| **The untrusted target influences its own evaluation.** The repository under test is compiled and executed on the tools machine. A sandbox escape there reaches the broker and its token, and the escapee can then forge the report *about the repository it came from* | not possible: no project code is executed anywhere | possible in principle | the two-user, no-network design (the plan, 2.1); re-execution; **no `contradicts` from a single execution**, so a hostile repository cannot bury its own leads through one machine |
| **Forged `supports`** | — | costs human time; cannot become `confirmed` without a human and a second look | tier; human outcome |
| **Forged `contradicts`** | — | would hide a lead from the dashboard and from selection | excluded at tier `worker_reported_single` (P1 condition 9) |
| **Larger API attack surface:** a new operation that parses attacker-influenced bytes | — | forge's JSON includes strings chosen by the code under test (revert reasons, labels) | strict JSON parsing; verdict only from fields of API-authored test names; bytes stored as bytes and rendered escaped; body limits and quotas |
| **Resource abuse** through large reports | — | bounded | D4 quotas, per-stream size limits, truncation with a full-stream digest |
| **Replay** of an old report | — | bounded | idempotency key, the step-bound input digest, the per-run nonce |
| **Scope creep:** "the exception exists, add Slither, Echidna, …" | — | a real risk of process, not of code | the rule names one evaluator; each further tool is a separate approval |

**What P2 does not weaken.** `record_evaluation` stays refused. The bounded validators stay API-run. Snapshot verification (D2),
API-derived analysis (D3), quotas (D4) and idempotency (D7) are untouched. The 0016 self-evaluation trigger still applies to the
row the API writes.

## P2.5 Evidence-integrity implications

- **All raw output is preserved, which is not the case today.** The current step stores only the first run's stdout, only when it
  is at most 1 MiB, and never stderr or exit codes (`reproduction.ts`, line 129; the `tool` object). P2's report stores every
  stream of every run. A stream over the blob limit is stored as a prefix with the full stream's digest and an explicit
  `truncated` marker; the verdict is derived only if the parsed portion is complete, else `inconclusive`, `output_too_large`.
- **Raw output is stored before the verdict is derived,** in the same transaction as the evaluation, so there is never an
  evaluation without its inputs.
- **The verdict is re-derivable.** Anyone holding the stored bytes, the oracle registration and the rule version can recompute
  the outcome. This is the property the owner's rule 2 asks for.
- **The 0016 view counts the row as `cross_family`, whatever the tier.** `evaluation_independence` knows the evaluator's family
  and nothing about how the execution was obtained. A `worker_reported_single` `supports` makes
  `hypothesis_independence.independently_supported` true. The tier therefore has to be enforced where rows are *used*: the API,
  the dossier, and the human-outcome rule (P2.9, draft C).
- **Provenance row.** `evaluation_provenance.recorded_by` has no honest value for this case (`api` would hide the worker;
  `direct-worker` and `trusted-runner` are other things). Two options: write no provenance row, so the dossier shows
  `worker_reported` (works today; the raw output is then linked only through the step output and the report blob), or add a value
  by migration (P2.9, draft A). `output_blob_sha256` is `NOT NULL`, so a provenance row always needs a stored blob: the report
  document itself, which cites the stream blobs, fits.
- **A stand-in can never enter.** The fake tools' hashes are not in the lock; the API derives `inconclusive`,
  `tool_checksum_mismatch`.

## P2.6 Independence analysis

P2 does not change *what* is independent; it changes *who vouches for it*.

- **Method independence** is as in the oracle document, section 6: solc and the EVM do not share the parser's errors; the anchor,
  class and reach are shared.
- **A new dependence: the executor.** Under D1 the party recording an evaluation and the party computing it are the same (the
  API). Under P2 the computation is on a machine that also executes the code under test. The *evaluated party's code* runs beside
  the *evidence producer*. That is a dependence between subject and evaluator which did not exist before, and it is the reason for
  the two-user design and for re-execution.
- **Re-execution is not a second method.** Two machines from the same image with the same binaries share every tool error. Their
  agreement shows the report was probably not forged on one machine. It adds nothing about whether forge, solc or the template is
  right. It must never be counted as a second independent confirmation.
- **Names are not independence.** Calling the machine "tools", the broker "broker" and the evaluator `foundry-forge` creates no
  independence. The claim that can be made is the method claim, with the executor caveat attached.

## P2.7 Conditions under which `contradicts` is justified under P2

Only if P1 is also approved. Then, in addition to P1.2:

- the tier is `worker_reported_repeated` or `owner_operated`;
- both reports passed every check of table 2;
- the two reports agree on every observation, including the refutation witness, and on the normalised raw-output digests.

With one machine, the refutation is recorded as `weakens` with reason `mechanism_rejected_by_contract` and the note "pending
re-execution". When the second report arrives and agrees, the API records a **new** evaluation (`contradicts`) whose input digest
includes both report hashes. The earlier row stays.

Why one failing test does not prove impossibility, and what a qualified `contradicts` does prove, is P1.6; it applies unchanged.

## P2.8 Tests required

Stand-ins and pure functions suffice for all but the last. **None demonstrates reproduction.**

1. A report containing `outcome`, `verdict`, `results` or any unknown field is refused (422) and audited; nothing is stored.
2. `record_evaluation` is still refused with `evaluations_are_api_derived` (the existing adversarial test, unchanged).
3. Wrong `input_digest_echo` → `inconclusive` / `input_mismatch`.
4. A binary hash not in the lock, including the fake tools' hashes → `inconclusive` / `tool_checksum_mismatch`; never `supports`.
5. Raw output naming a test the API did not author → `foreign_test`; missing an authored test → `output_invalid`.
6. Stream hash mismatch → refused.
7. Exit code inconsistent with parsed results → `output_inconsistent`.
8. Wrong or missing canary → `canary_failed`.
9. A report for a step of another run, an unleased step, a completed step; a replay with the same idempotency key returns the
   stored answer and writes nothing new.
10. Oversized stream → truncation recorded; verdict `inconclusive` / `output_too_large` if the parsed part is incomplete.
11. Quotas: a report over the token's storage quota is refused.
12. The derivation function: same bytes, same outcome; property test over shuffled key order in the JSON.
13. The evaluation is written by the API as `foundry-forge`; the 0016 trigger refuses it when the hypothesis's generator id is
    `foundry-forge`; `evaluation_independence` reports `cross_family` for a parser-family lead.
14. Switch off → the operation answers 403; no behaviour change anywhere else (the existing remote-worker and adversarial suites
    pass unchanged).
15. Two reports: agreeing → tier `worker_reported_repeated`; disagreeing → `inconclusive` / `reports_disagree`, both stored.
16. Hostile strings in forge output (HTML, control characters, very long revert reasons) are stored as bytes and rendered escaped.
17. **After the tools environment is approved, on real Foundry:** an end-to-end run through the operation in the local
    container, and one deliberate tamper of each field of the report, each detected or, for the fields in table 3, **documented as
    undetected**. The undetected list is part of the test's expected output.

## P2.9 Schema impact (draft descriptions only; nothing written or applied)

- **Required to start: none.** The report is a blob; the step is an ordinary `workflow_steps` row (subject to gap A11: one step
  per key per run, so a second reproduction round needs an ordinal step key, which is code).
- **Draft A (recommended before any production use):** widen `evaluation_provenance.recorded_by` to include a value for
  worker-reported execution with an API-derived verdict (working value `api-derived-from-worker-report`). Expand-only: the check
  constraint on an applied table is replaced by a wider one in a **new** migration. Optionally add nullable `execution_tier` and
  `report_blob_sha256` columns to the same table.
- **Draft B (optional):** a nullable `oracle_sha256` and the `oracle_registrations` table (oracle document, 4.2).
- **Draft C (a change to the unapplied R3b draft):** `confirmed` requires a cross-family `supports` whose execution tier is
  `worker_reported_repeated` or `owner_operated`. It depends on Draft A's column. Until it exists, the same rule is a process rule
  applied by the human who records the outcome.

Each draft, if wanted, is a separate approval. Applied migrations are never edited (`scripts/migrate.ts` refuses a changed
checksum).

## P2.10 Rollback

1. Set the switch to off: the operation refuses as before P2.
2. Revoke the run tokens (0015 supports revocation) and destroy the tools machines.
3. Evaluations already recorded stay (append-only). They remain labelled with their tier. If a machine or image is suspected:
   list the affected evaluations by token through `audit_events` and `worker_api_requests`, and for each record a superseding
   `inconclusive` evaluation by `foundry-forge` with code `execution_untrusted`, naming the superseded row.
4. Any human outcome that cited an affected evaluation is re-examined by a human.
5. The code change is one operation, one schema and one derivation function; it can be reverted without touching D1–D7.
6. If Draft A was applied, its rollback restores the narrower check only if no row uses the new value; otherwise the value stays
   and is simply no longer written.

## P2.11 Alternatives

| alternative | effect | assessment |
|---|---|---|
| **Do not change** | no Foundry result can enter production records under option D. Reproduction exists only on the direct path, which needs draft tables and a database credential on the machine that runs untrusted code | safest for D1. It means C5 cannot be operated in production in the approved worker architecture |
| **Run forge in the API** | the API would verify its own execution | **refuse.** It puts untrusted code execution beside `DATABASE_URL` and the operator secrets; the build exclusion of `tool-host/` exists to prevent exactly this |
| **Give the tools machine a database credential** (the direct path) | no new operation | **refuse.** Strictly worse than P2: the machine could write any evaluation, with no API-side check |
| **Store the report but record no evaluation** (an observation, like Slither's leads) | D1 untouched; the result is visible in the step output and dossier; nothing counts in the independence views | a legitimate, more conservative first stage. Cost: reproductions cannot ground a human `confirmed` (0009 needs a `supports` evaluation), so no labels accrue |
| **P2 as proposed** | evaluations with an API-derived verdict and an explicit tier | recommended |
| **P2 with mandatory re-execution for every result** | every evaluation is tier `worker_reported_repeated` | stronger; doubles compute and operator effort. Reasonable if the owner prefers it; see the approval text |

## P2.12 Recommendation

**Approve the narrow exception, off by default, for implementation and adversarial stand-in testing only.** In order:

1. implement the operation, the strict schema and the derivation function; run tests 1–16;
2. before any production use, decide Draft A (an honest `recorded_by`);
3. the first real results come from the **owner-operated local container** (tier `owner_operated`), which does not depend on
   the remote-worker trust question at all;
4. the first production tools machine runs with re-execution **required** for any result a human is about to rely on, and
   `contradicts` never from a single machine.

If the owner wants a smaller first step, the "store the report, record no evaluation" alternative is sound and loses only the
ability to accumulate labels.

## P2.13 Approval text

To approve as recommended:

> **Approved (P2, narrow):** a single exception to D1 may be implemented as described in P2.2 of
> `docs/proposals/c5-evidence-policy-changes.md`: for the evaluator `foundry-forge` only, the API may record an evaluation whose
> outcome the API itself derives from a strictly typed reproduction report containing raw tool output and no outcome field.
> `record_evaluation` remains refused. Every such evaluation is labelled as worker-reported execution with its evidence tier. A
> result at tier `worker_reported_single` may not be `contradicts`, and may not be the basis of a human `confirmed` outcome. The
> switch is off by default. This approval covers code and tests in a development branch only. Enabling the switch, any tools
> machine, any migration and any production run need separate approval.

To approve the stricter variant, add:

> Re-execution on a second, separately created machine is required for **every** evaluation recorded under this exception.

To decline:

> **Declined (P2):** D1 is unchanged. No evaluation is recorded from worker-reported output. A reproduction report may be stored
> as a worker-reported observation in the step output and shown in the dossier; it is not an evaluation and counts nowhere.

---

## Uncertainties common to both proposals

- **No real Foundry has run in this environment.** The JSON shape, exit codes, the way revert data from a nested call is exposed,
  and the determinism of output across machines are assumed from a stand-in (`engine/tools/testing/fake-tools.ts`). Normalised
  raw-output digests may not match across two machines for reasons unrelated to forgery (timings, ordering, absolute paths inside
  the output); if so, agreement must be defined over observations, not over bytes.
- **Fly specifics** (whether platform attestation exists, how machines are isolated from one another) were not verified. No
  mitigation above assumes them.
- **How often the refutation witness is observable on real code** is unknown. Custom errors, assembly reverts and proxies may make
  "reverted at the contract's own check, not a Panic" harder to decide than on the fixtures.
- **Whether "latest evaluation wins"** in the two status views causes confusing displays once a lead has several Foundry
  evaluations was reasoned from the SQL, not observed.
- **Production facts** (which migrations are applied, whether the worker listener is enabled) are taken from the repository's
  documents, not checked against production.
