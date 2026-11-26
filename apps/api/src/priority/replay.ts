/**
 * Offline replay harness (T-057). It compares selection strategies on a FROZEN scenario: a day-by-day history of opportunities, component
 * versions and a ground truth of how many confirmed findings each component version holds. No network, no database, no randomness except
 * seeded draws, so a run is fully reproducible.
 *
 * Read the output honestly: with SYNTHETIC scenarios (the only ones that exist today) the result tests the harness and illustrates the
 * policies' behaviour; it is NOT evidence that any strategy finds more real vulnerabilities. Real comparison needs replayed histories with
 * independently confirmed outcomes (design section 7), and the engine must beat these baselines there before it steers real capacity.
 */
import { POLICY_V1, type PriorityPolicy } from "./policy.js";
import { allocate, scoreOpportunity, type OpportunityInput } from "./score.js";

export type ReplayComponent = { id: string; versions: Array<{ fromDay: number; hash: string }> };
export type ReplayItem = {
  id: string; publishedDay: number; deadlineDay: number | null; maxRewardUsd: number | null; costUnits: number;
  components: ReplayComponent[];
};
export type ReplayScenario = {
  name: string; synthetic: boolean; days: number; slotsPerDay: number; items: ReplayItem[];
  /** ground truth, hidden from every strategy except the oracle: confirmed findings held by `${componentId}@${hash}` */
  findings: Record<string, number>;
};
export type StrategyName = "random" | "newest-first" | "highest-reward-first" | "round-robin" | "engine-v1";
export type Pick = { day: number; itemId: string; mode: "exploit" | "explore" | "baseline"; cost: number; findings: number; /** engine only: the explained score it acted on */ score?: number };
export type ReplayMetrics = {
  strategy: string; synthetic: boolean; picks: number; cost: number; confirmedFindings: number; findingsPerCostUnit: number;
  dayOfFirstConfirmed: number | null;
  /** share of changed component versions (any version after a component's first) that were researched by the end */
  changedCodeCoverage: number;
  /** engine only: findings per exploration pick (null for strategies without exploration) */
  explorationYield: number | null;
  /** oracle findings minus this strategy's findings, for the same capacity */
  regret: number;
};

const DAY0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (day: number) => new Date(DAY0 + day * 86_400_000).toISOString();
const versionAt = (c: ReplayComponent, day: number) => [...c.versions].filter((v) => v.fromDay <= day).sort((a, b) => b.fromDay - a.fromDay)[0];
function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

type State = { researched: Map<string, Set<string>>; lastPicked: Map<string, number>; remaining: Map<string, number> };

function available(s: ReplayScenario, day: number): ReplayItem[] {
  return s.items.filter((i) => i.publishedDay <= day && (i.deadlineDay === null || i.deadlineDay >= day));
}
/** what a strategy may see about an item: never the ground truth */
function toInput(i: ReplayItem, day: number, st: State): OpportunityInput {
  const comps = i.components.map((c) => { const v = versionAt(c, day); return v ? { id: c.id, contentSha256: v.hash, researchedAtHashes: [...(st.researched.get(c.id) ?? [])], classesExamined: [] } : null; }).filter((x) => x !== null);
  const changeDays = i.components.flatMap((c) => c.versions.map((v) => v.fromDay)).filter((d) => d > i.publishedDay && d <= day);
  return {
    id: i.id, title: i.id, maxRewardUsd: i.maxRewardUsd, deadline: i.deadlineDay === null ? null : iso(i.deadlineDay), publishedAt: iso(i.publishedDay),
    lastMaterialChangeAt: changeDays.length ? iso(Math.max(...changeDays)) : null, scopeVerified: true, eligibilityKnown: true, repositoryVerified: true,
    currentCommit: comps.map((c) => c.contentSha256).join("+"), components: comps, audits: [], estimatedCostUnits: i.costUnits,
  };
}
function research(i: ReplayItem, day: number, st: State, s: ReplayScenario): number {
  let found = 0;
  for (const c of i.components) {
    const v = versionAt(c, day); if (!v) continue;
    const set = st.researched.get(c.id) ?? new Set<string>(); st.researched.set(c.id, set);
    set.add(v.hash);
    // the single guard against double counting: a component version's findings are consumed the first time it is researched
    const key = `${c.id}@${v.hash}`; const n = st.remaining.get(key) ?? 0; found += n; st.remaining.set(key, 0);
  }
  st.lastPicked.set(i.id, day);
  return found;
}

export function replay(s: ReplayScenario, strategy: StrategyName | "oracle", seed = 1, policy: PriorityPolicy = POLICY_V1): { metrics: ReplayMetrics; picks: Pick[] } {
  const st: State = { researched: new Map(), lastPicked: new Map(), remaining: new Map(Object.entries(s.findings)) };
  const picks: Pick[] = []; const r = rng(seed);
  for (let day = 0; day < s.days; day++) {
    const pool = available(s, day); if (!pool.length) continue;
    let chosen: Array<{ item: ReplayItem; mode: Pick["mode"]; score?: number }>;
    const take = (xs: ReplayItem[]) => xs.slice(0, s.slotsPerDay).map((item) => ({ item, mode: "baseline" as const }));
    if (strategy === "random") { const p = [...pool]; const out: ReplayItem[] = []; while (p.length && out.length < s.slotsPerDay) out.push(p.splice(Math.floor(r() * p.length), 1)[0]!); chosen = take(out); }
    else if (strategy === "newest-first") chosen = take([...pool].sort((a, b) => b.publishedDay - a.publishedDay || a.id.localeCompare(b.id)));
    else if (strategy === "highest-reward-first") chosen = take([...pool].sort((a, b) => (b.maxRewardUsd ?? -1) - (a.maxRewardUsd ?? -1) || a.id.localeCompare(b.id)));
    else if (strategy === "round-robin") chosen = take([...pool].sort((a, b) => (st.lastPicked.get(a.id) ?? -1) - (st.lastPicked.get(b.id) ?? -1) || a.id.localeCompare(b.id)));
    else if (strategy === "oracle") {
      // sees the ground truth: remaining findings per cost at current versions (an upper reference, not a strategy anyone can run)
      const value = (i: ReplayItem) => i.components.reduce((n, c) => { const v = versionAt(c, day); return n + (v && !(st.researched.get(c.id)?.has(v.hash)) ? (st.remaining.get(`${c.id}@${v.hash}`) ?? 0) : 0); }, 0) / i.costUnits;
      chosen = take([...pool].sort((a, b) => value(b) - value(a) || a.id.localeCompare(b.id)));
    } else {
      const now = new Date(Date.parse(iso(day)));
      const assessments = pool.map((i) => scoreOpportunity(toInput(i, day, st), now, policy));
      const alloc = allocate(assessments, Math.min(s.slotsPerDay, pool.length), seed + day, policy);
      chosen = alloc.allocations.map((a) => ({ item: pool.find((i) => i.id === a.id)!, mode: a.mode, score: a.score }));
    }
    for (const { item, mode, score } of chosen) picks.push({ day, itemId: item.id, mode, cost: item.costUnits, findings: research(item, day, st, s), ...(score === undefined ? {} : { score }) });
  }
  const confirmed = picks.reduce((n, p) => n + p.findings, 0); const cost = picks.reduce((n, p) => n + p.cost, 0);
  // changed code = every version of a component after its first one (a new item's initial code is not a change)
  const changed = s.items.flatMap((i) => i.components.flatMap((c) => [...c.versions].sort((a, b) => a.fromDay - b.fromDay).slice(1).filter((v) => v.fromDay < s.days).map((v) => [c.id, v.hash] as const)));
  const explore = picks.filter((p) => p.mode === "explore");
  const oracle = strategy === "oracle" ? confirmed : replay(s, "oracle", seed, policy).metrics.confirmedFindings;
  return {
    picks,
    metrics: {
      strategy, synthetic: s.synthetic, picks: picks.length, cost, confirmedFindings: confirmed,
      findingsPerCostUnit: cost ? Math.round((confirmed / cost) * 10000) / 10000 : 0,
      dayOfFirstConfirmed: picks.find((p) => p.findings > 0)?.day ?? null,
      changedCodeCoverage: changed.length ? Math.round((changed.filter(([c, h]) => st.researched.get(c)?.has(h)).length / changed.length) * 1000) / 1000 : 1,
      explorationYield: strategy === "engine-v1" ? (explore.length ? Math.round((explore.reduce((n, p) => n + p.findings, 0) / explore.length) * 1000) / 1000 : 0) : null,
      regret: oracle - confirmed,
    },
  };
}

export const BASELINES: readonly StrategyName[] = ["random", "newest-first", "highest-reward-first", "round-robin"];
export function compare(s: ReplayScenario, seed = 1): ReplayMetrics[] {
  return [...BASELINES, "engine-v1" as const].map((k) => replay(s, k, seed).metrics);
}
