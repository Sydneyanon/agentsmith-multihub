# Authorization gate

Active testing is denied unless all of the following are true at the moment the test is about to run:

1. The program is active.
2. The exact scope version is verified.
3. The scope version is currently within its validity window.
4. The exact asset is explicitly marked `in_scope` under that scope version.
5. A non-expired approval exists for `active_testing` on that exact asset, and the approver identity matches the caller-supplied approval identity.

The guard is deliberately fail-closed. Missing rows, stale scope, expired approval, unknown asset, or database errors must stop execution. A URL submitted to intake is never authorization. A repository being public is never authorization.

The guard must be called immediately before each active test, including retries. It is not a one-time workflow-start check. Passive source inspection and public documentation research remain separate from active testing.
