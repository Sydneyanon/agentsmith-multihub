# Protocol model P1: evidence for owner review (2026-11-26). P2 is NOT started; it awaits this review.

**Scope approved (A20, narrowed):** P1 implementation only.

**Built:**
- `apps/api/src/analysis/solidity/protocol-model.ts` (`protocol-model/1`, builder `solidity-p1/1`).
- The analysis step stores the model content-addressed (`research_blobs`) and links it from its output (`protocol_model_sha256`).
- **No migration and no new table.**

## What P1 represents (and what it does not)
| Represented (each fact with code evidence and a derivation kind) | Not represented (P2+ only, not approved) |
|---|---|
| Components (deployable contracts, libraries, abstract bases) with a per-component content hash and linearisation | State-variable roles (ledger, aggregate, authority, implementation pointer) |
| Functions **in each deployed contract's dispatch context** (inherited entry points, who declared them), entry-point flag, caller-guard flag, state writes | Privileged roles and trust boundaries |
| Call edges: internal (inlined helpers), modifier, external, low-level call, delegatecall, send/transfer, with where the target comes from (parameter, caller, storage, constant) | Assets, value flows, state transitions, multi-transaction interactions, external-integration assumptions |
| Inheritance: linearisation and which override each deployed contract reaches | |
| Unknowns: everything not modelled (inline assembly, unresolved calls, parse problems), recorded rather than dropped | |

**P1 is not architecture intelligence yet.** It is the evidence-backed structural layer that the later steps build on, exported from what
the analyzer already computed rather than derived a second time.

## Consumers (owner condition: at least one real consumer)
1. **Research dossier: architecture section.**
   - Built only from the stored model: located through the snapshot's run and analysis step output, and re-hashed on read (the database
     also enforces blob integrity).
   - Lists each deployable component, its entry points, whether each is caller-guarded, the state it writes and its external calls, with
     code locations, plus everything not modelled.
   - A snapshot with no recorded model says so and nothing is reconstructed.
   - Exercised end to end in the worker workflow (`structural-workflow.integration.test.ts`) and on a real repository (below).
2. **Priority Engine coverage units (T-052 model, offline).** `coverageComponents(model)` produces version-aware coverage units per
   component (content hash, weight = number of state-changing entry points). A behavioural test shows that research at a component's
   old hash does not cover its new version, while untouched components stay covered.
   - **Limitation:** the Priority Engine is not connected to live data, so this consumer is real code on real models but not yet part of
     an operating loop.
3. **Structural map (compatibility).** The function-level map in the step output is now a **projection of the model**: one derivation
   instead of two.

## Evidence
| Claim | Evidence | Kind |
|---|---|---|
| Deterministic and canonical | Same sources give the same hash; reversed source order gives the same hash; arrays in canonical order (tests) | development |
| Every fact cites code | Each fact's file hash equals that file's content hash and its lines exist (test over all facts) | development |
| Component hashes are per component | Changing one contract changes only its hash, including for two contracts in one file (tests) | development |
| Dispatch context correct | An inherited `upgradeAndRun` is described in the deployed contract, guarded through the override it reaches (test) | development |
| Stable on a real repository | Two independent clone acquisitions of `crytic/not-so-smart-contracts` @ `020dbdb`, full pipeline each: identical model `1a1980f1…` and identical dossier content hash `e6e945f9…`. 51 deployable components, 162 entry points (146 without a caller guard), 34 unknowns, 34 leads (`eval/real-runs/not-so-smart-contracts/run4-p1-*`) | development, real code |
| Accurate on documented examples | Human-readable spot check (below) | development, inspected |
| No regression | Dev 17/0/0, corpus 1 18/0/0, corpus 2 31/8/6, corpus 3 18/1/13 (development); corpus-4 per-label results **identical** to the scored candidate 3 | development |
| Tests guard it | 11 unit tests + 2 workflow integration tests; P1 mutation spec 10/10 killed (one equivalent mutant removed, with the reason recorded); analyzer spec 36/36 still killed; full verify 799 unit tests, 254/254 integration as owner and as restricted role | development |

**Spot check on the real repository** (each documented bug as the model describes it):

| Function | Model description |
|---|---|
| `Unprotected.changeOwner` | unguarded, writes `owner` |
| `WalletLibrary.initWallet` (Parity) | unguarded, writes the owner set and limits |
| `Rubixi.DynamicPyramid` | unguarded, writes `creator` |
| `Missing.IamMissing` | unguarded, writes `owner` |
| `Reentrance.withdrawBalance` | unguarded, low-level call to `msg.sender` at line 17, writes `userBalance` |
| `KingOfTheEtherThrone.claimThrone` | `send` to a storage-held address (line 121) and to `msg.sender` |

## Limitations found
- **Inflated unknowns on old code.** Most of the 34 unknowns are pre-0.4.21 event emissions written without `emit`, which the tracer
  reports as unresolved calls. They are recorded, not hidden. A parser fix belongs with the analyzer, not the model.
- **Internal call targets lack parameter signatures.** They are named by contract and function only, so overloaded internal functions
  are not distinguished.
- **"Caller-guarded" is P1's coarse flag** (any authorising guard on the path). Who holds the authority, and whether it can be seized, is
  P3.
- The model of a very large repository may exceed the 1 MiB blob limit. It is then not stored and the step says so; no truncation.

## Decision for the owner (stop/go before P2)
- **Is P1's output accurate and useful enough to build P2 on?**
- **Recommended P2 scope** (from the plan): state-variable roles, consumed by the reentrancy validator's world seeding (replacing its
  private V1 derivation) and by the specialists' authority detection. Gate: identical verdicts and findings on all development data,
  with the private derivations deleted.
