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

### H. Discovery precedes scanning; the Immunefi scout (permanent)
AgentSmith must know which opportunities exist **before** deciding what code to research: discover, maintain a persistent opportunity list, detect new/updated/**paused**/closed programs, verify project and bounty information, identify official repositories, deduplicate across sources, prioritise, select, then acquire at an exact commit (5.2) and enter the normal pipeline. Immunefi is a source feeding the unified model, never a separate research system.
Investigation (2026-11-26, `docs/immunefi-scout.md`): the earlier scout was part of the separate **Hunt engine (`huntd`)**; its source is not available to me, but its saved session history verifies that it **read `immunefi.com/public-api/bounties.json` (JSON, no authentication) hourly, honoured robots.txt, and stored programs persistently** in a sqlite database, filtering paused/invite-only/ended programs and taking repository links from `githubUrl` and assets as unverified claims. Whether its authors read Immunefi's Terms is not recorded. Access position: the endpoint is **not officially documented** and Immunefi's Terms prohibit robots/automated access to the site, so permanent polling by AgentSmith is **not authorised**; a prior scout having read it is not authorisation. The owner chooses written permission, manual import or official-repository/URL routes; any approved access identifies itself honestly and honours robots.txt and agreed rates. Immunefi stays a permanent top-priority source regardless. Open issue S4: the Hunt engine may still be polling Immunefi hourly (safe check: `docs/hunt-engine-inspection-plan.md`). The recovered design and Immunefi field mappings are preserved in `docs/recovered-scout-design.md` as reference, not as an approved adapter.

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
| **5.0 Bounty discovery** | **Implemented but unverified** (GitHub-organisation adapter only) | `apps/api/src/discovery/`, migration `0008`, 61 discovery/db-role unit+integration tests, mutation spec 36/36, two review passes (author and a separate agent, `pr20-review-and-next-steps.md`). Off by default, human-gated. | Never run against real GitHub (approved live check blocked in the dev sandbox). Migration `0008` not applied anywhere but disposable local databases; not deployed; not merged (PR #20 draft). No human review. **Immunefi: Blocked** (no documented interface; Terms prohibit automated access; permission or an approved manual route needed; the earlier scout's method is recovered from history but its code is not, see `immunefi-scout.md`). **Code4rena and Sherlock platform adapters: Future work** (only their GitHub orgs are reachable by the existing adapter). Cantina, HackenProof, project pages: Future work (terms unread/unreachable). Known limitation: a compromised runtime role could forge a "human" event. |
| **5.0 General URL intake** | **Designed but not implemented** (classification only) | `resolveSourceReference` classifies GitHub, X and web URLs without fetching; `POST /v1/intake` creates a passive run; designs in `research-intake-and-discovery.md`, `x-bounty-link-intake.md`. | No fetch, extraction, verification of "official", pasted-text fallback, or platform-specific URL kinds (Immunefi/Code4rena/Sherlock). Not authorised to start fetching content. |
| **Unified opportunity model** | **Designed but not implemented** (requirements only) | Requirements in section 2C. | Current table is GitHub-only; no project-identity dedupe across sources; no commit-SHA/scope/reward/deadline fields. Needs a design and a new migration (approval). |
| **5.1 Research state** | **Implemented and verified** (locally; schema live, unused) | Migration `0007` (applied in production; ledger of 7 rows confirmed read-only on 2026-11-26), real-Postgres suites for blobs, snapshots, spans, events, reviews; mutation checks. | No production research run has ever used it (engine idle, no worker). Not merged to `main`. |
| **5.2 Repository acquisition** | **Implemented but unverified** | `apps/api/src/acquisition/`, 262 unit (with `net/`) + 23 integration tests also as the restricted role, mutation 65/65; code ships idle in the Release 1 image. | **No real GitHub validation has been done**: no live call ever made; `GitHubSource` is checked only against imitated servers and strict response schemas. No production path creates runs except human approval in 5.0 (unmerged); no production worker (Fly trial stops machines after 5 min; database owner role R1). Partial-snapshot policy, `GITHUB_TOKEN` and first live target are open owner decisions. Not merged. |
| **5.3 Intelligence mapping and attack-surface analysis** | **Implemented but unverified** (function-level prototype; not approved as a phase, not merged) | Branch `claude/phase-5-4-structural-analysis`: `apps/api/src/analysis/solidity/` builds contracts, inheritance, functions, modifiers and an effect trace (guards, calls, state reads and writes) with internal helpers and modifiers inlined; replaces the regex line counting for Solidity in the prototype pipeline. Legacy `repository-mapper.ts` is untouched. | Solidity only; never run on a real repository; no architecture-level map beyond functions and calls; not wired into the production workflow. |
| **5.4 Structural smart-contract analysis** | **Implemented but unverified** (dependency-free parser and analyzer prototype) | Own lexer and structural parser (no new dependency); 50 unit tests, 13/13 mutants killed; scored on an independently authored held-out corpus: run 1 18/18 vulnerable labels found with 1 false positive, baseline prototype 8/18 with 10 (`eval/results/README.md`). | Unverified labels; small corpus; no compiler cross-check; pragma-level semantics only; free functions, inline assembly and unresolved imports are not analysed. |
| **5.4B Automated security toolchain** | **Designed but not implemented** (assessment only) | `docs/security-tooling-assessment.md`: requirements, isolation, resource limits and how output becomes evidence-linked leads. Nothing installed. | Needs approval to install Foundry/Slither/Aderyn, a sandbox design and a pinned-compiler supply route. |
| **5.5 Specialist research intelligence** | **Implemented but unverified** (seven deterministic specialists, prototype) | Reentrancy (with helper chains and locks), access control (modifiers, in-body checks, helper guards, role mappings), initializers, delegatecall provenance, unchecked low-level calls, selfdestruct, tx.origin. Findings carry the call chain and the assumptions made. | No business-logic, economic, cryptographic, integration or upgrade specialists; no cross-contract data-flow beyond in-repository typed calls. |
| **5.5A Weirdness Engine** | **Future work** (agreed; **definition not written**) | Name and intent recorded. | Needs a definition with the owner before design. |
| **5.6 Independent challenge and review** | **Implemented but unverified** (one validator: reentrancy by bounded execution) | An interpreter executes a modelled contract against a re-entering attacker and compares with the best honest sequence of the same calls: validated with a concrete trace, refuted with the reason, or abstains. Other classes are recorded `inconclusive` (no validator), never as supported. | Author-independent review does not exist; only reentrancy; the attacker model is a bounded abstraction. |
| **5.7 Research dossiers and reporting** | **Implemented but unverified** (dossier builder, no report template) | `buildDossier` assembles leads, re-verified evidence spans, evaluations and database-derived status from stored records only, fails closed, and is reproducible (same content hash on a second run). Run end to end through the real acquisition path on the held-out corpus. | Not a submission-ready report; no human review recorded; nothing run on a real target. |
| **5.8 Frozen benchmarks and learning** | **Implemented but unverified** (frozen held-out corpus, harness and baseline; no learning) | `eval/`: baseline prototype preserved, held-out corpus frozen with a manifest, scoring harness, first-run result recorded before tuning. The blind Grok rediscovery benchmark is still recorded in 2E and not started. | Labels unverified; the corpus is already burned by one fix and needs a successor; no learning loop. |
| **Adaptive Research Priority Engine** | **Future work** | Agreed capability; 5.0 has a simple explained scorer (not this engine). | Objective, data, and approval to adapt behaviour all undefined; needs 5.8 outcomes. |
| **Live Engine Control Room** | **Designed but not implemented** (alpha dashboard exists) | `apps/web` alpha screens show real counts and say "not built" for missing sections; the 5.0 API exposes sources/opportunities. | No discovery-health, priority, tool/agent-activity, cost-attribution or review panels; no heartbeat/event sources for tools and agents. One stale UI string still says acquisition "is built in Task 5.2" (backlog T-110). |

Platform and release state: Release 1 (security foundation, engine idle) is **live** at `hub.agentsmithdesk.xyz` (image digest `sha256:c0eaf87d...`, Docker-less build, R1 owner role accepted temporarily). Not merged: PRs #11-#20. No worker, no CI (GitHub Actions unavailable), no genuine Dockerfile build pipeline.

## 4. Dependencies and blockers
| Item | Needs | Blocked by |
|---|---|---|
| Live GitHub shape check (5.0, 5.2) | an environment that can reach `api.github.com` (and `codeload.github.com` for acquisition) | dev sandbox allowlist; **owner action** |
| First live acquisition (5.2) | live shape check, a chosen small public repository, owner approval | same; owner decision on target and optional `GITHUB_TOKEN` |
| Immunefi adapter | an owner-approved access method: written permission (T-022), or the manual-import route (T-032/T-132) | Immunefi's Terms forbid automated access; endpoint undocumented; **owner/Immunefi** |
| Earlier scout's source code | read access to the Hunt engine source (T-130) | not in any repository I can see; **owner** |
| Single owner of discovery | decision on the Hunt engine versus MultiHub 5.0 (T-138) | two systems with overlapping scouts; **owner** |
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

## 5. Outstanding security issues (kept visible; not resolved)
| ID | Issue | Status |
|---|---|---|
| S1 | A compromised runtime database role can forge a "human" event and enable discovery sources. **The approval mechanism is not tamper-proof**; "human" means the holder of the single bearer token. | Open; needs a separate role/function (T-061), depends on S2. |
| S2 | R1: production runs as the schema-owner role; least-privilege role on Fly Managed Postgres unverified. | Open (T-060). |
| S4 | The Hunt engine (outside this repository) may already poll Immunefi's JSON hourly; no second poller is to be added, and the owner decides whether to pause it and which system owns discovery. | Open (T-138). |
| S3 | No production source, worker or polling is activated until S1, S2, the Fly billing restriction and the Immunefi access decision are resolved by the owner. | Standing rule. |
