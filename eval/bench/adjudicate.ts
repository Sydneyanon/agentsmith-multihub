/**
 * Independent AI adjudication of deterministic findings (Priority B, B3).
 *
 * Rules this module enforces structurally:
 * - Every model call goes through AiBudgetGateway (reviewed price, reservation, per-call/daily/monthly/workflow caps,
 *   configured tier routing). There is no other code path to a provider here.
 * - The adjudicator is blind to ground truth: candidates are built from analyzer findings + source code only; the prompt
 *   builder's input type has no label fields, and labels are never passed to this module. Code, paths and contract names
 *   reach the model only through the model-facing view (comments blanked, contract names and file paths neutralised), so
 *   explanatory comments or Bad/Good names in a corpus cannot leak the answer.
 * - One attempt per candidate, no retries. A budget/catalog block stops the pass (the rest are recorded unavailable with the
 *   same reason); a provider error stops the pass (no burning of further reservations).
 * - Output is stored beside the deterministic result. It never edits labels or scores; disagreement with a label is a flag for
 *   human review, nothing more.
 */
import type { Pool } from "pg";
import type { AiBudgetGateway, ModelAdapter } from "../../apps/api/src/ai-budget-gateway.js";
import type { ModelTask } from "../../apps/api/src/ai-budget.js";
import type { BenchmarkRecord, FindingRow } from "./benchmark.js";
import type { ModelView } from "./model-view.js";

export const ADJUDICATION_PROMPT_VERSION = "benchmark-adjudication/1";
/** Configured routing: an independent check of a security claim. MODEL_ROUTING maps this to tier3 ($0.10 per-call cap). */
export const ADJUDICATION_TASK: ModelTask = "independent_challenge";

export type CandidateReason = "collision" | "unscored" | "false_positive_vs_label";
export type Candidate = { reason: CandidateReason; finding: FindingRow };
export type AdjudicationStatus = "completed" | "unparseable" | "unavailable" | "failed";
export type Adjudication = {
  reason: CandidateReason; finding: Pick<FindingRow, "file" | "line" | "function" | "class">;
  status: AdjudicationStatus; detail: string | null;
  verdict: "real" | "not_real" | "uncertain" | null; severity: string | null; rationale: string | null;
  costUsd: number | null; inputTokens: number | null; outputTokens: number | null; reservationId: string | null; latencyMs: number;
};

/** Findings the deterministic grader cannot settle on its own. Built from the record, never from labels.json directly. */
export function selectCandidates(record: BenchmarkRecord): Candidate[] {
  const d = record.deterministic;
  const out: Candidate[] = [
    ...d.collisions.map((finding) => ({ reason: "collision" as const, finding })),
    ...d.unscoredFindings.map((finding) => ({ reason: "unscored" as const, finding })),
  ];
  // `score` reports false positives and line accuracy as text; resolve them back to concrete findings.
  for (const fp of d.falsePositives) {
    const m = /^(\S+):(\d+) (\S+) \(([^)]+)\)/.exec(fp);
    const f = m && record.findingsDetail.find((r) => r.file === m[1] && r.function === m[3] && r.class === m[4]);
    if (f) out.push({ reason: "false_positive_vs_label", finding: f });
  }
  return out;
}

const SEVERITIES = ["critical", "high", "medium", "low", "informational", "none"];

/** Prompt from a finding and the code around it, all through the model-facing view. Deliberately takes no label, note or expected class. */
export function buildPrompt(finding: FindingRow, view: ModelView) {
  const lines = view.text(finding.file).split("\n");
  const from = Math.max(1, finding.line - 25); const to = Math.min(lines.length, finding.line + 25);
  const excerpt = lines.slice(from - 1, to).map((t, i) => `${String(from + i).padStart(4)}  ${t}`).join("\n");
  const file = view.neutralPath(finding.file);
  return {
    system: "You are an independent smart-contract security reviewer. You are shown one automated finding and the code it points at. " +
      "Decide whether the finding describes a real, exploitable vulnerability in THIS code. Do not assume the tool is right. " +
      `Answer with JSON only: {"verdict":"real"|"not_real"|"uncertain","severity":${JSON.stringify(SEVERITIES.join("|"))},"rationale":"<= 60 words"}`,
    user: `Finding (${finding.class}) in ${file}, function ${finding.function}, line ${finding.line}:\n${view.redact(finding.claim)}\n\nCode (${file} lines ${from}-${to}):\n${excerpt}`,
  };
}

export function parseVerdict(text: string): { verdict: Adjudication["verdict"]; severity: string | null; rationale: string | null } | null {
  const m = /\{[\s\S]*\}/.exec(text); if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { verdict?: unknown; severity?: unknown; rationale?: unknown };
    if (j.verdict !== "real" && j.verdict !== "not_real" && j.verdict !== "uncertain") return null;
    const severity = typeof j.severity === "string" && SEVERITIES.includes(j.severity) ? j.severity : null;
    return { verdict: j.verdict, severity, rationale: typeof j.rationale === "string" ? j.rationale.slice(0, 500) : null };
  } catch { return null; }
}

export type AdjudicationContext =
  | { mode: "unavailable"; reason: string }
  | { mode: "gateway"; gateway: AiBudgetGateway; adapter: ModelAdapter; pool: Pool; workflowRunId: string; maxCalls?: number };

export async function adjudicate(candidates: Candidate[], view: ModelView, ctx: AdjudicationContext) {
  const pick = (f: FindingRow) => ({ file: f.file, line: f.line, function: f.function, class: f.class });
  const unavailable = (c: Candidate, detail: string): Adjudication => ({ reason: c.reason, finding: pick(c.finding), status: "unavailable", detail, verdict: null, severity: null, rationale: null, costUsd: null, inputTokens: null, outputTokens: null, reservationId: null, latencyMs: 0 });
  const results: Adjudication[] = [];
  if (ctx.mode === "unavailable") return { mode: ctx.mode, candidates: candidates.length, results: candidates.map((c) => unavailable(c, ctx.reason)), spentUsd: 0 };

  const max = ctx.maxCalls ?? 10;
  let halted: string | null = null; let spentUsd = 0;
  for (const [i, c] of candidates.entries()) {
    if (halted) { results.push(unavailable(c, halted)); continue; }
    if (i >= max) { results.push(unavailable(c, `call_limit_${max}_reached`)); continue; }
    const started = Date.now();
    const prompt = buildPrompt(c.finding, view);
    try {
      const r = await ctx.gateway.execute({ task: ADJUDICATION_TASK, adapter: ctx.adapter, workflowRunId: ctx.workflowRunId, promptVersion: ADJUDICATION_PROMPT_VERSION,
        request: { ...prompt, metadata: { purpose: "benchmark_adjudication", reason: c.reason } } });
      if (r.status === "blocked") { halted = `gateway_blocked:${r.reason}`; results.push(unavailable(c, halted)); continue; }
      spentUsd += r.costUsd;
      let tokens: { input_tokens: number | null; output_tokens: number | null } = { input_tokens: null, output_tokens: null };
      try { tokens = (await ctx.pool.query("SELECT input_tokens, output_tokens FROM ai_budget_reservations WHERE id = $1", [r.reservationId])).rows[0] ?? tokens; } catch { /* token read is best-effort under a restricted role */ }
      const v = parseVerdict(r.text);
      results.push({ reason: c.reason, finding: pick(c.finding), status: v ? "completed" : "unparseable", detail: v ? null : "model output was not the requested JSON",
        verdict: v?.verdict ?? null, severity: v?.severity ?? null, rationale: v?.rationale ?? null,
        costUsd: r.costUsd, inputTokens: tokens.input_tokens === null ? null : Number(tokens.input_tokens), outputTokens: tokens.output_tokens === null ? null : Number(tokens.output_tokens),
        reservationId: r.reservationId, latencyMs: Date.now() - started });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      halted = `halted_after_provider_error:${msg}`;
      results.push({ ...unavailable(c, msg), status: "failed", latencyMs: Date.now() - started });
    }
  }
  return { mode: ctx.mode, candidates: candidates.length, results, spentUsd: +spentUsd.toFixed(8) };
}
