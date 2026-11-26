# Implementation backlog

Source of truth for scope is `docs/ROADMAP.md`; this file lists small, independently reviewable tasks. **Listing a task approves nothing**: each task needs its own go-ahead, and the "Approval" field names what extra approval it needs.
Tasks are design-first where architecture is involved, to prevent drift. Status of all tasks: **not started** (2026-11-26) unless stated.

## Recommended next implementation task
**T-040 Unified opportunity model: design (documentation only), including the discovery-before-scanning workflow and the Immunefi program lifecycle (new, updated, paused, closed).** Reason: every other discovery task (more sources, URL intake, dedupe, priority engine, Control Room, the 5.2 hand-off) depends on one shared identity for project, repository, commit, scope and provenance.
Today's table is GitHub-only and keyed `github:owner/repo`; adding Immunefi, Code4rena, Sherlock or pasted URLs on top of it would create exactly the disconnected duplicate pipelines the roadmap forbids. It needs no spending, no environment access and no migration,
so it can proceed now. In parallel, the single most valuable **owner-side** action is T-010 (live GitHub shape check), because 5.0 and 5.2 are both unverified without it.

## Tasks
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

### T-050: Adaptive Research Priority Engine: design
| Field | |
|---|---|
| Phase | cross-phase |
| Dependencies | T-040 |
| Scope | Define the feature set, how each feature is recorded, how scores are explained, how outcomes feed back, and the limits of what can be claimed. |
| Acceptance criteria | Design doc; explicitly forbids invented probabilities; separates v1 (transparent weights) from learned adaptation. |
| Required tests | n/a (design). |
| Security considerations | Budget caps respected; no model spend. |
| Approval required | None (documentation). |

### T-051: Priority scoring v1 (transparent features)
| Field | |
|---|---|
| Phase | cross-phase |
| Dependencies | T-050 approved, T-041 |
| Scope | Replace the 5.0 placeholder scorer with the v1 feature scorer; every point stored with its reason. |
| Acceptance criteria | Deterministic scores with per-feature reasons; no probability language. |
| Required tests | Unit tests per feature; mutation spec. |
| Security considerations | No behaviour adaptation. |
| Approval required | Approval of the design. |

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
