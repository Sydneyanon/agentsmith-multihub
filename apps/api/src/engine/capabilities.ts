import { createHash } from "node:crypto";
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
  id: string; version: string;
  /** producer: plane-1 claims; evaluator: plane-2 technical evidence; reviewer: an independent opinion on claims (never evidence);
   *  mapper: architecture and attack-surface map that steers target selection */
  kind: "producer" | "evaluator" | "reviewer" | "mapper";
  stepKey: string; scope: "component" | "snapshot";
  classes: readonly string[]; description: string;
  requires: ReadonlyArray<{ env: string; what: string }>;
  status: "active" | "prepared";
  profile: CapabilityProfile;
};
/** What AgentSmith knows about a capability when it decides who should investigate what. */
export type CapabilityProfile = {
  specialisation: string;
  inputs: string[]; outputs: string[];
  limitations: string[]; failureModes: string[];
  /** in_process: AgentSmith code; local_tool: a pinned binary on the worker; attended_session: a Claude Code sub-agent run by a named
   *  operator (subscription, interactive only); unattended_api: a budget-gateway model call (needs A31; not built) */
  runtime: "in_process" | "local_tool" | "attended_session" | "unattended_api";
  availabilityMode: "unattended" | "interactive_only";
  /** relative cost of one assignment (1 = in-process seconds); attended sessions cost operator time and subscription usage, not API spend */
  costUnits: number; costNote: string;
  /** which protocol-model facts make this capability more useful on a component (a multiplier on its pending classes) */
  relevance: ReadonlyArray<{ signal: "ledger_vars" | "external_calls" | "entry_points" | "unguarded_writes" | "loops_or_lists"; weight: number }>;
  /** a mapper runs before producers on a snapshot it has not mapped */
  precedes?: boolean;
  /** the prompt that defines an attended specialist's method; its hash pins the version */
  method?: string;
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

/**
 * Attended Claude Code specialists (T-203). Each is a sub-agent with one research METHOD (the prompt below, whose hash pins the
 * version), run by a named operator in an attended Claude Code session: interactive only, subscription usage, no API spend, never
 * on an unattended worker. They are available only when the CLI runs with AGENTSMITH_ATTENDED_OPERATOR set. Their results enter
 * through `import-specialist`, anchored to hash-verified spans of the sealed snapshot; anything unanchored is rejected.
 */
export const ATTENDED_STEP_KEY = "specialist_review";
export const ATTENDED_CHALLENGE_STEP_KEY = "specialist_challenge";
const ATTENDED_REQ = [{ env: "AGENTSMITH_ATTENDED_OPERATOR", what: "a named operator running an attended Claude Code session" }] as const;
const attended = (p: Omit<CapabilityProfile, "runtime" | "availabilityMode" | "costUnits" | "costNote" | "failureModes"> & { failureModes?: string[] }): CapabilityProfile => ({
  runtime: "attended_session", availabilityMode: "interactive_only", costUnits: 10, costNote: "about 80k sub-agent tokens and 1.5 minutes per run (measured on the probe fixture), plus operator time; no API spend",
  failureModes: ["stopped by the session's safety classifier (observed when asked for step-by-step attack sequences)", "unanchored locations (rejected at import)", "schema-invalid output (rejected at import)", "same-model bias: not independent of other Claude specialists"],
  ...p, ...(p.failureModes ? { failureModes: p.failureModes } : {}),
});
const RULES = "Read only the materialised snapshot directory you are given; no network, no web, no installs, no other paths; do not modify the code; work alone. Report only issues you can argue concretely, with exact paths and line numbers; list what you examined and cleared and what you did not get to. Describe issues as an audit report (mechanism, preconditions, impact, how a local test would confirm or refute it); do not write step-by-step exploit instructions.";
export const ATTENDED_SPECIALISTS: readonly Capability[] = [
  { id: "claude-scoping", version: "1", kind: "mapper", stepKey: ATTENDED_STEP_KEY, scope: "snapshot", classes: ["architecture-map"], status: "active", requires: ATTENDED_REQ,
    description: "maps components, roles, trust boundaries, asset flows and a ranked attack surface; steers which component and specialist come next",
    profile: attended({ specialisation: "repository scoping", inputs: ["materialised sealed snapshot"], outputs: ["scope map", "ranked attack surface with suggested specialist", "optional claims"],
      limitations: ["a map, not evidence; ranking is a model judgement"], relevance: [], precedes: true,
      method: `Scope this unfamiliar repository as a senior auditor does before hunting: components, roles and privileges (including what should be privileged and is not), trust boundaries, asset flows and the accounting state, and a ranked attack surface (5-8 targets, each with a reason and the kind of specialist to send). ${RULES}` }) },
  { id: "claude-accounting", version: "1", kind: "producer", stepKey: ATTENDED_STEP_KEY, scope: "snapshot", classes: ["accounting-invariant", "arithmetic-precision", "economic-incentive"], status: "active", requires: ATTENDED_REQ,
    description: "DeFi accounting and state-transition specialist: invariants, update order, rounding direction, empty-state and cumulative effects",
    profile: attended({ specialisation: "accounting invariants and rounding", inputs: ["materialised sealed snapshot", "target components"], outputs: ["claims with spans", "invariants checked"],
      limitations: ["reasoning only; nothing executed", "may miss issues that need long simulations"], relevance: [{ signal: "ledger_vars", weight: 1 }],
      method: `For every contract that holds or accounts for value, write down the accounting invariants it must keep, then check every state-changing function against each: order of updates, rounding direction of every division and who it favours, first-use and empty-state edge cases, cumulative effects of repeated operations, and any check that can make a user-facing function revert. ${RULES}` }) },
  { id: "claude-path", version: "2", kind: "producer", stepKey: ATTENDED_STEP_KEY, scope: "snapshot", classes: ["multi-step-path", "oracle-manipulation"], status: "active", requires: ATTENDED_REQ,
    description: "cross-contract dependency specialist (APEX precursor): what each contract assumes about another's state, and which calls can violate it",
    profile: attended({ specialisation: "cross-contract and cross-transaction dependencies", inputs: ["materialised sealed snapshot"], outputs: ["dependency map", "claims with spans"],
      limitations: ["version 1 (attack-sequence wording) was stopped by the safety classifier; version 2 reports dependencies and test assertions instead"], relevance: [{ signal: "external_calls", weight: 1 }],
      method: `Map every place where one contract depends on another contract's state or behaviour, and every function whose correctness depends on state another function or contract can change. For each: the assumption, the functions that can change the state, and whether it can be violated with material consequence. ${RULES}` }) },
  { id: "claude-assumptions", version: "1", kind: "producer", stepKey: ATTENDED_STEP_KEY, scope: "snapshot", classes: ["assumption-violation", "liveness", "economic-incentive"], status: "active", requires: ATTENDED_REQ,
    description: "assumption-breaker (Weirdness precursor): implicit assumptions, counterexamples, and inconsistencies between sibling functions",
    profile: attended({ specialisation: "implicit assumptions and counterexamples", inputs: ["materialised sealed snapshot"], outputs: ["assumptions with counterexamples", "oddities", "claims with spans"],
      limitations: ["breadth over depth; many low-severity notes"], relevance: [{ signal: "external_calls", weight: 0.5 }, { signal: "ledger_vars", weight: 0.5 }],
      method: `For each contract list the implicit assumptions it relies on but never enforces (token behaviour, callers, other contracts' state, time, ordering, emptiness, list sizes, extreme values), try to construct a concrete counterexample for each, and flag inconsistencies between similar functions. ${RULES}` }) },
  { id: "claude-liveness", version: "1", kind: "producer", stepKey: ATTENDED_STEP_KEY, scope: "snapshot", classes: ["liveness"], status: "active", requires: ATTENDED_REQ,
    description: "class hunter for liveness and denial of service",
    profile: attended({ specialisation: "one class: liveness / DoS", inputs: ["materialised sealed snapshot"], outputs: ["claims with spans", "cleared paths"], limitations: ["one class only"], relevance: [{ signal: "loops_or_lists", weight: 1 }, { signal: "external_calls", weight: 0.5 }],
      method: `Hunt one class: liveness and denial of service. For every function users rely on to get value out or keep the system running, ask what can make it revert for everyone or a victim; distinguish permanent from temporary and anyone-can from needs-privilege. ${RULES}` }) },
  { id: "claude-hunter", version: "1", kind: "producer", stepKey: ATTENDED_STEP_KEY, scope: "snapshot", classes: ["access-control", "reentrancy", "initializer", "delegatecall", "unchecked-call", "selfdestruct", "tx-origin"], status: "active", requires: ATTENDED_REQ,
    description: "generalist vulnerability hunter: a verdict (vulnerable or safe, with reason) for every externally callable function, including exploitability",
    profile: attended({ specialisation: "per-function verdicts across the structural classes, judged on semantics rather than patterns", inputs: ["materialised sealed snapshot"], outputs: ["claims with spans", "explicit safe verdicts"],
      limitations: ["measured on the 31-label dev corpus only: 17/17 vulnerable found, 3 calls against labels of which 2 were label errors confirmed by execution and 1 a false positive"], relevance: [{ signal: "unguarded_writes", weight: 1 }, { signal: "entry_points", weight: 0.5 }],
      method: `For EVERY externally callable function, decide whether it contains a security vulnerability and of which class (access-control, reentrancy, initializer, delegatecall, selfdestruct, tx-origin, unchecked-call, or other). Judge look-alikes on their own merits and say "safe" with the reason; note whether each vulnerability is actually exploitable. ${RULES}` }) },
  { id: "claude-reproducer", version: "1", kind: "evaluator", stepKey: "foundry_validate", scope: "component", classes: ["challenge"], status: "prepared", requires: ATTENDED_REQ,
    description: "writes local regression tests that demonstrate a claim's impact (or refute it); the test becomes evidence only when run by the pinned foundry-forge evaluator (T-202)",
    profile: attended({ specialisation: "executable reproduction of claimed impact", inputs: ["claims with spans", "materialised sealed snapshot", "pinned forge and solc"], outputs: ["test/*.t.sol per claim", "a statement of what each test demonstrates (impact, revert only, or refutes)"],
      limitations: ["its own verdict is not evidence: only the pinned evaluator's execution is", "blocked until T-202 and A39 (Foundry installed persistently)"], relevance: [],
      method: `Write minimal defender's regression tests that demonstrate each claim's IMPACT (balances before and after, profit, or funds locked after all available actions), not merely that a call reverts; a test that refutes a claim is as valuable. ${RULES}` }) },
  { id: "claude-prior-art", version: "1", kind: "reviewer", stepKey: ATTENDED_CHALLENGE_STEP_KEY, scope: "snapshot", classes: ["duplicate-check"], status: "prepared", requires: ATTENDED_REQ,
    description: "checks claims against registered prior art (duplicate, related or novel); a suggestion for the human, never an outcome",
    profile: attended({ specialisation: "duplicate and prior-art triage", inputs: ["claims", "prior-art records (T-144 external_references, provenance verified, permitted use)"], outputs: ["per claim: duplicate (with the reference), related or novel"],
      limitations: ["measured on a local 12-entry corpus: 10/10 duplicates found, 1 false duplicate of 11 calls", "needs registered prior-art sources; external sources need A40 and their terms", "its 'duplicate' is a suggestion: the outcome 'duplicate' is human-only"], relevance: [],
      method: `Check each claim against the prior-art records you are given: "duplicate" only when the root cause AND mechanism match one record, "related" when a theme or consequence is shared but the cause or condition differs, otherwise "novel". ${RULES}` }) },
  { id: "claude-challenger", version: "1", kind: "reviewer", stepKey: ATTENDED_CHALLENGE_STEP_KEY, scope: "snapshot", classes: ["challenge"], status: "active", requires: ATTENDED_REQ,
    description: "independent challenger: tries to refute each claim, blinded to which specialist made it; records a review, never evidence",
    profile: attended({ specialisation: "adversarial review of claims", inputs: ["claims with spans (producer identity withheld)", "materialised sealed snapshot"], outputs: ["one review per claim: supports, rejects, needs_more_evidence or inconclusive"],
      limitations: ["a model opinion, not technical evidence: it can never make a finding confirmed", "same underlying model as the producers"], relevance: [],
      method: `You receive claims about this code without knowing who made them. For each, try hard to refute it from the code: check preconditions, guards, the arithmetic and whether the impact follows. Give a verdict (supports, rejects, needs_more_evidence, inconclusive) with the decisive reason and the test that would settle it. ${RULES}` }) },
];

export const CAPABILITIES: readonly Capability[] = [
  { id: "solidity-structural-specialists", version: "1", kind: "producer", stepKey: "investigate_target", scope: "component", classes: STRUCTURAL_CLASSES, status: "active", requires: [],
    description: "AgentSmith's deterministic Solidity specialists over the protocol model (in-process, no tool)",
    profile: { specialisation: "structural patterns over the protocol model: authority, initialisers, external calls", inputs: ["sealed snapshot", "protocol model"], outputs: ["claims with spans"],
      limitations: ["no accounting, precision, oracle or economic reasoning", "single-function patterns"], failureModes: ["parser gaps reported as problems"],
      runtime: "in_process", availabilityMode: "unattended", costUnits: 1, costNote: "seconds of CPU", relevance: [{ signal: "unguarded_writes", weight: 0.5 }, { signal: "external_calls", weight: 0.5 }] } },
  { id: "slither", version: SLITHER_VERSION, kind: "producer", stepKey: SLITHER_STEP_KEY, scope: "snapshot", classes: [...new Set(Object.values(SLITHER_DETECTOR_CLASS))].sort(), status: "active",
    requires: [{ env: "AGENTSMITH_SLITHER_BIN", what: `slither ${SLITHER_VERSION}` }, { env: "AGENTSMITH_SOLC_BIN", what: "a pinned solc binary" }],
    description: "Slither static analyzer, pinned version, run offline on the materialised sealed snapshot",
    profile: { specialisation: "pattern detectors (reentrancy, unchecked calls, dangerous patterns)", inputs: ["sealed snapshot (.sol)", "pinned solc"], outputs: ["claims with spans", "raw tool output"],
      limitations: ["no accounting or economic reasoning", "noisy on informational detectors", "framework remappings unsupported (compile_failed)"], failureModes: ["tool_unavailable", "version_mismatch", "compile_failed", "timeout", "output_invalid", "crashed"],
      runtime: "local_tool", availabilityMode: "unattended", costUnits: 2, costNote: "seconds to minutes of CPU", relevance: [{ signal: "external_calls", weight: 0.5 }, { signal: "entry_points", weight: 0.5 }] } },
  { id: "agentsmith-execution-validators", version: "1", kind: "evaluator", stepKey: "challenge_target", scope: "component", classes: ["reentrancy", "access-control", "selfdestruct", "delegatecall", "initializer", "unchecked-call"], status: "active", requires: [],
    description: "bounded execution and reachability validators; challenge any producer's leads of these classes",
    profile: { specialisation: "bounded execution of the claimed path", inputs: ["leads with spans"], outputs: ["evaluations"], limitations: ["six classes only; abstains on the rest"], failureModes: ["abstains (inconclusive)"],
      runtime: "in_process", availabilityMode: "unattended", costUnits: 1, costNote: "seconds", relevance: [] } },
  { id: "foundry-forge", version: FOUNDRY_VERSION, kind: "evaluator", stepKey: FOUNDRY_STEP_KEY, scope: "component", classes: [...STRUCTURAL_CLASSES, ...NOT_MODELLED_CLASSES], status: "prepared",
    requires: [{ env: "AGENTSMITH_FORGE_BIN", what: `forge ${FOUNDRY_VERSION}` }, { env: "AGENTSMITH_SOLC_BIN", what: "a pinned solc binary" }],
    description: "runs a reproducing test against the sealed snapshot offline; needs a test author (human, or a model after A31); installation is an environment change for the owner",
    profile: { specialisation: "executable reproduction (technical evidence)", inputs: ["sealed snapshot", "one test/*.t.sol by someone other than the producer"], outputs: ["evaluations with test hash"],
      limitations: ["needs a test author", "offline only; no fork"], failureModes: ["tool_unavailable", "version_mismatch", "compile_failed", "timeout"],
      runtime: "local_tool", availabilityMode: "unattended", costUnits: 3, costNote: "minutes of CPU", relevance: [] } },
  ...ATTENDED_SPECIALISTS,
];

export type Availability = { capability: Capability; available: boolean; reason: string };
export function availability(env: Record<string, string | undefined> = process.env): Availability[] {
  return CAPABILITIES.map((c) => {
    if (c.status === "prepared") return { capability: c, available: false, reason: "prepared, not assignable: needs owner approval to install and a test author" };
    const missing = c.requires.filter((r) => !env[r.env]);
    return missing.length ? { capability: c, available: false, reason: `not installed here: ${missing.map((m) => `${m.what} (${m.env})`).join(", ")}` } : { capability: c, available: true, reason: "available" };
  });
}
export const producers = (env?: Record<string, string | undefined>) => availability(env).filter((a) => a.available && (a.capability.kind === "producer" || a.capability.kind === "mapper")).map((a) => a.capability);
export const reviewers = (env?: Record<string, string | undefined>) => availability(env).filter((a) => a.available && a.capability.kind === "reviewer").map((a) => a.capability);
export const capabilityById = (id: string): Capability => { const c = CAPABILITIES.find((x) => x.id === id); if (!c) throw new Error(`unknown capability ${id}`); return c; };
export const PRODUCER_STEP_KEYS = [...new Set(CAPABILITIES.filter((c) => c.kind === "producer" || c.kind === "mapper").map((c) => c.stepKey))];

/** Every class AgentSmith tracks: what any declared capability examines, plus classes no capability examines (recorded as not modelled). */
export const TRACKED_CLASSES: readonly string[] = [...new Set([...CAPABILITIES.flatMap((c) => c.classes), ...NOT_MODELLED_CLASSES])].sort();

/** The version recorded for an attended specialist: its declared version plus the first 12 hex of its method prompt's hash. */
export function pinnedVersion(c: Capability): string {
  if (!c.profile.method) return c.version;
  return `${c.version}+prompt-${createHash("sha256").update(c.profile.method).digest("hex").slice(0, 12)}`;
}
