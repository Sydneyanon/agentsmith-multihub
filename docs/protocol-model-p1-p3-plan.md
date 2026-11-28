# Protocol model v1: P1–P3 implementation plan (approved as plan under A20, 2026-11-26; implementation not started)

**Rule for every step (owner condition).** A step is done only when it produces **evidence-backed output** and has **at least one real
consumer** that uses it in place of a private derivation, with a measured effect. Done means:
- the consumer's private code is removed or replaced;
- no regression on the dev corpus and corpora 1–3 (development evidence);
- the mutation spec covers the new facts.

A model nobody consumes does not count. **Stop/go review with the owner after P3**, before P4–P7.

**Storage without a migration.** The model is a deterministic JSON artifact. It is stored as a content-addressed blob in `research_blobs`
and referenced from the `analyze_structure` step output (`protocol_model_sha256`, `builder_version`). The `protocol_models` table (T-149
section 3) waits for the T-149 migrations; until then nothing new is added to the schema.

**Shape (all steps).** Every fact has:
- `kind`, `id`;
- `evidence`: a list of `{file, lineStart, lineEnd, blobSha256}`;
- `derivation`: `syntactic`, `inferred:<rule-id>`, `assumed` or `declared`.

Unknowns go to an `unknowns[]` list, later written as `research_coverage(result='not_modelled')` once T-144 is applied. The builder is a
pure function `buildProtocolModel(index: ProgramIndex, analyzer: Analyzer) → ProtocolModel`, versioned `protocol-model/1`.

## P1: components, functions, call edges, inheritance (export what exists; do not re-derive)
- **Content.**
  - **Components:** deployable contracts, libraries and interfaces, each with a content hash of its source span and its linearisation.
  - **Functions:** per **deployed** contract, from `deployedEntryPoints` plus internal functions, with visibility, mutability, modifiers
    and the deployed-context trace summary.
  - **Call edges:** internal, typed external, low-level, delegatecall, with target provenance from the trace (`targetTaint`, `targetVar`).
  - **Inheritance:** overrides, and the resolved virtual hook per deployed contract (class A).
- **Consumer 1, Priority Engine coverage units.** `coverage.ts` currently takes hand-built `ComponentSnapshot`s; an adapter builds them
  from P1 components (id, content hash, weight = number of external state-changing functions).
  - **Measured:** stable component hashes across the two independent acquisitions of `crytic/not-so-smart-contracts` @ `020dbdb`; a
    changed-file fixture changes only that component's hash.
- **Consumer 2, dossier.** An "Architecture" section built from P1 facts only, each with its evidence span.
- **Acceptance.**
  - Same snapshot, same blob hash.
  - Every fact has evidence.
  - Unresolved imports and inline assembly are listed in `unknowns`.

## P2: state-variable roles
- **Content.** Each state variable gets a role:
  - `ledger` (address-keyed numeric mapping);
  - `aggregate` (a scalar updated with `+=`/`-=` alongside a ledger, the V1 rule);
  - `authority` (read by an authorising guard, or recorded from the constructor's `msg.sender`);
  - `implementation_pointer` (including EIP-1967 constants; assembly slots only once class B is designed in);
  - `lock`, `one_time_flag`, `config`, `unknown`.

  Each role names the rule that derived it.
- **Consumer 1, reentrancy validator.** `simulate.ts` currently derives ledgers and aggregates privately. It switches to P2 roles to seed
  validator worlds.
  - **Measured:** identical verdicts on every reentrancy lead in the dev corpus and corpora 1–3, including the corrected MerchantEscrow
    verdict; the private derivation is deleted.
- **Consumer 2, specialists' authorities.** `Analyzer.authVars` switches to P2 `authority` roles.
  - **Measured:** identical findings on the dev corpus and corpora 1–3; the name-based heuristic becomes a recorded `inferred:name`
    derivation, not a silent fallback.
- **Acceptance.** No regression; `unknown` roles are listed, never guessed.

## P3: privileged roles and trust boundaries
- **Content.**
  - **Roles:** name, holding mechanism (variable, mapping, role table, immutable), grant and revoke paths, transferable or renounceable,
    the initialiser that sets it, and the functions it gates.
  - **Trust boundaries:** anyone → role, role → owner, contract → contract (factory/child, proxy/implementation where typed), contract →
    external. Each names the guard that enforces it, or `none`.
- **Consumer 1, access-control and initializer specialists.** They decide "privileged and unguarded" from P3 boundaries instead of
  `AUTH_VAR_NAME` / `PRIV_NAME` / `INIT_NAME` patterns.
  - **Measured:** no regression on the dev corpus and corpora 1–3. New **development fixtures, written for the class**, show the gains
    the patterns cannot reach:
    - class C, transitive authority through a factory;
    - class G, a version check is not a one-time guard;
    - class H, unguarded authority writes in non-init-named functions.
- **Consumer 2, dossier.** A roles-and-boundaries table with evidence.
- **Acceptance.** Every boundary names its guard or `none`; no role without evidence.

## After P3: stop/go review (owner)
Questions for the review:
1. Did the consumers become simpler (private derivations deleted) and no worse on development data?
2. Did the fixtures for classes C, G and H improve?
3. Are the facts accurate on `crytic/not-so-smart-contracts`, checked by a human?

If not, P4–P7 do not start. The independent measurement is corpus 4 (A2, separate) or a later sealed corpus. Never development
re-scores.

## Explicitly not in P1–P3
- Value flows, assets, state transitions, interactions and external integrations (P4–P7).
- Any new table.
- Any change to frozen candidates or corpora.
- APEX or Weirdness consumers.
