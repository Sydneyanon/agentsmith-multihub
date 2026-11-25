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

## Current implementation status

The API, database schema/migration runner, budget gateway, workflow queue and separate intake worker are scaffolded. The passive intake path currently supports deterministic source normalization, public GitHub metadata capture, bounded source sampling, an explicit authorization gate, deterministic attack-surface leads and structured unverified research hypotheses. Captured evidence is stored as immutable, SHA-256-addressed source snapshots.

The current worker does not execute repository code, install dependencies, run tests, scan hosts, perform transactions or submit reports. Active testing remains blocked until a current verified program scope and explicit approval are available. Pattern matches and generated hypotheses are not verified vulnerabilities.

All `/v1/*` API routes require a configured bearer token. Set `API_BEARER_TOKEN` to a randomly generated secret of at least 32 characters before using the API. Never commit the secret. The public status projection and existing Hunt dashboard remain separate and unchanged.

The workflow is intentionally incomplete after hypothesis generation: independent challenge, report preparation, learning and UI integration remain to be implemented. CI currently reports failures before exposing any job steps or downloadable logs (the workflow `ci.yml` exists, but no independent CI result has been obtained; the Actions billing block is the recorded cause), so build and test success has not yet been independently confirmed.

## Deployment

Fly.io is the intended first hosting target. Keep the existing production hostname unchanged until the replacement passes acceptance checks.
