# Validated finding on a controlled target: EtherStore reentrancy

**Date:** 2026-11-27. **Target:** `SunWeb3Sec/DeFiVulnLabs` at commit `f61f6ee5c3f89eb7685030647f8df19997596f8b`, file `src/test/Reentrancy.sol`.
This is an intentionally vulnerable, public educational corpus with known ground truth. It is a **controlled target, not a live
third-party bounty**. Like the Ethernaut cycle, this is an **exposure-qualified** demonstration: it shows AgentSmith's existing
hunting pipeline finds, validates and reproduces a real bug through three independent methods, not that it generalises to unseen code.

## The bug

`EtherStore.withdrawFunds` (extracted verbatim into `EtherStore.sol`) sends ether to the caller **before** reducing their balance,
and the balance update is itself guarded by a re-checked condition:

```solidity
function withdrawFunds(uint256 _weiToWithdraw) public {
    require(balances[msg.sender] >= _weiToWithdraw);
    (bool send, ) = msg.sender.call{value: _weiToWithdraw}("");   // line 10: external call hands control to msg.sender
    require(send, "send failed");
    if (balances[msg.sender] >= _weiToWithdraw) {                 // line 12: state updated only afterwards
        balances[msg.sender] -= _weiToWithdraw;
    }
}
```

A re-entering receiver withdraws repeatedly before its balance is reduced, draining the whole vault (classic check-effect-interaction
violation). `EtherStoreRemediated.withdrawFunds` in the same file applies a `nonReentrant` guard and the correct order; it is the control.

## What AgentSmith's existing pipeline did (all through the real engine, nothing bespoke)

The engine CLI drove the whole chain on a disposable Postgres with the drafts applied: register → verify scope (human) → rank →
select (human) → acquire + seal snapshot → map → investigate → challenge → ingest.

1. **Structural analyser (deterministic):** one hypothesis `solidity-reentrancy` on `EtherStore.withdrawFunds`, citing the external
   call at line 10 and the later state update at line 12 (evidence spans persisted).
2. **Slither 0.11.3 (independent tool, via the engine's version-pinned wrapper):** one `reentrancy-eth` detection (High impact, Medium
   confidence) on the same function, lines 8–13. Slither raised no reentrancy detection on the remediated function.
   - raw-output sha256 `54c290bfb47a06ad…`, input-manifest sha256 `5ef65d71ea0057d7…`.
3. **Deterministic evaluator `reentrancy-execution-validator`:** **supports** both hypotheses. It built an executed model on its own:
   "a re-entrant attacker extracts 2 ether where the best honest sequence of the same calls extracts 1 ether."
4. **Foundry 1.5.1 reproduction (via the engine's wrapper), `Reentrancy.t.sol`:**
   - `testDrainVulnerable` **passes**: an attacker that stakes 1 ether drains the full 6-ether vault (store balance → 0, attacker balance → 6 ether).
   - `testRemediatedSafe` **passes**: the attack reverts against the remediated vault and the victim's 5 ether is untouched.
   - test sha256 `8245ace513d50397…`, raw-output sha256 `d962874d0819e5e1…`.

## False positives eliminated

- **The remediated function:** neither the structural analyser nor Slither flagged `EtherStoreRemediated.withdrawFunds`, and the
  Foundry control confirms the attack fails against it. So the finding is specific to the vulnerable function.
- **Corpus-wide noise:** running the structural analyser over all 57 DeFiVulnLabs test files produced 56 raw "findings", most of which
  are false positives: `initializer` on test `setUp()` functions, `access-control` on attacker contracts' `attack()` methods. Those
  are a scanner's leads, not findings. This investigation keeps only the one lead that two independent detectors agree on **and** a
  deterministic evaluator supports **and** a Foundry PoC reproduces with measured impact.

## Honest limits

- **Not a confirmed finding in the evidence-planes sense:** the evaluator's "supports" is technical evidence that the lead is worth
  pursuing. A "confirmed finding" additionally needs a human adjudication, which is deliberately not done here.
- **Exposure-qualified:** this is a known textbook bug on a corpus the structural analyser was developed against. It demonstrates the
  operational chain and the ability to separate a real bug from false positives; it does not establish detection of novel bugs.
- **Controlled target only:** no live third-party bounty programme was scanned.

## Files

- `EtherStore.sol` — the vulnerable and remediated contracts, extracted verbatim.
- `Reentrancy.t.sol` — the self-contained PoC (no external dependencies), run through the engine's Foundry wrapper.
