import json, os, re
ROOT = os.path.join(os.path.dirname(__file__), '..')
T, F = True, False
# (file, contract, function, class, vulnerable, anchor, needle, pairkey, ambiguous, note, check_contract)
L = []
def add(file, contract, function, cls, vuln, anchor, needle, pair, amb, note, check=True):
    L.append(dict(file=file, contract=contract, function=function, cls=cls, vuln=vuln, anchor=anchor,
                  needle=needle, pair=pair, amb=amb, note=note, check=check))

for f, v in (("R01_EtherVault.sol", T), ("R02_EtherVault.sol", F)):
    add(f, "EtherVault", "withdrawAll", "reentrancy", v, "function withdrawAll", "msg.sender.call{value: amount}", "rv", F,
        "Balance is cleared only after the ether transfer, so a receiving contract can re-enter and withdraw repeatedly." if v else
        "Balance and total are cleared before the ether transfer, so re-entering finds nothing to withdraw.")
for f, v in (("R03_StakingRewards.sol", T), ("R04_StakingRewards.sol", F)):
    add(f, "StakingRewards", "claim", "reentrancy", v, "function claim", "rewardToken.transfer(msg.sender, owed)", "rs", F,
        "The reward token calls back into the recipient before rewardDebt is updated, so claim can be re-entered and the same rewards paid repeatedly." if v else
        "rewardDebt is updated before the hooked token transfer, so a re-entrant claim sees zero pending.")
add("R05_SavingsBank.sol", "SavingsBank", "withdraw", "reentrancy", F, "function withdraw", "payable(msg.sender).call", None, T,
    "External call precedes the balance decrement, but under checked arithmetic every nested withdrawal is subtracted on unwind and underflows, reverting the whole drain; CEI is still violated so some reviewers would flag it.")
add("R06_LedgerWallet.sol", "LedgerWallet", "withdrawAll", "reentrancy", T, "function withdrawAll", "msg.sender.call{value: amount}", None, F,
    "nonReentrant guards only withdrawAll; during the callback the attacker calls the unguarded move() to shift its still-recorded credit to a second account, then credit is zeroed, doubling the payout.")
add("R07_GenesisPass.sol", "GenesisPass", "mint", "reentrancy", T, "function mint", "_safeMint(msg.sender, id);", None, T,
    "The onERC721Received callback runs before mintedBy is updated, letting a contract re-enter mint and exceed the per-wallet cap; this bypasses a limit rather than stealing funds, so its severity is debatable.")
add("R07_GenesisPass.sol", "GenesisPass", "sweep", "access-control", F, "function sweep", "treasury.call{value", None, F,
    "Anyone can trigger the sweep, but the ether always goes to the immutable treasury.")

for f, v in (("A01_GovernanceToken.sol", T), ("A02_GovernanceToken.sol", F)):
    add(f, "GovernanceToken", "mint", "access-control", v, None, "    function mint(address to, uint256 amount) external", "am", F,
        "mint has no owner restriction, so anyone can mint up to the cap." if v else "mint is restricted with onlyOwner.")
for f, v in (("A03_ProtocolTreasury.sol", T), ("A04_ProtocolTreasury.sol", F)):
    add(f, "RoleRegistry", "setOperator", "access-control", v, None, "    function setOperator(address account, bool enabled) external", "ao", F,
        "Anyone can grant themselves operator status and then disburse treasury funds." if v else "Operator management is restricted to the admin.")
add("A05_PriceFeed.sol", "PriceFeed", "submit", "access-control", F, "function submit", "function submit", None, F,
    "The keeper modifier silently skips the body for other callers instead of reverting, so non-keepers cannot change the price.")
add("A05_PriceFeed.sol", "KeeperControlled", "setKeeper", "access-control", F, "function setKeeper", 'require(msg.sender == governance', None, F,
    "Keeper rotation is checked against governance.")
add("A06_TokenVesting.sol", "TokenVesting", "_payout", "access-control", T, None, "function _payout(address beneficiary, address to, uint256 amount) public", None, F,
    "The helper is public, so anyone can pay any amount of the vested token to an arbitrary address.")

for f, v in (("T01_FamilyWallet.sol", T), ("T02_FamilyWallet.sol", F)):
    add(f, "FamilyWallet", "sendTo", "tx-origin", v, "function sendTo", "require(", "to", F,
        "Authorisation uses tx.origin, so a contract the owner interacts with can send the wallet's funds anywhere." if v else
        "Authorisation uses msg.sender.")
add("T03_FairLaunch.sol", "FairLaunch", "buy", "tx-origin", F, None, "require(tx.origin == msg.sender", None, T,
    "tx.origin is only compared with msg.sender to block contract callers, not used for authorisation; some reviewers still flag it because it breaks smart-contract wallets.")
add("T04_StrategyManager.sol", "StrategyManager", "evacuate", "tx-origin", T, None, "require(tx.origin == administrator", None, F,
    "The inherited modifier authorises by tx.origin, so a malicious contract called by the administrator can evacuate strategies to itself.", check=False)
add("T04_StrategyManager.sol", "Administered", "handover", "tx-origin", T, None, "require(tx.origin == administrator", None, F,
    "The modifier authorises by tx.origin, letting a phishing contract take over administration.")

for f, v in (("U01_PayrollSplitter.sol", T), ("U02_PayrollSplitter.sol", F)):
    add(f, "PayrollSplitter", "distribute", "unchecked-call", v, "function distribute", ".send(cut)", "up", F,
        "The bool from send is ignored, so failed payouts are silently skipped while the run is recorded." if v else
        "The send result is required to be true.")
for f, v in (("U03_RefundEscrow.sol", T), ("U04_RefundEscrow.sol", F)):
    add(f, "RefundEscrow", "claimRefund", "unchecked-call", v, "function claimRefund", "buyer.call{value: amount}", "ur", F,
        "The deposit is zeroed and the low-level call result discarded, so a failed refund loses the buyer's funds." if v else
        "The low-level call result is checked and the whole refund reverts on failure.")
add("U05_TokenAirdrop.sol", "TokenAirdrop", "claim", "unchecked-call", T, "function claim", "token.transfer(msg.sender, amount);", None, T,
    "The ERC20 transfer return value is ignored after marking the claim; harmful only with tokens that return false instead of reverting.")

for f, v in (("I01_YieldVault.sol", T), ("I02_YieldVault.sol", F)):
    add(f, "YieldVault", "initialize", "initializer", v, None, "function initialize(IERC20 asset_, address manager_)", "iv", F,
        "initialize has no initializer guard, so anyone can call it again through the proxy and become manager." if v else
        "initialize is protected by the initializer modifier.")
for f, v in (("I03_RewardsVault.sol", T), ("I04_RewardsVault.sol", F)):
    add(f, "OwnableUpgradeable", "__Ownable_init", "initializer", v, None, "function __Ownable_init(address initialOwner)", "io", F,
        "The inherited ownership initialiser is public and unguarded, so anyone can call it after deployment and take ownership of the vault." if v else
        "The inherited initialiser is internal and onlyInitializing.")
for f, v in (("I05_LendingPoolV1.sol", T), ("I06_LendingPoolV1.sol", F)):
    add(f, "LendingPoolV1", "initialize", "initializer", v, None, "function initialize(address admin, uint256 reserveFactorBps_)", "il", v,
        "The implementation never disables initialisers, so anyone can initialise it directly and own it; how damaging this is depends on whether selfdestruct via the upgrade path still deletes code after EIP-6780." if v else
        "The implementation constructor disables initialisers.")
    add(f, "UUPSUpgradeable", "upgradeToAndCall", "delegatecall", v, "function upgradeToAndCall", "newImplementation.delegatecall(data)", "iu", v,
        "upgradeToAndCall lacks an onlyProxy check, so whoever initialises the bare implementation can make it delegatecall arbitrary code, e.g. selfdestruct; impact after EIP-6780 is debated." if v else
        "Although callable on the implementation, the implementation has no owner because its initialisers are disabled, so the upgrade path cannot be reached there.")
add("I07_MarketplaceV2.sol", "MarketplaceV2", "initializeV2", "initializer", T, None, "function initializeV2(", None, T,
    "The version-2 reinitialiser has no access control, so if the upgrade and this call are not atomic anyone can set the fee recipient first; safe if always used through upgradeToAndCall.")
add("I08_PoolConfigurator.sol", "PoolConfigurator", "initialize", "initializer", T, None, "function initialize(address governor_", None, F,
    "The initialized flag is checked but never set, so initialize can be called again to replace the governor.")
for f, v in (("I09_BridgeEscrow.sol", T), ("I10_BridgeEscrow.sol", F)):
    add(f, "BridgeEscrow", "initialize", "initializer", v, "function initialize", "require(", "ib", F,
        "Initialisation is guarded by owner being zero, which renounceOwnership restores, letting anyone re-initialise and install their own relayer." if v else
        "A dedicated flag guards initialisation, so renouncing ownership does not reopen it.")
for f, v in (("I11_CreatorVaultBeacon.sol", F), ("I12_CreatorVaultBeacon.sol", T)):
    add(f, "UpgradeableBeacon", "upgradeTo", "initializer", v, None, "function upgradeTo(address newImplementation)", "ibe", F,
        "Anyone can point the beacon at a new implementation, upgrading every beacon proxy at once." if v else
        "Beacon upgrades are restricted to the owner.")
add("I11_CreatorVaultBeacon.sol", "BeaconProxy", "fallback", "delegatecall", F, "fallback() external payable", "delegatecall(gas(), impl", None, F,
    "Delegates to the implementation reported by a beacon fixed at construction, with state in no conflicting slot.")
add("I11_CreatorVaultBeacon.sol", "CreatorVault", "initialize", "initializer", F, None, "function initialize(address creator, string calldata handle_", None, F,
    "Guarded by initializer, disabled on the implementation, and called atomically in the proxy constructor.")
for f, v in (("I13_GaugeController.sol", T), ("I14_GaugeController.sol", F)):
    add(f, "GaugeController", "_authorizeUpgrade", "initializer", v, None, "function _authorizeUpgrade(address newImplementation) internal override", "ia", F,
        "The UUPS authorisation hook only checks for a zero address, so anyone can upgrade the proxy to their own code." if v else
        "The UUPS authorisation hook is onlyOwner.")
add("I14_GaugeController.sol", "ERC1967Proxy", "fallback", "delegatecall", F, "fallback() external payable", "delegatecall(gas(), impl", None, F,
    "Standard ERC-1967 forwarding to an implementation stored in the dedicated slot.")
for f, v in (("I15_TransparentProxy.sol", T), ("I16_TransparentProxy.sol", F)):
    add(f, "TransparentProxy", "upgradeTo", "initializer", v, None, "function upgradeTo(address newImplementation) external", "it", F,
        "The proxy's upgradeTo has no admin check, so any caller can replace the implementation." if v else
        "upgradeTo is behind ifAdmin; other callers fall through to the implementation.")
add("I16_TransparentProxy.sol", "TransparentProxy", "fallback", "delegatecall", F, "function _fallback", "delegatecall(gas(), impl", None, F,
    "Forwards to the ERC-1967 implementation slot that only the admin can change.")

add("D01_PaymentSplitterProxy.sol", "PaymentSplitterProxy", "receive", "delegatecall", F, "receive() external payable", "logic.delegatecall", None, F,
    "Delegates to an immutable logic address with a fixed selector, and the proxy has no storage of its own.")
add("D01_PaymentSplitterProxy.sol", "PaymentSplitterProxy", "fallback", "delegatecall", F, "fallback() external payable", "delegatecall(gas(), impl", None, F,
    "Forwards to an immutable logic contract.")
for f, v in (("D02_CrowdsaleProxy.sol", T), ("D03_CrowdsaleProxy.sol", F)):
    add(f, "SaleProxy", "fallback", "delegatecall", v, "fallback() external payable", "delegatecall(gas(), impl", "dc", F,
        "The proxy keeps implementation and admin in slots 0 and 1, which the logic uses for token and owner, so initialising through the proxy overwrites them and hands over the admin role." if v else
        "Proxy state lives in ERC-1967 slots that do not overlap the logic layout.")
for f, v in (("D04_SmartAccount.sol", T), ("D05_SmartAccount.sol", F)):
    add(f, "SmartAccount", "executeModule", "delegatecall", v, "function executeModule", "module.delegatecall(data)", "da", F,
        "Anyone can delegatecall any address in the account's context, e.g. to overwrite the owner or drain it." if v else
        "Only the owner can delegatecall, and only into modules it has trusted.")
add("D06_PositionManager.sol", "Multicall", "multicall", "delegatecall", F, "function multicall", "address(this).delegatecall", None, F,
    "Delegatecalls only into its own code, and the batch is non-payable so msg.value cannot be reused.")
for f, v in (("D07_RateModelRouter.sol", T), ("D08_RateModelRouter.sol", F)):
    add(f, "RateModelRouter", "compute", "delegatecall", v, "function compute", "mathLib.delegatecall(data)", "dl", F,
        "The delegatecall target can be replaced by anyone through setMathLib, giving arbitrary code control of the router's storage." if v else
        "The delegatecall target can only be changed by the owner.")
    add(f, "RateModelRouter", "setMathLib", "access-control", v, None, "function setMathLib(address lib) external", "dls", F,
        "The library setter is unrestricted." if v else "The library setter is onlyOwner.")
for f, v in (("D09_ModularRouter.sol", F), ("D10_ModularRouter.sol", T)):
    add(f, "ModularRouter", "fallback", "delegatecall", v, "fallback() external payable", "delegatecall(gas(), impl", "dr", F,
        "The selector-to-module table can be written by anyone through setModule, so any caller can route a selector to their own code." if v else
        "The fallback delegates only to modules registered by the owner.")
    add(f, "ModularRouter", "setModule", "access-control", v, None, "function setModule(bytes4 selector, address module) external", "drs", F,
        "Module registration is unrestricted." if v else "Module registration is onlyOwner.")
add("D11_LaunchpadBatcher.sol", "Launchpad", "batch", "delegatecall", T, "function batch", "address(this).delegatecall", None, T,
    "The payable batch delegatecalls payable functions, so msg.value is counted once per item and credit can be inflated and withdrawn; arguably a msg.value-reuse issue rather than a delegatecall one.")
add("D12_KeeperJobs.sol", "KeeperJobs", "work", "unchecked-call", T, "function work", "j.module.delegatecall(j.payload);", None, F,
    "The delegatecall result is discarded, so a failed job still advances lastRun and pays the keeper reward.")

for f, v in (("S01_GiftCards.sol", T), ("S02_GiftCards.sol", F)):
    add(f, "GiftCards", "shutdown", "selfdestruct", v, "function shutdown", "selfdestruct(to)", "sg", F,
        "Anyone can selfdestruct the contract and take all unredeemed card balances." if v else "Only the issuer can selfdestruct the contract.")
for f, v in (("S03_MultisigWallet.sol", T), ("S04_MultisigWallet.sol", F)):
    add(f, "WalletLibrary", "initWallet", "initializer", v, "function initWallet", 'require(!initialized', "spi", F,
        "The shared library is never initialised itself, so anyone can call initWallet on it directly and become its owner." if v else
        "The library constructor marks itself initialised, so it cannot be claimed directly.")
    add(f, "WalletLibrary", "kill", "selfdestruct", v, "function kill", "selfdestruct(to)", "spk", F,
        "Because anyone can become owner of the library, they can selfdestruct it and break every wallet that delegates to it." if v else
        "The library cannot gain an owner, and owners of a wallet only destroy that wallet.")
add("S05_SubscriptionHub.sol", "SubscriptionHub", "decommission", "selfdestruct", F, "function decommission", "selfdestruct(treasury)", None, T,
    "Owner-only and proxy-only, so it is a deliberate admin kill switch; some would treat a selfdestruct in upgradeable logic as a centralisation risk.")
for f, v in (("S06_VestingFactory.sol", T), ("S07_VestingFactory.sol", F)):
    add(f, "VestingWallet", "initialize", "initializer", v, None, "function initialize(address beneficiary_, address controller_", "sci", v,
        "The clone implementation is left uninitialised, so anyone can initialise it and make themselves controller; impact depends on post-EIP-6780 selfdestruct semantics." if v else
        "The implementation constructor disables initialisers.")
    add(f, "VestingWallet", "revoke", "selfdestruct", v, "function revoke", "selfdestruct(refundTo)", "scr", v,
        "Whoever initialises the implementation can selfdestruct it, bricking every clone (fully only before EIP-6780)." if v else
        "Only the per-clone controller can revoke, and the implementation cannot acquire a controller.")
for f, v in (("S08_LotteryPot.sol", T), ("S09_LotteryPot.sol", F)):
    add(f, "Ownable", "transferOwnership", "access-control", v, None, "function transferOwnership(address newOwner) public", "slo", F,
        "transferOwnership is missing onlyOwner, so anyone can take ownership." if v else "transferOwnership is onlyOwner.")
    add(f, "LotteryPot", "terminate", "selfdestruct", v, "function terminate", "selfdestruct(payable(owner))", "slt", v,
        "terminate is owner-gated, but ownership can be taken by anyone, so anyone can selfdestruct the pot to themselves; the root cause is in the inherited ownership function." if v else
        "terminate is owner-gated and ownership cannot be taken.")

def contract_spans(lines):
    spans = []
    for i, ln in enumerate(lines):
        m = re.match(r'^(?:abstract\s+)?(contract|interface|library)\s+(\w+)', ln)
        if m:
            spans.append((m.group(2), i))
    out = {}
    for k, (name, start) in enumerate(spans):
        end = spans[k+1][1] if k+1 < len(spans) else len(lines)
        out[name] = (start, end)
    return out

pairs = {}
labels = []
for e in L:
    path = os.path.join(ROOT, 'contracts', e['file'])
    lines = open(path).read().split('\n')
    spans = contract_spans(lines)
    assert e['contract'] in spans, (e['file'], e['contract'])
    cs, ce = spans[e['contract']]
    start = 0
    if e['anchor']:
        hits = [i for i in range(cs, ce) if e['anchor'] in lines[i]]
        assert len(hits) == 1, (e['file'], e['anchor'], hits)
        start = hits[0]
        hits2 = [i for i in range(start, len(lines)) if e['needle'] in lines[i]]
        assert hits2, (e['file'], e['needle'])
        idx = hits2[0]
    else:
        hits = [i for i, l in enumerate(lines) if e['needle'] in l]
        assert len(hits) == 1, (e['file'], e['needle'], hits)
        idx = hits[0]
    if e['check']:
        assert cs <= idx < ce, (e['file'], e['contract'], idx)
    pid = None
    if e['pair']:
        pid = pairs.setdefault(e['pair'], "t%02d" % (len(pairs) + 1))
    labels.append(dict(file="contracts/" + e['file'], contract=e['contract'], function=e['function'],
                       **{"class": e['cls']}, vulnerable=e['vuln'], line=idx + 1, pair=pid,
                       ambiguous=e['amb'], note=e['note']))

# every file labelled
files = sorted(f for f in os.listdir(os.path.join(ROOT, 'contracts')) if f.endswith('.sol'))
labelled = {l['file'][len('contracts/'):] for l in labels}
assert set(files) == labelled, set(files) ^ labelled
# pairs: each pair id used by exactly two labels in two files, one vuln one benign
from collections import defaultdict
pp = defaultdict(list)
for l in labels:
    if l['pair']: pp[l['pair']].append(l)
for k, v in pp.items():
    assert len(v) == 2 and v[0]['vulnerable'] != v[1]['vulnerable'] and v[0]['file'] != v[1]['file'], k
json.dump(labels, open(os.path.join(ROOT, 'labels.json'), 'w'), indent=2)
print(len(files), "files", len(labels), "labels", sum(l['ambiguous'] for l in labels), "ambiguous", len(pp), "pairs")
from collections import Counter
c = Counter()
for l in labels:
    c[(l['class'], 'vuln' if l['vulnerable'] else 'benign')] += 1
    if l['ambiguous']: c[(l['class'], 'amb')] += 1
for cls in ["reentrancy","access-control","initializer","delegatecall","selfdestruct","tx-origin","unchecked-call"]:
    print(cls, c[(cls,'vuln')], c[(cls,'benign')], c[(cls,'amb')])
