# A7: restricted worker role, exact grant plan

**Status:** plan only. Nothing has been granted. The production dry run on 2026-11-27 was refused by Fly with "MPG system roles cannot be modified" during the revocation block, before any GRANT ran. No further production diagnostics will run without owner approval.

Generated from `db/runtime-grants.json` and `scripts/apply-runtime-grants.ts`. It runs as the database owner, in **one transaction**: any failure rolls back everything. The role is `agentsmith_worker`, which Fly created with role `reader` (that role inherits `pg_read_all_data`: SELECT only).

## 1. Exact SQL (statement order as the script issues it)
```sql
BEGIN;
-- (a) start from nothing: drop every direct privilege the role holds
REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM "agentsmith_worker";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM "agentsmith_worker";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "public" FROM "agentsmith_worker";
REVOKE ALL ON SCHEMA "public" FROM "agentsmith_worker";
-- (b) close default authority that PUBLIC (every role) would otherwise have
REVOKE CREATE ON SCHEMA "public" FROM PUBLIC;
-- for each application table, view and sequence (extension objects excluded):  REVOKE ALL ON TABLE "public".<name> FROM PUBLIC;
-- for each application function (extension functions excluded):              REVOKE ALL ON FUNCTION <signature> FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE <current_database> FROM PUBLIC;
REVOKE TEMPORARY, CREATE ON DATABASE <current_database> FROM "agentsmith_worker";
-- (c) membership check: the role's only membership (reader) must be read-only, verified inside the transaction
-- (d) the grants
GRANT USAGE ON SCHEMA "public" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."ai_model_prices" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."approvals" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."assets" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."budget_policies" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."finding_evidence" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."findings" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."hunt_gate_definitions" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."hunt_gate_results" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."hypothesis_status" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."knowledge_items" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."knowledge_links" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."program_assets" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."program_scope_versions" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."programs" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."research_blob_evictions" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."research_storage_stats" TO "agentsmith_worker";
GRANT SELECT ON TABLE "public"."verification_reviews" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."audit_events" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."bounty_program_changes" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."bounty_research_links" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."evaluation_evidence" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."evidence_spans" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."hypothesis_evaluations" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."hypothesis_events" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."hypothesis_evidence" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."hypothesis_reviews" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."model_usage_events" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."repo_snapshot_files" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."repository_monitor_checks" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."research_blobs" TO "agentsmith_worker";
GRANT SELECT, INSERT ON TABLE "public"."source_snapshots" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."ai_budget_reservations" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bounty_collection_runs" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bounty_duplicate_candidates" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bounty_imports" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bounty_observations" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bounty_programs" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bounty_repository_mappings" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bounty_scores" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."bounty_source_checks" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."hypotheses" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."repo_snapshots" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."repository_monitors" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."workflow_runs" TO "agentsmith_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."workflow_steps" TO "agentsmith_worker";
GRANT SELECT, UPDATE ON TABLE "public"."bounty_sources" TO "agentsmith_worker";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "agentsmith_worker";
GRANT EXECUTE ON FUNCTION public.verify_repo_snapshot(uuid) TO "agentsmith_worker";
GRANT EXECUTE ON FUNCTION public.verify_evidence_span(uuid) TO "agentsmith_worker";
GRANT EXECUTE ON FUNCTION public.repo_snapshot_manifest(uuid) TO "agentsmith_worker";
GRANT EXECUTE ON FUNCTION public.research_span_check(text, integer, integer, text) TO "agentsmith_worker";
GRANT EXECUTE ON FUNCTION public.research_split_lines(text) TO "agentsmith_worker";
GRANT EXECUTE ON FUNCTION public.research_reviewer_saw_valid(jsonb) TO "agentsmith_worker";
-- (e) pin search_path on every application function (defence against temp-schema shadowing)
-- for each application function:  ALTER FUNCTION <signature> SET search_path = "public", pg_temp;
COMMIT;
```

## 2. Table-by-table manifest (production tables only)

Not granted, because these tables don't exist in production (0008 is deliberately not applied): `bounty_opportunities`, `discovery_observations`, `discovery_sources`, `opportunity_events`.

| access | tables |
|---|---|
| SELECT (17) | `ai_model_prices`, `approvals`, `assets`, `budget_policies`, `finding_evidence`, `findings`, `hunt_gate_definitions`, `hunt_gate_results`, `hypothesis_status`, `knowledge_items`, `knowledge_links`, `program_assets`, `program_scope_versions`, `programs`, `research_blob_evictions`, `research_storage_stats`, `verification_reviews` |
| SELECT, INSERT (14) | `audit_events`, `bounty_program_changes`, `bounty_research_links`, `evaluation_evidence`, `evidence_spans`, `hypothesis_evaluations`, `hypothesis_events`, `hypothesis_evidence`, `hypothesis_reviews`, `model_usage_events`, `repo_snapshot_files`, `repository_monitor_checks`, `research_blobs`, `source_snapshots` |
| SELECT, INSERT, UPDATE (14) | `ai_budget_reservations`, `bounty_collection_runs`, `bounty_duplicate_candidates`, `bounty_imports`, `bounty_observations`, `bounty_programs`, `bounty_repository_mappings`, `bounty_scores`, `bounty_source_checks`, `hypotheses`, `repo_snapshots`, `repository_monitors`, `workflow_runs`, `workflow_steps` |
| SELECT, UPDATE (1) | `bounty_sources` |
| none | `schema_migrations` (the reader membership still allows SELECT) |

Through the Fly `reader` membership the role can also **read** every table (`pg_read_all_data`). It cannot write through it.

Notes from the manifest:
- **hypotheses UPDATE:** Row-lock only. hypothesis_evidence_guard() runs SELECT ... FOR UPDATE on hypotheses as the invoking role, which needs UPDATE. Any actual UPDATE is rejected by the hypotheses_immutable trigger, which the runtime role cannot disable (it owns nothing and has no TRIGGER privilege).
- **bounty_* (0011):** Bounty collection: no DELETE anywhere (delisted listings are marked, merged programmes keep their row); program changes are append-only; sources are seeded by the migration and only their state columns are updated.

## 3. Function permissions (exactly six EXECUTE grants; everything else is revoked from PUBLIC)

| function | purpose |
|---|---|
| `verify_repo_snapshot(uuid)` | re-verify a sealed snapshot (manifest and every blob) |
| `verify_evidence_span(uuid)` | re-verify one cited evidence span against its blob |
| `repo_snapshot_manifest(uuid)` | compute a snapshot's manifest hash, file count and bytes |
| `research_span_check(text, integer, integer, text)` | check that a span's lines and excerpt hash match the blob |
| `research_split_lines(text)` | line splitting used by the span checks |
| `research_reviewer_saw_valid(jsonb)` | validate a review's 'reviewer saw' record |
| **denied:** `evict_research_blob(text, text, text)` | deleting stored research content stays an owner action |

## 4. Verification query (run as the owner after the grants; read-only)
```sql
-- (1) attributes: all must be false
SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'agentsmith_worker';
-- (2) every table privilege the role effectively holds (direct, PUBLIC or via membership); compare with section 2
SELECT c.relname, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
  unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) AS p(priv)
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND has_table_privilege('agentsmith_worker', c.oid, p.priv)
   AND p.priv <> 'SELECT' ORDER BY 1, 2;
-- (3) forbidden: each count must be 0
SELECT p.priv, count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
  unnest(ARRAY['DELETE','TRUNCATE','TRIGGER','REFERENCES']) AS p(priv)
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND has_table_privilege('agentsmith_worker', c.oid, p.priv) GROUP BY 1;
SELECT count(*) AS owned FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = 'agentsmith_worker';
SELECT has_schema_privilege('agentsmith_worker', 'public', 'CREATE') AS can_create_in_schema,
       has_database_privilege('agentsmith_worker', current_database(), 'CREATE') AS can_create_schema,
       has_database_privilege('agentsmith_worker', current_database(), 'TEMP') AS can_use_temp;
-- (4) functions it may execute: exactly the six in section 3
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prorettype <> 'trigger'::regtype AND has_function_privilege('agentsmith_worker', p.oid, 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1;
-- (5) memberships: exactly 'reader'
SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = 'agentsmith_worker'::regrole;
```
The application runs the same checks automatically. `assessConnectedRole` (in `apps/api/src/db-roles.ts`) runs when the worker
starts, as the worker's own connection, and the grants script reruns it inside its transaction. It refuses any of: superuser,
CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS; ownership of any relation; CREATE in the schema; TEMP; PUBLIC privileges on
application relations; a membership that is not proven read-only; DELETE, TRUNCATE, TRIGGER or REFERENCES on any relation.

### Rehearsal of this exact plan (standard PostgreSQL 16, disposable database, 2026-11-28)
- **Setup:** the production schema (0001–0007, 0011–0014), and a login role whose only membership is a group holding
  `pg_read_all_data`, as Fly's `reader` does.
- **Script output:** "membership tolerated: verified read-only"; "effective privileges: 47 before, 90 after; added 43, removed 0";
  "applied runtime grants: 50 tables, 6 functions". (The 47 before are the SELECT privileges inherited from the read-only group.)
- **Verification query:**
  - 0 errors;
  - 43 INSERT/UPDATE privileges: 14 INSERT-only tables, 14 INSERT-and-UPDATE tables (28), and UPDATE on `bounty_sources`;
  - **0** DELETE, TRUNCATE, TRIGGER or REFERENCES;
  - 0 owned objects;
  - CREATE in the schema false, CREATE in the database false, TEMP false;
  - exactly the six functions;
  - one membership.

The plan therefore works on standard PostgreSQL. The remaining blocker is specific to Fly Managed Postgres.

## 5. What the worker cannot do (after the grants)
- **No DELETE or TRUNCATE:** granted on no table, and the startup check refuses the role if it holds either.
- **No ownership changes:** the role owns nothing, has no CREATEROLE, and cannot ALTER or DROP objects it doesn't own. It also
  cannot disable the append-only triggers, because only an owner or a TRIGGER privilege could, and it has neither.
- **No object creation:** no CREATE on the schema or the database. CREATE is also revoked from PUBLIC.
- **No temporary tables:** TEMP is revoked from the role and from PUBLIC. Function search paths are pinned as a second defence.

## 6. The worker refuses the owner connection
- The worker connects with `WORKER_DATABASE_URL`, and falls back to `DATABASE_URL` only if that is unset.
- With `HUB_REQUIRE_RESTRICTED_DB_ROLE=true` (always set for A8), the worker runs `assessConnectedRole` before claiming anything.
  The owner fails it: it owns every table and can CREATE. The worker then exits with code **78** and claims nothing.
- This is tested: the R1 integration tests hand the worker the owner role and assert exit 78 with nothing claimed.
- In production, `WORKER_DATABASE_URL` is already set (Fly attach, 2026-11-27), so no fallback occurs at all. The API keeps
  `DATABASE_URL`; its digest was verified unchanged.

## 7. The credential
- `agentsmith_worker` and `WORKER_DATABASE_URL` **already exist**. They were created by `fly mpg users create` and
  `fly mpg attach --variable-name WORKER_DATABASE_URL`, with all output discarded, so the password never entered this session.
- Creating the user again from the Fly dashboard gives the same kind of Fly-managed `reader` user. It would most likely meet the
  same refusal, so it is not needed to make progress.

## 8. The blocker, and the options
Fly refused one of the nine revocation statements in step (a)/(b). Which one decides the fix:
- **If Fly forbids changing a Fly-managed user's privileges** (GRANT or REVOKE to `agentsmith_worker`), a Fly-created user can
  never receive these grants. The alternative is a NOLOGIN role created by the owner, holding exactly these grants, with
  `agentsmith_worker` as a member. That membership change may be refused too.
- **If it forbids only the PUBLIC or database-level revocations**, a small change to the grants script would skip any revocation
  that is already in effect. That means a new release, which needs your approval.

Option A (recommended) is the one-off diagnostic, which needs your approval. It runs each of the nine statements on its own in a
single transaction, then rolls everything back: nothing changes, and it prints only which statements Fly accepts.

