# Claude runtime options and cost (2026-11-26)

**Status: assessment. No paid runtime is approved or active.** Prices are Anthropic first-party list prices from the Claude API
reference (model table cached 2026-11-03). Re-check them on the pricing page before any activation. Rules on subscriptions and the
Agent SDK are quoted from the current Claude Code documentation (`code.claude.com/docs/en/agent-sdk/overview`, `.../costs`), read
2026-11-26.

## 1. Options
| Option | What it is | Authentication for unattended use | Billing | Fit for AgentSmith |
|---|---|---|---|---|
| **Claude API (Messages), called by the AgentSmith worker** | One bounded request per task; AgentSmith owns the loop, tools and retries | API key (or workload identity federation) | per token; Batch API at 50%; prompt-cache reads about 0.05× input | **Recommended first runtime**: every call passes through the existing budget gateway; nothing runs that AgentSmith did not schedule |
| Claude API + Tool Runner | SDK-driven tool loop over tools AgentSmith defines | API key | per token | Later, for multi-step specialist tasks; needs loop and turn caps |
| Claude Agent SDK | Claude Code's harness as a library (built-in file/bash tools, subagents, hooks) on our own infra | API key. The docs: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…"* | per token | Possible for a sandboxed investigation specialist; strong containment needed (it runs commands) |
| Managed Agents | Anthropic hosts the loop and a per-session sandbox | API key | per token **plus session runtime**; history kept until deleted | Not first: adds runtime cost and stores research context off-platform |
| Claude Code (interactive, subscription) | What builds AgentSmith today, with a human present | claude.ai login | subscription plan allowance (rolling 5-hour and weekly windows) | **Development only**, operator in the loop. Not production authentication (the owner's rule and the SDK terms above) |

## 2. Prices that matter (USD per million tokens, input / output)
| Model | Input | Output | Cache read | Notes |
|---|---|---|---|---|
| Claude Opus 5.5 | 4.00 | 20.00 | 0.20 | thinking cannot be disabled; default effort `medium` |
| Claude Sonnet 5.5 | 2.00 | 10.00 | 0.10 | |
| Claude Haiku 5.5 | 0.10 | 0.50 | — | $0.50 / $2.50 beyond 100k-token prompts |

Thinking tokens are billed as output tokens. The Claude Code docs report agent teams using about 7× the tokens of a single session
in plan mode. Subagents each send their own requests, so **parallel agents are not cheaper**: each carries its own context.

## 3. What US$25 per month buys (worked examples; assumptions stated)
| Task shape | Model | Cost per task | Tasks per US$25 |
|---|---|---|---|
| 60k input / 8k output (one function cluster with model excerpt, written challenge) | Opus 5.5 | $0.24 + $0.16 = **$0.40** | ~62 |
| same | Sonnet 5.5 | $0.12 + $0.08 = **$0.20** | ~125 |
| 25k input / 5k output (focused question) | Sonnet 5.5 | $0.05 + $0.05 = **$0.10** | ~250 |
| 20k input / 1k output (triage or classification) | Haiku 5.5 | $0.002 + $0.0005 = **$0.0025** | ~10,000 |

With prompt caching of a stable prefix (instructions plus protocol-model excerpt) across several tasks on one snapshot, input cost
falls substantially. The Batch API halves cost for non-urgent challenges.

## 4. Budget enforcement that already exists (tested, never activated)
`apps/api/src/ai-budget.ts` and `ai-budget-gateway.ts`, with migrations 0002–0004 (applied in production as tables only):
- `INITIAL_AI_BUDGET`: **US$25/month, US$1/day, US$0.50 per workflow**, per-call caps by tier (US$0.01 / 0.05 / 0.10), monthly tier
  caps;
- reservation before the call at worst-case cost, settlement at actual cost;
- reviewed price catalogue;
- `AI_BUDGET_EMERGENCY_STOP`.

**Consequences to decide before activation:**
- The US$0.10 tier-3 per-call cap blocks the Opus example above ($0.40). Either tasks are cut to ≤ US$0.10 (Sonnet 5.5, about 25k in /
  5k out), or the owner revisits the caps. The cap is not silently raised.
- US$1/day caps throughput at roughly 10 focused Sonnet tasks per day.
- Required before any paid runtime:
  - no automatic top-ups (the API account is prepaid with auto-reload off);
  - `max_retries` bounded and counted against the reservation;
  - an explicit turn cap and `task_budget` on any loop;
  - no subagent spawning outside the queue;
  - cost recorded per task, per investigation and per confirmed discovery (the decision records, architecture §3B).

## 5. Recommendation
1. First runtime: **Claude API, Sonnet 5.5, single bounded requests from the worker, through the budget gateway**, for two tasks only:
   - business-logic interpretation of a component the structural model leaves unresolved;
   - a written independent challenge for high-value leads.
2. Measure on corpus 5 slices, blind, against the same tasks without Claude: confirmed leads per dollar.
3. Opus 5.5 only for tasks where that measurement shows a gain, and only within approved caps.
4. No Agent SDK, Managed Agents or subagent fan-out until single-call value is shown.

Activation needs its own approval (A31) and an API key held as a secret on the worker only, never in the repository or the browser.
