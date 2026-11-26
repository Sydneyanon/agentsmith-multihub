import { coverageComponents, type ProtocolModel } from "../analysis/solidity/protocol-model.js";
import type { CoverageRecord } from "./coverage.js";
import type { ComponentCoverage } from "./score.js";

/**
 * P1 consumer for priority SCORING (score.ts): the per-component input of an opportunity comes from the shared protocol model plus
 * recorded research, never from a hand-built or privately derived component list. A component counts as researched only at the content
 * hashes research was recorded against (version-aware); classes examined are those recorded at the component's CURRENT hash.
 */
export function scoringComponentsFromModel(model: ProtocolModel, records: readonly CoverageRecord[]): ComponentCoverage[] {
  return coverageComponents(model).map((c) => {
    const mine = records.filter((r) => r.componentId === c.id);
    return {
      id: c.id, contentSha256: c.contentSha256,
      researchedAtHashes: [...new Set(mine.map((r) => r.contentSha256))].sort(),
      classesExamined: [...new Set(mine.filter((r) => r.contentSha256 === c.contentSha256).flatMap((r) => r.classesExamined))].sort(),
    };
  });
}
