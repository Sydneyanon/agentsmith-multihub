# Autonomous loop — status and audit (Priorities 2, 3, 5)

Baseline: HEAD after the repository monitor + coverage metrics. This records what was audited and what was done, honestly separating
implemented/tested from audited-only.

## Priority 1 — Repository monitor (DONE, tested end to end)
See `docs/discovery-to-research-bridge.md`. The full cycle (discover → map → research → new commit → incremental rescan) is exercised
in `repo-monitor.integration.test.ts`. Not scheduled in production.

## Priority 2 — Programme → repository mapping (partially done)
- **Implemented**: `resolveProgrammeRepositories` turns a programme's resolved record (officialUrl + otherUrls) into GitHub `owner/name`
  targets, from source-tracked fields only — it never invents an association. `researchCandidates` / `GET /v1/bounties/candidates` now
  return `repositories` and `has_repository`, so an engine-suitable programme with **no** resolved repository is a visible **mapping
  gap**. `coverageMetrics` reports `with_repositories` vs `eligible`. Tested (`candidate-mapping.integration.test.ts`).
- **Gap (documented, not built)**: automatic enrichment that fetches a platform programme page to extract its in-scope repositories.
  The richest source of repos is the platform page itself (e.g. Immunefi's in-scope asset URLs), but Immunefi is disabled pending
  Terms, and Sherlock/HackenProof direct collection is gated behind the owner's enable + a deploy. So enrichment today is limited to
  what the community board already carries. When a source is enabled, its adapter already extracts asset/repository URLs into
  `otherUrls`, which `resolveProgrammeRepositories` then maps — no new code needed, only the enable. Verified vs inferred provenance is
  preserved by the per-field `source` on every resolved field.

## Priority 3 — Autonomous source coverage (audited; no code gap, enable is a deploy decision)
- **community-board**: enabled, live, hourly — covers all four platforms as community reports (keeps Cantina covered).
- **sherlock**: adapter built + tested; robots allow; **authorised**; disabled in the registry — enabling is one call after a deploy.
- **hackenproof**: adapter built + tested; **authorised for internal collection**; public-display guard already in place
  (`RESTRICTED_PUBLIC_SOURCES`); disabled — enabling is one call after a deploy.
- **immunefi**: adapter built + tested; **disabled pending written Terms approval** (unchanged). Full reconciliation in
  `docs/immunefi-reconciliation.md`.
- **cantina**: no permitted automated method; stays community-board only.
- The collector already does incremental updates, new/changed/delisted detection, dedup (`upsertObservation` → `recomputeProgram` →
  `markDelisted`), provenance, per-source last-success/error, retry, rate-limit and backoff. The bounty integration test exercises
  Sherlock + HackenProof collection with the sources enabled. **Finding: approved sources auto-collect the moment they are enabled;
  there is no collection-code gap, and no source-specific guard or eligibility rule was weakened.**

## Priority 5 — Hunting engine (audited; no change made this pass)
- **First pass**: a pinned deterministic stack runs before any model — the Solidity structural analyzer (`analysis/solidity/`:
  lexer/parser/pipeline/protocol-model/authority/challenge), Slither 0.11.3 and Foundry 1.5.1 (version-pinned wrappers). Deterministic
  checks gate expensive model calls.
- **Deep research**: hypothesis generation, independent challenge, and blinded review, with immutable evidence spans; a confirmed
  finding requires independent evidence **and** a human adjudication (strict, and confirmed findings remain 0 by design).
- **Budget**: every model call goes through `AiBudgetGateway.execute` ($25/mo global/daily/per-workflow/per-tier caps).
- **Finding**: the engine's structure is sound and well-guarded. Improving detector coverage / false-positive rate is high-value but
  needs the engine actually running on real targets to measure against — which is gated behind worker activation. Making changes to
  detectors now, blind, would risk the frozen baselines. **Recommended: activate the worker on a controlled target first, measure, then
  improve detectors against real output.** No detector changes were made this pass (rule 9: document rather than rewrite what works).

## The remaining gate to the milestone
The milestone — a demonstrated *live* cycle with no human step — now needs only operational decisions, not more code: deploy
(0012+0013), enable Sherlock/HackenProof, activate the worker, and schedule the collector→bridge→monitor passes. The code path is built
and exercised in integration tests end to end.
