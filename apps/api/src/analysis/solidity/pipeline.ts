import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ProgramIndex } from "./index.js";
import { challengeFinding } from "./challenge.js";
import { validateReentrancy, type SimOutcome } from "./simulate.js";
import { analyzeSources, type Finding } from "./specialists.js";
import { buildProtocolModel, reachableCalls, type ProtocolModel } from "./protocol-model.js";
import { sha256Hex, type ResearchStore, type StepLease } from "../../research-state.js";

/**
 * Glue between the structural analysis and the durable research state (5.1): findings become evidence-linked hypotheses citing
 * hash-verified spans of a sealed snapshot; the execution validator's verdicts become recorded evaluations. Nothing is claimed
 * beyond what each stage actually did: a class with no independent validator is recorded as `inconclusive`, never as "supports".
 */
export const SPECIALIST_ID = "solidity-structural-specialists"; export const SPECIALIST_VERSION = "1";
export const VALIDATOR_ID = "reentrancy-execution-validator"; export const VALIDATOR_VERSION = "1";

export type StoredHypothesis = { id: string; finding: Finding; spanIds: string[] };
/** research_blobs holds at most 1 MiB per blob; a larger model is not stored (and the step says so) rather than truncated. */
const MODEL_BLOB_LIMIT = 1_048_576;
export type StoredProtocolModel = { sha256: string; stored: boolean; components: number; functions: number; callEdges: number; unknowns: number };

async function readSnapshotSources(pool: Pool, snapshotId: string): Promise<Array<{ path: string; text: string }>> {
  const r = await pool.query<{ path: string; text: string }>(
    `SELECT f.path, convert_from(b.content, 'UTF8') AS text FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256
      WHERE f.snapshot_id = $1 AND f.path LIKE '%.sol' ORDER BY f.path COLLATE "C"`, [snapshotId]);
  return r.rows;
}

export async function runStructuralAnalysis(pool: Pool, store: ResearchStore, lease: StepLease, snapshotId: string): Promise<{ stored: StoredHypothesis[]; problems: string[]; contracts: number; functions: number; protocolModel: StoredProtocolModel }> {
  const sources = await readSnapshotSources(pool, snapshotId);
  // P1: the protocol model is built from the same sealed sources and stored content-addressed; the step output links it (T-149 stage 4)
  const pm = buildProtocolModel(sources); const bytes = Buffer.from(pm.json, "utf8");
  const storedModel = bytes.length <= MODEL_BLOB_LIMIT ? (await store.putBlob(lease, bytes)).sha256 === pm.sha256 : false;
  const protocolModel: StoredProtocolModel = { sha256: pm.sha256, stored: storedModel, components: pm.model.components.length, functions: pm.model.functions.length, callEdges: pm.model.callEdges.length, unknowns: pm.model.unknowns.length };
  const { findings, index, problems } = analyzeSources(sources);
  const stored: StoredHypothesis[] = []; const spanCache = new Map<string, string>();
  const span = async (file: string, line: number) => {
    const key = `${file}:${line}`; const have = spanCache.get(key); if (have) return have;
    const id = await store.createEvidenceSpan(lease, { snapshotId, path: file, lineStart: line, lineEnd: line }); spanCache.set(key, id); return id;
  };
  for (const f of findings) {
    const seen = new Set<string>(); const spans: Array<{ spanId: string; role: "primary" | "supporting" | "context" }> = [];
    for (const s of f.spans) { const k = `${s.file}:${s.lineStart}`; if (seen.has(k)) continue; seen.add(k); spans.push({ spanId: await span(s.file, s.lineStart), role: spans.length === 0 ? "primary" : s.role === "primary" ? "supporting" : s.role }); }
    const made = await store.createHypothesis(lease, {
      snapshotId, family: `solidity-${f.class}`, claim: f.claim, rationale: f.rationale + (f.assumptions.length ? ` Assumptions: ${f.assumptions.join("; ")}.` : ""),
      requiredChecks: f.requiredChecks, alternativeExplanations: f.alternatives, generator: { kind: "deterministic_rule", id: SPECIALIST_ID, version: SPECIALIST_VERSION }, spans,
    });
    stored.push({ id: made.id, finding: f, spanIds: spans.map((s) => s.spanId) });
  }
  const fns = [...index.contracts.values()].reduce((n, c) => n + c.functions.length, 0);
  return { stored, problems, contracts: index.contracts.size, functions: fns, protocolModel };
}

export type Validation = { hypothesisId: string; outcome: SimOutcome };

/** Independent challenge of reentrancy leads by execution; other classes are recorded as inconclusive (no independent validator exists yet). */
export async function runChallenge(pool: Pool, store: ResearchStore, lease: StepLease, snapshotId: string, stored: StoredHypothesis[]): Promise<Validation[]> {
  const index = new ProgramIndex(await readSnapshotSources(pool, snapshotId)); const out: Validation[] = [];
  for (const h of stored) {
    const primary = h.spanIds[0]!;
    if (h.finding.class !== "reentrancy") {
      const c = challengeFinding(index, h.finding);
      if (!c) {
        await store.recordEvaluation(lease, { hypothesisId: h.id, evaluatorId: "no-independent-validator", evaluatorVersion: "1", outcome: "inconclusive",
          rationale: `No independent validator exists yet for ${h.finding.class} leads; this lead has only been produced by the specialist and has not been challenged.`, spanIds: [], inputSha256: sha256Hex(h.finding.claim) });
        continue;
      }
      const outcome = c.verdict === "validated" ? "supports" : c.verdict === "refuted" ? "weakens" : "inconclusive";
      const text = `${c.method}: ${c.reason}.${c.trace.length ? " Trace: " + c.trace.join(" | ") : ""}${c.verdict === "refuted" ? " This weakens (does not eliminate) the lead: the model is a bounded abstraction." : ""}`;
      await store.recordEvaluation(lease, { hypothesisId: h.id, evaluatorId: `execution-challenge-${h.finding.class}`, evaluatorVersion: "1", outcome, rationale: text.slice(0, 7900), spanIds: outcome === "inconclusive" ? [] : [primary], inputSha256: sha256Hex(`${h.finding.claim}|${c.verdict}|${c.reason}`) });
      continue;
    }
    const fn = index.findFunctions(h.finding.contract, h.finding.function)[0];
    const r = fn ? validateReentrancy(index, fn) : { verdict: "inconclusive" as const, reason: "function not found", trace: [], scenarios: 0, detail: {} };
    out.push({ hypothesisId: h.id, outcome: r });
    const outcome = r.verdict === "validated" ? "supports" : r.verdict === "refuted" ? "weakens" : "inconclusive";
    const body = r.verdict === "validated" ? `Executed model: ${r.reason}. Trace: ${r.trace.join(" | ")}` : r.verdict === "refuted" ? `Executed model, ${r.scenarios} bounded scenarios: ${r.reason}. This weakens (does not eliminate) the lead: the model is a bounded abstraction.` : `The validator abstained: ${r.reason}`;
    await store.recordEvaluation(lease, { hypothesisId: h.id, evaluatorId: VALIDATOR_ID, evaluatorVersion: VALIDATOR_VERSION, outcome, rationale: body.slice(0, 7900), spanIds: outcome === "inconclusive" ? [] : [primary], inputSha256: sha256Hex(`${h.finding.claim}|${r.verdict}|${r.reason}`) });
  }
  return out;
}

export type DossierEntry = {
  hypothesis_id: string; class: string; function: string; claim: string; rationale: string; required_checks: unknown; alternative_explanations: unknown;
  generator: string; evidence: Array<{ path: string; lines: string; role: string; text: string; verified: boolean }>;
  evaluations: Array<{ evaluator: string; outcome: string; rationale: string }>; status: string | null; static_outcome: string | null; human_review: string;
};
export type ArchitectureSection =
  | { available: false; reason: string }
  | { available: true; model_sha256: string; builder: string; components: Array<{ id: string; kind: string; file: string; lines: string; content_sha256: string; entry_points: Array<{ fn: string; guarded: boolean; writes: string[]; external_calls: Array<{ kind: string; to: string; target_provenance: string | null; resolved_callee: string | null; at: string }>; unresolved_calls: Array<{ name: string; at: string }> }> }>; unknowns: Array<{ at: string; what: string }> };
export type Dossier = {
  snapshot: { id: string; repository: string; commit_sha: string; file_count: number; manifest_sha256: string; verified: boolean };
  summary: Record<string, number>; entries: DossierEntry[]; architecture: ArchitectureSection; limitations: string[]; content_sha256: string;
};

/** P1 consumer: the dossier's architecture section, built ONLY from the protocol model the analysis step stored for this snapshot's run
 *  (located through the step output, re-hashed on read; a missing or mismatching model is reported, never reconstructed). */
async function architectureFromStoredModel(pool: Pool, snapshotId: string): Promise<ArchitectureSection> {
  const ref = (await pool.query<{ sha: string | null }>(
    `SELECT st.output->>'protocol_model_sha256' AS sha FROM repo_snapshots s JOIN workflow_steps st ON st.workflow_run_id = s.workflow_run_id
      WHERE s.id = $1 AND st.step_key = 'analyze_structure' AND st.status = 'succeeded' AND st.output ? 'protocol_model_sha256' ORDER BY st.completed_at DESC LIMIT 1`, [snapshotId])).rows[0];
  if (!ref?.sha) return { available: false, reason: "no protocol model is recorded for this snapshot's analysis step" };
  const blob = (await pool.query<{ content: Buffer }>("SELECT content FROM research_blobs WHERE content_sha256 = $1", [ref.sha])).rows[0];
  if (!blob) return { available: false, reason: `the recorded protocol model ${ref.sha} was not stored (too large for one blob)` };
  if (createHash("sha256").update(blob.content).digest("hex") !== ref.sha) throw new Error("dossier refused: the stored protocol model does not match its recorded hash");
  const m = JSON.parse(blob.content.toString("utf8")) as ProtocolModel;
  const at = (e: { file: string; lineStart: number; lineEnd: number }) => `${e.file}:${e.lineStart}${e.lineEnd !== e.lineStart ? `-${e.lineEnd}` : ""}`;
  return {
    available: true, model_sha256: ref.sha, builder: `${m.schema} ${m.builder}`,
    components: m.components.filter((c) => c.deployable).map((c) => ({
      id: c.id, kind: c.kind, file: c.file, lines: `${c.evidence.lineStart}-${c.evidence.lineEnd}`, content_sha256: c.contentSha256,
      entry_points: m.functions.filter((f) => f.component === c.id && f.entryPoint).map((f) => ({
        fn: f.id, guarded: f.callerGuarded, writes: f.stateWrites,
        external_calls: reachableCalls(m, f.id).filter((e) => e.kind !== "unresolved").map((e) => ({ kind: e.kind, to: e.to, target_provenance: e.targetProvenance, resolved_callee: e.resolvedCallee ?? null, at: at(e.evidence) })),
        unresolved_calls: reachableCalls(m, f.id).filter((e) => e.kind === "unresolved").map((e) => ({ name: e.to, at: at(e.evidence) })),
      })),
    })),
    unknowns: m.unknowns.map((u) => ({ at: `${u.file}${u.line ? `:${u.line}` : ""}`, what: u.what })),
  };
}

/** Builds the dossier ONLY from stored records; spans are re-resolved and re-verified; fails closed if any cited span cannot be verified. */
export async function buildDossier(pool: Pool, store: ResearchStore, snapshotId: string): Promise<Dossier> {
  const snap = (await pool.query("SELECT id, repository, commit_sha, file_count, manifest_sha256 FROM repo_snapshots WHERE id = $1", [snapshotId])).rows[0];
  const verified = (await store.verifySnapshot(snapshotId)) as { ok?: boolean };
  const hs = (await pool.query<{ id: string; family: string; claim: string; rationale: string; required_checks: unknown; alternative_explanations: unknown; generator_id: string; generator_version: string }>(
    "SELECT id, family, claim, rationale, required_checks, alternative_explanations, generator_id, generator_version FROM hypotheses WHERE snapshot_id = $1 ORDER BY claim COLLATE \"C\"", [snapshotId])).rows;
  const entries: DossierEntry[] = [];
  for (const h of hs) {
    const ev = (await pool.query<{ span_id: string; role: string }>("SELECT span_id, role FROM hypothesis_evidence WHERE hypothesis_id = $1 ORDER BY role, span_id", [h.id])).rows;
    const evidence: DossierEntry["evidence"] = [];
    for (const e of ev) {
      const r = await store.resolveSpan(e.span_id); const verifiedHash = await store.verifySpan(e.span_id).then(() => true).catch(() => false);
      if (!r.ok || !verifiedHash) throw new Error(`dossier refused: a cited span of hypothesis ${h.id} cannot be verified`);
      evidence.push({ path: r.path, lines: `${r.lineStart}-${r.lineEnd}`, role: e.role, text: r.text.trim(), verified: true });
    }
    evidence.sort((a, b) => a.path.localeCompare(b.path) || a.lines.localeCompare(b.lines));
    const evals = (await pool.query<{ evaluator_id: string; outcome: string; rationale: string }>("SELECT evaluator_id, outcome, rationale FROM hypothesis_evaluations WHERE hypothesis_id = $1 ORDER BY evaluator_id, created_at", [h.id])).rows;
    const st = (await store.getStatus(h.id)) as Record<string, unknown> | null;
    const cls = h.family.replace(/^solidity-/, "");
    entries.push({ hypothesis_id: h.id, class: cls, function: /^(\w+\.\w+)/.exec(h.claim)?.[1] ?? "", claim: h.claim, rationale: h.rationale, required_checks: h.required_checks, alternative_explanations: h.alternative_explanations,
      generator: `${h.generator_id}@${h.generator_version}`, evidence, evaluations: evals.map((e) => ({ evaluator: e.evaluator_id, outcome: e.outcome, rationale: e.rationale })),
      status: (st?.status as string) ?? null, static_outcome: (st?.static_outcome as string) ?? null, human_review: "none recorded" });
  }
  const summary: Record<string, number> = {};
  for (const e of entries) summary[e.status ?? "unknown"] = (summary[e.status ?? "unknown"] ?? 0) + 1;
  const limitations = [
    "Every item is a lead produced by deterministic rules over source text; nothing was compiled, run against a chain or tested with a fuzzer.",
    "Reentrancy, access-control, initializer, delegatecall, selfdestruct and unchecked-call leads are challenged by bounded execution of a modelled contract (a different method from the specialists); tx.origin leads have no independent method and stay unchallenged.",
    "No human review is recorded for any item. Status values come from the database view and say so.",
    "The analysis is intra-repository: calls into code outside the snapshot, inline assembly and unresolved modifiers are not analysed (they are listed as assumptions where they affect a lead).",
  ];
  const architecture = await architectureFromStoredModel(pool, snapshotId);
  const content = entries.map((e) => [e.class, e.function, e.claim, e.evidence.map((x) => `${x.path}:${x.lines}:${x.text}`), e.evaluations.map((x) => `${x.evaluator}:${x.outcome}`), e.status]);
  const content_sha256 = createHash("sha256").update(JSON.stringify([content, architecture.available ? architecture.model_sha256 : null])).digest("hex");
  return { snapshot: { id: snap.id, repository: snap.repository, commit_sha: snap.commit_sha, file_count: snap.file_count, manifest_sha256: snap.manifest_sha256, verified: verified.ok === true }, summary, entries, architecture, limitations, content_sha256 };
}

export function renderDossierMarkdown(d: Dossier): string {
  const o: string[] = [`# Research dossier: ${d.snapshot.repository} @ ${d.snapshot.commit_sha}\n`,
    `Snapshot ${d.snapshot.id}: ${d.snapshot.file_count} files, manifest \`${d.snapshot.manifest_sha256}\`, database verification ok=${d.snapshot.verified}. Content hash \`${d.content_sha256}\`.\n`,
    `Status counts (derived by the database view): ${Object.entries(d.summary).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}.\n`, "## Leads\n"];
  d.entries.forEach((e, i) => {
    o.push(`### ${i + 1}. ${e.function} - ${e.class} (status: ${e.status})\n**Claim.** ${e.claim}\n`);
    for (const x of e.evidence) o.push(`- evidence (${x.role}) \`${x.path}:${x.lines}\`: \`${x.text.slice(0, 140)}\``);
    o.push(`\n**Challenge.**` + (e.evaluations.length ? "\n" + e.evaluations.map((v) => `- ${v.evaluator}: **${v.outcome}**. ${v.rationale.slice(0, 600)}`).join("\n") : " none recorded"));
    o.push(`\n**Required checks.** ${(e.required_checks as string[]).join("; ")}\n**Alternative explanations.** ${(e.alternative_explanations as string[]).join("; ")}\n**Generated by** ${e.generator}. Human review: ${e.human_review}.\n`);
  });
  o.push("## Architecture (protocol model P1)\n");
  if (!d.architecture.available) o.push(`Not available: ${d.architecture.reason}.\n`);
  else {
    o.push(`Model \`${d.architecture.model_sha256}\` (${d.architecture.builder}). Every item cites code; P1 covers components, entry points, writes and external calls only (no roles, assets or value flows yet).\n`);
    for (const c of d.architecture.components) {
      o.push(`### ${c.id} (${c.kind}, \`${c.file}:${c.lines}\`)`);
      for (const f of c.entry_points) o.push(`- \`${f.fn}\` ${f.guarded ? "caller-guarded" : "**no caller guard**"}${f.writes.length ? `; writes ${f.writes.join(", ")}` : ""}${f.external_calls.length ? `; calls ${f.external_calls.map((x) => `${x.kind} ${x.to}${x.resolved_callee ? ` -> ${x.resolved_callee}` : ""} (target from ${x.target_provenance ?? "n/a"}, \`${x.at}\`)`).join("; ")}` : ""}${f.unresolved_calls.length ? `; **unresolved:** ${f.unresolved_calls.map((x) => `${x.name} (\`${x.at}\`)`).join(", ")}` : ""}`);
      o.push("");
    }
    if (d.architecture.unknowns.length) o.push(`Not modelled (${d.architecture.unknowns.length}): ` + d.architecture.unknowns.slice(0, 20).map((u) => `\`${u.at}\` ${u.what}`).join("; ") + (d.architecture.unknowns.length > 20 ? "; ..." : "") + "\n");
  }
  o.push("## Limitations\n" + d.limitations.map((l) => `- ${l}`).join("\n") + "\n");
  return o.join("\n");
}

/** The structural map, now a PROJECTION of the protocol model (P1): one derivation, kept in the step output for compatibility. Metadata only. */
export function buildStructuralMap(sources: ReadonlyArray<{ path: string; text: string }>) {
  const { model } = buildProtocolModel(sources); const ix = new ProgramIndex(sources);
  const contracts = model.components.map((c) => ({
    name: c.id, kind: c.kind, file: c.file, bases: ix.contracts.get(c.id)?.bases ?? [], lines: [c.evidence.lineStart, c.evidence.lineEnd],
    state_variables: c.stateVariables.map((v) => ({ name: v.name, type: v.type, constant: v.constant, immutable: v.immutable })),
    functions: model.functions.filter((f) => f.component === c.id).map((f) => {
      const calls = reachableCalls(model, f.id).filter((e) => e.kind !== "unresolved");
      return {
        name: f.name, kind: f.kind, visibility: f.visibility, mutability: f.mutability, modifiers: f.modifiers, lines: [f.evidence.lineStart, f.evidence.lineEnd], declared_in: f.declaredIn,
        entry_point: f.entryPoint, caller_guarded: f.callerGuarded, external_calls: calls.length,
        low_level_calls: [...new Set(calls.map((e) => e.kind).filter((k) => k !== "external"))], state_writes: f.stateWrites,
        unresolved_calls: reachableCalls(model, f.id).filter((e) => e.kind === "unresolved").length,
      };
    }),
  }));
  return { contracts, problems: ix.problems, protocol_model_schema: model.schema };
}

/** Rebuild the stored hypotheses of a snapshot (ids and primary spans) by matching the deterministic findings to the database records. */
export async function loadStoredHypotheses(pool: Pool, snapshotId: string): Promise<StoredHypothesis[]> {
  const sources = await readSnapshotSources(pool, snapshotId); const { findings } = analyzeSources(sources); const out: StoredHypothesis[] = [];
  for (const f of findings) {
    const h = (await pool.query<{ id: string }>("SELECT id FROM hypotheses WHERE snapshot_id = $1 AND claim = $2 AND generator_id = $3", [snapshotId, f.claim, SPECIALIST_ID])).rows[0];
    if (!h) continue;
    const spans = (await pool.query<{ span_id: string }>("SELECT span_id FROM hypothesis_evidence WHERE hypothesis_id = $1 ORDER BY (role = 'primary') DESC, span_id", [h.id])).rows;
    out.push({ id: h.id, finding: f, spanIds: spans.map((x) => x.span_id) });
  }
  return out;
}
