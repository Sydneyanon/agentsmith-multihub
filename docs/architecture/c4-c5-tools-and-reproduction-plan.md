# C4 and C5 implementation plan: an isolated tools environment and independent reproduction

**Status: PLAN ONLY.** Written 2026-11-28 against commit `b8317cc`. **Nothing in this document was installed, downloaded, built
or executed.** No code, schema, migration, secret, image, Fly app or deployment was changed. No network call was made to any API.
The held-out corpora (`eval/heldout*`, `eval/benchmark-b`, `eval/heldout5`) were not opened.

- **C4:** an isolated tools environment with pinned solc versions, **real** Slither and **real** Foundry.
- **C5:** automated reproduction tests that independently test suspected vulnerabilities.

**Real Foundry has never run in this environment.** Every Foundry result in this repository's tests comes from a shell script
that prints canned JSON (`engine/tools/testing/fake-tools.ts: fakeTools().forge`). That is a **stand-in**. Nothing in this plan is
demonstrated until a checksum-verified forge binary has compiled and executed a test against a real contract. **A stand-in does
not count**, anywhere in this document.

**Status words** (as in `docs/architecture/integrated-research-architecture.md`): *designed*, *implemented*, *tested*,
*integrated*, *released*, *deployed*, *operationally verified*. Everything proposed here is *designed* at most.

**Evidence.** Claims about existing code were checked in the source at `b8317cc` and are cited as `file: symbol`.

---

## Summary

1. **What exists is a runner and a round, not a tools environment.** `runForgeTest` and `runSlither` build fixed arguments, a
   private directory and a minimal environment. They are *implemented* and *tested with stand-ins*. The module that starts
   processes (`tool-host/`) is excluded from the production build, so in production every tool run fails as `tool_unavailable`.
2. **Five things do not exist:** a tools image; an isolated place to run it; an automated test author; a path for a Foundry
   result to enter the records under option D; and any use of the C3 dependency snapshots by Foundry.
3. **Recommended shape:** a **separate tools image** on a **separate Fly app** (`agentsmith-tools`), one machine per run,
   destroyed afterwards, holding one run-scoped token and nothing else. Inside the machine, a **broker** process talks to the
   API; the **tool** process has no network, no token and a different user. The local equivalent is the same image in a container
   with `--network none`.
4. **Independence rests on the oracle, not on the test author's name.** The test is written by a deterministic template author
   in the API. It asserts a **fixed, preregistered oracle per vulnerability class** (attacker profit or invariant violation)
   against the **actual compiled contract**, with a **control run**. The generator supplies only *where* to look, never *what
   counts as success*.
5. **The honest limit:** under option D the result is **worker-reported**. The API can verify every input and output digest and
   derive the verdict from the raw output itself. It cannot verify that the execution happened. That limit is stated on the
   evidence.
6. **Two existing rules must change by decision, not silently:** the current mapping never emits `contradicts` from Foundry, and
   the worker API refuses every worker-recorded evaluation. Both are owner decisions (approvals 9 and 10 below).
7. **Almost every step past local code needs explicit owner approval:** downloading binaries, building an image, creating a Fly
   app, starting a machine, any outbound host, any migration. The approvals list is in Part 8.

---

## Part 1. Audit: what exists today, real versus stand-in

### 1.1 Component by component

| component | where | what it really does | status | real or stand-in |
|---|---|---|---|---|
| Tool runner | `engine/tools/run-tool.ts: materialise, runFixed, toolVersion, inputManifestSha256` | writes the sealed files into a fresh private directory (refuses absolute paths and `..`; `flag: "wx"`), calls a registered host with fixed arguments, deletes the directory | implemented, tested | real code |
| Process host | `engine/tools/tool-host/exec.ts: execFixed`, `register.ts` | `execFile` with environment `PATH`, `HOME`, `LANG` only; `SIGKILL` on timeout; 32 MiB output buffer | implemented; **excluded from the production build** (`tsconfig.build.json` excludes `**/tool-host/**`) | real code, absent from the image |
| Slither runner | `engine/tools/slither.ts: runSlither, SLITHER_ARGS, parseSlitherJson, recordSlitherLeads` | requires version `0.11.3`; passes solc explicitly; one run per directory; accepts remappings only in a safe shape (`SAFE_REMAPPING`) | implemented, tested, integrated as optional step `slither_scan`, off by default | runner real; **tests use a stand-in that replays one recorded real output**; the real-binary test is skipped unless installed |
| Foundry runner | `engine/tools/foundry.ts: runForgeTest, FORGE_ARGS, parseForgeJson` | requires version `1.5.1`; generates its own `foundry.toml`; drops the repository's root `foundry.toml`; `forge test --offline --json --match-test`; tests must be `test/*.sol` and may not overwrite a snapshot file | implemented, tested | runner real; **tested only with the stand-in** |
| Reproduction round | `engine/reproduction.ts: appendReproductionIn, importTest, processFoundryValidateStep` | appends `specialist_reproduce` then `foundry_validate` to the claims' run; each test runs twice; fixed outcome mapping | implemented, tested on throwaway databases with drafts applied | **stand-in only** |
| Test author | `capabilities.ts`: `claude-reproducer` (`kind: "test_author"`) | an attended Claude Code session run by a named operator | implemented | real, but **attended**; **no automated author exists** |
| Stand-ins | `engine/tools/testing/fake-tools.ts` | shell scripts: `slither` prints a recorded output; `solc` prints a version string; `forge` prints one canned result | test-only (excluded from the build) | **stand-in** |
| Availability | `capabilities.ts: availability` | a capability is "available" when its environment variables are **set** (`AGENTSMITH_FORGE_BIN`, `AGENTSMITH_SOLC_BIN`, `AGENTSMITH_SLITHER_BIN`) | implemented; live in `/v1/engine/components` as a declaration | **not a probe**: it does not run or checksum the binary |
| Option-D worker | `worker-api.ts`, `worker-remote.ts`, migration 0015 | a worker with no database credential and one run-scoped token, served by a fixed list of operations | implemented, tested locally; per the inventory, the listener is off in production and no worker runs | real code, not deployed as a running worker |
| Worker app | `fly.worker.toml`, `docs/security/worker-app-deployment.md` | a separate Fly app `agentsmith-worker` using the **same release image** as the hub | **prepared only; nothing created** | design |
| Dependency manifest | `acquisition/dependencies.ts` (`agentsmith-dependency-manifest/1`), `dependency-step.ts` | submodules sealed at pinned commits; declared remappings resolved; `usableRemappings` | implemented, tested, integrated in development; off by default | real code; **no real compiler has used it** |

### 1.2 Gaps found in the code (each verified)

| # | gap | evidence | consequence |
|---|---|---|---|
| A1 | The version check trusts a string | `toolVersion` takes the first `x.y.z` token of `--version` output | a stand-in passes it. "Pinned" today means "prints the right number" |
| A2 | No binary checksum anywhere | no hash of a tool binary is computed or recorded | the evidence cannot say which binary ran |
| A3 | Foundry gets no dependencies and no remappings | generated toml: `src = "."`, `libs = ["lib"]`, no `remappings`; `processFoundryValidateStep` reads only the parent snapshot's `.sol` files | any project with a submodule import fails to compile |
| A4 | The generated `foundry.toml` does not state the safety settings | it sets `src`, `test`, `libs`, `offline`, `solc` only | `ffi`, `fs_permissions` and the rest rely on Foundry defaults |
| A5 | Limits are a timeout and an output buffer only | `execFixed`: `timeout`, `maxBuffer` | no CPU, memory, disk or process-count limit |
| A6 | A timeout kills one process | `killSignal: "SIGKILL"` on the direct child; no process group | a `solc` started by `forge` can outlive it |
| A7 | One solc for everything | `AGENTSMITH_SOLC_BIN` is a single path | no selection by pragma; a `0.7` project cannot be compiled |
| A8 | The round needs draft tables | `reproduceInputSchema.decisionId` is required; `INSERT INTO research_effort` | it cannot run on the production schema (0009 and 0010 are drafts) |
| A9 | The round needs direct database access | `processFoundryValidateStep` uses `ctx.pool` | it cannot run in an option-D worker |
| A10 | Option D has no place for a Foundry result | `RESEARCH_STEP_KEYS` has no reproduction step; `record_evaluation` always answers 403 `evaluations_are_api_derived` | a new, deliberately narrow operation is required |
| A11 | One reproduction round per run | `reproductionRoundUsed`; one step per key per run (0001) | a later claim is deferred |
| A12 | Large raw output is dropped | the blob is stored only when ≤ 1 MiB (the 0007 limit) | above that, only a digest survives |
| A13 | Foundry never emits `contradicts` | mapping in `reproduction.ts`: `supports`, `weakens`, `inconclusive` only | "the fixed twin is contradicted" is not expressible today |
| A14 | The worker app reuses the hub image | `fly.worker.toml` `[build]` comment | that image has no binaries and no tool host; it cannot run tools |

### 1.3 What can be kept

The runner's shape is right and should be kept: fixed arguments, a fresh directory per run, a minimal environment, explicit
failure codes (`tool_unavailable`, `version_mismatch`, `compile_failed`, `timeout`, `output_invalid`, `crashed`,
`input_invalid`), the twice-run rule, "a failing test is not a refutation", and the refusal of a test author that produced the
claim. C4 and C5 extend these; they do not replace them.

---

## Part 2. C4: the isolated tools environment

### 2.1 Where it runs

| option | isolation | credentials present | verdict |
|---|---|---|---|
| In the API (`agentsmith-hub`) | none: same machine as `DATABASE_URL`, `API_BEARER_TOKEN`, `GITHUB_TOKEN` | all of them | **Refuse.** It is why `tool-host/` is excluded from the build |
| In the option-D worker app (`agentsmith-worker`) with a tools image | a separate app; one run token | the run token; that app also needs GitHub egress for archive download | Possible, but it joins "downloads untrusted archives from the internet" and "executes untrusted code" in one place |
| **A separate Fly app `agentsmith-tools`, separate tools image** | a separate app and image; one machine per run; no GitHub egress needed | one run-scoped token | **Recommended** |
| A container or namespace inside another machine | weaker than a separate VM; shares that machine's secrets unless carefully stripped | depends | Use **inside** the tools machine as a second layer, not as the boundary |

**Why a separate app** (the same reasoning as `fly.worker.toml`): every machine of a Fly app receives all of that app's secrets.
A tools machine must hold no database credential and no operator secret, so it cannot share an app with anything that does.

**Two layers:**
1. **The machine is the boundary.** One Fly machine per run (or per reproduction batch), started with `--restart no`, destroyed
   afterwards. Nothing persists between runs: no volume is attached.
2. **Inside the machine, two processes with different users:**
   - the **broker**: the existing remote worker (`worker-remote.ts`). It holds the run token (read from a file and unlinked, D6),
     speaks only to the API's private listener, fetches inputs and reports results. It executes no project code.
   - the **tool process**: `forge`, `solc`, `slither`, started by the broker through the tool host as an unprivileged user, in
     its own network namespace with no interfaces, with a read-only root and a fresh writable workspace. It has no token: the
     tool host already passes only `PATH`, `HOME` and `LANG`.

**Unverified, and to be checked in the approved smoke test:** whether an unprivileged network namespace (`unshare --net`,
bubblewrap or nsjail) can be created inside a Fly machine, and whether Fly offers an app-level egress restriction. The plan does
not depend on either alone: see 2.4.

**Local-development equivalent.** The same tools image, run as a container:
`--network none --read-only --cap-drop ALL --security-opt no-new-privileges --user <non-root> --pids-limit --memory --cpus
--tmpfs <workspace>`, with the inputs mounted read-only and one output directory. The broker runs outside the container and
talks to a local API. Whether this development environment has a container runtime was not checked; installing one would itself
need approval.

### 2.2 No database credentials in the tools process

| mechanism | status |
|---|---|
| The tools app has no `DATABASE_URL`, no `WORKER_DATABASE_URL`; it uses `WORKER_STORE=api` | designed (mirrors `fly.worker.toml`) |
| The broker refuses to start if `WORKER_API_TOKEN` is in its environment, or if any environment value equals the token | implemented, tested (`worker-remote.test.ts`, per `worker-app-deployment.md`) |
| The tool process environment is `PATH`, `HOME`, `LANG` | implemented (`exec.ts`) |
| The tool process runs as a different user from the broker, so it cannot read the broker's `/proc/<pid>/environ` or memory | designed |
| **Smoke test before any real run:** a canary test contract that tries to read the environment and well-known secret paths through every cheatcode available, and must fail | designed |

### 2.3 No production credentials

- The only secret is one run-scoped, short-lived, revocable worker token (0015 `worker_capability_tokens`). It can append to one
  run and nothing else.
- No `GITHUB_TOKEN`, no `API_BEARER_TOKEN`, no model API key, no RPC key. The image contains none; the app has none.
- The dummy-secret check already designed for the worker app (W2 in `worker-app-deployment.md`) applies unchanged and must pass
  for this app too, because how Fly exposes a file secret to the machine environment is still **unverified**.
- The token is revoked and the machine destroyed after the run (W6).

### 2.4 No uncontrolled network access

Four independent controls, so that no single one is trusted:

| layer | control |
|---|---|
| Tool arguments | `forge test --offline` (existing); `offline = true` in the generated config (existing). **No fork RPC, ever:** no `--fork-url`, no `eth_rpc_url`, no `[rpc_endpoints]`, no `[etherscan]` in the generated config. Slither is given `--solc` explicitly, so it never downloads a compiler (existing) |
| Compiler provisioning | every solc is baked into the image. No `svm`, no `solc-select` download at run time. A missing version is an explicit `unsupported_compiler_version`, never a download |
| Process | the tool process has a network namespace with no interfaces (or, if that proves unavailable on Fly, firewall rules installed by the machine's init before privileges are dropped) |
| Machine | the app exposes no service; its only intended destination is the API's private listener. An app-level egress restriction, if Fly offers one, is added. **Unverified.** |

**The canary proves it:** the smoke test includes a test that attempts an outbound connection and a DNS lookup by every route
Foundry allows, and must fail.

**How dependencies arrive: from the C3 sealed dependency snapshots only.** The broker fetches them through the existing worker
API operations (`dependency_context`, `dependency_solidity_files`), each file checked against its recorded hash. Nothing is
cloned, installed or fetched by the tools machine. `forge install`, `npm install`, `git submodule update` and `soldeer` are never
run. A dependency that C3 did not acquire is a limitation in the manifest and becomes the outcome `missing_dependency`.

### 2.5 Pinned compiler and tool versions

**Exact versions** (those the code already pins, plus what must be chosen at build time):

| tool | version | source of the pin |
|---|---|---|
| forge (Foundry) | `1.5.1` | `capabilities.ts: FOUNDRY_VERSION` |
| Slither | `0.11.3` | `capabilities.ts: SLITHER_VERSION` |
| crytic-compile and every Python dependency of Slither | **to be fixed at lock time** | a hash-pinned lock file (`pip install --require-hashes`), committed |
| Python | one exact patch version | the base image digest |
| solc | a small explicit set, starting with `0.8.28` (the version the recorded Slither run and the dev-probe example config used); each further version added by a reviewed change when a target needs it | a committed list |
| base image | pinned by digest, not by tag | the tools Dockerfile |

**No checksum is written in this document, because nothing was downloaded.** Recording them is step 2 of the sequence.

**Checksum verification.**
- A committed **tool lock** (`tools/tools.lock.json`, proposed) lists, per binary: name, version, the upstream URL, size, and
  SHA-256. For solc the upstream release list publishes a SHA-256 per build; the lock records it and where it was read.
- The image build verifies each download against the lock and fails otherwise. Nothing is "latest".
- **At run time the broker re-hashes each binary before use** and refuses on mismatch (`tool_checksum_mismatch`). This closes gap
  A1/A2: the version string is still checked, but it is no longer the evidence.
- The image digest is recorded with the release, as the hub image's is.

**Selecting solc per project pragma.**
1. The API (not the tools machine) collects every `pragma solidity` in the compilation unit: the in-scope sources, the
   dependency sources they import, and the generated test files.
2. It intersects the ranges and picks the **highest pinned version that satisfies all of them**.
3. If the repository's `foundry.toml` or Hardhat config names a compiler version, that is recorded as a **declared hint** and
   used when it is in the pinned set and satisfies the pragmas. The repository's config file itself is never given to a tool.
4. No pinned version satisfies → `unsupported_compiler_version`. Files that cannot share one version →
   `mixed_compiler_versions`. Both are explicit abstentions. Multi-compiler builds are out of scope for the first increment.
5. **Compiler settings change the bytecode.** `optimizer`, `optimizer_runs`, `evm_version` and `via_ir` are read from the
   repository's config **as data, through an allow-list of keys**, and written into the generated config. They are recorded in
   the tool manifest. If they cannot be read, defaults are used and the manifest says so.

**The claim this supports** is "the sealed source, compiled with the recorded compiler and settings". It is **not** "the
deployed bytecode": no on-chain comparison is made, and none is possible offline.

**The tool manifest**, recorded in the evidence of every run (schema proposed: `agentsmith-tool-manifest/1`):

```
image_digest
tools[]        { name, version_reported, binary_sha256, lock_entry }
solc           { version, binary_sha256, selected_by: "pragma-intersection" | "declared-hint", pragmas[] }
compiler_settings { optimizer, optimizer_runs, evm_version, via_ir, source: "repository-config" | "default" }
config_sha256  (the generated foundry.toml)
args[]         (the exact argument list)
limits         { cpu_ms, wall_ms, memory_mb, disk_mb, pids, output_bytes }
helper_sha256  (the vendored test helper, 3.3)
```

### 2.6 Reproducible dependency installation

There is no installation step at run time. "Installation" is materialisation of sealed bytes:

- The workspace is built from: the parent snapshot's files; each **acquired** dependency's files at the path the manifest
  records; the generated config; the generated tests; one vendored helper file.
- Remappings are exactly `usableRemappings(manifest)`: only those whose target is present. Each is checked again
  (`SAFE_REMAPPING`, already used for Slither) and its target must resolve **inside the workspace**.
- The whole workspace has one digest (`inputManifestSha256` over every path and content hash). Two runs with the same digest,
  the same tool manifest and the same tests are the same experiment.
- Packages under `node_modules` are not fetched by C3 (`pinned_not_acquired`). A project that needs one is `missing_dependency`
  until package acquisition is separately approved (`db/drafts/c3-dependency-records`).

**The image itself** is reproducible to the extent that every input is pinned by hash (base digest, tool lock, Python lock). A
bit-for-bit identical rebuild is not promised; the image **digest** is what is recorded.

### 2.7 Resource limits

Proposed starting values; each is a configuration value recorded in the tool manifest. They extend, not replace, the existing
timeout.

| resource | limit | mechanism |
|---|---|---|
| CPU | 2 shared vCPU for the machine; a CPU-time cap per tool invocation | machine size; cgroup `cpu.max` or `ulimit -t`, polled as `bounded-compute.ts` already does for the API's child |
| Memory | 4 GB machine; 3 GB per tool invocation | cgroup `memory.max`; an out-of-memory kill is reported as `memory_limit` |
| Disk | workspace on a size-capped tmpfs or quota (1 GB); read-only root | mount options |
| Processes | 256 per invocation | cgroup `pids.max` or `ulimit -u` |
| Output | 8 MiB of stdout per invocation (today 32 MiB); the stored raw-output blob stays within the 1 MiB store limit, larger output is truncated **with the truncation and the full digest recorded** | `maxBuffer`; an overflow is `output_too_large` |
| Open files, file size | conservative `ulimit -n`, `ulimit -f` | process limits |
| EVM execution | `gas_limit`, `memory_limit` and fuzz runs fixed in the generated config; templates use no fuzzing in the first increment | generated config |
| Per run | at most 10 reproductions per decision (existing `MAX_REPRODUCTIONS_PER_DECISION`); a wall-clock ceiling for the machine | existing constant; machine auto-stop |

The API-side quotas of option D (D4: bytes, blobs, processing time per token) continue to apply to everything the broker sends.

### 2.8 Timeouts and cancellation

| event | behaviour |
|---|---|
| Tool wall time (default 600 s per forge invocation, existing) | kill the **whole process group or cgroup**, not one process (fixes A6); outcome `timeout` |
| Compile and test are timed separately | so a slow compile is `compile_timeout`, not confused with a hanging test |
| Lease lost | the broker stops; nothing further is written (existing lease rule) |
| Run cancelled or token revoked | the broker exits (existing codes 78 and 77) and kills the tool cgroup first |
| Machine wall-clock ceiling | the machine stops itself; the step's lease expires; the API marks the step failed, retryable |
| Any of the above | recorded as an explicit outcome with its code. **A timeout is never a pass and never a refutation** |

### 2.9 Artifact and source provenance

| digest | what it covers | who computes it | who can verify it |
|---|---|---|---|
| snapshot `manifest_sha256` | the sealed parent sources | the API at sealing (and against GitHub, D2) | the API |
| `dependency_manifest_digest` | parent identity, every dependency's source, pin, tree and file-manifest hashes, remappings, limitations | the API | the API |
| `shared_model_sha256` | the protocol model the template author read | the API | the API |
| test digest | every generated test file | the API (it authors them) | the API |
| config digest | the generated `foundry.toml` | the API | the API |
| **input digest** | all of the above combined: the experiment's identity, and the `input_sha256` of the evaluation | the API | the API; the tools machine must echo it |
| tool manifest | image, binaries, compiler, settings, limits | the tools machine | **only against the committed tool lock**; the API cannot see the machine |
| raw output digest | forge's JSON output (workspace path normalised, as today) | the tools machine | the API re-hashes the bytes it receives |
| artifact digests | compiled bytecode hash per contract under test | the tools machine | not independently, in the first increment |

**Input digest = sealed snapshot + dependency manifest**, plus the tests, the config and the model hash. The existing code
computes `sha256(manifest | tests | match | intent)`; C5 adds the dependency manifest digest, the config digest and the tool-lock
hash, so that a changed dependency or compiler is a different experiment.

### 2.10 Test isolation

- **A fresh workspace per hypothesis and per run** (`materialise` already makes a new temporary directory and always deletes it).
  The two identical runs of the twice-run rule each get their own.
- **Sources are read-only.** Sealed files are written once; in the tools machine the source tree is mounted or chmod-ed
  read-only and only `out/`, `cache/` and the private `HOME` are writable. After the run the broker **re-hashes the source tree**
  and reports `sources_modified` if anything changed.
- **No state shared between hypotheses:** no shared `cache/`, `out/`, `HOME` or `~/.foundry`. The cost is a recompile per
  hypothesis; it is accepted.
- **No state shared between runs:** the machine is destroyed.
- **Tests cannot collide with sources:** the existing check refuses a test path that equals a snapshot path.

---

## Part 3. C5: independent reproduction

### 3.1 Evaluator identity

- **The evaluator identity already exists.** `foundry-forge` is in `analysis-identity.ts: ANALYSIS_IDENTITIES` and in the 0016
  seed as role `evaluator`, family `evm-execution`, method `compiled-test-execution`. 0016 is applied. **For Foundry as the
  evaluator, no migration and no data change is needed.**
- **It is distinct from every generator family today:** `agentsmith-solidity-parser` (specialists), `slither-ir`, `claude-model`.
  A Foundry `supports` on any of their leads is `cross_family` in `evaluation_independence`.
- **Adding any further identity is a migration, even though it is only data.** `analysis_identities` is append-only and the
  runtime role has `SELECT` only (`db/runtime-grants.json`). An applied migration cannot be edited: `scripts/migrate.ts` refuses a
  changed checksum. So a new row means a **new migration file** containing an `INSERT`, a matching entry in
  `analysis-identity.ts`, and the unit test that keeps them equal. That needs approval. It applies to Echidna, to APEX as an
  evaluator, and to Slither if it were ever registered separately for the tools machine.
- **The test author cannot be registered today.** The `role` check allows `generator`, `evaluator` and `abstention` only. Two
  choices:
  - **(a) code only, recommended first:** record the author's identity, version and family in the test artifact and in the
    evaluation's stored output, and enforce the author rules of 3.3 in code. No migration.
  - **(b) later:** a migration widening the `role` check to add `test_author` and seeding the row, so the database can enforce
    "author family ≠ generator family". Needs approval.

### 3.2 Who writes the test

**A deterministic template author**, identity `reproduction-template-author` with a version, running **in the API** (bounded
child, no execution of project code), keyed by vulnerability class and the shared model.

| input | from | what it may be used for |
|---|---|---|
| the lead's anchor: file, contract, function, class | the hypothesis and its lead key | **where** to aim |
| function signature, visibility, payability | shared model `functions` | how to call it |
| guards and roles | shared model `actors_permissions` | which caller to use for the attack and for the control |
| state roles and writers | shared model `state` | which balance or variable the oracle reads |
| unsupported features, unresolved questions | shared model | whether to abstain before writing anything |
| the generator's claim text and rationale | — | **never read** |

Because the test is authored in the API from sealed inputs, its bytes are **API-derived**: the tools machine receives them with
their digest and cannot substitute others without the mismatch showing.

**Classes in the first increment:** only those where a fixed oracle is clear and a fixture with an exploitable twin exists:
reentrancy (ether), access control (privileged state change by an unprivileged caller), initializer (re-initialisation changes
ownership). Unchecked call, delegatecall, selfdestruct and tx-origin follow one at a time. Every other class is
`unsupported_by_model` from the first day.

### 3.3 Reproduction without self-validation: the honest problem and the rule

**The problem.** The existing rule refuses a test author whose id equals a claim's generator id. That is necessary and not
sufficient. A deterministic template author:

- is written by the same people as the specialists, with the same understanding of each class;
- reads the shared model, which is built by the **parser family** (`agentsmith-solidity-parser`), the same substrate as the
  structural specialists and the validators;
- is aimed by the lead's anchor, which the generator chose.

So if the parser misreads a guard, the specialist may raise a wrong lead **and** the template may build a test that encodes the
same misreading. A test that passes for the wrong reason would then look like cross-family confirmation. Calling the author a
"separate identity" does not remove this. The independence that is real comes from somewhere else: **solc and the EVM do not
share the parser's errors.** The design must make the verdict depend on what the EVM did, and on nothing the generator or the
model asserted.

**The proposed rule (seven parts).**

1. **The oracle is fixed per class and preregistered.** Each class has one oracle, written once, versioned and stored by hash
   before any scoring: for example *attacker profit* (the attacker's balance after the sequence exceeds its balance before, by
   more than it legitimately held) or *invariant violation* (a stated relation over the contract's own state is false after the
   sequence). The template may vary **how to reach** the function; it may never vary **what counts as success**.
2. **The oracle observes the actual compiled contract.** The contract under test is compiled from the sealed source by the
   pinned solc. No mock of it, no modified copy, no re-implementation. The oracle reads **EVM-observable state**: balances,
   return values, storage through the contract's own getters. It never asserts on anything derived from the parser.
3. **No cheatcode may fabricate the effect.** Templates may use `deal` to fund actors and `prank` to choose a caller. They may
   **not** write the target's storage (`store`), replace its code (`etch`), mock its calls (`mockCall`), or warp state the oracle
   reads. This is enforced by a static allow-list check on the generated test before it is sent.
4. **A control run accompanies every attack run.** The same harness, the same setup, the same oracle, with the attack step
   replaced by the honest use of the function (or the attacker replaced by a non-reentrant caller). The control establishes two
   things: the harness deploys and exercises the contract at all, and the oracle is **not** satisfied without the attack. An
   oracle that fires in the control is `inconclusive` (`oracle_fires_in_control`), never `supports`.
5. **The author abstains rather than guesses.** If the model marks the function's region as unsupported, the actor set is
   unknown, or the constructor needs arguments the model cannot supply, no test is written and the outcome is
   `unsupported_by_model` with the feature and location.
6. **The author's inputs are recorded:** the model hash, the sections read, the template and oracle versions, and the analysis
   family of the model builder. The evidence states plainly: *"test authored from a parser-family model; the verdict rests on
   EVM-observed state."*
7. **The generator never touches the test.** Not the author, not the oracle, not the expected values. A model-written test may
   never evaluate a claim generated by the same model family (the extension already stated in Part 4.6 of the inventory).

**What still is not covered, said plainly.**
- A template can be wrong in a way that makes a real vulnerability *fail* to reproduce. That costs recall, and is why a failed
  attack is not automatically a contradiction (3.4).
- The anchor comes from the generator. If the generator points at the wrong function, the test examines the wrong function. The
  verdict is then about that function, and says so.
- Templates developed on the dev corpus are fitted to it. Results on the dev corpus demonstrate mechanism; they are **not** a
  measurement of capability.
- Supports means "the oracle fired on the sealed source under the recorded compiler in a local EVM". It does **not** mean the
  deployed contract is exploitable.

### 3.4 Outcome mapping

The four system outcomes mapped onto the existing `hypothesis_evaluations` outcomes (`supports`, `weakens`, `contradicts`,
`inconclusive`). No new outcome value is introduced.

| system outcome | condition | stored as | note |
|---|---|---|---|
| **supported** | both identical runs: compile succeeded; control ran and the oracle did **not** fire in it; attack ran and the oracle **fired** | `supports` by `foundry-forge` | as today, plus the control |
| **contradicted** | both identical runs: compile succeeded; control ran and passed (the harness demonstrably works on this contract); the attack sequence **executed to its end or was rejected by the contract itself**; the oracle did **not** fire. **And** the template is registered as *complete for this class* | `contradicts` by `foundry-forge` | **a change to today's rule**, see below |
| *(weaker form)* | as above, but the template is not registered as complete for the class | `weakens` | today's behaviour for a passing refutation test |
| **inconclusive** | anything else: compile failure, missing dependency, timeout, resource limit, non-deterministic runs, harness failure, oracle firing in the control, output invalid, checksum mismatch | `inconclusive` with a failure code | never a pass, never a refutation |
| **unsupported-by-model** | the author abstained before any execution | `inconclusive` with rationale prefix `abstained:<feature>@<file:line>` and a structured blob (option A of the inventory, Part 4.5) | a dedicated column would be a migration |

**The `contradicts` decision.** `reproduction.ts` states: a refutation test passing gives `weakens`, "one test cannot prove
impossibility, so never contradicts". That reasoning is sound for an arbitrary test. This plan proposes a narrow exception: when
a **preregistered, class-complete** template ran the class's canonical attack against the actual contract, the control proved
the harness works, and the contract's own behaviour stopped the effect, the specific claimed mechanism was tested and failed.
That is `contradicts` *for this mechanism*. It is not proof that the contract is safe, and the rationale must say so. `contradicts`
dominates in `hypothesis_status`, so this is consequential and is **an explicit owner decision** (approval 9). If it is declined,
the fixed twin is recorded as `weakens`, and the demonstration's second criterion is reworded accordingly.

**A constraint from 0007:** every outcome other than `inconclusive` must cite at least one evidence span
(`evaluations_require_evidence`). `supports` and `contradicts` cite the lead's primary span, as the existing code does.

**`refuted` and `confirmed` stay human.** No evaluation here is a label. `confirmed` needs a human outcome (draft 0009) resting
on a cross-family `supports`.

### 3.5 Failure and abstention reporting

Every one of these is an explicit, coded outcome stored on the evaluation. None is a pass.

| code | meaning | stage | new? |
|---|---|---|---|
| `tool_unavailable` | no tool host, or the binary is absent | before execution | existing |
| `tool_checksum_mismatch` | the binary's hash differs from the tool lock | before execution | new |
| `version_mismatch` | the binary reports another version | before execution | existing |
| `unsupported_by_model` | the template author abstained (feature and location given) | authoring | new |
| `unsupported_class` | no template exists for the class | authoring | new |
| `unsupported_compiler_version` / `mixed_compiler_versions` | no pinned solc satisfies the pragmas | planning | new |
| `missing_dependency` | an import resolves to a dependency C3 did not acquire, or a remapping target is absent | planning | new (Slither already has `dependency_unavailable`) |
| `compile_failed` | solc rejected the project or the test | compile | existing |
| `unsupported_feature` | the project needs something disabled by policy: `ffi`, file access, a fork, a build script | compile or run | new |
| `harness_failed` | setup or the control did not run | run | new |
| `oracle_fires_in_control` | the oracle is satisfied without the attack | run | new |
| `timeout` / `compile_timeout` | a wall-time limit was hit | compile or run | existing / new |
| `memory_limit`, `cpu_limit`, `output_too_large` | a resource limit was hit | run | new for tools (the API's bounded child already has them) |
| `non_deterministic` | two identical runs disagree | run | existing |
| `sources_modified` | the source tree changed during the run | after run | new |
| `output_invalid` / `crashed` | no parsable result | run | existing |

**Coverage must say the same thing.** A reproduction that ended in any of these is "not examined" for that lead, with the code.
A run in which every reproduction abstained is reported as "completed; nothing reproduced", never as a clean result.

### 3.6 Evidence storage and validation

**Flow under option D** (a new operation is required; see gaps A9, A10):

1. The API authors the tests, computes the input digest and stores the tests as blobs.
2. The broker leases the reproduction step and fetches: sources, dependency sources, config, tests, the expected input digest.
3. The tools machine materialises, verifies every hash, runs, and sends a **report**: the echoed input digest, the tool
   manifest, the raw forge output for each of the four executions (attack ×2, control ×2), the artifact digests, and the
   post-run source digest.
4. **The API derives the verdict itself** from the raw output (`parseForgeJson` and the mapping of 3.4). The tools machine sends
   no outcome field; if it sends one it is refused by the strict schema. The API records the evaluation as `foundry-forge`.

| the API can verify itself | the API must take on trust (worker-reported) |
|---|---|
| the input digest matches what it issued | that the binaries with those hashes actually ran |
| the tests named in the output are the tests it authored | that the raw output is the output of that execution |
| the report matches the strict schema; sizes within quota | the tool manifest's binary hashes and image digest |
| the tool manifest's hashes equal the committed tool lock | the artifact digests |
| the raw output parses, names every expected test, and the two runs agree | that the workspace was isolated as designed |
| the verdict, re-derived from the raw output | |

**Labelling.** The evaluation is shown as **worker-reported execution, API-derived verdict**. In the dossier, an evaluation with
no API provenance row is already rendered as `worker_reported` (`pipeline.ts`, the `recordedBy` mapping). `evaluation_provenance`
(0015) allows `recorded_by` values `api`, `direct-worker` and `trusted-runner` only; an honest value for this case needs either a
migration to that check, or no provenance row with the provenance held in the stored report blob. **Start with the blob.**

**This partly re-opens a closed risk, and that must be decided, not slipped in.** D1 exists because a compromised worker could
forge a validator's verdict (scenario S7a). A compromised tools machine can forge forge output. Mitigations, none complete:
- the verdict is derived by the API, so a forgery must be a consistent fake of four raw outputs for API-authored tests;
- an **execution canary**: each report includes a test whose expected value depends on a per-run random constant issued by the
  API and computed in the EVM. It catches a stand-in or a broken install; a determined attacker can compute it;
- optional **re-execution on a second, separately created machine**, with both reports required to agree, for any result a
  human is about to rely on;
- the result is never a label without a human outcome.

### 3.7 Security risks of running untrusted project code

`forge test` compiles and **executes** repository-supplied Solidity. Compiling is not code-free either.

| risk | how it happens | mitigation |
|---|---|---|
| `ffi` | a test or library calls `vm.ffi` to run a host command | `ffi = false` written explicitly in the generated config; no `FOUNDRY_*` variable reaches the tool; the canary test calls `vm.ffi` and must fail |
| File-system cheatcodes | `vm.readFile`, `vm.writeFile`, `vm.readDir`, `vm.envOr` | `fs_permissions = []` written explicitly; read-only root; no secrets on the file system or in the environment |
| The repository's own config | `foundry.toml` enabling `ffi`, RPC endpoints, extra `libs`, profiles | **the config is generated by us and never taken from the repository** (the runner already drops the root `foundry.toml`). Extend: drop every `foundry.toml`, `remappings.txt`, `.env`, `hardhat.config.*`, `package.json` scripts and `Makefile` from the workspace. Allowed settings are copied key by key |
| Environment overrides | `FOUNDRY_PROFILE`, `FOUNDRY_FFI`, `DAPP_*` | the tool environment is `PATH`, `HOME`, `LANG` only (existing) |
| Remappings escaping the workspace | `x=../../etc/` or an absolute target | only `usableRemappings`; `SAFE_REMAPPING`; resolved target must lie inside the workspace; `allow_paths` not set |
| Symlinks in the sources | a link pointing outside | sealed snapshots store file bytes, not links; `materialise` writes regular files only. To confirm in the smoke test |
| Malicious project tests and scripts | the repository's own `test/`, `script/`, `setUp` | only the generated tests are run (`--match-path` for the generated file as well as `--match-test`). The repository's `test/` and `script/` trees are left out of the workspace unless a source file imports from them. **`forge script` is never run** |
| Build scripts and hooks | `npm` lifecycle scripts, `Makefile`, git hooks | nothing is installed or built except by `forge` with the generated config; no `npm`, no `make`, no `git` in the tool process |
| Malicious contract code at run time | infinite loops, memory growth, deep recursion | gas and memory limits in the config; wall, CPU and memory limits; cgroup kill |
| Compiler bugs or exploits | a crafted source crashing or exploiting solc or the Python stack | the same isolation: no network, no token, unprivileged user, the machine destroyed after the run. This is the residual risk the VM boundary exists for |
| Output injection | forge output crafted to confuse the parser or the dashboard | strict JSON parsing; the verdict derived only from fields for the tests the API authored; output stored as bytes, rendered escaped |
| Path leakage | absolute paths in output | the workspace path is normalised out (existing) |
| Resource abuse against the API | huge reports | the per-token quotas of D4 |
| A compromised tools machine | forged results | 3.6; limited to appends in its own run |
| Supply chain of the tools themselves | a tampered forge, solc or Python package | the tool lock with SHA-256 per binary; hash-pinned Python lock; base image by digest; run-time re-hash |

---

## Part 4. Step-by-step implementation sequence

**Dev-only** means: code and tests in a development branch, using stand-ins or pure functions, no download, no new host, no
production change. It still needs ordinary review. **Owner approval** means an explicit, separate approval before the step.

| # | step | what it produces | class |
|---|---|---|---|
| 1 | Write the tool lock **format** and the tool-manifest schema; add run-time re-hash to the runner (tested against the stand-ins' own hashes) | `tool_checksum_mismatch`; manifest in the evidence | dev-only |
| 2 | **Fill the tool lock:** read the upstream release checksums for forge 1.5.1, the chosen solc versions, Slither 0.11.3 and its Python dependencies | committed hashes | **owner approval**: outbound hosts (the release hosts) |
| 3 | Harden the generated config (`ffi = false`, `fs_permissions = []`, no RPC, gas and memory limits) and the workspace filter (drop every repository config and script) | closes A4 | dev-only |
| 4 | Give Foundry the C3 dependencies and `usableRemappings`, with the inside-workspace check | closes A3 | dev-only (stand-in); real compile only after step 9 |
| 5 | solc selection by pragma intersection (pure function) and the allow-listed settings reader | closes A7 | dev-only |
| 6 | Resource limits and process-group kill in the tool host | closes A5, A6 | dev-only |
| 7 | The oracle and template for the first class (reentrancy, ether), the static cheatcode allow-list, the control run, the abstention rules; **preregister the oracle by hash** | the deterministic test author | dev-only |
| 8 | The tools Dockerfile (base by digest, downloads verified against the lock, non-root user, tool-host build included) | a Dockerfile, not an image | dev-only to write; **owner approval to build** (downloads binaries) |
| 9 | **Build the tools image locally and run the real-binary smoke test:** checksum verification, the canary tests (no network, no `ffi`, no file access, no environment), a real compile of the dev fixture | **the first real Foundry execution in this project** | **owner approval**: download and install binaries; a container runtime if absent; outbound hosts |
| 10 | Run the demonstration (Part 5) locally in the container, `--network none` | the acceptance evidence | covered by the approval of step 9; no production change |
| 11 | The option-D operation for a reproduction report, its strict schema, quotas, and the adversarial tests (forged outcome field, wrong input digest, foreign test, oversized report) | closes A9, A10 | dev-only to implement; **owner approval of the D1 relaxation** before release |
| 12 | The reproduction step on the `repository_research` path without the draft tables (decision recorded in the step output for the first slice), with an ordinal step key | closes A8, A11 | dev-only; release needs the usual release approval |
| 13 | Decide the `contradicts` rule (3.4) and the test-author registration (3.1) | policy | **owner approval**; (b) of 3.1 is a **migration** |
| 14 | Publish the tools image to a registry | an image digest | **owner approval**: new image |
| 15 | Create the Fly app `agentsmith-tools` (no machines) | an app | **owner approval**: new Fly app |
| 16 | Dummy-secret check and network canary on one throwaway machine in that app | proof of what the machine can see and reach | **owner approval**: production test, a machine |
| 17 | Enable the API's private worker listener, if not already enabled for the worker app | — | **owner approval**: production change |
| 18 | Mint one run-scoped token; start one tools machine for one approved run; revoke and destroy afterwards | the first production reproduction | **owner approval** for each: secret, machine, the run itself |
| 19 | Any additional solc version, any new class template, any new evaluator identity | — | **owner approval** (a lock change; an identity is a **migration**) |

Steps 1 and 3–7 can be done before any approval and are worth doing regardless. Nothing from step 8's build onward happens
without one.

---

## Part 5. The demonstration, and its acceptance criteria

### 5.1 Definition

> A suspected vulnerability is **generated by one engine**. An **independent tool** constructs and executes a reproduction
> against the **actual fixture contract** with **REAL Foundry**. The system **records** supported, contradicted or inconclusive.

Concretely:
1. **Generation.** The structural specialists (family `agentsmith-solidity-parser`) analyse the sealed fixture snapshot and
   record reentrancy hypotheses, with lead keys, in the 0007 store. Slither may be a second generator if its real binary is in
   the image; it is not required.
2. **Authoring.** The deterministic template author, a different identity that never reads the claim text, writes the attack
   and control tests from the lead's anchor and the shared model.
3. **Execution.** forge `1.5.1`, **its SHA-256 equal to the tool lock**, compiles the **unmodified fixture source** with the
   selected pinned solc and runs each test twice, offline, in the isolated container.
4. **Recording.** The verdict is derived from the raw output and recorded as a `foundry-forge` evaluation
   (`evm-execution`, so `cross_family`), with the tool manifest and every digest of 2.9.

**Fixtures.** The dev corpus (`eval/dev/`), whose labels are known and which is development data, not held-out:
- vulnerable: one of the three reentrancy functions labelled `vulnerable: true, exploitable: true` in `Bank2.sol`
  (`cashOut`, `withdrawUnchecked`, `claimBonus`);
- fixed twin: `Bank.withdrawCei` or `Bank.withdrawLocked` (`vulnerable: false`);
- uncompilable: a copy of the fixture with a deliberate syntax error **and**, separately, one with an import that no
  dependency satisfies.

**A caution the labels themselves raise.** `Bank.withdrawBad` and `Bank.withdrawHelper` are labelled `vulnerable: true,
exploitable: false` ("checked 0.8 subtraction: not drainable"). Under an attacker-profit oracle they should **not** be
supported. They are a useful fourth case: the demonstration should show what the system records for them, and the expected
answer is "not supported", with the structural lead left standing as a pattern that did not yield an effect. This is the
consequence distinction of capability 7, and it must not be reported as a failure of reproduction.

### 5.2 Acceptance criteria

| # | criterion | passes when |
|---|---|---|
| 1 | **A known-vulnerable fixture is supported** | the evaluation is `supports`; attack oracle fired in both runs; control oracle did not fire in either |
| 2 | **Its fixed twin is contradicted** | the evaluation is `contradicts` (or `weakens`, if approval 9 is declined, with the criterion reworded before the run); control passed; the attack ran and the oracle did not fire, in both runs |
| 3 | **An uncompilable project is inconclusive, with a reason** | the evaluation is `inconclusive` with `compile_failed` for the syntax error and `missing_dependency` for the absent import; no test result is fabricated |
| 4 | **The self-validation refusal is intact** | an attempt to record an evaluation whose evaluator id equals the generator id is refused by the 0016 trigger and by `ResearchStore.recordEvaluation`; an attempt to use a claim's generator as test author is refused; a worker-submitted `record_evaluation` is still refused; the existing independence and adversarial suites pass unchanged |
| 5 | **The frozen corpora are unchanged** | `eval/verify-frozen.sh` passes before and after; `eval/LABELS.sha256` is unchanged; no file under `eval/heldout*`, `eval/benchmark-b` or `eval/heldout5` was read or written (the run's inputs are the dev fixtures only) |
| 6 | The tool is real | the recorded forge and solc SHA-256 values equal the tool lock; the execution canary returned the value for this run's random constant |
| 7 | The isolation held | the canary tests for network, `ffi`, file access and environment all failed as required; the post-run source digest equals the input |
| 8 | It is reproducible | a second complete run gives the same input digest, the same verdicts and the same raw-output digests (after path normalisation) |
| 9 | Provenance is complete | every evaluation carries the input digest, the tool manifest, the test digests, the model hash and the raw-output digest |

**A stand-in does not count.** A run in which `forge` is `fakeTools().forge`, or any binary whose hash is not in the tool lock,
fails criterion 6 and therefore the demonstration, whatever it prints. The stand-in tests remain useful for the flow and stay in
the suite; they demonstrate nothing about reproduction.

**What a passing demonstration does and does not show.** It shows the mechanism works end to end on three self-labelled,
single-contract fixtures that the template was developed against. It does **not** show capability on real protocols, and it is
not a held-out measurement. The first real target (with submodules, remappings and a constructor that needs arguments) will
very likely abstain in several places; those abstentions are the next thing to learn from.

---

## Part 6. Cost and infrastructure estimates

Estimates, not measurements. No price was looked up for this document; Fly prices should be read from the current price list
before approval.

| item | estimate | basis |
|---|---|---|
| Tools machine | 2 shared vCPU, 4 GB RAM, no volume | the inventory's planning figure |
| Time per reproduction | 1–5 minutes typical (cold compile plus four short executions); hard ceiling 600 s per forge invocation, so at most 40 minutes per hypothesis | existing timeout × 4 runs |
| Time per run | at most 10 reproductions per decision → typically 10–50 minutes; ceiling of a few hours | `MAX_REPRODUCTIONS_PER_DECISION` |
| Compute cost per run | **cents**, at per-second billing for a machine of this size; the exact figure to be confirmed | order of magnitude only |
| Idle cost | none: the machine is destroyed after the run and no volume exists | design |
| Tools image size | roughly 0.5–1.5 GB (forge, several solc builds at about 10–50 MB each, Python with Slither) | typical sizes; unverified |
| Image storage and build | registry storage for one image per tool-lock change; a build of a few minutes | — |
| Database storage | per reproduction: up to four raw-output blobs (each ≤ 1 MiB), test blobs (a few KB), one manifest. Counted against the per-token quotas | 0007 blob limit |
| AI spend | **US$0.** C4 and C5 call no model | the template author is deterministic |
| Engineering effort (rough) | steps 1, 3–7: one to two weeks; steps 8–10: several days, dominated by first-contact problems with real tools; steps 11–12: about a week including adversarial tests; each further class template: days | judgement, not a commitment |
| Operational effort | each production run needs a token minted, a machine started, and cleanup: by hand at first | `worker-app-deployment.md` W4–W6 |

**The cost that matters is not compute.** It is the per-class work of writing a template and an oracle that is honest, and the
human time to adjudicate outcomes.

---

## Part 7. What this plan could not establish

- **Whether real Foundry 1.5.1 behaves as the runner assumes** (JSON shape, `--offline` semantics, exit codes, default
  `fs_permissions`). The parser was written against a stand-in. Expect corrections at step 9.
- **Whether Slither 0.11.3 compiles a remapped project** with the C3 remappings. Never tried with a real binary.
- **Fly specifics:** whether an unprivileged network namespace works inside a machine; whether app-level egress can be
  restricted; how a file secret appears in the machine environment (already flagged as unverified in
  `worker-app-deployment.md`).
- **Whether a container runtime is available** in the development environment.
- **The exact dependency versions for Slither,** and every checksum: nothing was downloaded.
- **Whether dependency sources are served to a reproduction step** by the existing `dependency_solidity_files` operation without
  change; it was written for the Slither stage.
- **Whether the repository's `test/` tree can always be left out;** some projects import helpers from it into `src/`.
- **How often the attacker-profit oracle is too strict or too loose** on real protocols. That needs real runs.
- **The estimates in Part 6.**

---

## Part 8. Explicit approvals list

Nothing below is assumed. Each is a separate decision. Existing register entries are referenced where they exist
(`docs/approval-register.md` A39 covers pinned audit tools in a cloud environment setup; it is listed there as undecided).

**Downloads, installs and outbound hosts**

1. Read upstream release checksums and fill the tool lock (outbound: the Foundry, solc and Python package release hosts).
2. Download and install forge 1.5.1, the listed solc versions, Slither 0.11.3 and its hash-pinned dependencies, **in a local
   tools image only**.
3. Install or use a container runtime in the development environment, if one is not present.
4. The exact initial set of solc versions; and every later addition.

**Images and infrastructure**

5. Build the tools image; publish it to a registry.
6. Create the Fly app `agentsmith-tools` (separate from `agentsmith-hub` and `agentsmith-worker`), or decide instead to run
   tools in `agentsmith-worker` with the tools image.
7. Run the dummy-secret and network-canary checks on a throwaway machine.
8. Start a tools machine for a named run; mint and stage its run-scoped token; enable the private worker listener if not
   already enabled. Each is separate, as in `worker-app-deployment.md` W1–W6.

**Policy and rules**

9. **Foundry may record `contradicts`** under the conditions of 3.4 (today it never does). If declined: the fixed twin is
   `weakens`.
10. **A narrow relaxation of D1:** the API may record a `foundry-forge` evaluation whose verdict it derives from
    worker-reported raw output, labelled worker-reported. Includes the decision on whether re-execution on a second machine is
    required before a human relies on a result.
11. The independence rule of 3.3: a fixed, preregistered oracle per class; the cheatcode allow-list; the mandatory control run;
    the generator never read by the test author.
12. The order in which class templates are written, and the oracle for each, preregistered by hash before use.
13. No fork RPC, ever, for Foundry (confirming item 16 of the inventory's Part 6).
14. Using the dev corpus for the demonstration, stated as development data.

**Schema (each a production migration)**

15. Optional: a `test_author` role in `analysis_identities` and the template author's row.
16. Optional: a `recorded_by` value for worker-reported execution in `evaluation_provenance`.
17. Optional: a structured abstention column on `hypothesis_evaluations` (versus the blob).
18. Any new evaluator identity (Echidna, APEX): a new migration with an `INSERT`, plus the mirrored code entry.
19. Promotion of drafts 0009 and 0010 and R3b (C6), needed for human outcomes and decisions; **not** needed for the local
    demonstration.

**Source access**

20. Fetching submodule repositories at pinned commits for a real target (item 15 of the inventory's Part 6). Not needed for the
    dev-fixture demonstration.

**Release**

21. Releasing the reproduction step and the new worker operation in the API image; any production run.

**Not approved, and not assumed anywhere in this document:** any download, any install, any image build, any Fly app or machine,
any secret, any migration, any production run, any outbound host, any model call.
