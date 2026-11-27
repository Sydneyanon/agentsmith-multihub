# Proposal (not merged): protocol-invariant detector — commit ae048ad, kept as a patch

**Status:** implemented and tested on synthetic contracts only. **Not integrated**: no measured benefit, so it is kept out of the
analyzer that production research uses. Apply with `git am docs/proposals/protocol-invariant-ae048ad.patch` (based on `bbd903b`).

## What it does
It infers conservation invariants of the form `aggregate == sum over accounts of ledger[a]` from functions that maintain them
consistently, and flags a function that breaks them. A move to another bucket, a resync, or a branch, loop or arithmetic it cannot
decide is not counted. It adds an execution check (`challengeInvariant`) and 22 synthetic tests (8 positive, 12 negative, 2
execution).

## Measured result (scored once, after the detector was finished; no tuning afterwards)
| corpus | before = after |
|---|---|
| dev, heldout, heldout2, heldout3, heldout4 | identical findings, scores unchanged, 0 new false positives |
| benchmark-b v3 | recall 0 on all eight classes (including protocol-invariant and accounting-error), false-positive rate 0 |

**Interpretation:** its gates (at least two maintainers, maintainers that both increase and decrease, more maintainers than
breakers) are conservative enough that it raised no false positives, and also no true positives. The most likely cause is that
small contracts rarely have two decreasing maintainers. Relaxing the gates now would be tuning against a corpus that has
already been scored, so I'm not doing that silently. A relaxed variant needs a fresh evaluation set.

## Blind-integrity disclosure (from the developing agent)
- It did not read benchmark-b or heldout contracts, labels or notes, and it changed nothing under `eval/`.
- It did read `docs/vuln-detection-benchmark.md`. That document describes the benchmark-b classes in one line each (e.g.
  "after burn, totalSupply != sum(balances)"), so the class taxonomy was known while it developed.
- It read the bench runner and test code, which names two benchmark-b file names.
- An accidental repository-wide grep for `"tx-origin"` printed label class lines from `eval/*/labels.json` and from
  `eval/heldout4/tools/labels.py`. They are unrelated to this detector, and nothing from them was used.
- **Consequence:** benchmark-b v3 is no longer fully blind with respect to its class descriptions, because the benchmark
  document itself publishes them. A future blind result needs a corpus whose descriptions are not in the repository.
