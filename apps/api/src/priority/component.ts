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
  weights: { unexplored: number; entryPoints: number; externalCalls: number; unguardedWrites: number; specialistSurface: number; costPenalty: number };
};
export const COMPONENT_POLICY_V1: ComponentPolicy = {
  version: "component-priority/3",
  weights: { unexplored: 50, entryPoints: 15, externalCalls: 20, unguardedWrites: 15, specialistSurface: 15, costPenalty: 10 },
};

/** What memory says about one component at one content hash: which capability examined which class, and where a capability abstained. */
export type ComponentMemory = {
  componentSha256: string;
  examined: Array<{ cls: string; method: string }>;
  /** a tool that failed here (version-specific): not retried by the same capability version */
  abstained: Array<{ cls: string; method: string; version: string }>;
};
/** A capability as the priority sees it: identity and the classes it examines (from engine/capabilities.ts). */
export type CapabilityRef = { id: string; version: string; classes: readonly string[] };

export type ComponentFeatures = {
  id: string; contract: string; file: string; contentSha256: string;
  entryPoints: number; externalCalls: number; unguardedWrites: number; functions: number;
  /** P2 state roles: variables classified as a ledger or an aggregate (accounting state) */
  ledgerVars: number;
  /** array-typed state variables (lists that loops or push payments may walk) */
  listVars: number;
  /** rank given to this component by an imported scoping map (1 = most worth attention), or null when no map ranks it */
  surfaceRank: number | null; surfaceSource: string | null;
  /** classes examined here by any capability */
  examinedClasses: string[];
  /** per available capability: the classes IT has not examined at this content hash (complementary machines each get their turn) */
  pendingByCapability: Record<string, string[]>;
  pendingPairs: number;
};

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number) => Math.round(x * 100) / 100 + 0;
const OUTWARD = new Set(["external", "low-level-call", "delegatecall", "send", "transfer"]);

/** Facts per coverage component, read from the protocol model only (no private re-derivation). */
/** A scoping specialist's ranked attack surface: contract name -> best rank, with the record it came from. */
export type SurfaceMap = { ranks: ReadonlyMap<string, number>; source: string };

export function componentFeatures(model: ProtocolModel, memory: readonly ComponentMemory[], caps: readonly CapabilityRef[], surface: SurfaceMap | null = null): ComponentFeatures[] {
  return coverageComponents(model).map((c) => {
    const contract = c.id.slice(c.id.lastIndexOf("#") + 1); const file = c.id.slice(0, c.id.lastIndexOf("#"));
    const fns = model.functions.filter((f) => f.component === contract);
    const entries = fns.filter((f) => f.entryPoint);
    const calls = new Set<string>();
    for (const f of entries) for (const e of reachableCalls(model, f.id)) if (OUTWARD.has(e.kind)) calls.add(`${e.from}->${e.to}@${e.evidence.file}:${e.evidence.lineStart}`);
    const mem = memory.filter((m) => m.componentSha256 === c.contentSha256);
    const examined = [...new Set(mem.flatMap((m) => m.examined.map((x) => x.cls)))].sort();
    const pendingByCapability: Record<string, string[]> = {};
    for (const cap of caps) {
      const done = new Set(mem.flatMap((m) => m.examined.filter((x) => x.method === cap.id).map((x) => x.cls)));
      const gaveUp = new Set(mem.flatMap((m) => m.abstained.filter((x) => x.method === cap.id && x.version === cap.version).map((x) => x.cls)));
      const pending = cap.classes.filter((k) => !done.has(k) && !gaveUp.has(k));
      if (pending.length) pendingByCapability[cap.id] = [...pending];
    }
    return {
      id: c.id, contract, file, contentSha256: c.contentSha256,
      entryPoints: entries.length, externalCalls: calls.size, unguardedWrites: entries.filter((f) => f.stateWrites.length > 0 && !f.callerGuarded).length, functions: fns.length,
      ledgerVars: (model.stateRoles.byComponent.find((b) => b.component === contract)?.variables ?? []).filter((v) => v.roles.some((r) => r.role === "ledger" || r.role === "aggregate")).length,
      listVars: (model.components.find((x) => x.id === contract)?.stateVariables ?? []).filter((v) => /\[\]$/.test(v.type)).length,
      surfaceRank: surface?.ranks.get(contract) ?? null, surfaceSource: surface && surface.ranks.has(contract) ? surface.source : null,
      examinedClasses: examined, pendingByCapability, pendingPairs: Object.values(pendingByCapability).reduce((n, v) => n + v.length, 0),
    };
  });
}

/** Total (capability, class) pairs the available capabilities could examine on one component. */
export const totalPairs = (caps: readonly CapabilityRef[]) => caps.reduce((n, c) => n + c.classes.length, 0);

export function scoreComponent(f: ComponentFeatures, pairs: number, policy: ComponentPolicy = COMPONENT_POLICY_V1): PriorityAssessment {
  const w = policy.weights; const c: Contribution[] = []; const flags: string[] = [];
  const add = (feature: string, raw: string, weight: number, fraction: number, reason: string) => c.push({ feature, raw, weight, points: round(weight * fraction), reason });
  const unexploredShare = pairs ? f.pendingPairs / pairs : 0;
  add("unexplored", `${f.pendingPairs}/${pairs} (capability, class) pairs not examined at this content hash`, w.unexplored, unexploredShare,
    "classes the available specialists have not yet examined on this exact component version are worth examining");
  add("entry-points", `${f.entryPoints}`, w.entryPoints, clamp(Math.log2(1 + f.entryPoints) / 5), "more externally reachable functions, more attack surface (log-scaled)");
  add("external-calls", `${f.externalCalls}`, w.externalCalls, clamp(Math.log2(1 + f.externalCalls) / 4), "calls leaving the component are where control and value cross a trust boundary");
  add("unguarded-writes", `${f.unguardedWrites}`, w.unguardedWrites, clamp(f.unguardedWrites / 4), "state-writing entry points without a caller check are reachable by anyone");
  add("specialist-surface", f.surfaceRank === null ? "not ranked by a scoping map" : `rank ${f.surfaceRank} (${f.surfaceSource})`, w.specialistSurface, f.surfaceRank === null ? 0 : clamp(1 - (f.surfaceRank - 1) / 8),
    "a scoping specialist ranked this component's attack surface (a model judgement, used only to order work, never as evidence)");
  add("cost", `${f.functions} functions`, -w.costPenalty, clamp(Math.log2(1 + f.functions) / 7), "larger components cost more to examine");
  if (f.entryPoints === 0) flags.push("no entry points (library or internal-only)");
  const raw = c.reduce((s, x) => s + x.points, 0);
  const max = w.unexplored + w.entryPoints + w.externalCalls + w.unguardedWrites + w.specialistSurface;
  const inputsSha256 = createHash("sha256").update(JSON.stringify({ f, pairs, policy })).digest("hex");
  return { id: f.id, score: round(clamp(raw / max) * 100), contributions: c, flags, explorationCandidate: f.examinedClasses.length === 0, unexploredShare: round(unexploredShare), policyVersion: policy.version, inputsSha256 };
}
