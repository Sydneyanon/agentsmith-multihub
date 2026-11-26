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

## Decision for the owner
- **Accept or reject the P3 milestone.**
- **P4 and broader protocol modelling** (assets, value flows, state transitions) are **not started** and need explicit approval.
