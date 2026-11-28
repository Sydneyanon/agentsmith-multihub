# benchmark-b: FROZEN (Priority B expansion corpus)

Frozen 2026-11-27. This corpus extends the vulnerability-detection benchmark (`docs/vuln-detection-benchmark.md`)
into classes the deterministic engine does **not** cover today. Each class is a matched pair: one minimal
vulnerable contract and one structurally-identical secure variant, so a detector is scored on both recall (does it
catch the bug) and precision (does it leave the clean twin alone).

Classes present (one matched vulnerable/secure pair each):
- **accounting-error** — `AccountingSaleBad/Good.sol`. A fixed-price sale whose `buy()` multiplies by the per-token
  price instead of dividing, minting far more tokens than paid for.
- **oracle-manipulation** — `OraclePriceBad/Good.sol`. Collateral valued from a manipulable instantaneous spot
  price (Bad) vs. a TWAP with a staleness check (Good). The price read is a view, so no reentrancy pattern.
- **state-transition** — `SalePhaseBad/Good.sol`. A phased sale whose `claim()` guards on `phase != Setup` (Bad,
  allows claims during Active) vs. `phase == Ended` (Good).
- **protocol-invariant** — `SupplyInvariantBad/Good.sol`. `burn()` decrements the balance but not `totalSupply`
  (Bad, breaks sum(balances) == totalSupply) vs. decrementing both (Good).

Each pair is written so that the *only* difference the detectors could see is the target bug: no external value
transfer, no missing access control, no overflow. The corpus produces **zero** structural findings — every signal
is the semantic defect the engine has no capability for.

Rules (same as the other frozen corpora): no tuning of any detector against these files or labels. If a file or
label changes, regenerate `MANIFEST.sha256` and record in the results that the corpus is no longer frozen. Labels
are checked against the stated bug by inspection (each pair is small enough that the defect is visible without a
compiler run).

Baseline (recorded `eval/results/benchmark-b-structural.txt`): `solidity-structural-specialists@1` scores
**recall 0 on all four classes** (4 misses, 0 false positives on the secure variants, 0 stray findings). That zero
is the intended measurement — it sizes the gap the engine must close, and is the yardstick any future semantic
capability (or APEX/Weirdness) has to beat. Exposure recorded in `eval/exposure.json` as `blind`.
