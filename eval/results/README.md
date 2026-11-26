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
