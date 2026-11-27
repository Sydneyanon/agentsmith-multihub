import { createHash } from "node:crypto";
import { coverageComponents, reachableCalls, type ProtocolModel } from "../analysis/solidity/protocol-model.js";
import type { Contribution, PriorityAssessment } from "./score.js";

/**
 * Component-level priority (T-052, extending T-051 in place). It ranks the components of ONE sealed snapshot for the next specialist
 * assignment. Same contract as score.ts: deterministic, every point a named contribution with its raw input and reason, no probability,
 * and the output has the PriorityAssessment shape so the existing `allocate()` does the exploit/explore split. It does not predict where
 * a vulnerability is; it orders what has not yet been examined, by facts the protocol model states.
 */
export type ComponentPolicy = {
  version: string;
  weights: { unexplored: number; entryPoints: number; externalCalls: number; unguardedWrites: number; costPenalty: number };
};
export const COMPONENT_POLICY_V1: ComponentPolicy = {
  version: "component-priority/1",
  weights: { unexplored: 50, entryPoints: 15, externalCalls: 20, unguardedWrites: 15, costPenalty: 10 },
};

/** What memory says about one component at one content hash: the classes examined there and the classes known not to be modelled. */
export type ComponentMemory = { componentSha256: string; examinedClasses: string[]; notModelledClasses: string[] };

export type ComponentFeatures = {
  id: string; contract: string; file: string; contentSha256: string;
  entryPoints: number; externalCalls: number; unguardedWrites: number; functions: number;
  examinedClasses: string[]; pendingClasses: string[];
};

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number) => Math.round(x * 100) / 100 + 0;
const OUTWARD = new Set(["external", "low-level-call", "delegatecall", "send", "transfer"]);

/** Facts per coverage component, read from the protocol model only (no private re-derivation). */
export function componentFeatures(model: ProtocolModel, memory: readonly ComponentMemory[], specialistClasses: readonly string[]): ComponentFeatures[] {
  return coverageComponents(model).map((c) => {
    const contract = c.id.slice(c.id.lastIndexOf("#") + 1); const file = c.id.slice(0, c.id.lastIndexOf("#"));
    const fns = model.functions.filter((f) => f.component === contract);
    const entries = fns.filter((f) => f.entryPoint);
    const calls = new Set<string>();
    for (const f of entries) for (const e of reachableCalls(model, f.id)) if (OUTWARD.has(e.kind)) calls.add(`${e.from}->${e.to}@${e.evidence.file}:${e.evidence.lineStart}`);
    const examined = [...new Set(memory.filter((m) => m.componentSha256 === c.contentSha256).flatMap((m) => m.examinedClasses))].sort();
    return {
      id: c.id, contract, file, contentSha256: c.contentSha256,
      entryPoints: entries.length, externalCalls: calls.size, unguardedWrites: entries.filter((f) => f.stateWrites.length > 0 && !f.callerGuarded).length, functions: fns.length,
      examinedClasses: examined, pendingClasses: specialistClasses.filter((k) => !examined.includes(k)),
    };
  });
}

export function scoreComponent(f: ComponentFeatures, specialistClasses: readonly string[], policy: ComponentPolicy = COMPONENT_POLICY_V1): PriorityAssessment {
  const w = policy.weights; const c: Contribution[] = []; const flags: string[] = [];
  const add = (feature: string, raw: string, weight: number, fraction: number, reason: string) => c.push({ feature, raw, weight, points: round(weight * fraction), reason });
  const unexploredShare = specialistClasses.length ? f.pendingClasses.length / specialistClasses.length : 0;
  add("unexplored", `${f.pendingClasses.length}/${specialistClasses.length} specialist classes not examined at this content hash`, w.unexplored, unexploredShare,
    "classes the available specialists have not yet examined on this exact component version are worth examining");
  add("entry-points", `${f.entryPoints}`, w.entryPoints, clamp(Math.log2(1 + f.entryPoints) / 5), "more externally reachable functions, more attack surface (log-scaled)");
  add("external-calls", `${f.externalCalls}`, w.externalCalls, clamp(Math.log2(1 + f.externalCalls) / 4), "calls leaving the component are where control and value cross a trust boundary");
  add("unguarded-writes", `${f.unguardedWrites}`, w.unguardedWrites, clamp(f.unguardedWrites / 4), "state-writing entry points without a caller check are reachable by anyone");
  add("cost", `${f.functions} functions`, -w.costPenalty, clamp(Math.log2(1 + f.functions) / 7), "larger components cost more to examine");
  if (f.entryPoints === 0) flags.push("no entry points (library or internal-only)");
  const raw = c.reduce((s, x) => s + x.points, 0);
  const max = w.unexplored + w.entryPoints + w.externalCalls + w.unguardedWrites;
  const inputsSha256 = createHash("sha256").update(JSON.stringify({ f, specialistClasses, policy })).digest("hex");
  return { id: f.id, score: round(clamp(raw / max) * 100), contributions: c, flags, explorationCandidate: f.examinedClasses.length === 0, unexploredShare: round(unexploredShare), policyVersion: policy.version, inputsSha256 };
}
