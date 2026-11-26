/** Step keys of the structural-analysis stages of a `repository_research` run. Kept apart so run creation and the worker can share them without cycles. */
export const ANALYZE_STEP_KEY = "analyze_structure";
export const CHALLENGE_STEP_KEY = "challenge_leads";
export const DOSSIER_STEP_KEY = "build_dossier";
export const ANALYSIS_STEP_KEYS = [ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY] as const;
/** The analysis stages run only when a worker is started with this switch AND the run was created with `structuralAnalysis`. */
export const STRUCTURAL_ANALYSIS_SWITCH = "STRUCTURAL_ANALYSIS_ENABLED";
export const ANALYZER_VERSION = "structural-solidity/1 (specialists 1, execution validators 1)";
