# Existing Hunt Control Room Integration

> **Correction (2026-11-25):** the text below describes the dashboard as served from GitHub Pages at `sydneyanon.github.io/hunt/`. The live hostname `hunt.agentsmithdesk.xyz` was observed to be served by its own server (Caddy, address `194.195.254.216`), not by GitHub Pages; where it is hosted is unverified and the Pages URL below may be a stale or secondary address. Treat the hosting statements as unconfirmed until the owner states them. The integration principles (private source of truth, one-way sanitised projection, no changes to the Hunt site without approval) are unaffected. The Hunt site has not been touched by any of this work.

## Product continuity

The existing public dashboard is https://sydneyanon.github.io/hunt/ and its source repository is https://github.com/Sydneyanon/hunt. It is currently a static HTML dashboard with an embedded status snapshot. Its public purpose is a status-only TV/control-room view. It explicitly excludes findings, proof-of-concepts and hypotheses.

MultiHub is the intended private operating engine behind this workflow. It must extend the existing operation rather than replace its visual identity or silently redefine its stages. The public dashboard remains a separate deployment until a replacement has passed acceptance. Do not change its repository, Pages configuration, URL or DNS as part of MultiHub work.

## Existing dashboard concepts to preserve

The published page presents Scout Search across bounty/contest platforms and X; live activity cards for running, queued, waiting, stalled and completed work; a hunt progress board with gates G0-G6; a contest board with program/platform, chain or technology, reward summary, dates and links; recent operational events and limited capacity/load indicators; and a public status-only safety statement.

The visible G0-G6 labels are G0 quick-win, G1 family sweep, G2 mutation score, G3 fork run, G4 coverage, G5 independent judge and G6 chaining check.

These labels are an observed interface contract, not a complete technical specification. Before implementing gate execution, document each gate's inputs, exact pass/fail criteria, artifacts, timeouts, retry policy and owner. Never infer those details from the label alone.

## Public/private boundary

The public page is a projection, not the source of truth.

Private MultiHub records own full program scope and scope history; repository snapshots and source references; hypotheses, findings, PoCs and exploit details; raw evidence, traces, test outputs and independent review; approval records, credentials and audit detail; and model prompts, internal reasoning artifacts and sensitive operational notes.

The public projection may expose only allowlisted operational metadata: approved hunt display name; high-level state and coarse stage label; gate completion booleans or safe aggregate progress; last-updated timestamp and non-sensitive activity summary; public contest information and official links; and coarse service-health/capacity indicators where safe.

Never publish finding titles, vulnerability classes tied to an unreported issue, hypotheses, affected code paths, exploit steps, PoC output, evidence URLs, private repository names, credentials, reviewer comments or report contents. A severity count or alert is also potentially sensitive and must be explicitly approved before public exposure.

## Data flow

1. MultiHub stores canonical workflow, gate, contest and event records in the private database.
2. A dedicated projection builds a strict, versioned public status schema from an allowlist.
3. The projection validates the schema and rejects unknown fields by default.
4. Only the sanitized snapshot is published to the public status endpoint/repository.
5. The public page renders that snapshot; it cannot write back into private workflow state.

Do not let the browser read private database tables or call private workflow endpoints. Do not put database credentials, API keys or privileged tokens in GitHub Pages assets.

## Status semantics

- queued means accepted but not started.
- running means a worker currently owns a valid lease.
- waiting / awaiting_approval means blocked on a human or external dependency.
- stalled means an explicit timeout/health rule has marked progress stale; it must not be inferred merely from a quiet event stream.
- complete means all required gates for that workflow version have passed or an explicit terminal disposition has been recorded.
- failed, rejected, skipped and cancelled remain distinct states.

Every public status includes updated_at and a schema version. The UI must display stale data as stale; it must not animate an old snapshot as if work were live. Running must come from a current lease/heartbeat, not a manually set label.

## Compatibility and migration

- Preserve the existing dashboard as the first public read-only client.
- Add a versioned status projection/API before changing the static page.
- Keep the existing status.json shape compatible during an initial adapter period, or introduce an explicit schema_version and update the page in the same reviewed release.
- Keep public and private data stores logically separated; publishing is a one-way, audited export.
- No automatic public publishing until an allowlist, redaction tests and human approval policy are implemented.
- Keep the existing Hunt site live until the new projection and UI pass acceptance. No DNS or Pages changes without explicit owner approval.

## Current implementation gap

The existing dashboard repository and MultiHub API repository are separate. The current MultiHub API scaffold does not yet power the published Hunt board, does not implement G0-G6 execution, and does not have a public status projection. The dashboard's displayed operational state must not be treated as proof that the new MultiHub workers are running.
