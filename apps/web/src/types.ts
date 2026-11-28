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
  id: string; step_key: string; role: string; sequence: number; status: string; attempt: number; error: { message: string; retryable: boolean | null } | null;
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
/** The parts of an acquisition report (docs/repository-acquisition.md) the client reads. Every field is optional: older snapshots have none. */
export interface AcquisitionReport {
  report_version?: number; tool?: { name?: string; version?: string }; acquired_at?: string;
  source?: { full_name?: string; repository_id?: number; requested_ref?: string | null; commit_sha?: string; tree_sha?: string; default_branch?: string };
  archive?: { sha256?: string; compressed_bytes?: number; uncompressed_bytes?: number; entries?: number };
  completeness?: { status?: string; unrepresentable_total?: number; unrepresentable?: Array<{ path: string; reason: string; kind: string }> };
  counts?: { tree_entries?: number; manifest_rows?: number; stored?: number; stored_bytes?: number; skipped_by_reason?: Record<string, number>; lfs_pointers?: number; symlinks?: number; submodules?: number; case_collisions?: number };
  symlinks?: Array<{ path: string; target: string; escapes_root: boolean }>;
  submodules?: Array<{ path: string; commit_sha: string; url: string | null }>;
  lfs_pointers?: Array<{ path: string; oid: string; size: number }>;
  verification?: { method?: string; manifest_sha256?: string };
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

/** GET /v1/engine/status (apps/api/src/engine-status.ts). The backend computes every state; the client only words it. */
export interface StepQueueRow { step_key: string; queued: number; running_live: number; running_expired_lease: number; awaiting_approval: number; succeeded: number; failed: number; failed_24h: number; oldest_queued_age_seconds: number | null }
export interface EngineStatus {
  version: string; generated_at: string; data_kind: "production" | "synthetic" | "test" | "unlabelled";
  build: { commit: string | null; image: string | null; built_at: string | null; source: string };
  schema: { ledger_readable: boolean; applied: string[] | null; expected: string[] | null; missing: string[] | null; unknown: string[] | null; discovery_installed: boolean };
  engine: { state: "idle" | "queued" | "working" | "attention"; reasons: string[] };
  workers: {
    connected: Array<{ worker_id: string; structural_analysis: boolean; connections: number }>; live_lease_owners: string[]; presence_basis: string;
    running: Array<{ worker: string; workflow_type: string; step_key: string; live: boolean; lease_expires_at: string | null }>;
  };
  queue: { totals: { queued: number; running_live: number; running_expired_lease: number; failed_24h: number }; order_basis: string;
    by_lane: Array<{ workflow_type: string; label: string; kind: "structural" | "legacy" | "other"; steps: StepQueueRow[] }> };
  runs: Array<{ workflow_type: string; lane: string; status: string; count: number; last_created_at: string }>;
  last: {
    run: { id: string; workflow_type: string; status: string; created_at: string; created_by: string } | null;
    step_success: { workflow_type: string; step_key: string; completed_at: string } | null;
    failure: { run_id: string; workflow_type: string; step_key: string; attempt: number; at: string | null; error: { message: string; retryable: boolean | null } } | null;
  };
  stages: {
    discovery: { installed: true; sources: number; enabled_sources: number; last_success_at: string | null; opportunities_by_state: Counts } | { installed: false; reason: string };
    acquisition: { snapshots_sealed: number; snapshots_building: number };
    protocol_mapping: { stored_models: number; schema: string };
    hypotheses: { total: number; by_status: Counts; note: string };
    evidence_spans: number;
    validation: { evaluations: number; blinded_reviews: number };
    adjudication: { disclosed_adjudications: number; human_confirmed_findings: null; note: string };
    memory: { installed: boolean; built: boolean; note: string };
  };
}
export interface DiscoverySource { source_key: string; adapter: string; display_name: string; enabled: boolean; min_interval_seconds: number; last_attempt_at: string | null; last_success_at: string | null; consecutive_failures: number }
export interface Opportunity { id: string; platform: string; title: string; state: string; priority_score: number; first_seen_at: string; last_seen_at: string }

/** The dossier's architecture section (apps/api/src/analysis/solidity/pipeline.ts, ArchitectureSection). */
export interface AuthoritySummary {
  roles: Array<{ variable: string; strength: string; holder: string; held_by: string | null; transfer: string; writers: string[] }>;
  open_authority_writes: string[]; callee_side_checks: string[]; factory_paths: string[]; proxy: string[]; initialisers: string[]; assumptions: string[]; unresolved: string[];
}
export type ArchitectureSection =
  | { available: false; reason: string }
  | { available: true; model_sha256: string; builder: string; unknowns: Array<{ at: string; what: string }>;
      components: Array<{ id: string; kind: string; file: string; lines: string; content_sha256: string; state_roles: Array<{ variable: string; status: string; roles: string[] }>; authority: AuthoritySummary | null;
        entry_points: Array<{ fn: string; guarded: boolean; writes: string[]; external_calls: Array<{ kind: string; to: string; target_provenance: string | null; resolved_callee: string | null; at: string }>; unresolved_calls: Array<{ name: string; at: string }> }> }> };
export interface DossierBrief { snapshot: { id: string; repository: string; commit_sha: string; verified: boolean }; architecture: ArchitectureSection; content_sha256: string }

/** GET /v1/research/runs/:id/progress (run-progress/1), GET /v1/research/timeline, GET /v1/engine/components. apps/api/src/operations-api.ts is authoritative. */
export type MetricKind = "processing" | "coverage" | "confidence" | "outcome";
export interface Metric { key: string; label: string; numerator: number | null; denominator: number | null; unit: string; kind: MetricKind; source: string; measurable: boolean; basis: "verified" | "worker_reported"; note?: string }
export interface StepActivity {
  step_id: string; step_key: string; status: string; attempt: number; started_at: string | null; completed_at: string | null; elapsed_seconds: number | null;
  lease_owner: string | null; lease_expires_at: string | null; lease_live: boolean; running_live: boolean;
  latest_progress: { phase: string; done: number; total: number | null; unit: string; at: string; reported_by: "worker"; via: string | null } | null; progress_records: number;
}
export interface PanelIssues {
  errors: Array<{ step_key: string; attempt: number | null; message: string; retryable: boolean | null; at: string | null; source: string }>;
  retries: Array<{ step_key: string; attempt: number }>; expired_leases: Array<{ step_key: string; lease_owner: string | null; lease_expired_at: string | null }>;
  lease_exhausted: number; abstentions: Array<{ code: string; detail: string; source: string }>;
  refusals: { total: number; quota: number; by_code: Record<string, number> }; blockers: Array<{ text: string; source: string }>;
}
export type ComponentState = "operational" | "available" | "experimental" | "unavailable" | "blocked";
export interface CapabilityRow { id: string; version: string; kind: string; in_run: boolean; state: string; reason: string; source: string; environment: string }
export interface ProgressPanel {
  id: string; title: string; state: string; state_basis: string; availability: { state: ComponentState; reason: string; evidence: string } | null;
  processing: Metric[]; coverage: Metric[]; counts: Metric[]; activity: StepActivity[]; issues: PanelIssues; notes: string[]; capabilities?: CapabilityRow[];
}
export interface RunProgress {
  version: string; generated_at: string;
  run: { id: string; workflow_type: string; status: string; repository: string | null; ref: string | null; created_at: string; started_at: string | null; completed_at: string | null; snapshot_id: string | null; bounty_scope: { programme: string; in_scope_paths: number } | null };
  stages: Array<{ step_key: string; status: string; attempt: number; elapsed_seconds: number | null; lease_live: boolean; started_at: string | null; completed_at: string | null }>;
  panels: ProgressPanel[];
  confidence: { available: true; total: number; distribution: Array<{ verdict: string; count: number }>; corroboration: { same_family: Metric; cross_family: Metric }; source: string; note: string } | { available: false; reason: string };
  outcome: { available: true; counts: Metric[]; no_leads: boolean; note: string } | { available: false; reason: string };
}
export interface TimelineItem { id: string; at: string; source: string; category: string; action: string; actor: string; step_key: string | null; step_id: string | null; hypothesis_id: string | null; run_id: string | null; summary: string; reason: string | null; payload: unknown }
export interface TimelinePage { generated_at?: string; items: TimelineItem[]; limit: number; has_more: boolean; next: { before: string; before_id: string } | null; decisions: { available: boolean; note: string }; sources: string[] }
export interface SystemComponents { generated_at: string; rules: Record<string, string>; components: Array<{ id: string; label: string; state: ComponentState; evidence: Array<{ source: string; detail: string; at?: string | null }> }> }
