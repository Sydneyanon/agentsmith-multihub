# 5.3 Protocol and architecture representation (design; conforms to T-149)

**Status: design, 2026-11-26. Not implemented.**

**Today.**
- Function-level structure (level 4): `analysis/solidity/index.ts` and `trace.ts` give contracts, inheritance, functions, modifiers and
  per-function effect traces with inlined helpers and deployed-contract dispatch.
- Legacy regex mapper (level 3, scaffolding).
- **Architecture and attack-surface intelligence does not exist (level 1).**

**Why function enumeration is not enough.** A list of functions says what can be called. Research needs to know what is protected, by
whom, what is valuable, where value moves, which other systems are trusted, and which sequences change state. Those are the questions
every specialist, APEX, Weirdness and the Priority Engine's per-component coverage ask today, each re-deriving partial answers privately.

## 1. What the model is
A **deterministic, versioned, derived artifact per sealed snapshot**:
- built at lifecycle stage 4 (Map);
- stored as a content-addressed blob in `research_blobs`;
- indexed by `protocol_models(snapshot_id, model_version, builder_version, input_manifest_sha256, blob_sha256)`;
- re-buildable from the snapshot alone.

**Every fact in it carries its evidence span** (file, lines, blob hash) **and a derivation kind**:

| Derivation kind | Meaning |
|---|---|
| `syntactic` | read directly from the code |
| `inferred` | a rule over syntax, naming the rule |
| `assumed` | not derivable, for example an external contract's behaviour |
| `declared` | from the program's own scope or documentation claims, with an observation id |

Facts never silently mix derivation kinds.

## 2. Entities and relations

| Entity | Content | Minimum derivation |
|---|---|---|
| **Component** | deployable contract, library, interface; source file; content hash; deployed-contract linearisation | syntactic |
| **Function** | visibility, mutability, modifiers, the deployed-context effect trace (reads, writes, calls, guards) | syntactic + inferred (trace) |
| **Call edge** | caller → callee: internal / external typed / low-level / delegatecall; target provenance (constant, immutable, storage, parameter, caller) | syntactic + inferred |
| **Inheritance and dependency** | linearisation, overrides, which virtual hook each deployed contract resolves to; imports, including unresolved ones listed explicitly | syntactic |
| **External integration** | every call whose target is outside the snapshot or untyped: token (ERC20/721/1155/4626 by interface use), oracle (price reads), DEX/AMM, lending, bridge, unknown. Each with the interface used and its assumptions (return checked? reentrancy possible? fee-on-transfer?) | inferred + **assumed** (explicit) |
| **Trust boundary** | a line between principals: anyone, a role holder, an owner/admin, another in-repository contract (factory, proxy, vault), an external protocol. Each boundary names the guard that enforces it, or `none` | inferred |
| **Privileged role** | role name, how it is held (storage variable, mapping, role table, immutable, slot), how granted and revoked, the functions it gates, whether it is transferable or renounceable, the initialiser that sets it | inferred |
| **Asset** | ether balance, ERC20 balances held, internal ledgers (address → amount), shares or supply aggregates, NFTs, authority itself (control of upgrade, pause, mint) | inferred |
| **Value flow** | asset × source → sink: transfers out, mints, burns, ledger debits and credits, exchange-rate computations (asset/aggregate ratios) | inferred |
| **State variable role** | ledger, aggregate (total of a ledger, as found in validator fix V1), config, authority, lock, one-time flag, oracle cache, implementation pointer (including EIP-1967 slots) | inferred |
| **State transition** | lifecycle states, such as uninitialised → initialised → paused → active → retired, with the functions that move between them and their guards | inferred |
| **Entry point / attack surface** | each externally callable function in each deployed contract, plus `fallback`/`receive`, proxy-forwarded implementation functions (failure class D) and callbacks the contract makes to untrusted code (re-entry windows). Each entry point has: reachable assets, writes to authority/ledgers/aggregates, external calls before or after writes, boundary crossed | inferred |
| **Interaction** | cross-contract: proxy ↔ implementation (with the storage-layout comparison, class E), factory ↔ child (transitive authority, class C), vault ↔ token. Multi-transaction: sequences enabled by state transitions (init → use; deposit → redeem; queue → execute), pairs of entry points sharing a ledger or aggregate (cross-function re-entry, exchange-rate manipulation) | inferred |
| **Unknowns** | every construct not modelled: inline assembly (until class B), unresolved imports, dynamic targets. Recorded as `research_coverage(result='not_modelled')` | explicit |

## 3. Who consumes it, and how (one representation, no private copies)

| Consumer | Uses |
|---|---|
| 5.4 structural analysis | functions, call edges, state-variable roles; replaces specialist-local re-derivation of authorities and ledgers |
| 5.5 specialists | access control ← roles + trust boundaries; reentrancy ← re-entry windows × ledgers/aggregates; upgradeability ← proxy interactions, implementation pointers, initialisers; economic ← value flows and exchange rates; integration ← external integrations and their assumptions |
| 5.6 challenge | seeds validator worlds consistently (ledgers *and* aggregates, roles, balances), choosing scenarios from interactions instead of a fixed template |
| 5.5A Weirdness | statistical and structural anomalies **relative to this model**: unusual boundaries, asymmetric guards between twin functions, unexplained assets, state transitions with no guard |
| APEX | exploration space: entry points × interactions × state transitions (path and sequence search), assumptions to break (the `assumed` facts) |
| Priority Engine / T-052 | component and class units for coverage; size and complexity for cost estimation |
| Control Room and dossiers | an architecture view generated from stored facts, with evidence spans |
| Domain packs (MD) | the same entity kinds (component, entry point, boundary, asset, flow, interaction, unknown) with domain-specific builders. The interfaces are domain-neutral; the Solidity builder is the first implementation |

## 4. Build order (after T-149 approval; each step with development fixtures and mutation coverage)

| Step | Content |
|---|---|
| P1 | Components, functions, call edges, inheritance (from the existing index): **export**, do not re-derive |
| P2 | State-variable roles: ledger, aggregate, authority, implementation pointer (including assembly slots, class B) |
| P3 | Privileged roles and trust boundaries |
| P4 | Assets and value flows |
| P5 | Entry points and attack surface, including proxy-forwarded and callback windows |
| P6 | Interactions: proxy ↔ implementation, factory ↔ child, cross-function pairs, state transitions |
| P7 | External integrations with explicit assumptions |

Each step must show **consumption**: at least one specialist or validator switches from private derivation to the model, with
development fixtures proving no regression on the dev corpus and corpora 1–3. Development evidence only; corpus 4 is the measurement.

## 5. Acceptance criteria
- Deterministic: same snapshot → same model blob hash.
- Every fact has an evidence span and a derivation kind; no `assumed` fact is presented as `syntactic`.
- Unknowns are recorded, never dropped.
- On the real-run repository (`crytic/not-so-smart-contracts` @ `020dbdb`), the model identifies the documented roles and value flows of
  the in-scope examples (development evidence, inspected by a human).
- No consumer keeps its own copy of these facts.
