/**
 * Outcome categories (owner decision 2026-11-26). They are kept distinct; ONLY `confirmed` is a successful discovery label.
 * Refuted, inconclusive, duplicate and missed outcomes are evidence, never collapsed into confirmed.
 */
export type OutcomeCategory = "confirmed" | "refuted" | "inconclusive" | "duplicate" | "missed";
export type Outcome = {
  id: string; category: OutcomeCategory;
  /** validated by a method independent of the component that produced the hypothesis (compiler-backed reproduction, independent review ...) */
  independentlyValidated: boolean;
  /** decided by a human adjudicator under their own identity */
  humanAdjudicated: boolean;
  vulnerabilityClass: string; target: string; recordedAt: string;
};
export const OUTCOME_CATEGORIES: readonly OutcomeCategory[] = ["confirmed", "refuted", "inconclusive", "duplicate", "missed"];

/** "Confirmed" means independently validated AND human-adjudicated; anything else labelled confirmed is rejected, not silently accepted. */
export function assertWellFormed(o: Outcome): void {
  if (!OUTCOME_CATEGORIES.includes(o.category)) throw new Error(`unknown outcome category ${String(o.category)}`);
  if (o.category === "confirmed" && !(o.independentlyValidated && o.humanAdjudicated)) throw new Error(`outcome ${o.id} is labelled confirmed without independent validation and human adjudication`);
}

/** The only positive labels learning may use (T-056). Everything else is returned separately as evidence, never as a success. */
export function splitForLearning(outcomes: readonly Outcome[]): { discoveryLabels: Outcome[]; evidence: Record<Exclude<OutcomeCategory, "confirmed">, Outcome[]> } {
  const evidence = { refuted: [] as Outcome[], inconclusive: [] as Outcome[], duplicate: [] as Outcome[], missed: [] as Outcome[] };
  const discoveryLabels: Outcome[] = [];
  for (const o of outcomes) { assertWellFormed(o); if (o.category === "confirmed") discoveryLabels.push(o); else evidence[o.category].push(o); }
  return { discoveryLabels, evidence };
}
