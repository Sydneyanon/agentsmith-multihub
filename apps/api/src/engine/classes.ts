import type { FindingClass } from "../analysis/solidity/specialists.js";

/**
 * The vulnerability classes the research loop tracks in memory. Two kinds, never mixed:
 * - SPECIALIST_CLASSES: what the deterministic Solidity specialists can actually examine. Coverage for these is `examined`.
 * - NOT_MODELLED_CLASSES: classes AgentSmith tracks but has no specialist for. Coverage for these is recorded as `not_modelled`, so the
 *   memory says "nobody looked" instead of implying a clean result. The structural analyzer cannot see precision or accounting bugs.
 */
const IMPLEMENTED = { "reentrancy": true, "access-control": true, "initializer": true, "delegatecall": true, "unchecked-call": true, "selfdestruct": true, "tx-origin": true } as const satisfies Record<FindingClass, true>;
export const SPECIALIST_CLASSES: readonly FindingClass[] = Object.keys(IMPLEMENTED) as FindingClass[];
export const NOT_MODELLED_CLASSES = ["arithmetic-precision", "accounting-invariant", "oracle-manipulation", "economic-incentive", "liveness"] as const;
