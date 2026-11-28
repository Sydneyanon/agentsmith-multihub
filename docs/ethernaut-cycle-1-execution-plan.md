# Ethernaut cycle 1: execution plan (for approval; nothing executed)

**Goal:** the first real research cycle in the production workspace:
- acquire `OpenZeppelin/ethernaut` at the pinned commit;
- seal the snapshot;
- build the protocol model;
- generate hypotheses;
- run the deterministic evaluations;
- show it all on the dashboard.

**It tests the operational chain only.** It is an **exposure-qualified evaluation** (`eval/production-cycle-1/README.md`):
- the code is unseen by the analyser;
- the patterns are familiar from its development data;
- the answer key was written by the same model family that helped build the analyser;
- Ethernaut is public and may be in model training data.

It cannot establish independent detection ability or generalisation. Confirmed findings stay at **0**: no human adjudication is approved.

## Fixed inputs (frozen before anything runs)

| Item | Value |
|---|---|
| Answer key | `eval/production-cycle-1/expected-findings.json`, SHA-256 `6f3e6d1287bd576627d7e694a942b57e10ce882de48374db7bc2cdb74c49ca30`, frozen at commit `03061fd`; **never edited after the run**; corrections are separate dated records |
| Run input | `{"excludePathPrefixes":["client","contracts/out","contracts/test","contracts/src/attacks"],"ref":"d05643a40aa98c45d66247c69ffceab8f44dd8cb","repository":"OpenZeppelin/ethernaut"}` |
| Run input hash (canonical JSON) | `ec58efb2ff321ca0ba8a7043484b2d1f22631199e360461b5c9c8f73cfdc22a4`. `create-run-main` refuses any other input |
| Worker code | `837aeb9` plus `docs/release/r1-on-837aeb9.patch` (tree `ac2a6d2274f3d820b592c50d0c45673175430ed8`); 0001–0007 only; no branch code |
| Database role | `agentsmith_worker` (R1, `docs/r1-runtime-role.md`); never the owner |

## Steps and approvals

Each block needs its own explicit approval. I stop after each block and report before the next.

### Block R1: role and image (approval "R1-apply")

1. **Build and push the worker image** from the R1 tree with `HUB_RELEASE_LAST_MIGRATION=0007 scripts/hub-image.sh`.
   - New tag in `registry.fly.io/agentsmith-hub`. **No release and no deploy:** the API machine keeps v6.
2. **You:** `fly mpg users create <cluster> --username agentsmith_worker --role reader`, then `fly secrets set WORKER_DATABASE_URL='<its URL>' --stage -a agentsmith-hub`.
   - The password never passes through this session.
3. **Grants dry run** on a one-off machine (`--rm`, removed when it exits):
   `fly machine run <r1-image> --app agentsmith-hub --region syd --rm --restart no -e RUNTIME_ROLE=agentsmith_worker -e RUNTIME_ROLE_READONLY_MEMBERSHIPS=reader -e RUNTIME_GRANTS_ALLOW_ABSENT=true -e RUNTIME_GRANTS_DRY_RUN=true -e MIGRATE_CONFIRM_REMOTE_HOST=<db host> --entrypoint sh -- -c 'DIRECT_DATABASE_URL="$DATABASE_URL" exec node dist/scripts/apply-runtime-grants.js'`
   - It must report:
     - `reader` verified read-only;
     - exactly the four 0008 tables skipped;
     - about 21 privileges added and 0 removed;
     - "DRY RUN: rolled back".
   - I show you the output before step 4.
4. **Apply:** the same command without `RUNTIME_GRANTS_DRY_RUN`.
5. **Role check as the worker user:** a one-off machine runs the worker with `HUB_REQUIRE_RESTRICTED_DB_ROLE=true` and `WORKER_ONLY_RUN_ID` set to a UUID that does not exist.
   - It must log `worker_role_verified`, then exit 66 ("does not exist") **without claiming anything**.
   - This proves the role and the connection before any run exists.

### Block A34: one research run (approval "A34")

6. **Pre-run gate (read-only):**
   - the queue is empty (no queued, running or awaiting-approval run);
   - GitHub's unauthenticated quota is at least 20 remaining;
   - the answer-key hash is unchanged.
7. **Create the run** on a one-off machine, connected as `agentsmith_worker`:
   `… --entrypoint sh -- -c 'exec node dist/apps/api/src/acquisition/create-run-main.js --input '"'"'<run input above>'"'"' --expect-sha256 ec58efb2ff321ca0ba8a7043484b2d1f22631199e360461b5c9c8f73cfdc22a4'`
   - The output is the `run_id`. The run is visible on the dashboard as queued, with four steps: acquire, analyse, challenge, dossier.

### Block A26: one temporary worker (approval "A26")

8. **Start the worker:**
   `fly machine run <r1-image> --app agentsmith-hub --region syd --vm-memory 512 --rm --restart no -e STRUCTURAL_ANALYSIS_ENABLED=true -e HUB_REQUIRE_RESTRICTED_DB_ROLE=true -e RUNTIME_ROLE_READONLY_MEMBERSHIPS=reader -e WORKER_ONLY_RUN_ID=<run_id> -e WORKER_EXIT_WHEN_RUN_DONE=true --entrypoint node -- dist/apps/api/src/worker-main.js`
   - It has no services and no public port, and is not restarted.
   - It verifies its role, claims only that run's steps, exits when the run ends, and the machine is removed (`--rm`).
   - `DISCOVERY_ENABLED` and `ENGINE_LOOP_ENABLED` are not set; there is no AI key and no AI call.
9. **Watch** `fly logs` and the Control Room. Hard stop: if the run is not finished in **30 minutes**, or anything unexpected appears, I stop and remove the machine (`fly machine stop`, then `destroy`) and report. I do not retry without asking.
10. **Confirm the worker is gone:** `fly machine list` shows only the API machine.

### After the run (part of A26; read-only)

11. **Export the evidence:**
    - run and steps;
    - the snapshot (commit, tree, manifest hash, the counts of stored and `excluded_by_policy` rows, proving `client/` was excluded);
    - the protocol model hash;
    - hypotheses with spans;
    - evaluations;
    - the dossier hash.

    Written to `eval/production-cycle-1/run-<date>/`.
12. **Score against the frozen key** into a **new** file, `eval/production-cycle-1/results-<date>.md`. It reports:
    - expected-entry detection (with accepted keys);
    - out-of-scope levels;
    - the pre-listed adjudication keys;
    - unkeyed hypotheses, each judged by hand with a reason;
    - infrastructure findings;
    - challenge outcomes.

    It is headed "exposure-qualified evaluation: operational test, not a detection measurement". The answer-key hash is checked unchanged before and after. Confirmed stays 0.
13. **Show you the dashboard.** It should show:
    - 1 sealed snapshot;
    - 1 stored protocol model;
    - N hypotheses;
    - N evaluations;
    - 0 confirmed.

## What this does not authorise

- Migrations 0008 or 0011, or any migration.
- An app release or deploy; any change to the API machine, its image or its `DATABASE_URL`.
- A permanent or scheduled worker; a second run.
- AI calls; active testing; contacting anyone.
- Changing the answer key; human adjudication.

## Risks and how they are contained

| Risk | Containment |
|---|---|
| The worker writes or destroys evidence it should not | R1 role: no DELETE, TRUNCATE or TRIGGER, no ownership; immutability triggers it cannot disable; tested (section 4 of `r1-runtime-role.md`) |
| The worker picks up other work | `WORKER_ONLY_RUN_ID`; the pre-run gate requires an empty queue; `create-run-main` refuses to create a run when one is pending |
| A different run than approved | `create-run-main` refuses unless the input hash equals the approved one |
| GitHub rate limit (60/h per IP, unauthenticated) | about 4 calls are needed; the gate checks the quota; a failed acquisition is recorded as failed and retried within the attempt limit; nothing partial is sealed |
| Acquisition or analysis too slow or too large | limits were checked in the pre-check (252 KB stored, 102 Solidity files); 30-minute hard stop |
| Owner credential exposure | the owner URL is used only by the grants step (steps 3–4), inside Fly, never printed; the worker machine connects with `WORKER_DATABASE_URL` |
| Rollback | stop and remove the worker; delete `agentsmith_worker` and the secret. Evidence rows are immutable by design, so the cycle's records remain as an honest record of what ran |

**Cost:** one shared-cpu machine for minutes (well under US$0.01), plus a few one-off machines for seconds. No AI spend.
