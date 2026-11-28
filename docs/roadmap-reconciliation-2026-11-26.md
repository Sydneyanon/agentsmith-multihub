# Roadmap reconciliation audit, 2026-11-26

**Audited state.** Branch `claude/structural-validation-and-workflow` at `89ad63d`. This branch contains `main` (`b50ff6f`, 102 commits
behind) and every stacked branch (PR #11–#20 heads, `claude/phase-5-4-structural-analysis` at `6cd3be7`). The previous status table
in `ROADMAP.md` section 3 was verified on `claude/phase-5-2-audit-and-5-0-discovery`; it is kept unchanged as history.

**Method.** I read the code, migrations, tests, evaluation records and documentation on this branch, and ran the full local suite:
`npm run verify` passes, with 768 unit tests and 239/239 integration tests as the owner role and again as the restricted role.
Production facts come from records dated 2026-11-25/26 (`docs/hub-production-plan.md`, ROADMAP section 3); **I did not re-probe
production** in this audit (no probes without approval).

## Classification used

| Level | Meaning |
|---|---|
| 1 | Not started |
| 2 | Designed but not implemented |
| 3 | Implemented but not adequately tested |
| 4 | Tested in development only |
| 5 | Independently evaluated |
| 6 | Operational in production |

A phase can hold several items at different levels; each is rated on what it **demonstrably does**.

---

## 1. Executive summary

AgentSmith today is a **well-tested research prototype with a live but idle platform**. It is not yet an operating research system.

- **Strongest part: structural Solidity analysis and its evaluation discipline.**
  - The deterministic analyzer (5.4/5.5) has been scored on three independently authored, sealed corpora.
  - Corpus 3 gave precision 0.89 and recall 0.65 on clear labels. Those corpora are synthetic and written by the same model family.
  - It ran once on a real public repository (7 of 8 documented bugs found), as development evidence.
- **Foundation (5.0–5.3) is not operational:**
  - **5.0 discovery:** one GitHub-organisation adapter, never run live; there is no multi-source discovery.
  - **5.1 research state:** schema applied in production (as recorded) but never used by a production run. The outcome, coverage,
    adjudication and human-review recording that the learning loop needs does not exist yet.
  - **5.2 acquisition:** proven on one real repository through a git-clone path in a disposable database. The GitHub API path has never
    run live, and there is no production worker.
  - **5.3 mapping:** architecture and attack-surface intelligence does not exist beyond function-level structure.
- **Coherence gap the roadmap does not show.** There are **two research pipelines**:
  - the original intake chain: regex mapper, template hypotheses, checklist challenge, writing `source_snapshots` and step output;
  - the newer `repository_research` workflow: sealed snapshots, structural analysis and execution challenge in the 5.1 research store.

  They share no snapshot, hypothesis or evidence model. This contradicts "one coherent system", and later intelligence work (APEX,
  Weirdness, the Priority Engine) has no single substrate to attach to until it is resolved.
- **Confirmed findings cannot be recorded.** There is no outcome record and no API for a human review. Under the owner's own
  definition, the system therefore cannot yet produce a confirmed discovery.
- **Later-stage work is ahead of the foundation.** The Priority Engine, APEX prior-art research and the corpus programme have
  progressed while 5.0–5.3 stayed unverified. That is acceptable for paper and fixture work. It must not continue into implementation
  that assumes a working foundation.

## 2. Status audit from 5.0 onward

| Item | Level | Evidence (this branch) | What is NOT true |
|---|---|---|---|
| **5.0 GitHub-organisation discovery adapter** | **4** | `apps/api/src/discovery/` (monitor, store, api, step); migration `0008` (`adapter IN ('github_org_repos')`, the only adapter); 25 real-Postgres integration tests, mutation spec; scheduler only when `DISCOVERY_ENABLED=true` | Never run against real GitHub. `0008` not applied outside disposable databases (as recorded). Unmerged (PR #20 draft). |
| **5.0 Multi-source discovery** (Immunefi, Code4rena, Sherlock, Cantina, HackenProof, project pages) | **1** | none in code | Immunefi blocked (terms, owner/Immunefi). The others need terms review. The Hunt engine may already poll Immunefi (S4, T-138 owner decision). |
| **5.0 URL intake** | **3** for classification; **2** for content | `source-resolver.ts` classifies GitHub/X/web URLs; `POST /v1/intake` creates an intake run whose first steps resolve the source and identify the project | No content extraction, no official-repository verification, no pasted-text fallback, no platform URL kinds. |
| **5.0 Unified opportunity model** | **2** | T-040 design, T-041 review (`opportunity-model-review.md`), D1–D9 brief (`opportunity-model-decisions.md`) | No migration; awaiting the owner's D1–D9 decisions. |
| **5.1 Research-state store** (blobs, sealed snapshots, spans, hypotheses, evaluations, reviews, events) | **4** (schema live in production as recorded; never used there) | Migration `0007`; `research-state.ts`; 89 real-Postgres tests across three suites, also as the restricted role; append-only and guard tests | No production run has written to it. Recording outcomes, missed findings, duplicates, coverage, effort and adjudications is **not implemented** (T-144 design only). |
| **5.1 Human review / adjudication path** | **3** | `ResearchStore.recordReview` exists and is tested at store level | **No API route or UI records a human review.** "Confirmed" is therefore unreachable. S1: "human" rows are forgeable by the runtime role. |
| **5.2 Repository acquisition (sealed, commit-pinned snapshots)** | **4** | `apps/api/src/acquisition/`; 25 integration tests; snapshot verification (manifest, per-file git object id); **one real public repository** (`crytic/not-so-smart-contracts` @ `020dbdb`, 47 files, manifest `b0d4fb23…`) acquired via the clone path into a disposable database (`eval/real-runs/`) | The GitHub API path (`GitHubSource`) has **never run live** (T-010; `api.github.com` unreachable here). No production worker. Partial-snapshot policy, token and first live target are owner decisions. |
| **5.3 Intelligence mapping: function-level structure** | **4** | `analysis/solidity/` index and effect traces (guards, calls, reads, writes, inlined helpers and modifiers; deployed-contract dispatch since `79716bd`) | Solidity only; inline assembly not analysed; no cross-contract data flow beyond typed calls. |
| **5.3 Architecture and attack-surface intelligence** (protocol representation: components, trust boundaries, assets, integrations, external dependencies) | **1** (the legacy regex mapper is **3**, scaffolding) | Legacy `repository-mapper.ts` / `map_attack_surface`: 10 regex rules (documented as scaffolding in `research-intelligence-plan.md`). T-152 is named only. | Nothing yet produces evidence-backed architecture or attack-surface intelligence. APEX, Weirdness, the Priority Engine's per-component coverage and specialists beyond templates all depend on it. |
| **5.4 Structural smart-contract analysis** | **5** (synthetic held-out corpora) | Corpus 1 run 1: 18/18, 1 FP. Corpus 2: TP 27, FP 10, FN 10. Corpus 3: precision 0.90, recall 0.58 (all labels); 0.89/0.65 on clear labels. All sealed before scoring, recorded unedited, candidates pinned in `eval/candidates.json`. Real repository: 7 of 8 (development). | Not evaluated on real audited or exploited codebases, or against established tools (5.4B absent). Corpora are synthetic and authored by the same model family. Fixes after corpus 3 (class A, V1–V3) are **development evidence only** until corpus 4 is scored. |
| **5.4B Automated toolchain** (Foundry, Slither, Aderyn, fuzzers) | **2** | `security-tooling-assessment.md`; T-150 pass 2 shows Foundry's documented capabilities | Nothing installed; needs sandbox design, supply route and approval. |
| **5.5 Specialists: seven deterministic classes** | **5** (with 5.4) | reentrancy, access control, initializer, delegatecall, unchecked call, selfdestruct, tx.origin | Initializer, proxy and selfdestruct are weak (`analyzer-failure-classes.md`, B–H designed). |
| **5.5 Specialists: business logic, economic, oracle, upgrade, integration** | **1** | none | |
| **5.5A Weirdness Engine** | **1** | Name and intent only | No definition agreed with the owner. |
| **5.6 Execution challenge (validators)** | **4** | `simulate.ts`, `challenge.ts` for six classes. Reentrancy validator cross-checked against compiler-backed EVM ground truth (19/19 earlier specs). Corpus-3 adjudication exposed two wrong refutations, now fixed in development (V1–V3). | The validator model is bounded; cross-function payable re-entry is not modelled. Only reentrancy is cross-checked against a real EVM. |
| **5.6 Independent review** (second method or blinded reviewer, human review loop) | **2** | Schema supports blinded and disclosed reviews; independent assessor agents used ad hoc for adjudication (`eval/adjudications/`) | No operational review workflow or API (see 5.1). |
| **5.7 Dossiers** | **4** | `buildDossier`, `GET /v1/research/snapshots/:id/dossier`; reproducible dossiers on the real-repository run | No submission-ready report template; no human review recorded. |
| **5.8 Frozen benchmarks** | **4** (an instrument in active use) | Corpora 1–4 sealed with manifests; harness; baseline; candidate registry (`eval/candidates.json`, verified in a tagless fresh clone); adjudication records | Labels mostly unverified except reentrancy. **Blind rediscovery benchmark on a real reference finding (decision E): 1**, needs the owner's reference finding. Corpus 4 sealed, unscored. |
| **5.8 Measurable learning** | **1** (gated by design) | Policy recorded (T-056 preregistration) | Correctly not started: there are no confirmed outcomes to learn from. |
| **Adaptive Research Priority Engine** | **4** (fixtures and synthetic only) | T-051 scoring v1 (frozen by golden tests), T-052 coverage model, T-057 replay harness, diagnosis | The diagnosis shows design gaps in v1. No real data; must not steer anything. |
| **Live Engine Control Room** | **3** (alpha, read-only) | `apps/web` screens show stored counts and say "not built" where no backend exists; read-only research and discovery APIs | No panels for discovery health, priority, tool or agent activity, cost or reviews; no event sources. Whether the alpha is served by the live hub is recorded in hub documents, not re-verified here. |
| **5.5-APEX** | **1** for implementation (T-150 prior-art research complete) | `apex.md`; `apex-prior-art.md`, `apex-prior-art-pass2.md` | T-151 architecture not written; depends on 5.3 protocol representation (T-152) and on the T-144 memory. |
| **MD Multi-domain** | **1** (concept document) | `multi-domain-research.md` | Correctly deferred. |
| **Platform (not a research capability)** | **6** for the Release 1 foundation (as recorded) | Hub live at `hub.agentsmithdesk.xyz` since 2026-11-25; engine idle | No worker; S1 and S2 open; no CI; `main` 102 commits behind; PRs #11–#20 draft. |

## 3. Missing, skipped or incomplete foundational steps

1. **Two disconnected research pipelines** (new finding).
   - The intake chain (`worker-runtime.ts`: resolve source → identify project → locate repositories with its own GitHub API reads into
     `source_snapshots` → authorization gate → regex map → template hypotheses → checklist challenge → brief) does **not** feed the 5.1
     research store.
   - `repository_research` (acquire → analyze → challenge → dossier) does.
   - Discovery approval (5.0) queues `repository_research`, but URL intake starts the old chain.
   - A decision is needed: one workflow, with the legacy chain retired or reduced to an intake front end that hands over to acquisition.
2. **5.2 has not been verified live through its production path** (T-010, GitHub API). Only the clone path was used, in a disposable
   database.
3. **The 5.1 loop is incomplete.** No outcome, coverage, adjudication or effort records (T-144), and no human-review API. So "confirmed",
   "missed", "duplicate" and "examined vs unexplored" cannot be recorded, and learning has nothing to learn from.
4. **5.3 has no architecture or protocol representation** (T-152). Specialists, APEX, Weirdness and per-component coverage have nothing
   shared to operate on beyond function-level traces.
5. **No research run has ever executed in production.** No worker; S1 and S2 open; billing restriction as recorded.
6. **No comparison with established tools** (5.4B absent). Independent evaluation compares only with our own baseline prototype.
7. **No real-world benchmark** (decision E, blind rediscovery). All held-out evidence is on synthetic corpora.
8. **Integration and release hygiene.** Roughly 100 commits sit unmerged on a stack of draft PRs, and the canonical roadmap was last
   verified on another branch. Owner decision; nothing to do without approval.

## 4. Dependency map

```
Owner decisions ─┬─ D1-D9 ─────────────► T-041 migration DRAFT ─► (approval) ─► 5.0 opportunity model
                 ├─ T-144 design ──────► T-144 migration DRAFT ─► (approval) ─► outcome/coverage/adjudication records
                 ├─ env: api.github.com ► T-010 live 5.2 check ─► first live acquisition
                 └─ T-147 go-ahead ────► candidate 3 registered ─► corpus 4 scored once

One research workflow (T-149, design) ──► 5.1 human-review API (needs T-144, S1/T-061 caveat)
          │                                     │
          ▼                                     ▼
 5.2 live acquisition ──► 5.3 protocol representation (T-152) ──► specialists beyond templates, Weirdness definition,
                                                                   APEX T-151, per-component coverage for the Priority Engine
 5.4B toolchain sandbox (design) ─► tool evidence as independent signals and baselines
 Priority Engine: revised synthetic experiment (T-057b) ─► real data only after 5.0-5.2 operate and outcomes exist (T-144)
 MD: after an independently evaluated smart-contract engine
```

## 5. Must remain frozen or untouched
- **Frozen records:** corpora `eval/heldout`, `heldout2`, `heldout3`, `heldout4` and their manifests; raw results `eval/results/*run1*`;
  candidate commits `6cd3be7`, `9c2d80e` and `eval/candidates.json` entries; adjudication records (append-only).
- **Corpus 4:** no inspection and no tuning before its one-time scoring.
- **Priority policy v1** (golden tests) and the frozen deterministic baseline.
- **Live surfaces:** production database and migrations, the live hub, workers and schedulers (`DISCOVERY_ENABLED`,
  `STRUCTURAL_ANALYSIS_ENABLED`), PR #20 and all PRs (draft, unmerged).
- **The Hunt engine and its polling.** No Vercel.

## 6. What should not be implemented yet
- APEX (any capability).
- Weirdness Engine (no definition).
- Multi-domain packs.
- Adaptive weights or learning.
- Live prioritisation.
- External polling (Immunefi or any platform).
- New migrations, before approval.
- Toolchain installation, before a sandbox design is approved.
