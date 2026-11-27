import type { Db } from "./decisions.js";
import { sameVersionSnapshots } from "./loop.js";

/**
 * Compare specialists on one version (T-203): which capability examined which component and class, which capability produced which
 * lead, which leads several capabilities found independently, and where a capability examined a component for a class and found
 * nothing that another capability did find there ("examined, not found": a CANDIDATE miss for that capability, which becomes the
 * outcome `missed` only through a human). Read-only; computed from the durable records, so it is replayable.
 */
export type LeadCluster = {
  contract: string; function: string; class: string;
  foundBy: Array<{ capability: string; hypothesisId: string }>;
  examinedNotFoundBy: string[];
  evidence: { technicalSupports: number; modelReviews: Record<string, number>; humanOutcome: string | null };
};
export type Comparison = { snapshot: string; capabilities: Record<string, { components: number; classes: string[]; leads: number }>; clusters: LeadCluster[]; uniqueFinds: Record<string, number> };

export async function compareSpecialists(db: Db, snapshotId: string): Promise<Comparison> {
  const version = await sameVersionSnapshots(db, snapshotId);
  const cov = (await db.query<{ method: string; component_name: string; cls: string }>(
    `SELECT DISTINCT c.method, c.component_name, c.vulnerability_class cls FROM research_coverage c WHERE c.snapshot_id = ANY($1::uuid[]) AND c.result = 'examined'`, [version])).rows;
  const leads = (await db.query<{ cap: string; lead: { hypothesisId: string; class: string; contract: string; function: string } }>(
    `SELECT s.output->'capability'->>'id' cap, l lead FROM workflow_steps s, jsonb_array_elements(s.output->'leads') l
      WHERE s.status = 'succeeded' AND jsonb_typeof(s.output->'leads') = 'array' AND s.output ? 'capability' AND (s.output->>'snapshot_id')::uuid = ANY($1::uuid[])`, [version])).rows;
  const ev = new Map((await db.query<{ id: string; tech: string; mrev: Record<string, number> | null; outcome: string | null }>(
    `SELECT h.id,
            (SELECT count(*) FROM hypothesis_evaluations e WHERE e.hypothesis_id = h.id AND e.outcome = 'supports' AND e.evaluator_id <> h.generator_id) tech,
            (SELECT jsonb_object_agg(v, n) FROM (SELECT r.verdict v, count(*) n FROM hypothesis_reviews r WHERE r.hypothesis_id = h.id AND r.reviewer_kind IN ('model','attended_model') GROUP BY 1) x) mrev,
            (SELECT o.category FROM hypothesis_outcomes o WHERE o.hypothesis_id = h.id ORDER BY o.created_at DESC LIMIT 1) outcome
       FROM hypotheses h WHERE h.snapshot_id = ANY($1::uuid[])`, [version])).rows.map((r) => [r.id, r]));
  // a cluster is one (contract, function, class); a lead without a function clusters at contract level
  const clusters = new Map<string, LeadCluster>();
  for (const { cap, lead } of leads) {
    const key = `${lead.contract}|${lead.function}|${lead.class}`;
    const c = clusters.get(key) ?? { contract: lead.contract, function: lead.function, class: lead.class, foundBy: [], examinedNotFoundBy: [], evidence: { technicalSupports: 0, modelReviews: {}, humanOutcome: null } };
    if (!c.foundBy.some((f) => f.capability === cap)) c.foundBy.push({ capability: cap, hypothesisId: lead.hypothesisId });
    const e = ev.get(lead.hypothesisId);
    if (e) { c.evidence.technicalSupports += Number(e.tech); for (const [v, n] of Object.entries(e.mrev ?? {})) c.evidence.modelReviews[v] = (c.evidence.modelReviews[v] ?? 0) + Number(n); c.evidence.humanOutcome ??= e.outcome; }
    clusters.set(key, c);
  }
  for (const c of clusters.values()) {
    const found = new Set(c.foundBy.map((f) => f.capability));
    c.examinedNotFoundBy = [...new Set(cov.filter((x) => x.component_name === c.contract && x.cls === c.class && !found.has(x.method)).map((x) => x.method))].sort();
  }
  const capabilities: Comparison["capabilities"] = {};
  for (const x of cov) { const k = (capabilities[x.method] ??= { components: 0, classes: [], leads: 0 }); if (!k.classes.includes(x.cls)) k.classes.push(x.cls); }
  for (const [m, v] of Object.entries(capabilities)) v.components = new Set(cov.filter((x) => x.method === m).map((x) => x.component_name)).size;
  for (const { cap } of leads) (capabilities[cap] ??= { components: 0, classes: [], leads: 0 }).leads++;
  const uniqueFinds: Record<string, number> = {};
  const list = [...clusters.values()].sort((a, b) => b.foundBy.length - a.foundBy.length || a.contract.localeCompare(b.contract) || a.function.localeCompare(b.function));
  for (const c of list) if (c.foundBy.length === 1) uniqueFinds[c.foundBy[0]!.capability] = (uniqueFinds[c.foundBy[0]!.capability] ?? 0) + 1;
  return { snapshot: snapshotId, capabilities, clusters: list, uniqueFinds };
}
