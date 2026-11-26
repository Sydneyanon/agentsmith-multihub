# Protocol model P3 (privileged roles and trust boundaries): evidence for owner review (2026-11-26). P4 is NOT started; it awaits this review.

**Scope approved:** P3 only (owner, 2026-11-26).

**Built:**
- `apps/api/src/analysis/solidity/authority.ts` (`authority/1`).
- Part of the content-addressed protocol model, now `protocol-model/3` / builder `solidity-p3/1`.
- **No migration.**

## What P3 represents (owner list), each element with exact code locations
| Element | How it is represented | Basis |
|---|---|---|
| Privileged roles and authority relationships | P2 authority variables with strength (name-only stays **weak** and is listed as unresolved), holder kind (single address, membership table, role table, contract reference) | inferred, rule-tagged |
| Access-control checks and their enforcement | every authorising check on an entry point: function, line, what it reads, `reverting` or `early-return`, and **side** (below). Described, **never certified** ("caller-guarded" means a check exists on the path, not that it is correct) | inferred from the trace |
| Ownership and administrative transfer | every writer of each authority variable with its control (`constructor`, `one-time-initialiser`, `guarded` by which role, or `open`) and line; transfer summarised as `fixed-after-deployment`, `by-holder`, `by-other-role`, `initialiser-only`, `open-writer` or `mixed` | inferred |
| Role inheritance | roles and checks are computed in each **deployed** contract's dispatch context (inherited modifiers and overrides included) | inferred |
| Cross-contract authority | **guard side:** `caller-side`, `callee-side` (the check runs inside a contract this one calls, where `msg.sender` is this contract, so it is satisfied by this contract and is **not** a check on this function's caller) or `assumed` (unseen modifier). Library code runs in the caller's context and stays caller-side | rule `callee-side-check-satisfied-by-this-contract` |
| Factory-mediated authority | `new X(...)` deployments with lines; a child's authority **held by the deploying contract** (constructor records `msg.sender`, and the snapshot deploys it); cross-contract paths with the callee's checks, what the callee reaches (selfdestruct, ether, writes, delegatecall) and whether the outer function has a caller-side check | rule `constructor-records-caller+deployed-by-new-in-snapshot` |
| Proxy / implementation boundaries | fallback or receive delegatecalling a pointer, with the implementation resolved only from a typed pointer (otherwise `unresolved`), and every pointer writer with its control | established call, inferred resolution |
| Initialisation and reinitialisation | writers guarded by a **one-time flag** (a bool checked as unset, or a number or address checked against zero, then set), and whether the constructor sets the flag (`lockedInConstructor`) | inferred |
| External trust assumptions | checks from unseen modifiers, and authorising conditions that read no state of this contract (an external call decides) | explicit |
| Unresolved paths | unseen-modifier checks, unresolvable implementations, name-only authorities: each with its location | explicit |

## Consumers replaced or added (after equivalence or improvement was shown)
1. **The specialists' private "guarded before this statement" logic** now uses the shared guard-side rule: a callee-side check no longer protects the outer function. This is the **only** behavioural change to findings.
2. **The dossier** shows, per component:
   - each authority with strength, holder, deploying-contract holder, transfer mechanism and writers (control and line);
   - open authority writes;
   - callee-side checks;
   - cross-contract paths;
   - proxy boundaries;
   - initialisation controls;
   - trust assumptions;
   - unresolved authority.

## Comparison with pre-P3 (P2 at `7aad0d7`)
| Source | TP / FP / FN before → after | Validator verdicts | Other |
|---|---|---|---|
| dev corpus | 17/0/0 → 17/0/0 | identical | — |
| corpus 1 | 18/0/0 → 18/0/0 | identical | — |
| corpus 2 | 31/8/6 → 31/8/6 | identical | — |
| corpus 3 (development data) | 18/1/13 → **20/1/11** | identical | two previously missed labels now found: `VaultFactory.retireVault` (selfdestruct) and `YieldController.setVaultStrategy` (access control). **No new false positive** |
| corpus 4 | per-label results **identical** to the scored candidate 3 (aggregate check only; labels not inspected; nothing tuned) | identical | — |
| `not-so-smart-contracts` | leads identical (34) | — | — |

## The improvement (owner requirement): failure class C fixed at its cause
**Root cause.** The tracer inlines a typed call into another snapshot contract. A `require(msg.sender == factory)` inside the callee was
therefore treated as protecting the **outer** function, which the factory satisfies itself.

**Fix.** The shared guard-side rule.

**Evidence:**
- **Fixture** (factory deploys a child; the child's `retire` checks `msg.sender == factory` and self-destructs; `Factory.retire` has no
  check): the pre-P3 analyzer (`7aad0d7`) reports **nothing**, and P3 reports `Factory.retire` (selfdestruct). The guarded twin is **not**
  flagged.
- **EVM ground truth:** the fixture compiled with solc and executed. An unrelated account calling `Child.retire` directly **reverts**;
  the same account via `Factory.retire` **succeeds** and selfdestruct executes.
- **Corpus 3** (development data, inspected earlier): two labelled-vulnerable misses of this shape are now found, with no new false
  positive. This is **development evidence**, not a held-out measurement. The next held-out claim needs corpus 5.

## Determinism
Two independent clone acquisitions of `crytic/not-so-smart-contracts` @ `020dbdb`, full pipeline each, gave an identical model
`86ebff12…` and identical dossier content `75969193…` (`eval/real-runs/not-so-smart-contracts/run7-p3-*`).

## Quality corrections made during the gate (caught by the real repository)
- **Protected-branch modifiers.** A write behind an `if (msg.sender == creator) _;` modifier (pre-0.5 style) was first classified
  `open`. It now honours the tracer's protected-branch flag. `Rubixi.changeOwner` is guarded, while `Rubixi.DynamicPyramid`, the
  wrong-constructor bug, is correctly an **open writer**.
- **One-time flags.** The first initialiser rule accepted any "guard reads V, then V is written" (for example `RaceCondition.buy` with
  `price`). It now requires an unset check on a bool, or a zero check on a number or address. Negative fixtures and mutants pin both
  fixes.

## Tests
- **Behavioural fixtures:** 18 in `authority.test.ts`, covering direct (positive, open-writer negative), inherited, protected-branch,
  factory-mediated (open and guarded twins, specialist finding), proxy (unresolved, open-upgrade negative), initialiser (unlocked,
  constructor-locked, price negative, zero-check), unseen-modifier and external assumptions, library checks, name-only authority, and
  determinism. Plus dossier assertions in the workflow integration test.
- **Mutation testing:** P3 spec **15/15** killed; analyzer 36/36, P2 12/12, P1 18/18 still killed.
- **Full verify:** 842 unit tests, 254/254 integration as owner and as restricted role. Frozen records unchanged. (The production build-output guard caught a source comment that read like a dynamic require; the comment was reworded, and the guard was not changed.)

## Limitations and unresolved authority paths
- **Open writers include intended open transfers.** A paid `buy` that makes the payer owner is an open writer: a fact, not a judgement
  (29 open authority writes on the real repository).
- **Proxy implementation types.** The implementation is resolved only from a typed pointer variable. Address-typed or constant
  pointers, such as the Parity `Wallet` with `_walletLibrary`, stay `unresolved`, so the implementation's surface and storage layout are
  not established (failure classes D and E remain).
- **Proxy storage.** EIP-1967 slots in inline assembly are not modelled (class B); slot-based admins and implementations are invisible.
- **Cross-contract paths need typed calls.** A path is found only when the call is typed and resolves to a snapshot contract; calls
  through an interface or an address cast are not followed. Factory-held authority needs an in-snapshot `new`; factories outside the
  snapshot, `create2` through assembly, or clones (EIP-1167) are not recognised.
- **Indirect owner structures.** Owner sets checked through index casts or arrays (Parity `m_ownerIndex`) are not recognised as roles
  (inherited from P2).
- **One-time flags.** Only an unset check on a bool, or a zero check on a number or address, is recognised. Versioned reinitialisers
  (`reinitializer(n)`), and initialisers whose guard is in an unseen modifier (which become assumptions), are not classified as
  initialisers.
- **No security judgement.** P3 states which checks exist and where they run. It does not judge whether a role is too powerful or
  whether a check is correct; that remains the specialists' and the challenge's job.
- **Two cross-contract features unexercised on the real repository.** It is old educational code with no callee-side checks or factory
  paths; that evidence comes from fixtures and corpus 3.

## P3 closeout review (2026-11-26, after `09662af`)
**What was reviewed.** The P3 diff and this record. Checks: guard-side classification used the same way in every consumer;
protected-branch, inherited, initialiser, factory and proxy behaviour; parallel authority or guard derivations that could disagree with
`protocol-model/3`; the evidence for the two corpus-3 gains; how the open authority writers are presented; determinism. No frozen record
was changed.

### Discrepancies found
| Id | Discrepancy | Effect | Resolution |
|---|---|---|---|
| **D1** | P1's `callerGuarded` flag counted a **callee-side** check as a guard on the outer function. P3 and the specialists did not. | `Factory.retire`-style entry points were shown as caller-guarded in the model's function list (dossier architecture section) while P3 said "open". | **Fixed.** `protocol-model.ts` uses `guardSide()` from `authority.ts`. Test: `authority.test.ts` "P3 closeout". |
| **D2** | P2's `authorising-guard-read` role was taken from **any** guard on the trace, including checks inside a called contract. A parent's variable with the same name as the child's (`factory`) became an authority because the CHILD checked its own copy. | Wrong authority role on the parent, a P3 input. | **Fixed.** Only checks that run in the component itself (or a library it uses) give its variables an authority role. Test added. |
| **D5** | P3 took writers from **internal and private** functions analysed on their own, so an `internal onlyInitializing` helper was reported as an open owner writer. | One spurious open writer in corpus 3 (`MembershipPointsV1.__Ownable_init`); none in the other corpora or the real repository. | **Fixed.** P3's inputs are the callable surface (public/external) and constructors; internal helpers are seen inlined in their callers' traces. Test added (`_setOwner` reached by a one-time `initialize`, an owner-only transfer and an open `grab`: only `grab` is open). |
| **D3** | The initializer specialist (`specialists.ts`, `initializer()`) keeps its own one-time-flag rule ("a guard reads a variable written later on the path"), looser than P3's `isUnsetCheck`. | Two derivations of the same concept can disagree (failure class G: `require(v > currentVersion)` passes as one-time in the specialist). | **Open, not changed.** Replacing it changes findings, so it needs an equivalence study on development data first (backlog T-185). |
| **D4** | The access-control and initializer specialists gate on **function names** (`PRIV_NAME`, `INIT_NAME`), alongside P3's name-independent open-writer facts. | Measured below. | **Open, not changed** (backlog T-185). |

**D4 measured** (function level: P3 open authority writers vs. specialist access-control/initializer leads; corpus 4 not used):

| Source | P3 open-writer functions | Specialist functions | Both | P3 only | Specialist only |
|---|---|---|---|---|---|
| dev | 3 | 7 | 3 | 0 | 4 |
| corpus 1 | 3 | 8 | 3 | 0 | 5 |
| corpus 2 | 9 | 25 | 9 | 0 | 16 |
| corpus 3 | 6 (7 before D5) | 16 | 6 | 0 (1 before D5) | 10 |
| `not-so-smart-contracts` | 10 | 16 | 10 | 0 | 6 |

Every P3 open writer also has a specialist lead, so P3 adds no unreported authority write. The "specialist only" cases are mostly outside
P3's scope: privileged operations that are not authority writes (`mint`, `setFee`, payouts, `sweepTo`). Some are authority writes P3
classifies differently, for example the Parity `WalletLibrary.init*` functions, whose authority (`m_owners`) P2 does not recognise (see
Limitations). Reducing the specialists' dependence on names is a findings-changing step and is not done here.

### Regression after D1, D2 and D5
| Source | Result vs. `09662af` |
|---|---|
| dev, corpora 1–3 | per-label results, finding counts (18, 18, 49, 30) and validator verdicts **identical** |
| corpus 4 | per-label results **identical** to the frozen candidate-3 record (aggregate check only; labels not inspected; nothing tuned) |
| `not-so-smart-contracts` @ `020dbdb` | 34 leads and 29 open authority writes, unchanged. The model content is byte-identical: with the builder id unchanged it reproduced `86ebff12…` on both clones. |

The builder id is now `solidity-p3/2`, because the fixes change the model for some inputs (corpus 3). The real-repository model is
`99b9cb66…` on both independent clones; the only difference from `86ebff12…` is the builder id. The schema stays `protocol-model/3`.
Mutation checks: P3 spec 18/18 killed, including one mutant for each of D1, D2 and D5.

### The two corpus-3 gains: what kind of evidence they are
`VaultFactory.retireVault` and `YieldController.setVaultStrategy` are **corpus labels** in development data that was inspected before
P3. They are not discoveries and not independently confirmed vulnerabilities. They now have a reproducible execution record.
`eval/ground-truth/crosscontract-heldout3.mjs` compiles the **unchanged** corpus files with solc 0.8.28 and runs them in an in-memory EVM
with no network (`unshare -rn`). The safe twin of each serves as a negative control. Result: `eval/adjudications/heldout3-crosscontract-ground-truth.json`
(two runs byte-identical).

| Case | Unrelated account, direct call to the guarded callee | Same account through the outer entry point | Outcome |
|---|---|---|---|
| `VaultFactory.retireVault` | `ClientVault.retire` reverts | succeeds | 10 ETH client balance swept to the factory treasury |
| `ManagedVaultFactory.retireVault` (twin) | reverts | reverts | balance kept |
| `YieldController.setVaultStrategy` + `harvestAndEarn` | — | both succeed | 10 ETH vault balance moved into the caller's own strategy |
| `StrategyController.setVaultStrategy` (twin) | — | reverts | balance kept |

Caveats. This shows execution under the corpus's own deployment assumptions (Shanghai, pre-Cancun; the harness stops at the EVM call, so
code deletion by `selfdestruct` is not observed, only the fund movement). AgentSmith's own validators are single-contract interpreters
and do **not** validate either lead. **Status: development fixture evidence, reproduced by execution; no human adjudication; no
independent reviewer.**

### The 29 open authority writes on the real repository: observations, not findings
Each row is a fact of the code ("no caller-side check on the path"), not a judgement. Many are intended. They fall into 10 functions;
20 of the writes are per-channel state in SpankChain `LedgerChannel`, which P2 treats as an authority because guards read the channel's
party addresses. The others include an intended paid ownership transfer (`RaceCondition.buy`, `CEOThrone.Stake`), honeypot set-ups and
known educational samples (`Unprotected.changeOwner`, wrong constructor names). The specialist lead column shows only that a lead exists
on the same function, not that it is correct. None of these is independently confirmed by this project.

| Function | Variable | Location | Specialist lead on the same function |
|---|---|---|---|
| `CEOThrone.Stake()` | `owner` | honeypots/KOTH/KOTH.sol:22 | access-control |
| `LedgerChannel.closeVirtualChannel(bytes32,bytes32)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:724 | access-control |
| `LedgerChannel.closeVirtualChannel(bytes32,bytes32)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:730 | access-control |
| `LedgerChannel.closeVirtualChannel(bytes32,bytes32)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:731 | access-control |
| `LedgerChannel.closeVirtualChannel(bytes32,bytes32)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:733 | access-control |
| `LedgerChannel.closeVirtualChannel(bytes32,bytes32)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:734 | access-control |
| `LedgerChannel.closeVirtualChannel(bytes32,bytes32)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:736 | access-control |
| `LedgerChannel.closeVirtualChannel(bytes32,bytes32)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:737 | access-control |
| `LedgerChannel.closeVirtualChannel(bytes32,bytes32)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:739 | access-control |
| `LedgerChannel.closeVirtualChannel(bytes32,bytes32)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:740 | access-control |
| `LedgerChannel.consensusCloseChannel(bytes32,uint256,uint256 [ 4 ],string,string)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:523 | access-control |
| `LedgerChannel.createChannel(bytes32,address,uint256,address,uint256 [ 2 ])` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:391 | access-control |
| `LedgerChannel.createChannel(bytes32,address,uint256,address,uint256 [ 2 ])` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:392 | access-control |
| `LedgerChannel.createChannel(bytes32,address,uint256,address,uint256 [ 2 ])` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:396 | access-control |
| `LedgerChannel.createChannel(bytes32,address,uint256,address,uint256 [ 2 ])` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:399 | access-control |
| `LedgerChannel.createChannel(bytes32,address,uint256,address,uint256 [ 2 ])` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:401 | access-control |
| `LedgerChannel.createChannel(bytes32,address,uint256,address,uint256 [ 2 ])` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:404 | access-control |
| `LedgerChannel.createChannel(bytes32,address,uint256,address,uint256 [ 2 ])` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:405 | access-control |
| `LedgerChannel.createChannel(bytes32,address,uint256,address,uint256 [ 2 ])` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:408 | access-control |
| `LedgerChannel.createChannel(bytes32,address,uint256,address,uint256 [ 2 ])` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:409 | access-control |
| `LedgerChannel.deposit(bytes32,address,uint256,bool)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:466 | reentrancy, access-control |
| `LedgerChannel.deposit(bytes32,address,uint256,bool)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:469 | reentrancy, access-control |
| `LedgerChannel.deposit(bytes32,address,uint256,bool)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:476 | reentrancy, access-control |
| `LedgerChannel.deposit(bytes32,address,uint256,bool)` | `Channels` | reentrancy/SpankChain_source_code/SpankChain_Payment.sol:479 | reentrancy, access-control |
| `Missing.IamMissing()` | `owner` | wrong_constructor_name/incorrect_constructor.sol:16 | access-control |
| `NEW_YEARS_GIFT.SetPass(bytes32)` | `sender` | honeypots/GiftBox/GiftBox.sol:24 | access-control |
| `RaceCondition.buy(uint)` | `owner` | race_condition/RaceCondition.sol:42 | access-control |
| `Rubixi.DynamicPyramid()` | `creator` | wrong_constructor_name/Rubixi_source_code/Rubixi.sol:17 | access-control |
| `Unprotected.changeOwner(address)` | `owner` | unprotected_function/Unprotected.sol:21 | access-control |

## Decision for the owner
- **Accept or reject the P3 milestone.**
- **P4 and broader protocol modelling** (assets, value flows, state transitions) are **not started** and need explicit approval.
