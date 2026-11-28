# Protocol model P2 (state-variable roles): evidence for owner review (2026-11-26). P3 is NOT started; it awaits this review.

**Scope approved:** P2 only (owner, 2026-11-26).

**Built:**
- `apps/api/src/analysis/solidity/state-roles.ts` (`state-roles/1`): **one** shared derivation of state-variable roles.
- It is part of the content-addressed protocol model, now `protocol-model/2` / builder `solidity-p2/1`.
- **No migration.**

## What each classification records (owner requirements 1–5)
| Field | Meaning |
|---|---|
| `role` | `ledger`, `aggregate`, `authority`, `implementation_pointer` or `lock` |
| `basis` | `established` when it follows directly from syntax with no heuristic (a declared address-keyed numeric mapping; use as a delegatecall target), `inferred` when a named rule produced it |
| `strength` | `strong`, `medium` or `weak`. **Name-only or pattern-only evidence is always `weak`**, with an explicit note ("suggests an authority, guarantees nothing"). No role is a security guarantee |
| `rule` | the rule id that produced the role |
| `evidence` | exact file and line locations |
| variable `status` | `classified`; `weak-only` (only weak roles); `ambiguous` (two or more different roles at medium strength or above); `unclassified` (no rule matched: kept with the reason, for later investigation) |

The rules:

| Role | Rule | Basis / strength | Evidence cited |
|---|---|---|---|
| ledger | `address-keyed-numeric-mapping` | established / strong | declaration |
| aggregate | `co-updated-with-ledger-in-trace`: a scalar uint changed with `+=`/`-=` in the same **inlined** trace as a ledger entry | inferred / strong | update lines |
| aggregate | `co-updated-with-ledger-in-body`: the validator's former same-body rule, kept so the shared derivation is a superset | inferred / strong | update line |
| authority | `authorising-guard-read` (polarity from the trace) | inferred / strong | guard line |
| authority | `compared-with-caller` | inferred / strong | comparison line |
| authority | `constructor-records-caller` | inferred / medium | assignment line |
| authority | `caller-indexed-role-name` | inferred / **weak** (name-dependent) | index line |
| authority | `name-pattern` | inferred / **weak** (name only) | declaration |
| implementation pointer | `delegatecall-target` | established / strong | call line |
| implementation pointer | `pointer-name`, `storage-slot-constant-name` | inferred / **weak** | declaration (slot use is in inline assembly, which is not modelled) |
| lock | `checked-set-call-reset`: a scalar bool/uint flag checked, **set by assignment** before an external call and **reset** after it | inferred / strong | guard, set and reset lines |

## Consumers replaced (owner requirement 7), only after equivalence was shown
1. **Specialists' authority detection** (`Analyzer.authVars`, previously private) now reads the shared roles. It counts every authority role,
   whatever its strength, exactly as before; the strength is visible in the model and dossier.
2. **The execution validator's ledgers and aggregates** (previously private, in `simulate.ts`) now come from the shared roles.
3. **The dossier** shows each component's variable roles with basis, strength, rule and lines, and lists unclassified variables.

**Equivalence evidence (before swapping):** on the dev corpus, corpora 1–4 and the real repository, the shared roles' authority, ledger and
aggregate sets equal the private derivations **contract by contract**: 0 differences, 0 missing, 0 extra.

**After swapping:** findings, per-label results and validator verdicts are **identical** to pre-P2 on every corpus (dev 18 findings / 5
validations; corpus 1 18/4; corpus 2 49/8; corpus 3 28/5; corpus 4 37/3).

## Improvement (owner requirement 9): development evidence, not a held-out measurement
**A total maintained in helper functions is now seeded consistently by the validator.**
- **Fixture:** a ledger updated in one function body and its total updated in helpers called by it.
- **Pre-P2 validator** (`2509f15`): **refuted**, from a false underflow it created itself by seeding the total at 0.
- **P2 validator:** **validated**.
- **EVM ground truth:** the fixture compiled with solc and executed: the attack **succeeds**, taking 2 ETH for a 1 ETH credit.
- **Scope of the evidence:** this pattern does not occur in corpora 1–4 or the real repository (0 extra aggregates), so the improvement
  is demonstrated on a development fixture only. It fixes a class of validator error and does not change any existing score.

**A second quality gain, from making the derivation honest:**
- **A wrong lock rule was caught.** The first draft's lock rule misclassified checks-effects-interactions ledgers as locks. The
  `ambiguous` status surfaced it, and the rule was tightened; negative fixtures and mutants now pin it.
- **Weak-only roles are now visible.** For example, `Gateway.owner` and `Expiry.treasury` in corpus 2 are authorities by name only, which
  the former private set silently counted the same as enforced ones.

## Determinism and content addressing (owner requirement 6)
- Roles are sorted and deduplicated. The model hash is stable across builds.
- Two independent clone acquisitions of `crytic/not-so-smart-contracts` @ `020dbdb`, full pipeline each, produced an identical model
  `cad6321c…` and identical dossier content `440eb0c0…`, with 34 leads (unchanged); see `eval/real-runs/not-so-smart-contracts/run6-p2-*`.

## Tests (owner requirement 8)
- **Behavioural tests:** 12 in `state-roles.test.ts`, covering every rule's basis, strength and lines; name-only stays weak; negative
  cases (one-time flag, counter, timestamp, checks-effects-interactions); unclassified with reason; ambiguous; determinism; the helper-split
  improvement against the validator. Plus dossier assertions in the workflow integration test.
- **Mutation testing:** P2 spec 12/12 killed; three survivors in the first run led to the negative fixtures. Analyzer spec 36/36, with one
  stale mutant re-pointed to the shared module. P1 spec 18/18.
- **Full verify:** 821 unit tests, 254/254 integration as owner and as restricted role. Frozen records unchanged.

## Coverage and where P2 cannot classify reliably (owner requirement 10)
| Source | Variables | Classified | Weak-only | Ambiguous | Unclassified |
|---|---|---|---|---|---|
| dev corpus | 15 | 10 | 1 | 0 | 4 |
| corpus 1 | 73 | 48 | 10 | 0 | 15 |
| corpus 2 | 114 | 58 | 8 | 0 | 48 |
| corpus 3 | 391 | 145 | 27 | 0 | 219 |
| corpus 4 | 486 | 149 | 64 | 0 | 273 |
| `not-so-smart-contracts` | 212 | 52 | 1 | 0 | 159 |

**Limitations:**
- **Most variables are unclassified** (about 50–75% on the larger sets). Many are legitimately outside the five roles: configuration,
  counters, arrays, metadata. They are listed, not guessed.
- **Indirect authority structures are missed.** Owner sets checked through index casts or arrays are not recognised: the Parity
  `WalletLibrary` uses `m_owners` / `m_ownerIndex` with `m_ownerIndex[uint(_addr)] > 0`, and both stay unclassified. Role tables keyed
  by `bytes32` roles are recognised only when an authorising guard reads them.
- **Proxy storage is not visible.** EIP-1967 slots are recognised only by constant name (weak), because inline assembly is not modelled
  (failure class B).
- **Only one lock shape is recognised** (check, set, call, reset in one trace). Locks implemented in an inherited contract whose modifier
  the tracer cannot see, or with a counter, are not classified as locks.
- **Ledger means "address-keyed numeric mapping".** Nested mappings (`mapping(address => mapping(address => uint))`), struct ledgers and
  share accounting by non-address keys are not recognised as ledgers.
- **No ambiguous variables occurred** after the lock fix. The status exists and is tested, but real-code examples are not yet observed.
- Roles are derived over the declared linearisation. They say what the code does with a variable, not who can **seize** a role. That is
  P3 (privileged roles and trust boundaries), **not approved**.

## Decision for the owner
- **Accept or reject the P2 milestone.**
- If you accept it, **P3** (privileged roles and trust boundaries, consumed by the access-control and initializer specialists) is the
  next step in the plan. It is **not started** and needs explicit approval.
