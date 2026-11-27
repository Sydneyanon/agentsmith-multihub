/**
 * Programme lifecycle (task 4). A single, deterministic derivation of where a programme stands, kept strictly separate from
 * "eligibility": discovery is not eligibility, official verification is not a repository, a repository is not in-scope smart-contract
 * code, and a smart-contract target is not a funded bounty. Each milestone is only reached when every earlier one holds, so the state
 * is evidence-based and never over-claims. Run state (queued/scanning/scanned/...) overlays once a research run has been linked.
 *
 * This is a pure function over facts the system already has; it invents nothing.
 */
import type { EligibilityTier } from "./eligibility.js";

export type LifecycleState =
  // the main ladder (ordered; each requires all earlier milestones)
  | "discovered" | "officially_verified" | "scope_retrieved" | "smart_contract_target_confirmed" | "reward_confirmed"
  | "eligible_for_research" | "queued_for_scan" | "scanning" | "scanned" | "finding_under_review" | "completed"
  // side states (a programme rests here instead of climbing)
  | "needs_verification" | "out_of_engine_scope" | "ineligible" | "paused" | "unavailable" | "source_restricted";

/** For the dashboard: the main ladder in order, so a UI can render progress. Side states are intentionally excluded. */
export const LIFECYCLE_LADDER: LifecycleState[] = [
  "discovered", "officially_verified", "scope_retrieved", "smart_contract_target_confirmed", "reward_confirmed",
  "eligible_for_research", "queued_for_scan", "scanning", "scanned", "finding_under_review", "completed",
];

export type RunState = { status: string; findingUnderReview?: boolean; completed?: boolean };

export type LifecycleInput = {
  tier: EligibilityTier;
  engineSuitable: boolean;
  verification: string;            // Resolution.verification
  status: string;                  // Resolution.status
  hasReward: boolean;
  repositoriesResolved: boolean;   // at least one GitHub repo resolved from the programme
  sourceRestricted?: boolean;      // the programme's source is collected but may not be displayed/used (e.g. HackenProof terms)
  run?: RunState | null;           // the linked repository_research run, if one exists
};

export function programmeLifecycle(i: LifecycleInput): LifecycleState {
  // Side states first: these describe a programme that is not on the research path.
  if (i.sourceRestricted) return "source_restricted";
  if (i.status === "paused") return "paused";
  if (i.status === "closed" || i.status === "no_longer_listed" || i.status === "unknown") return "unavailable";
  if (i.tier === "ineligible") return "ineligible";
  if (i.tier === "out_of_engine_scope") return "out_of_engine_scope";

  // If a research run has been linked, overlay its state (only eligible programmes get a run).
  if (i.run) {
    if (i.run.completed) return "completed";
    if (i.run.findingUnderReview) return "finding_under_review";
    switch (i.run.status) {
      case "succeeded": return "scanned";
      case "running": return "scanning";
      case "queued": case "awaiting_approval": return "queued_for_scan";
      // failed/rejected/cancelled: the scan did not complete; fall through to the pre-run ladder so it can be re-dispatched.
      default: break;
    }
  }

  // A candidate that is engine-suitable and funded but not yet officially confirmed rests here (the candidate pool).
  if (i.tier === "needs_verification") return "needs_verification";

  // The evidence ladder, gated: climb only as far as the facts support.
  if (i.verification !== "official_confirmed") return "discovered";
  if (!i.repositoriesResolved) return "officially_verified";
  if (!i.engineSuitable) return "scope_retrieved";
  if (!i.hasReward) return "smart_contract_target_confirmed";
  if (i.tier !== "eligible") return "reward_confirmed";
  return "eligible_for_research";
}

/** Human-readable label + whether the state means "the engine may work on it". */
export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  discovered: "Discovered", officially_verified: "Officially verified", scope_retrieved: "Scope retrieved",
  smart_contract_target_confirmed: "Smart-contract target confirmed", reward_confirmed: "Reward confirmed",
  eligible_for_research: "Eligible for research", queued_for_scan: "Queued for scan", scanning: "Scanning",
  scanned: "Scanned", finding_under_review: "Finding under review", completed: "Completed",
  needs_verification: "Needs verification", out_of_engine_scope: "Out of engine scope", ineligible: "Not a vuln bounty",
  paused: "Paused", unavailable: "Unavailable", source_restricted: "Source restricted",
};
