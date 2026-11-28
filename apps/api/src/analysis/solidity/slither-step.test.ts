import { describe, expect, it } from "vitest";
import { ENGINE_STEP_KEYS } from "../../engine/steps.js";
import { intakeStepKeys } from "../../worker-runtime.js";
import { ANALYSIS_STEP_KEYS, SLITHER_STEP_KEY } from "./keys.js";
import { APEX_SHADOW_STEP_KEY } from "../../apex/shadow-target.js";
import { isResearchSlitherStep, slitherScanStepInput } from "./slither-record.js";
import { SLITHER_SCAN_DEFAULTS, slitherScanClaimable, slitherScanLimits } from "./slither-step.js";

const bins = { AGENTSMITH_SLITHER_BIN: "/opt/slither", AGENTSMITH_SOLC_BIN: "/opt/solc" };

describe("the optional slither_scan stage of repository_research: claim gate", () => {
  it("default key selection is unchanged: no slither_scan without the explicit switch AND both binaries", () => {
    expect(intakeStepKeys({})).not.toContain(SLITHER_STEP_KEY);
    // apex_shadow is claimable with the analysis stages; only a run created for the approved target with a recorded approval has such a step
    expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true" })).toEqual([...intakeStepKeys({}), ...ANALYSIS_STEP_KEYS, APEX_SHADOW_STEP_KEY]);
    expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", ...bins })).not.toContain(SLITHER_STEP_KEY); // binaries alone: no
    for (const v of ["1", "TRUE", "yes", ""]) expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", SLITHER_SCAN_ENABLED: v, ...bins })).not.toContain(SLITHER_STEP_KEY);
    expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", SLITHER_SCAN_ENABLED: "true" })).not.toContain(SLITHER_STEP_KEY); // switch without binaries: no
    expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", SLITHER_SCAN_ENABLED: "true", AGENTSMITH_SLITHER_BIN: "/opt/slither", AGENTSMITH_SOLC_BIN: " " })).not.toContain(SLITHER_STEP_KEY);
    expect(intakeStepKeys({ SLITHER_SCAN_ENABLED: "true", ...bins })).not.toContain(SLITHER_STEP_KEY); // the analysis switch is still required
    expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", SLITHER_SCAN_ENABLED: "true", ...bins })).toEqual([...intakeStepKeys({}), ...ANALYSIS_STEP_KEYS, SLITHER_STEP_KEY, APEX_SHADOW_STEP_KEY]);
    // with the engine loop on as well the key appears once
    const both = intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", ENGINE_LOOP_ENABLED: "true", SLITHER_SCAN_ENABLED: "true", ...bins });
    expect(both.filter((k) => k === SLITHER_STEP_KEY)).toHaveLength(1);
    expect(intakeStepKeys({ STRUCTURAL_ANALYSIS_ENABLED: "true", ENGINE_LOOP_ENABLED: "true" })).toEqual([...intakeStepKeys({}), ...ANALYSIS_STEP_KEYS, ...ENGINE_STEP_KEYS, APEX_SHADOW_STEP_KEY]);
    expect(slitherScanClaimable({ SLITHER_SCAN_ENABLED: "true", ...bins })).toBe(true);
  });
  it("a research-run Slither step is told apart from an engine-loop assignment step by its input", () => {
    expect(isResearchSlitherStep({ step_key: SLITHER_STEP_KEY, input: slitherScanStepInput() })).toBe(true);
    expect(isResearchSlitherStep({ step_key: SLITHER_STEP_KEY, input: { decisionId: "x", capability: { id: "slither", version: "0.11.3" } } })).toBe(false);
    expect(isResearchSlitherStep({ step_key: SLITHER_STEP_KEY, input: null as unknown as Record<string, unknown> })).toBe(false);
    expect(isResearchSlitherStep({ step_key: "challenge_leads", input: slitherScanStepInput() })).toBe(false);
  });
});

describe("resource limits", () => {
  it("defaults, valid overrides, and invalid values ignored and named (never stretched)", () => {
    expect(slitherScanLimits({})).toEqual(SLITHER_SCAN_DEFAULTS);
    expect(slitherScanLimits({ SLITHER_SCAN_TIMEOUT_MS: "5000", SLITHER_SCAN_TOTAL_TIMEOUT_MS: "20000", SLITHER_SCAN_MAX_OUTPUT_BYTES: "1048576" })).toEqual({ ...SLITHER_SCAN_DEFAULTS, timeoutMs: 5000, totalTimeoutMs: 20000, maxOutputBytes: 1048576 });
    expect(slitherScanLimits({ SLITHER_SCAN_TIMEOUT_MS: "-1", SLITHER_SCAN_TOTAL_TIMEOUT_MS: "1e9", SLITHER_SCAN_MAX_OUTPUT_BYTES: "999999999999" })).toEqual({ ...SLITHER_SCAN_DEFAULTS, ignored: ["SLITHER_SCAN_TIMEOUT_MS", "SLITHER_SCAN_TOTAL_TIMEOUT_MS", "SLITHER_SCAN_MAX_OUTPUT_BYTES"] });
    expect(slitherScanLimits({ SLITHER_SCAN_TOTAL_TIMEOUT_MS: "2000" })).toMatchObject({ timeoutMs: 2000, totalTimeoutMs: 2000 }); // per-call never exceeds total
  });
});
