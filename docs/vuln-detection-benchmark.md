# Vulnerability-detection benchmark (Priority B)

Status: **B0–B3 complete; B4 audited and blocked on owner gates (A22/A23).** 2026-11-27.

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

- [x] **B0 — baseline.** Deterministic analyzer blind on `eval/heldout`: P/R 1.000 on the 7 syntactic classes (saturated); EVM validation splits reentrancy 2 validated / 2 refuted. *(`eval/results/benchmark-b-baseline-heldout.*`)*
- [x] **B1/B2 — synthetic Layer A, all eight semantic classes.** `eval/benchmark-b` **v3**: 8 matched pairs (16 contracts, 16 labels: 8 vulnerable, 8 secure). Versioned with an amendment log (`AMENDMENTS.md`, archived `versions/v1`, `versions/v2`); `eval/verify-frozen.sh` re-checks that every earlier version's files are byte-identical.
- [x] **B3 — evaluation infrastructure.** `eval/bench/` runner + independent AI adjudication through `AiBudgetGateway` + model-facing view (see §6).
- [ ] **B4 — curated real-CVE layer (`eval/heldout5`).** Audited (`docs/heldout5-b4-assessment.md`): protocol sound, no entries exist; selection needs an independent selector outside this repository (A22), scoring needs A23. Not started by design.
- [ ] **B5 — baseline across both layers**, then (and only then) detection changes, each re-scored blind.

### B2 results (benchmark-b v3, `eval/results/benchmark-b-v3-structural.*`)
Every contract compiles (solc 0.8.28); every pair is verified **by execution** (`eval/benchmark-b/verify-behaviour.mjs`, 8/8: vulnerable variant exhibits the defect, secure variant does not); every label line is checked against the source.

| class | pair | vulnerable variant shown by execution | recall | FP on secure twin |
|---|---|---|:-:|:-:|
| accounting-error | AccountingSale | 1 ether credits 10^33 tokens (fair 1000) | 0 | 0 |
| oracle-manipulation | OraclePrice | spot 100x TWAP gives 100x borrow power | 0 | 0 |
| state-transition | SalePhase | claim succeeds during Active | 0 | 0 |
| protocol-invariant | SupplyInvariant | after burn, totalSupply != sum(balances) | 0 | 0 |
| business-logic | ReferralSale | self-referral gets the discount | 0 | 0 |
| economic-attack | DonationVault | victim gets 0 shares for 5 ether; attacker +5 ether | 0 | 0 |
| cross-contract | AirdropTrust | ineligible caller claims via own eligibility contract | 0 | 0 |
| transaction-ordering | SwapNoSlippage | front-run victim receives 8.19 vs quoted 9.90 | 0 | 0 |

Overall: tp 0, fp 0, fn 8, tn 8 — recall 0, false-positive rate 0, **0 detector collisions, 0 unscored findings**, reproducible across file order. One collision was found and removed *during authoring* (pre-freeze): the reentrancy heuristic flagged a `view`/STATICCALL call to a caller-supplied contract — an analyzer false-positive pattern, recorded in `eval/benchmark-b/AMENDMENTS.md`.

## 5. Standing constraints

No deployment, no worker activation, no Immunefi; disposable Postgres for any DB-backed run; all AI calls through
the budget gateway (≤ $25/mo); frozen corpora and provenance preserved; answer keys never exposed to the engine;
no weakening of detection to inflate a score.

## 6. B3 — runner, adjudication and blinding (`eval/bench/`)

- `benchmark.ts` / `run.ts`: wraps the existing black-box `score()`; records runner version, benchmark name + version + manifest
  verification (SHA-256 of `MANIFEST.sha256`), analyzer capability + git commit + dirty flag, declared analyzer limitations,
  exposure status, timing, per-class and overall precision / recall / false-positive rate, **detector collisions and unscored
  findings** (which `score()` silently dropped), label integrity against the source (a label may sit in an internal callee; that is
  reported, not hidden), and failures. A run is `complete` only if the manifest verifies, labels check out and the analyzer ran; a
  recall of 0 is a result, not a failure. Verified on `heldout` (reproduces the B0 baseline exactly) and on benchmark-b v3.
- `adjudicate.ts`: candidates are findings the deterministic grader cannot settle (collisions, unscored, label-contradicting).
  Calls go **only** through `AiBudgetGateway` with task `independent_challenge` (configured tier3, $0.10 per call), one attempt
  each, no retries; a budget/catalog block or a provider error halts the pass and the rest are recorded `unavailable` / `failed`,
  never as judgments. Tokens and cost come from the gateway's own reservation ledger. Results sit in `record.ai`, separate from
  the deterministic result, and cannot change labels.
- `model-view.ts`: **benchmark-b's raw files are an answer key for any model** (explanatory `BUG (...)` comments and `Bad`/`Good`
  contract names; corpora 1–4 have neither). Everything shown to a model passes through a view that blanks comments (line numbers
  kept) and neutralises contract names and file paths; the mapping never leaves the runner.
- Live status: AgentSmith has no production model adapter and its reviewed price catalog is empty by design, so adjudication from
  the CLI is recorded **unavailable** ($0 spent). The gateway path is proven with fake adapters over real Postgres
  (`eval/bench/adjudicate.integration.test.ts`, also under the least-privilege runtime role).


## 7. Capability history (structural analyzer)

Each entry gives the analyzer version, the commit, what changed, the evidence for it, and its limitations. "Heldout" corpora have
each been scored many times, so a gain on them is evidence and not a fresh blind result. Only a newly frozen, never-scored corpus
gives a blind result.

| analyzer | commit | change | evidence | limitations |
|---|---|---|---|---|
| structural-solidity/1 | ≤ `939e17c` | baseline structural specialists + execution validator for reentrancy | dev P=1 R=1; heldout P=1 R=1; heldout2 P=0.795 R=0.838; heldout3 P=0.952 R=0.645; heldout4 P=0.952 R=0.526; benchmark-b v3 recall 0 | syntactic patterns only; no meaning-aware reasoning |
| structural-solidity/1 (unchanged string) | `5d6ccd1` (**first production release**) | cross-file citation root-cause fix (call-chain frames use the caller's file); per-dossier coverage status; malformed-file detection; uncitable findings rejected | all frozen corpora identical; regression test fails 3/3 without the fix | the version string was not bumped, so attribution of this build relies on the recorded build commit |
| structural-solidity/2 | `53301db` + labelling commit | writes through `storage` locals and `storage` parameters count as state writes (reentrancy) | 10 synthetic tests (4 positive, 6 negative); heldout3 R 0.645→0.677, P 0.952→0.955 (`NativeStakingPool.unstake`, exact line); all other corpora identical; 0 new false positives | not handled: storage references from function returns or ternaries, `using L for T` calls. **The execution check rates the new heldout3 hit "inconclusive"** (it cannot model writes to struct members); inconclusive means undecided, never "absent" |

Rule (unchanged): an inconclusive or missing independent check is never presented as evidence that a vulnerability is absent, and a
dossier with no leads says so explicitly (enforced in `renderDossierMarkdown` and tested end to end).
