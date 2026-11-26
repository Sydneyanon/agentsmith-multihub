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
