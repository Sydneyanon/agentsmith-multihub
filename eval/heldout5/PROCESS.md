# Corpus 5: process and chronology rules

Roles:
- **Selector**: an independent agent with no access to the analyzer repository, or the owner.
- **Operator**: this repository's maintainer, the analyzer side.
- **Reviewer**: someone who is not the analyzer's author, for new leads.

Every step is recorded with a timestamp in `CHRONOLOGY.md` (created at step 2).

| Step | Who | What | Gate |
|---|---|---|---|
| 1 | operator | This brief, the schemas and the validator are committed (T-180) | owner approval of the brief (given 2026-11-26) |
| 2 | owner | Starts the selector with only `BRIEF.md` and `schema/` | **A22** |
| 3 | selector | Returns `selection.json`, `ground-truth.json` and `SELECTION-NOTES.md` | — |
| 4 | operator | Runs `tools/validate.ts`, which prints counts and schema errors only and never ground-truth content. Commits all three files unopened, plus `MANIFEST.sha256` of them | — |
| 5 | operator | Acquires each `selection.json` entry read-only through the 5.2 path (`GitHubSource`), records each snapshot's manifest hash, and seals with `FROZEN.md` and a manifest of selection, ground truth and snapshot manifests | A22 (network reads) |
| 6 | operator | Registers candidates in `eval/candidates.json` **before** any analysis of corpus 5: candidate 3 (pre-P1 baseline), the current P3 candidate, and the baseline prototype | **A23** |
| 7 | operator | Scores each registered candidate **once**, in clean worktrees, in the registered order; stores raw results unmodified | A23 |
| 8 | reviewer | Reviews every lead not matched to ground truth, blind to analyzer confidence. Offline EVM evidence where possible. Writes adjudication records | reviewer named by the owner |
| 9 | operator | Report (T-184) | — |

Rules:
- The operator never opens `ground-truth.json` before step 7 has stored all results.
- After step 7, corpus 5 is **development data**, like corpora 1–4. It is never re-scored as a held-out measurement and never used to
  tune a candidate before its own registered scoring.
- Nothing about corpus 4 changes: it stays spent, unread and unused.
- No contact with projects or platforms, and no disclosure or submission, without separate owner approval.
