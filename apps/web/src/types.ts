/** Shapes of the /v1/research responses the client reads. The backend (apps/api/src/research-api.ts) is authoritative. */
export interface Page<T> { items: T[]; limit: number; offset: number; has_more: boolean }
export type Counts = Record<string, number>;

export interface ProjectSummary {
  id: string; workflow_type: string; status: string; created_at: string; started_at: string | null; completed_at: string | null;
  input: { kind: string | null; value: string | null; source: string | null };
  progress: { steps_total: number; steps_succeeded: number; steps_failed: number; current_step: string | null; current_step_status: string | null };
  snapshots: { total: number; sealed: number };
  hypotheses: { total: number; by_status: Counts };
  evaluations: number; reviews: number;
}
export interface StepRow {
  id: string; step_key: string; role: string; sequence: number; status: string; attempt: number; error: string | null;
  started_at: string | null; completed_at: string | null; lease_owner: string | null; lease_expires_at: string | null; lease_live: boolean;
}
export interface SnapshotBrief { id: string; repository: string; commit_sha: string; ref_name: string | null; sealed_at: string | null; file_count: number | null; total_bytes: number | string | null; manifest_sha256: string | null; spans: number; hypotheses: number }
export interface ProjectDetail extends ProjectSummary {
  correlation_id: string | null; created_by: string | null; notes: string | null;
  steps: StepRow[]; snapshot_records: SnapshotBrief[];
  legacy: { note: string; evidence_snapshots: Array<{ id: string; source_kind: string; source_uri: string; content_sha256: string; captured_at: string }>; brief: unknown; leads: unknown[] };
}

export interface Overview {
  generated_at: string;
  projects: { total: number; by_status: Counts };
  research: {
    snapshots: { sealed: number; building: number }; evidence_spans: number;
    hypotheses: { total: number; by_status: Counts }; evaluations: number; reviews: Counts; events_24h: { research: number; workflow: number };
  };
  pipeline: {
    health: { state: string; reasons: string[] };
    steps_queued: number; steps_running: number; running_with_expired_lease: number; live_lease_owners: number;
    failed_steps_24h: number; failed_steps_7d: number; oldest_queued_age_seconds: number | null; last_step_success_at: string | null;
    steps_by_key_and_status: Record<string, Counts>;
  };
  storage: Record<string, string | number> | undefined;
}

export interface SnapshotSummary {
  id: string; workflow_run_id: string; repository: string; source_host: string; commit_sha: string; ref_name: string | null; sealed_at: string | null;
  file_count: number | null; total_bytes: number | string | null; manifest_sha256: string | null; spans: number; hypotheses: number; created_at: string;
  acquisition_report: unknown;
}
export interface SnapshotDetail extends SnapshotSummary {
  sealed: boolean;
  files: { stored: number; skipped: number; by_classification: Counts; skip_reasons: Counts };
  verification: unknown;
}
export interface FileRow { path: string; classification: string; size_bytes: number; stored: boolean; skip_reason: string | null; span_count: number; hypothesis_count: number }
export interface FileText { path: string; classification: string; size_bytes: number; blob_sha256: string; line_count: number; text: string; spans: Array<{ id: string; line_start: number; line_end: number; hypotheses: Array<{ id: string; status: string }> }> }
export interface SurfaceFile { path: string; classification: string; size_bytes: number; stored: boolean; skip_reason: string | null; spans: number; hypotheses_by_status: Counts }
export interface Surface { truncated: boolean; files: SurfaceFile[] }

export interface HypothesisSummary {
  id: string; workflow_run_id: string; snapshot_id: string; repository: string; commit_sha: string; family: string; claim: string; created_at: string; supersedes_id: string | null;
  generator: { kind: string; id: string; version: string }; status: string; static_outcome: string | null; static_conflicts_with_review: boolean | null;
  counts: { evidence: number; evaluations: number; blinded_reviews: number; adjudications: number }; last_event_seq: number | null;
}
export type Resolution = { ok: true; text: string } | { ok: false; reason: string };
export interface HypothesisDetail extends HypothesisSummary {
  rationale: string; required_checks: unknown; alternative_explanations: unknown; generator_reservation_id: string | null; produced_by_step_id: string | null;
  evidence: Array<{ span_id: string; role: string; path: string; line_start: number; line_end: number; resolution: Resolution }>;
  evaluations: Array<{ id: string; evaluator_id: string; evaluator_version: string; actor_kind: string; outcome: string; rationale: string; input_sha256: string; created_at: string; span_ids: string[] }>;
  reviews: Array<{
    id: string; reviewer_kind: string; reviewer_id: string; review_mode: string; reviewer_saw: unknown; input_sha256: string; verdict: string; rationale: string; created_at: string;
    model: { provider: string | null; name: string | null; prompt_version: string | null; reservation_id: string | null } | null;
  }>;
  events: Array<{ seq: number; event_type: string; actor_kind: string; actor_id: string | null; reason: string | null; created_at: string }>;
}
export interface EvidenceRow { id: string; snapshot_id: string; repository: string; commit_sha: string; path: string; line_start: number; line_end: number; created_at: string; cited_by_hypotheses: number; cited_by_evaluations: number }
export interface EvidenceDetail {
  span: { id: string; snapshot_id: string; repository: string; commit_sha: string; path: string; line_start: number; line_end: number; blob_sha256: string; excerpt_sha256: string; created_at: string };
  resolution: Resolution; verification: unknown;
  context: { before: Array<{ line: number; text: string }>; after: Array<{ line: number; text: string }> } | null;
  cited_by: { hypotheses: Array<{ id: string; claim: string; family: string; role: string; status: string }>; evaluations: Array<{ id: string; hypothesis_id: string; evaluator_id: string; outcome: string }> };
}
export interface ActivityItem {
  id: string; at: string; at_cursor: string; source: string; automation: string; actor_kind: string; actor_id: string; action: string; entity_type: string; entity_id: string;
  run_id: string | null; hypothesis_id: string | null; step_key: string | null; reason: string | null;
}
export interface ActivityPage { items: ActivityItem[]; limit: number; has_more: boolean; next: { before: string; before_id: string } | null; automation_basis: string }
