# Evaluation results (facts only)

Corpora: `eval/dev` (written by the analyzer's author; used for development; **not** independent) and `eval/heldout` (42 contracts, 47 labels, written by a separate agent that never saw the analyzer; frozen before the analyzer existed; see `eval/heldout/FROZEN.md`). Labels on both are author-asserted and **not** verified by compilation or execution.

| Analyzer | Corpus | TP | FP | FN | TN | Precision | Recall | Key line exact |
|---|---|---|---|---|---|---|---|---|
| Baseline prototype (line patterns) | dev (31 labels) | 10 | 4 | 7 | 10 | 0.71 | 0.59 | 10/10 |
| Structural analyzer | dev | 17 | 0 | 0 | 14 | 1.00 | 1.00 | 17/17 |
| Baseline prototype | held-out | 8 | 10 | 10 | 19 | 0.44 | 0.44 | 5/8 |
| **Structural analyzer, run 1 (frozen result)** | held-out | 18 | **1** | 0 | 28 | 0.95 | 1.00 | 18/18 |
| Structural analyzer, after fixing the run-1 failure | held-out | 18 | 0 | 0 | 29 | 1.00 | 1.00 | 18/18 |

How to read this honestly:
- Run 1 (`heldout-run1-structural.*`) is the only genuinely held-out measurement of the analyzer. Its one false positive (`SdB.shutdown`) was a real bug: a modifier argument (`onlyBy(owner)`) was not recognised as the authority. I inspected that one file after scoring, fixed the bug, and added a development fixture. The later 18/0 result is therefore **no longer held-out**: it was tuned on an observed failure. A fresh corpus is needed for the next measurement.
- The corpus is small (47 labels, 19 vulnerable), the textbook patterns are shared between author and analyzer (same model family), and the labels are unverified. Perfect recall here does not predict recall on real contracts. The baseline's collapse on the same files shows the corpus does discriminate.
- The execution validator disagrees with two of four `vulnerable` reentrancy labels in the held-out corpus (`ReentHelperA`, `ReentBankA`): under checked 0.8 arithmetic the re-entrant transaction reverts, so no drain is possible by the modelled attacker. Whether those labels or the model is wrong is open; the corpus author flagged the helper label as uncertain.
- Findings in functions without a label are not scored (0 on the held-out corpus).

## Update: compiler-backed ground truth
See `ground-truth-README.md`. The four disputed reentrancy cases are settled by execution: checked arithmetic makes the labelled-vulnerable pattern non-drainable; unchecked twins are exploitable; validator vs EVM agreement 19/19. The run-1 held-out result and all earlier rows above are unchanged and still valid as recorded.

## Update: independent evaluation of the frozen candidate on a fresh corpus (T-140)
Corpus `eval/heldout2`: 50 contracts, 96 labels (24 marked `ambiguous` by their author), written by an agent that was told nothing about the analyzer, the earlier corpus or any result; all 50 compile with solc 0.8.28 (pass/fail gate only); frozen with a manifest **before** any analyzer ran on it. Candidate: tag `structural-candidate-1` (commit 6cd3be7), run unmodified (`heldout2-run1-candidate1-structural.*`), baseline alongside (`heldout2-run1-baseline.*`).

| Analyzer | Labels | TP | FP | FN | TN | Precision | Recall |
|---|---|---|---|---|---|---|---|
| Baseline prototype, all labels | 96 | 13 | 16 | 24 | 43 | 0.45 | 0.35 |
| **Candidate 1, all labels** | 96 | 27 | 10 | 10 | 49 | 0.73 | 0.73 |
| Candidate 1, clear labels only (72) | 72 | 27 | 2 | 6 | 37 | 0.93 | 0.82 |
| Candidate 1, ambiguous labels only (24) | 24 | 0 | 8 | 4 | 12 | 0.00 | 0.00 |

By class (candidate 1, TP/FP/FN): reentrancy 7/1/2, access-control 9/3/2, initializer 1/0/4, delegatecall 2/3/1, selfdestruct 2/1/0, tx-origin 2/1/0, unchecked-call 4/1/1. Key line exact for 26 of 27 detections.
Abstentions (reentrancy execution validator on the 8 leads): validated 4, refuted 3, inconclusive 1. Unlabelled findings: 0.

Honest reading: on this independently written, harder corpus the candidate is much better than the baseline but nowhere near the 18/18 seen on the first corpus; most of the gap is initializer and upgradeability, access control on unusual shapes, and judgement calls the author marked ambiguous (where the analyzer flags and the label says benign, or the reverse). The two corpora's labels are unverified except for reentrancy (compiler-backed, see `ground-truth-README.md`).

**After this run the corpus is no longer held-out.** I inspected the misses and fixed general failure classes (early-return paths before a check, authority passed through helper arguments, delegatecall provenance through helpers, stored allow-lists, initializer breadth, fixed-owner payouts, halt-style setters). The re-score `heldout2-after-tuning-DEVELOPMENT-not-heldout.*` (TP 31, FP 8, FN 6, TN 51) is **development evidence only**. Corpora 1 and the development corpus are unchanged by those fixes (18/0 and 17/0). A third corpus is needed for the next honest measurement.

## Update: third independent corpus, both frozen candidates and the baseline (2026-11-26)
**Corpus.** `eval/heldout3` has 58 contracts and 79 labels; its author marked 8 of them `ambiguous`. It was written by a separate agent
that was told nothing about the analyzer, the earlier corpora or any result, and all 58 contracts compile with solc 0.8.28 (pass/fail
gate only). It was frozen and committed in `912bda2`, and pushed, before any analyzer ran on it. See `eval/heldout3/FROZEN.md`, which
also discloses the one exposure: the author's hand-back message named the ambiguous labels before scoring. No analyzer change followed.

**Scoring.** Each analyzer ran once, unmodified, in a clean worktree at its tag: `structural-candidate-1` = 6cd3be7 and
`structural-candidate-2` = 9c2d80e, both verified by `eval/verify-frozen.sh`. The baseline ran from the candidate-2 worktree; the
baseline and the harness are identical at both tags. The raw outputs `heldout3-run1-*.{json,txt}` are unedited. The clear/ambiguous
split below is derived from them by `heldout3-split.py` into `heldout3-run1-split-DERIVED.txt`.

| Analyzer | Labels | TP | FP | FN | TN | Precision | Recall |
|---|---|---|---|---|---|---|---|
| Baseline prototype, all labels | 79 | 8 | 7 | 23 | 41 | 0.53 | 0.26 |
| Baseline, clear labels only | 71 | 6 | 5 | 20 | 40 | 0.55 | 0.23 |
| **Candidate 1, all labels** | 79 | 18 | 2 | 13 | 46 | 0.90 | 0.58 |
| **Candidate 2, all labels** | 79 | 18 | 2 | 13 | 46 | 0.90 | 0.58 |
| Candidates 1 and 2, clear labels only | 71 | 17 | 2 | 9 | 43 | 0.89 | 0.65 |
| Candidates 1 and 2, ambiguous labels only | 8 | 1 | 0 | 4 | 3 | 1.00 | 0.20 |

**By class** (both candidates, TP/FP/FN):

| Class | TP/FP/FN |
|---|---|
| reentrancy | 4/1/2 |
| access-control | 4/0/1 |
| initializer | 2/0/4 |
| delegatecall | 2/1/2 |
| unchecked-call | 2/0/2 |
| selfdestruct | 1/0/2 |
| tx-origin | 3/0/0 |

Key line exact: 12/18 for both. Within 2 lines: 17/18 for candidate 1 and 16/18 for candidate 2.

**Abstentions.** The execution validator ran on the 5 reentrancy leads, with the same verdicts for both candidates:
- **Validated (1):** `withdrawRefund`, labelled vulnerable.
- **Refuted (3):**
  - `PrepaidCreditLedger.withdraw`, labelled benign. The refutation agrees with the label.
  - `EtherShareVault.redeem`, labelled vulnerable. This disagrees with the label.
  - `MerchantEscrow.release`, labelled vulnerable. This disagrees with the label.
- **Inconclusive, i.e. an abstention (1):** `AirdropDistributor.claim`, where the external call `points.mint` could not be modelled.

The two disagreements are **open**: either the label or the validator's bounded scenarios are wrong. The corpus author describes the
`EtherShareVault` drain as re-entering `deposit` at a depressed share price, a cross-function path. Neither is settled by the
compiler-backed EVM check yet.

**Unlabelled.** Findings in unlabelled functions, which are not scored: 10 for candidate 1, 7 for candidate 2.

**Honest reading:**
- **The fixes did not move the labels.** Candidates 1 and 2 agree label by label: same 18 detections, same 13 misses, same 2 false
  positives. The fixes made after corpus 2 and the first real run gave no measurable gain in label recall or precision on this
  independent corpus. Their only visible effect is fewer findings outside the labelled functions (10 to 7).
- **Precision is high and recall is moderate.** Precision on clear labels is 0.89; recall is 0.65. The weak classes are again the
  upgradeable/initializer family (initializer 2 of 6 found, selfdestruct-through-logic-contract 1 of 3), proxy fallbacks (delegatecall
  2 of 4) and some unchecked-call shapes.
- **The baseline is far behind** (recall 0.26).
- **Ambiguous labels are reported separately and are not counted as wins or losses** of either side. The analyzer found 1 of the 5
  labelled vulnerable, and flagged none of the 3 labelled benign.
- **The sample is small.** With 31 vulnerable labels, a one-label change moves recall by about 3 points.

**After this run the corpus is no longer held-out** for any change made in response to it. No analyzer change was made in this cycle.

## Update: ground-truth adjudication and development changes (2026-11-26, later)
- **Adjudication** (`eval/adjudications/`): both disputed corpus-3 reentrancy labels are **upheld**. The evidence is EVM execution of
  the unchanged contracts plus an independent assessor who saw no labels. The validator's two refutations were artefacts of its model.
  The corpus-3 label metrics above are unchanged. The validator line is corrected: of its 3 refutations, only 1 was right.
- **Development changes** (`docs/analyzer-failure-classes.md`): failure class A, and validator defects V1–V3. The re-scores
  `heldout2-after-cycle4-*` and `heldout3-after-cycle4-*` are **DEVELOPMENT evidence, not held-out**:
  - corpus 3: TP 18, FP 1, FN 13 (FP 2 → 1);
  - corpus 2, corpus 1 and the dev corpus: unchanged.
- **Corpus 4** (`eval/heldout4`) is sealed and unscored. It is the next held-out gate.

## Update: corpus 4, scored once: candidate 3, candidate 2, baseline (2026-11-26; owner approval A2)
**Protocol.** `docs/corpus4-freeze-before-score-checklist.md`:
- Candidate 3 is `48d9a38`. Its analyzer and harness are byte-identical to `79716bd` (class A plus validator V1–V3). It was registered in
  `eval/candidates.json` and pushed in `aa6119d` **before** scoring.
- Corpus 4 (`b9df4e5`, manifest `9627b82a…`) was never opened before scoring, and its manifest was verified unchanged afterwards.
- Each analyzer ran once, in a clean worktree at its registered commit. Raw outputs `heldout4-run1-*` are unedited, with hashes in the
  registry. The split comes from `heldout4-split.py` into `heldout4-run1-split-DERIVED.txt`.

| Analyzer | Labels | TP | FP | FN | TN | Precision | Recall |
|---|---|---|---|---|---|---|---|
| Baseline prototype, all | 79 | 12 | 6 | 26 | 35 | 0.67 | 0.32 |
| Candidate 2, all | 79 | 21 | 2 | 17 | 39 | 0.91 | 0.55 |
| **Candidate 3, all** | 79 | 20 | 1 | 18 | 40 | 0.95 | 0.53 |
| Candidate 2, clear only (67) | 67 | 20 | 1 | 9 | 37 | 0.95 | 0.69 |
| **Candidate 3, clear only (67)** | 67 | 20 | **0** | 9 | 38 | **1.00** | 0.69 |
| Candidate 2, ambiguous only (12) | 12 | 1 | 1 | 8 | 2 | — | — |
| Candidate 3, ambiguous only (12) | 12 | 0 | 1 | 9 | 2 | — | — |

**Labels where candidates 2 and 3 differ:** exactly two, both `upgradeToAndCall` (delegatecall class).
- `I06_LendingPoolV1`, clear, benign: candidate 2 flagged it, candidate 3 does not. This is a false positive removed by class A
  (deployed-contract dispatch sees the owner-guarded override).
- `I05_LendingPoolV1`, **ambiguous**, vulnerable: candidate 3 no longer flags it. The author's concern is an unlocked implementation
  (failure class F, designed, not implemented), not the override that candidate 3 now correctly resolves.

**Execution validator.**
- Candidate 3: 1 validated, 1 refuted, 1 inconclusive.
- Candidate 2: 0 validated, 2 refuted, 1 inconclusive.

V1 (consistent seeding) turned a wrong refutation of `withdrawAll` (labelled vulnerable) into a validation. One refutation of a
labelled-vulnerable lead remains (`claim`); it is **open** and goes to adjudication (T-145) if pursued, never to a label edit.

**Honest reading:**
- The changes behave as designed on data they were not built from: one fewer false positive on clear labels, no clear-label recall lost,
  one validator error corrected.
- The effect is **one label on each side**. That is not statistically distinguishable from no change on a corpus of this size, so no
  claim of significant improvement is made.
- Recall on clear labels (0.69) is unchanged: the designed but unimplemented failure classes B–H remain the main gap.
- Both structural candidates far exceed the baseline.
- **Corpus 4 is now spent as held-out.** Any change made in response to it is development evidence; a fifth sealed corpus is needed for
  the next claim.
