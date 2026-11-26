# Adaptive Research Priority Engine: design (T-050, started 2026-11-26)

Status: **design draft for owner review. Documentation only: no code, no migration, nothing activated.** It expands, and does not duplicate, the 5.0 placeholder scorer (`discovery/priority.ts`) and the earlier outline in `ROADMAP.md` 2D. It is a **core cross-phase capability** to be built early and evolved throughout, not left until the end of the roadmap.

## 1. Objective
Continuously decide where AgentSmith should spend its limited research capacity to maximise the **expected value of independently confirmed security discoveries per unit of cost**, while deliberately keeping capacity for exploration. It decides *where to research*; it does not decide whether a finding is true.

## 2. Six levels of prioritisation
| Level | Unit ranked | Typical decision |
|---|---|---|
| 1 | Bounty programs / opportunities | which program to look at next |
| 2 | Projects and repositories | which repository within it |
| 3 | Commits and changed components | which changes since the last examined version |
| 4 | Contracts and functions | which components inside a repository |
| 5 | Attack surfaces and unexplored execution paths | which paths APEX and specialists explore (feeds APEX capability 6) |
| 6 | Hypotheses and follow-up investigations | which lead to challenge or deepen |
Each level produces a ranked list with a recorded explanation per item; higher levels set budgets that lower levels spend.

## 3. Signals (what the engine reads)
### 3.1 Freshness and discovery (signal, never a guarantee)
New programs, projects and repositories; expanded scope; newly added assets or contracts; recent upgrades; new integrations and dependencies; material repository changes. Each contributes a bounded, decaying amount; freshness alone cannot make an item top priority.
### 3.2 Coverage and audit saturation (durable, version-aware)
A **research coverage record** keyed by `(repository, commit or tree hash, component identity and content hash, vulnerability class, method)` stores: what was mapped, which surfaces and classes were examined, hypotheses generated, challenged, refuted or confirmed, false positives, and what remains unexplored or only partly investigated. Prior third-party audit coverage is recorded **only with evidence** (report, scope, commit) and discounted by reliability.
Rules: coverage attaches to *versions of components*, so unchanged, repeatedly investigated, saturated components lose priority while **changed or new code is never treated as already audited**; saturation is judged per component and class, **never penalising a whole project because some contracts were heavily audited**.
### 3.3 Reassessment and priority recovery
Priority is event-driven and never frozen low. Recovery triggers: new commits; upgraded contracts; new integrations; previously unreachable components becoming available; relevant new vulnerability intelligence; new evidence changing an earlier hypothesis; changes to trust boundaries or protocol behaviour. A trigger re-opens exactly the affected components (by content hash), not the whole project.
### 3.4 Economic and efficiency factors
Reward and eligibility; potential impact; scope and asset importance; deadlines and time sensitivity; research time and compute cost; historical discovery performance per domain/class; existing coverage; novelty and unexplored surface; reliability of the source and repository. Estimated cost uses measured past runs, not guesses, once available.
### 3.5 Exploration versus exploitation
A reserved share of capacity is **exploration**: new projects, unexplored components, unusual architectures, low-coverage areas, novel vulnerability classes, uncertain-but-possibly-valuable targets. The share is a policy parameter (proposed starting value 20 percent of capacity per planning period, **an owner decision**), allocated by a logged, seeded selection among low-coverage candidates so it is reproducible and auditable. The engine must not keep choosing only familiar high scorers.

## 4. Scoring v1: transparent and deterministic (T-051)
- **Form:** a bounded, additive score per item built from named features; each feature stores `(name, raw value, weight, contribution, reason, evidence pointer)`. The sum, every contribution and the policy version are stored with the item; the same inputs always give the same score.
- **Features per level** follow section 3; weights live in a versioned, human-reviewed policy file, not in code; weight changes are recorded decisions.
- **Uncertainty flags** (missing reward, unverified scope, unverified audit claim, stale data) are explicit and lower rank through stated rules, never hidden.
- **No invented probabilities.** v1 outputs scores and ranks with reasons. Words such as "probability" or "expected value in dollars" are not used until calibrated estimates exist (section 6).
- **Guardrails:** score components for exploration and for coverage gaps are separate so the Control Room can show why an item was chosen (exploit versus explore).
- **Fixtures first:** v1 is built and tested on synthetic opportunities and repository histories before real data is connected; real discovery and acquisition feeds are attached as they become operational.

## 5. Research coverage and the history it needs
Required durable records (to be designed with the unified opportunity model, T-040/T-041, no migration here): coverage records (3.2), priority assessments (explained scores), exploration allocations, outcomes (each with a **confirmation level**: unverified, tool-corroborated, reproduced by execution, independently reviewed, externally confirmed), and effort/cost per run. Version awareness uses the structural index's component hashes so an unchanged function keeps its history across commits.

## 6. Learning, calibration and what may be learned from
- Learn from **independently confirmed** outcomes, from missed findings, from false positives, from failed investigations and from human adjudication. **Never** treat unverified or self-generated findings as confirmed ground truth.
- Keep separate and stored: predicted discovery value, actual outcomes, research effort and cost, confidence/calibration, and priority over time.
- v1 is hand-set weights. Adaptive weight updates come later (T-056), only above a minimum count of independently confirmed outcomes (threshold set by the owner on the evidence), with held-out replay to check that learning improves ranking; calibrated probabilities are introduced only after reliability checks (calibration curves) on data the learner did not see. Until then the engine reports ranks and reasons only.

## 7. Evaluation (T-057)
Offline replay on historical opportunity and outcome data (including frozen fixtures) against simple baselines: random, newest-first, highest-reward-first, round-robin. Metrics: independently confirmed findings per unit cost, time to first confirmed finding, coverage of changed code, fairness to low-coverage targets (exploration yield), and regret versus an oracle where outcomes are known. The engine must beat the simple baselines on held-out replays before it is allowed to steer real capacity; its own logs are not its benchmark.

## 8. Integration
Inputs: discovery events and the unified opportunity model (5.0), acquisition commit events (5.2), the structural index and component hashes (5.4), research-state coverage (5.1), cost ledger (budget gateway), outcomes and reviews (5.6/5.8). Outputs: ranked work queues for orchestration, search budgets for APEX (T-157), explanations for the Control Room (T-058), recommendations to the operator. It never starts work that needs an approval by itself; approvals remain human.

## 9. Sequencing
Start T-050 now (this document). Build T-051 early alongside the unified opportunity model, on fixtures. T-052/T-053 follow the coverage model and commit events; T-054/T-055 add economics and exploration; T-056/T-057 need real outcomes and the 5.8 corpora; T-058 connects live systems. Dependencies and acceptance criteria are in `docs/backlog.md`.

## 10. Adopted policies (owner decisions, 2026-11-26)
1. **Exploration allocation:** 20 percent of research capacity is reserved for exploration and 80 percent for exploitation of the strongest current opportunities. The ratio is a configurable policy value (`apps/api/src/priority/policy.ts`, `explorationShare`), changed only through a recorded decision citing evidence of whether exploration produced useful discoveries.
2. **Outcome categories (ground truth):** five distinct categories are kept: **confirmed** (independently validated **and** human-adjudicated), **refuted** (evidence shows the hypothesis is wrong), **inconclusive** (insufficient evidence), **duplicate** (already known or previously reported), **missed finding** (independently discovered after the original investigation). **Only confirmed outcomes are successful discovery labels.** Refuted, inconclusive, duplicate and missed outcomes are kept as evidence and are never collapsed into confirmed. Implemented as a tested code-level policy (`apps/api/src/priority/outcomes.ts`); storage is proposed in `docs/research-memory-gaps.md` (T-144).
3. **Adaptive weights and probability calibration:** scoring stays transparent and deterministic. No adaptive weights and no probability estimates until sufficient, diverse, independently adjudicated evidence exists. T-056 must **preregister**, before looking at outcome data: the evidence threshold and its justification (no convenient number without a reason), the calibration method, the held-out evaluation design, and the comparison against the frozen deterministic policy (`priority-policy/1`). Learning that does not beat the frozen policy on held-out data is not adopted.
4. **Third-party audit data:** permitted where provenance and permitted use are established; otherwise ignored and flagged. The engine distinguishes claimed audit coverage, vulnerability classes examined, specific verified findings and AgentSmith's own commit-specific research. **An audit report is never proof that a repository or project is saturated.** Coverage is tracked at commit, component, contract, function and vulnerability-class level; in v1 an audit counts fully only for the exact commit it names, and only together with components AgentSmith has researched at their current version.

## 11. T-051 status
Implemented on fixtures only (`apps/api/src/priority/`): deterministic additive scoring with a named, reasoned contribution per feature, policy version and input hash; flags instead of guesses for unknowns; version-aware coverage and audit handling as in section 10; seeded, reproducible 20/80 allocation. Tested by property tests over synthetic opportunities (`priority.test.ts`). **Not connected to real discovery or acquisition data, not used to steer anything, no learning.**

## 12. Open owner decisions
1. The exploration share, outcome categories, calibration gating and audit-data policy are decided (section 10).
2. Still open: the preregistered evidence threshold for T-056 (to be proposed with its justification when outcome data exists), and which audit sources to ingest first.
