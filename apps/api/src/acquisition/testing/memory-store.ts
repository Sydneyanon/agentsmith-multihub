import { createHash, randomUUID } from "node:crypto";
import { manifestSha256, type ResearchStore, type SnapshotFileInput, type StepLease } from "../../research-state.js";
import type { AcquisitionStore } from "../acquire.js";

/** Records every call and keeps state in memory, so tests can prove that a failed acquisition wrote nothing. */
export class MemoryStore implements AcquisitionStore {
  calls: string[] = [];
  snapshots = new Map<string, { id: string; repository: string; commitSha: string; refName: string | null; report: Record<string, unknown>; sealed: boolean; manifest: string | null }>();
  blobs = new Map<string, Buffer>();
  rows = new Map<string, SnapshotFileInput[]>();
  failOn: string | null = null;
  /** Make the seal report something other than what was written (simulates a database that disagrees). */
  sealOverride: Partial<{ manifestSha256: string; fileCount: number; totalBytes: number }> | null = null;
  verifyOk = true;

  private record(name: string) { this.calls.push(name); if (this.failOn === name) throw new Error(`injected failure in ${name}`); }
  get writes(): string[] { return this.calls.filter((c) => c !== "findSnapshot" && c !== "verifySnapshot"); }

  findSnapshot: ResearchStore["findSnapshot"] = async (_lease: StepLease, repository, commitSha) => {
    this.record("findSnapshot");
    const s = [...this.snapshots.values()].find((x) => x.repository === repository && x.commitSha === commitSha);
    if (!s) return null;
    const rows = this.rows.get(s.id) ?? [];
    return { id: s.id, refName: s.refName, report: s.report, sealed: s.sealed, manifestSha256: s.manifest, fileCount: s.sealed ? rows.length : null, totalBytes: s.sealed ? rows.reduce((n, r) => n + ("blobSha256" in r ? r.sizeBytes : 0), 0) : null };
  };
  createSnapshot: ResearchStore["createSnapshot"] = async (_lease, input) => {
    this.record("createSnapshot");
    const existing = [...this.snapshots.values()].find((x) => x.repository === input.repository && x.commitSha === input.commitSha);
    if (existing) return existing.id;
    const id = randomUUID();
    this.snapshots.set(id, { id, repository: input.repository, commitSha: input.commitSha, refName: input.refName ?? null, report: input.acquisitionReport ?? {}, sealed: false, manifest: null });
    this.rows.set(id, []);
    return id;
  };
  putBlob: ResearchStore["putBlob"] = async (_lease, content) => {
    this.record("putBlob");
    const sha256 = createHash("sha256").update(content).digest("hex");
    this.blobs.set(sha256, content);
    return { sha256, sizeBytes: content.length };
  };
  addSnapshotFiles: ResearchStore["addSnapshotFiles"] = async (_lease, id, files) => {
    this.record("addSnapshotFiles");
    const rows = this.rows.get(id)!;
    for (const f of files) if (!rows.some((r) => r.path === f.path)) rows.push(f);
  };
  sealSnapshot: ResearchStore["sealSnapshot"] = async (_lease, id) => {
    this.record("sealSnapshot");
    const rows = this.rows.get(id)!;
    const manifest = manifestSha256(rows.map((r) => ({ path: r.path, blobSha256: "blobSha256" in r ? r.blobSha256 : null, skipReason: "skipReason" in r ? r.skipReason : null })));
    const snap = this.snapshots.get(id)!; snap.sealed = true; snap.manifest = manifest;
    return { manifestSha256: manifest, fileCount: rows.length, totalBytes: rows.reduce((n, r) => n + ("blobSha256" in r ? r.sizeBytes : 0), 0), ...this.sealOverride };
  };
  verifySnapshot: ResearchStore["verifySnapshot"] = async (id) => {
    this.record("verifySnapshot");
    const rows = this.rows.get(id) ?? [];
    const missing = rows.filter((r) => "blobSha256" in r && !this.blobs.has(r.blobSha256)).length;
    return { ok: this.verifyOk && missing === 0 && this.snapshots.get(id)?.sealed === true };
  };
}
