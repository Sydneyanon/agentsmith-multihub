# B4 — heldout5 (corpus 5) provenance, exposure and suitability assessment

Date: 2026-11-27. Scope: audit only. **Nothing was selected, fetched, scored or edited in `eval/heldout5/`.**

## 1. Provenance
- Committed once: `837aeb9` (2026-11-26, T-180). Contents: `BRIEF.md`, `PROCESS.md`, `schema/selection.schema.json`,
  `schema/ground-truth.schema.json`, `tools/validate.ts` (+ tests).
- Brief approved by the owner 2026-11-26 (PROCESS step 1).
- Validator re-checked today: `eval/heldout5/tools/validate.test.ts` 3/3 pass; it prints only counts and error positions, never
  repository, path, class, URL or note content (verified by reading its single output statement).

## 2. State and gates
| PROCESS step | status |
|---|---|
| 1 brief + schemas + validator | done |
| 2 owner starts an independent selector | **not started — gate A22 not given** |
| 3–4 selection + ground truth handed back, validated, sealed | not started |
| 5 read-only acquisition via `GitHubSource` | not started — A22 (network reads) |
| 6–7 register candidates, score once | not started — **gate A23 not given** |
| 8–9 blind review of unmatched leads, report | not started |

There are no entries, no ground truth and no `CHRONOLOGY.md`. **There is therefore no real-CVE layer yet**; B4 cannot produce a
measurement until A22 and A23 are given.

## 3. Exposure history
Clean, because nothing exists to expose. No capability has seen any corpus-5 code or answer. `eval/exposure.json` correctly has no
corpus-5 entry (a capability with no entry is not scored).

## 4. Independence: who may select
PROCESS requires the selector to be "an independent agent with no access to the analyzer repository, or the owner", and the brief
forbids it to read the analyzer's code, results or corpora 1–4.
- **This session is disqualified**: it has read the analyzer, corpora 1–4 and every result. If it selected entries, corpus 5 would
  stop being held out before it existed.
- **A sub-agent started from this session is also disqualified**: it runs in this container with full repository access.
- The selector must run **outside this repository**, started by the owner with only `BRIEF.md` and `schema/` (e.g. a fresh
  conversation or a cloud session with no repository attached). Its hand-back is committed unopened (step 4).

## 5. Training-data exposure (model-based capabilities)
- The brief's blinding rule prefers reports published **after 2026-06-30** and flags earlier ones `prior_knowledge_risk: true`.
- That date was set against an earlier model. Every model-based capability scored on corpus 5 (adjudicator, attended
  specialists, any future APEX/Weirdness) needs its own knowledge cutoff recorded per score row; a report on or before a model's
  cutoff is not blind for that model even if it is after 2026-06-30. The deterministic analyzer is unaffected.
- Public CVE/contest write-ups from before a model's cutoff must be assumed to be in its training data. This is why existing
  public "vulnerable contract" collections cannot serve as held-out data for model-based capabilities.

## 6. What the analyzer side may see (answer-key leakage)
- `selection.json` is analyzer-visible and contains `kind` (`vulnerable` / `post_fix_control` / `clean_control`) and
  `control_of`. **These reveal which entries are vulnerable.** The deterministic analyzer never reads them; a model-based
  capability must receive **only the sealed snapshot code** of an entry, never `selection.json` fields beyond what acquisition
  needs. The B3 runner's model-facing view (`eval/bench/model-view.ts`) is the place to enforce this when corpus 5 is scored.
- Real repositories can carry their own leaks: committed audit reports (`audits/`, `docs/`), `@audit` comments, or fix history.
  Acquisition must be the vulnerable commit's tree only (the sealed-snapshot path already excludes git history), and model-facing
  runs should exclude audit/report paths and strip comments as benchmark-b does.
- The model must have no web access during scoring: a repository name plus commit is enough to look up its public report.

## 7. Suitability for the semantic benchmark
- Strong fit: the brief requires **at least 8 entries whose findings are only in classes the engine does not claim** (oracle,
  accounting, business logic, signature replay, DoS…), plus post-fix and clean controls. That is the real-code counterpart of
  benchmark-b's eight synthetic classes.
- Class vocabulary: `ground-truth.schema.json` allows the seven claimed classes or `other:<description>`. To make corpus-5 results
  comparable with benchmark-b, the selector could use `other:<benchmark-b class>` (e.g. `other:oracle-manipulation`). This changes
  the selector's instructions, so it is a **proposed addendum for owner approval**, not applied.
- Confirmed vs disputed: the schema requires High/Medium severity (or exploit) and a `fix_commit`, but has **no field separating
  confirmed findings from sponsor-disputed or acknowledged-unfixed ones**. The mission requires that separation. Proposed (needs
  owner approval, plus a validator update): a required `confirmation` field — `fix_merged | exploit_observed | judge_confirmed |
  disputed` — with disputed findings scored separately and never counted as misses.

## 8. Other real-world material in the repository
`cases/alchemix-v3-001`, `eval/production-cycle-1`, `eval/real-runs/not-so-smart-contracts`: all worked on by this project's
sessions (development data); the brief also excludes `not-so-smart-contracts` explicitly. Useful as real-code development checks,
**not** as held-out measurement.

## 9. Decisions needed from the owner
1. **A22**: start an independent selector outside this repository (only `BRIEF.md` + `schema/`).
2. Before starting it (its instructions freeze when it starts): approve or reject the two addenda in section 7.
3. **A23**: later, registration and one-time scoring.

Until then the honest B4 status is: **protocol audited and ready; no real-world measurement exists; no general detection claim can
be made from the synthetic benchmark.**
