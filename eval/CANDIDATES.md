# Frozen candidate identity and evaluation provenance

## Why
The remote refuses tag pushes from this environment: the git proxy disconnects on any ref other than the session branch. This was
re-tested on 2026-11-26. The tags `structural-candidate-1` and `structural-candidate-2` therefore existed only in one container.

## Method (no frozen commit is modified)
`eval/candidates.json` is committed and pushed with the branch. For each candidate it records:
- the **commit SHA** and **tree SHA**;
- the **analyzer subtree SHA** and the **harness blob SHA**;
- the original tag message and time;
- the **SHA-256 of every result file scored with it**.

It also records each frozen corpus's manifest sum and freeze commit, and the baseline result hashes.

Git objects are content-addressed, so a commit SHA plus a tree SHA is a stronger identity than a tag, which is a movable pointer. Both
frozen commits are ancestors of the pushed branch, so they exist on the remote.

- `eval/candidates.sh verify` checks that every candidate commit:
  - exists;
  - matches its tree, analyzer and harness hashes;
  - is an ancestor of HEAD.

  It also checks every recorded result file and corpus manifest, and that any local tag agrees.
- `eval/candidates.sh restore-tags` recreates missing local tags from the registry and never moves an existing tag.
- `eval/verify-frozen.sh` now runs both checks and needs no tags.

**Tested:** a fresh clone from the remote, with no tags, verifies everything and restores both tags at the recorded commits.

## Residual risk and owner options
The remote keeps the frozen commits only while some remote ref contains them. If this branch were **squash-merged and deleted**, they
could become unreachable and be garbage-collected. Ways to remove that risk, which need the owner:
1. merge with history preserved (merge commit or rebase), not squash; or
2. allow a protected `frozen/*` branch or push the tags from the owner's machine (`eval/candidates.sh restore-tags`, then
   `git push origin --tags`); or
3. open a pull request for this branch, since GitHub retains pull-request head commits.

Nothing here changes an existing corpus or raw result file.
