# benchmark-b: FROZEN (Priority B expansion corpus)

Frozen 2026-11-27. This corpus extends the vulnerability-detection benchmark (`docs/vuln-detection-benchmark.md`)
into classes the deterministic engine does **not** cover today. Each class is a matched pair: one minimal
vulnerable contract and one structurally-identical secure variant, so a detector is scored on both recall (does it
catch the bug) and precision (does it leave the clean twin alone).

Classes present:
- **accounting-error** — `AccountingSaleBad.sol` (vulnerable) / `AccountingSaleGood.sol` (secure). A fixed-price
  sale whose `buy()` multiplies by the per-token price instead of dividing, minting far more tokens than paid for.
  No external call, so it is not a reentrancy/unchecked-call pattern — the only defect is the accounting.

Rules (same as the other frozen corpora): no tuning of any detector against these files or labels. If a file or
label changes, regenerate `MANIFEST.sha256` and record in the results that the corpus is no longer frozen. Labels
were authored for this benchmark and are checked against the stated bug; the accounting pair is simple enough to
verify by inspection (no compiler run is required to see the inverted operator).

Baseline (recorded `eval/results/benchmark-b-accounting.txt`): `solidity-structural-specialists@1` scores
recall 0 on `accounting-error` (1 miss, 0 false positives on the secure variant). That zero is the intended
measurement — it sizes the gap the engine must close, and is the yardstick any future accounting capability
(or APEX/Weirdness) has to beat. Exposure recorded in `eval/exposure.json` as `blind`.
