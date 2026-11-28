# Protocol model P1: evidence for owner review (2026-11-26). P2 is NOT started; it awaits this review.

> **Revision 2 (after the owner's ten P1 requirements).** The first P1 commit was `6e1ed20`. Checking it against the requirements found three gaps, now closed:
> 1. **Explicit unresolved relationships.** An unresolved call is now an `unresolved` edge of the calling function, with its location. External calls carry `resolvedCallee`, which is `null` unless the type resolves to a snapshot contract; an interface is never connected to an implementer.
> 2. **The scoring consumer.** The Priority Engine's scorer takes its per-component input from the model (`priority/from-model.ts`). There was no private code-derived component list to remove: components were hand-supplied inputs.
> 3. **Old-versus-new comparison** (below). It found **two regressions in the first P1 commit**, now fixed:
>    - calls made by internal helpers had dropped out of the entry points that reach them;
>    - constructors were missing.
>
> The figures in this revision supersede the first commit's where they differ (model hash, unknowns count).

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


## Old versus new (pre-P1 structural map at `48d9a38` versus the P1 projection), every corpus and the real repository

| Source | Functions old → new | Old functions missing | Re-homed to the deployed contract | Same-function differences |
|---|---|---|---|---|
| dev corpus | 42 → 42 | 0 | 1 | entry-point flag on 3 constructors |
| corpus 1 | 106 → 106 | 0 | 4 | 22 constructors |
| corpus 2 | 175 → 175 | 0 | 1 | 29 constructors |
| corpus 3 | 370 → 370 | 0 | 74 | 54 constructors |
| corpus 4 | 464 → 493 | 0 | 127 | 60 constructors |
| `not-so-smart-contracts` | 185 → 208 | 0 | 0 | 17 constructors |

On every source:
- **Identical:** caller-guard flag, state writes, reachable external-call count and call kinds (the old label `call` is now
  `low-level-call`).
- **Entry-point flag differences:** **all are constructors**, verified exhaustively (0 exceptions). The old map wrongly counted public
  constructors as callable entry points.
- **Extra functions:** inherited functions now described in each deployed child contract that exposes them.

### Where P1 improves consistency
- **One derivation.** The dossier, the step's structural map and the Priority Engine's coverage and scoring inputs all read the same
  stored model; previously the map was computed separately and the other two had nothing.
- **Deployed-context truth.** Inherited functions are described where they are actually callable, through the override that
  contract reaches. Constructors are no longer mislabelled as entry points.
- **Version-aware components.** Per-component content hashes let coverage and scoring tell changed code from unchanged code, including
  for two contracts in one file.
- **Explicit gaps.** Unresolved calls and interface calls are marked as such instead of being dropped or guessed.

### Where P1 does not yet provide enough information
- **"Caller-guarded" is a yes/no flag.** It cannot say which role guards a function, or whether that role can be seized (P3).
- **No variable roles.** It does not know what a state variable *is*: a ledger, a total, an authority or an implementation pointer
  (P2). The validator and specialists therefore still derive those privately.
- **No assets, value flows, state transitions or multi-transaction structure** (P4–P6), and no external-integration assumptions (P7).
- **Unknowns on legacy code are inflated** (38 on the real repository, mostly pre-0.4.21 events written without `emit`).
- **Internal call targets have no parameter signature,** so overloaded internal functions are not distinguished.

## Final figures (revision 2)
- **Real repository** (`run5-p1-final-*`): two independent clone acquisitions of `crytic/not-so-smart-contracts` @ `020dbdb` produced an
  identical model `13fa83c7…` and identical dossier content `66c40511…`. 51 deployable components and 162 entry points; 53 reach an
  external call, 32 reach an unresolved call; 38 unknowns; 34 leads (unchanged).
- **Tests:**
  - 16 protocol-model unit tests and 2 dossier workflow integration tests.
  - P1 mutation spec 18/18 killed; analyzer spec 36/36.
  - Findings unchanged on every corpus; corpus-4 per-label results identical to the scored candidate 3.
  - Full verify: 807 unit tests, 254/254 integration as owner and as restricted role.
- **Requirement checklist:**
  1. Deterministic from the sealed snapshot ✓
  2. Versioned format and producer ✓
  3. Evidence for every relationship ✓
  4. Unresolved relationships explicit, nothing invented ✓
  5. Content-addressed and hash-verified ✓
  6. Priority Engine consumes P1 ✓ (no private derivation existed to remove)
  7. The dossier's architecture comes only from P1 ✓
  8. Behavioural and integration tests for both consumers ✓
  9. Old versus new compared ✓
  10. Limitations recorded ✓
