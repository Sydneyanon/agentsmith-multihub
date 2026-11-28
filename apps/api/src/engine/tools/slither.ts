import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SPAN_LINES, type ResearchStore, type StepLease } from "../../research-state.js";
import { SLITHER_DETECTOR_CLASS, SLITHER_VERSION } from "../capabilities.js";
import { inputManifestSha256, materialise, runFixed, sha256, toolVersion, type ToolFailure } from "./run-tool.js";

/**
 * Slither as an external DETECTION producer (plane 1). Pinned: the binary must report exactly SLITHER_VERSION, and solc is passed
 * explicitly, so nothing is downloaded (no solc-select). Fixed arguments per source directory: `<dir> --solc <solc> --json - --disable-color`
 * (Slither's solc mode compiles the files directly in the directory it is given, so it runs once per directory holding .sol files and the
 * results are merged; a project that needs framework remappings fails as `compile_failed`, explicitly). The result keeps
 * the reproducibility record (versions, arguments, input manifest hash, raw output hash, exit code, duration) and the structured
 * detector results; every failure is an explicit code, never an empty "no findings".
 */
export const SLITHER_ARGS = (dir: string, solc: string, remappings: readonly string[] = []) => [dir, "--solc", solc, "--json", "-", "--disable-color", ...(remappings.length ? ["--solc-remaps", remappings.join(" ")] : [])];
/** a remapping is passed to the compiler only in this shape (no whitespace, no option-looking text); anything else is refused */
const SAFE_REMAPPING = /^(?:[A-Za-z0-9@._\/-]+:)?[A-Za-z0-9@._\/-]+=[A-Za-z0-9@._\/-]+$/;

export type SlitherElement = { type: string; name: string; contract: string | null; file: string; lines: number[] };
export type SlitherDetection = { check: string; impact: string; confidence: string; description: string; bugClass: string | null; elements: SlitherElement[] };
export type SlitherRun = {
  ok: true; version: string; solcVersion: string; args: string[][]; inputManifestSha256: string; rawOutput: string; rawOutputSha256: string;
  exitCodes: Array<number | null>; durationMs: number; detections: SlitherDetection[];
};

type RawElement = { type?: string; name?: string; source_mapping?: { filename_relative?: string; lines?: number[] }; type_specific_fields?: { parent?: { name?: string; type?: string; type_specific_fields?: { parent?: { name?: string } } } } };
function contractOf(e: RawElement): string | null {
  if (e.type === "contract") return e.name ?? null;
  const p = e.type_specific_fields?.parent;
  if (p?.type === "contract") return p.name ?? null;
  if (p?.type === "function") return p.type_specific_fields?.parent?.name ?? null;
  return null;
}

export function parseSlitherJson(raw: string): { detections: SlitherDetection[] } | ToolFailure {
  let doc: { success?: boolean; error?: string | null; results?: { detectors?: Array<{ check?: string; impact?: string; confidence?: string; description?: string; elements?: RawElement[] }> } };
  try { doc = JSON.parse(raw); } catch { return { code: "output_invalid", detail: "slither did not print JSON" }; }
  if (doc.success !== true) return { code: "compile_failed", detail: String(doc.error ?? "slither reported success=false").slice(0, 2000) };
  const ds = doc.results?.detectors;
  if (ds !== undefined && !Array.isArray(ds)) return { code: "output_invalid", detail: "results.detectors is not a list" };
  const detections: SlitherDetection[] = [];
  for (const d of ds ?? []) {
    if (typeof d.check !== "string" || !Array.isArray(d.elements)) return { code: "output_invalid", detail: "a detector result lacks check or elements" };
    detections.push({ check: d.check, impact: String(d.impact ?? ""), confidence: String(d.confidence ?? ""), description: String(d.description ?? "").slice(0, 4000), bugClass: SLITHER_DETECTOR_CLASS[d.check] ?? null,
      elements: d.elements.map((e) => ({ type: String(e.type ?? ""), name: String(e.name ?? ""), contract: contractOf(e), file: String(e.source_mapping?.filename_relative ?? ""), lines: (e.source_mapping?.lines ?? []).filter((n) => Number.isInteger(n) && n > 0) })) });
  }
  return { detections };
}

/**
 * `timeoutMs` bounds each Slither invocation (default 300 s). Optional, for callers that need a hard overall bound: `totalTimeoutMs`
 * bounds the sum of all invocations (each one gets at most the time remaining), and `maxOutputBytes` bounds what one invocation may
 * print (output beyond it is an explicit `output_invalid`, never a truncated parse). Without them the behaviour is the original one.
 */
export async function runSlither(input: { files: ReadonlyArray<{ path: string; content: Buffer }>; slitherBin: string; solcBin: string; timeoutMs?: number; totalTimeoutMs?: number; maxOutputBytes?: number;
  /** C3: dependency sources, written beside the snapshot so imports resolve; never scanned as targets and never anchored (only `files` are) */
  dependencyFiles?: ReadonlyArray<{ path: string; content: Buffer }>;
  /** C3: import remappings from the run's dependency manifest (only those whose target is available) */
  remappings?: readonly string[] }): Promise<SlitherRun | { ok: false; failure: ToolFailure; durationMs: number }> {
  const started = Date.now();
  const fail = (failure: ToolFailure) => ({ ok: false as const, failure, durationMs: Date.now() - started });
  if (!input.files.length) return fail({ code: "input_invalid", detail: "no Solidity files in the snapshot" });
  const remappings = [...(input.remappings ?? [])];
  const unsafe = remappings.find((r) => !SAFE_REMAPPING.test(r));
  if (unsafe !== undefined) return fail({ code: "input_invalid", detail: `a remapping is not in the accepted shape and was not passed to the compiler: ${unsafe.slice(0, 120)}` });
  const own = new Set(input.files.map((f) => f.path));
  const extra = (input.dependencyFiles ?? []).filter((f) => !own.has(f.path)); // a dependency never overwrites a file of the analysed snapshot
  const work = materialise([...input.files, ...extra]); const home = mkdtempSync(join(tmpdir(), "agentsmith-tool-home-"));
  try {
    const v = await toolVersion(input.slitherBin, home, work.dir); if ("code" in v) return fail(v);
    if (v.version !== SLITHER_VERSION) return fail({ code: "version_mismatch", detail: `slither ${v.version}; pinned ${SLITHER_VERSION}` });
    const sv = await toolVersion(input.solcBin, home, work.dir); if ("code" in sv) return fail(sv);
    const dirs = [...new Set(input.files.filter((f) => f.path.endsWith(".sol")).map((f) => (f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".")))].sort();
    if (!dirs.length) return fail({ code: "input_invalid", detail: "no Solidity files in the snapshot" });
    const all: SlitherDetection[] = []; const outputs: string[] = []; const argsUsed: string[][] = []; const exitCodes: Array<number | null> = []; const seen = new Set<string>();
    for (const dir of dirs) {
      const args = SLITHER_ARGS(dir, input.solcBin, remappings); argsUsed.push(args.map((x) => (x === input.solcBin ? "<solc>" : x)));
      const perRun = input.timeoutMs ?? 300_000;
      const remaining = input.totalTimeoutMs === undefined ? perRun : input.totalTimeoutMs - (Date.now() - started);
      if (remaining <= 0) return fail({ code: "timeout", detail: `overall limit of ${input.totalTimeoutMs} ms reached before ${dir}` });
      const timeoutMs = Math.min(perRun, remaining);
      const r = await runFixed(input.slitherBin, args, { cwd: work.dir, timeoutMs, home, ...(input.maxOutputBytes !== undefined ? { maxBuffer: input.maxOutputBytes } : {}) });
      if (r.spawnError === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return fail({ code: "output_invalid", detail: `output exceeded ${input.maxOutputBytes ?? "the output limit"} bytes in ${dir}` });
      if (r.spawnError) return fail({ code: "tool_unavailable", detail: r.spawnError });
      if (r.timedOut) return fail({ code: "timeout", detail: `killed after ${timeoutMs} ms in ${dir}` });
      // reproducibility: the private working directory differs per run, so its absolute path is replaced before hashing or storing
      const stdout = r.stdout.split(work.dir).join("<snapshot>");
      const parsed = parseSlitherJson(stdout);
      if ("code" in parsed) return fail(parsed.code === "output_invalid" && r.exitCode !== 0 && r.exitCode !== 255 ? { code: "crashed", detail: `exit ${r.exitCode} in ${dir}: ${r.stderr.slice(-1000)}` } : { ...parsed, detail: `${dir}: ${parsed.detail}` });
      outputs.push(stdout); exitCodes.push(r.exitCode);
      for (const d of parsed.detections) { // a file compiled from two directories is reported twice: keep one
        const key = `${d.check}|${d.elements.map((e) => `${e.file}:${e.lines[0] ?? 0}:${e.name}`).join(",")}`;
        if (!seen.has(key)) { seen.add(key); all.push(d); }
      }
    }
    const rawOutput = outputs.length === 1 ? outputs[0]! : JSON.stringify(outputs.map((o) => JSON.parse(o)));
    return { ok: true, version: v.version, solcVersion: sv.version, args: argsUsed, inputManifestSha256: inputManifestSha256(extra.length ? [...input.files, ...extra] : input.files),
      rawOutput, rawOutputSha256: sha256(rawOutput), exitCodes, durationMs: Date.now() - started, detections: all };
  } finally { work.cleanup(); rmSync(home, { recursive: true, force: true }); }
}

/** Structured lead summary every producer returns, so a challenge step treats all producers alike. */
export type LeadRef = { hypothesisId: string; class: string; contract: string; function: string; file: string; line: number };
export type SlitherLeadRecord = { leads: LeadRef[]; unmapped: Record<string, number>; outside: number; unanchored: number; notRecorded: number };

/**
 * The ONE mapping from Slither detections to plane-1 hypotheses, shared by every step that runs Slither (the engine loop's assignment
 * step and the repository_research `slither_scan` step). A detection whose check has no AgentSmith class is informational: counted in
 * `unmapped`, never stored. A mapped detection is anchored to its first element on an included contract (a function element preferred);
 * the span is created through the research store, which hash-verifies it against the sealed snapshot, and a detection that cannot be
 * anchored is counted (`unanchored`), never stored without evidence. The generator is `slither@<version>`: tool output is a claim.
 * `maxLeads` (optional) bounds how many hypotheses one run may write; detections beyond it are counted in `notRecorded`.
 */
export async function recordSlitherLeads(store: Pick<ResearchStore, "createEvidenceSpan" | "createHypothesis">, lease: StepLease, input: {
  snapshotId: string; run: Pick<SlitherRun, "version" | "detections">; paths: ReadonlySet<string>; includeContract: (contract: string) => boolean; maxLeads?: number;
}): Promise<SlitherLeadRecord> {
  const { run, snapshotId } = input; const include = input.includeContract;
  const leads: LeadRef[] = []; const unmapped: Record<string, number> = {}; let outside = 0; let unanchored = 0; let notRecorded = 0;
  for (const d of run.detections) {
    if (!d.bugClass) { unmapped[d.check] = (unmapped[d.check] ?? 0) + 1; continue; }
    const el = d.elements.find((e) => e.type === "function" && e.contract && include(e.contract)) ?? d.elements.find((e) => e.contract && include(e.contract));
    if (!el) { outside++; continue; }
    if (!input.paths.has(el.file) || !el.lines.length) { unanchored++; continue; }
    if (input.maxLeads !== undefined && leads.length >= input.maxLeads) { notRecorded++; continue; }
    const start = Math.min(...el.lines); const end = Math.max(...el.lines); const span = end - start + 1 <= MAX_SPAN_LINES ? [start, end] : [start, start];
    let spanId: string;
    try { spanId = await store.createEvidenceSpan(lease, { snapshotId, path: el.file, lineStart: span[0]!, lineEnd: span[1]! }); } catch { unanchored++; continue; }
    const fn = el.type === "function" ? el.name : "";
    const h = await store.createHypothesis(lease, {
      snapshotId, family: `slither-${d.check}`,
      claim: `Slither ${d.check} (${d.impact} impact, ${d.confidence} confidence) in ${el.contract}${fn ? `.${fn}` : ""}: ${d.description.split("\n")[0]!.slice(0, 600)}`,
      rationale: `Slither ${run.version} detector ${d.check}, mapped to AgentSmith class ${d.bugClass}. Tool output is a claim, not evidence. Full description: ${d.description.slice(0, 3000)}`,
      requiredChecks: ["independent validation by an evaluator other than Slither"], alternativeExplanations: ["detector false positive", "behaviour intended and guarded elsewhere"],
      generator: { kind: "deterministic_rule", id: "slither", version: run.version }, spans: [{ spanId, role: "primary" }],
    });
    if (!leads.some((l) => l.hypothesisId === h.id)) leads.push({ hypothesisId: h.id, class: d.bugClass, contract: el.contract!, function: fn, file: el.file, line: start });
  }
  return { leads, unmapped, outside, unanchored, notRecorded };
}
