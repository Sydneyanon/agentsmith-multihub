/**
 * Backend vocabulary mapped to wording. Nothing here computes a status: unknown values are shown verbatim and
 * marked "unrecognised". There is deliberately no "verified" label anywhere in the client.
 */
export type Tone = "cyan" | "green" | "amber" | "red" | "grey" | "violet";
export interface Word { label: string; tone: Tone; hint: string }

export const HYPOTHESIS_STATUS: Record<string, Word> = {
  unreviewed: { label: "Awaiting review", tone: "amber", hint: "No review or static check has settled this hypothesis." },
  weakened_by_static_check: { label: "Weakened by static check", tone: "grey", hint: "A deterministic rule found evidence against it." },
  contradicted_by_static_check: { label: "Contradicted by static check", tone: "red", hint: "A deterministic rule contradicts the claim." },
  supported_by_review: { label: "Reviewer supports pursuing", tone: "cyan", hint: "A blinded review supports further work. This is not a confirmed finding." },
  rejected_by_review: { label: "Rejected by review", tone: "grey", hint: "A blinded review rejected it." },
  needs_more_evidence: { label: "Needs more evidence", tone: "amber", hint: "A review asked for more evidence." },
  review_inconclusive: { label: "Review inconclusive", tone: "amber", hint: "A review could not decide." },
  reviews_disagree: { label: "Reviews disagree", tone: "violet", hint: "Reviews reached different verdicts." },
  withdrawn: { label: "Withdrawn", tone: "grey", hint: "Withdrawn by its author." },
};
export const RUN_STATUS: Record<string, Word> = {
  queued: { label: "Queued", tone: "amber", hint: "" }, running: { label: "Running", tone: "cyan", hint: "" },
  awaiting_approval: { label: "Awaiting approval", tone: "amber", hint: "" }, succeeded: { label: "Complete", tone: "green", hint: "" },
  failed: { label: "Failed", tone: "red", hint: "" }, rejected: { label: "Rejected", tone: "grey", hint: "" }, cancelled: { label: "Cancelled", tone: "grey", hint: "" },
};
export const STEP_STATUS = RUN_STATUS;
export const HEALTH: Record<string, Word> = {
  idle: { label: "Idle", tone: "grey", hint: "Nothing queued or running." },
  working: { label: "Working", tone: "cyan", hint: "Steps are queued or running." },
  attention: { label: "Needs attention", tone: "amber", hint: "See the reasons listed." },
};
export const AUTOMATION: Record<string, Word> = {
  automated: { label: "Automated", tone: "cyan", hint: "A deterministic rule or worker." },
  model: { label: "Model", tone: "violet", hint: "A language model." },
  human: { label: "Human", tone: "amber", hint: "A person." },
};
export const REVIEW_MODE: Record<string, Word> = {
  blinded_independent_assessment: { label: "Blinded assessment", tone: "cyan", hint: "The reviewer judged the evidence without seeing the claim's own verdict." },
  disclosed_adjudication: { label: "Disclosed adjudication", tone: "amber", hint: "The reviewer saw prior conclusions. Not an independent assessment." },
};
export const FILE_CLASS_TONE: Record<string, string> = { source: "cyan", test: "green", config: "amber", docs: "grey", vendored: "violet", generated: "violet", other: "grey" };

export function word(table: Record<string, Word>, value: string | null | undefined): Word {
  if (value && Object.prototype.hasOwnProperty.call(table, value)) return table[value]!;
  return { label: `${value ?? "unknown"} (unrecognised)`, tone: "grey", hint: "The backend returned a value this client does not know." };
}

export const STEP_LABEL: Record<string, string> = {
  resolve_source: "Resolve source", identify_project: "Identify project", locate_official_repositories: "Locate repositories",
  establish_authorization: "Establish scope", map_attack_surface: "Map attack surface", generate_hypotheses: "Generate hypotheses",
  independent_challenge: "Independent challenge", prepare_research_brief: "Prepare brief",
};
export const stepLabel = (key: string): string => STEP_LABEL[key] ?? key;

/** The seven stage slots of Design 2. `built` names the task that will produce the slot's records when it does not exist yet. */
export interface StageSlot { key: string; label: string; notBuilt?: string }
export const STAGES: StageSlot[] = [
  { key: "discovery", label: "Discovery", notBuilt: "Task 5.3" },
  { key: "repository", label: "Repository" },
  { key: "understanding", label: "Understanding", notBuilt: "Task 5.4" },
  { key: "analysis", label: "Analysis" },
  { key: "challenge", label: "Challenge" },
  { key: "review", label: "Review" },
  { key: "verification", label: "Verification", notBuilt: "later stage" },
];

export type StageState = "done" | "none" | "not_built";
export interface ProjectRecordCounts { snapshots: { sealed: number }; hypotheses: { total: number }; evaluations: number; reviews: number }
/** A slot is "done" only when the backend reports a record for it; this never infers completion from step names. */
export function stageStates(p: ProjectRecordCounts): Array<StageSlot & { state: StageState }> {
  const has: Record<string, boolean> = { repository: p.snapshots.sealed > 0, analysis: p.hypotheses.total > 0, challenge: p.evaluations > 0, review: p.reviews > 0 };
  return STAGES.map((slot) => ({ ...slot, state: slot.notBuilt ? "not_built" : has[slot.key] ? "done" : "none" }));
}

export const NAV: Array<{ id: string; label: string; hash: string; later?: string }> = [
  { id: "home", label: "Research Home", hash: "#/home" },
  { id: "projects", label: "Projects", hash: "#/projects" },
  { id: "repository", label: "Repository", hash: "#/repository" },
  { id: "hypotheses", label: "Hypotheses", hash: "#/hypotheses" },
  { id: "evidence", label: "Evidence", hash: "#/evidence" },
  { id: "activity", label: "Activity", hash: "#/activity" },
  { id: "reviews", label: "Reviews", hash: "#/reviews", later: "Task 5.6" },
  { id: "findings", label: "Findings", hash: "#/findings", later: "later stage" },
  { id: "knowledge", label: "Knowledge", hash: "#/knowledge", later: "later stage" },
  { id: "system", label: "System", hash: "#/system", later: "later stage" },
];
