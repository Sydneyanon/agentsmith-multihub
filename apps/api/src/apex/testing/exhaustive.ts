/**
 * PROTOTYPE (docs/architecture/apex-first-capability.md §10.2 item 1). Compares the explorer's coverage (its honest and adversarial
 * breadth-first searches, with the explorer's argument domain and depth) against EXHAUSTIVE enumeration of a small finite domain run to a
 * fixpoint (no new state), on contracts small enough for that to terminate. Self-authored contracts only; this measures the search, not
 * detection quality. Not wired anywhere.
 */
import type { CoverageCollector } from "./coverage.js";
import { exploreDeep } from "./deep-explorer.js";
import { bfs, Engine, ETHER, EXPLORER_DOMAIN, type Domain, type ExploreOptions } from "./state-explorer-prototype.js";

export const EXHAUSTIVE_DOMAIN: Domain = { amounts: [0n, ETHER, 2n * ETHER], values: [0n, ETHER], bools: [false, true], addresses: "actors" };

type Side = { states: number; abstractStates: number; transitions: number; guardSides: number; statements: number; completedFunctions: string[] };
export type CoverageGap = {
  contract: string;
  explorer: Side & { depth: number };
  exhaustive: Side & { depthReached: number; fixpoint: boolean; sequences: number };
  gap: {
    statesMissed: number; abstractStatesMissed: number; transitionsMissed: number;
    guardSidesMissed: string[]; statementsMissed: string[]; functionsNeverCompletedByExplorer: string[];
    /** fractions of what exhaustive enumeration reached that the explorer also reached */
    stateCoverage: number; abstractStateCoverage: number; transitionCoverage: number; guardSideCoverage: number;
    /** sanity: the explorer reached nothing the exhaustive search did not (its domain is a subset); must be 0 */
    explorerOnly: number;
  };
};

type Union = { concrete: Set<string>; abstract: Set<string>; transitions: Set<string>; sides: Set<string>; reached: Set<string>; completed: Set<string> };
function union(cols: CoverageCollector[]): Union {
  const u: Union = { concrete: new Set(), abstract: new Set(), transitions: new Set(), sides: new Set(), reached: new Set(), completed: new Set() };
  for (const c of cols) {
    c.concrete.forEach((k) => u.concrete.add(k)); c.abstract.forEach((k) => u.abstract.add(k)); c.transitions.forEach((k) => u.transitions.add(k));
    c.reached.forEach((k) => u.reached.add(k));
    for (const [at, g] of c.guards) { if (g.passed) u.sides.add(`${at}:passes`); if (g.failed) u.sides.add(`${at}:fails`); }
    for (const f of c.finish().functions) if (f.completed > 0) u.completed.add(f.name);
  }
  return u;
}
const side = (u: Union): Side => ({ states: u.concrete.size, abstractStates: u.abstract.size, transitions: u.transitions.size, guardSides: u.sides.size, statements: u.reached.size, completedFunctions: [...u.completed].sort() });
const minus = <T>(a: Set<T>, b: Set<T>): T[] => [...a].filter((k) => !b.has(k));
const frac = <T>(x: Set<T>, e: Set<T>): number => (e.size ? [...x].filter((k) => e.has(k)).length / e.size : 1);

/**
 * `explore` selects the explorer being measured: by default the deep strategy with its default options (its honest and adversarial
 * layered searches, exactly as `exploreStateInvariants` runs them); `{ strategy: "baseline" }` measures the baseline's two breadth-first
 * searches at `depth` (default 3), as before.
 */
export function compareWithExhaustive(sources: ReadonlyArray<{ path: string; text: string }>, contract: string, options: { depth?: number; maxDepth?: number; maxSequences?: number; domain?: Domain; explore?: ExploreOptions } = {}): CoverageGap {
  const maxDepth = options.maxDepth ?? 12; const maxSequences = options.maxSequences ?? 400_000;
  const engine = new Engine(sources, contract); if (!engine.root) throw new Error(`cannot deploy ${contract}: ${engine.abstained}`);
  const baseline = options.explore?.strategy === "baseline";
  const deep = baseline ? null : exploreDeep(sources, contract, options.explore ?? {});
  const depth = deep ? (deep.report.search?.acceptingDepth ?? 0) : (options.depth ?? options.explore?.depth ?? 3);
  // explorer: exactly the searches whose coverage the explorer reports
  const x = union(deep ? deep.collectors : [false, true].map((adversarial) => bfs(engine, EXPLORER_DOMAIN(adversarial), depth, maxSequences, () => {})));
  const exCol = bfs(engine, options.domain ?? EXHAUSTIVE_DOMAIN, maxDepth, maxSequences, () => {});
  const e = union([exCol]);
  return {
    contract,
    explorer: { ...side(x), depth },
    exhaustive: { ...side(e), depthReached: exCol.depthReached, fixpoint: exCol.fixpoint, sequences: exCol.sequences },
    gap: {
      statesMissed: minus(e.concrete, x.concrete).length, abstractStatesMissed: minus(e.abstract, x.abstract).length, transitionsMissed: minus(e.transitions, x.transitions).length,
      guardSidesMissed: minus(e.sides, x.sides).sort(), statementsMissed: minus(e.reached, x.reached).sort(), functionsNeverCompletedByExplorer: minus(e.completed, x.completed).sort(),
      stateCoverage: frac(x.concrete, e.concrete), abstractStateCoverage: frac(x.abstract, e.abstract), transitionCoverage: frac(x.transitions, e.transitions), guardSideCoverage: frac(x.sides, e.sides),
      explorerOnly: minus(x.concrete, e.concrete).length,
    },
  };
}
