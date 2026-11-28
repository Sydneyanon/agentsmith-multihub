import type { NormalizedOpportunity } from "./types.js";

/**
 * A deliberately simple, deterministic first ordering so the operator sees the freshest, actionable items first.
 * It is NOT the Adaptive Research Priority Engine (a later roadmap capability that will learn from outcomes); every point has a reason.
 */
export function scoreOpportunity(item: Pick<NormalizedOpportunity, "closed" | "createdAt" | "repositoryCandidates" | "details">, now: Date): { score: number; reasons: string[] } {
  if (item.closed) return { score: 0, reasons: ["closed or archived at the source"] };
  let score = 0;
  const reasons: string[] = [];
  if (item.repositoryCandidates.length > 0) { score += 40; reasons.push("has a candidate repository (+40)"); }
  const created = item.createdAt ? Date.parse(item.createdAt) : NaN;
  if (Number.isFinite(created)) {
    const days = (now.getTime() - created) / 86_400_000;
    if (days >= 0 && days <= 7) { score += 40; reasons.push("created in the last 7 days (+40)"); }
    else if (days > 7 && days <= 30) { score += 20; reasons.push("created in the last 30 days (+20)"); }
  }
  const description = typeof item.details.description === "string" ? item.details.description : "";
  if (/\b(audit|contest|bounty|competition)\b/i.test(description)) { score += 10; reasons.push("description mentions an audit, contest or bounty (+10)"); }
  return { score: Math.min(100, score), reasons };
}
