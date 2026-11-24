# Model Routing and Cost-Control Policy

## Initial budget: US$25 per calendar month

The first operating budget is a hard ceiling of **US$25/month** for AI API usage, measured in USD. It is a ceiling, not a spending target. The platform must pause new model calls when any applicable limit is reached. Unused budget does not roll over.

### Hard limits

| Scope | Hard limit | Behaviour at limit |
|---|---:|---|
| Global calendar month | **$25.00** | Stop all new model calls |
| Global calendar day | **$1.00** | Pause model calls until next UTC day |
| One workflow run | **$0.50** | Stop model calls for that run |
| One Tier 1 call | **$0.01** | Reject or choose a cheaper route |
| One Tier 2 call | **$0.05** | Reject or choose a cheaper route |
| One Tier 3 call | **$0.10** | Reject; no automatic premium escalation |
| Tier 1 monthly allocation | **$5.00** | Stop Tier 1 calls for the month |
| Tier 2 monthly allocation | **$15.00** | Stop Tier 2 calls for the month |
| Tier 3 monthly allocation | **$5.00** | Stop Tier 3 calls for the month |

Tier allocations sum to the global $25 cap. They are sub-limits, not additional spend. The daily cap is deliberately conservative during the pilot; the monthly cap remains the ultimate ceiling. A zero-dollar reserve is intentional: the platform does not promise spend capacity that has not been budgeted.

All caps are checked against a conservative worst-case cost estimate **before** a provider request. If price metadata is missing, stale or ambiguous, the call is rejected. After the call, actual provider usage is recorded. If a provider's final bill exceeds the estimate, the overage is counted against remaining global budget and new calls are paused if any cap has been crossed. Never rely on provider-side soft alerts as the enforcement mechanism.

## Routing tiers

- **Tier 0 — deterministic code (no model):** parsing, validation, deduplication, scheduling, retries, database queries, state transitions, URL checks, repository tree filtering, budget arithmetic, policy enforcement, evidence hashing and workflow bookkeeping.
- **Tier 1 — economical model:** classification, extraction, tagging, concise summaries, routine triage and structured transformations. Per-call cap $0.01.
- **Tier 2 — capable general model:** investigation planning, targeted code review, technical explanation, report drafting and multi-step reasoning. Per-call cap $0.05.
- **Tier 3 — premium reasoning:** hard vulnerability analysis, conflicting evidence, difficult exploitability questions and final independent challenge. Per-call cap $0.10; reserve this for cases where the expected value of deeper reasoning is clear.

A task starts at the cheapest tier that meets its quality requirement. Tier escalation must include a recorded reason and must pass all applicable caps. No automatic retry may escalate tiers. A Tier 3 review is not run on every finding by default; it is reserved for high-impact or genuinely ambiguous cases.

## Workload allocation

Initial planning allocation of the $25 monthly budget:
- $5 Tier 1: high-volume intake classification and extraction.
- $15 Tier 2: targeted investigations, code review and report drafting.
- $5 Tier 3: selected difficult cases and independent challenges.

This is a budget envelope, not a promise to spend each allocation. If Tier 1 or Tier 3 is exhausted, that work pauses; unused allocation is not automatically transferred. Any reallocation requires an explicit policy change.

## Mandatory gateway and enforcement

Every model call must pass through one central gateway. No worker, route or specialist agent may call a provider directly. The gateway must:
1. identify workflow, step, task purpose, provider/model and routing tier;
2. obtain current provider pricing and estimate worst-case cost from bounded input/output token limits;
3. atomically reserve budget against global monthly, global daily, workflow, per-call and tier-monthly caps;
4. reject calls if pricing is unknown or any cap would be crossed;
5. apply hard input/output token limits and bounded retry counts;
6. record provider, model, prompt version, token counts, estimated and actual USD cost, latency and outcome;
7. reconcile reservations against actual usage and release unused reservation;
8. fail closed if the budget store is unavailable or concurrent reservations cannot be made safely.

Reservations must be atomic in Postgres so parallel workers cannot each observe the same remaining balance and overspend it. The monthly and daily counters use UTC calendar boundaries. The workflow cap is cumulative across all calls in that run. Provider retries count as separate billable calls and must pass the gateway again.

When a budget is exhausted, the system pauses new model work, preserves queued jobs and records a clear reason. Tier 0 deterministic work may continue. The system must never silently continue spending. Raising a cap or approving an exception requires an explicit operator action and an audit event; the initial configuration has no automatic overage.

## Context and loop discipline

- Retrieve only relevant memory and evidence for each task.
- Summarise long histories into versioned, source-linked notes.
- Cache stable reference material where supported.
- Prefer targeted files, diffs and symbol slices over full repository dumps.
- Set task-specific input and output token ceilings.
- Do not repeatedly rediscover facts already stored in structured records.
- Bound agent iterations, tool calls, repository files and retries.
- A workflow must stop and surface a reason when its evidence or cost allowance is exhausted.

## Quality controls

Cheap models are not trusted merely because they are cheap. Each task class needs an acceptance test set and escalation threshold. The independent judge should receive the claim, relevant evidence and criteria—not the investigator's unsupported conclusion. Premium review is reserved for high-impact decisions and disagreements, not routine actions.

## Provider independence

Provider and model selection remain configuration, not workflow business logic. Store provider, model, prompt version, token counts, latency and cost with every call. Price tables must be versioned and refreshed before they are used to estimate a call. Provider outages, price changes or model retirement must not require rewriting workflow logic.

## Current implementation status

The initial limits and deterministic routing map are defined in `apps/api/src/ai-budget.ts`, covered by unit tests, and seeded as database policy rows by migration `0002_initial_ai_budget.sql`. **This is policy configuration and preflight logic, not yet a live provider gateway.** The platform must not enable autonomous model calls until atomic Postgres reservations, provider adapters, actual-usage reconciliation, and the global emergency stop are implemented and tested. Until then, the hard budget is specified but not yet operationally enforced.
