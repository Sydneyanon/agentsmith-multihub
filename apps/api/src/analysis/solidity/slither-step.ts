import { tmpdir } from "node:os";
import { ResearchStore } from "../../research-state.js";
import type { ClaimedStep } from "../../worker.js";
import { DryRunViolation } from "../../engine/effects.js";
import { recordSlitherLeads, runSlither } from "../../engine/tools/slither.js";
import type { ToolFailure } from "../../engine/tools/run-tool.js";
import { SLITHER_SCAN_SWITCH, SLITHER_VERSION } from "./keys.js";
import { isResearchSlitherStep } from "./slither-record.js";
import { sealedSnapshot, withHeartbeat, type AnalysisStepContext } from "./step.js";

/**
 * The OPTIONAL `slither_scan` stage of a `repository_research` run (between analyze_structure and challenge_leads). It exists only in
 * runs created with `slitherScan` (which requires `structuralAnalysis`), and a worker claims it only when SLITHER_SCAN_ENABLED=true AND
 * AGENTSMITH_SLITHER_BIN and AGENTSMITH_SOLC_BIN are set (see `slitherScanClaimable`). It does not depend on the engine loop or on any
 * draft migration: it reads only the run's sealed, hash-verified snapshot (files written byte for byte from research_blobs into a
 * private temporary directory by the existing runner) and writes only through the research store under the step lease.
 *
 * The runner is the existing pinned one (engine/tools/slither.ts): exact version check, solc passed explicitly, fixed arguments, a
 * minimal environment (PATH and a private HOME), a hard timeout. Mapped detections become plane-1 hypotheses with generator
 * `slither@<version>` through the SAME mapping the engine loop uses (`recordSlitherLeads`); informational detectors are counted only.
 *
 * A tool failure never fails the run: the step SUCCEEDS with `status: "abstained"` and the failure code, and the dossier's coverage and
 * limitations say that Slither abstained and why. A missing tool is an abstention, never an empty "no findings".
 */
export const SLITHER_SCAN_ROLE = "external_producer";
type Env = Record<string, string | undefined>;
const set = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
/** The worker may claim the stage only with the explicit switch (exactly "true") AND both pinned binaries configured. */
export function slitherScanClaimable(env: Env): boolean {
  return env[SLITHER_SCAN_SWITCH] === "true" && set(env["AGENTSMITH_SLITHER_BIN"]) && set(env["AGENTSMITH_SOLC_BIN"]);
}

/** Resource limits. Defaults: 300 s per Slither invocation, 900 s in total, 16 MiB of output per invocation, at most 1000 stored leads. */
export const SLITHER_SCAN_DEFAULTS = { timeoutMs: 300_000, totalTimeoutMs: 900_000, maxOutputBytes: 16 * 1024 * 1024, maxLeads: 1000 } as const;
const LIMIT_ENV = [
  ["timeoutMs", "SLITHER_SCAN_TIMEOUT_MS", 1_000, 3_600_000],
  ["totalTimeoutMs", "SLITHER_SCAN_TOTAL_TIMEOUT_MS", 1_000, 7_200_000],
  ["maxOutputBytes", "SLITHER_SCAN_MAX_OUTPUT_BYTES", 65_536, 64 * 1024 * 1024],
] as const;
export type SlitherScanLimits = { timeoutMs: number; totalTimeoutMs: number; maxOutputBytes: number; maxLeads: number; ignored?: string[] };
/** A value that is not an integer within its bounds is ignored (the default applies) and named in `ignored`, never silently stretched. */
export function slitherScanLimits(env: Env): SlitherScanLimits {
  const out: SlitherScanLimits = { ...SLITHER_SCAN_DEFAULTS }; const ignored: string[] = [];
  for (const [key, name, min, max] of LIMIT_ENV) {
    const raw = env[name]; if (raw === undefined || raw === "") continue;
    const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (Number.isSafeInteger(n) && n >= min && n <= max) out[key] = n; else ignored.push(name);
  }
  if (out.totalTimeoutMs < out.timeoutMs) out.timeoutMs = out.totalTimeoutMs;
  return ignored.length ? { ...out, ignored } : out;
}

const passive = { execution_mode: "passive_only", authorization_status: "unverified", active_testing_allowed: false } as const;
/** the private working directory differs per run; it is never recorded */
const scrub = (s: string) => s.split(tmpdir()).join("<tmp>").replace(/<tmp>\/agentsmith-tool-[A-Za-z0-9]+/g, "<snapshot>").slice(0, 2000);

export async function processResearchSlitherScanStep(ctx: AnalysisStepContext, step: ClaimedStep): Promise<void> {
  if (!isResearchSlitherStep(step)) throw new Error("not a repository_research slither_scan step");
  const env = ctx.env ?? process.env;
  const store = new ResearchStore(ctx.pool); const snap = await sealedSnapshot(ctx.pool, store, step.workflow_run_id);
  const lease = { stepId: step.id, workerId: ctx.workerId };
  const limits = slitherScanLimits(env);
  const base = { producer: "slither", pinned_version: SLITHER_VERSION, snapshot_id: snap.snapshotId, repository: snap.repository, commit_sha: snap.commitSha, manifest_sha256: snap.manifestSha256, limits, ...passive };
  await withHeartbeat(ctx, step, async () => {
    const started = Date.now();
    const abstain = (failure: ToolFailure, durationMs: number) => ctx.worker.complete(step.id, {
      status: "abstained", abstention: { code: failure.code, detail: scrub(failure.detail) }, generator: null, hypothesis_ids: [], leads: [], leads_by_class: {},
      wall_ms: durationMs, ...base,
    });
    // the claim gate is the worker's key selection; this re-check covers a worker that reached the step another way (e.g. the
    // engine loop's key list): without the switch and both binaries the stage abstains explicitly instead of running or passing silently
    if (env[SLITHER_SCAN_SWITCH] !== "true") { await abstain({ code: "tool_unavailable", detail: `${SLITHER_SCAN_SWITCH} is not "true" on the worker that claimed this step` }, 0); return; }
    const slitherBin = env["AGENTSMITH_SLITHER_BIN"]; const solcBin = env["AGENTSMITH_SOLC_BIN"];
    if (!set(slitherBin) || !set(solcBin)) { await abstain({ code: "tool_unavailable", detail: "AGENTSMITH_SLITHER_BIN or AGENTSMITH_SOLC_BIN is not set on this worker" }, 0); return; }
    // ONLY the sealed snapshot: the stored bytes of its Solidity files (the snapshot was verified above)
    const files = (await ctx.pool.query<{ path: string; content: Buffer }>(
      `SELECT f.path, b.content FROM repo_snapshot_files f JOIN research_blobs b ON b.content_sha256 = f.blob_sha256 WHERE f.snapshot_id = $1 AND f.path LIKE '%.sol' ORDER BY f.path COLLATE "C"`, [snap.snapshotId])).rows;
    let r: Awaited<ReturnType<typeof runSlither>>;
    try {
      r = await runSlither({ files, slitherBin: slitherBin!, solcBin: solcBin!, timeoutMs: limits.timeoutMs, totalTimeoutMs: limits.totalTimeoutMs, maxOutputBytes: limits.maxOutputBytes });
    } catch (e) {
      if (e instanceof DryRunViolation) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      r = { ok: false, failure: { code: /unsafe snapshot path/.test(msg) ? "input_invalid" : "crashed", detail: msg }, durationMs: Date.now() - started };
    }
    if (!r.ok) { await abstain(r.failure, r.durationMs); return; }
    const rawBlob = Buffer.byteLength(r.rawOutput) <= 1_048_576 ? (await store.putBlob(lease, Buffer.from(r.rawOutput, "utf8"))).sha256 : null;
    // the whole snapshot is in scope: every contract Slither reports on, anchored only where the location exists in the snapshot
    const rec = await recordSlitherLeads(store, lease, { snapshotId: snap.snapshotId, run: r, paths: new Set(files.map((f) => f.path)), includeContract: () => true, maxLeads: limits.maxLeads });
    const byClass: Record<string, number> = {}; for (const l of rec.leads) byClass[l.class] = (byClass[l.class] ?? 0) + 1;
    const informational = Object.values(rec.unmapped).reduce((a, b) => a + b, 0);
    await ctx.worker.complete(step.id, {
      status: "tool_completed", generator: `slither@${r.version}`,
      tool: { name: "slither", version: r.version, solc_version: r.solcVersion, args: r.args, input_manifest_sha256: r.inputManifestSha256, raw_output_sha256: r.rawOutputSha256, raw_output_blob: rawBlob, exit_codes: r.exitCodes, duration_ms: r.durationMs },
      hypothesis_ids: rec.leads.map((l) => l.hypothesisId), leads: rec.leads, leads_by_class: byClass,
      detections_total: r.detections.length, informational_detections: informational, unmapped_detectors: rec.unmapped, outside_snapshot_contracts: rec.outside, unanchored: rec.unanchored, leads_not_recorded: rec.notRecorded,
      wall_ms: Date.now() - started, ...base,
    });
  });
}

