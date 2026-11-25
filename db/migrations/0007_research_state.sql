-- First-class research state (Task 5.1). Design: docs/research-state.md.
-- Records are append-only, history is an event log, status is derived by a view.
-- Blob bytes can be removed only through evict_research_blob(), which never removes cited evidence.
-- These checks guard against application mistakes; an owner-level SQL user can still disable triggers.
--
-- Provenance rule: every record carries workflow_run_id (and, where a step wrote it, produced_by_step_id).
-- Composite foreign keys (id, workflow_run_id) force a record, its parent records and its writing step to
-- belong to the SAME run, so a worker cannot attach evidence, hypotheses, evaluations or reviews to another
-- run's records whatever the application does. A step's lease is still checked by the application.
ALTER TABLE workflow_steps ADD CONSTRAINT workflow_steps_id_run_key UNIQUE (id, workflow_run_id);

CREATE FUNCTION research_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; record a new row instead', TG_TABLE_NAME;
END;
$$;

-- Line definition shared with the application: split on LF only, ignore one final empty element
-- when the text ends with a newline; an empty text is one empty line.
CREATE FUNCTION research_split_lines(p_text text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  parts text[];
  n integer;
BEGIN
  parts := string_to_array(p_text, E'\n');
  n := array_length(parts, 1);
  IF n IS NULL THEN RETURN ARRAY['']::text[]; END IF;
  IF n > 1 AND parts[n] = '' THEN parts := parts[1:n - 1]; END IF;
  RETURN parts;
END;
$$;

-- ---------------------------------------------------------------------------
-- Content-addressed blobs
-- ---------------------------------------------------------------------------
CREATE TABLE research_blobs (
  content_sha256 text PRIMARY KEY CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 1048576),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content) = size_bytes),
  CHECK (encode(sha256(content), 'hex') = content_sha256)
);

CREATE FUNCTION research_blobs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('agentsmith.blob_eviction', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'research_blobs are immutable; use evict_research_blob() to remove unreferenced bytes';
END;
$$;
CREATE TRIGGER research_blobs_immutable BEFORE UPDATE OR DELETE ON research_blobs
  FOR EACH ROW EXECUTE FUNCTION research_blobs_guard();

CREATE TABLE research_blob_evictions (
  id bigserial PRIMARY KEY,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  evicted_by text NOT NULL CHECK (length(evicted_by) BETWEEN 1 AND 200),
  evicted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER research_blob_evictions_append_only BEFORE UPDATE OR DELETE ON research_blob_evictions
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- ---------------------------------------------------------------------------
-- Repository snapshots: one repository at one commit, building then sealed
-- ---------------------------------------------------------------------------
CREATE TABLE repo_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  produced_by_step_id uuid NOT NULL,
  source_host text NOT NULL CHECK (source_host IN ('github.com')),
  repository text NOT NULL CHECK (repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  ref_name text CHECK (ref_name IS NULL OR length(ref_name) <= 250),
  acquisition_report jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(acquisition_report) = 'object'),
  file_count integer CHECK (file_count IS NULL OR file_count BETWEEN 0 AND 20000),
  total_bytes bigint CHECK (total_bytes IS NULL OR total_bytes BETWEEN 0 AND 67108864),
  manifest_sha256 text CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$'),
  sealed_at timestamptz,
  sealed_by_step_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((sealed_at IS NULL) = (manifest_sha256 IS NULL)),
  CHECK ((sealed_at IS NULL) = (file_count IS NULL)),
  CHECK ((sealed_at IS NULL) = (total_bytes IS NULL)),
  CHECK ((sealed_at IS NULL) = (sealed_by_step_id IS NULL)),
  UNIQUE (workflow_run_id, repository, commit_sha),
  UNIQUE (id, workflow_run_id),
  FOREIGN KEY (produced_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id),
  FOREIGN KEY (sealed_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id)
);

CREATE TABLE repo_snapshot_files (
  snapshot_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  produced_by_step_id uuid NOT NULL,
  path text NOT NULL CHECK (
    length(path) BETWEEN 1 AND 1024
    AND path !~ '^/' AND path !~ '(^|/)\.\.?(/|$)' AND path !~ '//' AND path !~ '[\t\n\r]'
  ),
  blob_sha256 text CHECK (blob_sha256 IS NULL OR blob_sha256 ~ '^[a-f0-9]{64}$'),
  git_blob_sha text CHECK (git_blob_sha IS NULL OR git_blob_sha ~ '^[a-f0-9]{40}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  classification text NOT NULL CHECK (classification IN ('source','test','vendored','generated','docs','config','other')),
  skip_reason text CHECK (skip_reason IS NULL OR skip_reason IN
    ('binary','oversize','symlink','submodule','excluded_by_policy','unreadable_encoding','limit_reached')),
  PRIMARY KEY (snapshot_id, path),
  UNIQUE (snapshot_id, path, blob_sha256),
  CHECK ((blob_sha256 IS NULL) = (skip_reason IS NOT NULL)),
  FOREIGN KEY (snapshot_id, workflow_run_id) REFERENCES repo_snapshots (id, workflow_run_id),
  FOREIGN KEY (produced_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id)
);

-- Rows may be added only while the snapshot is building, and only for blobs that exist with the stated size.
CREATE FUNCTION repo_snapshot_files_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sealed timestamptz;
  blob_size integer;
BEGIN
  SELECT sealed_at INTO sealed FROM repo_snapshots WHERE id = NEW.snapshot_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot % does not exist', NEW.snapshot_id; END IF;
  IF sealed IS NOT NULL THEN RAISE EXCEPTION 'snapshot % is sealed; its manifest cannot change', NEW.snapshot_id; END IF;
  IF NEW.blob_sha256 IS NOT NULL THEN
    SELECT size_bytes INTO blob_size FROM research_blobs WHERE content_sha256 = NEW.blob_sha256;
    IF NOT FOUND THEN RAISE EXCEPTION 'blob % is not stored', NEW.blob_sha256; END IF;
    IF blob_size <> NEW.size_bytes THEN
      RAISE EXCEPTION 'manifest size % does not match stored blob size % for %', NEW.size_bytes, blob_size, NEW.path;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repo_snapshot_files_before_insert BEFORE INSERT ON repo_snapshot_files
  FOR EACH ROW EXECUTE FUNCTION repo_snapshot_files_guard();
CREATE TRIGGER repo_snapshot_files_immutable BEFORE UPDATE OR DELETE ON repo_snapshot_files
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- Manifest hash: sha256 over "path TAB (blob hash | skipped:reason) LF" lines in byte order of path.
CREATE FUNCTION repo_snapshot_manifest(p_id uuid, OUT file_count integer, OUT total_bytes bigint, OUT manifest_sha256 text)
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer,
         COALESCE(sum(size_bytes) FILTER (WHERE blob_sha256 IS NOT NULL), 0)::bigint,
         encode(sha256(convert_to(COALESCE(string_agg(
           path || E'\t' || COALESCE(blob_sha256, 'skipped:' || skip_reason) || E'\n', '' ORDER BY path COLLATE "C"), ''), 'UTF8')), 'hex')
  FROM repo_snapshot_files WHERE snapshot_id = p_id
$$;

-- The only permitted update is building -> sealed, and the database computes the sealed values itself.
CREATE FUNCTION repo_snapshots_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'repo_snapshots are append-only'; END IF;
  IF OLD.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'snapshot % is sealed and immutable', OLD.id; END IF;
  IF NEW.sealed_at IS NULL THEN RAISE EXCEPTION 'a building snapshot can only be sealed'; END IF;
  IF NEW.sealed_by_step_id IS NULL THEN RAISE EXCEPTION 'sealing must name the sealing step (of the same run)'; END IF;
  IF (NEW.id, NEW.workflow_run_id, NEW.produced_by_step_id, NEW.source_host, NEW.repository, NEW.commit_sha, NEW.ref_name, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.workflow_run_id, OLD.produced_by_step_id, OLD.source_host, OLD.repository, OLD.commit_sha, OLD.ref_name, OLD.created_at) THEN
    RAISE EXCEPTION 'only sealing is allowed to change a snapshot';
  END IF;
  SELECT * INTO m FROM repo_snapshot_manifest(OLD.id);
  IF m.file_count > 20000 THEN RAISE EXCEPTION 'snapshot has % files; the limit is 20000', m.file_count; END IF;
  IF m.total_bytes > 67108864 THEN RAISE EXCEPTION 'snapshot stores % bytes; the limit is 67108864', m.total_bytes; END IF;
  NEW.file_count := m.file_count;
  NEW.total_bytes := m.total_bytes;
  NEW.manifest_sha256 := m.manifest_sha256;
  NEW.sealed_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER repo_snapshots_guard BEFORE UPDATE OR DELETE ON repo_snapshots
  FOR EACH ROW EXECUTE FUNCTION repo_snapshots_guard();

-- ---------------------------------------------------------------------------
-- Evidence spans
-- ---------------------------------------------------------------------------
-- Returns ok | evicted | not_text | range_error | mismatch.
CREATE FUNCTION research_span_check(p_blob text, p_start integer, p_end integer, p_excerpt_sha256 text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw bytea;
  body text;
  lines text[];
  excerpt text;
BEGIN
  SELECT content INTO raw FROM research_blobs WHERE content_sha256 = p_blob;
  IF NOT FOUND THEN RETURN 'evicted'; END IF;
  BEGIN
    body := convert_from(raw, 'UTF8');
  EXCEPTION WHEN SQLSTATE '22021' THEN
    RETURN 'not_text';
  END;
  lines := research_split_lines(body);
  IF p_start < 1 OR p_end < p_start OR p_end > array_length(lines, 1) THEN RETURN 'range_error'; END IF;
  excerpt := array_to_string(lines[p_start:p_end], E'\n');
  IF encode(sha256(convert_to(excerpt, 'UTF8')), 'hex') <> p_excerpt_sha256 THEN RETURN 'mismatch'; END IF;
  RETURN 'ok';
END;
$$;

CREATE TABLE evidence_spans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL,
  produced_by_step_id uuid,
  snapshot_id uuid NOT NULL,
  path text NOT NULL,
  blob_sha256 text NOT NULL CHECK (blob_sha256 ~ '^[a-f0-9]{64}$'),
  line_start integer NOT NULL CHECK (line_start >= 1),
  line_end integer NOT NULL,
  excerpt_sha256 text NOT NULL CHECK (excerpt_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (line_end >= line_start AND line_end - line_start < 400),
  FOREIGN KEY (snapshot_id, path, blob_sha256) REFERENCES repo_snapshot_files (snapshot_id, path, blob_sha256),
  FOREIGN KEY (snapshot_id, workflow_run_id) REFERENCES repo_snapshots (id, workflow_run_id),
  FOREIGN KEY (produced_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id),
  UNIQUE (snapshot_id, path, line_start, line_end),
  UNIQUE (id, workflow_run_id)
);

CREATE FUNCTION evidence_spans_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sealed timestamptz;
  verdict text;
BEGIN
  SELECT sealed_at INTO sealed FROM repo_snapshots WHERE id = NEW.snapshot_id;
  IF sealed IS NULL THEN RAISE EXCEPTION 'evidence can only cite a sealed snapshot'; END IF;
  verdict := research_span_check(NEW.blob_sha256, NEW.line_start, NEW.line_end, NEW.excerpt_sha256);
  IF verdict <> 'ok' THEN RAISE EXCEPTION 'evidence span does not resolve (%)', verdict; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_spans_before_insert BEFORE INSERT ON evidence_spans
  FOR EACH ROW EXECUTE FUNCTION evidence_spans_guard();
CREATE TRIGGER evidence_spans_immutable BEFORE UPDATE OR DELETE ON evidence_spans
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

CREATE FUNCTION verify_evidence_span(p_id uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT research_span_check(blob_sha256, line_start, line_end, excerpt_sha256) FROM evidence_spans WHERE id = p_id), 'unknown_span')
$$;

-- Re-hashes every stored blob and recomputes the manifest hash.
CREATE FUNCTION verify_repo_snapshot(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  s record;
  m record;
  missing integer;
  mismatched integer;
BEGIN
  SELECT * INTO s FROM repo_snapshots WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_snapshot'); END IF;
  SELECT * INTO m FROM repo_snapshot_manifest(p_id);
  SELECT count(*) FILTER (WHERE b.content_sha256 IS NULL),
         count(*) FILTER (WHERE b.content_sha256 IS NOT NULL AND encode(sha256(b.content), 'hex') <> f.blob_sha256)
    INTO missing, mismatched
    FROM repo_snapshot_files f LEFT JOIN research_blobs b ON b.content_sha256 = f.blob_sha256
   WHERE f.snapshot_id = p_id AND f.blob_sha256 IS NOT NULL;
  RETURN jsonb_build_object(
    'ok', s.sealed_at IS NOT NULL AND s.manifest_sha256 = m.manifest_sha256 AND s.file_count = m.file_count
          AND s.total_bytes = m.total_bytes AND missing = 0 AND mismatched = 0,
    'sealed', s.sealed_at IS NOT NULL,
    'manifest_matches', s.manifest_sha256 IS NOT DISTINCT FROM m.manifest_sha256,
    'evicted_blobs', missing,
    'hash_mismatches', mismatched,
    'stored_manifest_sha256', s.manifest_sha256,
    'recomputed_manifest_sha256', m.manifest_sha256);
END;
$$;

-- Removes blob bytes that no evidence cites, leaving the manifest and an audit row.
CREATE FUNCTION evict_research_blob(p_sha256 text, p_reason text, p_actor text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  blob_size integer;
BEGIN
  IF EXISTS (SELECT 1 FROM evidence_spans WHERE blob_sha256 = p_sha256) THEN
    RAISE EXCEPTION 'blob % is cited as evidence and cannot be evicted', p_sha256;
  END IF;
  SELECT size_bytes INTO blob_size FROM research_blobs WHERE content_sha256 = p_sha256 FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM set_config('agentsmith.blob_eviction', 'on', true);
  DELETE FROM research_blobs WHERE content_sha256 = p_sha256;
  PERFORM set_config('agentsmith.blob_eviction', 'off', true);
  INSERT INTO research_blob_evictions (content_sha256, size_bytes, reason, evicted_by) VALUES (p_sha256, blob_size, p_reason, p_actor);
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Hypotheses: the claim as generated. Never edited; status lives in the event log.
-- ---------------------------------------------------------------------------
CREATE TABLE hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  produced_by_step_id uuid,
  snapshot_id uuid NOT NULL,
  supersedes_id uuid,
  family text NOT NULL CHECK (family ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  claim text NOT NULL CHECK (length(claim) BETWEEN 10 AND 2000),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 8000),
  required_checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_checks) = 'array'),
  alternative_explanations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(alternative_explanations) = 'array'),
  generator_kind text NOT NULL CHECK (generator_kind IN ('deterministic_rule','model','human')),
  generator_id text NOT NULL CHECK (length(generator_id) BETWEEN 1 AND 200),
  generator_version text NOT NULL CHECK (length(generator_version) BETWEEN 1 AND 100),
  generator_reservation_id uuid REFERENCES ai_budget_reservations(id),
  claim_fingerprint text NOT NULL CHECK (claim_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((generator_kind = 'model') = (generator_reservation_id IS NOT NULL)),
  UNIQUE (snapshot_id, claim_fingerprint),
  UNIQUE (id, workflow_run_id),
  FOREIGN KEY (snapshot_id, workflow_run_id) REFERENCES repo_snapshots (id, workflow_run_id),
  FOREIGN KEY (produced_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id),
  FOREIGN KEY (supersedes_id, workflow_run_id) REFERENCES hypotheses (id, workflow_run_id)
);
CREATE INDEX hypotheses_run_idx ON hypotheses (workflow_run_id, created_at);

CREATE FUNCTION hypotheses_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sealed timestamptz;
BEGIN
  SELECT sealed_at INTO sealed FROM repo_snapshots WHERE id = NEW.snapshot_id;
  IF sealed IS NULL THEN RAISE EXCEPTION 'a hypothesis must be pinned to a sealed snapshot'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hypotheses_before_insert BEFORE INSERT ON hypotheses FOR EACH ROW EXECUTE FUNCTION hypotheses_guard();
CREATE TRIGGER hypotheses_immutable BEFORE UPDATE OR DELETE ON hypotheses FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

CREATE TABLE hypothesis_evidence (
  hypothesis_id uuid NOT NULL,
  span_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  produced_by_step_id uuid,
  role text NOT NULL CHECK (role IN ('primary','supporting','context')),
  PRIMARY KEY (hypothesis_id, span_id),
  FOREIGN KEY (hypothesis_id, workflow_run_id) REFERENCES hypotheses (id, workflow_run_id),
  FOREIGN KEY (span_id, workflow_run_id) REFERENCES evidence_spans (id, workflow_run_id),
  FOREIGN KEY (produced_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id)
);

CREATE FUNCTION hypothesis_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hyp_snapshot uuid;
  span_snapshot uuid;
  existing integer;
BEGIN
  SELECT snapshot_id INTO hyp_snapshot FROM hypotheses WHERE id = NEW.hypothesis_id FOR UPDATE;
  SELECT snapshot_id INTO span_snapshot FROM evidence_spans WHERE id = NEW.span_id;
  IF hyp_snapshot IS DISTINCT FROM span_snapshot THEN
    RAISE EXCEPTION 'evidence span belongs to a different snapshot than the hypothesis';
  END IF;
  SELECT count(*) INTO existing FROM hypothesis_evidence WHERE hypothesis_id = NEW.hypothesis_id;
  IF existing >= 20 THEN RAISE EXCEPTION 'a hypothesis may cite at most 20 evidence spans'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hypothesis_evidence_before_insert BEFORE INSERT ON hypothesis_evidence
  FOR EACH ROW EXECUTE FUNCTION hypothesis_evidence_guard();
CREATE TRIGGER hypothesis_evidence_immutable BEFORE UPDATE OR DELETE ON hypothesis_evidence
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- At commit, every hypothesis must cite at least one primary span.
CREATE FUNCTION hypotheses_require_primary_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hypothesis_evidence WHERE hypothesis_id = NEW.id AND role = 'primary') THEN
    RAISE EXCEPTION 'hypothesis % must cite at least one primary evidence span', NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER hypotheses_primary_evidence AFTER INSERT ON hypotheses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hypotheses_require_primary_evidence();

-- ---------------------------------------------------------------------------
-- Deterministic evaluations (may abstain) and reviews (model or human)
-- ---------------------------------------------------------------------------
CREATE TABLE hypothesis_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL,
  hypothesis_id uuid NOT NULL,
  produced_by_step_id uuid NOT NULL,
  actor_kind text NOT NULL DEFAULT 'deterministic_rule' CHECK (actor_kind = 'deterministic_rule'),
  evaluator_id text NOT NULL CHECK (length(evaluator_id) BETWEEN 1 AND 200),
  evaluator_version text NOT NULL CHECK (length(evaluator_version) BETWEEN 1 AND 100),
  outcome text NOT NULL CHECK (outcome IN ('supports','weakens','contradicts','inconclusive')),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 8000),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workflow_run_id),
  FOREIGN KEY (hypothesis_id, workflow_run_id) REFERENCES hypotheses (id, workflow_run_id),
  FOREIGN KEY (produced_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id)
);
CREATE INDEX hypothesis_evaluations_hypothesis_idx ON hypothesis_evaluations (hypothesis_id);
CREATE TRIGGER hypothesis_evaluations_immutable BEFORE UPDATE OR DELETE ON hypothesis_evaluations
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

CREATE TABLE evaluation_evidence (
  evaluation_id uuid NOT NULL,
  span_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  produced_by_step_id uuid NOT NULL,
  PRIMARY KEY (evaluation_id, span_id),
  FOREIGN KEY (evaluation_id, workflow_run_id) REFERENCES hypothesis_evaluations (id, workflow_run_id),
  FOREIGN KEY (span_id, workflow_run_id) REFERENCES evidence_spans (id, workflow_run_id),
  FOREIGN KEY (produced_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id)
);
CREATE FUNCTION evaluation_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hyp_snapshot uuid;
  span_snapshot uuid;
BEGIN
  SELECT h.snapshot_id INTO hyp_snapshot FROM hypothesis_evaluations e JOIN hypotheses h ON h.id = e.hypothesis_id WHERE e.id = NEW.evaluation_id;
  SELECT snapshot_id INTO span_snapshot FROM evidence_spans WHERE id = NEW.span_id;
  IF hyp_snapshot IS DISTINCT FROM span_snapshot THEN
    RAISE EXCEPTION 'evaluation cites a span from a different snapshot than its hypothesis';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evaluation_evidence_before_insert BEFORE INSERT ON evaluation_evidence
  FOR EACH ROW EXECUTE FUNCTION evaluation_evidence_guard();
CREATE TRIGGER evaluation_evidence_immutable BEFORE UPDATE OR DELETE ON evaluation_evidence
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- Only an inconclusive (abstaining) evaluation may cite nothing.
CREATE FUNCTION evaluations_require_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome <> 'inconclusive' AND NOT EXISTS (SELECT 1 FROM evaluation_evidence WHERE evaluation_id = NEW.id) THEN
    RAISE EXCEPTION 'a % evaluation must cite at least one evidence span', NEW.outcome;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER hypothesis_evaluations_evidence AFTER INSERT ON hypothesis_evaluations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION evaluations_require_evidence();

CREATE FUNCTION research_reviewer_saw_valid(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'object' THEN
    (SELECT count(*) FROM jsonb_object_keys(p)) = 6
    AND p ?& ARRAY['claim','evidence_spans','generator_rationale','generator_identity','prior_evaluations','prior_reviews']
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) WHERE jsonb_typeof(value) <> 'boolean')
  ELSE false END
$$;

CREATE TABLE hypothesis_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL,
  hypothesis_id uuid NOT NULL,
  produced_by_step_id uuid,
  reviewer_kind text NOT NULL CHECK (reviewer_kind IN ('model','human')),
  reviewer_id text NOT NULL CHECK (length(reviewer_id) BETWEEN 1 AND 200),
  review_mode text NOT NULL CHECK (review_mode IN ('blinded_independent_assessment','disclosed_adjudication')),
  reviewer_saw jsonb NOT NULL CHECK (research_reviewer_saw_valid(reviewer_saw)),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  verdict text NOT NULL CHECK (verdict IN ('supports','rejects','needs_more_evidence','inconclusive')),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 8000),
  model_provider text,
  model_name text,
  model_prompt_version text,
  model_reservation_id uuid REFERENCES ai_budget_reservations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (review_mode <> 'disclosed_adjudication' OR reviewer_kind = 'human'),
  CHECK (reviewer_kind <> 'model' OR (model_provider IS NOT NULL AND model_name IS NOT NULL
         AND model_prompt_version IS NOT NULL AND model_reservation_id IS NOT NULL)),
  CHECK (reviewer_kind <> 'human' OR (model_provider IS NULL AND model_name IS NULL
         AND model_prompt_version IS NULL AND model_reservation_id IS NULL)),
  CHECK (review_mode <> 'blinded_independent_assessment' OR (
    (reviewer_saw->>'claim')::boolean AND (reviewer_saw->>'evidence_spans')::boolean
    AND NOT (reviewer_saw->>'generator_rationale')::boolean AND NOT (reviewer_saw->>'generator_identity')::boolean
    AND NOT (reviewer_saw->>'prior_evaluations')::boolean AND NOT (reviewer_saw->>'prior_reviews')::boolean)),
  UNIQUE (id, workflow_run_id),
  FOREIGN KEY (hypothesis_id, workflow_run_id) REFERENCES hypotheses (id, workflow_run_id),
  FOREIGN KEY (produced_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id)
);
CREATE INDEX hypothesis_reviews_hypothesis_idx ON hypothesis_reviews (hypothesis_id);

CREATE FUNCTION hypothesis_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  h record;
BEGIN
  SELECT generator_kind, generator_id INTO h FROM hypotheses WHERE id = NEW.hypothesis_id;
  IF NEW.review_mode = 'blinded_independent_assessment'
     AND h.generator_kind = NEW.reviewer_kind AND h.generator_id = NEW.reviewer_id THEN
    RAISE EXCEPTION 'a blinded independent assessment cannot be made by the actor that generated the hypothesis';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hypothesis_reviews_before_insert BEFORE INSERT ON hypothesis_reviews
  FOR EACH ROW EXECUTE FUNCTION hypothesis_reviews_guard();
CREATE TRIGGER hypothesis_reviews_immutable BEFORE UPDATE OR DELETE ON hypothesis_reviews
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- ---------------------------------------------------------------------------
-- Events: the authoritative, ordered history
-- ---------------------------------------------------------------------------
CREATE TABLE hypothesis_events (
  seq bigserial PRIMARY KEY,
  workflow_run_id uuid NOT NULL,
  hypothesis_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('registered','evaluation_recorded','review_recorded','withdrawn')),
  evaluation_id uuid,
  review_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('deterministic_rule','model','human')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_type = 'evaluation_recorded') = (evaluation_id IS NOT NULL)),
  CHECK ((event_type = 'review_recorded') = (review_id IS NOT NULL)),
  CHECK ((event_type = 'withdrawn') = (reason IS NOT NULL)),
  CHECK (event_type <> 'withdrawn' OR actor_kind = 'human'),
  FOREIGN KEY (hypothesis_id, workflow_run_id) REFERENCES hypotheses (id, workflow_run_id),
  FOREIGN KEY (evaluation_id, workflow_run_id) REFERENCES hypothesis_evaluations (id, workflow_run_id),
  FOREIGN KEY (review_id, workflow_run_id) REFERENCES hypothesis_reviews (id, workflow_run_id)
);
CREATE UNIQUE INDEX hypothesis_events_registered_once ON hypothesis_events (hypothesis_id) WHERE event_type = 'registered';
CREATE UNIQUE INDEX hypothesis_events_withdrawn_once ON hypothesis_events (hypothesis_id) WHERE event_type = 'withdrawn';
CREATE UNIQUE INDEX hypothesis_events_evaluation_once ON hypothesis_events (evaluation_id) WHERE evaluation_id IS NOT NULL;
CREATE UNIQUE INDEX hypothesis_events_review_once ON hypothesis_events (review_id) WHERE review_id IS NOT NULL;
CREATE INDEX hypothesis_events_hypothesis_idx ON hypothesis_events (hypothesis_id, seq);

-- registered / evaluation / review events exist only because a trigger on the underlying record wrote them
-- (nesting depth 2); the application may insert only a withdrawal directly (depth 1).
CREATE FUNCTION hypothesis_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type <> 'withdrawn' AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'a % event is created by recording the underlying record, not inserted directly', NEW.event_type;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hypothesis_events_before_insert BEFORE INSERT ON hypothesis_events
  FOR EACH ROW EXECUTE FUNCTION hypothesis_events_guard();
CREATE TRIGGER hypothesis_events_immutable BEFORE UPDATE OR DELETE ON hypothesis_events
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

CREATE FUNCTION hypotheses_log_registered() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO hypothesis_events (workflow_run_id, hypothesis_id, event_type, actor_kind, actor_id)
  VALUES (NEW.workflow_run_id, NEW.id, 'registered', NEW.generator_kind, NEW.generator_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER hypotheses_after_insert AFTER INSERT ON hypotheses FOR EACH ROW EXECUTE FUNCTION hypotheses_log_registered();

CREATE FUNCTION evaluations_log_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO hypothesis_events (workflow_run_id, hypothesis_id, event_type, evaluation_id, actor_kind, actor_id)
  VALUES (NEW.workflow_run_id, NEW.hypothesis_id, 'evaluation_recorded', NEW.id, NEW.actor_kind, NEW.evaluator_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER hypothesis_evaluations_after_insert AFTER INSERT ON hypothesis_evaluations
  FOR EACH ROW EXECUTE FUNCTION evaluations_log_event();

CREATE FUNCTION reviews_log_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO hypothesis_events (workflow_run_id, hypothesis_id, event_type, review_id, actor_kind, actor_id)
  VALUES (NEW.workflow_run_id, NEW.hypothesis_id, 'review_recorded', NEW.id, NEW.reviewer_kind, NEW.reviewer_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER hypothesis_reviews_after_insert AFTER INSERT ON hypothesis_reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_log_event();

-- ---------------------------------------------------------------------------
-- Derived status. There is no stored status and no 'verified' value.
-- ---------------------------------------------------------------------------
CREATE VIEW hypothesis_status AS
WITH latest_review AS (
  SELECT DISTINCT ON (r.hypothesis_id, r.reviewer_kind, r.reviewer_id) r.hypothesis_id, r.verdict
  FROM hypothesis_reviews r JOIN hypothesis_events e ON e.review_id = r.id
  ORDER BY r.hypothesis_id, r.reviewer_kind, r.reviewer_id, e.seq DESC
), review_summary AS (
  SELECT hypothesis_id, count(*) AS reviewers, count(DISTINCT verdict) AS distinct_verdicts, min(verdict) AS verdict
  FROM latest_review GROUP BY hypothesis_id
), latest_evaluation AS (
  SELECT DISTINCT ON (v.hypothesis_id, v.evaluator_id) v.hypothesis_id, v.outcome
  FROM hypothesis_evaluations v JOIN hypothesis_events e ON e.evaluation_id = v.id
  ORDER BY v.hypothesis_id, v.evaluator_id, e.seq DESC
), evaluation_summary AS (
  SELECT hypothesis_id,
         CASE WHEN bool_or(outcome = 'contradicts') THEN 'contradicts'
              WHEN bool_or(outcome = 'weakens') THEN 'weakens'
              WHEN bool_or(outcome = 'supports') THEN 'supports'
              ELSE 'inconclusive' END AS static_outcome
  FROM latest_evaluation GROUP BY hypothesis_id
), review_counts AS (
  SELECT hypothesis_id,
         count(*) FILTER (WHERE review_mode = 'blinded_independent_assessment') AS blinded_reviews,
         count(*) FILTER (WHERE review_mode = 'disclosed_adjudication') AS adjudications
  FROM hypothesis_reviews GROUP BY hypothesis_id
), evaluation_counts AS (
  SELECT hypothesis_id, count(*) AS evaluations FROM hypothesis_evaluations GROUP BY hypothesis_id
), withdrawals AS (
  SELECT DISTINCT hypothesis_id FROM hypothesis_events WHERE event_type = 'withdrawn'
)
SELECT h.id AS hypothesis_id,
       CASE WHEN w.hypothesis_id IS NOT NULL THEN 'withdrawn'
            WHEN rs.reviewers IS NOT NULL AND rs.distinct_verdicts > 1 THEN 'reviews_disagree'
            WHEN rs.reviewers IS NOT NULL THEN CASE rs.verdict
                 WHEN 'supports' THEN 'supported_by_review'
                 WHEN 'rejects' THEN 'rejected_by_review'
                 WHEN 'needs_more_evidence' THEN 'needs_more_evidence'
                 ELSE 'review_inconclusive' END
            WHEN es.static_outcome = 'contradicts' THEN 'contradicted_by_static_check'
            WHEN es.static_outcome = 'weakens' THEN 'weakened_by_static_check'
            ELSE 'unreviewed' END AS status,
       COALESCE(es.static_outcome, 'none') AS static_outcome,
       COALESCE(ec.evaluations, 0)::integer AS evaluations,
       COALESCE(rc.blinded_reviews, 0)::integer AS blinded_reviews,
       COALESCE(rc.adjudications, 0)::integer AS adjudications,
       COALESCE(rs.reviewers IS NOT NULL AND rs.distinct_verdicts = 1 AND rs.verdict = 'supports'
                AND es.static_outcome IN ('weakens', 'contradicts'), false) AS static_conflicts_with_review,
       (w.hypothesis_id IS NOT NULL) AS withdrawn,
       (SELECT max(e.seq) FROM hypothesis_events e WHERE e.hypothesis_id = h.id) AS last_event_seq
FROM hypotheses h
LEFT JOIN withdrawals w ON w.hypothesis_id = h.id
LEFT JOIN review_summary rs ON rs.hypothesis_id = h.id
LEFT JOIN evaluation_summary es ON es.hypothesis_id = h.id
LEFT JOIN evaluation_counts ec ON ec.hypothesis_id = h.id
LEFT JOIN review_counts rc ON rc.hypothesis_id = h.id;

CREATE VIEW research_storage_stats AS
SELECT (SELECT count(*) FROM research_blobs) AS blobs,
       (SELECT COALESCE(sum(size_bytes), 0) FROM research_blobs) AS blob_bytes,
       (SELECT count(*) FROM repo_snapshots) AS snapshots,
       (SELECT count(*) FROM repo_snapshots WHERE sealed_at IS NULL) AS building_snapshots,
       (SELECT count(*) FROM research_blob_evictions) AS evictions,
       (SELECT COALESCE(sum(size_bytes), 0) FROM research_blob_evictions) AS evicted_bytes;
