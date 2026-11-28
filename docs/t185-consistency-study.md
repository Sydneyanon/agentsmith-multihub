# T-185: specialist consistency study (P3 closeout D3, D4), 2026-11-26

**Scope.** A study. No product code was changed. Data: dev corpus and corpora 1–3 (development data, inspected before), and
`crytic/not-so-smart-contracts` @ `020dbdb` (no labels). **Corpus 4 is excluded** and the script refuses to read it. Script:
`eval/studies/t185-consistency.ts`. Raw output: `eval/studies/t185-results.json` (deterministic).

**Question.** Can the specialists' own rules be replaced by the shared P3 facts, removing parallel derivations?
- **D3**: the initializer specialist's one-time-flag rule versus P3's writer control.
- **D4**: access-control findings that rest only on a privileged-looking function name versus P3's name-independent open authority
  writes.

## Results (TP / FP / FN on labels)
| Source | Current | D3: P3 decides initialisers | D4a: drop name-only access-control | D4b: D4a + P3 open writers |
|---|---|---|---|---|
| dev | 17/0/0 | 17/0/0 | 15/0/2 | 15/0/2 |
| corpus 1 | 18/0/0 | 18/0/0 | 16/0/2 | 16/0/2 |
| corpus 2 | 31/8/6 | **30/8/7** | **25/7/12** | 25/7/12 |
| corpus 3 | 20/1/11 | 20/1/11 | **17/1/14** | 17/1/14 |
| real repository (finding count) | 34 | **31** | 33 | 33 |

**D3, where the swap loses:**
- corpus 2 `Vesting.init`: a labelled, true finding. It writes `beneficiary`, which P2 does not classify as an authority (no check
  compares it with the caller), so P3 has no writer fact for it.
- On the real repository, the Parity `WalletLibrary.initWallet`, `initMultiowned` and `initDaylimit`. The owner set is held in index
  structures (`m_owners`, `m_ownerIndex`) that P2 does not recognise (a recorded P2/P3 limitation).

No case went the other way: P3 found no initialiser the specialist missed.

**D4, name-only findings by corpus:**
- dev 3: `Config.setFeeOpen`, `Misc.setImpl`, `ModArg.setOtherWrongArg`.
- corpus 1 2: `AcFeeA.setFee`, `DcStoreA.setLogic`.
- corpus 2 7: `Conduit.setLogic`, `Dock.setSink`, `Minter.halt`, `RoleBoard.unpause`, `Tap.setFlow`, `Tap.setFlowLoose`, `Throttle.setLimit`.
- corpus 3 5: `GasRebatePool.registerOrder`, `GasRebatePool.settle`, `OpsTimelock.setDelay`, `ProtocolFeeRouter.setStakingSink`,
  `YieldController.setVaultStrategy`.
- real repository 1: `LedgerChannel.settleVC`.

Dropping them loses 2 / 2 / 6 / 3 true positives and removes 1 false positive (corpus 2). Adding P3 open authority writes recovers
**nothing** (D4b = D4a), because these functions write configuration (fees, sinks, limits, logic pointers), not authority variables.

## Conclusions
1. **Neither swap is an improvement. Both would lose real detections.** The disagreement is mainly one of **scope**:
   - the specialists cover any unguarded privileged state;
   - P3 covers authority variables only.

   The one-time rule itself (class G: a value check taken for a one-time guard) produced no measurable difference on this data.
2. **The name gate carries detection value today** (13 true positives across dev and corpora 1–3, for 1 false positive). It is already
   marked medium confidence on each finding. Removing it would be a regression, so it stays.
3. **What would remove the parallel derivation without losing detections** (designs; each needs an implementation go-ahead and the
   same study as its gate):
   - **D3-a: one rule, two scopes.** Export P3's one-time-flag test (`isUnsetCheck`) and have the initializer specialist call it for
     its flag check, keeping its broader scope. Expected: identical results on this data. Gate: this study shows no change.
   - **D3-b: close the P2 gap.** Recognise owner sets held in index mappings or arrays (`m_owners` / `m_ownerIndex` shape) as
     authorities, so P3 sees the Parity initialisers. Gate: no new false positive on dev and corpora 1–3.
   - **D4-a: a name-independent "configuration" role in P2.** A variable whose every other writer is caller-guarded; an unguarded
     writer of it is then a structural signal, not a naming one. Measure whether it reproduces the 13 name-only true positives
     before the name gate is touched.
4. **Status of D3/D4:** both remain **open**, now measured. The P3 closeout records stand unchanged.
