# Held-out corpus: FROZEN

Authored by a separate agent that was forbidden to read any analyzer code and had no knowledge of it. Frozen on 2026-11-26 **before** the structural analyzer was written. The analyzer author does not read these files or labels while developing; the corpus is scored once per milestone by `eval/run-eval.ts`, and results are reported as they come, failures included.

Rules: no tuning of rules against these files. If any file or label is changed, regenerate `MANIFEST.sha256` and say so in the results (the corpus is then no longer held out). Labels were checked by their author; the author flagged several as uncertain (see the evaluation report). The labels have NOT been independently verified by compilation or execution (no compiler is installed).
