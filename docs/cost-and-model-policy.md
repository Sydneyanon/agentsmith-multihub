# Model Routing and Cost-Control Policy

## Objective

Keep the platform useful without requiring repeated manual top-ups or allowing runaway agent loops. Provider and model choice must remain replaceable configuration, not business logic.

## Routing tiers

- **Tier 0 — deterministic code:** parsing, validation, deduplication, scheduling, retries, database queries, state transitions, budget arithmetic and policy enforcement. No model call.
- **Tier 1 — economical model:** classification, extraction, tagging, concise summaries, routine triage and structured transformations.
- **Tier 2 — capable general model:** investigation planning, code review, technical explanation, report drafting and multi-step reasoning.
- **Tier 3 — premium reasoning:** hard vulnerability analysis, conflicting evidence, difficult exploitability questions and final independent challenge.

A task starts at the cheapest tier that meets its quality requirement. Escalation requires a reason and records the reason in the usage ledger.

## Hard budget controls

Every model call must pass through one central gateway. The gateway:
1. identifies the workflow, step, task purpose and provider/model;
2. estimates worst-case cost before sending;
3. checks per-call, per-run, daily and monthly limits;
4. applies token and output caps;
5. records provider usage and estimated USD cost;
6. rejects calls that exceed limits.

No worker may call a provider directly.

When a budget is exhausted, the system pauses new model work, preserves queued jobs and records a clear reason. It must never silently continue spending. A user can explicitly raise a limit or approve a one-off exception.

## Context discipline

- Retrieve only the relevant memory and evidence for each task.
- Summarize long histories into versioned, source-linked notes.
- Cache stable system instructions and repeated reference material where supported.
- Avoid sending full repository contents when a targeted file or diff is sufficient.
- Set explicit maximum input and output tokens for each task class.
- Do not repeatedly ask a model to rediscover facts already stored in structured records.

## Quality controls

Cheap models are not trusted merely because they are cheap. Each task class has an acceptance test set and escalation threshold. Premium review is reserved for high-impact decisions and disagreements, not every routine action.

## Provider independence

The gateway supports multiple providers behind one internal interface. Provider outages, price changes or model retirement must not require rewriting workflow logic. Store provider, model, prompt version, token counts, latency and cost with every call.

## Initial operating defaults

Start with conservative caps and adjust only after observing real usage:
- Per model call: hard token cap and cost ceiling.
- Per workflow: fixed spend ceiling.
- Daily platform budget: explicit operator-set value.
- Monthly platform budget: explicit operator-set value.
- Global emergency stop: disable all new model calls immediately.

The platform must display spend to date, forecast, budget remaining, and top workflows by cost.
