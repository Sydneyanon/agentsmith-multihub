# benchmark-b: FROZEN (Priority B expansion corpus) — version 3

Frozen 2026-11-27. Version history and amendments: `AMENDMENTS.md`; archived earlier versions: `versions/`. This corpus extends the vulnerability-detection benchmark (`docs/vuln-detection-benchmark.md`)
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
- **business-logic** — `ReferralSaleBad/Good.sol`. The referral discount is granted for any non-zero referrer, including
  the buyer (Bad) vs. only for an existing customer other than the buyer (Good).
- **economic-attack** — `DonationVaultBad/Good.sol`. Shares priced against the donatable raw ETH balance (Bad, first-depositor
  inflation) vs. internally tracked assets (Good).
- **cross-contract** — `AirdropTrustBad/Good.sol`. Eligibility asked of a caller-supplied contract (Bad) vs. the contract fixed
  at construction (Good).
- **transaction-ordering** — `SwapNoSlippageBad/Good.sol`. A swap with no minimum-output bound (Bad, sandwichable) vs. a
  caller-chosen `minOut` (Good).

Each pair is written so that the *only* difference the detectors could see is the target bug: no reentrancy-shaped
interaction (the one ETH transfer, `DonationVault.withdraw`, happens after all state is written), no missing access
control, no overflow. The corpus produces **zero** structural findings — every signal
is the semantic defect the engine has no capability for.

Rules (same as the other frozen corpora): no tuning of any detector against these files or labels. If a file or
label changes, regenerate `MANIFEST.sha256` and record in the results that the corpus is no longer frozen. Labels
are checked three ways: all 16 contracts compile (solc 0.8.28); `verify-behaviour.mjs` executes every pair in an EVM and
confirms the vulnerable variant exhibits the defect and the secure one does not (8/8); and every label line lies inside its
labelled function (checked by the benchmark runner).

Baseline v3 (recorded `eval/results/benchmark-b-v3-structural.txt` by `eval/bench/run.ts`): `solidity-structural-specialists@1`
scores **recall 0 on all eight classes** (8 misses, 0 false positives on the 8 secure variants, 0 collisions, 0 unscored
findings). The v2 result (`benchmark-b-structural.*`) and v1 result (`benchmark-b-accounting.*`) are preserved. That zero
is the intended measurement — it sizes the gap the engine must close, and is the yardstick any future semantic
capability (or APEX/Weirdness) has to beat. Exposure recorded in `eval/exposure.json` as `blind`.
