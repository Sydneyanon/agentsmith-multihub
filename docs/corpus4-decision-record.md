# Corpus 4: decision and execution record (facts only; the A2 approval status is UNRESOLVED pending the owner's clarification)

This record states what happened, in order, with exact commits and times (UTC, from git). It changes no approval history, no frozen
record and no result. Corpus 4 is not scored again and nothing is tuned against it.

## Chronology
| # | Time (UTC, 2026-11-26) | Event | Evidence |
|---|---|---|---|
| 1 | 14:27:35 | Corpus 4 sealed: authored by a separate agent with no exposure to the analyzer; 59 contracts, 79 labels (12 ambiguous); manifest `9627b82a…`; **not inspected, not scored** | commit `b9df4e5`; `eval/heldout4/FROZEN.md`; `eval/heldout4/MANIFEST.sha256` |
| 2 | before 15:37 | **Approval screen.** I asked which of four gated items to record as approved. The response text returned by the screen began: *"1. A2 — APPROVED: Freeze and register candidate 3, then score candidate 3, candidate 2 and the baseline once each against corpus 4, following the checklist. No tuning or changes based on corpus-4 results."* The same response approved P1 only, kept D1–D9 and T-149 S2 unapproved, and asked for the register to reflect the distinctions. | session transcript (owner's answer to the approval question) |
| 3 | 15:37:32 | That response recorded in the decision log and register as "A2 APPROVED" | commit `48d9a38` |
| 4 | 15:37:46 | **Candidate 3 frozen and registered before scoring:** commit `48d9a38` (analyzer and harness byte-identical to `79716bd`), registry entry with `frozenBefore: eval/heldout4`, local tag; pushed and confirmed on the remote | commit `aa6119d`; `eval/candidates.json` |
| 5 | 15:38 | **Scored once each**, in clean worktrees at the registered commits: candidate 3, candidate 2 (`9c2d80e`), baseline. Corpus manifest verified unchanged afterwards | `eval/results/heldout4-run1-*` |
| 6 | 15:38:46 | Raw results recorded unedited; hashes in the registry; corpus marked scored | commit `f0ef971`; `eval/results/README.md` |
| 7 | later | The owner's next message listed A2 among decisions to keep "separate and pending". I recorded the discrepancy without changing either record | decision log, row of the P1 revision (`1af6870`) |
| 8 | later | The owner said they will clarify whether A2 was explicitly selected on the approval screen, and asked that its status stay **unresolved** until then | this record |

## Facts that do not depend on the clarification
- Corpus 4 was sealed (1) before candidate 3 was registered (4), and candidate 3 was registered and pushed (4) before any scoring (5).
- Each analyzer was scored exactly once. Raw outputs are unedited, and their hashes are in `eval/candidates.json`.
- No analyzer change was made in response to corpus 4. Its results are used for nothing further. The only post-score reading was the
  failure description already recorded in `eval/results/README.md`.
- Scoring cannot be undone. If the owner concludes that A2 was not given, the results remain as a recorded fact with this note, and the
  next held-out claim uses corpus 5.

## Status
**A2: UNRESOLVED.** The execution facts above stand regardless.
