# Security, Scope and Approval Rules

These rules are platform invariants.

## Authorization gate
Before any active test, resolve a current, versioned authorization record containing program identity and source URL; explicitly in-scope assets and exclusions; allowed and prohibited test classes; rate limits and operational constraints; authorization start and end times; and source snapshot and last-verified timestamp.

Missing, expired, ambiguous or conflicting scope means **do not run**.

## Action classes
1. Passive research: public documentation, source review and non-invasive metadata collection.
2. Low-impact validation: narrowly scoped checks explicitly permitted by the program.
3. State-changing or high-impact testing: explicit human approval and a documented rollback or containment plan required.
4. External actions: report submission, account interaction, production changes or disclosure require explicit human approval.

Never infer permission from asset ownership, a domain name, a prior run or a successful test.

## Evidence
A finding cannot be marked verified without reproducible evidence and independent review. Store sensitive evidence with access controls and retention rules. Redact credentials, session tokens and unrelated personal data from logs and reports.

## Stop conditions
Stop and escalate on scope uncertainty, unexpected data access, service instability, rate-limit violations, suspected real-user impact or any indication that testing affects systems beyond the authorized target.

## Secrets
- No credentials in Git, issues, logs, screenshots or finding evidence.
- Use Fly secrets or another secret manager at runtime.
- Prefer short-lived, app-scoped deployment credentials.
- Rotate any credential that may have been exposed.


## API access control

All current `/v1/*` routes are protected by a configured bearer token. Set `API_BEARER_TOKEN` to a randomly generated secret of at least 32 characters in the deployment secret store; never place it in source control or public status output. If the token is not configured, the API returns `503 api_auth_not_configured` for versioned routes. Missing or invalid credentials receive `401 unauthorized`. Health endpoints remain available for platform health checks and disclose no research data.

This is a single-operator bootstrap control, not a complete multi-user identity or role system. Before exposing the API to multiple users, add managed identity, per-user authorization, session/token rotation, rate limiting and audit attribution.
