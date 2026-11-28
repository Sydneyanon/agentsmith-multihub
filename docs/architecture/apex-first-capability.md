# APEX first capability: protocol-state exploration over the bounded interpreter (design for owner review)

**Status:** design, written 2026-11-28 against commit `7c2b37a`. **Not approved for implementation.** It refines §7 of
`docs/architecture/integrated-research-architecture.md` (APEX components A3, A4, A7 and A11; milestone M3) into one first capability.
It does not change the milestones, the binding rules in `docs/apex.md` §4, or any frozen corpus. A small **PROTOTYPE** was written to
test feasibility (§8). It lives under a `testing/` directory, which `tsconfig.build.json` excludes from production builds. It is wired
into nothing, and it was run only on self-authored contracts inside a unit test.

**Blind-integrity statement.** For this design I read the documents and code named in the task. From `eval/heldout5` I read only
`BRIEF.md`, `PROCESS.md` and `AMENDMENT-1-PROPOSED.md`. From `docs/vuln-detection-benchmark.md` I used only class names and the
published baseline figures. I opened no heldout or benchmark-b contracts, labels or results, and I fetched or analysed no third-party
code. The prototype's contracts were written for this document.

---

## 1. Definition

**APEX is** AgentSmith's autonomous exploration engine. It forms its own understanding of a protocol: the shared protocol model plus
executions of that model. From that understanding it generates **challengeable hypotheses**, each with:
- the property it believes the protocol intends;
- the concrete evidence that the property can be broken;
- a record of what it explored and what it did not.

It reads and writes only the shared research state (`docs/apex.md` §4.1). It proposes; it never decides.

**APEX is not:**
- **Scanner orchestration.** Running Slither, Echidna or Foundry and relabelling their output is the job of the tool stages
  (`slither_scan`, the proposed `reproduce_leads`). Those tools are APEX's instruments and baselines, never its source of hypotheses.
- **A new name for static analysis.** The structural specialists (`specialists.ts`) already match patterns in a single function. An
  APEX hypothesis must rest on something the specialists do not compute: an **inferred property** of the protocol, plus an
  **executed sequence** that violates it.
- **A validator of its own output.** The counterexample sequence is evidence that APEX *offers*. It counts towards status only after
  a different capability family reproduces it (§4.8).
- **A volume generator.** It is judged by independently confirmed, non-duplicate discoveries per unit of cost (`docs/apex.md` §3.1),
  never by how many hypotheses it emits.

**Operational test for "APEX-originated".** At the moment the hypothesis is created, all three of these hold:
1. its generator is an APEX component;
2. its rationale names an invariant candidate that APEX derived and that honest sequences supported;
3. **no** lead from another producer existed on that snapshot, contract, function and class (§4.6).

Anything else is either "derived from a known finding" or "scanner-originated" (§6.1).

---

## 2. The first capability

### 2.1 Choice

**Protocol-state exploration over the existing interpreter (`simulate.ts`).** It has five steps:
1. Deploy a contract in the modelled world.
2. Infer candidate invariants from the protocol model's state roles.
3. **Sensitivity check:** keep only the candidates that honest bounded sequences actually exercise and preserve.
4. Search bounded multi-step sequences of public entry points, called by distinct actors.
5. Report every violation of an established invariant as a hypothesis whose evidence is the shortest counterexample sequence.

v1 invariant families:

| family | candidate | source of the candidate | what a violation means |
|---|---|---|---|
| conservation | `aggregate == Σ ledger[a]` | P2 `aggregate` × `ledger` roles (`state-roles.ts: stateVariableRoles`) | totals and per-account records diverge (mint/burn/fee bugs) |
| solvency | `address(this).balance ≥ Σ ledger[a]` | `ledger` role, contract handles ether | the contract owes more than it holds |
| actor value | an actor's ether received from the contract ≤ ether it sent | contract handles ether | one actor extracts value it never contributed (the cross-actor theft shape) |
| one-way state | a phase variable never returns towards its deployed value, except by the privileged deployer | a bool/uint **read in a guard** (trace `guard` events) | an illegal phase or status change |
| privileged-only state (v1.1) | an authority variable changes only when the sender is the current authority or the deployer | P2 `authority` roles, P3 `authority` facts | privilege escalation by a sequence (overlaps the access-control specialist; marked as such) |

### 2.2 Why this and not the alternatives

The prior-art review is the strongest evidence on where APEX can add value (`docs/apex-prior-art-pass2.md` §4):
- **Oracles, not search, are the bottleneck.** Most exploitable bugs are beyond tools because those tools rely on simple general
  oracles or on hand-written properties [F1, F15].
- **Multi-transaction business-flow semantics remain hard.**

Sequence search on its own is not new: Echidna, Medusa, Foundry invariant mode and hevm already do it (§3, capability 4, "integration").

The defensible contribution of this capability is therefore **automatic oracle inference from AgentSmith's own protocol model,
filtered by honest executions, with no hand-written property**. The search is only the means of testing those oracles.

| alternative | for | against (evidence) | verdict |
|---|---|---|---|
| **A. Protocol-state exploration (chosen)** | Reuses EXISTING substrate: `Interp` and `World.clone/restore`, P2 roles. The prototype shows the interpreter executes multi-call, multi-actor sequences with state carried between calls (§8). Its output is a concrete, replayable sequence that maps directly to a Foundry test (`agentsmith-sequence/1`, arch. §4). Covers the semantic classes the specialists cannot: `accounting-invariant` is in `NOT_MODELLED_CLASSES` (`engine/classes.ts`) | The interpreter has one contract and no tokens or oracles (§3). The capability is narrow by construction | **first** |
| B. Assumption extraction (A2) | Targets the stated gap of oracle and assumption inference | Its output is a list of assumptions with no executable check. Its acceptance test needs a preregistered assumption list from the corpus author (arch. A2). It is not demonstrable without a human-written key, and it is weak as evidence | second; it feeds A later as candidate sources |
| C. Cross-contract interaction (A5) | Where real bugs often live | The interpreter is single-contract: storage is keyed by variable name for one `contract` (`simulate.ts:33–52`). Interface calls are `Unsupported` (`:134`, `:161`). Most of the work would be building an interpreter, not APEX | after v1, as an interpreter extension (§5, increment 8) |
| D. Ordering and MEV scenarios (A8) | A known gap | Needs prices, oracles and token semantics, none of which are modelled. Every result would be an artefact of the model | later |
| E. Experiment selection by information value (A10) as the first capability | Cheap | It has no hypotheses of its own to select among. Synthetic replay shows policy v1 does **not** beat round-robin (`docs/adaptive-priority-engine-design.md` §11.1). No real runs exist to learn from | it is built *inside* A as a budgeted sub-policy (§4.5) |
| F. Echidna or Foundry invariant fuzzing with inferred properties | A real EVM, so fewer modelling gaps | The tools image is not approved (A39, arch. §8). Using the tool as the generator turns APEX into orchestration. Echidna is planned as an **independent evaluator** of A's candidates (R14), which is worth more | as validator, not generator |

### 2.3 Realistic expected value

The expected value is stated before any build so that it can be checked later. It is **not** a promise.

- **Controlled corpus (§6.2):** high detection on vulnerable twins is likely, because the corpus is written in the interpreter's
  dialect. That is exactly why a controlled-corpus result is **not evidence of research value**: it only shows that the mechanism
  works. The informative numbers there are the false-positive rate on the negative controls and the comparison against random
  exploration at the same budget.
- **Real repositories, including corpus 5:** **near zero recall is the most likely v1 outcome.** Expected causes:
  - typical in-scope code uses ERC-20 tokens through interfaces (`IERC20(t).transferFrom` is `Unsupported`, `simulate.ts:161`);
  - it uses structs (`member` access is `Unsupported`, `:78`), dynamic arrays (`push`/`length` unsupported), `block.timestamp`
    (`:78`), libraries outside the snapshot (`unresolved call`, `:135`) and oracles.

  The amendment's semantic groups (`accounting`, `invariant`, `state-transition`, `cross-contract`, `economic`, `sequence`) are
  where A *aims*. v1 can reach only those findings expressible in ether-and-mapping contracts.
- **What a positive v1 would look like on real code:** a small number of hypotheses on simple, self-contained components (vault and
  staking cores, claim or vesting state machines), each reproduced in Foundry. One independently confirmed APEX-only finding would
  already be a meaningful result. **Zero is a legitimate, publishable null.**
- **The main value of v1 is learning which interpreter extensions pay off.** The abstention reasons of a real run are recorded per
  function and per construct (§4.4), so the next increment is chosen from measured abstentions, not from intuition.

### 2.4 How this differs from the null-result invariant detector (P14)

| | protocol-invariant detector (`docs/proposals/protocol-invariant.md`) | this capability |
|---|---|---|
| unit | a **single function's** syntactic deltas | **sequences** (length ≤ k) of calls by distinct actors |
| evidence | "this function's `+=`/`-=` pattern differs from the maintainers'" | an **executed counterexample**: the exact sequence and the state before and after it |
| how a candidate becomes trusted | syntactic gates: ≥ 2 maintainers, both increasing and decreasing, more maintainers than breakers. Small contracts rarely pass them | **semantic sensitivity check:** at least one honest transition moved *both* sides of the relation and preserved it. A candidate that honest use never exercises is dropped as vacuous; one that honest use never preserves is dropped as "not an invariant" |
| failure it can hit | silent: cannot fire on small contracts (measured: recall 0, FP 0) | visible: coverage records what was exercised, abstained and dropped, with reasons; a sensitivity test **must fire on synthetic positives before any scoring** (arch. §7.3) |
| bugs that manifest under honest use | out of reach by design (a breaker must be a minority) | in reach: an **established** candidate broken by an honest transition is reported (prototype case A: `mint` establishes it, `burn` breaks it) |
| cross-actor bugs | not expressible | the adversarial phase lets address arguments name other actors (prototype case B) |

The lesson carried over unchanged: **gates are fixed and preregistered before the controlled-corpus run.** A gate changed after scoring
needs a new corpus. The prototype's two gate changes (§8.3) happened during development on self-authored code, before any scoring, and
are declared.

---

## 3. What v1 can and cannot do

### 3.1 Contract shapes the interpreter supports today (cited)

| construct | supported | where |
|---|---|---|
| single deployable contract with inherited bases, modifiers and internal helpers | yes (inheritance by linearisation; modifiers by placeholder) | `index.ts: linearize`, `simulate.ts: withModifiers` (`:187–197`) |
| `uint*`, `bool` and `address` state; mappings, including nested mappings | yes; storage keyed `name\|k1\|k2` | `simulate.ts: key`, `readVar`, `writeVar` (`:41–52`) |
| checked 0.8 arithmetic; pre-0.8 wrapping by pragma; `unchecked {}` blocks | yes | `arith` (`:55–60`), `ProgramIndex.wrapsArithmetic` |
| `require`, `assert`, `revert`, custom-error reverts | yes; a revert undoes the transaction because the explorer restores `World` | `call` (`:131`), `stmt` (`:219`) |
| `msg.sender`, `msg.value`, `address(this).balance` | yes. **The caller must credit `msg.value` to the balance before execution**; the prototype does this, `runFunction` does not | `eval` member (`:74–77`) |
| ether out via `call{value:}`, `send`, `transfer` | yes; receipts are counted only for the actor `"attacker"` (`World.received`) | `call` (`:144–154`) |
| an attacker receive hook that re-enters | yes; off in v1 (`validateReentrancy` covers re-entrancy) | `callback` (`:167`) |
| `if`, ternary, tuple assignment, `delete`, `++`/`--`, named returns | yes | `stmt`, `eval` |
| constructors (base first) | yes, by an explorer-chosen deployer | `runFunction` / `withModifiers` (a constructor skips modifiers, `:188`) |

### 3.2 What it cannot model

Every one of these is either an **abstention** (`Unsupported`, recorded) or a **silent approximation**. A silent approximation is the
dangerous kind, because it can produce a false counterexample.

| gap | behaviour | class | consequence for A |
|---|---|---|---|
| external calls to other contracts or interfaces (ERC-20, oracles, routers) | `Unsupported("external call …")` / `"interface cast"` (`:134`, `:161`) | abstention | every function that touches a token is excluded. **This is the largest recall limit** |
| more than one contract in the world | one `contract` per `Interp` | structural | no cross-contract invariants in v1 |
| real token behaviour (fee-on-transfer, rebasing, ERC-777 hooks, return-false tokens) | not modelled | n/a | none of these classes is in v1 scope |
| oracles and prices | not modelled | n/a | economic classes are out of scope |
| `block.*` (timestamp, number), `msg.data`, `gasleft()` | `Unsupported("member …")` (`:78`) | abstention | time-dependent flows (vesting, auctions) are excluded until a time model exists (§5, increment 7) |
| gas, gas limits, out-of-gas reverts | not modelled | silent | DoS-by-gas is out of scope; loops are not gas-bounded |
| structs, `.field` access, dynamic arrays (`push`, `length`), `bytes`/`string` content | `Unsupported` | abstention | a large share of real code |
| `keccak256`, `abi.encode*`, `ecrecover`, signatures | `Unsupported("unresolved call …")` | abstention | signature replay is out of scope |
| `try`/`catch`, inline assembly, `delegatecall` semantics | `try` unsupported; assembly ignored by the parser; `delegatecall` is recorded, not executed (`:140–143`) | abstention / silent | proxies are out of scope |
| **loops**: at most 8 iterations, then the loop silently exits | `simulate.ts:216` (`n++ < 8`) | **silent** | **can produce a false counterexample** (a loop that would maintain the invariant is cut short). v1 rule: a sequence whose execution hit the loop cap is marked `loop_truncated` and its violations are discarded, not reported (needs a small counter in `Interp`; §5, increment 1) |
| **narrow integer types** (`uint8`, `uint128`): overflow is checked only against 2^256 | `arith` uses one `MAX` (`:20`, `:58`) | **silent** | can hide a real overflow or invent a state. v1 rule: a candidate over a variable of a narrow type is not generated |
| type casts (`uint8(x)`, `uint128(x)`) | pass the value through unchanged (`:132`) | **silent** | as above; a sequence that executes a narrowing cast is marked and its violations are discarded |
| string literals | every literal is `"<str>"` (`:68`) | **silent** | string comparisons are wrong; functions that compare strings are excluded |
| `tx.origin` | always `"attacker"` (`:76`) | **silent** | functions that read `tx.origin` are excluded from v1 moves |
| balance of any other address | `0` (`:77`) | **silent** | functions that read another address's balance are excluded |
| ether sent to actors other than `"attacker"` | balance decreases, receipt not attributed | partial | the actor-value family checks only the observed actor. v1 runs it once per actor role (rename), within budget |
| step limit of 20 000 per path | `Unsupported("step limit")` (`:64`) | abstention | recorded as `budget` in coverage |
| argument values: a small fixed domain (1 ether; actor addresses) | explorer choice | under-approximation | bugs that need specific values (rounding at 1 wei, boundary amounts) are missed. v1.1 adds boundary values from the constants found in guards |

**Principle:** an unmodelled construct may lower recall. It must **never** be allowed to raise a hypothesis. Silent approximations are
therefore either excluded up front or detected during execution, and the affected sequences are discarded.

---

## 4. Architecture and interfaces

All inputs and outputs go through shared state. No private cache or model is kept (`docs/apex.md` §4.1). The stage is an **optional
step of the one `repository_research` workflow**, like `slither_scan`. Its key is `apex_state_explore`, placed between
`analyze_structure` and `challenge_leads`. It is off by default; a worker claims it only when `APEX_STATE_EXPLORE_ENABLED=true`.

```
analyze_structure ──► [slither_scan] ──► [apex_state_explore] ──► challenge_leads ──► [reproduce_leads] ──► build_dossier
   writes model blob,      writes slither       reads model by hash,       same-substrate          foundry-forge          shows APEX
   specialist leads        leads                prior leads; writes        evaluations are         (independent)          hypotheses,
                                                candidates, coverage,      labelled, never         evaluations            coverage,
                                                sequences, hypotheses      counted (R3)                                   independence
```

### 4.1 Inputs

| input | source | rule |
|---|---|---|
| protocol model | `research_blobs` by `protocol_model_sha256` from the `analyze_structure` step output | re-hashed on read; fail closed on mismatch (as `architectureFromStoredModel`). **Never rebuilt** (arch. §2 notes that `mapAndAssign` rebuilds it) |
| sealed snapshot sources | `readSnapshotSources` after `sealedSnapshot` | refuse unless `verifySnapshot` is `ok` and `sealed` |
| prior hypotheses on the snapshot | `hypotheses` (all generators) at step start | used only for the independence marker and for deduplication, never as seeds |
| prior APEX outcomes and coverage | `research_coverage` (0009) by `component_sha256`; `hypothesis_outcomes`; earlier `apex-explore-report/1` blobs | used by selection (§4.5) and learning (§4.7). Only **production** records: evaluation runs use disposable databases (arch. §10) |
| budget | step input: `{ maxSequences, maxDepth, maxWallMs }` | recorded in the report |

### 4.2 Outputs

| output | where | schema |
|---|---|---|
| candidate invariants | one blob per snapshot, `apex-invariants/1`; ids referenced by hypotheses (later R5 `protocol-model/4.assertions`) | `InvariantCandidate[]` |
| exploration report and coverage | blob `apex-explore-report/1`; its hash in the step output; 0009 `research_coverage` rows per (component, class) with `examined` / `abstained` / `not_modelled` and `reason_code` | `ExplorationReport` |
| counterexample sequences | blob `agentsmith-sequence/1`, one per hypothesis (the arch. §4 schema) | `SequenceSpec` |
| hypotheses | `ResearchStore.createHypothesis`: `generator = { kind: "deterministic_rule", id: "apex-state-explorer", version: "1" }`; `family = "apex-invariant-<kind>"` (the *claim* family column); spans = primary span on the breaking function plus a supporting span on each other function in the sequence | as stored |
| capability family | `agentsmith-interpreter`, declared in `CAPABILITIES` and later in R3's `capability_identity(id, family, substrate)` | the substrate is shared with the specialists and validators (§4.8) |
| rationale | the hypothesis `rationale` text holds a short human sentence **plus** the hashes of the invariant record, the sequence blob and the supporting honest sequences | `ApexRationale` (serialised into the report blob; summarised in text) |
| independence marker | R4 `hypothesis_contributions` row, role `originated`, with `prior_suggestions` (arch. §3.3); until R4 exists, recorded in the report blob and the step output | `IndependenceMarker` |
| decisions | 0010 `research_decisions` (level `path`) with every alternative region as a candidate; until 0010 exists, inside the report blob | `ExplorationDecision` |

**Note on "family".** The `hypotheses.family` column holds the *claim* family (today `solidity-<class>`). The *capability* family
`agentsmith-interpreter` is a property of the generator, used by the independence rules (R3). The two are kept apart.

### 4.3 TypeScript interfaces (proposed)

```ts
/** apex-invariants/1 — one blob per (snapshot, protocol model, explorer version). */
export type InvariantKind = "conservation" | "solvency" | "actor-value" | "one-way" | "privileged-only";
export type InvariantCandidate = {
  id: string;                         // stable: `${component}:${kind}:${vars.join(",")}`
  component: string;                  // ProtocolModel component id
  componentSha256: string;            // ComponentFact.contentSha256 (coverage is per content hash)
  kind: InvariantKind;
  statement: string;                  // human-readable, generated from the structured form
  structured:                         // what the checker evaluates; never free text
    | { kind: "conservation"; aggregate: string; ledger: string }
    | { kind: "solvency"; ledger: string }
    | { kind: "actor-value"; actorRole: "observed" }
    | { kind: "one-way"; variable: string; deployedValue: string }
    | { kind: "privileged-only"; variable: string };
  derivedFrom: Array<{ fact: "stateRole" | "guardRead" | "authority"; ref: string; evidence: { file: string; line: number }[] }>;
  sensitivity: {
    status: "established" | "vacuous" | "not_an_invariant" | "abstained";
    supportingTransitions: number;     // honest transitions that moved both sides and preserved it
    supportingSequenceSha256: string[]; // agentsmith-sequence/1 blobs (up to 3, the shortest)
    honestViolations: number;
    reason?: string;
  };
};

/** agentsmith-sequence/1 — replayable by the Foundry template author (R6) without APEX code. */
export type ActorId = "deployer" | "alice" | "bob" | "attacker";
export type SequenceSpec = {
  schema: "agentsmith-sequence/1";
  component: string; componentSha256: string; protocolModelSha256: string;
  deployment: { deployer: ActorId; constructorArgs: Array<{ type: string; value: string }> };
  initialState: "deployed-only";      // v1 never seeds storage directly
  steps: Array<{ actor: ActorId; function: string; signature: string; args: Array<{ type: string; value: string }>; valueWei: string }>;
  expected: { invariantId: string; holdsBefore: true; violatedAfterStep: number; observed: Record<string, string> };
  model: { interpreter: "agentsmith-simulate"; version: string; approximationsHit: string[] }; // must be [] for a reported violation
};

export type FunctionCoverage = {
  function: string; attempted: number; completed: number; reverted: number;
  abstained: { reasonCode: "external_call" | "struct" | "array" | "block_property" | "hash" | "loop_truncated" | "narrow_type" | "params" | "step_limit" | "other"; detail: string } | null;
};
/** apex-explore-report/1 */
export type ExplorationReport = {
  schema: "apex-explore-report/1"; explorer: { id: "apex-state-explorer"; version: string };
  snapshotId: string; protocolModelSha256: string; budget: { maxSequences: number; maxDepth: number; maxWallMs: number };
  components: Array<{
    component: string; componentSha256: string;
    status: "explored" | "abstained" | "not_selected";
    reason?: string;
    phases: Record<"honest" | "adversarial", {
      sequences: number; distinctStates: number; depthReached: number; budgetExhausted: boolean; functions: FunctionCoverage[];
    }>;
    candidates: string[];             // InvariantCandidate ids
    violations: Array<{ invariantId: string; phase: "honest" | "adversarial"; sequenceSha256: string; hypothesisId: string | null; suppressed?: string }>;
  }>;
  notExplored: Array<{ component: string; why: string }>; // explicit absence, never implied
  decisions: ExplorationDecision[];
};

export type ApexRationale = {
  invariantId: string; invariantStatement: string;
  counterexampleSha256: string;                   // the violating SequenceSpec
  supportingHonestSequences: string[];            // SequenceSpec hashes that established the invariant
  whyGenerated: string;                           // e.g. "established by 3 honest transitions (mint, transfer); violated by burn after mint"
  limitations: string[];                          // the model limits that apply (§3.2), always non-empty
};

export type IndependenceMarker = {
  independentOfScanners: boolean;                 // true iff priorSuggestions.length === 0
  checkedAt: string;                              // transaction time of creation
  priorSuggestions: Array<{ hypothesisId: string; generator: string; class: string; function: string }>; // same snapshot, contract, function
  scope: "function+class";                        // v1; "function" is also reported
};

/** One choice of where to spend budget next. Every alternative is recorded, chosen or not. */
export type ExplorationRegion = { component: string; invariantId: string | null; functions: string[]; depth: number; phase: "honest" | "adversarial" };
export type ExplorationDecision = {
  seq: number; budgetLeft: number;
  candidates: Array<{ region: ExplorationRegion; features: Record<string, { value: unknown; source: string } | { value: null; unknown_reason: string }>; score: number; action: "explore" | "defer" | "skip_low_value" | "skip_budget"; reason: string }>;
  chosen: number | null; mode: "exploit" | "explore"; seed: number;
};

/** The step's contract, so the stage stays a thin adapter over pure code. */
export interface StateExplorer {
  explore(input: { sources: ReadonlyArray<{ path: string; text: string }>; model: ProtocolModel; modelSha256: string;
    prior: ReadonlyArray<{ hypothesisId: string; generator: string; class: string; contract: string; function: string }>;
    memory: ExplorationMemory; budget: ExplorationReport["budget"]; seed: number }): {
    candidates: InvariantCandidate[]; report: ExplorationReport; sequences: SequenceSpec[];
    hypotheses: Array<{ claim: string; family: string; rationale: ApexRationale; independence: IndependenceMarker; spans: Array<{ file: string; line: number; role: "primary" | "supporting" }>; sequenceSha256: string }>;
  };
}
export type ExplorationMemory = {
  // per (invariant kind, construct): counts of confirmed / refuted / inconclusive outcomes of earlier APEX hypotheses (production only)
  outcomesByKind: Record<InvariantKind, { confirmed: number; refuted: number; inconclusive: number; adjudicated: number }>;
  // components already explored at the same content hash and explorer version, with their abstention codes
  explored: Array<{ componentSha256: string; explorerVersion: string; status: string; reasonCodes: string[] }>;
};
```

`StateExplorer.explore` is pure. Given the same input and seed, it gives the same output. The step stores the results through
`ResearchStore` under its lease: blobs first, then spans, then hypotheses, then the step output. This mirrors `runStructuralAnalysis`.

### 4.4 Exploration algorithm (v1)

1. **Deploy.** Run the constructors base-first as `deployer`. Address parameters are the deployer; numeric parameters come from the
   small domain. Storage is never seeded (the V1 lesson recorded in `validateReentrancy`: seeding ledgers without aggregates gives an
   inconsistent world).
2. **Generate candidates** from the stored model's P2 roles and the trace guard reads. Exclude the variables §3.2 says to exclude.
3. **Honest phase.** Breadth-first search to depth `k_h`. Actors are `deployer`, `alice` and the observed actor. Address arguments
   are always the caller itself. The search merges identical states (storage, balance, received, sent).
   - Each transition from a state where a candidate held is classified per candidate as *supporting* (both sides moved and the
     candidate held), *violating* or *not touching*.
   - **Sensitivity:** a candidate with zero supporting transitions is `vacuous` or `not_an_invariant`, and is dropped with that
     reason.
4. **Adversarial phase.** The same search to depth `k_a`, but address arguments may name any actor. Only **established** candidates
   are checked.
5. **Report.** Violations come out in breadth-first order, so the first is a shortest counterexample. Execution is then replayed
   once from the deployed state to confirm it is deterministic. Any sequence that hit an approximation (loop cap, narrowing cast,
   excluded construct) is **suppressed**: it is recorded in the report with the reason, and no hypothesis is created.
6. **Deduplicate.** One hypothesis per (component, invariant, breaking function). Other sequences that violate the same pair are
   recorded in the report only.

### 4.5 Experiment selection by expected information gain

Budget unit: one executed transition. Default budget: 50 000 transitions per snapshot, and `k_h = k_a = 3`, raised to 4 for
components with ≤ 6 entry points.

A **region** is (component, invariant or `null`, the subset of functions, depth, phase). Before each region is explored, a decision
lists every region not yet explored, each with these features:

| feature | source | meaning |
|---|---|---|
| `uncertainty` | candidate sensitivity status. `established` with no adversarial coverage = 1.0; a partly covered region = remaining share of distinct states | information is highest where an established invariant has not been attacked |
| `reachability` | share of the region's functions that completed at least once in the honest phase (from coverage) | a region of abstaining functions gives no information |
| `prior_yield` | `ExplorationMemory.outcomesByKind[kind]`: confirmed / adjudicated, used only once `adjudicated ≥ MIN_ADJUDICATED` (5, `loop.ts`); otherwise `unknown` → 1.0 | evidence-gated |
| `novelty` | 1 if no other producer has a lead on the region's functions (independence marker), 0.5 otherwise | APEX should spend where others did not look |
| `cost` | estimated transitions = moves^depth / merge ratio measured in the honest phase | |

`score = uncertainty × reachability × prior_yield × (0.5 + 0.5 × novelty) / cost`. The highest score is explored. Every 5th
decision is a seeded uniform draw (exploration), as in `pickOne`. Every alternative is recorded with its features and their sources:
in 0010 `research_decision_candidates` once applied, and in the report until then. When the budget runs out, the regions left
become `notExplored` entries with `skip_budget`. **Nothing unexplored is ever reported as clean.**

### 4.6 Independence marker

When a hypothesis is created, the stage queries `hypotheses` on the same snapshot for any generator other than
`apex-state-explorer` (structural specialists, Slither, attended producers) with the same contract and function. It records the
matches, and the matches of the same class.
- `independentOfScanners = (matches on function and class == 0)`.
- The function-only count is also reported, because class mapping is imperfect.

The marker is computed **at creation** and never recomputed afterwards (arch. §3.3). A later Slither run that finds the same function
does not change it; it becomes a corroboration (arch. §6.3).

The independence ordering requires `apex_state_explore` to run **after** `analyze_structure` and `slither_scan` in the same run.
Otherwise "independent" would only mean "earlier".

### 4.7 Learning from outcomes (evidence-gated)

- **Only `confirmed` outcomes are positive labels** (`priority/outcomes.ts: splitForLearning`). Refuted and inconclusive outcomes are
  evidence of a different kind.
- **What adapts, and only after `MIN_ADJUDICATED` adjudicated outcomes per invariant kind:**
  - `prior_yield` in selection (§4.5);
  - per-kind generation thresholds, as a recorded policy-version bump (`apex-explore-policy/N`, hashed like `RESEARCH_POLICY_V0`).
- **Refuted** (a Foundry `refute`, or a human `rejects`): the (kind, construct) pair gets a refutation record, linked to the sequence
  blob. Three refutations of the same kind with the same cause trigger a **review**, never an automatic suppression. A human looks at
  whether the model or the candidate rule is wrong.
- **Inconclusive** (the reproduction could not be built): an abstention code (for example `not_reconstructible`) is recorded and
  steers interpreter work (§2.3). It never lowers a kind's yield.
- **Never trained on held-out data.** Evaluation runs use disposable databases and never write production memory. A policy version is
  evaluated only on a corpus frozen before the change. A corpus used for tuning is development data from then on (arch. §10).
  Nothing from `eval/heldout*` or `eval/benchmark-b` is ever read by the stage.

### 4.8 Independence of validation

APEX may not validate its own hypotheses.
- The in-process execution validators share APEX's parser and interpreter. They are the **same substrate**, so any result they give
  on an APEX hypothesis is labelled same-substrate and does not count towards `confirmed` (arch. §3.3, R3).
- **Counting validation:**
  1. a Foundry reproduction (`foundry-forge`, solc + EVM) of the `agentsmith-sequence/1` steps, written by the deterministic template
     author R6 or by `claude-reproducer`, **not by APEX**. The expected effect is fixed in the experiment spec before the run
     (arch. §9);
  2. or an Echidna property check of the same candidate (R14);
  3. then human adjudication for `confirmed` (0009 rules).
- APEX emits the sequence spec. It never writes `hypothesis_evaluations`. Under R3, a database trigger refuses
  `evaluator_id = generator_id`.

---

## 5. Implementation sequence

Each increment is a separate, reviewable change with unit tests. Nothing runs in production until increment 6's gate.

| # | increment | entry criteria | exit criteria (measured) |
|---|---|---|---|
| 0 | **Controlled corpus authored and frozen** (§6.2), with labels and a preregistration (`agentsmith-preregistration/1`) | owner approval of this design | the corpus manifest hash and label hash are committed **before** increment 2 code exists; the development use is declared in `eval/exposure.json` |
| 1 | **Interpreter instrumentation** (no behaviour change): count loop-cap hits and narrowing casts per run; an `approximationsHit` list on `World`; a `creditValue` option on `runFunction` | 0 | all existing tests and every frozen corpus result are byte-identical; new unit tests show the counters fire |
| 2 | **Pure explorer library** `analysis/apex/state-explorer.ts` (the §4.3 interface; candidates, honest and adversarial phases, suppression, deterministic replay); promoted from the prototype by rewrite, not by copy | 1 | the sensitivity test fires on every synthetic positive; determinism (two runs give identical bytes); budget respected; **the controlled-corpus run (once, as preregistered) passes its gates** (§6.4) |
| 3 | **Sequence and invariant blob schemas** (`agentsmith-sequence/1`, `apex-invariants/1`, `apex-explore-report/1`) with strict parsers | 2 | round-trip tests; a reader refuses unknown versions |
| 4 | **Optional `apex_state_explore` step** in `repository_research` (like `slither_scan`): `createResearchRun({ apexStateExplore: true })` requires `structuralAnalysis`; the worker claims it only when `APEX_STATE_EXPLORE_ENABLED=true` | 3 | integration test on a disposable database: hypotheses with generator `apex-state-explorer@1`, spans verified, blobs stored, step output hashes; **off by default**: a run created without the option is byte-identical to today's |
| 5 | **Dossier section**: APEX hypotheses with the invariant, the sequence, the supporting honest sequences, the independence marker and the coverage including `notExplored` | 4 | dossier test: every APEX entry shows its limitations; abstentions are never shown as absence |
| 6 | **Foundry replay** of APEX sequences through R6 / `reproduce_leads` (arch. increment 4) | arch. increments 3–4 (tools image, A39) | on the controlled corpus, every reported vulnerable-twin sequence reproduces under solc + EVM; 0 `supports` on a secure twin |
| 7 | **v1.1 interpreter extensions, chosen by measured abstentions:** in-snapshot ERC-20 as a second modelled contract; struct members; dynamic arrays; `block.timestamp` as a monotone, actor-advanced variable | 4 and abstention data from at least one approved real run | each extension: all frozen results unchanged; on the controlled corpus, the new shapes pass; the abstention share on the real run falls |
| 8 | **Selection by information gain** (§4.5) with recorded decisions (0010) | 4; 0010 applied (A29) | on a frozen replay, more established-invariant coverage per transition than uniform region choice; all alternatives recorded |
| 9 | **Blind evaluation** (§6.5) | A22 and A23 approved; APEX v1 **registered before selection** | scored once; result published whatever it is |

The structural analyzer, the specialists, `validateReentrancy` and `challengeFinding` are not changed by any increment except the
instrumentation in increment 1.

---

## 6. Evaluation proposal (Workstream 4)

**Question:** does APEX produce **useful, independent** research, or does it repeat what scanners and specialists already produce?

**A successful build, a passing test suite or a high hypothesis count is not evidence of that.** Only independently reproduced or
adjudicated findings that no baseline produced count as added value.

### 6.1 Categories

Every lead from every capability falls into exactly one category. The category is computed from stored records, never asserted.

| category | rule |
|---|---|
| **APEX-independent hypothesis** | generator `apex-state-explorer`; `independentOfScanners = true` at creation |
| **scanner-originated finding** | generator `slither`, `solidity-structural-specialists` or another producer |
| **derived from a known finding** | APEX hypothesis with `independentOfScanners = false`, or whose function is the subject of an external reference (0009 `external_references`) |
| **independent reproduction** | a `supports` evaluation by `foundry-forge` (or Echidna) on a test not authored by the generator |
| **false positive** | on a secure control, or adjudicated `refuted` with the cause recorded (model artefact, intended behaviour, wrong invariant) |
| **refuted** | an independent evaluation `weakens`/`contradicts`, or a human `rejects` |
| **inconclusive** | no independent evaluation could be built (`not_reconstructible`, tool abstention); never counted as true or false |

### 6.2 Controlled corpus (new, self-authored, development only)

- **Declared status:** `eval/apex-dev-1/`, `exposure: development`. Authored by the APEX developer, so it measures *mechanism*, not
  research value.
- **Freezing:** labels are frozen and hashed **before** APEX v1 (increment 2) is run on it.
- **Contents (target 24 contracts):**

| group | n | examples (shapes, not copies of any benchmark) |
|---|---|---|
| sequence-dependent and invariant bugs, vulnerable twin | 8 | burn or fee path that skips the aggregate; cross-actor withdrawal; a phase flag reversible by a user; a claim that can repeat after a reset; a two-step withdrawal whose second step does not consume the first; an emergency path that skips accounting; a reward accrual that does not settle before a balance change; a deposit cap bypassed by a sequence |
| secure twin of each | 8 | the same contract with the one-line fix |
| negative controls: honest multi-step protocols | 4 | request → complete withdrawal; commit → reveal; stake → unstake with a cooldown flag; owner pause → unpause |
| negative controls: intentionally asymmetric but correct accounting | 4 | fees kept outside the ledger; a protocol-owned reserve; rounding dust kept by the contract; a donation function that raises the balance without a ledger entry |

- **Labels:** per contract, the vulnerable function and the broken property (one sentence), or `secure`.
- **Bias control:** a second person (or an attended `claude-challenger` session that sees only the contracts) checks that each
  secure twin is really secure **before** freezing.

### 6.3 Null hypotheses and baselines (same corpus, same budget where applicable)

| baseline | what it isolates |
|---|---|
| **N1 random sequence exploration**: uniformly random actor, function and arguments, same transition budget, same candidates and same checker | the value of systematic breadth-first search and merging over chance |
| **N2 random candidates**: the same explorer, with invariants drawn uniformly from all (variable, variable) pairs and kinds, no role inference, same sensitivity rule | the value of inferring oracles from the protocol model |
| **N3 no sensitivity check**: the same explorer with every generated candidate treated as established | the value of the honest-sequence filter (predicts more false positives on the asymmetric controls) |
| **N4 structural specialists** (`solidity-structural-specialists@1`), run as today | what pattern detection already finds |
| **N5 Slither's recorded output** where it exists (the CI-recorded runs). On the new corpus it can be run only where the tools image is approved; otherwise it is reported as abstained, never as zero | what an external scanner finds |

### 6.4 Metrics and gates (preregistered with the corpus)

- **Recall** on vulnerable twins and **precision** over all APEX leads, with 95% Wilson intervals.
- **False-positive rate on secure twins and negative controls.** Gate: ≤ 1 false positive across all 16 non-vulnerable contracts.
- **Added value:** the count of verified true findings that **no baseline N4 or N5 produced**. Verification is a Foundry reproduction
  of the sequence. The count is reported even when it is 0.
- **Reproduction rate:** reported sequences that replay under solc + EVM, divided by reported sequences. Gate before any real run:
  ≥ 0.9, with **0** reproduced on a secure twin.
- **Against the nulls:** APEX must beat N1 on recall at equal budget and N3 on false-positive rate. If not, the component that does not
  beat its null is not promoted.
- **Cost:** transitions and wall time per supported lead.
- **Sensitivity gate (from the P14 lesson):** the explorer must fire on every synthetic positive in its own unit tests before the
  corpus is scored. A detector that cannot fire is not scored.

**Score once.** If a gate fails, the result is recorded as it stands. Changing a gate needs a new controlled corpus `apex-dev-2`.

### 6.5 Genuine blind evaluation: corpus 5 with the proposed amendment

- **Use corpus 5 only after the owner approves A22 (selector and acquisition, with Amendment 1) and A23 (registration and scoring).**
  This document does not start any selection or scoring and changes nothing under `eval/heldout5`.
- **Registration timing matters.** Amendment 1 §3.3 scores "any semantic or APEX candidate registered before selection".
  `apex-state-explorer@1` can be scored on corpus 5 only if it is frozen and registered in `eval/candidates.json` **before the
  selector starts**. If v1 has not passed §6.4 by then, it should **not** be registered, and it waits for R12 or a later corpus.
  Registering an unready candidate burns a blind corpus.
- **Preregistered claim on corpus 5:**
  - the amendment's primary claim rule (semantic-group recall higher, 95% intervals not overlapping, control false-positive rate not
    higher) applied to "structural analyzer alone" against "structural analyzer plus APEX";
  - the APEX-only discovery count, reported separately.
  - Given §2.3, the expected outcome is **"no demonstrated difference"**, and that result is recorded and published as such.
- **Not blind:** benchmark-b, whose class descriptions are published in `docs/vuln-detection-benchmark.md`. It may be used as
  development data only and is never reported as a blind result.

---

## 7. Risks and failure modes

| risk | how it shows | mitigation in this design |
|---|---|---|
| **Path explosion** | moves^depth grows exponentially. In the prototype, a 6-function contract at depth 4 explored 6 084 honest and 10 140 adversarial transitions (1 186 distinct states after merging), while depth 3 on 2–3 function contracts needs 36–400 | state merging; a depth cap; a transition budget with recorded exhaustion; region selection (§4.5); per-region function subsets taken from the read/write sets of the invariant's variables, so only functions that touch them are combined |
| **Modelling gaps produce false counterexamples** | silent approximations (§3.2: loop cap, narrow types, casts, strings, `tx.origin`, other balances) | excluded up front or detected and suppressed (increment 1); a reported sequence must have `approximationsHit = []`; Foundry replay before any human sees it as supported; the dossier always shows the limitations |
| **Intended behaviour read as a violation** | asymmetric accounting, admin resets, rewards. The prototype hit two such cases on an unstructured contract before its gates were fixed (§8.3) | sensitivity (support needs both sides to move); one-way only for guard-read variables, and reversal by the deployer is allowed; the asymmetric negative controls in §6.2; N3 measures the filter |
| **Under-approximation hides real bugs** | a small argument domain; three actors; depth 3 | recorded as coverage, never as "no finding"; v1.1 boundary values; depth raised where cheap |
| **Leakage** | design or tuning informed by blind corpora | no heldout or benchmark-b content read (statement above); evaluation runs on disposable databases; `eval/exposure.json` entries; corpus 5 used only under A22/A23 |
| **Overfitting to self-authored examples** | the same person writes the contracts and the explorer, so the corpus mirrors the explorer's dialect | the corpus is frozen before the explorer is run; a second reviewer checks the secure twins; the result is described as mechanism-only; the claim of research value waits for a blind corpus written by someone else (R12, corpus 5) |
| **Same-substrate confirmation** | the in-process validators "agree" because they share the parser | R3 labels same-substrate evaluations; only Foundry or Echidna count |
| **Scanner echo** | APEX re-finds what the specialists found and it is counted as new | the independence marker is computed at creation, and those hypotheses are categorised "derived" (§6.1) |
| **Volume as success** | many hypotheses on real code | precision and reproduction gates; a hypothesis cap per component (default 5) with the overflow recorded, not stored |

---

## 8. PROTOTYPE results (feasibility only)

**Files:**
- `apps/api/src/apex/testing/state-explorer-prototype.ts`
- `apps/api/src/apex/testing/state-explorer-prototype.test.ts`

**Status:**
- labelled PROTOTYPE in both files;
- under `testing/`, so excluded from production builds by `tsconfig.build.json`;
- imported by nothing outside its own test;
- not a pipeline step;
- not scored on any frozen corpus.

**Generator id:** `apex-state-explorer@0-prototype`. It writes nothing to the research store.

### 8.1 What it does

The prototype is about 230 lines. It uses `Interp`, `World.clone/restore`, `ProgramIndex.deployedEntryPoints`,
`stateVariableRoles` and `Tracer` guard events, without changing any of them. It implements the conservation, solvency,
actor-value and one-way families, the two phases, breadth-first search with state merging, and the sensitivity rule. It produces
hypothesis drafts with spans, rationale and an independence marker computed against `analyzeSources` (the structural specialists;
Slither is not run).

### 8.2 Results (9 tests, all pass)

| case (self-authored) | expected, written before the first run | result |
|---|---|---|
| A vulnerable: `burn` lowers `balanceOf` but not `totalSupply` | conservation violated by `burn` | `owner0:mint(owner0, 1e18) -> owner0:burn(1e18)`, honest phase; supported by 3 honest transitions; `independentOfScanners: true` |
| A secure | nothing | nothing |
| B vulnerable: `withdrawFor(who, amount)` with no check | actor-value violated, adversarial phase, 2 transactions | `owner0:deposit() [1 ether] -> attacker:withdrawFor(owner0, 1e18)`; conservation and solvency hold (correctly); no specialist lead on `withdrawFor` → `independentOfScanners: true` |
| B secure (`require(who == msg.sender)`) | nothing | nothing |
| C vulnerable: `reopen()` with no guard after the owner's `close()` | one-way violated | `owner0:close() -> alice:reopen()`; no specialist lead → independent |
| C secure (`reopen` owner-only) | nothing | nothing (a reversal by the deployer is administrative) |
| D negative control: fee kept outside the ledger; two-step withdrawal | nothing | nothing; the candidate `totalFees == Σ balances` is generated, then dropped by the sensitivity check (`established: false`) |
| E negative control: unrelated counters, an ether sink, an arbitrary mapping setter, a resettable counter (depth 4) | nothing | nothing; 6 084 honest transitions, 1 186 distinct states, budget not exhausted |
| coverage of an unmodelled construct (`block.timestamp`) | reported as unsupported | `completed: 0`, `unsupported: "member block.timestamp"` |

Test output (`npx vitest run apps/api/src/apex`):
```
 ✓ apps/api/src/apex/testing/state-explorer-prototype.test.ts (9 tests) 320ms
      Tests  9 passed (9)
```
Full suite: `npm run typecheck` exit 0; `npm test`: 68 files, 1047 passed, 1 skipped.

### 8.3 Changes after the first run (declared)

1. **A modelling bug in the prototype.** An unwritten storage slot was read as `null` instead of its type default, so `closed = false`
   on a fresh slot counted as a change. Case C then reported a one-step "violation" (`alice:reopen()` from the deployed state). This
   was fixed by reading defaults as the interpreter does. The expectation was not changed.
2. **Two gate refinements, found on case E, which I wrote as an unstructured probe:**
   - support must move **both** sides of the relation (balance-only changes had "established" solvency over a non-ether mapping);
   - one-way candidates only for variables **read in a guard** (a resettable counter had been reported).

   Both are now part of the design (§4.4). These are development changes on self-authored code. They are exactly the kind of change
   that §6.2's freeze-before-run rule forbids once the controlled corpus exists.

### 8.4 What the prototype could not do, and what it showed

- **The interpreter supports multi-call, multi-actor sequences without modification.** State carries across calls through `World`, a
  revert is undone by `restore`, and actors are just `msg.sender` strings. The one thing the caller must do is credit `msg.value` to
  the balance before a payable call.
- Only the actor named `"attacker"` has its ether receipts counted. The actor-value family can therefore observe one actor per run.
- No time, tokens, structs or arrays; anything outside the contract abstains (shown by the coverage test).
- The loop cap and narrow-type approximations are **not yet detected**. The prototype does not suppress sequences that hit them, which
  is why increment 1 comes first.
- **Path growth is real.** Depth 4 on six functions is already about 16 000 transitions. Budgets and region selection are needed
  before any real repository.
- The independence marker compared only against the structural specialists. Slither was not run.
- The prototype says **nothing** about detection quality on real code.
