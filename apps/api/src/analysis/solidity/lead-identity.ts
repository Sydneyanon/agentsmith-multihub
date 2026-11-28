import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { analysisIdentity, evaluationRelation, generatorFamily, type EvaluationRelation } from "../../analysis-identity.js";
import { canonicalJson } from "../../research-state.js";

/**
 * C2: ONE identity for the same potential issue across engines and across snapshots of a repository.
 *
 * The LEAD KEY is derived in code from (repository, vulnerability class, file path, contract, function name). It contains no line number,
 * no snapshot, no commit and no generator, so it survives line shifts and is the same whichever engine reports the issue and at whichever
 * commit. It is stored only inside existing JSON (`lead_keys` in the producing step's output); there is no new table and no migration.
 *
 * An INVESTIGATION is the set of hypotheses of one snapshot that share a lead key. Hypotheses are never merged, edited or deleted (0007 is
 * append-only): each engine's claim stays its own row with its own generator, analysis family, evidence spans and evaluations. The
 * investigation only GROUPS them, so that
 *  - the dossier counts one finding, not one per engine;
 *  - every engine's evidence stays separately attributable;
 *  - disagreement is recorded as a contradiction with BOTH sides kept, never averaged or dropped;
 *  - the independence rules are untouched: evaluations still belong to one hypothesis, an evaluator that is the generator is still refused
 *    (research-state.ts IndependenceError and the 0016 trigger), and at the investigation level an evaluator that shares a family with ANY
 *    contributing generator counts as same-family corroboration, never as independent confirmation. Two generators of different families
 *    agreeing is independent GENERATION; it is not validation.
 *
 * Known limit, by design of the anchor: two distinct issues of the same class in the same function share a key. They stay two hypotheses
 * inside one investigation; nothing is lost, but they are counted once.
 */
export const LEAD_KEY_SCHEMA = "agentsmith-lead-key/1";
export type LeadAnchor = { repository: string; class: string; file: string; contract: string; function: string };

/** `withdraw(uint256)` and `withdraw` are the same anchor; a contract-level lead has the empty function. */
export const normaliseFunction = (fn: string): string => fn.trim().replace(/\(.*$/s, "").replace(/^.*\./, "");
export function normaliseAnchor(a: LeadAnchor): LeadAnchor {
  return { repository: a.repository.trim().toLowerCase(), class: a.class.trim().toLowerCase(), file: a.file.trim().replace(/^\.\//, ""), contract: a.contract.trim().replace(/@.*$/, ""), function: normaliseFunction(a.function) };
}
export function leadKey(anchor: LeadAnchor): string {
  const a = normaliseAnchor(anchor);
  return createHash("sha256").update(canonicalJson([LEAD_KEY_SCHEMA, a.repository, a.class, a.file, a.contract, a.function])).digest("hex");
}
/** How a producing step records its lead keys: one entry per hypothesis, ordered by key (so the record does not depend on the order of ids). */
export type LeadKeyEntry = { hypothesis_id: string; lead_key: string };
export const leadKeysOf = (repository: string, leads: ReadonlyArray<{ id: string; class: string; file: string; contract: string; function: string }>): LeadKeyEntry[] =>
  leads.map((l) => ({ hypothesis_id: l.id, lead_key: leadKey({ repository, class: l.class, file: l.file, contract: l.contract, function: l.function }) }))
    .sort((a, b) => (a.lead_key < b.lead_key ? -1 : a.lead_key > b.lead_key ? 1 : a.hypothesis_id < b.hypothesis_id ? -1 : 1));

export type Stance = "asserts" | "supports" | "weakens" | "contradicts" | "inconclusive";
export type InvestigationEvaluation = { evaluation_id: string; evaluator: string; analysis_family: string | null; method: string | null; outcome: string; rationale: string;
  /** relation to the generator of the hypothesis it evaluates (the existing 0016 rule, unchanged) */
  relation: EvaluationRelation;
  /** relation to the WHOLE investigation: same-family when it shares a family with any contributing generator */
  relation_to_investigation: EvaluationRelation };
export type Contribution = {
  hypothesis_id: string; generator: string; generator_kind: string; analysis_family: string | null; method: string | null; produced_by_step: string | null;
  claim: string; evidence: Array<{ path: string; lines: string; role: string }>; evaluations: InvestigationEvaluation[];
};
export type Contradiction = {
  kind: "refuted_by_another_engine" | "weakened_by_another_engine" | "evaluators_disagree";
  for: { engine: string; analysis_family: string | null; stance: Stance; hypothesis_id: string };
  against: { engine: string; analysis_family: string | null; stance: Stance; hypothesis_id: string; evaluation_id: string };
  /** whether the two sides read the code through different analysis families (a disagreement inside one family is weaker information) */
  families: "cross-family" | "same-family" | "unknown-family";
  note: string;
};
const familyRelation = (a: string | null, b: string | null): Contradiction["families"] => (a === null || b === null ? "unknown-family" : a === b ? "same-family" : "cross-family");
export type Investigation = {
  lead_key: string; keyed: boolean; anchor: LeadAnchor | null;
  contributions: Contribution[];
  generators: string[]; generator_families: string[];
  /** two or more generators of DIFFERENT known families reported this lead on their own: independent generation, not validation */
  independent_generation: boolean;
  corroboration: { same_family: number; cross_family: number; unknown_family: number };
  contradictions: Contradiction[];
  assessment: "contradicted" | "weakened" | "supported_cross_family" | "corroborated_same_family" | "supported_unknown_family" | "open";
  note: string;
};

type StepLeads = { step_key: string; keys: Record<string, string>; anchors: Map<string, LeadAnchor> };

/** The lead keys the producing steps of a run recorded (analysis: the specialists' leads; slither_scan: Slither's), with their anchors. */
async function recordedLeadKeys(db: Pick<Pool, "query">, runId: string, repository: string): Promise<StepLeads[]> {
  const rows = (await db.query<{ step_key: string; output: { lead_keys?: unknown; leads?: unknown; finding_payloads?: Record<string, unknown> } | null }>(
    "SELECT step_key, output FROM workflow_steps WHERE workflow_run_id = $1 AND status = 'succeeded' AND output ? 'lead_keys' ORDER BY sequence", [runId])).rows;
  const out: StepLeads[] = [];
  for (const r of rows) {
    const keys: Record<string, string> = {}; const anchors = new Map<string, LeadAnchor>();
    for (const e of Array.isArray(r.output?.lead_keys) ? (r.output.lead_keys as Array<Partial<LeadKeyEntry>>) : []) if (typeof e?.hypothesis_id === "string" && typeof e.lead_key === "string" && /^[0-9a-f]{64}$/.test(e.lead_key)) keys[e.hypothesis_id] = e.lead_key;
    // the anchor behind each key, from structured records only: Slither's lead list, or the specialists' stored finding payloads
    if (Array.isArray(r.output?.leads)) for (const l of r.output.leads as Array<{ hypothesisId?: string; class?: string; contract?: string; function?: string; file?: string }>) {
      if (typeof l.hypothesisId === "string" && keys[l.hypothesisId]) anchors.set(l.hypothesisId, normaliseAnchor({ repository, class: String(l.class ?? ""), file: String(l.file ?? ""), contract: String(l.contract ?? ""), function: String(l.function ?? "") }));
    }
    const payloads = Object.entries(r.output?.finding_payloads ?? {}).filter(([id, sha]) => keys[id] && typeof sha === "string") as Array<[string, string]>;
    if (payloads.length) {
      const blobs = new Map((await db.query<{ content_sha256: string; content: Buffer }>("SELECT content_sha256, content FROM research_blobs WHERE content_sha256 = ANY($1::text[])", [[...new Set(payloads.map(([, s]) => s))]])).rows.map((b) => [b.content_sha256, b.content]));
      for (const [id, sha] of payloads) {
        const b = blobs.get(sha); if (!b) continue;
        try { const p = JSON.parse(b.toString("utf8")) as { class?: string; contract?: string; function?: string; file?: string }; anchors.set(id, normaliseAnchor({ repository, class: String(p.class ?? ""), file: String(p.file ?? ""), contract: String(p.contract ?? ""), function: String(p.function ?? "") })); } catch { /* an unreadable payload leaves the key without an anchor; the key itself is still recorded */ }
      }
    }
    out.push({ step_key: r.step_key, keys, anchors });
  }
  return out;
}

/**
 * The investigations of one snapshot, built ONLY from stored records: the lead keys the producing steps recorded, the hypothesis rows,
 * their evidence links and their evaluations (latest per evaluator, as the status view takes them). A recorded key whose anchor can be
 * read back is re-derived and must match (an integrity error otherwise). A hypothesis with no recorded key is its own, unkeyed
 * investigation: it is never guessed into another.
 */
export async function investigationsOfSnapshot(db: Pick<Pool, "query">, snapshotId: string): Promise<Investigation[]> {
  const snap = (await db.query<{ repository: string; workflow_run_id: string }>("SELECT repository, workflow_run_id FROM repo_snapshots WHERE id = $1", [snapshotId])).rows[0];
  if (!snap) return [];
  const recorded = await recordedLeadKeys(db, snap.workflow_run_id, snap.repository);
  const keyOf = new Map<string, { key: string; anchor: LeadAnchor | null }>();
  for (const s of recorded) for (const [id, key] of Object.entries(s.keys)) {
    const anchor = s.anchors.get(id) ?? null;
    if (anchor && leadKey(anchor) !== key) throw new Error(`lead identity refused: the ${s.step_key} step recorded lead key ${key} for hypothesis ${id}, which is not the key of its recorded anchor`);
    keyOf.set(id, { key, anchor });
  }
  const hs = (await db.query<{ id: string; claim: string; generator_kind: string; generator_id: string; generator_version: string; step_key: string | null }>(
    `SELECT h.id, h.claim, h.generator_kind, h.generator_id, h.generator_version, st.step_key FROM hypotheses h LEFT JOIN workflow_steps st ON st.id = h.produced_by_step_id
      WHERE h.snapshot_id = $1 ORDER BY h.claim COLLATE "C", h.id`, [snapshotId])).rows;
  const groups = new Map<string, { keyed: boolean; anchor: LeadAnchor | null; members: typeof hs }>();
  for (const h of hs) {
    const k = keyOf.get(h.id); const key = k?.key ?? `unkeyed:${h.id}`;
    const g = groups.get(key) ?? groups.set(key, { keyed: !!k, anchor: k?.anchor ?? null, members: [] }).get(key)!;
    g.members.push(h); if (!g.anchor && k?.anchor) g.anchor = k.anchor;
  }
  const out: Investigation[] = [];
  for (const [lead_key, g] of groups) {
    const families = new Set<string>();
    for (const h of g.members) { const f = generatorFamily({ kind: h.generator_kind, id: h.generator_id }); if (f) families.add(f); }
    const contributions: Contribution[] = [];
    for (const h of g.members) {
      const gen = { kind: h.generator_kind, id: h.generator_id }; const gi = analysisIdentity(h.generator_id);
      const evidence = (await db.query<{ path: string; line_start: number; line_end: number; role: string }>(
        `SELECT s.path, s.line_start, s.line_end, he.role FROM hypothesis_evidence he JOIN evidence_spans s ON s.id = he.span_id WHERE he.hypothesis_id = $1 ORDER BY (he.role = 'primary') DESC, s.path, s.line_start`, [h.id])).rows;
      const evals = (await db.query<{ id: string; evaluator_id: string; evaluator_version: string; outcome: string; rationale: string }>(
        "SELECT id, evaluator_id, evaluator_version, outcome, rationale FROM hypothesis_evaluations WHERE hypothesis_id = $1 ORDER BY evaluator_id, created_at", [h.id])).rows;
      const latest = new Map<string, (typeof evals)[number]>(); for (const e of evals) latest.set(e.evaluator_id, e);
      contributions.push({
        hypothesis_id: h.id, generator: `${h.generator_id}@${h.generator_version}`, generator_kind: h.generator_kind, analysis_family: generatorFamily(gen), method: gi?.role === "generator" ? gi.method : null, produced_by_step: h.step_key,
        claim: h.claim, evidence: evidence.map((e) => ({ path: e.path, lines: `${e.line_start}-${e.line_end}`, role: e.role })),
        evaluations: [...latest.values()].map((e) => {
          const ei = analysisIdentity(e.evaluator_id); const relation = evaluationRelation(gen, e.evaluator_id);
          // stricter than the per-hypothesis rule: sharing a family with ANY generator of the investigation is same-family
          const relation_to_investigation: EvaluationRelation = relation === "abstention" || relation === "unknown-family" ? relation : ei && families.has(ei.analysisFamily) ? "same-family" : relation;
          return { evaluation_id: e.id, evaluator: `${e.evaluator_id}@${e.evaluator_version}`, analysis_family: ei?.analysisFamily ?? null, method: ei?.method ?? null, outcome: e.outcome, rationale: e.rationale.slice(0, 600), relation, relation_to_investigation };
        }),
      });
    }
    const all = contributions.flatMap((c) => c.evaluations.map((e) => ({ c, e })));
    const supports = all.filter((x) => x.e.outcome === "supports");
    const count = (r: EvaluationRelation) => supports.filter((x) => x.e.relation_to_investigation === r).length;
    const corroboration = { same_family: count("same-family"), cross_family: count("cross-family"), unknown_family: count("unknown-family") };
    const contradictions: Contradiction[] = [];
    for (const { c, e } of all) {
      if (e.outcome !== "contradicts" && e.outcome !== "weakens") continue;
      // every generator of the investigation asserts the lead; the opposing evaluation is kept beside each assertion it opposes
      for (const g2 of contributions) contradictions.push({
        kind: e.outcome === "contradicts" ? "refuted_by_another_engine" : "weakened_by_another_engine",
        for: { engine: g2.generator, analysis_family: g2.analysis_family, stance: "asserts", hypothesis_id: g2.hypothesis_id },
        against: { engine: e.evaluator, analysis_family: e.analysis_family, stance: e.outcome as Stance, hypothesis_id: c.hypothesis_id, evaluation_id: e.evaluation_id },
        families: familyRelation(g2.analysis_family, e.analysis_family),
        note: `${g2.generator} (${g2.analysis_family ?? "family not recorded"}) asserts the lead; ${e.evaluator} (${e.analysis_family ?? "family not recorded"}) ${e.outcome === "contradicts" ? "executed a counterexample" : "did not observe the claimed effect"} when evaluating ${c.hypothesis_id === g2.hypothesis_id ? "that hypothesis" : `the same lead as reported by ${c.generator}`}. Both records are kept; neither overrides the other without a human decision.`,
      });
      for (const s of supports) if (s.e.evaluator !== e.evaluator || s.c.hypothesis_id !== c.hypothesis_id) contradictions.push({
        kind: "evaluators_disagree",
        for: { engine: s.e.evaluator, analysis_family: s.e.analysis_family, stance: "supports", hypothesis_id: s.c.hypothesis_id },
        against: { engine: e.evaluator, analysis_family: e.analysis_family, stance: e.outcome as Stance, hypothesis_id: c.hypothesis_id, evaluation_id: e.evaluation_id },
        families: familyRelation(s.e.analysis_family, e.analysis_family),
        note: `${s.e.evaluator} supports the lead (on ${s.c.generator}'s hypothesis) while ${e.evaluator} ${e.outcome} it (on ${c.generator}'s). Both evaluations are kept.`,
      });
    }
    const has = (o: string) => all.some((x) => x.e.outcome === o);
    const assessment: Investigation["assessment"] = has("contradicts") ? "contradicted" : has("weakens") ? "weakened" : corroboration.cross_family ? "supported_cross_family" : corroboration.same_family ? "corroborated_same_family" : corroboration.unknown_family ? "supported_unknown_family" : "open";
    const generators = [...new Set(contributions.map((c) => c.generator))].sort();
    out.push({
      lead_key, keyed: g.keyed, anchor: g.anchor, contributions, generators, generator_families: [...families].sort(), independent_generation: families.size >= 2, corroboration, contradictions, assessment,
      note: !g.keyed ? "No lead key is recorded for this hypothesis by its producing step, so it is not grouped with any other."
        : contributions.length > 1 ? `${contributions.length} hypotheses from ${generators.length} generator(s) share this lead key: ONE investigation. Each engine's claim and evidence is kept separately below.${families.size >= 2 ? " Generators of different analysis families reported it independently; that is independent generation, not validation." : ""}`
        : "One hypothesis has this lead key.",
    });
  }
  return out.sort((a, b) => (a.lead_key < b.lead_key ? -1 : a.lead_key > b.lead_key ? 1 : 0));
}

export type InvestigationSummary = { hypotheses: number; investigations: number; multi_engine: number; independent_generation: number; with_contradictions: number; contradictions: number; unkeyed: number; by_assessment: Record<string, number> };
export function summariseInvestigations(list: readonly Investigation[]): InvestigationSummary {
  const by: Record<string, number> = {}; for (const i of list) by[i.assessment] = (by[i.assessment] ?? 0) + 1;
  return { hypotheses: list.reduce((n, i) => n + i.contributions.length, 0), investigations: list.length, multi_engine: list.filter((i) => i.generators.length > 1).length,
    independent_generation: list.filter((i) => i.independent_generation).length, with_contradictions: list.filter((i) => i.contradictions.length).length, contradictions: list.reduce((n, i) => n + i.contradictions.length, 0),
    unkeyed: list.filter((i) => !i.keyed).length, by_assessment: by };
}

/**
 * Cross-snapshot memory without a new table: every recorded occurrence of a lead key in any run of the repository, oldest first, from the
 * producing steps' outputs. (At scale this scan wants an index; see db/drafts/c2-lead-identity.)
 */
export async function leadHistory(db: Pick<Pool, "query">, repository: string, key: string): Promise<Array<{ hypothesis_id: string; snapshot_id: string; commit_sha: string; generator: string; analysis_family: string | null; step_key: string; created_at: string }>> {
  const rows = (await db.query<{ hypothesis_id: string; snapshot_id: string; commit_sha: string; generator_kind: string; generator_id: string; generator_version: string; step_key: string; created_at: Date }>(
    `SELECT h.id AS hypothesis_id, h.snapshot_id, sn.commit_sha, h.generator_kind, h.generator_id, h.generator_version, st.step_key, h.created_at
       FROM workflow_steps st CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(st.output->'lead_keys') = 'array' THEN st.output->'lead_keys' ELSE '[]'::jsonb END) AS lk(entry)
       JOIN hypotheses h ON h.id::text = lk.entry->>'hypothesis_id' AND h.workflow_run_id = st.workflow_run_id
       JOIN repo_snapshots sn ON sn.id = h.snapshot_id
      WHERE st.status = 'succeeded' AND lk.entry->>'lead_key' = $2 AND lower(sn.repository) = lower($1)
      ORDER BY h.created_at, h.id`, [repository, key])).rows;
  return rows.map((r) => ({ hypothesis_id: r.hypothesis_id, snapshot_id: r.snapshot_id, commit_sha: r.commit_sha, generator: `${r.generator_id}@${r.generator_version}`, analysis_family: generatorFamily({ kind: r.generator_kind, id: r.generator_id }), step_key: r.step_key, created_at: r.created_at.toISOString() }));
}
