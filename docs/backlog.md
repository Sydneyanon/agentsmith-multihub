# Implementation backlog

Source of truth for scope is `docs/ROADMAP.md`; this file lists small, independently reviewable tasks. **Listing a task approves nothing**: each task needs its own go-ahead, and the "Approval" field names what extra approval it needs.
Tasks are design-first where architecture is involved, to prevent drift. Status of all tasks: **not started** (2026-11-26) unless stated.

## Recommended next implementation task
**T-040 Unified opportunity model: design (documentation only), including the discovery-before-scanning workflow and the Immunefi program lifecycle (new, updated, paused, closed).** Reason: every other discovery task (more sources, URL intake, dedupe, priority engine, Control Room, the 5.2 hand-off) depends on one shared identity for project, repository, commit, scope and provenance.
Today's table is GitHub-only and keyed `github:owner/repo`; adding Immunefi, Code4rena, Sherlock or pasted URLs on top of it would create exactly the disconnected duplicate pipelines the roadmap forbids. It needs no spending, no environment access and no migration,
so it can proceed now. In parallel, the single most valuable **owner-side** action is T-010 (live GitHub shape check), because 5.0 and 5.2 are both unverified without it.

## Tasks

## ID registry (checked 2026-11-26)
Used: T-010 to T-148 as listed below (T-137 and T-149 are unused and reserved free). Reserved by roadmap decision: **T-052 to T-058** (Adaptive Priority Engine, extending T-050 and T-051 in place), **T-150 to T-162** (APEX), **T-170 to T-179** (multi-domain). A documentation guard fails if any task ID appears twice.
### T-010: Live GitHub response-shape check (discovery)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | none |
| Scope | One read-only unauthenticated GET of `/orgs/code-423n4/repos?...` from a permitted environment; compare fields to `github-org.ts`; record status, timestamp, rate-limit header, field validation. No body kept. No code change unless the shape differs. |
| Acceptance criteria | A short evidence record in docs; any shape mismatch becomes a separate fix task. |
| Required tests | None new (existing adapter tests extended only if shape differs). |
| Security considerations | No token; no writes; no production source or run. |
| Approval required | Owner runs it or approves an environment allowing `api.github.com`. |

### T-011: First live repository acquisition (one small public repository)
| Field | |
|---|---|
| Phase | 5.2 |
| Dependencies | T-010; owner chooses target and `GITHUB_TOKEN` policy |
| Scope | Run acquisition against one owner-chosen small public repository from a permitted environment against a disposable database; record commit SHA, tree, counts, memory, duration. |
| Acceptance criteria | Sealed snapshot whose manifest matches GitHub's tree; real response shapes confirmed or deviations recorded. |
| Required tests | Evidence record; fixtures added for any new shape. |
| Security considerations | Disposable database only; passive; hosts `api.github.com`, `codeload.github.com` only. |
| Approval required | Owner approval for target, hosts and environment. |

### T-020: Source-adapter contract and registry (design + refactor plan)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | none |
| Scope | Document the adapter interface (config schema, URL builder with per-adapter fixed host allowlist, parser, source-verification hook, rate-limit declaration, health reporting). No code. |
| Acceptance criteria | Design doc reviewed; lists the one migration needed to widen the adapter set and the per-adapter host constant refactor. |
| Required tests | n/a (design). |
| Security considerations | Host allowlists are code constants, never configuration. |
| Approval required | None (documentation). |

### T-021: Source health and failure back-off
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-020 |
| Scope | Use `consecutive_failures` for exponential back-off and a derived health state (healthy/degraded/failing/disabled) exposed read-only by the API. |
| Acceptance criteria | A failing source is retried less often; health is computed from stored observations only. |
| Required tests | Integration tests for back-off and health states; mutation spec entries. |
| Security considerations | No new outbound capability. |
| Approval required | None for code; migration only if a column is needed (separate approval). |

### T-022: Immunefi access decision and written permission
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | none |
| Scope | Owner (the agent never contacts Immunefi) chooses an access route from `docs/immunefi-scout.md` section 2: ask Immunefi in writing whether `public-api/bounties.json` or another interface may be polled, at what rate and with what caching/storage terms; or decide to rely on manual import / official repositories. Read the full Terms of Use (about 16,000 characters were not read verbatim). |
| Acceptance criteria | The decision and any written permission are recorded in `immunefi-scout.md` and the decision log. No polling code is written without it. |
| Required tests | n/a |
| Security considerations | No automated access to immunefi.com until resolved; no disguised or rate-evading access. |
| Approval required | Owner. |

### T-023: Code4rena and Sherlock source verification
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-010 |
| Scope | Verify official GitHub organisations and repository naming (including `-findings` vs code repositories, judging repositories); record verification signals; read platform terms/docs when reachable. |
| Acceptance criteria | Verified source records with provenance; adapter config presets that exclude findings/judging repositories unless intended. |
| Required tests | Fixture tests of name filters. |
| Security considerations | Official-ness needs corroboration plus human confirmation. |
| Approval required | Owner confirms official organisations. |

### T-024: Cantina, HackenProof, official project bounty pages: terms and interface research
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | hosts reachable or owner supplies text |
| Scope | Read official terms/docs for each; classify permitted access (API, feed, manual only). |
| Acceptance criteria | A verified/unverified table per source; no adapter. |
| Required tests | n/a |
| Security considerations | No scraping. |
| Approval required | None for research; any adapter needs approval. |

### T-030: URL intake design: extraction, verification and pasted-text fallback
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-040 (draft) |
| Scope | Design how a pasted URL becomes provenance-carrying fields; what is fetched, when access fails, and how pasted text is accepted and marked as operator-supplied. |
| Acceptance criteria | Design doc; defines per-kind extractors (X, GitHub, Immunefi, Code4rena, Sherlock, project page, disclosure) and the never-fabricate rule. |
| Required tests | n/a (design). |
| Security considerations | SSRF-pinned fetch only; X never crawled; no login bypass. |
| Approval required | None (documentation). |

### T-031: URL classifier: platform-specific kinds (no network)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-030 |
| Scope | Extend `resolveSourceReference` with kinds for Immunefi, Code4rena, Sherlock pages and canonical forms; pure function. |
| Acceptance criteria | Known URLs classify and canonicalise deterministically; unknown remain `web_page`; hostile URLs still rejected. |
| Required tests | Table-driven unit tests; mutation spec. |
| Security considerations | No fetch; SSRF rules unchanged. |
| Approval required | None. |

### T-032: Pasted-text intake path
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-030 |
| Scope | Accept operator-pasted text with its claimed source URL, store as an operator-supplied snapshot (hash, time, actor), never labelled as retrieved. |
| Acceptance criteria | Intake stores text with provenance 'operator-supplied'; extraction treats it as unverified. |
| Required tests | Integration tests incl. labelling; mutation: text cannot be marked fetched. |
| Security considerations | Untrusted text bounded and sanitised. |
| Approval required | Migration likely: separate approval. |

### T-040: Unified opportunity model: design
**Status: design drafted 2026-11-26 in `docs/opportunity-model-design.md`; awaiting owner review. Documentation only; T-041 (migration draft) is not started.**

| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | none |
| Scope | Design how opportunity, program, project identity, repository identity, commit SHA, scope, reward, deadlines, eligibility, testing restrictions, snapshots and change history relate; how today's `bounty_opportunities` migrates; the program lifecycle (discovered, updated, **paused**, closed/ended, dismissed) that today's states lack; the discovery-before-scanning flow (`immunefi-scout.md` section 3); and the Immunefi record fields observed in the earlier scout output and in the unverified JSON (reward, dates, standing vs time-boxed, size, program URL, entry requirements, code location and commit), each as a *claim with provenance*. |
| Acceptance criteria | Design doc with schema sketch, identity-resolution rules and cross-source dedupe; reviewed. No migration. |
| Required tests | n/a (design). |
| Security considerations | Official-ness never inferred from one source; scope is a claim until confirmed. |
| Approval required | None (documentation); the later migration needs approval. |

### T-041: Unified opportunity model: migration draft and tests
**Status 2026-11-26: NOT started; the owner withheld approval pending review of the T-040 design. Review prepared for approval in `docs/opportunity-model-review.md` (findings F1 to F13, decisions D1 to D9, backfill, rollback and compatibility plan). No SQL written.**
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-040 approved |
| Scope | Write migration `0009` and store functions per the approved design; tested on disposable databases only. |
| Acceptance criteria | Migration applies and rolls back cleanly; existing discovery data maps over; append-only rules preserved. |
| Required tests | Real-Postgres tests incl. restricted role; mutation spec. |
| Security considerations | Least-privilege grants updated in `runtime-grants.json`. |
| Approval required | Explicit approval before writing; separate approval before any production apply. |

### T-042: Cross-source project identity and dedupe
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-041 |
| Scope | Resolve the same project seen via several sources to one identity using repository identity and verified links. |
| Acceptance criteria | Two sources for one project yield one research pipeline; conflicts are surfaced, not merged silently. |
| Required tests | Fixture-based tests for merges and false-merge prevention. |
| Security considerations | Never merge on name similarity alone. |
| Approval required | None beyond T-041. |

### T-050: Adaptive Research Priority Engine: detailed design
**Status 2026-11-26: design written and the owner's initial policies adopted (exploration 20/80 configurable; five outcome categories, only confirmed are discovery labels; no adaptive weights or probabilities before preregistered evidence; audit data only with provenance and permitted use, never as project saturation) in `docs/adaptive-priority-engine-design.md` section 10. Expands the original T-050; no duplicate task exists.**

| Field | |
|---|---|
| Phase | cross-phase (core capability, built early) |
| Dependencies | T-040 (opportunity model design) |
| Scope | Define the six prioritisation levels, signals (freshness, coverage and saturation, reassessment, economics, exploration), scoring v1, the version-aware coverage record, learning rules and evaluation against simple baselines. |
| Acceptance criteria | A reviewed design that: separates v1 transparent weights from learned adaptation; forbids invented probabilities; states the exploration policy parameter; defines coverage keyed by version and component hash; lists the owner decisions (exploration share, learning ground-truth levels, calibration thresholds, audit-data ingestion). |
| Required tests | n/a (design); a documentation guard pins its key rules. |
| Security considerations | Budget caps respected; no model spend; no approval is ever started by the engine. |
| Approval required | None (documentation); owner review of the open decisions. |

### T-051: Transparent deterministic priority scoring v1
**Status 2026-11-26: implemented on fixtures only (`apps/api/src/priority/`, 14 property tests including golden values that freeze policy v1 as the deterministic baseline). Not connected to real data; steers nothing.**

| Field | |
|---|---|
| Phase | cross-phase |
| Dependencies | T-050 approved; built alongside T-040/T-041, on fixtures first |
| Scope | Replace the 5.0 placeholder scorer with the v1 feature scorer over synthetic opportunities and repository histories; every feature contribution stored with reason and evidence pointer; versioned weight policy file; uncertainty flags. Real discovery and acquisition feeds attached as they become operational. |
| Acceptance criteria | Deterministic scores with per-feature reasons; no probability language; exploration and coverage-gap components separable; fixtures cover freshness, saturation and recovery cases. |
| Required tests | Unit tests per feature; golden-file score explanations; mutation spec. |
| Security considerations | No behaviour adaptation; no external calls. |
| Approval required | Approval of the T-050 design. |

### T-052: Research coverage and audit-saturation model
**Status 2026-11-26: model built on fixtures only (`apps/api/src/priority/coverage.ts`, 9 tests): coverage per component at a content hash and per class; changed code never counts as covered; audits count only with provenance and permitted use, only for components they name at the unchanged hash, discounted (claimed 0.25, commit-specific 0.8, never 1.0); project figure is component-weighted. Not wired into policy v1 (frozen); no schema (needs T-041/T-144 approval); real-Postgres invalidation tests wait for that schema.**
| Field | |
|---|---|
| Phase | cross-phase / 5.1 |
| Dependencies | T-050, T-040; structural component hashes (5.4) |
| Scope | Design then build the version-aware coverage records: examined commits, mapped components, investigated surfaces and classes, hypotheses and outcomes, unexplored areas, evidence-backed prior-audit coverage with reliability discount. |
| Acceptance criteria | Unchanged saturated components lose priority; changed or new code is never treated as covered; one heavily audited contract does not lower the whole project; unverified audit claims are discounted. |
| Required tests | Real-Postgres tests of coverage invalidation by content hash; fixtures for audited-and-unchanged vs changed components. |
| Security considerations | Third-party audit data ingested only under its terms. |
| Approval required | Design approval; migration approval for any schema. |

### T-053: Commit- and change-aware reprioritisation
| Field | |
|---|---|
| Phase | cross-phase / 5.2 |
| Dependencies | T-052, T-011 (real acquisition), T-051 |
| Scope | Event-driven recovery: new commits, upgrades, new integrations, scope or asset changes, new intelligence, changed hypothesis evidence re-open exactly the affected components. |
| Acceptance criteria | A fixture history where an old, low-priority repository gains a relevant commit rises in rank for the changed components only, with the trigger recorded as the reason. |
| Required tests | Replay tests over synthetic commit histories. |
| Security considerations | Read-only monitoring only; no polling of any source without approval. |
| Approval required | Design approval; no live polling without owner approval. |

### T-054: Economic and research-efficiency scoring
| Field | |
|---|---|
| Phase | cross-phase |
| Dependencies | T-051 |
| Scope | Reward and eligibility, impact, scope and asset importance, deadlines, cost and time estimates from measured runs, historical performance per class; all weights in the reviewed policy file. |
| Acceptance criteria | Each factor visible in the explanation; missing data produces an uncertainty flag, not a guess; no probability claims. |
| Required tests | Feature unit tests; fixtures with missing and conflicting data. |
| Security considerations | None. |
| Approval required | None beyond T-050 approval. |

### T-055: Exploration versus exploitation allocation
| Field | |
|---|---|
| Phase | cross-phase |
| Dependencies | T-051, T-052 |
| Scope | Implement the reserved exploration share with seeded, logged selection among low-coverage and novel candidates. |
| Acceptance criteria | Over a simulated period the engine spends at least the configured share on exploration, never only on the top scorers, and every exploration pick is reproducible from its seed and logged reason. |
| Required tests | Allocation simulations; reproducibility tests. |
| Security considerations | None. |
| Approval required | Owner sets the exploration share. |

### T-056: Historical outcome integration and calibration
| Field | |
|---|---|
| Phase | cross-phase / 5.8 |
| Dependencies | T-057 baselines, independently confirmed outcomes from 5.6/5.8 |
| Scope | Store outcomes with confirmation levels; adaptive weight updates and, only when evidence allows, calibration. |
| Acceptance criteria | A **preregistered** plan, written before outcome data is examined, stating: the evidence threshold and its justification (diverse targets and classes, independently adjudicated only); the calibration method; the held-out evaluation design; and the comparison against the frozen deterministic policy `priority-policy/1`. Learning uses only `confirmed` outcomes; refuted, inconclusive, duplicate and missed outcomes are evidence, never success labels; calibrated estimates are reported only if they beat the frozen policy on held-out data. |
| Required tests | Tests that unverified outcomes cannot enter training; held-out replay showing the learner's ranking improves. |
| Security considerations | None. |
| Approval required | Owner approval of the minimum evidence threshold. |

### T-057: Comparative evaluation against simple baselines
**Status 2026-11-26: offline replay harness built (`apps/api/src/priority/replay.ts`, 7 tests): random, newest-first, highest-reward-first and round-robin baselines plus engine v1 and a ground-truth oracle; reports confirmed findings, findings per cost, time to first confirmed, changed-code coverage, exploration yield and regret; strategies are tested not to see the ground truth. Only a SYNTHETIC scenario exists, so no result is evidence that any strategy is better; real comparison needs replayed histories with independently confirmed outcomes.**
| Field | |
|---|---|
| Phase | cross-phase / 5.8 |
| Dependencies | T-051, historical or synthetic outcome data |
| Scope | Offline replay against random, newest-first, highest-reward-first and round-robin. |
| Acceptance criteria | Reports confirmed findings per cost, time to first confirmed finding, changed-code coverage, exploration yield and regret; the engine must beat the simple baselines on held-out replays before steering real capacity. |
| Required tests | The replay harness itself, with frozen inputs. |
| Security considerations | None. |
| Approval required | None. |

### T-058: Live integration with discovery, orchestration and the Control Room
| Field | |
|---|---|
| Phase | cross-phase / Control Room |
| Dependencies | T-051, T-057, discovery and acquisition operational, T-091 |
| Scope | Feed ranked queues to orchestration, explanations to the Control Room, search budgets to APEX. |
| Acceptance criteria | Every displayed ranking reproduces from stored records with its explanation; no displayed score without a stored assessment. |
| Required tests | API tests; UI test refusing unbacked values. |
| Security considerations | The engine never triggers an action that needs an approval. |
| Approval required | Owner approval before it steers real work. |

### T-060: Fly Managed Postgres role verification
| Field | |
|---|---|
| Phase | 5.0/ops |
| Dependencies | owner approves a disposable cluster (cost) |
| Scope | On a throwaway cluster test creating a Writer user, the role guard, the grants script and TRUNCATE rights. |
| Acceptance criteria | Documented answer to: can least-privilege roles be built on MPG, and which design. |
| Required tests | Evidence record; script change if needed. |
| Security considerations | No production cluster touched. |
| Approval required | Owner approval (costs money). |

### T-061: Separate human-decision integrity
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-060 |
| Scope | Make human decision events writable only through a separate role/function. |
| Acceptance criteria | A compromised runtime role cannot forge a human event. |
| Required tests | Restricted-role tests attempting forgery. |
| Security considerations | Closes limitation recorded in PR #20 review. |
| Approval required | Approval; role change in production needs separate approval. |

### T-062: Worker deployment design (no activation)
| Field | |
|---|---|
| Phase | ops |
| Dependencies | T-060 |
| Scope | Process group, no public ports, egress allowlist, runtime role, cost estimate from Fly's own pricing page. |
| Acceptance criteria | Design reviewed; minimum monthly cost stated by the owner from Fly pricing. |
| Required tests | n/a |
| Security considerations | Never starts a worker. |
| Approval required | Owner approves billing before any activation. |

### T-063: Genuine Docker build pipeline
| Field | |
|---|---|
| Phase | ops |
| Dependencies | a reachable builder |
| Scope | Replace the Docker-less artifact with a Dockerfile-built image and verify equivalence. |
| Acceptance criteria | Digest-pinned build from the exact commit; smoke 31/31. |
| Required tests | Existing image smoke. |
| Security considerations | Supply-chain: pinned base digest. |
| Approval required | Approval for any paid service. |

### T-070: Independent human review of PR #20
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | none |
| Scope | A human (or external) security review of migration 0008, the guard trigger, events, scheduler and the 5.2 hand-off. |
| Acceptance criteria | Findings recorded and fixed or accepted. |
| Required tests | As findings require. |
| Security considerations | n/a |
| Approval required | Owner arranges the reviewer. |

### T-080: Phase 5.3 design: intelligence mapping and attack-surface analysis
| Field | |
|---|---|
| Phase | 5.3 |
| Dependencies | T-011 |
| Scope | Design inputs/outputs, evidence rules, how it replaces the legacy regex mapper, language scope. |
| Acceptance criteria | Design doc approved by the owner; no code. |
| Required tests | n/a (design). |
| Security considerations | Read-only analysis; no execution of repository code. |
| Approval required | Owner approval to start the phase. |

### T-090: Control Room design: event and heartbeat sources
| Field | |
|---|---|
| Phase | Control Room |
| Dependencies | T-040 |
| Scope | Specify which real records feed each panel (discovery health, opportunities, acquisition, priorities, runs, tools/agents, reviews, findings, cost); define the 'refuse to render unbacked data' test. |
| Acceptance criteria | Design doc listing, per panel, its source table or the missing source. |
| Required tests | n/a (design). |
| Security considerations | Read-only; token-protected API. |
| Approval required | None (documentation). |

### T-091: Control Room: discovery health panel (read-only)
| Field | |
|---|---|
| Phase | Control Room |
| Dependencies | T-021, T-090 |
| Scope | API endpoint and UI panel showing source health, last observations and failures from stored rows. |
| Acceptance criteria | Idle/stale/unknown are labelled; nothing shown without a stored record. |
| Required tests | API integration tests; UI test refusing unbacked values. |
| Security considerations | Bearer-protected; no new write path. |
| Approval required | None beyond normal review. |

### T-100: Grok rediscovery benchmark: reference confirmation
| Field | |
|---|---|
| Phase | 5.8 |
| Dependencies | owner |
| Scope | Owner supplies and confirms the Immunefi program, finding, repository and commit Grok found; Alchemix V3 rounding/index remains a candidate until then. |
| Acceptance criteria | A confirmed reference record, stored **sealed and hidden** from the pipeline (hash recorded, content withheld from any research input). |
| Required tests | n/a |
| Security considerations | Reference must not enter any research context before sealing. |
| Approval required | Owner provides and confirms. |

### T-101: Blind rediscovery benchmark protocol
| Field | |
|---|---|
| Phase | 5.8 |
| Dependencies | T-100, T-080 |
| Scope | Define the blinding, sealing of AgentSmith's hypotheses and evidence before the reveal, and scoring (root cause, impact, reproducibility, evidence quality, time, cost). |
| Acceptance criteria | Protocol doc; framed as a known-positive capability test, not proof of novelty. |
| Required tests | Protocol checks that the reference is absent from inputs. |
| Security considerations | No active testing; local repository reading only unless scope is verified. |
| Approval required | Owner approval before any run; model spend only through the gateway with approval. |

### T-110: Fix stale dashboard text about acquisition
| Field | |
|---|---|
| Phase | Control Room |
| Dependencies | none |
| Scope | One-line UI string still says acquisition is built in Task 5.2 and unavailable. |
| Acceptance criteria | Text states the real status (implemented, not live-verified). |
| Required tests | UI test of the string. |
| Security considerations | None. |
| Approval required | None. |

### T-120: Weirdness Engine definition workshop
| Field | |
|---|---|
| Phase | 5.5A |
| Dependencies | none |
| Scope | Owner and Claude write the definition (scope, inputs, outputs). |
| Acceptance criteria | Definition committed to the plan. |
| Required tests | n/a |
| Security considerations | None. |
| Approval required | Owner participation. |

### T-130: Obtain the earlier scout's source (Hunt engine)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | owner |
| Scope | The scout's method is recovered from history (`immunefi-scout.md` section 1) but its source (`huntd/scout.py`, `huntd/sources.py`, tests, fixtures) is not in any repository I can see. Owner says where it lives (their server, a private repository, or the earlier session's tarball) and approves read-only access. The agent will not read credentials, the admin token or secrets while doing so. |
| Acceptance criteria | The design notes in `immunefi-scout.md` are confirmed or corrected against the real source; fixtures usable for adapter tests are identified. |
| Required tests | n/a (evidence record) |
| Security considerations | Do not copy tokens, passwords or keys; read only the named source files. |
| Approval required | Owner supplies or approves access. |

### T-131: Platform-source registry (inventory, not adapters)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-020, T-024 |
| Scope | Record the scout's 13-platform inventory (Immunefi, Sherlock, Cantina, Code4rena, CodeHawks, Guardian, HackenProof, CertiK Hunt, HackerOne, Mantis, SpecSiege, bugbounty.fyi, X) with per-source: verified official interface, terms status, permitted access, priority. Aggregators are marked secondary. |
| Acceptance criteria | A table in docs; every entry says verified vs unverified; no adapter. |
| Required tests | n/a |
| Security considerations | No access without a recorded terms review. |
| Approval required | None (documentation); any adapter needs approval. |

### T-132: Manual snapshot import design and adapter (Immunefi first)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-040, T-032 |
| Scope | A human-initiated import of an operator-supplied program list or page text; stored as an operator-supplied snapshot (hash, time, actor) and parsed into opportunities with field provenance; never labelled as fetched by the system. |
| Acceptance criteria | An imported list creates/updates opportunities in the unified model with change history; a re-import detects new/updated/paused/closed; malformed input fails closed. |
| Required tests | Fixture imports (incl. hostile input); lifecycle diff tests; mutation spec. |
| Security considerations | Untrusted input bounded; no network access; the owner decides whether the source of the file complies with its terms. |
| Approval required | Design approval, then migration approval if a table is needed. |

### T-133: Immunefi polling adapter (only after an approved access method)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-022 (written permission), T-020, T-041, T-021 |
| Scope | Rate-limited, conditional-request polling at the permitted rate, with health status, kill switch and snapshot hashing; disabled by default. |
| Acceptance criteria | Behaviour matches the recorded permission exactly (rate, caching, storage); failure handling and back-off tested. |
| Required tests | Fixture-server tests; rate-limit tests; mutation spec. |
| Security considerations | Fixed host constant; no evasion of limits; no use if permission is withdrawn. |
| Approval required | Written permission recorded + owner approval; enabling in production needs the S1/S2 blockers resolved. |

### T-134: Program lifecycle states (paused, ended) in the opportunity model
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-040 |
| Scope | Add paused and ended/closed distinctions (Immunefi exposes `isPaused`/`pausedAt`/`endDate`; other sources differ) to the model and diff logic. |
| Acceptance criteria | A program that becomes paused or ends yields a recorded event without losing its link to research. |
| Required tests | Lifecycle transition tests; mutation spec. |
| Security considerations | A source's claim of "closed" does not delete research history. |
| Approval required | Migration approval if schema changes. |

### T-135: Optional seed from the Hunt status board
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-132 |
| Scope | Treat the public Hunt `status.json` contest list as an operator-supplied historical seed of program names and URLs, all flagged unverified. Read-only; the Hunt repository and site are never modified. |
| Acceptance criteria | Seeded entries carry provenance "Hunt status projection, operator-supplied" and no verified scope. |
| Required tests | Import fixture test. |
| Security considerations | The board is a sanitised projection and is not a source of truth; no findings data exists in it. |
| Approval required | Owner approval. |

### T-136: Adapter conduct policy (all sources)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-020 |
| Scope | Write the policy every adapter must meet: honest identifying user agent, RFC 9309 robots.txt handling, response-size caps, conditional requests, fixed per-source rate, no evasion, kill switch. Reuse the Hunt engine's design where it fits. |
| Acceptance criteria | A reviewed policy and a checklist each adapter design must pass. |
| Required tests | n/a (policy); later enforced by adapter tests. |
| Security considerations | A source's terms override convenience; absence of a robots rule is not permission. |
| Approval required | None (documentation). |

### T-138: Decide the single owner of discovery (Hunt engine vs MultiHub)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | T-130 |
| Scope | The Hunt engine (Python, sqlite, deployed separately) already scouts and keeps a target backlog; MultiHub 5.0 is the permanent architecture. Decide: migrate its discovery into MultiHub, keep it as a feeder through an import path, or retire it. Meanwhile decide whether to pause its Immunefi source (S4). No second Immunefi poller is added. |
| Acceptance criteria | A recorded owner decision and, if feeding, an import contract that preserves provenance. |
| Required tests | n/a |
| Security considerations | The Hunt service and its configuration are not modified by MultiHub work without approval. |
| Approval required | Owner. |

### T-139: Safe read-only check of the Hunt engine's polling (S4)
| Field | |
|---|---|
| Phase | 5.0 |
| Dependencies | owner go-ahead per step |
| Scope | Follow `docs/hunt-engine-inspection-plan.md`: owner's own looks first, then (only if approved) one unauthenticated public status request and an allowlisted Linode instance-metadata read. No server access, no secrets, no change to Hunt. |
| Acceptance criteria | A recorded answer (confirmed polling, no evidence, or not determinable) and the evidence step that produced it. |
| Required tests | n/a |
| Security considerations | Never read StackScripts, user-data, configs, disks, volumes, the secrets file or the admin token; print allowlisted fields only. |
| Approval required | Owner, per step. |

### T-140: Fresh held-out corpus (successor to the burned one)

**Status 2026-11-26: done for corpus 2** (frozen, scored once, recorded). A third corpus is needed before the next measurement because corpus 2 was used for tuning after the first run.
| Field | |
|---|---|
| Phase | 5.8 |
| Dependencies | none |
| Scope | A separate agent writes a second corpus including harder cases (cross-contract, inheritance chains, proxies, access control via libraries, non-textbook styles); frozen with a manifest before the analyzer is changed. |
| Acceptance criteria | The analyzer is scored once on it and the result recorded unedited. |
| Required tests | `eval/run-eval.ts` |
| Security considerations | None (local text). |
| Approval required | None. |

### T-141: Compile-and-execute ground truth for labels (Foundry)

**Status 2026-11-26: done for reentrancy** with solcjs and a JS EVM instead of Foundry (Foundry's binaries and the compiler host are blocked here). Validator agrees 19/19; disputed labels settled. Other classes still unverified by execution.
| Field | |
|---|---|
| Phase | 5.4B |
| Dependencies | `docs/security-tooling-assessment.md` approved |
| Scope | Run the corpora's contracts under Foundry in a no-network sandbox to verify labels and the reentrancy validator's verdicts (including the two labels it disputes). |
| Acceptance criteria | Each disputed label is settled by execution; the validator's agreement rate is reported. |
| Required tests | Execution outputs recorded as artifacts. |
| Security considerations | Sandbox per the assessment; `ffi` off. |
| Approval required | Install of Foundry and pinned compilers; owner approval. |

### T-142: Path-sensitive independent challenge for access control, initializers and delegatecall

**Status 2026-11-26: implemented** (unprivileged-caller execution for access control, selfdestruct, delegatecall and initializers; failing-call execution for unchecked calls). tx.origin still has no independent method.
| Field | |
|---|---|
| Phase | 5.6 |
| Dependencies | none |
| Scope | A second method (path enumeration with guard facts) that can weaken or refute those classes, so they are not left unchallenged. |
| Acceptance criteria | Disagreement cases on both corpora are listed; classes with a validator no longer record `no-independent-validator`. |
| Required tests | Unit and held-out scoring; mutation spec. |
| Security considerations | None. |
| Approval required | None. |

### T-143: Wire the structural pipeline into the `repository_research` workflow (idle by default)

**Status 2026-11-26: implemented, off by default** (`structuralAnalysis` run option and `STRUCTURAL_ANALYSIS_ENABLED` worker switch). Not activated; no real-repository run yet.
| Field | |
|---|---|
| Phase | 5.3-5.7 |
| Dependencies | T-011 (first live acquisition) |
| Scope | Add the analyse and challenge steps after acquisition as worker steps; no production activation. |
| Acceptance criteria | A run created in tests passes acquire, analyse, challenge and produces the dossier. |
| Required tests | Real-Postgres integration incl. restricted role. |
| Security considerations | Read-only analysis; no execution of repository code. |
| Approval required | Design approval; no worker activation without owner approval. |

## APEX series (reserved T-150 to T-162; proposed, not authorised; see `docs/apex.md`)

### T-150: APEX: prior-art research and novelty assessment
**Status 2026-11-26: first pass in `docs/apex-prior-art.md` (no paper read directly). Second pass done in `docs/apex-prior-art-pass2.md`: 23 papers read in full (copies the authors published on GitHub), 7 official documentation sets including the Foundry book at a0f150db, and 28 README-only sources. Ratings: (1) existing/integration; (2) meaningful extension at most; (3) integration; (4) integration, possibly extension; (5) integration (lowered); (6) integration, possibly extension; (7) existing (lowered); (8) meaningful extension, provisional. None potentially novel. Publisher sites were still unreachable (the allowlist change was not approved at the prompt), so papers available only there are not read, and are listed in that document's section 6.**
| Field | |
|---|---|
| Phase | 5.5-APEX |
| Dependencies | none (may start when owner directs; recorded for later) |
| Scope | Cited review of static analysis, symbolic/concolic execution, fuzzing and invariant-guided exploration, formal verification, cross-contract and protocol-level analysis, learning-guided search and published protocol-level vulnerability research; per capability, novel versus combination. |
| Acceptance criteria | What exists, what is reusable (with licences), what is unsolved, where APEX could hold a measurable advantage, and a per-capability novel/combination verdict, every claim cited to a primary source; **no originality claimed without evidence**. |
| Required tests | n/a (research); a documentation guard pins the no-unsupported-originality rule. |
| Security considerations | No access to restricted sources; no code from reviewed tools is run without approval. |
| Approval required | None for research; owner review of the verdicts. |

### T-151: APEX: architecture and integration design
| Field | |
|---|---|
| Phase | 5.5-APEX |
| Dependencies | T-150, T-040, T-152 outline |
| Scope | Design how the eight capabilities sit on the shared protocol model, research state, hypothesis system, challenge and memory; origin and provenance recording; interfaces with the Weirdness Engine and specialists; budget and safety limits. |
| Acceptance criteria | Reviewed design showing no private parallel model; provenance of origin defined (and any needed store extension identified for later approval); independence rule (APEX never judges its own output) specified; first controlled-prototype scope proposed. |
| Required tests | n/a (design). |
| Security considerations | Passive-only and no-spend rules restated; any model use needs separate approval. |
| Approval required | Owner review; any schema change is a separate approval. |

### T-152: APEX: shared protocol model and invariant representation
| Field | |
|---|---|
| Phase | 5.3 / 5.4 / 5.5-APEX |
| Dependencies | T-151; structural analyzer on further independent corpora |
| Scope | Define the shared protocol representation (contracts, calls, assets, integrations, trust boundaries, state) and a machine-checkable invariant/assumption representation used by APEX, specialists and challenge. |
| Acceptance criteria | Representation documented and reviewed; round-trips existing analyzer output; invariants can be evaluated by the execution engine and by tools. |
| Required tests | Schema/golden tests; compile-and-execute checks where applicable. |
| Security considerations | None (local modelling). |
| Approval required | Design approval; migration approval if stored. |

### T-153: APEX: execution-path and transaction-sequence exploration
| Field | |
|---|---|
| Phase | 5.5-APEX (capabilities 1 and 4) |
| Dependencies | T-151, T-152 |
| Scope | Explore paths across functions, modifiers, helpers and contracts, and bounded sequences of transactions, with path-explosion control and recorded coverage. |
| Acceptance criteria | On independent fixtures, finds known multi-step and cross-function issues that the current analyzer does not; every path result stored with evidence and reproducible. |
| Required tests | Fixture tests; compiler-backed ground truth; mutation spec. |
| Security considerations | Local execution of snapshots only; resource caps. |
| Approval required | Task approval. |

### T-154: APEX: assumption extraction and breaking
| Field | |
|---|---|
| Phase | 5.5-APEX (capability 2) |
| Dependencies | T-151, T-152 |
| Scope | Extract explicit and implicit assumptions as records and systematically attempt to violate each. |
| Acceptance criteria | Assumptions are first-class stored records; each has a recorded breaking attempt and outcome; measured yield on independent fixtures. |
| Required tests | Fixture tests; independent challenge of resulting hypotheses. |
| Security considerations | No active testing; model use separately approved. |
| Approval required | Task approval. |

### T-155: APEX: cross-contract and protocol interaction exploration
| Field | |
|---|---|
| Phase | 5.5-APEX (capability 3) |
| Dependencies | T-151, T-152, T-153 |
| Scope | Model interactions among contracts, tokens, oracles, lending, vaults, bridges and external dependencies, including stubs for out-of-repository code with stated assumptions. |
| Acceptance criteria | Detects at least one class of multi-contract economic or ordering issue on independent fixtures that single-contract analysis misses; external-code assumptions are explicit. |
| Required tests | Independent multi-contract corpus; compiler-backed validation. |
| Security considerations | Stubs never contact real systems. |
| Approval required | Task approval. |

### T-156: APEX: novel hypothesis generation
| Field | |
|---|---|
| Phase | 5.5-APEX (capability 5) |
| Dependencies | T-153, T-154, T-155 |
| Scope | Generate hypotheses not tied to fixed templates, each evidence-linked with origin recorded; define and measure novelty. |
| Acceptance criteria | A stated novelty measure; hypotheses carry spans, assumptions and required checks; measured precision after independent challenge; no unevidenced claims. |
| Required tests | Held-out evaluation; independent challenge. |
| Security considerations | Model involvement is spending and needs separate approval; no external contact. |
| Approval required | Task approval; separate approval for any model spend. |

### T-157: APEX: adaptive exploration and prioritisation
| Field | |
|---|---|
| Phase | 5.5-APEX (capability 6) / Priority Engine |
| Dependencies | T-052, T-055, T-153 |
| Scope | Search budgeting and path prioritisation from coverage gaps, anomaly signals, novelty and measured discovery value. |
| Acceptance criteria | Search spends budget per the Priority Engine policy; coverage gaps close measurably versus an unguided baseline on fixtures; learning only from independently confirmed outcomes. |
| Required tests | Replay and fixture tests against baselines. |
| Security considerations | None. |
| Approval required | Task approval. |

### T-158: APEX: counterexample generation and independent validation
| Field | |
|---|---|
| Phase | 5.5-APEX (capability 7) / 5.6 |
| Dependencies | T-152, T-141 methods |
| Scope | Produce reproducible counterexamples and invariant-violation evidence under a real compiler and EVM, minimise them, and hand them to the independent challenge stage. |
| Acceptance criteria | Every APEX claim of a violation ships with a reproducible counterexample; APEX does not assign the independent outcome; disagreement with ground truth is measured. |
| Required tests | Compiler-backed execution; reproducibility checks. |
| Security considerations | Sandboxed, no network, no host access. |
| Approval required | Task approval; sandbox design approval. |

### T-159: APEX: integration with the Weirdness Engine and specialist researchers
| Field | |
|---|---|
| Phase | 5.5-APEX / 5.5A / 5.5 |
| Dependencies | T-151, Weirdness Engine definition (T-120) |
| Scope | Define signal exchange both ways with provenance of origin. |
| Acceptance criteria | Each hypothesis records the originating and contributing components; no duplicated pipeline; combined runs reproducible. |
| Required tests | Integration tests on fixtures. |
| Security considerations | None. |
| Approval required | Task approval. |

### T-160: APEX: durable discovery memory and learning
| Field | |
|---|---|
| Phase | 5.5-APEX (capability 8) / 5.1 / 5.8 |
| Dependencies | T-151, T-052 |
| Scope | Preserve explored paths, strategies, false positives, confirmed vulnerabilities and missed findings; learning interface with contamination controls. |
| Acceptance criteria | Memory records are versioned and queryable; learning uses only independently confirmed outcomes; replay shows prior knowledge improves search without leaking benchmark answers. |
| Required tests | Real-Postgres tests; leakage tests. |
| Security considerations | Retention and access rules for sensitive findings. |
| Approval required | Design and migration approval. |

### T-161: APEX: controlled prototype
| Field | |
|---|---|
| Phase | 5.5-APEX |
| Dependencies | T-150, T-151, T-152, and at least T-153 plus T-158 |
| Scope | A minimal end-to-end prototype on the shared architecture, offline fixtures only. |
| Acceptance criteria | Runs the full loop (explore, hypothesise, counterexample, independent challenge, memory) on fixtures with everything stored in the research state; frozen baselines untouched. |
| Required tests | Integration tests; reproducibility. |
| Security considerations | Passive and local only; disabled by default. |
| Approval required | Explicit owner approval to start implementation. |

### T-162: APEX: independent benchmark and comparative evaluation
| Field | |
|---|---|
| Phase | 5.8 / 5.5-APEX |
| Dependencies | T-161, independent corpora (T-140 style), T-141 |
| Scope | Compare existing tools, the current analyzer, combined conventional tooling, AgentSmith with APEX off and on, on frozen independently authored held-out corpora and unseen repositories. |
| Acceptance criteria | Reports independently confirmed APEX-only discoveries, false positives and negatives, reproducibility, time, cost, cross-contract coverage and generalisation; corpora written and graded independently of APEX; baselines frozen and unedited; the strategic claim is measured, and a negative result is reported as such. |
| Required tests | The evaluation harness; reproducibility reruns. |
| Security considerations | No active testing of live systems. |
| Approval required | Owner approval. |

### T-144: Research outcomes and coverage records
| Field | |
|---|---|
| Phase | 5.1 / cross-phase |
| Dependencies | `docs/research-memory-gaps.md` reviewed |
| Scope | Append-only `hypothesis_outcomes` (five categories, database rule for confirmed), missed findings via outcome `missed`, `research_coverage` keyed by component content hash, class and method, an optional counterexample artifact on evaluations, and a step-output cost convention. Contribution provenance deferred to T-151. |
| Acceptance criteria | Confirmed cannot be recorded without an independent supporting evaluation and a human adjudication; coverage distinguishes examined, abstained, not modelled and out of scope; the Priority Engine and the Control Room read these records instead of private copies. |
| Required tests | Real-Postgres tests incl. restricted role; mutation spec. |
| Security considerations | Append-only; least-privilege grants. |
| Approval required | Design approval, then migration approval. |

### T-145: Ground-truth disputes and adjudication records
**Status 2026-11-26: first record done** (`eval/adjudications/heldout3-reentrancy.json`): two corpus-3 labels upheld by EVM execution and an independent assessor; validator refutations overturned; labels never edited; human sign-off pending.
| Field | |
|---|---|
| Phase | 5.8 / cross-phase |
| Dependencies | `eval/ground-truth` |
| Scope | Disputed labels are adjudicated with recorded evidence (compiler-backed execution, independent assessment) and kept separate from the original labels; results can be reported both ways. Becomes a durable record type in T-144. |
| Acceptance criteria | No frozen label is edited; every adjudication names its evidence, adjudicator and human sign-off state. |
| Required tests | Registry verification of adjudication evidence hashes (with T-144). |
| Security considerations | None beyond provenance. |
| Approval required | Owner sign-off of each adjudication before it counts as human-adjudicated. |

### T-146: Analyzer failure classes B to H (development only)
**Status 2026-11-26: class A and validator defects V1-V3 implemented with development fixtures; B-H designed in `docs/analyzer-failure-classes.md`.**
| Field | |
|---|---|
| Phase | 5.4 / 5.6 |
| Dependencies | T-145 |
| Scope | Assembly storage slots, transitive authority, proxy surface, storage-layout collision, unlocked implementations, value guards mistaken for one-time guards, name-gated initializer detection; cross-function payable re-entry in the validator. |
| Acceptance criteria | Each class has new development fixtures written for the class (not copied from corpus 3) that fail before and pass after; dev corpus and corpora 1-2 do not regress; mutation spec kills every new guard. |
| Required tests | Fixtures, development re-scores labelled as such, mutation spec. |
| Security considerations | Passive analysis only. |
| Approval required | None (development); the measurement is T-147. |

### T-147: Corpus-4 evaluation gate
**Status 2026-11-26: corpus sealed (`eval/heldout4`, 59 contracts, 79 labels, 12 ambiguous; b9df4e5); not scored.**
| Field | |
|---|---|
| Phase | 5.8 |
| Dependencies | T-146 candidate registered in `eval/candidates.json` before scoring |
| Scope | Score the registered candidate, candidate 2 and the baseline once each on corpus 4; report clear and ambiguous labels and abstentions separately. |
| Acceptance criteria | Scored once, raw results unedited, registry updated with result hashes. |
| Required tests | `eval/verify-frozen.sh`. |
| Security considerations | None. |
| Approval required | Owner go-ahead to score. |

### T-148: Frozen-candidate registry
**Status 2026-11-26: done** (`eval/candidates.json`, `eval/candidates.sh`, `eval/CANDIDATES.md`; e57852b): candidates identified by commit, tree, analyzer and harness hashes; verified and tags restored in a tagless fresh clone. Residual risk (squash-merge) documented with owner options.
| Field | |
|---|---|
| Phase | 5.8 |
| Dependencies | none |
| Scope | Durable identity of frozen analyzer candidates and their scored results without remote tags. |
| Acceptance criteria | A fresh clone without tags verifies every candidate, result and corpus manifest and restores the tags. |
| Required tests | `eval/verify-frozen.sh` in a fresh clone. |
| Security considerations | None. |
| Approval required | Owner choice among the residual-risk options in `eval/CANDIDATES.md`. |

## Multi-domain series (reserved T-170 to T-179; proposed, not authorised; see `docs/multi-domain-research.md`)

### T-170: Shared kernel generalisation audit
| Field | |
|---|---|
| Phase | kernel |
| Dependencies | none |
| Scope | Audit which research-state, evidence, memory and orchestration interfaces assume Solidity or repositories, and design artifact snapshots and typed evidence locators. |
| Acceptance criteria | A reviewed list of required generalisations with a migration-free interface proposal; the smart-contract path unchanged. |
| Required tests | n/a (design). |
| Security considerations | None. |
| Approval required | Design approval. |

### T-171: Domain-pack interface design
| Field | |
|---|---|
| Phase | kernel |
| Dependencies | T-170 |
| Scope | Define what a domain pack declares: threat model, artifacts, acquisition adapters, analyzers, hypothesis families, validation methods, evidence locators, reporting templates and the safety and authorisation policy. |
| Acceptance criteria | Interface reviewed; smart contracts expressible as the first pack without behaviour change. |
| Required tests | n/a (design). |
| Security considerations | Authorisation policy is part of the interface. |
| Approval required | Design approval. |

### T-172: Web application domain: threat model and architecture research
| Field | |
|---|---|
| Phase | Web2 |
| Dependencies | T-171, smart-contract engine independently evaluated |
| Scope | Prior-art and threat-model study for authentication, authorisation, session management, access control, business logic, privilege escalation and trust boundaries; passive-first architecture; safe validation approach. |
| Acceptance criteria | Cited research and a reviewed architecture; every dynamic method states its authorisation and sandbox requirements. |
| Required tests | n/a (research/design). |
| Security considerations | Active testing only under verified scope and authorisation. |
| Approval required | Owner review. |

### T-173: Web application domain: limited proof of capability
| Field | |
|---|---|
| Phase | Web2 |
| Dependencies | T-172 |
| Scope | A limited passive proof (for example authorisation checks found by source review of a framework application) on a local fixture application. |
| Acceptance criteria | Works end to end on the shared kernel with evidence and independent challenge; no live system touched. |
| Required tests | Fixture application tests; independent labels. |
| Security considerations | Local fixtures only. |
| Approval required | Owner approval to start. |

### T-174: Web application domain: independent evaluation
| Field | |
|---|---|
| Phase | Web2 / 5.8 |
| Dependencies | T-173 |
| Scope | Independently authored held-out Web2 corpus, labels verified by a method other than the analyzer, comparison with conventional tools. |
| Acceptance criteria | Reported detection, false positives and negatives, and where it does not beat conventional tools. |
| Required tests | Evaluation harness. |
| Security considerations | Local fixtures only. |
| Approval required | Owner approval. |

### T-175: API security domain pack design
| Field | |
|---|---|
| Phase | API |
| Dependencies | T-171, T-174 |
| Scope | Design for BOLA, BFLA, authentication weaknesses, business-logic flaws, privilege escalation and data exposure from specifications and code. |
| Acceptance criteria | Reviewed design with passive methods first and an authorisation-gated validation plan. |
| Required tests | n/a (design). |
| Security considerations | No testing of live APIs without authorisation. |
| Approval required | Design approval. |

### T-176: Cloud and infrastructure domain pack design
| Field | |
|---|---|
| Phase | Cloud |
| Dependencies | T-171 |
| Scope | Design for identity and permissions, misconfiguration, insecure storage, exposed services and trust boundaries from infrastructure-as-code and exported configuration. |
| Acceptance criteria | Reviewed design; passive configuration analysis only until authorised. |
| Required tests | n/a (design). |
| Security considerations | No live probing; no credentials stored. |
| Approval required | Design approval. |

### T-177: Software supply-chain domain pack design
| Field | |
|---|---|
| Phase | Supply chain |
| Dependencies | T-171 |
| Scope | Design for dependency vulnerabilities, insecure packages, build and deployment processes, dependency confusion and substitution, compromised update mechanisms, trust relationships. |
| Acceptance criteria | Reviewed design using manifests and build definitions; sandboxed reproducibility checks. |
| Required tests | n/a (design). |
| Security considerations | No installation or execution of untrusted packages outside a sandbox. |
| Approval required | Design approval. |

### T-178: Identity systems domain pack design
| Field | |
|---|---|
| Phase | Identity |
| Dependencies | T-171 |
| Scope | Design for authentication flows, authorisation boundaries, identity lifecycle, token and credential handling, privilege relationships, federation and trust failures. |
| Acceptance criteria | Reviewed design with protocol-flow modelling and an authorisation-gated validation plan. |
| Required tests | n/a (design). |
| Security considerations | No credentials or personal data stored beyond an authorised engagement. |
| Approval required | Design approval. |

### T-179: Cross-domain acceptance review and expansion decision
| Field | |
|---|---|
| Phase | kernel |
| Dependencies | T-174, T-175 to T-178 as available |
| Scope | Review measured value per domain against the acceptance criteria in `docs/multi-domain-research.md` section 7 and decide the expansion order. |
| Acceptance criteria | A recorded decision per domain with the evidence; no domain declared operational without its corpus, comparison, safe validation and authorisation policy. |
| Required tests | n/a (review). |
| Security considerations | None. |
| Approval required | Owner decision. |

