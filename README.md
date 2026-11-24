# AgentSmith MultiHub

A modular, evidence-driven security research and bug-bounty operations platform.

## Product direction

MultiHub is one coordinated platform with shared state, durable records, explicit workflow ownership, and independent verification.

Initial hubs:
- Control Room — status, approvals and orchestration.
- Bug Bounty Hub — program scope, assets, findings and reports.
- Intelligence Hub — sourced research, evidence and linked knowledge.
- Automation Hub — scheduled jobs and bounded workers.
- Analytics Hub — quality, throughput and evaluation.

## Core workflow

Scout → Intake → Investigator → PoC Builder → Independent Judge → Fix Laboratory → Fork Verification → Report Writer → Learning.

## Operating principles

1. Scope and authorization are checked before active testing.
2. High-impact tests and external submissions require human approval.
3. Findings require reproducible evidence and independent review.
4. Audit events preserve who changed what, when and why.
5. Secrets and sensitive vulnerability evidence never belong in source control.
6. Learning is versioned and evaluated against frozen baselines.

## Initial milestone

Establish a deployable API scaffold, validated configuration, health checks and architecture contracts. Authentication, persistence, UI and job orchestration follow in reviewed increments.

## Deployment

Fly.io is the intended first hosting target. Keep the existing production hostname unchanged until the replacement passes acceptance checks.
