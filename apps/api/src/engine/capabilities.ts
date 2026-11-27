import type { FindingClass } from "../analysis/solidity/specialists.js";
import { NOT_MODELLED_CLASSES } from "./classes.js";

/**
 * Capability declarations (T-201). Not a registry or an orchestrator: each capability is a step of the ONE T-149 workflow
 * (`repository_research`), named by its step key, with a fixed identity and version and the bug classes it examines. The research loop
 * reads these declarations to choose WHICH specialist to assign to WHICH target; the workflow runs it; the results enter the same
 * evidence, challenge, coverage and memory records as everything else.
 *
 * - producer  -> plane 1 (claims). Its output is never evidence for its own claims.
 * - evaluator -> plane 2 (independent evidence). Its identity differs from every producer's, so independence is checkable.
 * - scope 'snapshot' tools examine a whole compilation unit in one run, so one assignment covers every component they have not examined.
 * Availability is a fact about this machine (pinned binaries present); an unavailable capability is never assigned, and the decision
 * says so. A capability marked `prepared` is declared and tested but never assigned automatically.
 */
export type Capability = {
  id: string; version: string; kind: "producer" | "evaluator"; stepKey: string; scope: "component" | "snapshot";
  classes: readonly string[]; description: string;
  requires: ReadonlyArray<{ env: string; what: string }>;
  status: "active" | "prepared";
};

const STRUCTURAL_CLASSES = ["reentrancy", "access-control", "initializer", "delegatecall", "unchecked-call", "selfdestruct", "tx-origin"] as const satisfies readonly FindingClass[];

/** Slither 0.11.3 detector -> AgentSmith bug class. Detectors not listed are informational or style; they are counted, never stored as leads. */
export const SLITHER_DETECTOR_CLASS: Readonly<Record<string, string>> = {
  "reentrancy-eth": "reentrancy", "reentrancy-no-eth": "reentrancy", "reentrancy-benign": "reentrancy", "reentrancy-events": "reentrancy", "reentrancy-unlimited-gas": "reentrancy",
  "arbitrary-send-eth": "access-control", "arbitrary-send-erc20": "access-control", "arbitrary-send-erc20-permit": "access-control", "protected-vars": "access-control", "unprotected-upgrade": "access-control",
  "suicidal": "selfdestruct",
  "controlled-delegatecall": "delegatecall", "delegatecall-loop": "delegatecall",
  "tx-origin": "tx-origin",
  "unchecked-lowlevel": "unchecked-call", "unchecked-send": "unchecked-call", "unchecked-transfer": "unchecked-call",
  "uninitialized-state": "uninitialized-state", "uninitialized-storage": "uninitialized-state", "uninitialized-local": "uninitialized-state",
  "divide-before-multiply": "divide-before-multiply",
  "incorrect-equality": "strict-equality",
  "weak-prng": "weak-randomness",
  "locked-ether": "locked-ether",
  "missing-zero-check": "missing-zero-check",
};

export const SLITHER_STEP_KEY = "slither_scan";
export const FOUNDRY_STEP_KEY = "foundry_validate";
export const SLITHER_VERSION = "0.11.3";
export const FOUNDRY_VERSION = "1.5.1";

export const CAPABILITIES: readonly Capability[] = [
  { id: "solidity-structural-specialists", version: "1", kind: "producer", stepKey: "investigate_target", scope: "component", classes: STRUCTURAL_CLASSES, status: "active", requires: [],
    description: "AgentSmith's deterministic Solidity specialists over the protocol model (in-process, no tool)" },
  { id: "slither", version: SLITHER_VERSION, kind: "producer", stepKey: SLITHER_STEP_KEY, scope: "snapshot", classes: [...new Set(Object.values(SLITHER_DETECTOR_CLASS))].sort(), status: "active",
    requires: [{ env: "AGENTSMITH_SLITHER_BIN", what: `slither ${SLITHER_VERSION}` }, { env: "AGENTSMITH_SOLC_BIN", what: "a pinned solc binary" }],
    description: "Slither static analyzer, pinned version, run offline on the materialised sealed snapshot" },
  { id: "agentsmith-execution-validators", version: "1", kind: "evaluator", stepKey: "challenge_target", scope: "component", classes: ["reentrancy", "access-control", "selfdestruct", "delegatecall", "initializer", "unchecked-call"], status: "active", requires: [],
    description: "bounded execution and reachability validators; challenge any producer's leads of these classes" },
  { id: "foundry-forge", version: FOUNDRY_VERSION, kind: "evaluator", stepKey: FOUNDRY_STEP_KEY, scope: "component", classes: [...STRUCTURAL_CLASSES, ...NOT_MODELLED_CLASSES], status: "prepared",
    requires: [{ env: "AGENTSMITH_FORGE_BIN", what: `forge ${FOUNDRY_VERSION}` }, { env: "AGENTSMITH_SOLC_BIN", what: "a pinned solc binary" }],
    description: "runs a reproducing test against the sealed snapshot offline; needs a test author (human, or a model after A31); installation is an environment change for the owner" },
];

export type Availability = { capability: Capability; available: boolean; reason: string };
export function availability(env: Record<string, string | undefined> = process.env): Availability[] {
  return CAPABILITIES.map((c) => {
    if (c.status === "prepared") return { capability: c, available: false, reason: "prepared, not assignable: needs owner approval to install and a test author" };
    const missing = c.requires.filter((r) => !env[r.env]);
    return missing.length ? { capability: c, available: false, reason: `not installed here: ${missing.map((m) => `${m.what} (${m.env})`).join(", ")}` } : { capability: c, available: true, reason: "available" };
  });
}
export const producers = (env?: Record<string, string | undefined>) => availability(env).filter((a) => a.available && a.capability.kind === "producer").map((a) => a.capability);
export const capabilityById = (id: string): Capability => { const c = CAPABILITIES.find((x) => x.id === id); if (!c) throw new Error(`unknown capability ${id}`); return c; };
export const PRODUCER_STEP_KEYS = CAPABILITIES.filter((c) => c.kind === "producer").map((c) => c.stepKey);

/** Every class AgentSmith tracks: what any declared capability examines, plus classes no capability examines (recorded as not modelled). */
export const TRACKED_CLASSES: readonly string[] = [...new Set([...CAPABILITIES.flatMap((c) => c.classes), ...NOT_MODELLED_CLASSES])].sort();
