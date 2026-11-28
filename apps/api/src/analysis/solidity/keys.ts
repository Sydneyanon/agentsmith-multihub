/** Step keys of the structural-analysis stages of a `repository_research` run. Kept apart so run creation and the worker can share them without cycles. */
export const ANALYZE_STEP_KEY = "analyze_structure";
export const CHALLENGE_STEP_KEY = "challenge_leads";
export const DOSSIER_STEP_KEY = "build_dossier";
export const ANALYSIS_STEP_KEYS = [ANALYZE_STEP_KEY, CHALLENGE_STEP_KEY, DOSSIER_STEP_KEY] as const;
/** The analysis stages run only when a worker is started with this switch AND the run was created with `structuralAnalysis`. */
export const STRUCTURAL_ANALYSIS_SWITCH = "STRUCTURAL_ANALYSIS_ENABLED";
/**
 * Bump on every change that can alter what the analysis reports. History: /1 up to and including release 5d6ccd1 (the first production
 * research run; that build already has the cross-file citation fix and coverage records); /2 adds writes through storage references (53301db).
 * The exact build commit is recorded beside it in the analysis step output (`analyzer_build`), so results are always attributable.
 */
export const ANALYZER_VERSION = "structural-solidity/2 (specialists 1 + storage-reference writes, execution validators 1)";
/**
 * The OPTIONAL Slither stage (`slither_scan`, between analyze_structure and challenge_leads). It is created only when a run is created
 * with `slitherScan` (which requires `structuralAnalysis`), and a worker claims it only when this switch is exactly "true" AND
 * AGENTSMITH_SLITHER_BIN and AGENTSMITH_SOLC_BIN are set. The step key is shared with the engine loop's Slither step; the step input's
 * `scope` tells them apart.
 */
export { SLITHER_STEP_KEY, SLITHER_VERSION } from "../../engine/capabilities.js";
export const SLITHER_SCAN_SWITCH = "SLITHER_SCAN_ENABLED";
export const SLITHER_SCAN_SCOPE = "repository_research";
