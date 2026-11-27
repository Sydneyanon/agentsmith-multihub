# Vulnerability-detection benchmark (Priority B)

Status: **baseline established; expansion designed.** 2026-11-27.

This is the benchmark that answers the only question that matters for the engine: *can AgentSmith actually
find vulnerabilities?* It builds on the existing evaluation machinery (`eval/run-eval.ts`, the frozen corpora,
`docs/evaluation-protocol.md`, the `agentsmith-exposure/1` protocol and the `eval/heldout5` real-repo design) —
it does not replace it. Nothing here changes detection behaviour; the mission requires a baseline *before* any
such change.

## 1. Measured baseline (what the engine does today)

The deterministic structural analyzer (`analyzeSources`, capability `solidity-structural-specialists@1`) scored
against its designated **blind** frozen corpus `eval/heldout` (frozen before the analyzer was written). Raw output:
`eval/results/benchmark-b-baseline-heldout.txt`.

| corpus | exposure | labels | tp | fp | fn | precision | recall | key-line exact |
|--------|----------|-------:|---:|---:|---:|----------:|-------:|---------------:|
| heldout | **blind** | 47 | 18 | 0 | 0 | **1.000** | **1.000** | 17/18 |
| dev | tuned (reference, not a measurement) | 31 | 17 | 0 | 0 | 1.000 | 1.000 | 17/17 |

Per class on blind `heldout`, precision and recall are both 1.000 for all seven classes it covers:
`reentrancy, access-control, initializer, delegatecall, unchecked-call, tx-origin, selfdestruct`.

**Two honest conclusions:**

1. **The simple-pattern benchmark is saturated.** On blind data the deterministic analyzer is already at ceiling
   (perfect P/R) for the seven syntactic classes. Re-running it will not move; tuning against it would be
   overfitting. More of the same contracts measures nothing new.
2. **Pattern detection is not exploitability.** The independent EVM execution layer (`validateReentrancy`, a real
   `@ethereumjs/evm` run, not the detector) re-checked the four reentrancy leads: **2 validated** (a re-entrant
   attacker provably extracts more than the best honest sequence) and **2 refuted** (the re-entrant transaction
   reverts — pattern present, no bounded exploit). A detector that flags all four as "vulnerable" is right by the
   label and wrong about the world for two of them. This gap — *flagged vs. actually exploitable* — is the real
   measurement target, and it is where APEX/Weirdness (today **unimplemented**, roadmap only) would have to earn
   their place.

## 2. What the benchmark must measure next

The seven covered classes are the easy, syntactic ones. The twelve classes Priority B names are mostly **beyond
what any current capability can detect** — the engine has no accounting/oracle/economic/invariant reasoning. A
benchmark that includes them will honestly score ~0 recall there; that zero is the point (it sizes the gap and
becomes the yardstick APEX/Weirdness must beat).

| class | covered today | detectable by | notes |
|-------|:---:|---|---|
| reentrancy | ✅ | structural + EVM validation | exploitability split is the live signal |
| access-control | ✅ | structural | syntactic |
| initialization | ✅ | structural (`initializer`) | |
| upgradeability (delegatecall/selfdestruct) | partial | structural | only the syntactic slices |
| unchecked-call | ✅ | structural | |
| tx-origin | ✅ | structural | |
| business logic | ❌ | — | needs semantic/model reasoning |
| accounting errors | ❌ | — | precursor probe only (`claude-accounting`, attended) |
| oracle manipulation | ❌ | — | |
| economic / attack | ❌ | — | needs simulation + value reasoning |
| cross-contract | ❌ | — | protocol-model substrate exists, no detector |
| transaction ordering | ❌ | — | |
| state-transition | ❌ | — | |
| protocol invariant | ❌ | — | |

## 3. Design (layered corpus, blind grading + AI adjudication)

Chosen by the operator: **layered corpus** (synthetic + curated real-CVE) and **deterministic grading plus an
independent AI-adjudication pass**.

**Layer A — synthetic matched pairs (new).** One minimal vulnerable contract and a matched secure variant per
uncovered class, each a new *frozen* corpus beside `eval/heldout*` following the same convention: `contracts/` +
`labels.json` (schema `{file, contract, function, class, vulnerable, line, exploitable?, pair?}`), a `FROZEN.md`
with date + `MANIFEST.sha256`, and a new `eval/exposure.json` entry (`status: blind` for any capability written
before the freeze). Clean per-class signal, fully controlled labels, no external dependence.

**Layer B — curated real-CVE (extends `eval/heldout5`).** A handful of audited protocols pinned at a
disclosed-vulnerability commit **and** their patched commit, each ground-truth label verified against the public
disclosure, expressed in `eval/heldout5/schema/ground-truth.schema.json`. This is the realism layer; it reuses the
`agentsmith-preregistration/1` frozen-answer-key format (`eval/production-cycle-1/expected-findings.json`) so the
key is committed and hashed **before** any run.

**Grading.**
1. *Deterministic match* (today's `score()`): a label is detected when a finding matches `file+function+class`;
   report per-class TP/FP/FN/TN, precision/recall, line-exactness. Reproducibility checked by re-running on
   reversed file order (already done).
2. *Exploitability* for classes that support it: the EVM/Foundry validators decide *validated / refuted*, scored
   separately from pattern detection (the reentrancy split above is the template).
3. *AI adjudication* (independent): near-misses, severity accuracy and any finding the deterministic grader can't
   place are judged by a model **through the `AiBudgetGateway`** (the $25/mo budget, per-workflow caps), with the
   answer key withheld from the discovery engine and the adjudicator prompted only with the finding + code, never
   the label. Adjudications are recorded like `eval/adjudications/*`.

**Metrics recorded per run:** true positives, false positives, missed vulnerabilities, severity accuracy,
reproduction success (validated/refuted), wall-clock time, and AI spend (from `model_usage_events`). Every row
names the capability's **exposure** (`blind | blind-labels | tuned | seen | same-family-authored`) per
`agentsmith-exposure/1`; a capability with no exposure entry is not scored.

**Blindness guardrails:** answer keys never reach the discovery engine; new corpora are frozen (hash-pinned)
before first score; `eval/exposure.json` tracks contamination; `eval/verify-frozen.sh` checks the manifests.

## 4. Build plan (increments)

- [x] **B0 — baseline.** Measure the deterministic analyzer blind; record saturation + the exploitability split. *(this doc + `eval/results/benchmark-b-baseline-heldout.*`)*
- [x] **B1 — synthetic Layer A, first uncovered class.** accounting-error matched pair, frozen, exposure-registered; engine recall 0 — the gap, and proof the extension pipeline works end-to-end.
- [x] **B2 — synthetic Layer A, four uncovered classes.** `eval/benchmark-b` now holds matched pairs for accounting-error, oracle-manipulation, state-transition and protocol-invariant; frozen (`MANIFEST.sha256`), exposure=blind. The analyzer scores **recall 0 on all four, 0 false positives, 0 stray findings** (`eval/results/benchmark-b-structural.txt`) — each pair is written so the only detectable difference is the semantic defect. Remaining uncovered classes to add next: business-logic, economic-attack, cross-contract, transaction-ordering.
- [ ] **B3 — grader harness.** Extend `run-eval.ts` into a benchmark runner that also records time + AI spend and emits the metrics table; wire the AI-adjudication pass through the budget gateway.
- [ ] **B4 — curated real-CVE Layer B.** 2–3 audited protocols at disclosed-vuln + patched commits, ground-truth verified against disclosures, pre-registered answer keys.
- [ ] **B5 — baseline report across both layers**, then (and only then) consider detection changes, each re-scored blind.

## 5. Standing constraints

No deployment, no worker activation, no Immunefi; disposable Postgres for any DB-backed run; all AI calls through
the budget gateway (≤ $25/mo); frozen corpora and provenance preserved; answer keys never exposed to the engine;
no weakening of detection to inflate a score.
