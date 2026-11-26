# AgentSmith MultiHub: canonical roadmap

**This is the permanent source of truth for what AgentSmith is meant to become, what is permanently decided, and what is actually true today.**
Individual task prompts, PR descriptions and summaries must not contradict it. If a task needs a change to the architecture or a phase, change this document
first (through review), not the task. History and the original audit stay in `research-intelligence-plan.md`; the task list is `docs/backlog.md`.

Last verified against the repository: 2026-11-26, branch `claude/phase-5-2-audit-and-5-0-discovery` (stack PRs #11-#20 draft and unmerged; `main` at `b50ff6f`).
Everything in section 3 was re-checked against code, migrations and docs on that date, not copied from earlier summaries. Nothing here approves implementation,
deployment, spending or testing; approvals are recorded only in the decision log (`research-intelligence-plan.md` section 10).

## 0. Destination
AgentSmith must discover opportunities independently, monitor changing bounty information, prioritise research, acquire verified repositories, map architecture,
run security tools, generate unusual hypotheses, challenge findings, produce evidence-backed dossiers, and learn from outcomes. A single GitHub organisation
monitor is a foundation, **not** completion of autonomous discovery.

Operating loop: find opportunities (many sources, plus URLs the operator pastes) -> monitor them for change -> rank by research value -> acquire the verified repository at an exact commit
-> map architecture and attack surface -> run tools and specialist investigations -> surface unusual structure (Weirdness Engine) -> challenge findings independently -> dossier
-> learn from successes, failures and misses.

## 1. Numbering (reconciliation, so nothing is lost)
The 2026-11-25 plan numbered Discover as 5.3 and the Control Room as 5.9. On 2026-11-26 the owner fixed the list below. The mapping:

| Canonical (this document) | Name | Earlier numbering / note |
|---|---|---|
| 5.0 | Bounty discovery (multi-source) and URL intake | New; absorbs the old "5.3 Discover" requirements (candidate discovery, X-link intake) |
| 5.1 | Research-state foundation | unchanged |
| 5.2 | Repository acquisition and sealed snapshots | unchanged |
| 5.3 | Intelligence mapping and attack-surface analysis | Was "5.5 attack-surface map v2" plus the mapping half of "5.4"; the old label "5.3 Discover" no longer exists |
| 5.4 | Structural smart-contract analysis | Was "5.4 Understand (Solidity first)" |
| 5.4B | Automated security toolchain | unchanged |
| 5.5 | Specialist research intelligence | Was "5.5 Specialists" |
| 5.5A | Weirdness Engine | unchanged |
| 5.6 | Independent challenge and review | Was "5.6 Challenge v2 + review model" |
| 5.7 | Research dossiers and reporting | Was "5.7 Dossier" |
| 5.8 | Frozen benchmarks and measurable learning | Was "5.8 Frozen baseline + eval"; now also holds the blind rediscovery benchmark |
| cross-phase | Adaptive Research Priority Engine | unchanged |
| operational interface | Live Engine Control Room | Was "5.9" |

No phase is removed. "Task 5.3 is not authorised" in the decision log referred to the old Discover scope; the canonical 5.3 (intelligence mapping) is also not authorised and not started.

## 2. Permanent decisions
Recorded 2026-11-26 at the owner's direction. Each is a requirement on future work; none authorises implementation, spending, deployment or testing.

### A. Multi-source bounty discovery
Initial permanent sources, in priority order: **(1) Immunefi (highest priority), (2) Code4rena, (3) Sherlock, (4) official GitHub organisations and repositories.**
To investigate for later integration: Cantina, HackenProof, official project bounty pages, other legitimate bounty and security-contest platforms.
Every source gets its **own adapter** with: source verification, provenance, rate limits, health status, failure handling and deduplication.
Official access methods and terms are verified **before** implementation (the 2026-11-26 findings are in `discovery-sources-official-research.md`: Immunefi's terms forbid automated access to the site and its JSON list is undocumented, so permission is needed first).

### B. General URL intake
The operator can paste any relevant public URL: X posts, GitHub links, Immunefi pages, Code4rena and Sherlock contests, project announcements, security disclosures, others.
AgentSmith extracts, verifies, normalises, deduplicates and prioritises. **X is a manually supplied channel**, not a paid crawler and not a mandatory API integration.
If content cannot be accessed, the system asks for pasted text or alternative official links. **It never fabricates retrieved content.** Today only classification exists (`source-resolver.ts`, `POST /v1/intake`); nothing is fetched or extracted.

### C. One unified opportunity model
All sources and pasted URLs feed one opportunity and research system. It preserves: source provenance, official program links, repository identity, exact commit SHA, scope, reward, deadlines, eligibility,
testing restrictions, source snapshots, change history and links to research records. The same project appearing through several sources must resolve to **one** project/research identity, not parallel pipelines.
Today `bounty_opportunities` is keyed by `github:owner/repo` and is GitHub-specific; it is a first slice, not this model (backlog T-040).

### D. Adaptive Research Priority Engine (cross-phase)
Ranks opportunities, projects, repositories, components and hypotheses from evidence: bounty economics and deadlines; scope and eligibility; source and repository reliability; code changes and upgrades; complexity and exposure; trust boundaries;
coverage gaps; historical outcomes; novelty; estimated research value, time and cost. **Scores are transparent (each point has a stored reason). No invented calibrated probabilities.** The simple explained scorer in 5.0 is a placeholder, not this engine.

### E. Blind Grok rediscovery benchmark (Phase 5.8)
AgentSmith independently attempts to rediscover the vulnerability Grok previously found through an Immunefi opportunity. The exact finding, repository and commit must first be **confirmed** by the owner. The earlier Alchemix V3 rounding/index investigation is only a **candidate, not a confirmed match** (and no record of it exists in this repository).
The reference finding stays hidden from the research pipeline until AgentSmith's hypotheses and evidence are **sealed**. Evaluate root-cause accuracy, impact, reproducibility, evidence quality, time and cost.
It is a **known-positive capability benchmark, not proof of novel discovery.**

### F. Live Engine Control Room
Integrates: discovery source health; new and changed opportunities; repository acquisition; research priorities; active and queued runs; specialist and tool activity; hypotheses and evidence; independent reviews; findings and outcomes; costs and performance.
**Everything shown is real and database-backed. No invented activity, no sample performance;** idle shows as idle, stale as stale, unknown as unknown.

### G. Safety and approval boundaries (permanent)
- Passive discovery does not authorise active testing; current program scope and rules are verified before any active research; no unauthorised testing.
- No automatic bounty submissions. No bypassing access restrictions or rate limits.
- No unapproved paid services or model spending (model calls only through the budget gateway).
- No production migration, deployment or worker activation, and no PR merge, without explicit owner approval.
- The existing Hunt service and its configuration are preserved. **No Vercel.**
- Credentials are never requested, printed or stored by the agent; the bearer token stays in the owner's custody.

## 3. Phase-by-phase status (verified 2026-11-26)
Status vocabulary: **Implemented and verified** / **Implemented but unverified** / **Designed but not implemented** / **Blocked** / **Awaiting approval** / **Future work**.
"Verified" here means exercised against the real thing it depends on; passing local tests alone does not make a phase complete.

| Phase | Primary status | Evidence (what is true) | What is NOT true / open |
|---|---|---|---|
| **5.0 Bounty discovery** | **Implemented but unverified** (GitHub-organisation adapter only) | `apps/api/src/discovery/`, migration `0008`, 61 discovery/db-role unit+integration tests, mutation spec 36/36, two review passes (author and a separate agent, `pr20-review-and-next-steps.md`). Off by default, human-gated. | Never run against real GitHub (approved live check blocked in the dev sandbox). Migration `0008` not applied anywhere but disposable local databases; not deployed; not merged (PR #20 draft). No human review. **Immunefi: Blocked** (terms forbid automated access; permission needed). **Code4rena and Sherlock platform adapters: Future work** (only their GitHub orgs are reachable by the existing adapter). Cantina, HackenProof, project pages: Future work (terms unread/unreachable). Known limitation: a compromised runtime role could forge a "human" event. |
| **5.0 General URL intake** | **Designed but not implemented** (classification only) | `resolveSourceReference` classifies GitHub, X and web URLs without fetching; `POST /v1/intake` creates a passive run; designs in `research-intake-and-discovery.md`, `x-bounty-link-intake.md`. | No fetch, extraction, verification of "official", pasted-text fallback, or platform-specific URL kinds (Immunefi/Code4rena/Sherlock). Not authorised to start fetching content. |
| **Unified opportunity model** | **Designed but not implemented** (requirements only) | Requirements in section 2C. | Current table is GitHub-only; no project-identity dedupe across sources; no commit-SHA/scope/reward/deadline fields. Needs a design and a new migration (approval). |
| **5.1 Research state** | **Implemented and verified** (locally; schema live, unused) | Migration `0007` (applied in production; ledger of 7 rows confirmed read-only on 2026-11-26), real-Postgres suites for blobs, snapshots, spans, events, reviews; mutation checks. | No production research run has ever used it (engine idle, no worker). Not merged to `main`. |
| **5.2 Repository acquisition** | **Implemented but unverified** | `apps/api/src/acquisition/`, 262 unit (with `net/`) + 23 integration tests also as the restricted role, mutation 65/65; code ships idle in the Release 1 image. | **No real GitHub validation has been done**: no live call ever made; `GitHubSource` is checked only against imitated servers and strict response schemas. No production path creates runs except human approval in 5.0 (unmerged); no production worker (Fly trial stops machines after 5 min; database owner role R1). Partial-snapshot policy, `GITHUB_TOKEN` and first live target are open owner decisions. Not merged. |
| **5.3 Intelligence mapping and attack-surface analysis** | **Awaiting approval** (design exists only in the old plan) | Legacy: `repository-mapper.ts` (ten regular expressions over at most 20 files) exists and is labelled as such. | Not designed in detail, not authorised, not started. Depends on 5.2 live verification. |
| **5.4 Structural smart-contract analysis** | **Future work** | Design sketch in the plan (section 5). `@solidity-parser/parser` is not a dependency. | Not started. Depends on 5.2 and 5.3. |
| **5.4B Automated security toolchain** | **Future work** (agreed capability) | Agreed 2026-11-25. | Needs a sandbox design for any tool that executes code (own approval), tool/licence selection, result schema. Findings must enter as hypotheses with provenance, never as confirmed findings. |
| **5.5 Specialist research intelligence** | **Future work** | Design sketch only; legacy fixed-template hypotheses exist. | Not started. |
| **5.5A Weirdness Engine** | **Future work** (agreed; **definition not written**) | Name and intent recorded. | Needs a definition with the owner before design. |
| **5.6 Independent challenge and review** | **Future work** | 5.1 has review records and mode rules; legacy static checklist "challenge" exists and is not independent. | No evaluator that can weaken a claim; no independent reviewer path. |
| **5.7 Research dossiers and reporting** | **Future work** | Legacy brief endpoint with honest completeness labels. | No evidence-checked dossier. |
| **5.8 Frozen benchmarks and learning** | **Future work** | Design sketch (eval corpus, baseline); the blind Grok rediscovery benchmark is recorded in 2E. | Reference finding, repository and commit unconfirmed. Learning loop needs this baseline. |
| **Adaptive Research Priority Engine** | **Future work** | Agreed capability; 5.0 has a simple explained scorer (not this engine). | Objective, data, and approval to adapt behaviour all undefined; needs 5.8 outcomes. |
| **Live Engine Control Room** | **Designed but not implemented** (alpha dashboard exists) | `apps/web` alpha screens show real counts and say "not built" for missing sections; the 5.0 API exposes sources/opportunities. | No discovery-health, priority, tool/agent-activity, cost-attribution or review panels; no heartbeat/event sources for tools and agents. One stale UI string still says acquisition "is built in Task 5.2" (backlog T-110). |

Platform and release state: Release 1 (security foundation, engine idle) is **live** at `hub.agentsmithdesk.xyz` (image digest `sha256:c0eaf87d...`, Docker-less build, R1 owner role accepted temporarily). Not merged: PRs #11-#20. No worker, no CI (GitHub Actions unavailable), no genuine Dockerfile build pipeline.

## 4. Dependencies and blockers
| Item | Needs | Blocked by |
|---|---|---|
| Live GitHub shape check (5.0, 5.2) | an environment that can reach `api.github.com` (and `codeload.github.com` for acquisition) | dev sandbox allowlist; **owner action** |
| First live acquisition (5.2) | live shape check, a chosen small public repository, owner approval | same; owner decision on target and optional `GITHUB_TOKEN` |
| Immunefi adapter | written permission or clear official terms/API | Immunefi's Terms forbid automated access; **owner/Immunefi** |
| Code4rena / Sherlock / Cantina / HackenProof platform adapters | official terms and interfaces read and recorded | docs hosts unreachable from sandbox; HackenProof terms are an unreadable PDF |
| Unified opportunity model | design, then a migration | owner approval for any migration; design not written |
| URL intake extraction | opportunity model, fetch policy, pasted-text fallback | not authorised; model design |
| Production worker | billing resolved; least-privilege runtime role; no public ports | Fly trial (machines stop after 5 min); R1 role question on Fly Managed Postgres; **owner** |
| Migration `0008` in production | independent human review, live verification, matching code release | **owner approval**; PR #20 draft |
| Human-decision integrity | separate role/function for human events | role design (R1) |
| 5.3 and later | verified 5.2 on real repositories | live verification, approval |
| 5.8 benchmark | owner-confirmed reference finding, repository, commit | **owner** |
| Priority engine | 5.8 outcomes, objective definition | 5.8 |
| Genuine Docker build | a builder reachable from the dev environment | TLS interception; Actions unavailable |
| PR merges | explicit approval | policy |
