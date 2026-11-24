# Hunt Gate Execution Contract

## Existing gate vocabulary

The existing Hunt Control Room displays these gates: G0 quick-win; G1 family sweep; G2 mutation score; G3 fork run; G4 coverage; G5 independent judge; G6 chaining check.

These names are carried forward from the existing dashboard. Their exact technical pass/fail criteria, required artifacts, timeouts, retries and dependencies have not yet been fully specified in the accessible source. The platform must not invent them.

## Versioned definitions

Each executable gate requires an approved, immutable definition containing:

- Gate code and monotonically increasing definition version.
- Exact deterministic or reviewable criteria, including thresholds and comparison operators.
- Required input snapshot and evidence/artifact types.
- Allowed execution environment and safety constraints.
- Timeout, retry and terminal-state rules.
- Named approver and approval timestamp.

Unapproved or missing definitions are non-executable. A display label is not an execution specification.

## Append-only results

Each attempt creates a new result linked to a workflow run and the exact gate-definition version. Results record evaluator, status, input snapshot, structured output, artifact references, rationale and timestamps. Results are not overwritten; corrections or reruns append a new result.

Allowed result statuses: pending, running, passed, failed, inconclusive, blocked and skipped. A workflow must not be marked complete merely because a gate was skipped or because a prior version passed.

## Independent judge

G5 is displayed as independent judge in the current board. The judge must be logically separate from the investigator and must evaluate the evidence and criteria version rather than trust the investigator's conclusion. A judge cannot silently rewrite the original hypothesis or evidence.

## Current implementation status

Migration 0005 establishes storage and immutability for approved gate definitions and append-only results. It deliberately does not seed executable definitions or claim any G0-G6 gate is operational. Exact criteria must be recovered from the existing pipeline/source material and reviewed before gate workers are enabled.
