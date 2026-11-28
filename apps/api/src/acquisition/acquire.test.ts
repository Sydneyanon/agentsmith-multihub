import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireRepository, type AcquireRequest, type AcquisitionResult } from "./acquire.js";
import { AcquisitionError } from "./errors.js";
import { manifestSha256 } from "../research-state.js";
import { buildGitFixture, type FixtureFile, type GitFixture } from "./testing/git-fixture.js";
import { FakeSource } from "./testing/fake-source.js";
import { MemoryStore } from "./testing/memory-store.js";
import { synthArchive, synthGz } from "./testing/synth-archive.js";
import { MAIN_FILES, SECRET_MARKER } from "./testing/fixtures.js";
import { END, dir, file, gz, header, paxHeader, symlink, tar } from "./testing/tar-writer.js";

const lease = { stepId: "step-1", workerId: "worker-1" };
const FIXED_NOW = () => new Date("2026-01-02T03:04:05.000Z");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");



let main: GitFixture;
beforeAll(() => { main = buildGitFixture(MAIN_FILES); });
afterAll(() => main.cleanup());

const request: AcquireRequest = { repository: "acme/vault", ref: "main" };
async function run(source: FakeSource, store = new MemoryStore(), req: AcquireRequest = request, extra: { signal?: AbortSignal; events?: Array<[string, unknown]> } = {}) {
  const result = await acquireRepository({ store, source, now: FIXED_NOW, ...(extra.signal ? { signal: extra.signal } : {}), progress: (e, f) => extra.events?.push([e, f]) }, lease, req);
  return { result, store };
}
const fail = async (promise: Promise<unknown>): Promise<AcquisitionError> => promise.then(() => { throw new Error("expected the acquisition to fail"); }, (e) => { expect(e).toBeInstanceOf(AcquisitionError); return e as AcquisitionError; });

describe("a complete acquisition of a real git repository", () => {
  let out: { result: AcquisitionResult; store: MemoryStore };
  beforeAll(async () => { out = await run(new FakeSource(main)); });

  it("seals one snapshot pinned to the resolved commit, with the canonical repository name", () => {
    expect(out.result).toMatchObject({ repository: "acme/vault", commitSha: main.commitSha, treeSha: main.treeSha, completeness: "complete", reused: "new" });
    const [snap] = [...out.store.snapshots.values()];
    expect(snap).toMatchObject({ commitSha: main.commitSha, refName: "main", sealed: true });
  });

  it("gives every entry of the git tree a manifest row, with its git object id, and no row for anything else", () => {
    const rows = out.store.rows.get(out.result.snapshotId)!;
    const treeFiles = main.treeEntries.filter((e) => e.type !== "tree");
    expect(rows.map((r) => r.path).sort()).toEqual(treeFiles.map((e) => e.path).sort());
    for (const entry of treeFiles) {
      const row = rows.find((r) => r.path === entry.path)!;
      if (entry.type === "blob") expect(row.gitBlobSha, entry.path).toBe(entry.sha);
      expect(row.sizeBytes, entry.path).toBe(entry.size ?? 0);
    }
  });

  it("stores the files it should, byte for byte, content addressed, and skips the rest with an explicit reason", () => {
    const rows = out.store.rows.get(out.result.snapshotId)!;
    const reason = (p: string) => { const r = rows.find((x) => x.path === p)!; return "skipReason" in r ? r.skipReason : "stored"; };
    expect(reason("contracts/Vault.sol")).toBe("stored");
    expect(reason("contracts/Token.sol")).toBe("stored");
    expect(reason("empty.txt")).toBe("stored");
    expect(reason("assets/model.bin")).toBe("stored");           // an LFS pointer is real repository content
    expect(reason("big.txt")).toBe("oversize");
    expect(reason("image.bin")).toBe("binary");
    expect(reason("latin1.txt")).toBe("unreadable_encoding");
    expect(reason("link")).toBe("symlink");
    expect(reason("evil-link")).toBe("symlink");
    expect(reason("deps/lib")).toBe("submodule");
    for (const row of rows) {
      if (!("blobSha256" in row)) continue;
      const original = MAIN_FILES.find((f) => f.path === row.path) as { content: string | Buffer };
      const bytes = Buffer.isBuffer(original.content) ? original.content : Buffer.from(original.content);
      expect(out.store.blobs.get(row.blobSha256)!.equals(bytes), row.path).toBe(true);
      expect(row.blobSha256).toBe(sha256(bytes));
    }
  });

  it("records the manifest hash, equal to the hash recomputed from the rows", () => {
    const rows = out.store.rows.get(out.result.snapshotId)!;
    const local = manifestSha256(rows.map((r) => ({ path: r.path, blobSha256: "blobSha256" in r ? r.blobSha256 : null, skipReason: "skipReason" in r ? r.skipReason : null })));
    expect(out.result.manifestSha256).toBe(local);
    const report = [...out.store.snapshots.values()][0]!.report as { verification: { manifest_sha256: string } };
    expect(report.verification.manifest_sha256).toBe(local);
  });

  it("records provenance: repository identity, commit, tree, archive hash, time, limits, counts", () => {
    const r = [...out.store.snapshots.values()][0]!.report as any;
    expect(r.source).toMatchObject({ host: "github.com", repository_id: 1234, full_name: "acme/vault", requested_ref: "main", commit_sha: main.commitSha, tree_sha: main.treeSha, archive_comment_matches_commit: true });
    expect(r.acquired_at).toBe("2026-01-02T03:04:05.000Z");
    expect(r.archive.sha256).toBe(sha256(main.tarGz));
    expect(r.archive.compressed_bytes).toBe(main.tarGz.length);
    expect(r.archive.top_level_directory).toBe(main.prefix);
    expect(r.tool).toEqual({ name: "agentsmith-repository-acquisition", version: "5.2.0" });
    expect(r.limits.maxFileBytes).toBe(256 * 1024);
    expect(r.completeness).toMatchObject({ status: "complete", unrepresentable_total: 0 });
    expect(r.counts).toMatchObject({ symlinks: 3, submodules: 1, lfs_pointers: 1, case_collisions: 1 });
    expect(r.counts.skipped_by_reason).toEqual({ oversize: 1, binary: 1, unreadable_encoding: 1, symlink: 3, submodule: 1 });
  });

  it("reports symlinks as inert text and flags the ones that point outside the repository", () => {
    const r = [...out.store.snapshots.values()][0]!.report as any;
    const byPath = Object.fromEntries(r.symlinks.map((s: any) => [s.path, s]));
    expect(byPath["link"]).toMatchObject({ target: "contracts/Vault.sol", escapes_root: false });
    expect(byPath["evil-link"]).toMatchObject({ target: "/etc/passwd", escapes_root: true });
    expect(byPath["up-link"]).toMatchObject({ target: "../../outside", escapes_root: true });
  });
  it("reports the submodule's pinned commit and its url from .gitmodules, never fetching it", () => {
    const r = [...out.store.snapshots.values()][0]!.report as any;
    expect(r.submodules).toEqual([{ path: "deps/lib", commit_sha: "2222222222222222222222222222222222222222", url: "https://example.invalid/some/lib.git", url_source: ".gitmodules" }]);
  });
  it("reports the LFS pointer and that its object was not fetched", () => {
    const r = [...out.store.snapshots.values()][0]!.report as any;
    expect(r.lfs_pointers).toEqual([{ path: "assets/model.bin", oid: "b".repeat(64), size: 987654 }]);
  });

  it("is deterministic: the same commit gives the same manifest and the same rows", async () => {
    const again = await run(new FakeSource(main));
    expect(again.result.manifestSha256).toBe(out.result.manifestSha256);
    expect(again.store.rows.get(again.result.snapshotId)).toEqual(out.store.rows.get(out.result.snapshotId));
  });
  it("is independent of how the network chunks the download", async () => {
    const source = new FakeSource(main); source.chunkSize = 37;
    expect((await run(source)).result.manifestSha256).toBe(out.result.manifestSha256);
  });
  it("is reproduced by an archive rebuilt entry by entry (so the tampering tests below start from a valid base)", async () => {
    const source = new FakeSource(main); source.tarGz = synthGz(main);
    expect((await run(source)).result.manifestSha256).toBe(out.result.manifestSha256);
  });
  it("never puts file content in progress events or in the report", async () => {
    const events: Array<[string, unknown]> = [];
    const { store } = await run(new FakeSource(main), new MemoryStore(), request, { events });
    expect(JSON.stringify(events)).not.toContain(SECRET_MARKER);
    expect(JSON.stringify([...store.snapshots.values()][0]!.report)).not.toContain(SECRET_MARKER);
    // phases in order (blob and manifest batches repeat their phase with a growing count; the dashboard stores them throttled)
    expect(events.map((e) => e[0]).filter((e, i, a) => a[i - 1] !== e)).toEqual(["resolved", "planned", "archive_verified", "blobs_stored", "manifest_rows_added", "sealed"]);
    const last = (name: string) => events.filter((e) => e[0] === name).at(-1)![1] as { done: number; total: number };
    expect(last("blobs_stored").done).toBe(last("blobs_stored").total);
    expect(last("manifest_rows_added").done).toBe(last("manifest_rows_added").total);
  });
  it("resolves the ref once and then addresses only the commit id", async () => {
    const source = new FakeSource(main);
    await run(source);
    expect(source.calls.filter((c) => c.startsWith("commit:"))).toEqual(["commit:main"]);
    expect(source.calls.filter((c) => c.startsWith("archive:"))).toEqual([`archive:${main.commitSha}`]);
  });
  it("uses the default branch when no ref is given, and a full commit id when given", async () => {
    const byDefault = await run(new FakeSource(main), new MemoryStore(), { repository: "acme/vault" });
    expect(byDefault.result.commitSha).toBe(main.commitSha);
    const bySha = await run(new FakeSource(main), new MemoryStore(), { repository: "acme/vault", ref: main.commitSha });
    expect(bySha.result.manifestSha256).toBe(out.result.manifestSha256);
  });
  it("stores the canonical repository name that GitHub reports, not the casing the operator typed", async () => {
    const { result } = await run(new FakeSource(main), new MemoryStore(), { repository: "ACME/Vault", ref: "main" });
    expect(result.repository).toBe("acme/vault");
  });
});

describe("failures write nothing at all", () => {
  const neverWrites = (store: MemoryStore) => { expect(store.writes).toEqual([]); expect(store.snapshots.size).toBe(0); expect(store.blobs.size).toBe(0); };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function expectRefusal(prepare: (s: FakeSource) => void | Promise<void>, code: string, extra: Partial<AcquireRequest> = {}): Promise<any> {
    const source = new FakeSource(main); await prepare(source);
    const store = new MemoryStore();
    const error = await fail(run(source, store, { ...request, ...extra }));
    expect(error.code).toBe(code);
    neverWrites(store);
    return error;
  }

  describe("a corrupted, substituted or tampered archive", () => {
    it("one flipped byte inside a file", () => expectRefusal((s) => {
      const tarball = Buffer.from(main.tarball); const at = tarball.indexOf(Buffer.from("contract Token {}"));
      tarball[at + 9] = tarball[at + 9]! ^ 0x01; s.tarGz = gz(tarball);
    }, "archive_tree_mismatch"));
    it("a same-size substitution of a file's content", () => expectRefusal((s) => {
      s.tarGz = synthGz(main, { replace: { "contracts/Token.sol": Buffer.from("pragma solidity ^0.8.20;\ncontract EVIL {}\n") } });
    }, "archive_tree_mismatch"));
    it("a file with different size than the tree says", () => expectRefusal((s) => {
      s.tarGz = synthGz(main, { replace: { "README.md": Buffer.from("# Vault, but longer\n") } });
    }, "archive_tree_mismatch"));
    it("an entry the tree lists is missing from the archive", async () => {
      const e = await expectRefusal((s) => { s.tarGz = synthGz(main, { drop: ["contracts/Token.sol", "README.md"] }); }, "archive_tree_mismatch");
      expect(e.details).toMatchObject({ kind: "missing_entries", total: 2 });
    });
    it("an extra file the tree does not list", () => expectRefusal((s) => { s.tarGz = synthGz(main, { extra: [file(`${main.prefix}/backdoor.sol`, "contract X {}\n")] }); }, "archive_tree_mismatch"));
    it("a file placed inside a submodule directory", () => expectRefusal((s) => { s.tarGz = synthGz(main, { extra: [file(`${main.prefix}/deps/lib/injected.sol`, "x")] }); }, "archive_tree_mismatch"));
    it("a regular file where the tree has a symbolic link", () => expectRefusal((s) => {
      s.tarGz = synthGz(main, { drop: ["link"], extra: [file(`${main.prefix}/link`, "contracts/Vault.sol")] });
    }, "archive_tree_mismatch"));
    it("a symbolic link where the tree has a regular file", () => expectRefusal((s) => {
      s.tarGz = synthGz(main, { drop: ["README.md"], extra: [symlink(`${main.prefix}/README.md`, "/etc/passwd")] });
    }, "archive_tree_mismatch"));
    it("a symbolic link standing in for a regular file even when its text equals the file's bytes (only the type differs)", async () => {
      const e = await expectRefusal((s) => { s.tarGz = synthGz(main, { drop: ["README.md"], extra: [symlink(`${main.prefix}/README.md`, "# Vault\n")] }); }, "archive_tree_mismatch");
      expect(e.message).toMatch(/symbolic link where the tree has a file/);
    });
    it("a symbolic link whose target differs from the git object", () => expectRefusal((s) => {
      s.tarGz = synthGz(main, { drop: ["evil-link"], extra: [symlink(`${main.prefix}/evil-link`, "/etc/shadow")] });
    }, "archive_tree_mismatch"));
    it("an archive made from a different commit", () => expectRefusal((s) => { s.tarGz = synthGz(main, { comment: "f".repeat(40) }); }, "commit_mismatch"));
    it("an archive that does not say which commit it is", () => expectRefusal((s) => { s.tarGz = synthGz(main, { comment: null }); }, "commit_mismatch"));
    it("a tree entry whose git object id is wrong", () => expectRefusal((s) => {
      s.treeEntries = s.treeEntries.map((e) => (e.path === "contracts/Token.sol" ? { ...e, sha: "0".repeat(40) } : e));
    }, "archive_tree_mismatch"));
    it("a tree that does not belong to the commit", () => expectRefusal((s) => { s.treeShaOverride = "1".repeat(40); }, "commit_mismatch"));
    it("a truncated listing from the hosting service", () => expectRefusal((s) => { s.treeTruncated = true; }, "tree_truncated"));
  });

  describe("a malformed or hostile archive", () => {
    it("a truncated download", () => expectRefusal((s) => { s.tarGz = main.tarGz.subarray(0, Math.floor(main.tarGz.length / 2)); }, "archive_malformed"));
    it("a download that is not gzip", () => expectRefusal((s) => { s.tarGz = Buffer.from("<html>rate limited</html>"); }, "archive_malformed"));
    it("a tar with no end-of-archive marker", () => expectRefusal((s) => { s.tarGz = synthGz(main, { skipEnd: true }); }, "archive_malformed"));
    it.each([
      ["a path that climbs out of the tree", (prefix: string) => `${prefix}/../../etc/passwd`],
      ["a climb hidden in the middle of a path", (prefix: string) => `${prefix}/contracts/../../secrets`],
      ["a dot segment", (prefix: string) => `${prefix}/./x`],
      ["a path with an empty segment", (prefix: string) => `${prefix}//y`],
    ])("%s is refused as unsafe, before it is compared with anything", async (_n, makePath) => {
      const e = await expectRefusal((s) => { s.tarGz = synthGz(main, { extra: [file(makePath(main.prefix), "x")] }); }, "archive_malformed");
      expect(e.message).toMatch(/unsafe path/);
    });
    it("an absolute path", () => expectRefusal((s) => { s.tarGz = synthGz(main, { extra: [file("/etc/passwd", "x")] }); }, "archive_malformed"));
    it("a second top-level directory", () => expectRefusal((s) => { s.tarGz = synthGz(main, { extra: [file("another-root/x.sol", "x")] }); }, "archive_malformed"));
    it("the same path listed twice", () => expectRefusal((s) => { s.tarGz = synthGz(main, { extra: [file(`${main.prefix}/README.md`, "# Vault\n")] }); }, "archive_malformed"));
    it("a hard link", () => expectRefusal((s) => { s.tarGz = synthGz(main, { extra: [header({ name: `${main.prefix}/h`, type: "1", linkname: `${main.prefix}/README.md` })] }); }, "unsupported_tar_entry"));
    it("a device node", () => expectRefusal((s) => { s.tarGz = synthGz(main, { extra: [header({ name: `${main.prefix}/dev`, type: "3" })] }); }, "unsupported_tar_entry"));
    it("a file named like the top-level directory", () => expectRefusal((s) => { s.tarGz = gz(tar(paxHeader({ comment: main.commitSha }, "g"), file(main.prefix, "x"), END)); }, "archive_malformed"));
  });

  describe("limits", () => {
    it("a download larger than the compressed limit", async () => { const e = await expectRefusal(() => undefined, "limit_exceeded", { limits: { maxCompressedBytes: 1000 } }); expect(e.details).toMatchObject({ limit: "compressed_bytes" }); });
    it("an archive that expands beyond the limit (a bomb)", () => expectRefusal((s) => { s.tarGz = gz(tar(paxHeader({ comment: main.commitSha }, "g"), dir(main.prefix), file(`${main.prefix}/zeros`, Buffer.alloc(40_000_000)), END)); }, "limit_exceeded", { limits: { maxUncompressedBytes: 5_000_000 } }));
    it("too many archive entries", () => expectRefusal(() => undefined, "limit_exceeded", { limits: { maxTarEntries: 5 } }));
    it("a repository with more entries than a manifest can hold, before any download", async () => {
      const source = new FakeSource(main);
      const store = new MemoryStore();
      const e = await fail(run(source, store, { ...request, limits: { maxManifestEntries: 5 } }));
      expect(e.code).toBe("repository_too_large");
      expect(source.calls.some((c) => c.startsWith("archive"))).toBe(false);
      neverWrites(store);
    });
    it("the whole acquisition running out of time (a stalled download)", async () => {
      const source = new FakeSource(main); source.hang = true;
      const store = new MemoryStore();
      const e = await fail(run(source, store, { ...request, limits: { maxWallClockMs: 60 } }));
      expect(e.code).toBe("timeout"); expect(e.retryable).toBe(true);
      neverWrites(store);
    });
    it("a cancelled step", async () => {
      const source = new FakeSource(main); source.hang = true;
      const controller = new AbortController(); setTimeout(() => controller.abort(), 30);
      const store = new MemoryStore();
      const e = await fail(run(source, store, request, { signal: controller.signal }));
      expect(e.code).toBe("timeout");
      neverWrites(store);
    });
  });

  describe("bad requests", () => {
    it.each([["a malformed repository", { repository: "not a repo" }], ["a hostile ref", { repository: "acme/vault", ref: "../../etc" }], ["a ref with a newline", { repository: "acme/vault", ref: "a\nb" }]])("%s", async (_n, req) => {
      const source = new FakeSource(main); const store = new MemoryStore();
      expect((await fail(run(source, store, req as AcquireRequest))).code).toBe("invalid_reference");
      expect(source.calls).toEqual([]); neverWrites(store);
    });
    it("a ref that does not exist", () => expectRefusal(() => undefined, "commit_unavailable", { ref: "no-such-branch" }));
    it("hosting-service errors keep their retry classification", async () => {
      const source = new FakeSource(main); source.archiveError = new AcquisitionError("network", "connection reset", true);
      const e = await fail(run(source, new MemoryStore())); expect(e.retryable).toBe(true);
      const perm = new FakeSource(main); perm.archiveError = new AcquisitionError("repository_not_found", "gone");
      expect((await fail(run(perm, new MemoryStore()))).retryable).toBe(false);
    });
  });
});

describe("the store disagreeing with what was verified", () => {
  it("a seal that reports a different manifest hash is refused", async () => {
    const store = new MemoryStore(); store.sealOverride = { manifestSha256: "0".repeat(64) };
    expect((await fail(run(new FakeSource(main), store))).code).toBe("verification_failed");
  });
  it("a seal that reports a different file count, or different stored bytes, is refused", async () => {
    const a = new MemoryStore(); a.sealOverride = { fileCount: 1 };
    expect((await fail(run(new FakeSource(main), a))).code).toBe("verification_failed");
    const b = new MemoryStore(); b.sealOverride = { totalBytes: 1 };
    expect((await fail(run(new FakeSource(main), b))).code).toBe("verification_failed");
  });
  it("a sealed snapshot that no longer verifies is refused, not returned", async () => {
    const store = new MemoryStore();
    await run(new FakeSource(main), store);
    store.verifyOk = false;
    expect((await fail(run(new FakeSource(main), store))).code).toBe("verification_failed");
  });
  it("a freshly sealed snapshot that does not verify is refused", async () => {
    const store = new MemoryStore(); store.verifyOk = false;
    expect((await fail(run(new FakeSource(main), store))).code).toBe("verification_failed");
  });
});

describe("paths the manifest cannot hold", () => {
  let odd: GitFixture;
  beforeAll(() => { odd = buildGitFixture([{ path: "ok.sol", content: "contract Ok {}\n" }, { path: "bad\tname.sol", content: "contract Tab {}\n" }, { path: "new\nline.sol", content: "contract Nl {}\n" }], { repo: "odd" }); });
  afterAll(() => odd.cleanup());
  const req: AcquireRequest = { repository: "acme/odd", ref: "main" };

  it("fails by default, naming each such path escaped, and writes nothing", async () => {
    const store = new MemoryStore();
    const e = await fail(run(new FakeSource(odd), store, req));
    expect(e.code).toBe("unrepresentable_paths");
    expect(e.details.total).toBe(2);
    expect((e.details.examples as Array<{ path: string }>).map((x) => x.path).sort()).toEqual(["bad\\u{9}name.sol", "new\\u{a}line.sol"]);
    expect(store.writes).toEqual([]);
  });
  it("on request, seals a snapshot that says it is partial and lists exactly what it could not record", async () => {
    const { result, store } = await run(new FakeSource(odd), new MemoryStore(), { ...req, onUnrepresentable: "seal_partial" });
    expect(result.completeness).toBe("partial");
    expect(store.rows.get(result.snapshotId)!.map((r) => r.path)).toEqual(["ok.sol"]);
    const report = [...store.snapshots.values()][0]!.report as any;
    expect(report.completeness.status).toBe("partial");
    expect(report.completeness.unrepresentable.map((u: any) => u.path).sort()).toEqual(["bad\\u{9}name.sol", "new\\u{a}line.sol"]);
    expect(report.completeness.unrepresentable[0]).toMatchObject({ reason: "tab_or_newline", kind: "file" });
  });
});

describe("exclusion by policy and the byte budget", () => {
  it("records excluded paths and over-budget files as explicit skips, deterministically", async () => {
    const a = await run(new FakeSource(main), new MemoryStore(), { ...request, excludePathPrefixes: ["lib", "test"], limits: { maxStoredBytes: 100 } });
    const rows = a.store.rows.get(a.result.snapshotId)!;
    const reason = (p: string) => { const r = rows.find((x) => x.path === p)!; return "skipReason" in r ? r.skipReason : "stored"; };
    expect(reason("lib/forge-std/Test.sol")).toBe("excluded_by_policy");
    expect(reason("test/Vault.t.sol")).toBe("excluded_by_policy");
    expect(Object.values(a.result.skipped).reduce((x, y) => x + y, 0) + a.result.storedFiles).toBe(rows.length);
    expect(a.result.storedBytes).toBeLessThanOrEqual(100);
    const b = await run(new FakeSource(main), new MemoryStore(), { ...request, excludePathPrefixes: ["lib", "test"], limits: { maxStoredBytes: 100 } });
    expect(b.result.manifestSha256).toBe(a.result.manifestSha256);
  });
});
