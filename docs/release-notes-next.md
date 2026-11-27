# Release notes: next release (after 5d6ccd1)

Not built, not released, not deployed. The first production research run uses release `5d6ccd1` (image `sha256:b3a6327e…`),
which does **not** contain these changes.

## Detection improvement
- **Reentrancy through storage references** (`53301db`). A write such as `a.balance = 0`, where
  `Account storage a = accounts[msg.sender]`, now counts as a write to `accounts[msg.sender]`. The same applies to writes inside
  an internal helper that takes `Account storage a`.
  - Memory and calldata copies are still not treated as state.
  - Re-pointing a reference is not treated as a write.
- **Evidence:**
  - heldout3 recall rises from 0.645 to 0.677 and precision from 0.952 to 0.955. heldout3 has been scored many times, so this
    is not a blind result.
  - Every other frozen corpus is identical, with no new false positives.
  - 10 synthetic tests were added.
- **Limitation:** the execution check rates the new detection "inconclusive" because it cannot model struct-member writes.
  The dossier shows that as undecided.

## Attribution and honesty
- The analyzer version string is bumped to `structural-solidity/2 (specialists 1 + storage-reference writes, execution validators 1)`.
- The analysis step records `analyzer_build` (build commit and image).
- Every dossier names the analyzer and the build commit, or says "not recorded"; it never guesses.
- Dossiers state explicitly that an undecided independent check is not evidence of absence, and that no leads is not evidence of
  absence.
- Dossier content hashes change, because the analyzer record is now part of the hashed content.

## Release checks required before this ships
- Full release procedure: build, smoke 39/39, push, a new digest, and a new approval.
- No migration changes.
