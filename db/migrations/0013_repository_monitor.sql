-- 0013: the repository monitor (autonomous loop). Tracks the repositories AgentSmith is researching, the last HEAD commit it has
-- seen, and the outcome of each check, so a new commit automatically triggers an incremental rescan — without a human initiating it.
-- Append-only check log for auditability and the coverage dashboard. Excluded from the production image like 0008/0012; ships only on
-- an approved deploy. It references no other workstream table directly (the run id is a soft reference recorded in the check log).

CREATE TABLE repository_monitors (
  repository text PRIMARY KEY CHECK (repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  enabled boolean NOT NULL DEFAULT true,
  default_branch text CHECK (default_branch IS NULL OR length(default_branch) <= 250),
  -- the last commit the monitor OBSERVED as HEAD (not necessarily analysed); analysis state lives in repo_snapshots.
  last_head_commit text CHECK (last_head_commit IS NULL OR last_head_commit ~ '^[a-f0-9]{40}$'),
  last_checked_at timestamptz,
  last_outcome text CHECK (last_outcome IS NULL OR last_outcome IN
    ('up_to_date', 'first_scan_queued', 'rescan_queued', 'already_queued', 'unavailable', 'error')),
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  next_attempt_at timestamptz,              -- backoff gate: the monitor skips this repo until now() >= next_attempt_at
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repository_monitor_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  head_commit text CHECK (head_commit IS NULL OR head_commit ~ '^[a-f0-9]{40}$'),
  outcome text NOT NULL,
  decision text,                             -- planRepositoryResearch decision: already_analysed | full | incremental | (none on error)
  workflow_run_id uuid,                      -- the rescan run created by this check, if any (soft reference)
  base_commit text CHECK (base_commit IS NULL OR base_commit ~ '^[a-f0-9]{40}$'),  -- the baseline an incremental rescan diffs against
  error text
);
CREATE INDEX repository_monitor_checks_repo ON repository_monitor_checks (repository, checked_at DESC);
