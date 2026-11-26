# AgentSmith APEX: Autonomous Path Exploration & Exploitation Research Engine

Status: **permanent roadmap commitment, recorded 2026-11-26. Not designed in detail, not authorised for implementation, not started.** It does not interrupt the structural analyzer, compiler validation, held-out evaluation or research-workflow work. First tasks, when dependencies are mature: T-150 (prior-art and novelty assessment) and T-151 (architecture and integration design); nothing is implemented before both are reviewed.

## 1. Purpose
A proprietary vulnerability-discovery capability that goes beyond scanners, predefined patterns and existing tools: finding previously unrecognised vulnerabilities by reasoning about execution paths, protocol interactions, hidden assumptions, unusual state transitions and combinations of individually legitimate operations. The ambition is to find what conventional approaches miss. **That claim is to be measured, never assumed** (section 6).

## 2. Placement and numbering
APEX is a **dedicated workstream under 5.5 Specialist Research Intelligence**, with its own identity alongside the Weirdness Engine (5.5A). **No phase is renumbered.** Its identifier is the workstream label `5.5-APEX` (it is not a phase number), its tasks are T-150 to T-162, and it carries no change to 5.0-5.8. If a later design needs an actual phase renumbering it will be proposed and explained here first, not applied silently.

| Roadmap element | Relationship to APEX |
|---|---|
| 5.1 Research state | Every APEX path, hypothesis, counterexample and memory record is stored through the existing store (spans, hypotheses, evaluations, reviews). Discovery memory (capability 8) extends it; extensions need a reviewed migration. |
| 5.2 Acquisition | APEX consumes only sealed, commit-pinned snapshots. |
| 5.3 Intelligence mapping | Supplies the **shared protocol representation** (contracts, calls, trust boundaries, assets, integrations) that APEX explores. APEX does not build a private model. |
| 5.4 Structural analysis | The effect traces, inlining of helpers and modifiers, and the execution interpreter are the substrate of the Execution Path Explorer. |
| 5.4B Automated toolchain | Foundry, Slither, Aderyn and any fuzzer or symbolic executor are **supporting instruments** (evidence sources, validators) and **comparison baselines**, never replaced or ignored. |
| 5.5 Specialist intelligence | Specialists supply domain assumptions and checks; APEX searches across them and records which specialist contributed. |
| 5.5A Weirdness Engine | Cooperating component: anomaly and contradiction signals steer the Adaptive Search Engine; APEX hypotheses can be returned to it. Origin is always recorded. |
| 5.6 Independent challenge | APEX **never judges its own output**. Its counterexample engine produces reproducible evidence; the independent challenge and review stage decides. |
| 5.7 Dossiers | Dossiers include APEX path traces, assumptions and counterexamples with provenance. |
| 5.8 Benchmarks and learning | Supplies frozen baselines and held-out corpora APEX does not write or grade; receives APEX outcomes for learning. |
| Adaptive Research Priority Engine | Allocates APEX's search budget and supplies coverage records (`adaptive-priority-engine-design.md`). |
| Control Room | Shows APEX activity only from stored records. |

## 3. The eight capabilities (preserved)
| # | Capability | Intended function | Builds on (exists today) | Open |
|---|---|---|---|---|
| 1 | **Execution Path Explorer** | Construct and explore execution paths across functions, modifiers, internal helpers, contracts and transaction sequences | `analysis/solidity/trace.ts` (inlined effect traces), `simulate.ts` (interpreter), per-function reachability challenge | multi-contract world, path explosion control, transaction sequences, storage aliasing |
| 2 | **Assumption Breaker** | Extract explicit and implicit security assumptions (guards, invariants, trusted callers, ordering, value ranges, oracle freshness) and systematically investigate how each might fail | guard extraction (`auth`, locks, one-time flags) as the seed of an assumption catalogue | what counts as an assumption; implicit assumption extraction; recording assumptions as first-class records |
| 3 | **Protocol Interaction Explorer** | Analyse interactions among contracts, integrations, oracles, tokens, lending, vaults, bridges and external dependencies | typed in-repository call resolution; cross-contract inlining (limited) | models of external protocols and tokens; economic semantics; unresolved/imported code |
| 4 | **Temporal Sequence Hunter** | Explore unusual sequences of valid operations, state transitions, upgrades, partial operations and transaction ordering | re-entrancy attacker search (bounded two-call orderings) | general sequence search, upgrade and migration states, ordering/MEV-style assumptions |
| 5 | **Novel Hypothesis Generator** | Create original, evidence-backed hypotheses beyond fixed templates | seven deterministic template specialists (the thing APEX must go beyond) | how novelty is defined and measured; model involvement is spending and needs separate approval |
| 6 | **Adaptive Search Engine** | Prioritise promising and unexplored paths from evidence, coverage gaps, novelty and measured discovery value | Priority Engine design (coverage, exploration quota) | search strategy, learned guidance only from independently confirmed outcomes |
| 7 | **Counterexample and Validation Engine** | Attempt to refute hypotheses, produce reproducible counterexamples, validate invariant violations | execution validators; compiler-backed ground truth harness (`eval/ground-truth`) | invariant representation (T-152), executable counterexamples under a real compiler and EVM, minimisation |
| 8 | **Durable Discovery Memory** | Preserve explored paths, successful strategies, false positives, confirmed vulnerabilities and missed findings | 5.1 research state | schema for paths/strategies/coverage; learning interface; contamination controls |

## 4. Integration requirements (binding)
1. **One shared representation.** APEX uses the 5.3/5.4 protocol model and 5.1 records; a private parallel model is a defect.
2. **Provenance of origin.** Every hypothesis records which component originated it (`apex/<capability>@version`, a specialist, the Weirdness Engine, a human, a tool) and which components contributed evidence. The store's generator identity is the starting point; any extension (for example an origin chain) is decided in T-151 and needs a reviewed migration.
3. **Independence.** The component that generates a hypothesis cannot be the component that validates it for the purpose of status; APEX's counterexample engine yields evidence, the 5.6 stage assigns the independent outcome. Status continues to come from the database view, and nothing is called confirmed without independent confirmation and, where applicable, a human decision.
4. **Cooperation, not duplication.** Weirdness Engine and specialists are inputs and consumers, not forks.
5. **Safety.** All APEX work is passive reading and local modelling or sandboxed execution of snapshots. No active testing of any live system, no external contact, no spending (including model calls) without separate approval; the approval boundaries in `ROADMAP.md` 2G apply unchanged.

## 5. Novelty and prior-art requirement (before any implementation)
**T-150 first pass done 2026-11-26: `docs/apex-prior-art.md`.** Conservative, provisional verdicts (papers could not be read from this environment): capabilities 1 and 7 existing or integration; 3 integration; 2, 4 and 6 integration, possibly a meaningful extension under stated conditions; 5 a meaningful extension at most; 8 provisionally a meaningful extension. None is rated potentially novel. A second pass with paper access is required before T-151 relies on the verdicts.

T-150 must be a serious, cited review before design is frozen. Starting scope (named from memory; **unverified here, to be confirmed against primary sources**): static analysis frameworks and detectors (for example Slither, Aderyn); symbolic and concolic execution for EVM (Manticore- and Mythril-class tools, hevm, Halmos); property-based and invariant fuzzing (Echidna, Medusa, Foundry invariant testing); formal verification and specification-driven provers (the Certora Prover, SMTChecker); cross-contract and protocol-level analysis; learning-guided and model-assisted search for vulnerabilities; published protocol-level incident and exploit analyses; and the bug-bounty and audit-contest findings literature.
The review must report: what already exists; what can be reused (and on what licence); what is unsolved or insufficiently addressed; where APEX could plausibly hold a measurable advantage; and for **each of the eight capabilities, whether it is novel or a useful combination of existing methods**. **No originality is claimed without evidence.** A capability judged a combination is still valuable if it measurably helps.

## 6. Independent benchmark and the strategic metric
APEX is evaluated against, on the same frozen inputs: (a) existing security tools run individually, (b) the current AgentSmith analyzer, (c) combined conventional tooling, (d) AgentSmith with APEX disabled, (e) AgentSmith with APEX enabled.
**Primary strategic metric: independently confirmed APEX-only discoveries**: genuine vulnerabilities found by APEX that systems (a)-(d) missed, confirmed by a method APEX did not use and by someone other than APEX's authors (for example compiler-backed exploit reproduction plus independent review, or a later public disclosure).
Also measured: false positives, false negatives, reproducibility, time, cost, cross-contract coverage, and generalisation to unseen repositories.
Rules: APEX does not create or grade its own benchmark; corpora are authored independently and frozen with manifests before APEX is run (`eval/heldout*` practice); a corpus is burned for held-out purposes once tuning is informed by its results; ground truth should favour vulnerabilities disclosed after the system's design freeze to limit contamination of any model involved; frozen baselines (`structural-candidate-1`, the baseline prototype) are never overwritten.

## 7. Task series (proposed; reserved IDs; none authorised)
T-150 prior-art and novelty assessment; T-151 architecture and integration design; T-152 shared protocol model and invariant representation; T-153 execution-path and transaction-sequence exploration; T-154 assumption extraction and breaking; T-155 cross-contract and protocol interaction exploration; T-156 novel hypothesis generation; T-157 adaptive exploration and prioritisation; T-158 counterexample generation and independent validation; T-159 integration with the Weirdness Engine and specialist researchers; T-160 durable discovery memory and learning; T-161 controlled prototype; T-162 independent benchmark and comparative evaluation. Details, dependencies and acceptance criteria are in `docs/backlog.md`.

## 8. Timing
Record now; do not start implementation. Dependencies that must mature first: structural analysis and the independent-challenge stack stable on at least one more independent corpus; the research workflow integrated and exercised on a real approved repository; the shared protocol representation (T-152) and the Priority Engine's coverage model (T-052) designed. Start with T-150 and T-151. Other independent roadmap work continues in parallel.
