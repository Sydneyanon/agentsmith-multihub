import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
export const SLITHER_ARGS = (dir: string, solc: string) => [dir, "--solc", solc, "--json", "-", "--disable-color"];

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

export async function runSlither(input: { files: ReadonlyArray<{ path: string; content: Buffer }>; slitherBin: string; solcBin: string; timeoutMs?: number }): Promise<SlitherRun | { ok: false; failure: ToolFailure; durationMs: number }> {
  const started = Date.now();
  const fail = (failure: ToolFailure) => ({ ok: false as const, failure, durationMs: Date.now() - started });
  if (!input.files.length) return fail({ code: "input_invalid", detail: "no Solidity files in the snapshot" });
  const work = materialise(input.files); const home = mkdtempSync(join(tmpdir(), "agentsmith-tool-home-"));
  try {
    const v = await toolVersion(input.slitherBin, home, work.dir); if ("code" in v) return fail(v);
    if (v.version !== SLITHER_VERSION) return fail({ code: "version_mismatch", detail: `slither ${v.version}; pinned ${SLITHER_VERSION}` });
    const sv = await toolVersion(input.solcBin, home, work.dir); if ("code" in sv) return fail(sv);
    const dirs = [...new Set(input.files.filter((f) => f.path.endsWith(".sol")).map((f) => (f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".")))].sort();
    if (!dirs.length) return fail({ code: "input_invalid", detail: "no Solidity files in the snapshot" });
    const all: SlitherDetection[] = []; const outputs: string[] = []; const argsUsed: string[][] = []; const exitCodes: Array<number | null> = []; const seen = new Set<string>();
    for (const dir of dirs) {
      const args = SLITHER_ARGS(dir, input.solcBin); argsUsed.push(args.map((x) => (x === input.solcBin ? "<solc>" : x)));
      const r = await runFixed(input.slitherBin, args, { cwd: work.dir, timeoutMs: input.timeoutMs ?? 300_000, home });
      if (r.spawnError) return fail({ code: "tool_unavailable", detail: r.spawnError });
      if (r.timedOut) return fail({ code: "timeout", detail: `killed after ${input.timeoutMs ?? 300_000} ms in ${dir}` });
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
    return { ok: true, version: v.version, solcVersion: sv.version, args: argsUsed, inputManifestSha256: inputManifestSha256(input.files),
      rawOutput, rawOutputSha256: sha256(rawOutput), exitCodes, durationMs: Date.now() - started, detections: all };
  } finally { work.cleanup(); rmSync(home, { recursive: true, force: true }); }
}
