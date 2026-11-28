# Local research dossier (Track B experiment)

**Target:** `acme/vaults` at commit `061020f7dd5e93708a25a08e3d77f377d0e16ca8` (educational fixture written for this experiment; two contracts: one with planted bugs, one benign control).

**Snapshot:** sealed, 3 files, 2391 bytes, manifest `45d08cdc648502da74f7cca29c03d5fadce4bf5302db9fa1401c62c24ec50339`; database re-verification: ok=True, hash mismatches=0, manifest matches=True.

**What is real vs prototype:** acquisition, sealing, evidence spans, hypotheses, evaluations, derived status and span verification are the repository's real code and database. The Solidity analyzer and the challenger are prototypes written for this run, not product components. No network, no real project, no spending.

## Attack-surface map (function level)
| Contract.function | visibility | mutability | modifiers | lines | entry point |
|---|---|---|---|---|---|
| SafeVault.deposit | external | payable | - | 25-27 | yes |
| SafeVault.withdraw | external | nonpayable | nonReentrant | 29-34 | yes |
| SafeVault.sweep | external | nonpayable | onlyOwner | 36-39 | yes |
| SafeVault.isEoa | external | view | - | 41-43 | no |
| VulnVault.initialize | external | nonpayable | - | 10-13 | yes |
| VulnVault.deposit | external | payable | - | 15-18 | yes |
| VulnVault.withdraw | external | nonpayable | - | 20-26 | yes |
| VulnVault.setOwner | external | nonpayable | - | 28-31 | yes |
| VulnVault.forward | external | nonpayable | - | 33-35 | yes |
| VulnVault.pay | external | nonpayable | - | 37-40 | yes |
| VulnVault.kill | external | nonpayable | - | 42-44 | yes |

For comparison, the existing product rules (`passive-surface-v1`) on the same files only count pattern matches: SOL-EXT-ENTRY x4 in SafeVault.sol, SOL-LOWLEVEL-CALL x2 in SafeVault.sol, SOL-TX-ORIGIN x1 in SafeVault.sol, SOL-EXT-ENTRY x7 in VulnVault.sol, SOL-LOWLEVEL-CALL x3 in VulnVault.sol, SOL-TX-ORIGIN x1 in VulnVault.sol, SOL-SELFDESTRUCT x1 in VulnVault.sol, SOL-DELEGATECALL x1 in VulnVault.sol.

## Hypotheses (each cites stored, hash-verified source lines)

### H1. SafeVault.isEoa - solidity-tx-origin
**Claim:** SafeVault.isEoa references tx.origin (line 42).

- evidence `contracts/SafeVault.sol:42-42`: `return tx.origin == msg.sender;`

**Required checks:** Determine whether tx.origin is used for authorization or only as an EOA check; Identify who can be tricked into calling a malicious contract

**Alternative explanations:** It may be an anti-contract check (tx.origin == msg.sender) rather than authorization

**Challenge (weakens):** tx.origin is compared with msg.sender, which is an anti-contract (EOA) check, not authorization.

**Stored status (derived by the database view):** `weakened_by_static_check`; human review: none recorded.

### H2. VulnVault.initialize - solidity-unprotected-initializer
**Claim:** VulnVault.initialize sets the owner with no caller check and no one-time guard (line 11).

- evidence `contracts/VulnVault.sol:10-10`: `function initialize(address newOwner) external {`
- evidence `contracts/VulnVault.sol:11-11`: `owner = newOwner;`

**Required checks:** Confirm no modifier or inherited guard applies; Confirm the function is reachable in the deployed configuration

**Alternative explanations:** Access control may be enforced by a proxy or deployment script outside this file

**Challenge (supports):** No modifier, msg.sender comparison or one-time flag guards the privileged action.

**Stored status (derived by the database view):** `unreviewed`; human review: none recorded.

### H3. VulnVault.withdraw - solidity-reentrancy-order
**Claim:** VulnVault.withdraw makes an external call (line 22) before updating state (line 24); a re-entering receiver could observe stale state.

- evidence `contracts/VulnVault.sol:22-22`: `(bool ok, ) = msg.sender.call{value: amount}("");`
- evidence `contracts/VulnVault.sol:24-24`: `balances[msg.sender] -= amount;`

**Required checks:** Confirm the callee can re-enter this contract; Confirm no reentrancy lock or earlier state write protects the path; Reproduce with a malicious receiver in a local fork test

**Alternative explanations:** A nonReentrant modifier may guard this function; State may be updated before the call elsewhere in the path

**Challenge (supports):** No reentrancy modifier or lock is present and no balance write precedes the call; the write after the call is reachable by a re-entering receiver.

**Stored status (derived by the database view):** `unreviewed`; human review: none recorded.

### H4. VulnVault.setOwner - solidity-tx-origin
**Claim:** VulnVault.setOwner references tx.origin (line 29).

- evidence `contracts/VulnVault.sol:29-29`: `require(tx.origin == owner, "not owner");`

**Required checks:** Determine whether tx.origin is used for authorization or only as an EOA check; Identify who can be tricked into calling a malicious contract

**Alternative explanations:** It may be an anti-contract check (tx.origin == msg.sender) rather than authorization

**Challenge (supports):** tx.origin is compared with the owner inside a require: it is used as authorization.

**Stored status (derived by the database view):** `unreviewed`; human review: none recorded.

### H5. VulnVault.forward - solidity-unchecked-call
**Claim:** VulnVault.forward ignores the success flag of a low-level call (line 34).

- evidence `contracts/VulnVault.sol:34-34`: `target.delegatecall(data);`

**Required checks:** Confirm the return value is never used on any path; Find what state is updated assuming success

**Alternative explanations:** The function may be intended best-effort

**Challenge (supports):** The call's result is never captured or tested in the rest of the function.

**Stored status (derived by the database view):** `unreviewed`; human review: none recorded.

### H6. VulnVault.forward - solidity-delegatecall-target
**Claim:** VulnVault.forward delegatecalls (line 34); the target may be caller-controlled.

- evidence `contracts/VulnVault.sol:33-33`: `function forward(address target, bytes calldata data) external {`
- evidence `contracts/VulnVault.sol:34-34`: `target.delegatecall(data);`

**Required checks:** Determine whether the target is a parameter or mutable storage; Check for an access modifier

**Alternative explanations:** The target may be a constant trusted implementation

**Challenge (supports):** The delegatecall target "target" is a function parameter and the function has no access modifier: any caller chooses the code that runs.

**Stored status (derived by the database view):** `unreviewed`; human review: none recorded.

### H7. VulnVault.pay - solidity-reentrancy-order
**Claim:** VulnVault.pay makes an external call (line 38) before updating state (line 39); a re-entering receiver could observe stale state.

- evidence `contracts/VulnVault.sol:38-38`: `to.call{value: amount}("");`
- evidence `contracts/VulnVault.sol:39-39`: `balances[msg.sender] -= amount;`

**Required checks:** Confirm the callee can re-enter this contract; Confirm no reentrancy lock or earlier state write protects the path; Reproduce with a malicious receiver in a local fork test

**Alternative explanations:** A nonReentrant modifier may guard this function; State may be updated before the call elsewhere in the path

**Challenge (supports):** No reentrancy modifier or lock is present and no balance write precedes the call; the write after the call is reachable by a re-entering receiver.

**Stored status (derived by the database view):** `unreviewed`; human review: none recorded.

### H8. VulnVault.pay - solidity-unchecked-call
**Claim:** VulnVault.pay ignores the success flag of a low-level call (line 38).

- evidence `contracts/VulnVault.sol:38-38`: `to.call{value: amount}("");`

**Required checks:** Confirm the return value is never used on any path; Find what state is updated assuming success

**Alternative explanations:** The function may be intended best-effort

**Challenge (supports):** The call's result is never captured or tested in the rest of the function.

**Stored status (derived by the database view):** `unreviewed`; human review: none recorded.

### H9. VulnVault.kill - solidity-unprotected-destruct
**Claim:** VulnVault.kill can selfdestruct with no access control (line 43).

- evidence `contracts/VulnVault.sol:42-42`: `function kill() external {`
- evidence `contracts/VulnVault.sol:43-43`: `selfdestruct(payable(msg.sender));`

**Required checks:** Confirm no modifier or inherited guard applies; Confirm the function is reachable in the deployed configuration

**Alternative explanations:** Access control may be enforced by a proxy or deployment script outside this file

**Challenge (supports):** No modifier, msg.sender comparison or one-time flag guards the privileged action.

**Stored status (derived by the database view):** `unreviewed`; human review: none recorded.

## Controls and honest limits

- Planted bugs found by the generator: **8/8**. This is circular: I wrote the fixture and the analyzer, so it shows the plumbing works, not real-world recall.
- Benign contract: generator raised 1 finding (`SafeVault.isEoa`, a `tx.origin == msg.sender` anti-contract check); the challenger weakened it, and the stored status became `weakened_by_static_check`. Standing on the benign contract after challenge: 0.
- Standing after challenge on the vulnerable contract: 8 (all unreviewed by a human).
- After applying the fixes to the vulnerable contract, the prototype still reports `VulnVault.forward` as a delegatecall risk even though an in-body `require(msg.sender == owner)` now guards it: **the challenger only recognises modifiers, so it fails to weaken a guarded function (false positive that survives).**
- A hand-rolled `_status` reentrancy lock is not recognised by analyzer or challenger: **false positive that survives challenge.**
- An external call hidden in an internal helper is missed entirely (no inter-procedural analysis): **false negative.**
- Nothing here is a verified vulnerability: no exploit was built or run, no compiler or fuzzer was used, no human review exists. These are reviewable leads with cited evidence.
