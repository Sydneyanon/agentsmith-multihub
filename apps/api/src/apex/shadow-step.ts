import type { Pool } from "pg";
import { BoundedCompute, ComputeBusyError, ComputeLimitError, type ComputeLimits } from "../analysis/solidity/bounded-compute.js";
import { readBuildInfo } from "../engine-status.js";
import type { ResearchReads, SealedSnapshotRef, StepLifecyclePort } from "../research-port.js";
import { LeaseLostError } from "../step-errors.js";
import type { ClaimedStep } from "../worker.js";
import { APEX_SHADOW_SCHEMA, DEFAULT_SHADOW_LIMITS, type ShadowLimits, type ShadowResult } from "./shadow.js";
import { apexShadowStepOutput, recordApexShadow, shadowResultSchema, ShadowRecordRefused, type ShadowReport } from "./shadow-record.js";
import { APEX_SHADOW_LABEL, APEX_SHADOW_TARGET, APEX_SHADOW_VERSION, apexShadowEligibility } from "./shadow-target.js";
import { createHash } from "node:crypto";
import { modelReadRecord, readSharedModelRef } from "../analysis/solidity/shared-model.js";

/**
 * The `apex_shadow` step: the LAST stage of an approved run, after the dossier is built, so nothing it does can reach the dossier, the
 * leads or the evaluations. It
 *  1. re-checks eligibility (approved repository, pinned commit, official 20-path scope, sealed snapshot of that commit) and, if any check
 *     fails, records a REFUSAL with its reason and stops;
 *  2. reads ONLY the in-scope Solidity files of the run's sealed snapshot (never another version, never the network);
 *  3. runs APEX in a bounded child process (CPU, wall time, heap, output size; a transition budget inside), never in this process;
 *  4. records ONE report (completed, refused or failed) through its sink: the direct worker's own connection, or the remote worker's ONE
 *     allow-listed operation `report_apex_shadow`; the recorder re-checks it (shadow-record.ts);
 *  5. completes the step. An APEX failure of any kind (throw, timeout, memory, invalid output) is a RECORDED SHADOW FAILURE and the step
 *     still succeeds, so the research run is never failed by APEX.
 * Only a lost lease propagates (the step is then retried like any other step).
 */
export const DEFAULT_SHADOW_COMPUTE: ComputeLimits = { maxInputBytes: 32 * 1024 * 1024, cpuMs: 300_000, wallMs: 330_000, maxHeapMb: 1024, maxOutputBytes: 16 * 1024 * 1024, maxConcurrent: 1, queueMs: 60_000 };
let shared: BoundedCompute | null = null;
const sharedCompute = () => (shared ??= new BoundedCompute(DEFAULT_SHADOW_COMPUTE));

export type ShadowSink = {
  record(stepId: string, report: ShadowReport): Promise<{ report_sha256: string }>;
  complete(stepId: string, sha: string | null, unrecorded?: { code: string; message: string }): Promise<void>;
};
export type ShadowStepContext = {
  worker: Pick<StepLifecyclePort, "heartbeat">; workerId: string; heartbeatMs?: number; mode: "direct" | "remote";
  /** `sharedProtocolModel` (C1) is optional: a context without it records no model, exactly as before */
  reads: Pick<ResearchReads, "sealedSnapshot" | "snapshotSources"> & Partial<Pick<ResearchReads, "sharedProtocolModel">>; sink: ShadowSink;
  /** the run's recorded input when the worker can read it (direct); the remote worker uses the step input copied at creation */
  runInput?: Record<string, unknown> | null;
  /** injectable for tests: replaces the bounded child (e.g. a throwing or hanging compute) */
  compute?: (payload: { sources: Array<{ path: string; text: string }>; in_scope_paths: string[]; limits: ShadowLimits }) => Promise<{ result: unknown; wallMs: number; cpuMs: number }>;
  computeLimits?: Partial<ComputeLimits>; shadowLimits?: Partial<ShadowLimits>;
};

/** The direct worker's sink: its own connection, the same recorder the API runs. */
export function directShadowSink(pool: Pool, worker: Pick<StepLifecyclePort, "complete">, workerId: string): ShadowSink {
  return {
    record: (stepId, report) => recordApexShadow(pool, { stepId, owner: workerId, actor: workerId, via: "direct_worker", report }),
    complete: async (stepId, sha, unrecorded) => worker.complete(stepId, await apexShadowStepOutput(pool, stepId, sha, unrecorded)),
  };
}

function failureOf(error: unknown): NonNullable<ShadowReport["failure"]>["code"] {
  if (error instanceof ComputeLimitError) return error.code === "compute_failed" ? "compute_failed" : error.code;
  if (error instanceof ComputeBusyError) return "busy";
  return "error";
}

export async function processApexShadowStep(ctx: ShadowStepContext, step: ClaimedStep): Promise<void> {
  const input = step.input as Record<string, unknown>;
  const run = ctx.runInput ?? null;
  const approval = (run ? run["apex_shadow"] : input["approval"]) as { approved_by?: string; approved_commit?: string } | undefined;
  const computeLimits: ComputeLimits = { ...DEFAULT_SHADOW_COMPUTE, ...(ctx.computeLimits ?? {}) };
  const shadowLimits: ShadowLimits = { ...DEFAULT_SHADOW_LIMITS, ...(ctx.shadowLimits ?? {}) };
  let snap: SealedSnapshotRef | null = null;
  // C1: the shared protocol model this stage read by hash (set once the in-scope files are known); part of the report's provenance
  let protocolModel: NonNullable<ShadowReport["provenance"]["protocol_model"]> | undefined;
  const report = (over: Partial<ShadowReport>, files: ShadowReport["provenance"]["input_files"] = [], engine: string | null = null): ShadowReport => ({
    schema: APEX_SHADOW_SCHEMA, label: APEX_SHADOW_LABEL, version: APEX_SHADOW_VERSION, status: "failed", refusal: null, failure: null, result: null, observed: null,
    provenance: { apex_version: APEX_SHADOW_VERSION, engine_generator: engine, strategy: "deep",
      compute_limits: { cpuMs: computeLimits.cpuMs, wallMs: computeLimits.wallMs, maxHeapMb: computeLimits.maxHeapMb, maxInputBytes: computeLimits.maxInputBytes, maxOutputBytes: computeLimits.maxOutputBytes }, shadow_limits: shadowLimits,
      snapshot_id: snap?.snapshotId ?? null, commit_sha: snap?.commitSha ?? null, manifest_sha256: snap?.manifestSha256 ?? null, repository: snap?.repository ?? null,
      approved_by: typeof approval?.approved_by === "string" ? approval.approved_by.slice(0, 200) : null, approved_commit: typeof approval?.approved_commit === "string" ? approval.approved_commit.slice(0, 64) : null,
      input_files: files, worker: { mode: ctx.mode, build_commit: readBuildInfo().commit?.slice(0, 64) ?? null }, ...(protocolModel ? { protocol_model: protocolModel } : {}) },
    ...over,
  });

  let lost = false;
  const beat = setInterval(() => { ctx.worker.heartbeat(step.id).then((alive) => { if (!alive) lost = true; }, () => undefined); }, ctx.heartbeatMs ?? 30_000);
  let r: ShadowReport;
  try {
    // 1. eligibility from the run's records (direct) or the step's copy of them (remote; the recorder re-checks the run itself)
    const eligibility = (snapshot?: { commitSha: string; sealed: boolean }) => apexShadowEligibility(
      run ? { repository: run["value"], ref: run["ref"], approval: run["apex_shadow"], scope: run["bounty_scope"] } : { repository: input["repository"], ref: input["ref"], approval: input["approval"], scope: input["bounty_scope"] }, snapshot);
    let e = eligibility();
    if (e.ok) {
      try { snap = await ctx.reads.sealedSnapshot(step.workflow_run_id); } catch (error) { if (error instanceof LeaseLostError) throw error; e = { ok: false, code: "snapshot_not_sealed", reason: `no sealed, verified snapshot: ${error instanceof Error ? error.message.slice(0, 300) : "unknown"}` }; }
      if (e.ok && snap) e = eligibility({ commitSha: snap.commitSha, sealed: true });
    }
    if (!e.ok) r = report({ status: "refused", refusal: { code: e.code, reason: e.reason } });
    else {
      // 2. only the in-scope files of the sealed snapshot
      const inScope = new Set(APEX_SHADOW_TARGET.inScopePaths);
      const sources = (await ctx.reads.snapshotSources(snap!.snapshotId)).filter((x) => inScope.has(x.path));
      const started = Date.now();
      // C1: the SAME shared protocol model the analysis stored, read by hash and re-hashed. APEX explores only files whose bytes are the
      // model's inputs, and the model's syntactic prediction of unsupported features is later compared with what the gate abstained on.
      let predicted: Record<string, number> = {};
      if (ctx.reads.sharedProtocolModel) {
        const model = readSharedModelRef(await ctx.reads.sharedProtocolModel(step.workflow_run_id));
        const rec = modelReadRecord(model, "input identity check; the model's predicted unsupported features, compared with the fidelity gate's abstentions");
        if (model.available && rec.sha256 !== null) {
          const inputs = new Map(model.doc.inputs.map((i) => [i.file, i.sha256]));
          const matched = sources.filter((x) => inputs.get(x.path) === createHash("sha256").update(x.text, "utf8").digest("hex")).length;
          const sec = model.doc.sections.unsupported_features;
          if (sec.status === "computed") for (const p of sec.predicted) if (inScope.has(p.at[0]!.file)) predicted[p.feature] = (predicted[p.feature] ?? 0) + 1;
          protocolModel = { ...rec, inputs_total: sources.length, inputs_matched: matched, predicted_unsupported: predicted, gate_vs_model: null };
          if (matched !== sources.length) throw new Error(`the in-scope sources are not the inputs of the shared protocol model ${model.sha256} (${matched} of ${sources.length} match)`);
        } else if (rec.sha256 === null) protocolModel = { sha256: null, read: "unavailable", reason: rec.reason.slice(0, 500) };
      }
      // 3. the bounded child
      try {
        const payload = { sources, in_scope_paths: [...APEX_SHADOW_TARGET.inScopePaths], limits: shadowLimits };
        const out = ctx.compute ? await ctx.compute(payload) : await sharedCompute().run<{ shadow: unknown }>("apex_shadow", payload, computeLimits).then((x) => ({ result: x.result.shadow, wallMs: x.wallMs, cpuMs: x.cpuMs }));
        const valid = shadowResultSchema.safeParse(out.result);
        if (!valid.success) r = report({ status: "failed", failure: { code: "invalid_result", message: `the APEX result does not have its schema (${valid.error.issues[0]?.path.join(".") ?? ""}: ${valid.error.issues[0]?.message ?? "invalid"})`.slice(0, 1000), wall_ms: out.wallMs } });
        else {
          const result = valid.data as ShadowResult;
          if (protocolModel && protocolModel.sha256 !== null) {
            const o = new Set(Object.keys(result.abstentions_by_feature)); const p = new Set(Object.keys(predicted));
            protocolModel = { ...protocolModel, gate_vs_model: { predicted_and_observed: [...o].filter((f) => p.has(f)).sort(), observed_not_predicted: [...o].filter((f) => !p.has(f)).sort(), predicted_not_observed: [...p].filter((f) => !o.has(f)).sort() } };
          }
          r = report({ status: "completed", result, observed: { wall_ms: Math.round(out.wallMs), cpu_ms: Math.round(out.cpuMs) } }, result.input_files, result.engine.generator);
        }
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        r = report({ status: "failed", failure: { code: failureOf(error), message: (error instanceof Error ? error.message : String(error)).slice(0, 1000), wall_ms: Date.now() - started } });
      }
    }
  } catch (error) {
    clearInterval(beat);
    if (error instanceof LeaseLostError) throw error;
    // anything else before APEX ran (a read failed): still a recorded shadow failure, never a run failure
    r = report({ status: "failed", failure: { code: "error", message: `the shadow stage could not prepare its input: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000), wall_ms: 0 } });
  }
  clearInterval(beat);
  if (lost) throw new LeaseLostError("the step lease was lost during the APEX shadow stage");

  // 4. record (once); if the full report cannot be recorded, record why; if even that fails, complete with the reason
  let sha: string | null = null; let unrecorded: { code: string; message: string } | undefined;
  try { sha = (await ctx.sink.record(step.id, r)).report_sha256; }
  catch (error) {
    if (error instanceof LeaseLostError || (error instanceof ShadowRecordRefused && error.code === "lease_not_held")) throw error instanceof LeaseLostError ? error : new LeaseLostError(error.message);
    const code = error instanceof ShadowRecordRefused ? error.code : (error as { code?: string }).code ?? "error";
    const message = `the shadow report was not recorded (${code}): ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
    try { sha = (await ctx.sink.record(step.id, report({ status: "failed", failure: { code: "error", message, wall_ms: 0 } }))).report_sha256; }
    catch (again) { if (again instanceof LeaseLostError) throw again; unrecorded = { code: String(code).slice(0, 60), message }; }
  }
  // 5. complete: the step succeeds whatever APEX did
  await ctx.sink.complete(step.id, sha, unrecorded);
}
