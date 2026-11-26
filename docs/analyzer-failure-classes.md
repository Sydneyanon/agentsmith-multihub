# Analyzer failure classes from corpus 3 (and corpus 2), 2026-11-26

**Scope.** The corpus-3 misses and false positives in the three weak classes (initializer, delegatecall/proxy, selfdestruct), the two
disputed reentrancy validations, and the corpus-2 residue in the same classes.

**Evidence status.** Corpus 3 was inspected only after it was scored. Every re-score below is **development evidence, not a held-out
measurement**. The next honest measurement is the sealed corpus 4 (`eval/heldout4`), scored once by a candidate registered before
scoring. Candidate 2 and every frozen record are unchanged.

## Failure classes

| Id | Class | Evidence (case → effect) | Status |
|---|---|---|---|
| **A** | **Inherited entry points were analysed in the declaring base, not in the deployed contract**, so virtual dispatch was lost. A base `upgradeToAndCall` calling a virtual `_authorizeUpgrade` saw no body. Internal calls and modifiers also switched context to the callee's declaring contract. | c3 `EmissionsControllerV1.upgradeToAndCall` → FP (owner-guarded override ignored); c3 `RewardsControllerV1.upgradeToAndCall` → right only by accident (the empty override was never seen) | **Implemented.** Deployed contracts are analysed with their whole surface in their own context; abstract bases are analysed only through the contracts that deploy them; one statement is reported once. 5 dev fixtures, 4 of which fail on the old code. c3 FP 2 → 1. |
| **B** | **Inline assembly is not analysed.** Admin and implementation addresses kept in EIP-1967 slots via `sstore`/`sload` are invisible as privileged state and as guards. | c3 `AdminSlotProxy.changeAdmin` (FN, open admin-slot write); c3 `RewardsControllerV1.upgradeToAndCall` initializer-class label (FN: the slot write is unseen) | **Designed, not implemented.** Parse Yul `sstore(slot, v)`, `sload(slot)` and `delegatecall(...)` inside `assembly` into trace events on a pseudo-variable named after the slot constant (`slot:ADMIN_SLOT`). Treat slot constants named `*ADMIN*`, `*IMPLEMENTATION*`, `*OWNER*` or `*BEACON*` as authorities. |
| **C** | **Transitive authority across contracts.** A guard `msg.sender == factory` is only as strong as the factory's own entry point. An unguarded factory function that calls the guarded one inherits its sensitivity. | c3 `VaultFactory.retireVault` → `ClientVault.retire` → `selfdestruct` (FN) | **Designed.** When the only guard is equality with an immutable set to the deployer, and that deployer is a contract in the snapshot that creates this one (`new`), analyse the creator's call sites of the guarded function as privileged operations of the creator. |
| **D** | **A proxy exposes its implementation's surface.** A fallback delegatecalling `msg.data` to a fixed implementation makes every unguarded state-changing function of the implementation a proxy entry point, run against the proxy's storage. | c3 `SharedWallet.fallback` → `WalletLibrary.initWallet` (FN, Parity class); c2 `Conduit.fallback` had the same shape | **Designed.** Resolve the implementation type from the state variable's declared type or its constructor assignment. Analyse the implementation's entry points in a "proxy context" and report on the proxy fallback. |
| **E** | **Storage-layout collision** between a proxy's own state variables and its implementation's. | c3 `SimpleUpgradeProxy.fallback` (FN) | **Designed.** Compare slot assignments of the proxy's non-constant state variables with the implementation's (where the type is resolvable). A shared slot with different meaning is a finding; EIP-1967 slots are exempt. |
| **F** | **Unlocked implementation contracts.** An implementation never disables its initialisers, so anyone can initialise the bare logic and use its own privileged paths, for example selfdestruct before Cancun. | c3 `PriceFeedAdapterV1.initialize`, `MarketLogic.initialize`, `MarketLogic.emergencyRetire` (all labelled **ambiguous** by the author) | **Designed, deliberately low priority.** The labels are judgement calls, and impact after Cancun is limited. Report as a lower-confidence lead with the Cancun caveat. |
| **G** | **A value check taken for a one-time guard.** `require(v > currentVersion)` followed by a write to `currentVersion` looks like an initialisation flag, but any caller passes it with a larger value. | c2 `Hub.upgradeTo` (FN) | **Designed.** A one-time guard must compare against a constant or boolean state, for example `!initialized` or `== 0`. A comparison with caller-supplied data is not one-time. |
| **H** | **Initializer detection is gated on names.** Only functions named like `init*`/`setup*` are examined, so `reconfigure`, which makes the same unguarded authority writes, is missed. | c2 `Staking.reconfigure` (FN) | **Designed.** The access-control specialist already covers unguarded authority writes; check why its gate (`auth.size > 0`, PRIV_NAME) excluded this case before widening anything, to avoid FP growth. |

## Validator (execution) defects found by the ground-truth adjudication

| Id | Defect | Evidence | Status |
|---|---|---|---|
| **V1** | **Inconsistent seeded state.** Ledgers were seeded but the totals kept alongside them were not, so honest calls underflowed or divided by zero, and that was reported as a refutation. | c3 `MerchantEscrow.release` (false "underflow"), `EtherShareVault.redeem` (false "division by zero"); see `eval/adjudications/` | **Implemented.** Any uint total updated with `+=`/`-=` in the same function as a ledger entry is seeded with the sum of the seeded entries. Dev fixtures: drain validated, safe twin refuted. c3 MerchantEscrow: refuted → **validated**. |
| **V2** | **"No exploit found" was reported as a refutation** while cross-function re-entry into a payable, exchange-rate function was never explored. | c3 `EtherShareVault.redeem` (real drain through `deposit()`) | **Implemented (soundness).** It is *inconclusive*, naming the target, when a payable function prices from the contract's ether balance or from an aggregate the entry function updates. Plain per-account deposits keep their refutation; the existing tests are unchanged. Modelling the cross-function exploit itself is designed (re-enter with the received value, then an exit call) but not implemented. |
| **V3** | **Named return variables** were unknown identifiers, so the validator gave up. | c3 `EtherShareVault.redeem` | **Implemented**, with a dev fixture. |

## Development-evidence re-score (working tree; NOT held-out)

| Corpus | Candidate 2 (recorded) | This change | Note |
|---|---|---|---|
| dev | 17/0/0 | 17/0/0 | unchanged |
| corpus 1 | 18/0/0 (after its fix) | 18/0/0 | unchanged |
| corpus 2 (after tuning) | 31 TP / 8 FP / 6 FN | 31 / 8 / 6 | unchanged |
| corpus 3 | 18 / 2 / 13 | **18 / 1 / 13** | class A removed the EmissionsController FP |
| c3 validator | 1 validated, 3 refuted (2 wrong), 1 inconclusive | 2 validated, 1 refuted (correct), 2 inconclusive | both adjudicated errors corrected |

Recall on corpus 3 does not move: B–H are designed, not implemented. Implementing them is the next development step, using new
development fixtures written for each class. It must not be fitted to the corpus-3 files.
