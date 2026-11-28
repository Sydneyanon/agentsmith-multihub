# Held-out corpus 2: FROZEN

Authored by a separate agent that was instructed not to read any analyzer code, the earlier held-out corpus, any evaluation results or known failure cases (it was told nothing about them). 50 contracts, 96 labels, including labels the author marked `ambiguous`. Compiler gate before freezing: all 50 contracts compile with solc 0.8.28 (pass/fail only; the files were not read by the analyzer's author, and the labels were not inspected).

Frozen before any analyzer was run on it. The candidate that scores it is tag `structural-candidate-1` (commit 6cd3be7), run unmodified. The result is recorded in `eval/results/heldout2-run1-candidate1.*` exactly as produced. After that the corpus is no longer held-out for any analyzer change made in response to what it shows.
