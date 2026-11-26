heldout3-src -- held-out Solidity corpus #3 (static-analysis evaluation)
=========================================================================

Authoring
---------
* 58 hand-written Solidity files (pragma ^0.8.20) in contracts/, one primary
  contract per file, 33-109 lines each. Written from scratch without a
  compiler, without looking at any analyzer, repository or earlier corpus,
  and without network access. Not yet compile-checked.
* Production-like style: NatSpec, events, custom errors, abstract bases,
  2-3 level inheritance, modifiers defined in bases (several with arguments,
  e.g. onlyRole(bytes32), onlyModule(address), onlyRegistryAdmin(bytes32)),
  libraries with `using X for Y`, helper chains 2-3 calls deep, UUPS and
  transparent-style proxies with ERC1967 storage slots, versioned
  initializers/reinitializers, ERC4626-style share vault, staking, auctions,
  escrow, M-of-N approvals, timelocks, fee routers, token hooks, factories.
* Most cases come as vulnerable/twin pairs (same `pair` id) plus benign
  look-alikes and some deliberately ambiguous cases.
* Cross-contract reasoning is needed in at least 12 files: AirdropDistributor,
  PointsDropDistributor, NativeWrapperGateway, EthLiquidityPool,
  YieldController, StrategyController, SharedWallet, LimitWallet,
  SimpleUpgradeProxy, SlotUpgradeProxy, ModularAccount, MarketLogic,
  VaultFactory, ManagedVaultFactory, RateOracle, BorrowRateOracle.
* No identifier or comment uses words such as bug/vulnerable/safe/fixed/
  patched/exploit/attack (the library helper `safeTransfer` is the only
  "safe" token, a standard library name).

Label schema (labels.json, array of objects)
--------------------------------------------
  file        "contracts/X.sol"
  contract    contract on which the labelled entry point is reachable. Where a
              function is inherited from a base, this is the deployed
              (most-derived) contract, e.g. LoyaltyPointsV1.__Ownable_init.
  function    entry-point function name ("fallback", "constructor" allowed).
              Two labels use a private helper name (EnglishAuction.
              _notifyListener) to avoid two verdicts for one function/class.
  class       reentrancy | access-control | initializer | delegatecall |
              unchecked-call | selfdestruct | tx-origin
  vulnerable  true | false (best judgement, also for ambiguous entries)
  line        1-based line of the key statement; if the statement sits in a
              helper or in another contract of the same file, the helper's
              line is given. For reentrancy the line is the external call.
              Every line was checked mechanically against the final files
              (each anchor text matched exactly the intended line).
  pair        shared id for a vulnerable/twin pair, else null
  ambiguous   true when reasonable reviewers could disagree
  note        one maintainer sentence
Functions without a label are "not relevant". One function may carry labels
for two classes (RewardsControllerV1.upgradeToAndCall: initializer and
delegatecall).

Counts (79 labels, 58 files)
----------------------------
class            vulnerable  benign  ambiguous(of which labelled vuln)
reentrancy           5         10        1 (1)
access-control       4         10        1 (1)
initializer          4          8        2 (2)
delegatecall         4          6        1 (0)
unchecked-call       4          3        1 (0)
selfdestruct         2          4        1 (1)
tx-origin            3          4        1 (0)
total               26         45        8
(vulnerable/benign columns exclude ambiguous entries.)
Ambiguous-label count: 8.

Reentrancy specifics
--------------------
* Post-call assignment / unchecked arithmetic, real drain: MerchantEscrow
  (assignment), NativeStakingPool (unchecked subtraction), AirdropDistributor
  (bool assignment after hooked mint), ReserveAuction.withdrawRefund
  (assignment).
* Post-call checked 0.8 subtraction: EtherShareVault (vulnerable: nested
  redeem reverts, but re-entering deposit() mints at a depressed rate),
  PrepaidCreditLedger (not vulnerable: nested withdrawals underflow and
  revert, no other reader of the stale balance), EthLiquidityPool (ambiguous:
  pool functions are locked, but the stale reserve inflates pricePerShare
  for LpCollateralLender -- read-only reentrancy).

Changes to contracts after the first 44 files were written
----------------------------------------------------------
* Added 14 files to cover classes that were not yet present: selfdestruct
  (LegacyFeeVault, FeeVaultV2, MarketLogic, DustSweeper, VaultFactory,
  ManagedVaultFactory, GovernedSunsetPool), tx-origin (DelegatedPayoutWallet,
  PayoutWalletV2, GenesisMintPass, RateOracle, BorrowRateOracle,
  GasRebatePool) and one unchecked-call file (EnglishAuction).
* Removed the comment line "@custom:oz-upgrades-unsafe-allow constructor"
  from OracleAdapterV1 and StrategyRegistryV2 (it appeared only in the twins,
  so it gave away the answer).
* Reworded NatSpec phrases that contained the word "Fixed" (NativeStakingPool,
  NativeStakingPoolV2, RevenueSplitter, RevenueDistributor, TreasuryPayouts,
  GrantTreasury, GenesisMintPass) to Wad-math/Static/Flat.
* No code logic of the original 44 files was changed in this pass. Earlier,
  while drafting, WalletLibrary/LimitWalletLogic `send` was renamed `spend`
  and VaultLogicV1 got an explicit `_initialized` flag so its slot collision
  with SimpleUpgradeProxy can actually be triggered.
