# Held-out corpus 3: FROZEN

**Authoring.** Written by a separate agent. It was told not to read any analyzer code, the earlier corpora, any evaluation result or any
known failure case, and was told nothing about them.

**Size.** 58 contracts and 79 labels: 26 vulnerable, 45 benign, and 8 the author marked `ambiguous`. The author's `README.txt` describes
how it was written, the label schema, class counts and every edit it made.

**Provenance and process, as recorded:**
- **Paused mid-way.** The author stopped at a usage limit after writing 44 contracts. It was resumed with the same isolation rules to
  write the labels and README.
- **14 contracts added on resumption.** The 44 contained no selfdestruct or tx-origin cases, which its brief required. The author added
  7 selfdestruct, 6 tx-origin and 1 unchecked-call contract; the README names them. All 58 are kept.
- **Compiler gate before freezing.** All 58 contracts compile with solc 0.8.28 (pass/fail only; result in the commit message).
- **Disclosure.** The analyzer's author did not open the contracts or `labels.json`. However, the corpus author's hand-back message
  named the 8 ambiguous labels, a few other uncertain ones, and two possible compile issues. That text reached the analyzer's author
  before scoring. No analyzer code was changed between receiving it and scoring. The candidates scored are tags made earlier:
  `structural-candidate-1` = 6cd3be7573b80e995eabffd12e218807a2100f27 and `structural-candidate-2` = 9c2d80e70eb08dae2afae5ab55a11e372c38061d.

**Scoring.** Frozen with `MANIFEST.sha256` (sum in `MANIFEST.sha256.sum`) and committed **before** any analyzer ran on it. Each analyzer
is scored once, unmodified, at its tag, with the baseline alongside. Results are recorded exactly as produced in
`eval/results/heldout3-run1-*`. After that the corpus is no longer held-out for any change made in response to what it shows.
