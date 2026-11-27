# Release process (permanent)

**Purpose:** production always runs one identified release, and the release always reflects what has been built and verified.
Two files are the source of truth:
- `deploy/release.json`: the release baseline (candidate, approval, critical fixes, previous images);
- `deploy/fleet.json`: the machines that should exist.

The checks are `scripts/fleet-plan.ts` and `scripts/release-check.ts`. Both are read-only: they print what to do, and never do it.

## For every release
1. **Build from a clean, pushed commit:**
   `HUB_RELEASE_LAST_MIGRATION=0007 HUB_RELEASE_EXTRA_MIGRATIONS=<approved list> scripts/hub-image.sh build`
2. **Verify:** typecheck; `npm test`; `npm run test:integration`, both as the owner and with `TEST_RUNTIME_ROLE=1`;
   `scripts/hub-image.sh verify` (the image smoke test, run against a disposable database). Every check must pass. Record the count.
3. **Push:** `scripts/hub-image.sh push`. Record the digest it prints.
4. **Update `deploy/release.json` in a commit:** the candidate's commit, image, smoke result, analyzer version and migrations, plus
   any new critical fix. `scripts/release-check.test.ts` checks that every listed fix is contained in the candidate.
5. **Run the drift report:** `npx tsx scripts/release-check.ts --engine-status <saved /v1/engine/status>`. It goes into the
   approval request with each finding and the approval it needs.
6. **Owner approval.** Set `approved` in `release.json` in the same commit that records the approval.
7. **Deploy in the order the report prints.** The API (`fly deploy`) and **every** other machine (`fly machine update`) move together,
   because `fly deploy` updates only the `app` process group. Run `release-check` again after each step.
8. **Done** when `release-check` exits 0: no mismatch, nothing behind, no missing fix, no missing migration, every declared machine
   running.

## Rules
- **No accumulated drift.** If an approved release is not deployed within a working day, or a critical fix lands, the next status
  report says so and gives the `release-check` output.
- **No `fly machine run` of a long-lived machine outside `deploy/fleet.json`.** Declare it first; undeclared machines are
  reported as `unexpected`.
- **Experimental work stays out of a release** until it is verified. It is kept on the branch behind a flag, or as a proposal under
  `docs/proposals/`.
- **`main`:** the release commit should be on `main`. Until you decide how the branch reaches `main` (normally a pull request),
  `release-check` reports `release_not_on_main`.
