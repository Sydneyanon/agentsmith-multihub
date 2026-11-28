-- DRAFT (not a migration; never applied by the migration runner). See README.md in this directory.
-- C3: (1) a database-enforced link between an analysed snapshot and its dependency snapshots; (2) storage for a package that is pinned by
-- a lockfile integrity hash. Today (1) is recorded in JSON (the dependency snapshot's acquisition_report.dependency_of and the dependency
-- step's manifest) and (2) cannot be stored at all, so pinned packages are recorded as "pinned, not acquired".
-- Requires 0007 (repo_snapshots, research_blobs, research_reject_mutation).

-- (1) one row per dependency of an analysed snapshot, acquired or not
CREATE TABLE snapshot_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL,
  parent_snapshot_id uuid NOT NULL,
  -- path from the root of the analysed snapshot (a nested submodule's path is below its parent's)
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  depth integer NOT NULL CHECK (depth BETWEEN 1 AND 8),
  kind text NOT NULL CHECK (kind IN ('git_submodule', 'npm_package')),
  source_url text CHECK (source_url IS NULL OR length(source_url) <= 500),
  -- the pin: for a submodule, the gitlink of the parent commit's tree; never a branch head
  pinned_commit text CHECK (pinned_commit IS NULL OR pinned_commit ~ '^[a-f0-9]{40}$'),
  pin_established_by text CHECK (pin_established_by IS NULL OR pin_established_by IN ('gitlink_in_parent_tree', 'package-lock.json integrity')),
  status text NOT NULL CHECK (status IN ('acquired', 'unpinned', 'missing_url', 'disallowed_host', 'unavailable', 'too_large',
                                         'nested_depth_exceeded', 'dependency_limit_reached', 'unrepresentable_path', 'pinned_not_acquired')),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 500),
  dependency_snapshot_id uuid,
  package_snapshot_id uuid,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  recorded_by_step_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_snapshot_id, path),
  FOREIGN KEY (parent_snapshot_id, workflow_run_id) REFERENCES repo_snapshots (id, workflow_run_id),
  FOREIGN KEY (dependency_snapshot_id, workflow_run_id) REFERENCES repo_snapshots (id, workflow_run_id),
  FOREIGN KEY (recorded_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id),
  -- an acquired dependency names exactly one stored snapshot; anything else names none and says why
  CHECK ((status = 'acquired') = (dependency_snapshot_id IS NOT NULL OR package_snapshot_id IS NOT NULL)),
  CHECK (status = 'acquired' OR reason IS NOT NULL),
  CHECK (dependency_snapshot_id IS NULL OR package_snapshot_id IS NULL),
  -- nothing is acquired without a pin
  CHECK (status <> 'acquired' OR pin_established_by IS NOT NULL),
  CHECK (parent_snapshot_id IS DISTINCT FROM dependency_snapshot_id)
);
CREATE INDEX snapshot_dependencies_dependency_idx ON snapshot_dependencies (dependency_snapshot_id) WHERE dependency_snapshot_id IS NOT NULL;
CREATE TRIGGER snapshot_dependencies_immutable BEFORE UPDATE OR DELETE ON snapshot_dependencies
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();

-- both ends must be sealed, and a git dependency's snapshot must be of exactly the pinned commit
CREATE FUNCTION snapshot_dependencies_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_sealed timestamptz; dep record;
BEGIN
  SELECT sealed_at INTO parent_sealed FROM repo_snapshots WHERE id = NEW.parent_snapshot_id;
  IF parent_sealed IS NULL THEN RAISE EXCEPTION 'the analysed snapshot must be sealed before its dependencies are recorded'; END IF;
  IF NEW.dependency_snapshot_id IS NOT NULL THEN
    SELECT sealed_at, commit_sha INTO dep FROM repo_snapshots WHERE id = NEW.dependency_snapshot_id;
    IF dep.sealed_at IS NULL THEN RAISE EXCEPTION 'a dependency snapshot must be sealed'; END IF;
    IF dep.commit_sha IS DISTINCT FROM NEW.pinned_commit THEN RAISE EXCEPTION 'the dependency snapshot is of commit %, not the pinned commit %', dep.commit_sha, NEW.pinned_commit USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER snapshot_dependencies_before_insert BEFORE INSERT ON snapshot_dependencies FOR EACH ROW EXECUTE FUNCTION snapshot_dependencies_guard();

-- (2) a package tarball pinned by a lockfile: identified by its integrity hash, never by a version range
CREATE TABLE package_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id),
  produced_by_step_id uuid NOT NULL,
  registry_host text NOT NULL CHECK (registry_host IN ('registry.npmjs.org')),
  name text NOT NULL CHECK (name ~ '^(@[a-z0-9._~-]+/)?[a-z0-9._~-]+$' AND length(name) <= 214),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 100),
  resolved_url text NOT NULL CHECK (resolved_url ~ '^https://registry\.npmjs\.org/' AND length(resolved_url) <= 500),
  -- the lockfile's integrity string and the digest the acquirer recomputed over the downloaded bytes; they must agree
  lockfile_integrity text NOT NULL CHECK (lockfile_integrity ~ '^sha512-[A-Za-z0-9+/=]{86,90}$'),
  tarball_sha512 text NOT NULL CHECK (tarball_sha512 ~ '^[a-f0-9]{128}$'),
  file_count integer NOT NULL CHECK (file_count BETWEEN 0 AND 20000),
  total_bytes bigint NOT NULL CHECK (total_bytes BETWEEN 0 AND 67108864),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, name, version, lockfile_integrity),
  UNIQUE (id, workflow_run_id),
  FOREIGN KEY (produced_by_step_id, workflow_run_id) REFERENCES workflow_steps (id, workflow_run_id)
);
CREATE TRIGGER package_snapshots_immutable BEFORE UPDATE OR DELETE ON package_snapshots
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
CREATE TABLE package_snapshot_files (
  package_snapshot_id uuid NOT NULL REFERENCES package_snapshots(id),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 1024 AND path !~ '(^|/)\.\.(/|$)' AND path !~ '^/'),
  blob_sha256 text NOT NULL REFERENCES research_blobs(content_sha256),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  PRIMARY KEY (package_snapshot_id, path)
);
CREATE TRIGGER package_snapshot_files_immutable BEFORE UPDATE OR DELETE ON package_snapshot_files
  FOR EACH ROW EXECUTE FUNCTION research_reject_mutation();
ALTER TABLE snapshot_dependencies ADD CONSTRAINT snapshot_dependencies_package_fk
  FOREIGN KEY (package_snapshot_id, workflow_run_id) REFERENCES package_snapshots (id, workflow_run_id);
