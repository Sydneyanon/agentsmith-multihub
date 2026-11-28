# Corpus 4: freeze-before-score checklist (T-147). Executes ONLY after owner approval A2.

Corpus 4 (`eval/heldout4`, 59 contracts, 79 labels, 12 ambiguous) is a **one-time** independent evaluation set:
- sealed in `b9df4e5`; manifest sum `9627b82ae1ff72deae57cb8c21579f96ec5982ca8af9b4d96f83f51e0a7d7fd6`;
- uninspected and unscored.

Every box must be ticked in order. A failure at any step stops the procedure, with nothing scored.

## A. Before candidate 3 exists
- [ ] A1. Nobody opens `eval/heldout4/contracts`, `labels.json`, `tools/` or `README.txt`.
      The only permitted operations are `sha256sum -c` and `eval/verify-frozen.sh`.
- [ ] A2. `bash eval/verify-frozen.sh` passes, including `heldout4: manifest OK (9627b82a…)`.
- [ ] A3. All analyzer work intended for candidate 3 is committed and pushed. `git status` is clean.

## B. Freeze and register candidate 3 (before any scoring)
- [ ] B1. `C3=$(git rev-parse HEAD)`. Record `$C3`, its tree (`git rev-parse $C3^{tree}`), analyzer tree
      (`git rev-parse $C3:apps/api/src/analysis`) and harness blob (`git rev-parse $C3:eval/run-eval.ts`).
- [ ] B2. Add a `structural-candidate-3` entry to `eval/candidates.json` with:
      - those hashes;
      - `"frozenBefore": "eval/heldout4"`;
      - an empty `scoredResults`.

      Create the local tag: `git tag -a structural-candidate-3 $C3 -m "..."`.
- [ ] B3. Commit **only** the registry change (message: "eval: register structural-candidate-3 before scoring corpus 4") and push.
      Confirm with `git ls-remote origin <branch>`. The registry commit must be a descendant of `$C3` and of `b9df4e5`.
- [ ] B4. `bash eval/verify-frozen.sh` passes, now listing candidate 3.

## C. Score exactly once (clean worktrees; harness unchanged)
- [ ] C1. Create three worktrees: `git worktree add --detach <wt3> structural-candidate-3`, `<wt2>` at `structural-candidate-2` (`9c2d80e`),
      and a baseline worktree at `$C3`. Verify each worktree's `rev-parse HEAD`.
- [ ] C2. From each worktree, run `npx tsx eval/run-eval.ts <repo>/eval/heldout4/contracts <analyzer> <out>`:
      - candidate 3: `structural` → `heldout4-run1-candidate3-structural`;
      - candidate 2: `structural` → `heldout4-run1-candidate2-structural`;
      - baseline: `baseline` → `heldout4-run1-baseline`.

      Each runs **once**. A crash is recorded as a crash, not retried with changes.
- [ ] C3. Confirm the corpus manifest is unchanged afterwards (`sha256sum -c`).

## D. Record unedited
- [ ] D1. Copy the outputs byte-for-byte to `eval/results/`. Record their SHA-256 in the registry (`scoredResults`).
- [ ] D2. A derived split (clear / ambiguous labels / validator abstentions / per class) goes in a separate `*-DERIVED.txt`, produced
      by script.
- [ ] D3. Update `eval/results/README.md` with all three analyzers, clear and ambiguous labels separately, abstentions, and an honest
      reading. Commit and push.

## E. After scoring (permanent rules)
- [ ] E1. Corpus 4 is now **development data** for any change made in response. Every later re-score is named `*-DEVELOPMENT-not-heldout*`.
- [ ] E2. Disputed labels go to adjudication (`eval/adjudications/`, T-145). Labels are never edited.
- [ ] E3. Commission corpus 5, sealed before the next claim of improvement.
- [ ] E4. No tuning against corpus 4 while any claim relies on it being held-out.
