# AgentSmith autonomous intelligence architecture (2026-11-26)

**Status: design. Nothing in this document is approved for implementation beyond A24 (Control Room CR1/CR2, done).** T-149
(`docs/unified-research-workflow.md`) remains the single workflow authority. This document places every intelligent capability
inside that one workflow: no second lifecycle, protocol model, priority engine or memory.

**Today AgentSmith is not autonomous.**
- No worker runs in production.
- No decision is made by the system about what to research.
- No research outcome has been recorded.
- Nothing has been learned from experience.

The architecture below states how it can come to own those decisions, and what evidence each step needs.

## 1. Principle
AgentSmith owns the research **decisions, orchestration, memory and learning**. Every other capability is a specialist that receives a
bounded task and returns typed output with provenance:
- deterministic analysers;
- toolchains;
- APEX and Weirdness;
- Claude as a reasoning specialist;
- ML models.

No specialist confirms its own output. A capability earns more responsibility only by measured improvement in **independently
confirmed, differentiated discoveries per unit of research time and cost**.

## 2. The loop, mapped to T-149
```
 Discover ─► Prioritise ─► Acquire ─► Understand ─► Hypothesise ─► Investigate ─► Challenge ─► Verify ─► Adjudicate ─► Remember ─► Learn
   (5.0)      (policy)      (5.2)      (5.3 P1–P3)     (5.5)         (specialists)    (5.6)       (exec)     (human)       (memory)    (policy update)
     ▲                                                                                                                                     │
     └──────────────────────────────── decisions, costs and outcomes recorded at every arrow ◄───────────────────────────────────────────┘
```
Each arrow is a T-149 workflow step: a row in `workflow_steps` with lease, attempt, output and error, plus an audit event. The Control
Room reads exactly these records. The new element is the **decision record** written at every choice point (§4), so that learning has
data to learn from.

## 3. Components
### A. Shared perception: the protocol model and its extensions
| Element | Exists | Owner |
|---|---|---|
| Project, repository, commit and snapshot identity | **Yes**: `repo_snapshots` (commit, tree, manifest hash), 5.2 acquisition | 5.2 |
| Components, functions, call edges, inheritance, unknowns | **Yes**: P1 | `protocol-model/3` |
| State-variable roles (ledger, aggregate, authority, implementation pointer, lock) | **Yes**: P2 | `protocol-model/3` |
| Authority, trust boundaries, cross-contract and proxy paths, initialisers | **Yes**: P3 | `protocol-model/3` |
| Assets and value flows | No | P4 (**not approved**) |
| Execution paths and state transitions | No | P5–P7 (designed in `protocol-representation-design.md`) |
| Research coverage: what was examined, by which method, with what result | No | new: coverage records (§3D), needs a migration |

There is one model per snapshot, content-addressed and stored. Every consumer (specialists, validators, dossier, priority, ML
features, Control Room) reads that model; none re-derives it. The P3 closeout removed the last known parallel derivations of guard
side (D1, D2, D5). Two remain and are recorded (D3, D4, T-185).

### B. Research decision and policy engine
One engine, extending the existing priority work in place (T-050/T-051; reserved T-052–T-058). It is **not** a new service. It
decides at six levels:
1. opportunity;
2. repository;
3. changed or unexplored component;
4. contract and function;
5. attack surface and path;
6. follow-up hypothesis.

**Version 0 (deterministic, transparent).** Each candidate gets a score vector, not one number:
- expected value (bounty size where known; asset exposure later, from P4);
- cost (estimated analysis time and model spend);
- novelty (not previously examined, from coverage records);
- duplicate risk (known audits, public reports);
- change (new commit, new integration);
- class gap (classes the engine is weak on, from evaluation records);
- history (past outcomes on similar components).

A fixed, documented rule combines them. Each component is shown with its evidence. **No invented probabilities.** Where a term has no
data, it is "unknown", not zero. A fixed share of decisions (for example 1 in 5) goes to exploration (an unexplored candidate chosen by
a recorded rule), so that history does not only confirm itself.

**Every decision is recorded**, including meaningful non-actions such as "skipped: duplicate risk". Each record holds:
- inputs (feature values and their sources);
- the rule version;
- the chosen action;
- the alternatives ranked;
- the cost incurred;
- later, the outcome.

These records are the training data for ML-1, and the "why this target" text on the Control Room.

### C. Specialists: one contract for every capability
| Specialist | Responsibility | Input | Output | Provenance | How it is evaluated |
|---|---|---|---|---|---|
| Structural analyzer (exists) | Pattern- and model-based leads in 7 classes | sealed snapshot + protocol model | hypotheses with cited spans | analyzer version, model hash | frozen corpora, corpus 5 |
| Execution validators (exist; single-contract) | Exploit or refute a lead by interpretation | hypothesis + model | validated / refuted / inconclusive + trace | validator version | adjudicated EVM ground truth (`eval/adjudications/`) |
| Independent challenger (exists, 5.6) | Find reasons a lead is wrong | hypothesis + evidence | evaluation with outcome and rationale | evaluator id/version | agreement with adjudication |
| Security toolchain (designed) | External static/dynamic tools (e.g. Slither, fuzzers) on the snapshot, offline | snapshot | normalised leads, tool version, command | tool + version + input hash | same corpora; overlap and unique-confirmed counts |
| APEX (designed, T-150–T-162) | Transaction-sequence exploration against a local fork or offline EVM | model + target paths | candidate sequences, traces | engine version, seed | confirmed-by-execution rate; time per confirmed lead |
| Weirdness Engine (designed) | Unusual structure relative to a corpus of protocols | model + feature store | ranked anomalies (investigation candidates only) | model version, reference set | whether anomalies lead to confirmed outcomes |
| Claude reasoning specialist (designed; §5 and `claude-runtime-options.md`) | Business logic, ambiguous behaviour, hard paths, high-value challenges | bounded task + model excerpt + evidence | structured hypothesis or challenge with cited spans; concise rationale (no chain of thought stored) | model id, prompt version, budget reservation | blind comparison on corpus 5 slices; cost per confirmed lead |
| Specialist researchers (human) | Review, adjudication | dossier | signed review | reviewer identity | n/a (ground truth) |

**Rules that apply to every specialist:**
- Output is a lead, evaluation or trace. Only a human adjudication (T-149 S2, **unapproved**) produces a confirmed finding.
- Every output cites code spans that are re-verified on read; uncited output is discarded.
- Every specialist runs under the workflow's lease and budget reservation. None spawns work outside the queue.

### D. Durable experience memory
One store, keyed by snapshot and model element (function id, variable, path). It holds:
- outcomes: confirmed, refuted, inconclusive, false positive, duplicate, missed (from evaluations and post-mortems);
- coverage: element × method × date × result, including "examined, nothing found";
- decisions (§3B), with what was investigated and why;
- methods: which specialist and parameters produced which outcome;
- evidence and adjudication links.

**Label rule.** Only an outcome adjudicated independently (a human reviewer who is not the producing specialist, or reproducible
execution evidence plus human sign-off) becomes a **positive confirmed-discovery label**. Refutations and false positives become
negative labels only when their basis is recorded. Corpus labels are kept separate as synthetic ground truth and never mixed with real
outcomes.

The existing tables cover hypotheses, evaluations, reviews, events and the empty 0001 `knowledge_*`. Coverage, decision and outcome
records need a migration (T-149 S2/S4 and T-144 lineage; **all unapproved**).

## 4. How autonomy grows (each stage needs measured evidence, not more infrastructure)
| Level | AgentSmith decides | Precondition |
|---|---|---|
| 0 (today) | nothing; an operator submits a repository | none |
| 1 | the order of queued work, by deterministic policy v0, with a recorded rationale | decision records; worker active (A26) |
| 2 | which components and paths to investigate inside a repository, and which specialist to apply | coverage records; per-specialist evaluation on corpus 5 |
| 3 | which opportunities to take, within budget | discovery live (0008 applied, polling approved); duplicate-risk data |
| 4 | policy updated from its own outcomes (ML-1 in shadow, then guarded promotion) | enough adjudicated outcomes (§ ML readiness); shadow results better than v0 on unseen data |
| 5 | strategy selection (ML-3) | level 4 sustained; strategy outcome data |

## 5. Claude's place
Claude is called by the policy engine for a **bounded, budgeted task**, never as the loop's controller:
- interpret an unfamiliar protocol's business logic;
- reason about a path the structural model leaves unresolved;
- write a challenge for a high-value lead.

Deterministic capabilities handle routine work (parsing, modelling, pattern specialists, validation). Runtime options, costs and the
budget enforcement already in the code are in `docs/claude-runtime-options.md`.

## 6. Control Room as the operating interface
Today (A24) it shows:
- engine state and reasons;
- workers;
- queue and lanes;
- research stages;
- build and schema;
- discovery;
- P1–P3 architecture.

Each later capability adds a panel that reads its own records:
- decisions ("why this target");
- priorities;
- ML predictions and their shadow status;
- Claude assignments with cost;
- APEX runs;
- active hypotheses with supporting and contradicting evidence;
- memory;
- learning;
- cost per confirmed discovery.

Reasoning is shown as stored **inputs, evidence, decision and concise rationale**. Model chain of thought is neither requested nor
stored.
