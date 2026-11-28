# Continuous Protocol Security Monitoring: design (for owner review)

**Status: DESIGNED, not implemented.** Written 2026-11-28 against commit `0d4ee1d`. No application code, migration, schema, secret,
deployment or `deploy/` file was changed to write it. No blockchain RPC endpoint or block-explorer API was contacted. Provider facts
come from public pricing and documentation pages, read through web search only (§H.0 says what that means for their reliability).
**No provider is approved.** Every part labelled DESIGNED below has no code. EXISTING means the code exists in this repository at
`0d4ee1d`. Like every EXISTING research component (`docs/architecture/integrated-research-architecture.md` §1), it is not running in
production.

## Summary

The owner has mandated that AgentSmith become a continuous security intelligence system. For each programme it establishes a reviewed
baseline. It then watches the approved repositories and the officially in-scope deployed addresses, and notices meaningful changes. It
analyses each change against the baseline and works out the affected code, state and dependencies. It assigns the right specialists,
keeps the evidence and conclusions in the shared research state, and shows alerts and open investigations in Operations. Its unit of
work is **a change and its consequences**, not a repeated full audit.

This design **extends what exists** rather than adding a parallel product:

- **The repository monitor** (0013, `bounties/monitor.ts`) already detects new HEAD commits and queues runs. It gains three things:
  - a *reviewed* baseline, in place of "the latest sealed snapshot";
  - a scope-aware, meaningful-change filter;
  - a change-impact closure.
- **Deployed addresses** become monitored assets of a programme, with append-only observations. Their shape copies
  `discovery_observations` (0008) and `repository_monitor_checks`.
- **Deployed-code verification** compiles the pinned commit and compares the result with the on-chain runtime bytecode. A mismatch is an
  **integrity discrepancy**, never a vulnerability.
- **A change becomes an investigation** in the one existing workflow (`repository_research`). Its hypotheses, evaluations, independence
  (0016), dossier and decision records (A28/A29 draft) are all unchanged. A new analysis step localises the change. No tool confirms its
  own hypothesis.
- **Operations** gains a monitoring view, built in the existing metric format. Monitoring coverage, code coverage, confidence and
  outcomes stay separate.

**Why the first phase is offline:** at least five new records are needed, and every one is a future migration that needs approval. They
are named in §F.3.
- Phase M0 verifies USX's deployed bytecode against a sealed snapshot and a bytecode **recorded by the owner**.
- M0 uses no live RPC, no new host and no migration.
- Live reads (M3 and later) need decisions on providers, hosts, keys, cadence and alert routing. The list is in §L.

**What this cannot do:**
- It cannot see changes made outside the monitored addresses and repositories.
- It cannot prove that the absence of an event means the absence of a change. Only state reconciliation narrows that gap.
- It cannot make an incremental analysis as reliable as a full one when the change touches storage layout, inheritance or delegatecall
  targets. §D.5 says when a full rescan is required.

---

## 0. Audit of the existing components

Each row gives what the component does today, what it lacks for monitoring, and how this design extends it.

### 0.1 The repository monitor (migration 0013)

**Files:**
- `db/migrations/0013_repository_monitor.sql`
- `apps/api/src/bounties/monitor.ts` and `monitor-main.ts`
- `apps/api/src/bounties/repo-intel.ts`
- `deploy/fleet.json` (`bounty-monitor`, daily, not running)

**Does today:**
- `repository_monitors` holds one row per repository. Rows are seeded from `bounty_research_links`.
- The columns are `last_head_commit`, `last_outcome`, backoff (`consecutive_failures`, `next_attempt_at`) and disable-after-N.
- `repository_monitor_checks` is an append-only check log (`decision`, `workflow_run_id`, `base_commit`).
- `monitorOne` resolves the default-branch HEAD through the acquisition `RepositorySource`. It calls `planRepositoryResearch`, which
  returns `already_analysed`, `incremental` or `full`.
- It is idempotent against pending runs. It queues `repository_research` at the exact commit and links the run to every owning
  programme.

**Lacks:**
1. **"Analysed" means sealed, not reviewed.** `already_analysed` is `hasAnalysedCommit`, which is true for any sealed snapshot. The
   baseline is `latestSealedSnapshot`: the most recent seal, whether or not anyone reviewed it.
2. **Every new commit triggers a rescan**, even one that touches only docs or tests. The change is not filtered by scope.
3. **"Incremental" is a label only.** `changedFilesBetween` exists, but no step calls it. Outside `repo-intel.ts` nothing in
   `apps/api/src` references it. The queued run analyses the whole new snapshot exactly as a first pass would.
4. **The rescan loses the official scope.** `cfg.createRun(..., { structuralAnalysis })` passes no `bountyScope`. A rescan's dossier
   therefore has no `scope_status`.
5. Only the default branch is watched. The scope's pinned commit is not compared with HEAD.
6. There are no deployed addresses.

**Extended by:**
- §A.2: reviewed baselines.
- §A.1: a meaningful-change classifier over `changedFilesBetween`.
- §A.4: a closure step that the run actually uses.
- §A.1: carrying the programme's scope into every monitor-created run (a code fix, no schema).

### 0.2 Programmes, scope, mappings, pinned commits (migrations 0011, 0012, 0014)

**Files:**
- `db/migrations/0011_bounty_intelligence.sql`, `0012_bounty_research_link.sql`, `0014_repository_mappings.sql`
- `bounties/enrich.ts`, `bounties/promote.ts`
- `acquisition/bounty-scope.ts`

**Does today:**
- **0011** stores `bounty_programs`, resolved from `bounty_observations` by authority. Field history goes to `bounty_program_changes`.
  Nothing is overwritten.
- **0014** `bounty_repository_mappings` maps a programme to repositories with:
  - `verification_status`;
  - `last_seen_at`, which detects scope changes (repository dropped from the page).
- **Enrich** fetches only official pages that robots.txt and the platform's terms permit. Only `officially_confirmed` and
  `official_documentation` mappings may enter research.
- **Promote** creates queued runs and records `bounty_research_links` (0012) in the same transaction.
- **`BountyScope`** (`programme`, `in_scope_paths`, `evidence`, `evidence_sha256`) is recorded on the run's input. It labels leads; it
  never restricts acquisition.

**Lacks:**
- There is no record of deployed addresses, chains or the scope's pinned commit. The USX addresses live only in
  `docs/research-runs/usx-scope-evidence.md`.
- An older, separate model exists in `0001_initial.sql`: `programs`, `program_scope_versions`, `assets`, `program_assets` with
  `scope_status`. It is used only by `scope-guard.ts`, the active-testing gate. It is not linked to `bounty_programs`.

**Extended by:** §F.3 M1, `monitored_deployments`. Each row is a programme-scoped address with its evidence URL and page hash. It uses
the same verification statuses as 0014, so only official addresses are ever read on chain. Re-using the 0001 `assets` tables was
considered and rejected: they key on `programs`, not `bounty_programs`, and they belong to the active-testing gate, which monitoring must
never touch (§I).

### 0.3 Snapshots and snapshot verification (migration 0007, D2)

**Files:**
- `db/migrations/0007_research_state.sql` (`repo_snapshots`, `repo_snapshot_files`, `verify_repo_snapshot`)
- `acquisition/snapshot-verify.ts`

**Does today:**
- A snapshot is one repository at one commit. It is building, then sealed.
- The database computes the manifest hash when the snapshot is sealed.
- Files are classified (`source`, `test`, `vendored`, `generated`, `docs`, `config`, `other`) and carry `git_blob_sha`.
- **D2:** before sealing a worker-uploaded snapshot, the API itself:
  - re-resolves the commit (it must equal a pinned 40-hex ref);
  - re-fetches the tree and recomputes the plan;
  - re-hashes every stored byte to its git blob id.
- The result is stored in `snapshot_verifications`.

**Lacks:** nothing for the source side. The file classification is exactly what the meaningful-change filter needs. A snapshot belongs
to **one run** (composite foreign keys), so a later investigation run cannot cite another run's snapshot. §D.3 deals with this.

**Extended by:**
- The baseline is "sealed **and D2-verified** **and reviewed**" (§A.2).
- Bytecode verification (§C) compiles from that snapshot's bytes only.

### 0.4 Research runs, steps and the dossier

**Files:**
- `acquisition/step.ts` (`createRepositoryResearchRunIn`)
- `analysis/solidity/pipeline.ts`, `keys.ts`

**Does today:**
- One workflow, `repository_research`:
  - `acquire_repository`
  - `analyze_structure`
  - optional `slither_scan`
  - `challenge_leads`
  - `build_dossier`
  - optional `apex_shadow`
- `buildDossier` reads stored records only. It fails closed when a cited span does not verify.
- **Evidence integrity (D):** each entry separates `origin`, `validators`, `supporting_evidence`, `contradicting_evidence`,
  `corroboration` (same-, cross- and unknown-family), `reproduction`, `assessment` (never "confirmed") and `uncertainty`.
- **Provenance:** `api_derived`, `api_verified` or `worker_reported`.
- **Coverage:** `complete`, `partial`, `not_analysable` or `not_analysed`, with every problem listed.
- **`scope_status`:** `in_scope` or `out_of_scope`, by the primary span's path.

**Lacks:**
- The dossier has no notion of a baseline or of a change. There is no "new since the baseline", "unchanged" or "no longer present".
- There is no record of what was not checked because of the change's scope.

**Extended by:** a `change_impact` section in the dossier and a new step (§D.2). The existing fields stay as they are.

### 0.5 The research state (migrations 0007 and 0016)

**Files:**
- `db/migrations/0007_research_state.sql`, `0016_research_independence.sql`
- `apps/api/src/analysis-identity.ts`

**Does today:**
- `hypotheses` are immutable. Each one is tied to a snapshot and cites at least one primary evidence span.
- `hypothesis_evaluations` are deterministic and may abstain.
- `hypothesis_reviews` are model or human; a blinded review cannot be made by the generator.
- `hypothesis_events` is the ordered history. Status is the derived `hypothesis_status` view; no status is stored.
- `audit_events` (0001) is append-only and general.
- **0016:**
  - `analysis_identities` lists the family and method of every generator and evaluator.
  - A trigger refuses an evaluation by the hypothesis's own generator.
  - `evaluation_independence` and `hypothesis_independence` keep same-family corroboration and cross-family support in separate
    columns.

**Lacks:**
- Nothing in it records a monitored change, an on-chain observation or a reviewed baseline.
- `claim_fingerprint` is unique per snapshot. Nothing links "the same lead" across two snapshots.

**Extended by:**
- §F maps every monitoring memory item onto these records first.
- A stable cross-snapshot lead key is DESIGNED as a derived value, not a column (§F.2).

### 0.6 Engine, capabilities, tools and APEX

**Files:**
- `engine/capabilities.ts`
- `engine/tools/slither.ts`, `engine/tools/foundry.ts`
- `apps/api/src/apex/`
- `docs/architecture/apex-first-capability.md` §10 and §11.3

**Does today:**
- Capabilities are declarations of steps in the one workflow (producer, evaluator, reviewer, mapper, test_author), each with classes,
  runtime, cost and relevance.
- **Slither 0.11.3:**
  - pinned, solc given explicitly, no download;
  - one run per directory;
  - **a project that needs framework remappings fails as `compile_failed`**.
- **Foundry:** `forge test --offline` pinned, as an evaluator (`evm-execution` family), but only with a separately authored test.
  Real-Foundry reproduction is **UNPROVEN** (`worker-architecture-decision.md`, last table).
- **APEX:**
  - a measurement-only shadow step for one approved run (USX at `9e97…`);
  - never evidence;
  - its fidelity gate abstains on external calls, proxies and hashing, and suppresses approximations.

**Lacks:**
- There is no capability that maps a change to its impact.
- There is no compilation for bytecode.
- The protocol model (`protocol-model.ts` P3) knows proxy boundaries and upgrade writers, but it knows nothing about EIP-2535 diamonds
  or facets. The word does not appear in the builder.

**Extended by:**
- §E: a change-impact mapper.
- §C: a bytecode-verification step, using the same pinned-tool runner pattern as Slither and Foundry.
- §A.4: facet routing added to the protocol model, as a later increment.

### 0.7 Operations

**Files:**
- `apps/api/src/operations-api.ts`
- `apps/web/src/view-operations.ts`
- `docs/research-runs/live-operations-dashboard-spec.md`

**Does today:**
- The view is per run. It has ten panels (overall, discovery, acquisition, scope, analysis, APEX, tools, validation, reproduction,
  evidence) plus a "System" components card.
- Every metric is `{numerator, denominator, unit, kind, source, measurable, basis}`, with `kind` one of `processing`, `coverage`,
  `confidence` or `outcome`.
- Without a recorded denominator the metric is marked "not measurable" and no % is shown.
- Confirmed outcomes are always 0, because no API records a human outcome.

**Lacks:**
- There is no programme-level or cross-run view.
- There is no monitoring state, alert or overdue check.

**Extended by:** §G, a monitoring view in the same format, with a new metric kind `monitoring`. That is a type change, not a schema
change.

### 0.8 Discovery and decision drafts (migration 0008 and the drafts)

**Files:**
- `db/migrations/0008_discovery.sql`, which is not in the production image (`deploy/release.json` lists no 0008)
- `db/drafts/t144-research-memory/0009_research_memory.sql`
- `db/drafts/a29-engine-loop/0010_engine_loop.sql`
- `docs/research-decision-records.md` (A28)
- `engine/decisions.ts`

**Does today (as drafts):**
- **0008:** `discovery_observations` has one immutable row per fetch. It stores the URL, status, hash and size, never the body. This is
  the pattern to copy for chain reads.
- **0009 draft:**
  - `research_coverage` records the result `examined`, `abstained`, `not_modelled` or `out_of_scope`, with a reason code;
  - `research_effort`;
  - `hypothesis_outcomes`, which are human only;
  - `missed_in_runs`.
- **0010 draft:** `research_decisions` and `research_decision_candidates`. Every alternative is a row, including non-actions (`defer`,
  `skip_*`), with features that cite sources. The decision is written before the work it causes.

**Lacks:** none of these are applied anywhere (A4b and A29 are not approved).

**Extended by:**
- A monitoring alert's triage is a `research_decisions` row: "investigate", "defer" or "no action because…".
- What a change-focused run did or did not check is `research_coverage`.
- Monitoring therefore **depends on** A4b and A29 to record non-actions durably. Until they are applied, `audit_events` carries them
  (§F.1).

### 0.9 The worker architecture (option D)

**File:** `docs/security/worker-architecture-decision.md`.

**Does today:**
- The worker holds no database credential, only a run-scoped token.
- The API verifies content against GitHub (D2) and recomputes analysis (D3).
- The API runs validators itself (D1).
- Quotas apply (D4).
- The token is kept out of the environment (D6).
- Evaluations are idempotent (D7).
- **Option D is not yet approved for activation** (`deploy/release.json`: "Not approved: worker app, worker tokens…").

**Monitoring consequence:**
- Reading the chain is not handling untrusted archives. It fits a **collector-style scheduled job in the hub app**, like
  `bounty-monitor`.
- Compiling untrusted Solidity with `solc` is running a tool on untrusted input. It belongs on the **worker under D**, and its output is
  `worker_reported` (§C.5, §I.3).

---

## A. Repository and deployment monitoring (DESIGNED)

### A.1 New commits and meaningful source changes

The monitor keeps its loop: it resolves HEAD, compares it with the stored state and logs the check. It changes in two ways.

1. **What it compares against.** It compares HEAD with the programme's **reviewed baseline** commit (§A.2), not "any sealed commit".
   It also records the official scope's pinned commit and flags HEAD ≠ scope commit.
   - Sherlock's page for USX itself warns that "the link to the GitHub repo … may lead to older commit"
     (`usx-scope-evidence.md`).
   - A divergence is an alert for a human ("scope commit and HEAD differ"). It is never a silent re-pin.

2. **Which changes are meaningful.** A new commit is first acquired and sealed (D2-verified) as today. A new deterministic step,
   `classify_change`, then runs `changedFilesBetween(baseline, head)` and classifies each changed path. It uses the snapshot's own
   `classification` plus the run's `bounty_scope`.

| changed path | class | action |
|---|---|---|
| `classification = source`, `*.sol`, in `in_scope_paths` | **in-scope source** | investigate (§D) |
| `source`, `*.sol`, out of scope, but in the closure of an in-scope file (§A.4) | **dependency source** | investigate, labelled dependency |
| `source`, `*.sol`, out of scope and outside the closure | out-of-scope source | record; no investigation; counted in Operations |
| `config` affecting compilation: `foundry.toml`, `remappings.txt`, `hardhat.config.*`, the solc version, `lib/` submodule pointers, `package.json` dependency versions | **build change** | bytecode re-verification (§C) and a full rescan (§D.5) |
| `test`, `docs`, `generated`, `other`; `script/` deploy scripts | non-meaningful (scripts: noted, since they reveal deployment intent) | record only |
| `vendored` (for example `lib/openzeppelin-contracts`) | **dependency source** if any in-scope file imports it | investigate the closure |

A commit with no meaningful change ends as `up_to_date_non_meaningful` in `repository_monitor_checks` (a new outcome value, which is a
schema change; see §F.3). No analysis is spent on it.

**Honest trade-off:**
- Classification relies on the acquisition plan's path rules. A Solidity file mis-classified as `test` (for example a production
  contract under `test/`) would be skipped.
- Mitigation: any `*.sol` change that an in-scope file imports is in the closure, whatever its classification.

**Scope fix (code only):** every monitor-created run carries the programme's current `BountyScope`. That is the latest scope recorded on
a run of that programme. If the official page has changed since then (`bounty_repository_mappings.last_seen_at`), the run carries the
old scope and an alert says so. The scope is never silently refreshed.

### A.2 Baseline management: reviewed versus current

| term | meaning | record |
|---|---|---|
| **current** | the latest observed HEAD (repository) or implementation (deployment) | `repository_monitors.last_head_commit`; the latest chain observation (§B) |
| **analysed** | a sealed, D2-verified snapshot exists at that commit | `repo_snapshots.sealed_at`, `snapshot_verifications` |
| **reviewed baseline** | an analysed snapshot that a named human has accepted as the reference for this programme, with its dossier hash | DESIGNED `programme_baselines` (§F.3 M2), or a `research_decisions` row (A29) with `decided_by_kind = 'human'` |

**Rules (DESIGNED):**

1. **The first baseline.** It is the official scope's pinned commit, after:
   - acquisition;
   - D2 verification;
   - a complete or partial dossier (with the partial reasons recorded);
   - a human acceptance that names the dossier's `content_sha256`.
   For USX this is `9e972566…` once the approved run has happened. Today **no baseline exists for any programme**.
2. **Superseding a baseline.** A baseline is replaced only by a human acceptance of a newer analysed snapshot. The acceptance must cite:
   - the change investigation's dossier;
   - its decision record, including any non-actions;
   - the bytecode-verification state of the deployment, if any (§C).
   Nothing supersedes a baseline automatically. A new commit that is never reviewed leaves the baseline where it was, and Operations shows
   "N commits / D days behind".
3. **History is kept.** The old baseline stays: a supersede row, never an update. Every alert says which baseline it was computed
   against.
4. **Repository and deployment are separate.** A programme can have reviewed source at commit X while the chain runs code compiled
   from Y. That is the purpose of §C.
5. **Baselines are per programme and repository.** Two programmes sharing a repository may have different baselines.

### A.3 Incremental analysis of changed files

The structural analysis is seconds of CPU on the whole snapshot (`capabilities.ts` cost 1). The design therefore **keeps the whole-
snapshot analysis** and makes the rest of the work incremental:

- **Comparison.** Leads are compared with the baseline's leads by a stable key (§F.2). Each lead is `new`, `unchanged`,
  `changed location` or `no longer produced`.
- **Spending the expensive capabilities** only on the closure:
  - Slither, at cost 2: the closure's directories;
  - Foundry, at cost 3: only for leads that a separate test author writes a test for;
  - attended Claude specialists and budget-gateway model calls: only for the closure;
  - APEX shadow: only where approved.
- **Recording coverage.** What the closure did and did not examine goes in coverage (§D.4).

This is more honest than parsing only the changed files. A changed file's meaning depends on unchanged files: its base contracts,
libraries and storage.

### A.4 The dependency and interaction closure

For each changed contract or function, `classify_change` computes a closure from the protocol model of **both** snapshots, the baseline
and the head.

| relation | source today | gap |
|---|---|---|
| callers and callees (internal and external) | `protocol-model.ts` call edges, `reachableCalls` | external calls to unresolved targets are `unresolved_calls`: the closure is marked partial |
| inheritance (base and derived) | parser and index (`ProgramIndex`) | a changed base contract puts every derived contract in the closure |
| state: variables read and written, and their writers | `state-roles.ts`, `authority.ts` (writers, transfer controls) | none for direct reads and writes; assembly `sstore` is a recorded unknown |
| **storage layout** | NOT computed today | DESIGNED: diff the `storageLayout` output of `solc` (from §C's compilation) between baseline and head. Any slot shift, type change or reordering in a contract behind a proxy is a **layout-collision risk**: a full rescan plus a mandatory human review |
| proxy to implementation | P3 `proxy` boundaries, `upgradeWriters` | the implementation is often `unresolved` from types alone; the chain observation (§B) resolves it |
| **diamond facets** (EIP-2535) | NOT modelled (no facet or diamond notion in `protocol-model.ts`) | DESIGNED increment: selector → facet routing, from `diamondCut` initialisers in source plus the on-chain loupe (§B.2). Facets share the diamond's storage, so a changed facet's closure includes every facet that touches the same storage struct (for USX, `TreasuryStorage.sol` is in scope and is the obvious candidate) |
| modifiers and roles | `authority.ts` | none |
| libraries (internal and linked) | index | linked libraries also matter for §C |

The closure is recorded as a content-addressed blob, linked from the step output. If it is **partial** (any unresolved edge, assembly,
delegatecall to a variable, or missing layout), the reasons are listed, and §D.5 decides whether a full rescan is required.

---

## B. Read-only on-chain monitoring (DESIGNED)

### B.0 Hard constraints

- Only **officially in-scope addresses** are read. In-scope means recorded in `monitored_deployments` with `officially_confirmed` or
  `official_documentation` status and an evidence URL plus page hash, exactly as for repositories (0014).
- An address that is merely referenced from source, found in an explorer or read from storage is **not** monitored. It may be
  *reported* as a new integration (§B.6).
- **Read-only JSON-RPC methods only:**
  - `eth_chainId`
  - `eth_blockNumber`
  - `eth_getBlockByNumber`
  - `eth_getLogs`
  - `eth_getStorageAt`
  - `eth_call` (view functions only)
  - `eth_getCode`
  - optionally `eth_getProof`
- No signing, no `eth_sendRawTransaction`, no private key anywhere in the system (§I).
- Every read pins a block. It is made at a **finalised or confirmed** block number (§H.5), never at `latest`. The `(chain, block number,
  block hash)` triple is recorded with the value.

### B.1 Proxy upgrades

| what | how (state) | how (events) | notes |
|---|---|---|---|
| EIP-1967 implementation | `eth_getStorageAt(addr, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)` = `bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)` | `Upgraded(address indexed implementation)` | the slot is authoritative; the event can be missing (direct `sstore`, a non-standard proxy) |
| EIP-1967 beacon | slot `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50`, then `eth_call implementation()` on the beacon | `BeaconUpgraded(address indexed beacon)`, plus the beacon's own `Upgraded` | two hops; both are monitored |
| EIP-1967 admin (transparent proxy) | slot `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103` | `AdminChanged(address previousAdmin, address newAdmin)` | for OpenZeppelin 5 transparent proxies the admin is a `ProxyAdmin` contract: monitor its `owner()` too |
| UUPS | the same implementation slot; the upgrade logic lives in the implementation, so a new implementation can change *who may upgrade* | `Upgraded` | after every implementation change, re-run §C and re-derive the upgrade authority from the new implementation's source |
| non-standard proxies (custom slot, minimal proxies, EIP-1167 clones) | EIP-1167: the implementation is embedded in the runtime code (read with `eth_getCode`); custom slot: only if the source shows the slot | none, or custom | identified from source (P3 `proxy` boundaries); if not identifiable, recorded as `proxy_kind_unknown`, and the code hash is still monitored |

The slot constants above are the published EIP-1967 values. They must be re-checked against the EIP text and the pinned OpenZeppelin
source in the snapshot before implementation. They were written from the standard and not tested here.

### B.2 Diamonds (EIP-2535)

- **Event:** `DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata)`. It carries the full cut: facet address, action
  (Add, Replace, Remove) and selectors.
- **State:** the loupe functions:
  - `facets()`
  - `facetAddresses()`
  - `facetFunctionSelectors(address)`
  - `facetAddress(bytes4)`
  The loupe is optional for non-compliant diamonds. If it is absent, only events and per-selector probes of known selectors are
  possible, and that coverage limit is recorded.
- **Compared with:** the selector → facet map implied by the reviewed source and the baseline deployment. Any added, replaced or removed
  selector is a change. Every new facet address triggers §C for that facet.
- **Storage:** facets share the diamond's storage. A replaced facet re-opens the layout check (§A.4).

### B.3 Ownership

- **OpenZeppelin `Ownable`:** `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` and `owner()`.
- **`Ownable2Step`:** additionally `OwnershipTransferStarted(previousOwner, newOwner)` and `pendingOwner()`. A started-but-not-accepted
  transfer is a change in its own right: the alert "ownership transfer pending to X".
- **Renouncement** (owner becomes `address(0)`) is a change.
- If the owner is a contract, classify it from `eth_getCode` as a Safe, a timelock or unknown, and monitor that contract (§B.4).

### B.4 Roles, multisigs and timelocks

- **AccessControl:** `RoleGranted(role, account, sender)`, `RoleRevoked(role, account, sender)` and
  `RoleAdminChanged(role, previousAdminRole, newAdminRole)`.
  - Membership cannot be enumerated from state for plain `AccessControl`. The authoritative member set is the **event-reconstructed**
    set from deployment onwards.
  - This needs a full log history once, at baseline time, then incremental reads.
  - `AccessControlEnumerable` allows a state cross-check: `getRoleMemberCount` and `getRoleMember`.
- **Safe multisig:** `getOwners()`, `getThreshold()`, `nonce()`; events `AddedOwner`, `RemovedOwner`, `ChangedThreshold`,
  `EnabledModule`, `DisabledModule`, `ChangedGuard`.
  - A module or guard change is critical: a module can bypass the threshold.
  - Safe event signatures differ between Safe versions (1.3 vs 1.4.1). They must be matched to the deployed version, read via `VERSION()`.
- **Timelocks** (OpenZeppelin `TimelockController`):
  - `CallScheduled(id, index, target, value, data, predecessor, delay)`;
  - `CallExecuted(...)`;
  - `Cancelled(id)`;
  - `MinDelayChange(oldDuration, newDuration)`.
  - **Queued operations are early warning.** A queued upgrade is reported *before* it executes, with its decoded target and calldata
    where the ABI is known.
  - A `MinDelayChange` to a lower value is critical.
- Only monitored if the multisig or timelock is itself officially in scope, **or** it holds authority over an in-scope contract
  (owner, admin, role holder). In the second case it is read as a dependency of the in-scope address; the owner must confirm that this
  derivation is acceptable (§L).

### B.5 Critical parameters

- **Where the list comes from:** the reviewed source, not guesses. For each in-scope contract, `authority.ts` already lists privileged
  writers.
- **What is monitored:**
  - every state variable written only by a privileged function: setters for oracle and feed addresses, fees, caps, limits, pause flags,
    bridge or messenger addresses, LayerZero peers (`PeerSet(eid, peer)` on OApp/OFT) and enforced options;
  - read with `eth_call` (public getter) or `eth_getStorageAt` (slot from `storageLayout`);
  - the matching events.
- **Values are compared with the baseline value** captured when the baseline was accepted. Thresholds such as "fee above X" are a
  programme-level configuration that a human sets. They are never inferred.
- **Limit:** a parameter with no getter, packed into a slot with others, or inside a mapping needs the slot computation from the
  layout. Mapping keys must be known (for example peers per endpoint id). Unknown keys are a recorded blind spot.

### B.6 New integrations

- **New external addresses.** When a monitored address-typed variable or getter changes (oracle, bridge, peer), the new address is a
  change and is reported with `eth_getCode` (contract or EOA, code hash).
  - It is **not** automatically added to monitoring.
  - It is not in scope unless the official scope says so.
  - It is listed under "new integrations" for a human.
- **Approvals.** Monitored contracts holding tokens may grant ERC-20 allowances: `Approval(owner = monitored, spender, value)` on token
  contracts.
  - This requires reading logs of **token contracts that are not in scope**, filtered by `topic1 = monitored address`.
  - This is a read of a public log about an in-scope address, not monitoring of the token. It is still an owner decision (§L), because
    it widens which contracts are queried.
  - Set the token list from the reviewed source (the assets the contract holds).

### B.7 Which chains

**What the scope evidence actually supports** (`docs/research-runs/usx-scope-evidence.md`):

- **Scroll mainnet** (chain id 534352): four deployed in-scope addresses:
  - `0xcb14bcdf6cd483665d10dfd6f87d908996c7f922`
  - `0xd16909ecc9c71d481ee3b2cb1968c0dadcf0d300`
  - `0x3b005fefc63ca7c8d25ee21fba3787229ba4cf03`
  - `0x9f3d4b0c9e930ca3957ecd3dedb7417f8e0e4c35`
  - Which contract each address is, and whether any is a proxy or the diamond, is **not recorded** and is unknown.
- **LayerZero OFT chains:** **not evidenced.** The in-scope *source* includes `src/oft/USXOFT.sol`, `StakedUSXOFT.sol`,
  `USXOFTAdaptor.sol`, `StakedUSXOFTAdaptor.sol` and `BridgedTokenOFTAdapter.sol`, which implies deployments on other chains. The
  recorded scope lists **no** address on any other chain.
- **Ethereum L1:** `IScrollERC20Bridge.sol` and `BridgedToken.sol` suggest an L1 counterpart. It is **not evidenced** either.

**Rule:** monitor Scroll only, until the official page (or official project documentation linked from it) is re-read and records
addresses on other chains. Each additional chain is then a `monitored_deployments` row with its own evidence and page hash.

**Must be confirmed by the owner before any live read:**
1. which of the four addresses are which contract;
2. whether OFT deployments on other chains are in scope;
3. whether the L1 side is in scope;
4. whether the scope page has changed since the hash `1cdc8353…` (2026-11-28).

### B.8 Events versus state polling

| | event-based (`eth_getLogs`) | state polling (`eth_getStorageAt` / `eth_call` at block N) |
|---|---|---|
| sees | every *emitted* change, with transaction context and ordering | the *current* value, whatever wrote it |
| misses | changes with no event: a direct `sstore` from an upgrade initialiser or `delegatecall`, a non-standard proxy, a custom setter that emits nothing; events from addresses not in the filter; ranges skipped by a gap or a provider truncation | changes that happen and are reverted between two polls (A→B→A); the order and number of intermediate changes; anything not enumerated (unknown slots, mapping keys) |
| cost | one call per chain per window for all addresses (address-array filter), but providers cap block ranges and result sizes | one call per value per poll; grows with addresses × values × cadence |
| failure mode | silent: a provider returns `[]` for a range it did not index | loud: an error, or a value that disagrees across providers |

**Design: both, plus reconciliation.**
1. **Events** are the primary change feed, with block-range checkpoints per chain and per provider (§H.6).
2. **State polling** covers the critical values at every check: implementation, beacon, admin, owner, pendingOwner, Safe
   owners/threshold, loupe digest and code hash of each implementation.
3. **Periodic full reconciliation** (daily): every tracked value is read at one finalised block and compared with the
   event-reconstructed state. Any disagreement is a `reconciliation_mismatch` alert. It means an event was missed, or a write without an
   event happened; both need a human. This is the only defence against changes made without an event.
4. **The A→B→A blind spot** is closed only by events. If events are missed, it stays open. That is recorded as a limitation, not hidden.

---

## C. Deployed code verification (DESIGNED)

### C.1 Purpose

Does the code at the in-scope address equal the code compiled from the reviewed commit? The answer is a statement about **integrity**:
whether the reviewed source is what runs. It is not about security.

- **A mismatch is an INTEGRITY DISCREPANCY.** It is never automatically a vulnerability and never a hypothesis about a bug.
- It is recorded as a verification state, surfaced as an alert, and it blocks treating the source baseline as describing the deployment.

### C.2 Reproducible compilation from the pinned commit

**Inputs, all from the sealed snapshot:**
- the compiler settings (`foundry.toml` profile, `hardhat.config.*` or `remappings.txt`);
- the **exact solc version** (pragma ranges are not enough; the project's config pins it);
- the optimizer (enabled and runs);
- `viaIR`;
- `evmVersion`;
- `metadata.bytecodeHash` (`ipfs`, `bzz1` or `none`) and `appendCBOR`;
- remappings;
- dependency sources (git submodules under `lib/` at their pinned commits, or `node_modules` from a lockfile);
- the contract's fully qualified name.

**Procedure:**
1. Build solc **standard-JSON input** from the snapshot bytes only. Submodule contents must be in the snapshot: acquisition today
   **skips submodules** (`skip_reason = 'submodule'`).
2. **Dependencies are the first blocker.** USX almost certainly uses Foundry `lib/` submodules, and that is the remapping case on which
   Slither already fails (`compile_failed`).
   - DESIGNED: acquire each submodule at its pinned gitlink commit as additional D2-verified snapshot content.
   - This needs an acquisition change and a decision (§L).
   - Until then, the result is `unverifiable(dependencies_not_acquired)`.
3. Compile with the pinned solc binary given explicitly. Nothing is downloaded at run time, matching Slither and Foundry.
4. The output is creation bytecode, runtime bytecode (`deployedBytecode`), `immutableReferences`, `linkReferences`, metadata and
   `storageLayout` (used by §A.4).

### C.3 Comparison rules

1. **Runtime, not creation.** Compare `eth_getCode(address, block)` with the compiled `deployedBytecode`.
   - Creation-bytecode comparison needs the deployment transaction's input. That requires locating the creation transaction, which is an
     explorer or trace lookup, so it is a secondary check.
   - Creation input is the only place **constructor arguments** appear (appended ABI-encoded after the creation code). It is used only to
     decode and record them, when available.
2. **Metadata hash (CBOR suffix).** The runtime code ends with a CBOR map (IPFS or bzzr hash, solc version) and a 2-byte big-endian
   length.
   - Strip it from both sides (read the length from the last two bytes; check that the map decodes) before comparing.
   - If the bytecodes match **only** after stripping, the state is `matched_modulo_metadata`. The executable code is identical, but the
     metadata (comments, whitespace, source paths or settings in metadata) differs.
   - If the CBOR suffix decodes on both sides and the metadata hashes are equal, the state is `matched_exact`.
3. **Immutables.** solc leaves zero placeholders for each immutable at the offsets in `immutableReferences`.
   - Mask those byte ranges on both sides before comparing.
   - Record each on-chain immutable value: they are deployment parameters (addresses, decimals) and are themselves baseline values
     (§B.5).
4. **Linked libraries.** `linkReferences` placeholders are replaced by library addresses.
   - Mask them, record the on-chain addresses, and verify each library address recursively (§C.2 for the library).
   - A library that is not in scope is verified only if the owner approves reading it (§L).
5. **Proxies.** The proxy's own code is compared with the proxy contract compiled from the snapshot, or with the canonical OpenZeppelin
   proxy at the pinned dependency version.
   - The **implementation**, read from its EIP-1967 slot at the same block (§B.1), is compared with the implementation contract.
   - Most security-relevant mismatches will be implementation mismatches.
6. **Facets.** Each facet address from the loupe or `DiamondCut` is verified as its own contract. The diamond's selector map is compared
   as in §B.2.
7. **Block pinning.** The code, the implementation slot and the facet list are all read at one finalised block, so they describe the
   same state.

### C.4 States (exactly one per (address, block, baseline))

| state | meaning | typical reasons |
|---|---|---|
| `matched_exact` | runtime bytecode equal after masking immutables and libraries; metadata hash equal | none |
| `matched_modulo_metadata` | equal after masking and stripping CBOR; metadata differs | different source paths, comments or metadata settings; the same executable code |
| `mismatch` | differs after all normalisation | `different_commit`, `different_settings` (optimizer runs, viaIR, evmVersion), `different_dependency_version`, `unknown`. The cause is a *hypothesis about the build*, tested by re-compiling with the alternatives; it is never a security finding |
| `unverifiable` | could not be decided | `no_code_at_address` (EOA or self-destructed), `dependencies_not_acquired`, `compiler_unavailable`, `settings_not_in_repository`, `compile_failed`, `contract_not_identified` (which artifact this address is), `rpc_disagreement` (§H.4), `proxy_implementation_unresolved` |
| `not_checked` | not attempted in this cycle | `not_due`, `budget`, `owner_not_approved` |

**Every state carries:**
- compiler version and settings;
- the input manifest hash;
- the compiled runtime hash, the on-chain code hash and the normalised hashes;
- the masked ranges;
- the block number and block hash;
- the provider(s) and quorum result;
- the snapshot id;
- the basis.

### C.5 Who computes it, and what is trusted

- **Compilation** runs solc on untrusted source, so it runs on the worker under option D. Its compiled artifact is `worker_reported`.
- **The normalisation and comparison** are pure byte operations. The API recomputes them itself, using the worker-reported artifact and
  the API's own on-chain read. This mirrors D3.
- The verification state is therefore **"comparison api_derived, compilation worker_reported"**, and the dossier and Operations show it
  that way.
- A compromised worker could forge a matching artifact. The mitigations are:
  - an explorer- or Sourcify-verified source as an independent signal (§C.6);
  - later, a pinned, isolated compile service, which is an owner decision.

### C.6 Explorer-verified source: secondary, never authoritative

Etherscan-family, Blockscout or Sourcify "verified" status is someone else's compilation claim:
- recorded as a signal (`explorer_verified: full | partial | none | unavailable`, with source URL, date and response hash);
- never a substitute for §C.3;
- never able to override a `mismatch`.

A disagreement (the explorer says verified at source X, and ours mismatches against commit Y) is itself reported. It often means the
deployment came from a different commit than the scope pins, which is exactly what the owner needs to know.

---

## D. Change-focused research (DESIGNED)

### D.1 Change → investigation

1. **A change is created** by either a repository change (§A.1, meaningful) or a chain change (§B), as an append-only change record
   (§F.3 M4).
2. **Triage** is a decision record (A29 `research_decisions`, `level = 'repository'` or `'component'`). Its candidates are the changed
   components, each with an action: `investigate`, `defer` or `skip_*`. Every skipped component is a row with a reason. A human or the
   policy decides; the policy only recommends investigations above a threshold set by the owner.
3. **The investigation** is a `repository_research` run:
   - at the head commit (repository change);
   - or at the **baseline commit** (chain change, for example an ownership transfer, whose meaning is read against the reviewed source);
   - or at the commit identified as the new implementation's source, if one is found (an upgrade).
   Its input carries `monitoring_change: { change_id, baseline_snapshot, closure_sha256 }` and the programme's `bounty_scope`.

### D.2 What the run does differently

A new step, `change_impact` (role `change_mapper`), sits after `analyze_structure` and before the producers. It is deterministic and
API-derived (D3 style). It:

- recomputes the closure (§A.4) on the sealed head snapshot and the baseline snapshot;
- records the changed contracts, functions, state variables, storage-layout delta, authority delta (`authority.ts` facts before and
  after) and facet-routing delta;
- tags every lead from `analyze_structure` with `change_relation`:
  - `in_change`: the primary span is in changed code;
  - `in_closure`;
  - `outside_closure`;
  and, by the stable key (§F.2), with `baseline_relation`: `new`, `unchanged` or `moved`, plus the list of baseline leads `no_longer_produced`;
- sets the **assignments** for later steps through the engine's capability selection. It reads `capabilities.ts` relevance signals,
  restricted to closure components. For example, an `authority` delta assigns the access-control execution validator and an attended
  access-control review. A storage-layout delta assigns a human review (no automated capability models layout collisions). An
  external-call or oracle change assigns `claude-path` (oracle-manipulation) under the budget gateway.

The dossier gains a `change_impact` section: baseline, head, what changed, closure (complete or partial, with reasons), leads by change
relation, baseline leads no longer produced (each needing a reason: code removed, or analyser difference), and what was not examined.
Existing dossier fields are unchanged.

### D.3 Preserving the previous baseline

Snapshots, hypotheses and evaluations are per run (composite foreign keys, 0007). An investigation run therefore **re-acquires** the
baseline commit as a second snapshot in its own run, alongside the head snapshot.
- This is cheap: content-addressed blobs deduplicate, and D2 re-verifies.
- It keeps every citation in-run, as 0007 requires. The baseline run's records are never modified.
- Cross-run reference happens only through the derived lead key and the baseline record.
- **This needs a change:** acquisition today seals one snapshot per run per (repository, commit). Two commits per run are allowed by
  the unique key `(workflow_run_id, repository, commit_sha)`, but `acquire_repository` acquires one ref. A second acquisition step is
  a code change, not a schema change.

### D.4 Recording checked, not checked and not modellable

This is the 0009-draft `research_coverage` per (component hash, class, method): `examined`, `abstained`, `not_modelled` or
`out_of_scope`, with a reason code. Monitoring adds reason codes; that is data, not schema:

- `outside_change_closure`
- `closure_partial_unresolved_call`
- `storage_layout_not_compared`
- `facet_routing_unknown`
- `no_capability_for_class` (the existing `NOT_MODELLED_CLASSES`)
- `deployment_unverified`

Until A4b applies 0009, the same facts go in the dossier's `coverage.problems` and in an `audit_events` row. They are not queryable
across runs.

### D.5 When incremental is reliable, and when a full rescan is required

**Incremental (closure-only spend) is acceptable only when all of these hold:**
- the closure is complete (no unresolved edges in it);
- no storage-layout change;
- no change to inheritance roots, proxy or upgrade code, initialisers, `delegatecall` sites, fallback or receive, or diamond routing;
- no build change (§A.1);
- the deployed code is `matched_*` against the baseline.

**A full rescan (all capabilities on the whole snapshot, as a first pass) is required when any of these hold:**
- any storage-layout delta behind a proxy or diamond;
- a change to a base contract inherited by most in-scope contracts (for example `TreasuryStorage.sol`);
- a compiler, settings or dependency version change;
- a partial closure;
- a deployment `mismatch` or `unverifiable` against the baseline;
- the baseline is older than a configurable age or analyser version (`ANALYZER_VERSION` changed since the baseline: earlier results
  are not comparable);
- the owner asks.

The decision and its trigger are recorded in the decision row. Even incremental runs repeat the cheap whole-snapshot structural analysis
(§A.3).

---

## E. Cooperation through AgentSmith (DESIGNED)

The tools do not run side by side. Each one reads the shared state and writes into it, and the next step reads what the previous one
wrote.

| role | component | reads | writes | independence |
|---|---|---|---|---|
| shared protocol understanding | protocol model (`protocol-model.ts` P1–P3) + DESIGNED facet routing + on-chain facts | sealed snapshot; chain observations as *labelled external facts* | `protocol_model_sha256` blob | facts, not claims |
| localisation | `change_impact` (§D.2) | both protocol models; `changedFilesBetween`; chain change | closure blob; lead tags; assignments | deterministic; no hypotheses |
| static detection | Slither (`slither-ir` family) | closure directories | hypotheses (generator `slither`) | cannot evaluate its own leads (0016 trigger) |
| structural specialists | `solidity-structural-specialists` (parser family) | whole snapshot | hypotheses | its execution validators share the **same family**: only corroboration |
| state exploration | APEX shadow | approved run only; in-scope `.sol` | `audit_events apex_shadow.reported` only | **never evidence**; enabled only where its fidelity gate (§10.1 of the APEX doc) supports, and in shadow until §10.2.5 (independent replay) is validated |
| reproduction | Foundry (`evm-execution`) | a test written by a **separate test author** (`claude-reproducer` or a human) | evaluation `foundry-forge` | cross-family against parser, Slither and model generators |
| reasoning | attended Claude specialists; later budget-gateway calls | closure, change summary, baseline dossier | hypotheses (`claude-model` family); blinded reviews | a model review of a model claim is same-family; every unattended call goes through `AiBudgetGateway` ($25/month, $1/day, $0.50 per workflow, per-call caps: `ai-budget.ts`) and is refused when a cap would be exceeded |
| comparison and disagreement | dossier `evidenceIntegrity`, `hypothesis_independence`, `hypothesis_status` (`reviews_disagree`, `static_conflicts_with_review`) | all evaluations | dossier entry | disagreement is surfaced, never averaged |
| next investigation | engine loop + A29 decisions | status, disagreement, coverage gaps | decision rows, including non-actions | a disagreement or a `weakens` is a candidate for a different-family evaluator |

**Independence rules (0016, unchanged):**
- An evaluation by the hypothesis's generator is refused by the database.
- Only `cross_family` support counts as independent.
- Same-family agreement is corroboration.
- Nothing in monitoring writes `confirmed`; that needs a human outcome (0009 draft).

**Chain observations as evidence.** A chain observation is stored as a content-addressed JSON blob: method, params, block, block hash,
provider(s), quorum result and value. An evidence span may cite it, alongside source spans, for example: "owner() at block N is 0x…;
the setter at `USX.sol:120-131` is guarded by `onlyOwner`".
- The hypothesis still needs a primary span in the snapshot (0007).
- The observation is supporting context, labelled `chain_observation`, `api_derived` (read by the API's own client) and
  `quorum: k of n`.

### E.1 Worked example: a proxy upgrade, end to end (DESIGNED; hypothetical, not USX data)

1. **Detection.**
   - The Scroll event poll for the checkpoint window `(B0, B1]` returns `Upgraded(0xNEW)` from monitored proxy P.
   - The same cycle's slot read at finalised block B1 returns implementation `0xNEW` from provider A and provider B (quorum 2 of 2).
   - Both agree with the event. A chain change record is written: `proxy_implementation_changed`, old `0xOLD` (baseline), new `0xNEW`,
     tx hash, block, observations.
2. **Alert.** Operations shows "P: implementation changed (critical), not yet verified". The alert routes to the owner's channel
   (decision §L).
3. **Verification (§C).**
   - `eth_getCode(0xNEW, B1)` is read with quorum.
   - The monitor checks whether the repository has a commit whose compiled implementation matches. Candidates are the reviewed
     baseline, HEAD, and tags since the baseline. The bound is configurable, and each compile is a worker job.
   - **Case A:** HEAD's compiled implementation is `matched_modulo_metadata`. The change is located: the upgrade deployed HEAD.
   - **Case B:** nothing matches. The state is `mismatch(unknown)` against every candidate. This is an **integrity discrepancy**: the
     deployed code is not the reviewed source. Research proceeds on what *is* known (Case A path, or bytecode-level facts only), and the
     dossier says the reviewed source does not describe the deployment.
4. **Triage decision.** `research_decisions` (level `repository`): candidate "investigate HEAD vs baseline", selected; candidates "re-verify
   facets", "defer the OFT adaptors (unchanged)" with reasons. The run is created in the same transaction.
5. **Investigation run** at HEAD with the baseline re-acquired:
   - `acquire_repository` ×2, both D2-verified;
   - `analyze_structure` on HEAD;
   - `change_impact`: the changed `USX.sol` functions, an authority delta (a new `setMinter` with a weaker guard, say), a storage-layout
     delta (one new variable appended: no collision), a complete closure. The rules say incremental is acceptable, except that the
     storage change is behind a proxy, so the policy requires a **human layout review** in any case;
   - Slither on the closure;
   - `challenge_leads`: the API's execution validators run on the access-control lead (same family as the specialists);
   - an attended `claude-hunter` pass on the closure;
   - `claude-reproducer` writes a Foundry test for the `setMinter` lead;
   - `foundry-forge` runs it offline on the snapshot, and its result is a cross-family evaluation;
   - `build_dossier` with `change_impact`.
6. **Disagreement.** Suppose the execution validator `supports` but Foundry `contradicts`, because the guard is enforced by a modifier
   in a base contract the bounded model did not include.
   - The dossier shows `refuted` (an executed counterexample wins).
   - Both evaluations are kept, and the uncertainty names the bounded model.
   - The engine records a decision: "no further action on this lead; reason: cross-family contradiction", which is a recorded
     **non-action**.
7. **Memory.** The run is linked to the change record. The lead key is recorded; a future run that produces the same lead sees its
   history. The lesson ("bounded model misses inherited modifiers") is recorded **only** because an executed contradiction supports it
   (§F.4).
8. **Baseline.** The owner reviews the dossier and the layout check, then accepts HEAD as the new baseline. The old baseline is kept as
   superseded. The deployment baseline becomes `0xNEW` with `matched_modulo_metadata`. The alert closes with a reference to the
   acceptance.

---

## F. Shared memory and learning (DESIGNED)

### F.1 Mapping onto existing records first

| memory item | existing record | gap |
|---|---|---|
| reviewed versions | `repo_snapshots` + `snapshot_verifications` + dossier `content_sha256` | the *acceptance* is not recorded (M2) |
| repository changes | `repository_monitor_checks` (commit, decision, base) | the meaningful-change classification and closure (M4; closure blob) |
| chain changes | none | M3/M4 |
| investigations | `workflow_runs` + `bounty_research_links` | link to the change (M4 `change_id`; the run input carries it already) |
| actions **and non-actions** | `research_decisions` / `_candidates` (A29 draft); `audit_events` until then | A29 must be applied for queryable non-actions |
| hypotheses | `hypotheses`, `hypothesis_evidence` | none |
| findings supported or rejected | `hypothesis_evaluations`, `hypothesis_reviews`, `hypothesis_status`, `hypothesis_independence`; human outcomes in `hypothesis_outcomes` (0009 draft) | A4b for outcomes |
| failed approaches | step `failed` / abstentions (`inconclusive` evaluations with reason); Slither and APEX abstention codes; `audit_events` | none for runs; "approach X failed on component Y" across runs needs `research_coverage` (0009) |
| what was checked / not / not modellable | `research_coverage` (0009 draft); dossier `coverage` | A4b |
| unresolved questions | dossier `uncertainty`, `architecture.unknowns`; open leads | no first-class "question" record; DESIGNED as `research_decision_candidates` with action `defer` and a reason (A29), not a new table |
| lessons | none durable | §F.4: only evidence-gated, as a human-accepted record |
| bytecode verifications | none | M5 |
| deployed addresses | `usx-scope-evidence.md` only | M1 |

### F.2 Stable cross-snapshot lead key (derived, no column)

`lead_key = sha256(canonicalJson([repository, class, contract, function, normalised_path]))`

It is computed from the stored finding payload (`agentsmith-finding/1`). It deliberately omits line numbers, so a lead that moved lines
keeps its key, while a renamed function or a moved file gets a new key. It is a view-level derivation and is tested. Two different leads
that share a key, for example two reentrancy leads in one function, are compared as a set.

### F.3 Minimal new records: future migrations, each requiring owner approval

None of these exist. Each would be a forward-only, append-only migration with a rollback, tested on disposable databases, and excluded
from the production image until approved (the 0012–0014 pattern).

| id | record | purpose | notes |
|---|---|---|---|
| **M1** | `monitored_deployments` | (bounty_program_id, chain_id, address, role label, evidence URL, evidence page sha256, discovery method, verification status as 0014, last_seen_at, enabled) | only official statuses may be read on chain |
| **M2** | `programme_baselines` | (programme, repository, snapshot_id, dossier content hash, accepted_by (human), accepted_at, supersedes_id, deployment state per address) | append-only; or expressed as A29 `research_decisions` rows + a view, if the owner prefers fewer tables |
| **M3** | `chain_observations` + `chain_checkpoints` | one immutable row per read (chain, provider id (no key), method, params hash, block number, block hash, result hash, value blob, outcome, error code, latency), mirroring `discovery_observations`; checkpoints per (chain, provider, filter) with last scanned finalised block | the body of large results goes to `research_blobs` |
| **M4** | `monitoring_changes` | one row per detected change (kind, programme, subject (repo or address), old/new, detected_by (event / poll / reconciliation), observation ids, severity class, state open/triaged/investigating/closed, decision id, run id) | the alert source for Operations; also needs new `repository_monitor_checks.outcome` values (`up_to_date_non_meaningful`, `scope_commit_diverges`) |
| **M5** | `deployment_verifications` | (address, block, snapshot, contract FQN, state §C.4, reasons, settings, hashes, masked ranges, compilation basis, explorer signal) | append-only |

The 0009 and 0010 drafts (A4b, A29) are **dependencies**, not part of this design. Without them, non-actions and coverage stay in
`audit_events` and dossiers.

### F.4 Evidence-gated learning

Nothing is learned from unvalidated output:
- not from APEX shadow records;
- not from worker-reported compilation alone;
- not from a single same-family corroboration;
- not from a model's opinion.

A lesson is recorded only when it rests on one of:
- an executed cross-family contradiction or support;
- a human outcome (0009);
- a reconciled chain fact (quorum, finalised).

Lessons go in `knowledge_items` (0001, an existing table), with links to the evaluations that justify them and the accepting human. They
adjust the *policy* only through a new, versioned policy hash (A29 `policy_sha256`). The lessons are never trained on silently.

---

## G. The Operations monitoring view (DESIGNED)

A new programme-level page beside the per-run view. It is read-only, behind the operator token, and computed per request from stored
records, like `operations-api.ts`. It reuses `metric()` unchanged and adds one `MetricKind`: `"monitoring"`. That is a TypeScript type
change, not schema.

### G.1 Per programme

| field | source | shown as |
|---|---|---|
| monitored repositories / addresses (by chain) | `repository_monitors`; M1 | counts, with evidence links |
| last successful check (repo; chain per provider) | `repository_monitor_checks`; M3 | timestamp + age; **overdue** if age > 2 × cadence |
| latest repository commit vs reviewed baseline vs scope commit | `repository_monitors`, M2, run `bounty_scope` | three hashes; "N meaningful commits behind" |
| latest deployed implementation per proxy / facet set | M3 | address, block, code hash |
| changes (open / triaged / investigating / closed) | M4 | counts + list by severity |
| integrity discrepancies | M5 `mismatch`, `unverifiable` | list with reasons; never under "findings" |
| investigations pending and completed | runs linked to M4 | per run: link to the existing run view |
| failed or overdue checks | M3 outcome `failed`; overdue computation | error codes (redacted with `redactText`) |
| reconciliation mismatches | M4 `detected_by = reconciliation` | list |

### G.2 Metrics (each with real numerator and denominator; `measurable: false` and no % otherwise)

| key | kind | numerator / denominator | source |
|---|---|---|---|
| `addresses_checked_on_time` | monitoring | in-scope addresses whose last successful check is within 2 × cadence / enabled in-scope addresses | M1, M3 |
| `chain_ranges_covered` | monitoring | finalised blocks scanned with no gap since the baseline block / finalised blocks since the baseline block | M3 checkpoints |
| `critical_values_reconciled` | monitoring | tracked values whose last reconciliation agreed / tracked values | M3, M4 |
| `deployments_verified` | monitoring | addresses in `matched_exact` or `matched_modulo_metadata` at the latest implementation / in-scope addresses | M5 |
| `providers_in_quorum` | monitoring | critical reads with k-of-n agreement / critical reads | M3 |
| `changes_triaged` | processing | changes with a decision / changes detected | M4 + A29 |
| `closure_components_examined` | coverage | closure components with `examined` coverage for ≥1 class / closure components | 0009 `research_coverage` (not measurable until A4b) |

Confidence (the dossier verdict distribution) and outcomes (human outcomes, confirmed always 0 without them) are shown **in their
existing panels only**. A change investigation is never summarised as a single % of "security".

### G.3 Coverage and blind spots (always listed, never hidden)

The view always lists:
- chains named in source but not in the scope (the OFT and L1 sides, until confirmed);
- addresses with `unverifiable`;
- parameters with no getter or unknown mapping keys;
- roles not enumerable by state;
- ranges a provider refused or truncated;
- the A→B→A blind spot when event coverage has a gap;
- closure parts marked partial;
- any analyser classes in `NOT_MODELLED_CLASSES`.

---

## H. Providers, cost and reliability (DESIGNED; NO PROVIDER IS APPROVED)

### H.0 How these facts were gathered, and how far to trust them

- The pages could not be fetched directly. From this session `www.alchemy.com`, `docs.etherscan.io` and `docs.sourcify.dev` did not
  resolve (the session's network allowlist).
- Every figure below comes from **web-search result summaries on 2026-11-28**. Several of those summaries contradict each other; the
  contradictions are kept.
- **No provider's terms of service were read in full.** Before any approval, each pricing page and terms page must be read directly
  and recorded with a hash, as `bounty_sources.access_note` does for collection sources.
- Per-method credit costs are mostly **unknown**. Where a number is used, it is labelled.

### H.1 RPC candidates (Scroll mainnet, chain id 534352)

| provider | Scroll? | free tier (as reported) | rate limit (as reported) | paid (as reported) | unknowns |
|---|---|---|---|---|---|
| **Scroll public RPC** `rpc.scroll.io` | yes (official) | free, no key | unknown; third parties claim ~5 req/s or ~100 req/min; "can become congested", returns 429 | n/a | terms, SLA, archive depth, `finalized` tag support |
| **Alchemy** | yes (`scroll-mainnet.g.alchemy.com`; RPC, Debug, Webhooks; **no Trace API**, per its Scroll page) | 30M CU/month (older pages say 100M or 300M: outdated) | 300 or 500 CU/s (sources differ) | PAYG $0.45–$0.525 per 1M CU (sources differ) | `eth_getLogs` = 60 CU (official CU page, as summarised); `eth_call` ≈ 26 CU (**third-party crate only**); `eth_getStorageAt` **unknown**; block-range cap for logs on Scroll unknown |
| **Infura / MetaMask Developer** | yes (it has a Scroll JSON-RPC reference) | 3M credits/day | 500 credits/s | Developer 15M/day, 4,000/s; Team 75M/day | per-method credit cost **unknown** (not in the summaries); price **unknown**; HTTP 402 at the daily cap |
| **QuickNode** | yes (Scroll chain page) | **30-day free trial only**, 10M credits, 15 req/s | as left | **unknown** | unsuitable as a free continuous source |
| **Ankr** | yes (Scroll page) | Freemium 200M API credits/month (sign-in) | ~30 req/s (Node API); public tier shared | **unknown** | credits per request **unknown**; some chains moved from keyless Public to Freemium in 2026 |
| **OnFinality, Dwellir, Chainstack** (seen in results) | claimed | not researched | | | not evaluated |

### H.2 Explorers and verification sources

| source | Scroll? | free tier (as reported) | role here | caveat |
|---|---|---|---|---|
| **Etherscan API v2** (one key, `chainid` parameter) | **probably not any more:** its changelog announced deprecation of Scroll (534352) API support on **2026-04-16** | 3 calls/s, 100,000/day, "selected chains" (an older page says 5/s) | secondary verified-source signal; creation-tx lookup | verify the deprecation before relying on it; Scrollscan (Etherscan-family) is affected in the same way |
| **Blockscout** (`blockscout.scroll.io`) | yes (the explorer exists) | unknown | secondary signal; creation-tx lookup | terms and limits unknown |
| **Sourcify v2** (`/v2/...`; v1 shut off 2026-07-07) | **unconfirmed** for 534352 | unknown (historically free, no key) | secondary signal: full vs partial match, compiler settings | Scroll support and limits unknown |

Explorer calls happen only on a change (a new implementation or facet), so at most a handful per day. Cost is dominated by RPC.

### H.3 Cost estimate (arithmetic shown; assumptions labelled)

**Per-check reads:**
- **Per address, R_a = 10:**
  - 3 EIP-1967 slots (implementation, beacon, admin);
  - `owner()` and `pendingOwner()`;
  - 5 critical parameters (an assumption; the real number comes from the source).
  - Diamonds add 1 (`facets()`), and Safes add 3; those are ignored here.
- **Per chain, R_c = 2:** a block header and one `eth_getLogs` covering all monitored addresses. This assumes the window fits in one
  call; the range cap is unknown.
- **Code reads:** `eth_getCode` only on change, plus daily reconciliation (1 per address per day, which is negligible).
- **Quorum:** every read goes to 2 providers, so each provider sees the full volume below.

**Formula:** calls/day per provider = A × R_a × K + C × R_c × K, where A is the number of addresses, C the number of chains and K the
checks per day. A month is 30 days.

| scenario | A (N × M) | C | cadence (K) | calls/day | calls/month |
|---|---|---|---|---|---|
| **S1: USX today** | 1 × 4 = 4 | 1 | hourly (24) | 4×10×24 + 1×2×24 = 960 + 48 = **1,008** | **30,240** |
| **S2** | 10 × 10 = 100 | 3 | hourly (24) | 100×10×24 + 3×2×24 = 24,000 + 144 = **24,144** | **724,320** |
| **S3** | 10 × 10 = 100 | 3 | 15 min (96) | 100×10×96 + 3×2×96 = 96,000 + 576 = **96,576** | **2,897,280** |

**Alchemy** (assuming `eth_call` and `eth_getStorageAt` are each 26 CU, which is UNVERIFIED, and `eth_getLogs` is 60 CU):
- **S1:** (960×26 + 24×60 + 24×26) × 30 ≈ (24,960 + 1,440 + 624) × 30 ≈ **0.81M CU/month**. Free.
- **S2:** (24,000×26 + 72×60 + 72×26) × 30 ≈ (624,000 + 4,320 + 1,872) × 30 ≈ **18.9M CU/month**. Under the 30M free tier.
- **S3:** (96,000×26 + 288×60 + 288×26) × 30 ≈ (2,496,000 + 17,280 + 7,488) × 30 ≈ **75.6M CU/month**.
  - Above the free tier.
  - At $0.45–$0.525 per 1M CU, the upper bound (all CU billed) is **$34–$40/month**.
  - Whether the free allotment is netted against PAYG is **unknown**.
- **Throughput:** S3's peak is the whole 1,000-read cycle. Spread over the 15-minute window, that is ≈ 1.1 calls/s ≈ 29 CU/s, well
  under 300 CU/s.

**Infura** (free 3M credits/day; credits per call UNKNOWN). The break-even is 3,000,000 / calls per day:
- S1 needs < 2,976 credits per call;
- S2 needs < 124;
- S3 needs < 31.
- S1 is very likely free. S2 is free only if typical calls cost under ~124 credits. S3 probably needs a paid tier (price unknown).

**Ankr** (200M credits/month; credits per request UNKNOWN). The break-even is 200,000,000 / calls per month:
- S1 needs < 6,614 credits per request;
- S2 needs < 276;
- S3 needs < 69.

**Scroll public RPC:**
- S1 is ≈ 0.012 req/s average and S3 ≈ 1.1 req/s.
- Even the most pessimistic third-party figure (100 req/min ≈ 1.7 req/s) would carry S3 on average, but with no SLA and no terms read.
- Use it only as a **tie-breaker third source**, not as a primary.

**Other costs (not RPC):**
- **Compile jobs:** worker CPU, on change only.
- **Storage:** chain observations are about 0.5 KB per row of metadata, plus small value blobs. S3 writes ≈ 96,576 rows/day ≈
  2.9M rows/month ≈ 1.5 GB/month **before** deduplication.
- **Design consequence:** store a row only when a value *changes*, and an hourly "unchanged" summary row per address otherwise. That
  brings S3 to ≈ 100 addresses × 24 = 2,400 rows/day ≈ 72k rows/month.
- **AI:** only through the budget gateway's existing hard caps ($25/month in total). Monitoring adds no budget.

**Bottom line:**
- USX alone (S1) at hourly cadence plausibly costs **$0 in provider fees** on two free tiers.
- Ten programmes × ten addresses (S2) is plausibly still free on Alchemy and borderline on the others.
- 15-minute cadence at that size (S3) is **roughly $35–$40/month** on Alchemy by the assumptions above.
- Every figure must be re-checked against the live pricing pages before approval.

### H.4 Redundancy and quorum

- **Two independent providers** for every critical read: implementation, admin, beacon, owner, pending owner, Safe owners and
  threshold, facet set, code hash. Each read is made at the **same block number**, and the **block hash** is compared first.
- **Agreement** (same block hash, same value) is `quorum 2/2`.
- **Disagreement** on the value at the same block hash means one provider is wrong or lying. It is recorded as
  `rpc_disagreement`, raised as an alert, and resolved by a third source (Scroll public RPC). **No change is declared** from a single
  provider's critical value.
- **Different block hashes** at the same height mean a reorg or a lagging node. Retry at a deeper confirmation.
- Non-critical parameters may use one provider, with a daily quorum reconciliation.

### H.5 Reorgs and finality

- **Ethereum L1:** read at the `finalized` block tag (about two epochs, ≈ 13 minutes).
- **Scroll (a zk rollup):**
  - Its sequencer can in principle reorder unconfirmed blocks.
  - L1-finality comes when the batch proof is finalised on Ethereum, which third-party guides describe as "a few minutes" to longer.
  - **Whether Scroll's RPC supports the `finalized` and `safe` tags, and its typical finalisation delay, are unknown.**
  - DESIGNED default: use `finalized` if supported. Otherwise use a confirmation depth set by the owner (for example 300 L2 blocks) and
    label results "L2-confirmed, not L1-final".
- **LayerZero destination chains (if confirmed):** each chain's own finality rule.
- **Alerts:**
  - A "critical change" alert may be raised early at `latest − small depth`, labelled **unconfirmed**.
  - It becomes confirmed only at the finality rule.
  - It is withdrawn (append-only `withdrawn` state) if the block hash at that height changes.

### H.6 Missed-event detection, recovery and continuity

- **Checkpoints:** per (chain, provider, filter), the last fully scanned *finalised* block. A window is marked scanned only when every
  chunk answered.
- **Splitting:** when a provider refuses a range or a result is too large, halve the range and retry.
- **Cross-checks:** both providers' log results for a window must contain the same (tx hash, log index) set. A difference is a gap alert.
- **Gap backfill:** on restart, outage or provider change, re-scan from the checkpoint. Nothing is assumed about the missing range.
  Operations shows the uncovered range until it is filled.
- **Reconciliation** (daily, §B.8) catches what events cannot.
- **Continuity:**
  - checks are idempotent (keyed by chain, block and subject);
  - the job is stateless apart from the database, so a crashed job resumes from the checkpoints;
  - backoff and disable-after-N reuse the `repository_monitors` mechanics;
  - a provider failing N times is marked degraded and the other provider continues;
  - **a single-provider period is labelled "no quorum"**, and no critical change is declared from it alone.

---

## I. Security and permissions (DESIGNED)

### I.1 Everything new

| item | kind | required for | notes |
|---|---|---|---|
| RPC host(s), e.g. `scroll-mainnet.g.alchemy.com`, an Infura/Ankr Scroll host, `rpc.scroll.io` | outbound hosts | M3+ | must go through `outboundFetch` (`net/outbound.ts`, the SSRF policy: HTTPS on 443, public IPs, pinned peer); the hosts are fixed configuration, never derived from data |
| explorer / verification hosts (Blockscout, Sourcify; Etherscan v2 if Scroll is still served) | outbound hosts | §C.6 | low volume |
| RPC API keys (one per provider) | **secrets** | M3+ | read-only keys, not wallet keys; stored as Fly secrets by pipe, never in the repository, in `fleet.json` env or in logs; redacted by `redactText`/`redactSecrets` (extend the shape list to the key formats). Keys embedded in URLs must be redacted wherever errors are logged |
| explorer API key (if any) | secret | §C.6 | same |
| pinned solc binaries (per version used by in-scope programmes) | dependency | §C | in the worker/tools image, hash-pinned, never downloaded at run time |
| a CBOR decoder | dependency | §C | small, pinned; or hand-written for the subset needed (preferred: fewer dependencies) |
| `chain-monitor` scheduled job | service | M3+ | a new `deploy/fleet.json` machine (role `job`), gated like `bounty-monitor` |
| compile job | worker step | §C | runs under option D (not approved for activation) |

### I.2 Minimum access

- **No private keys, ever.** No wallet, no signer, no `eth_sendTransaction` or `eth_sendRawTransaction`, no `eth_sign*`, no
  `personal_*`.
- **Client allow-list:** the RPC client exposes only the read-only methods listed in §B.0. A test scans for anything else (like the
  `outbound.test.ts` bypass scan).
- **Read-only provider keys:** where a provider supports key restrictions (allowed origins or IPs, method allow-lists, per-key spend
  caps), use them. Whether each provider supports this is **unknown**.
- **No active testing:** nothing is ever sent to a deployed contract except `eth_call` to view functions at a historical block.
  `scope-guard.ts`'s active-testing gate is not touched and stays fail-closed.
- **No contact** with a project, its multisig signers or its infrastructure beyond public RPC reads.

### I.3 Where it runs

| work | where | why |
|---|---|---|
| chain reads, checkpoints, quorum, reconciliation, change records, alerts | **collector-style job in the hub app** (like `bounty-monitor`), with the database connection | inputs are small, structured JSON from fixed hosts; strictly parsed (hex length checks); no untrusted code; mirrors existing collectors |
| repository change detection | the existing `bounty-monitor` job | unchanged placement |
| compilation of untrusted Solidity | **worker under option D** (isolated, no database credential, run-scoped token) | solc on untrusted input is tool execution, like Slither/Foundry |
| byte normalisation and comparison, closure, `change_impact` | API (D3-style recompute, bounded child process) | deterministic; API-derived |

### I.4 Risks

| risk | consequence | mitigation |
|---|---|---|
| **RPC provider lies or censors** (returns a stale or forged value, drops logs) | a false "no change", or a false alert | two-provider quorum at the same block hash; a third tie-breaker; log-set cross-check; daily reconciliation; nothing declared from one provider |
| **compromised worker forges a compiled artifact** | false `matched` | comparison API-derived; compilation labelled `worker_reported`; explorer/Sourcify signal as an independent check; later an isolated compile service |
| **key leakage** (URL-embedded keys in logs, errors, the timeline) | quota theft, cost | secrets only by pipe; redaction of key shapes; per-key caps where offered; rotation runbook; keys never sent to the worker |
| **cost overrun** | unexpected bill | prefer free tiers with hard daily caps (Infura: 402 at the cap; Etherscan: blocked at the daily limit unless overage is on); a monthly call budget in the job itself (refuse beyond it, record `not_checked(budget)`); cadence set per programme by the owner |
| **alert flooding** (a noisy parameter, a reorg storm, a provider flap) | real alerts lost | one change record per (subject, value transition); unconfirmed alerts collapse into the confirmed one; provider-health alerts kept separate from protocol alerts; per-programme rate limit on notifications; severity classes set by the owner |
| **scope creep** (reading addresses not in scope) | terms or ethics breach | only M1 official rows are read; derived dependencies (owner Safes, token approvals) need an explicit owner decision per programme |
| **false sense of security** | "no alert" taken to mean "safe" | blind-spot list always shown (§G.3); "no alert" never displayed as green without the coverage metrics beside it |
| **owner connection bypass (S11)** | evidence rewritable | unchanged from today; the evidence hash chain proposed in the worker decision applies here too |

### I.5 Robots.txt and terms

- RPC JSON-RPC endpoints are APIs used under each provider's terms. **The terms must be read and recorded before use** (not done; see
  §H.0).
- Explorer **web pages are never scraped**. Only documented APIs are used, within their published limits, with robots.txt honoured for
  any page fetch, as `enrich.ts` does.
- The same access-status vocabulary as `bounty_sources` (`permitted`, `owner_decision_required`, `blocked_terms`, …) is DESIGNED for
  each provider record, so a provider whose terms forbid this use cannot be enabled.

---

## J. Proposed implementation sequence (small, gated phases)

Each phase ends with tests on disposable databases, an owner review and an explicit go or no-go. Nothing in a later phase starts before
the earlier one is approved.

| phase | content | network | schema | approvals needed |
|---|---|---|---|---|
| **M0: offline bytecode verification for USX** | a pure library: CBOR suffix parsing and stripping; immutable masking from `immutableReferences`; library masking; the §C.4 state machine. Tested on **self-compiled fixtures** (with and without immutables, libraries, a proxy and a facet), then on **one USX runtime bytecode that the owner records** and supplies as a file, compared with a compilation from the sealed snapshot of `9e972566…` | **none** (no RPC; the snapshot comes from the already-approved USX run) | none | the owner supplies or approves the recorded bytecode and its provenance; USX acquisition must have happened (it is part of the approved run, not of this design) |
| **M0b: dependency acquisition** | acquire `lib/` submodules at their gitlinks, as D2-verified content, so §C.2 can compile | GitHub (existing) | none | acquisition change review |
| **M1: repository-side changes** | carry `bounty_scope` into monitor-created runs; `classify_change` (meaningful-change filter); closure (`change_impact`) without storage layout; dossier `change_impact` section; lead key view | GitHub (existing) | outcome values on `repository_monitor_checks` (migration) | migration approval; deploy |
| **M2: baselines** | `programme_baselines` (or A29 decisions); operator action "accept baseline" | none | M2 | A29/A4b ordering decision; migration |
| **M3: read-only chain client, offline-tested** | method allow-list; quorum; checkpoints; reorg rules; replay tests on **recorded fixtures** (no live endpoint) | none | M1, M3 (disposable DBs only) | design review |
| **M4: live reads, one programme, one chain** | USX on Scroll, S1 cadence (hourly), two providers | **new hosts and keys** | M1, M3, M4 applied | provider choice, terms review, hosts, keys, cadence, alert routing, finality rule (§L) |
| **M5: live bytecode verification** | M0 on live reads at finalised blocks; worker compile under D | as M4 | M5 | option D activation |
| **M6: Operations monitoring view** | §G, read-only | none | none | UI review |
| **M7: change-focused investigations** | triage decisions; investigation runs with the baseline re-acquired; capability assignment from the closure | as before | depends on A29/A4b | AI budget unchanged; owner sets the severity → action policy |
| **M8: more programmes / chains** | only after M4–M7 have run for a period with measured false-alert and miss rates | per chain | none | per programme and chain |

---

## K. Limitations and risks (summary)

- **No baseline exists today** for any programme. The USX run has not happened.
- **The repository monitor's "incremental" is a label today.** This design makes it real, but the analysis stays whole-snapshot by
  choice (§A.3).
- **Event monitoring cannot see writes without events.** Only reconciliation narrows that gap, and A→B→A within one poll interval stays
  invisible if events are also missed.
- **Bytecode verification** depends on acquiring dependencies and on pinning compiler settings exactly. Many real projects will be
  `unverifiable` at first. Compilation is worker-reported under D.
- **Storage-layout and diamond-facet reasoning are not in the protocol model today.** Both are DESIGNED increments. Until they exist,
  any layout or facet change forces a full rescan plus human review.
- **Chains:** only Scroll is evidenced for USX. OFT and L1 deployments are unconfirmed.
- **Providers:** every figure is from search summaries. Terms were not read, and per-method costs are largely unknown.
- **Scroll finality semantics through RPC are unknown.**
- **Non-actions, coverage and outcomes** are durable and queryable only once A29 and A4b are applied.
- **Option D is not activated.** Anything needing worker compilation waits for it.
- **The owner connection (S11) can still rewrite evidence**, as it can today.
- **APEX stays shadow and is never evidence.** Real Foundry reproduction is unproven.
- **Monitoring can create a false sense of security.** The blind-spot list is mandatory in the view.

---

## L. Decisions requiring the owner's approval

1. **Adopt this design** as the direction for monitoring, as an extension of the existing architecture.
2. **M0:** approve offline bytecode verification for USX, and the provenance of the recorded USX runtime bytecode(s) (who records them,
   from where, at which block).
3. **The baseline policy:** the first baseline is the official scope commit, after a dossier plus human acceptance. Supersede only by
   human acceptance. Decide whether to record it as `programme_baselines` (M2) or as A29 decisions.
4. **The order of A4b (0009) and A29 (0010) relative to monitoring**, since non-actions and coverage depend on them.
5. **Migrations M1–M5**, each separately, plus the new `repository_monitor_checks` outcome values.
6. **Chains and addresses:** confirm which contract each of the four USX Scroll addresses is. Confirm whether OFT chains and L1 are in
   scope; no read happens before that.
7. **Derived dependencies:** whether owner and admin Safes, timelocks, linked libraries and token-approval logs of non-scope contracts
   may be read because they hold authority over, or relate to, in-scope addresses.
8. **Providers:** choose two plus a tie-breaker, **after** each provider's terms and pricing are read directly and recorded. Approve the
   hosts and the read-only API keys (secrets).
9. **Cadence** per programme (S1 hourly suggested for USX), and a monthly RPC call or spend cap enforced by the job.
10. **The finality rule** for Scroll (the `finalized` tag if supported, otherwise a confirmation depth), and whether unconfirmed early
    alerts are shown.
11. **Alert routing and severity classes:** which changes are critical, and who is notified, and how. No notification channel exists
    today.
12. **Dependency acquisition** (submodules) for compilation (M0b).
13. **Where compilation runs:** the worker under D (worker-reported), or a separate isolated compile service.
14. **Explorer use:** whether to use Blockscout or Sourcify (and Etherscan v2, if it still serves Scroll) as secondary signals.
15. **The full-rescan triggers** in §D.5, including the analyser-version and baseline-age thresholds.
16. **The new `MetricKind: "monitoring"`** and the programme-level Operations page.

---

## Sources (provider pages, as returned by web search on 2026-11-28; not fetched directly)

- Alchemy pricing: https://www.alchemy.com/pricing ; pricing plans: https://alchemy.com/docs/reference/pricing-plans ; PAYG billing: https://support.alchemy.com/articles/2300474614-understanding-alchemy-s-pay-as-you-go-billing-model ; free tier: https://www.alchemy.com/support/free-tier-details
- Alchemy compute-unit costs: https://www.alchemy.com/docs/reference/compute-unit-costs ; third-party CU table (eth_call 26, unverified): https://docs.rs/chainrpc-core/0.1.0/src/chainrpc_core/cu_tracker.rs.html
- Alchemy Scroll: https://www.alchemy.com/rpc/scroll.md , https://www.alchemy.com/docs/reference/scroll-chain-api-faq
- Infura / MetaMask Developer pricing: https://docs.metamask.io/services/get-started/pricing/ ; daily limits: https://support.metamask.io/develop/account/limits/daily-limits/ ; Scroll methods: https://docs.metamask.io/services/reference/scroll/json-rpc-methods/
- QuickNode pricing: https://www.quicknode.com/pricing ; free-trial term: https://support.quicknode.com/articles/5387074982-1-month-free-trial ; Scroll: https://www.quicknode.com/api-credits/scroll
- Ankr Scroll: https://www.ankr.com/web3-api/chains-list/scroll/ ; service plans: https://www.ankr.com/docs/rpc-service/service-plans ; changelog: https://www.ankr.com/docs/changelog/public-tier-chains-2026-08-31/
- Etherscan v2 rate limits: https://docs.etherscan.io/resources/rate-limits ; pricing: https://etherscan.io/api/pricing ; supported chains: https://docs.etherscan.io/etherscan-v2/supported-chains ; changelog (Scroll deprecation 2026-04-16): https://docs.etherscan.io/changelog/
- Sourcify API (v2; v1 shut off 2026-07-07): https://docs.sourcify.dev/docs/api/
- Blockscout Scroll (existence, via GoldRush): https://goldrush.dev/docs/chains/scroll
- Scroll public RPC and finality (third-party): https://dev.to/onfinality/scroll-rpc-provider-key-criteria-for-production-dapps-4gj0 , https://onfinality.io/networks/scroll

Repository files cited: see §0 (all paths relative to the repository root at `0d4ee1d`).
