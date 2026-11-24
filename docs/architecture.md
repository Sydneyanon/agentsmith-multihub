# MultiHub Architecture Contract

## Shared operating context
The hubs are bounded modules over shared identity, assets, programs, evidence, workflow runs and audit events. They must not become independent bots with disconnected memories or competing definitions of truth.

## Initial bounded contexts
| Context | Owns | Must not own |
|---|---|---|
| Control Room | approvals, orchestration, global status | vulnerability truth |
| Bug Bounty | program scope, assets, findings, reports | independent verdicts on its own findings |
| Intelligence | sourced notes, relationships, research context | untraceable assertions |
| Automation | schedules, job leases, retries, worker health | authority to expand testing scope |
| Analytics | derived metrics and evaluation | mutation of source evidence |

## Canonical records
Define programs, immutable program-scope versions, assets, workflow runs and steps, findings, finding evidence, verification reviews, approvals, audit events, knowledge items and typed links. Evidence and decision records carry stable IDs, timestamps, provenance and version information. Corrections append superseding records rather than erase history.

## Workflow state machine
A step state is queued, running, awaiting_approval, succeeded, failed, rejected or cancelled. Transitions are validated centrally. Workers claim jobs with leases; retries are idempotent and bounded. Every execution carries a correlation ID and references the exact scope version under which it was authorized.

## Independent verification
The investigator records a hypothesis and supporting evidence. The PoC builder produces a minimal, safe reproduction where permitted. The independent judge evaluates evidence against program rules and reproduction criteria. The judge can reject or downgrade a finding without changing the investigator's original record.

## Learning loop
Learning uses reviewed outcomes, not raw model confidence. Store source observations, decision, action or non-action, expected result, actual result and reviewer verdict. Policy changes are versioned, evaluated against a frozen baseline and approved before deployment.

## Deployment shape
Start with one API process. Later split into API, scheduler and worker processes sharing packages and the database. Use database-backed leases and idempotency keys before adding distributed queues.
