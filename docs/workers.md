# Workflow worker

`WorkflowWorker` is the database-backed execution primitive. It is intentionally separate from task handlers: it claims and records work, but does not fetch arbitrary URLs or run security tests itself.

- Claims one eligible step in sequence order using `FOR UPDATE SKIP LOCKED`.
- Uses expiring leases so abandoned work can be reclaimed.
- Increments attempts on claim and enforces a configured retry ceiling.
- Requires the current lease owner to heartbeat or complete a step.
- Writes audit events for claims, success, and failure.
- Marks the parent run successful only after every step succeeds.

The first worker runtime should register a finite set of trusted handlers by `step_key`. Unknown steps must fail closed. Handler execution must have explicit timeouts and bounded input/output. No handler should perform active testing unless it has loaded a current verified scope and the required approval.

This module does not yet start a polling process or provide a public worker endpoint. That is deliberate: the execution policy and handler registry must be in place before unattended jobs are enabled.
