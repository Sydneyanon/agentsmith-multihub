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

## Opportunity discovery (Phase 5.0)
Discovery runs **before** repository scanning. Every source (Immunefi, Code4rena, Sherlock, official GitHub organisations, later Cantina, HackenProof and project pages, plus operator-pasted URLs including X posts) is a separate adapter feeding **one** opportunity model with provenance, change history and cross-source identity; a source never becomes its own research system. An opportunity is selected by a human, acquired through the pipeline below, then researched. Source access is limited to what each platform's official terms permit and is recorded per source; where it is unresolved (Immunefi) the source stays permanent but unpolled and the manual-import route applies. See `docs/ROADMAP.md` (decision H) and `docs/immunefi-scout.md`. The current approval record is not tamper-proof against a compromised runtime database role (ROADMAP section 5).

## Evidence acquisition
Repository content enters the system only through acquisition (`docs/repository-acquisition.md`): one repository at one resolved commit SHA becomes one sealed snapshot in the research state (`repo_snapshots`, `repo_snapshot_files`, content-addressed `research_blobs`). Acquisition is passive reading of a public repository: it executes, installs, builds and follows nothing, treats every byte as hostile, verifies the archive against the commit's own git tree (object ids, sizes, completeness, commit identity), accounts for every entry (stored, or skipped with an explicit reason), writes nothing until the whole archive is verified, and is idempotent and resumable. There is one snapshot model; later stages (discovery, structural analysis, specialists, challenge, dossier) read sealed snapshots and cite them by span.

## Learning loop
Learning uses reviewed outcomes, not raw model confidence. Store source observations, decision, action or non-action, expected result, actual result and reviewer verdict. Policy changes are versioned, evaluated against a frozen baseline and approved before deployment.

## Deployment shape
Start with one API process. Later split into API, scheduler and worker processes sharing packages and the database. Use database-backed leases and idempotency keys before adding distributed queues.
