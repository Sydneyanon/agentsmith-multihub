# API

The API is intentionally small at this stage. All operational endpoints require a configured PostgreSQL database.

## Health

- `GET /health/live`: process liveness only.
- `GET /health/ready`: database readiness.

## Research intake

`POST /v1/intake` accepts a user-supplied project URL or research idea.

Example:

```json
{
  "kind": "url",
  "value": "https://github.com/example/project",
  "source": "user",
  "notes": "Investigate the authorization boundary around withdrawals."
}
```

Allowed sources: `user`, `x`, `github`, `website`, `other`.

The endpoint validates and stores the intake, creates a workflow run and ordered workflow steps, and writes an audit event in one database transaction. It returns HTTP 202 with the workflow ID.

**Safety boundary:** intake is passive. It does not fetch arbitrary URLs, clone repositories, scan hosts, execute proof-of-concept code, or submit reports. URL resolution and repository access will be implemented as separately controlled workers. Active testing requires a current, verified program scope and allowed techniques.

## Workflow tracking

- `GET /v1/workflows?limit=25&status=queued`: recent workflow runs.
- `GET /v1/workflows/:id`: workflow details and ordered step states.

The current implementation creates queued workflow records. A worker/claim loop is a later milestone; queued does not mean the investigation has already run.
