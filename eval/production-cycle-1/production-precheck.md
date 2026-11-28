# Production pre-check, 2026-11-27 (read-only)

These checks ran on the production machine `2870320f99dd68`, release v6, image `sha256:7f99bf27…`, label revision `837aeb9b48ed`.
The script was sent with `fly machine exec`, because `fly ssh console` cannot build its tunnel from the cloud container.
- Every database statement ran inside `BEGIN READ ONLY … ROLLBACK`.
- GitHub was reached through the deployed `GitHubSource`, unauthenticated, with read-only GETs and one HEAD.
- Nothing was written; the temporary script file was deleted and its absence confirmed.
- No secret was printed.

| Check | Result | Status |
|---|---|---|
| Image contains the worker entry point and structural-analysis step | `dist/.../worker-main.js` and `analysis/solidity/step.js` present | pass |
| Migrations applied | 0001 to 0007; `discovery_sources` absent | as expected |
| Existing research state | 0 runs, 0 steps, 0 snapshots, 0 hypotheses, 0 evaluations, 0 blobs; database 9.8 MB | as expected |
| Connected sessions | `pg_exporter` and this check only; no worker | as expected |
| Database role the worker would use | session user `fly-user`, effective role `schema_admin`, which **owns** every research table; not superuser, no CREATEROLE, no BYPASSRLS. The least-privilege runtime role (R1) is not applied; the API already runs this way under the A25 acceptance | **risk, needs a decision** |
| GitHub through the deployed client | identity `OpenZeppelin/ethernaut` (id 111001784, not archived, not a fork); the pinned commit resolves to tree `481488182d37…`; the tree is not truncated and has 1,381 non-directory entries, matching the local plan | pass |
| Archive host | `codeload.github.com` HEAD 200 | pass |
| GitHub rate limit (unauthenticated, per IP) | 60 per hour, 51 left after these checks. An acquisition needs about 3 to 4 API calls. The egress IP may be shared | pass, but limited |
| Acquisition limits | 1,381 rows, under 20,000; 252 KB stored, under 64 MiB. The archive is about 5.9 MB compressed and 24.5 MB uncompressed, under 128 and 512 MiB | pass |
| Analysis side effects (code at `837aeb9`) | no `child_process`, spawn or fetch in `apps/api/src/analysis`; nothing compiled or executed; no AI calls | pass |

## Uncertainties

1. **The worker would run as the table-owning role.** In principle an owner could disable the immutability triggers. The deployed code never does, but the database would not stop it. The alternative is applying R1 first, which is a database change that needs its own approval.
2. **Unauthenticated GitHub quota.** Repeated retries could exhaust the 60 calls per hour and fail acquisition (it can be retried; nothing partial is sealed). Adding a `GITHUB_TOKEN` would be a new secret, which is not proposed.
3. **Not exercised end to end in production:**
   - a worker claiming steps;
   - writing blobs and sealing a snapshot on this database (Fly Managed Postgres through pgbouncer);
   - the analysis on 102 files within the step lease and the 512 MB VM.

   These are what the run itself would prove.
4. **Run creation.** No HTTP route creates a run with analysis switched on, so A34 needs a one-off operator script. It would call the deployed `createRepositoryResearchRun(..., { structuralAnalysis: true })` through `fly machine exec`.
