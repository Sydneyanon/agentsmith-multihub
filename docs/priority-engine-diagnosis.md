# T-057 diagnosis: why engine v1 does not beat round-robin on findings per cost (2026-11-26)

**Scope.** This diagnoses the synthetic replay (`apps/api/src/priority/replay.test.ts`, scenario `synthetic-v1`: 20 days, 1 slot/day).
Policy v1 is **not changed**; golden tests keep it frozen. Every number below comes from that scenario and is a diagnostic of the
harness and the policy, **not evidence about real discovery**.

**Observed.**

| Strategy | Findings | Cost | Findings per cost unit |
|---|---|---|---|
| engine-v1 | 5 of 5 | 575 | 0.0087 |
| round-robin | 5 of 5 | 510 | 0.0098 |
| oracle | 5 of 5 | 485 | 0.0103 |

## Causes, measured, in order of effect

| # | Cause | Category | Measurement | Effect |
|---|---|---|---|---|
| 1 | The harness forces a pick in every slot, and the scenario holds far less new work than capacity: 5 finding-bearing component versions for 20 picks. | **Synthetic scenario construction** and harness design | 16 of 20 picks find nothing **for every strategy, including the oracle**. Engine-v1 spends 490 of its 575 cost units on them; round-robin 425. | Findings per cost then measures how cheaply a strategy wastes capacity, not how well it finds things. The metric cannot discriminate here. |
| 2 | Fully researched opportunities keep a high score. The score describes the opportunity (reward, deadline, freshness); it has no term for the **marginal value of researching it again** when nothing has changed. | **Opportunity-value estimation** | Day 6: `contest`, researched at its current versions, scores 40.16 (reward 20.83, deadline 9.33, freshness 8.62, saturation −10). Engine-v1 re-picks it on days 4–10 and re-picks `old-big` on days 16–19. | Repeated research of unchanged code; the engine's extra cost against round-robin comes from this. |
| 3 | Our own complete research saturates an opportunity only **halfway**. The 0.5 factor meant to discount research without a commit-specific audit also applies to AgentSmith's own current-version research. | **Coverage saturation** | Saturation −10 of a possible −20 for a fully researched item with no audit. | Covered work is not pushed down enough. |
| 4 | Exploration never runs at small slot counts. The allocation rounds `slots × 0.2` per call, and `round(0.2) = 0`. | **Exploration allocation** | 0 exploration picks of 20; at 5 slots, 1 per call. | The 20/80 policy is not exercised, and exploration yield reads 0 for structural reasons. |
| 5 | Cost barely affects rank. The log-scaled penalty, `10 × log10(1+c)/5`, separates 20 from 10 units by about 0.6 points. | **Research-cost estimation** (weighting) | `contest` cost −2.64 vs `old-small` −2.08. | Cheaper equivalent work is not preferred. This matters only once causes 1–2 are fixed. |
| 6 | Freshness behaves as designed: `new-late` is taken the day it appears. | Freshness | Picked on day 15 by engine-v1, round-robin and the oracle. | **Not a cause.** |

**Conclusion.** The comparison failed first because of the scenario and harness (cause 1). Behind that sit two real design gaps in
policy v1: no marginal-value term (cause 2), and over-discounted own coverage (cause 3). There is also an allocation defect that makes
the agreed 20/80 policy inert at one slot (cause 4). None of this justifies editing v1. Any change becomes **policy v2**, a separate
version evaluated against frozen v1 under the experiment below.

## Revised experiment (proposal; preregister before running)

1. **Action model.**
   - Each period has a **cost budget**, not a fixed pick count, and a strategy may **decline** to spend.
   - Idle budget is reported. Re-researching an unchanged component version is allowed, but reported as **redundant cost**.
2. **Scenario families, not one scenario.**
   - A seeded generator with every parameter written down: number of opportunities, publication rate, deadlines, reward distribution,
     cost distribution, commit/change rate per component, and finding density per new component version.
   - Each family states its key assumption explicitly, for example "finding density independent of reward" versus "correlated
     (ρ = 0.3)". Results are reported **per assumption** as a sensitivity table, never as one number.
   - **Held-out seeds:** policies are designed on development seeds and compared once on a sealed set of seeds.
3. **Baselines.**
   - The four current ones: random, newest-first, highest-reward-first, round-robin.
   - Plus **least-recently-researched**, **cheapest-first** and **changed-code-first** (research any component version not yet
     researched, oldest change first). The last is the strong simple baseline any engine must beat.
   - The oracle stays as the upper reference.
4. **Metrics** (distributions over seeds, with confidence intervals):
   - findings per cost on budget actually spent;
   - redundant cost share;
   - time to first finding;
   - **change-to-research latency** (days from a code change to its research);
   - exploration yield (with exploration actually exercised);
   - regret against the oracle;
   - idle budget.
5. **Policies compared.**
   - Frozen **v1** (unchanged).
   - Candidate **v2** with four changes, each ablated separately:
     - a marginal-value gate: zero unexplored current-version components and no recent change → the opportunity is ineligible
       unless picked for exploration;
     - own current-version research saturating fully;
     - exploration as a **running quota** (carry the fractional 0.2 per slot across periods);
     - cost weight calibrated so equal-value work prefers the cheaper option.
6. **Decision rule** (preregistered): v2 replaces v1 for *offline recommendation* only if it beats changed-code-first and v1 on
   findings per cost and change latency across the assumption families on held-out seeds. Live prioritisation stays off either way.
7. **Honesty constraints.**
   - Synthetic results are labelled synthetic everywhere.
   - Real comparison waits for replayed histories with independently confirmed outcomes (T-144 records, T-056).

## What was done now
- Diagnosis only; no policy changed.
- The causes are pinned by tests (`replay.test.ts`, "diagnosis" block), so a future v2 cannot silently claim a win this harness could
  not measure.
