# Integration test reliability record

Two intermittent integration failures were investigated on 2026-11-26, after one owner-role run failed during `npm run verify`
on cfdee08. Both causes were in the tests' own set-up, not in product code. No test was skipped, suppressed or weakened.

## Issue A: worker-loop "keeps working after the database terminates every connection mid-run"

**Observed.** On 2026-11-26 at 09:19, `npm run verify` on cfdee08 failed one owner-role integration test (238/239). The restricted-role run
passed 239/239. The verify summary did not keep the vitest output, so **the failing test's name was not captured at the time**.

**Evidence preserved.** The PostgreSQL server log for that minute contains, from the test login, during the owner-role run:

```
2026-11-26 09:19:41.091 UTC [2841] agentsmith_test@postgres ERROR:  permission denied to terminate process
DETAIL:  Only roles with the SUPERUSER attribute may terminate processes of roles with the SUPERUSER attribute.
STATEMENT:  SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()
```

That statement exists only in `worker-loop.integration.test.ts`. The server had restarted after an unclean shutdown 55 seconds earlier
(09:18:46, "database system was not properly shut down; automatic recovery in progress").

**Cause.** The test injects a fault by terminating every backend on its test database, as the non-superuser test login. When a
superuser-owned backend is on that database at that moment, PostgreSQL refuses the **whole statement**. The test then fails inside its
fault injection, not in the behaviour it tests.

Which superuser backend it was is **not recorded**: connections are not logged. The likeliest is an autovacuum worker, which runs as the
bootstrap superuser and is busier right after crash recovery. This is an inference.

**Reproduced.** The mechanism was reproduced deterministically: a parked superuser session on a database makes the test's exact query
fail with the same error. The same query restricted to non-superuser roles succeeds.

**Fix.** The fault injection now terminates only backends of non-superuser roles: every connection the worker and API hold. A new
assertion requires that at least one connection was actually terminated, so the test cannot pass by terminating nothing.

**Status: cause identified with high confidence, not fully proven** (the backend's identity was not logged). Kept **open (monitoring)**: the fix is in place and 40 reruns plus a full verify are clean, but the original trigger (a superuser
backend right after crash recovery) is rare, so a clean rerun record cannot by itself prove the cause.

## Issue B: discovery "records a material change as an 'updated' event, ignores churn in pushed_at, ..."

**Observed.** In rerun 7 of 25 owner-role reruns (10:37 UTC), `updated` was 1 where 0 was expected. The full output is preserved in
the investigation logs.

**Cause.** The fixture helper `repo()` computed `created_at` from `Date.now()` on **every call**. `created_at` is a stored, material
field. When the clock crossed a millisecond boundary between two `repo()` calls in the same test, the "pushed_at only" pass really did
carry a changed `created_at`. The monitor then correctly recorded `updated`. The product behaved correctly; the fixture was
nondeterministic.

**Proved.** With a forced 1 ms tick between calls, the old fixture fails with the identical assertion, and the fixed fixture passes.

**Fix.** One fixed `CREATED_AT` for every fixture repository. No assertion changed.

**Status: cause established; fixed.**

## Rerun record (2026-11-26)

| Batch | Code | Owner role | Restricted role |
|---|---|---|---|
| 25 owner-role reruns while investigating | cfdee08, the two fixes landing part-way | 23 passed; run 5 failed because the investigation reset the test password mid-run (excluded, self-inflicted); run 7 = Issue B | not run |
| Full `npm run verify` after both fixes | working tree on 41bc0ff | 239/239 | 239/239 |
| 20 + 20 reruns after both fixes (alternating) | e3c1739 (same test code) | **20/20 passed (239/239 each)** | **20/20 passed (239/239 each)** |

Owner-role and restricted-role results are always reported separately.
