# Live operations dashboard: specification (2026-11-28; to be BUILT after D's fixes land)

Owner requirement: progress bars and percentages for the whole research process, from real records only. Every number on the page
names its numerator and denominator. Where no denominator is measurable, the page says "not measurable" and shows a count, never
an invented percentage.

## 0. Four kinds of number, kept visually separate
| kind | meaning | example | display |
|---|---|---|---|
| **Processing** | how much of the planned work has been done | 3 of 5 stages finished; 412 of 431 files stored | progress bar plus % |
| **Coverage** | how much of what *should* be examined was examined, by what method | 18 of 20 in-scope files parsed; 6 of 13 lead classes have an independent validator | bar plus %, labelled "coverage" |
| **Confidence** | how strongly the evidence supports each lead | per-lead assessment: refuted / weakened / open / supported cross-family | distribution, **never a single %** |
| **Outcome** | what research found | 0 confirmed, 2 open, 1 refuted | counts only |

A finished stage shows **"processed"**, never "understood". The coverage and confidence panels sit next to it, so a 100% processing bar
is always seen beside what was not covered.

## 1. The gap that must be closed first: progress *within* a stage
- **Today:** a step is `queued`, `running` (with a live lease) or `succeeded`/`failed`. Counts become known only when the step completes
  (its `output`). Acquisition already emits progress internally (`acquire.ts` `progress("planned", …)` and others), but it is not stored.
- **Proposal:** an append-only progress record per step.
  - **Format:** `{step_id, phase, done, total, unit, at}`, written at most every N seconds and at each phase change.
  - **Where:** as `audit_events` with action `workflow_step.progress` (no migration), or a small append-only table in the D
    release's migration.
  - **Under D:** the worker reports progress through one new allow-listed, quota-limited operation. The dashboard labels these
    numbers **"reported by the worker"**, distinct from the counts the API derives itself (D3), which are shown as **"verified"**.
  - **Fallback:** until this exists, a running stage shows "running since …, progress not measurable" plus its live lease.

## 2. The ten panels: numerator / denominator, source, and what is not measurable
| # | panel | processing (num / denom) | coverage | sources | not measurable / caveats |
|---|---|---|---|---|---|
| 1 | **Overall run** | stages succeeded / stages in the run (4, or 5 with Slither) | — | `workflow_steps` | stages are not equal in cost, so the bar counts stages and does not estimate time; elapsed time per stage is shown |
| 2 | **Programme discovery** | sources checked in the latest collection / sources enabled | eligible / programmes collected (an outcome ratio, labelled as such) | `bounty_collection_runs`, `bounty_source_checks`, `bounty_programs` | failed sources (HackenProof) shown as errors with their code and the next due time |
| 3 | **Repository acquisition and verification** | during: files stored / files planned (progress record `planned` then `stored`). After: from the step output and `repo_snapshot_files` | D2: files verified against the GitHub tree / files in the manifest | step output, snapshot tables, D2 evidence | before `planned` the total is unknown, so the bar shows "resolving commit" |
| 4 | **Scope verification** | in-scope paths found in the snapshot / in-scope paths in the official scope (20 for USX) | leads in scope / all leads | `workflow_runs.input.bounty_scope`, `repo_snapshot_files`, dossier `bounty_scope` | an in-scope path missing from the snapshot is shown as a **blocker** |
| 5 | **Protocol analysis** | Solidity files parsed / Solidity files in the snapshot; contracts and functions modelled | in-scope files parsed / in-scope Solidity files; unresolved calls (e.g. into submodules) counted | `analyze_structure` output (API-verified under D3), the protocol model | "parsed" is not "understood"; unresolved external calls are shown next to the bar |
| 6 | **APEX exploration** | runs WITHOUT a shadow step: **experimental, not enabled for this run**; the approved shadow run: coverage num/denom (contracts, in-scope files, entry points, statements, guard sides, dropped frontier states), abstentions by feature with file:line, suppressions, candidates accepted and rejected, cost, provenance | the same ratios, labelled | `workflow_steps` apex_shadow, `audit_events` apex_shadow.reported | every number is labelled "APEX shadow: unvalidated, not evidence" and worker-reported; nothing of it is counted in panels 8-10, confidence or outcome (§11.3 of apex-first-capability.md) |
| 7 | **Specialist and tool execution** | per capability: completed / abstained / unavailable, with the reason | lead classes examined / classes declared | step outputs, dossier `coverage.external_tools`, capability availability | Slither in production shows **unavailable (no binary)**, not 0% |
| 8 | **Independent validation** | hypotheses with an API-recorded evaluation / hypotheses stored | hypotheses whose class has an independent validator / hypotheses | `hypothesis_evaluations`, `hypothesis_independence` (0016) | "no-independent-validator" is shown as **not validated**, never as done |
| 9 | **Reproduction** | reproductions recorded / hypotheses eligible for reproduction | — | evaluations by `evm-execution`-family evaluators | production: **unavailable (Foundry not installed)**, shown as unavailable, not 0% |
| 10 | **Evidence and dossier** | dossier built (0/1), plus cited spans re-verified / cited spans | — | `build_dossier` output, `evidence_spans` verification | the dossier's own coverage status (complete / partial / not analysable) is shown beside it |

**Confidence panel:** the per-lead assessment distribution from the dossier, with same-family corroboration and cross-family
support shown separately.

**Outcome panel:** confirmed / open / refuted / weakened counts. "0 confirmed" is displayed plainly. "No leads" says that it is not
evidence of absence.

**Errors, retries and blockers, per panel:**
- failed steps and their error codes;
- attempt counts above 1;
- expired leases;
- abstention codes;
- quota refusals and audit `worker_api.refused` counts.

## 3. Live activity timeline (expandable)
A merged, time-ordered stream of **existing** records:
- `audit_events`: step claimed, succeeded and failed; `worker_api.*` accepted, refused and replayed; run created;
- `hypothesis_events`: registered, evaluation recorded, review recorded;
- the new step progress records.

Each row can be expanded to show its stored payload: operation, step, hypothesis, evaluator and family, outcome, and error. Decisions
(engine loop) appear only when 0010 exists. Until then the timeline says so instead of showing nothing.

## 4. System view: component states from evidence
| state | rule (all evidence-based) |
|---|---|
| **operational** | used successfully in production, with a recorded event (e.g. the collector's last successful run; GitHub's live check) |
| **available** | deployed and assignable, but not yet used in production (e.g. the structural analyzer before the first run) |
| **experimental** | in code, off by default (APEX, the Slither stage) |
| **unavailable** | the capability probe fails in this environment (no binary, no migration), with the probe's reason |
| **blocked** | a recorded blocker, e.g. HackenProof's last failure code, or a missing secret |

These come from engine status, the capability registry's environment availability (the planned registry increment) and the
recorded events. **No hardcoded green.**

## 5. Build and verification plan (after D lands)
1. **Read-only aggregation endpoint** `/v1/research/runs/:id/progress`, computed only from the tables above. Each metric is returned as
   `{numerator, denominator, unit, kind, source, measurable}`. A `null` denominator means "not measurable".
2. **The step progress record** (§1), written through D's interface.
3. **The Control Room view:** ten panels, the confidence and outcome panels, the timeline, the system view, and the existing live
   refresh with its "stale since" honesty.
4. **Tests:**
   - each metric's numerator and denominator against a seeded database;
   - an unmeasurable stage shows no percentage;
   - a 100% processing bar never shows "understood".
5. **Local rehearsal:** the targeted USX-like fixture, a real API process and the worker in remote mode, with the hub in a browser.
   Screenshots at each stage, taken from real records. **No production deployment** without approval.
