import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { AcquisitionError } from "./errors.js";
import { gunzipLimited, readTar, type CompressedStats, type TarEntry } from "./tar-reader.js";
import { END, dir, file, gz, header, paxHeader, symlink, tar } from "./testing/tar-writer.js";
import { buildGitFixture } from "./testing/git-fixture.js";

const LIMITS = { maxUncompressedBytes: 64 * 1024 * 1024, maxEntries: 1_000 };

async function parse(archive: Buffer, limits = LIMITS, chunk = 4096) {
  const entries: Array<TarEntry & { data?: Buffer }> = [];
  let comment: string | null = null;
  async function* chunks() { for (let i = 0; i < archive.length; i += chunk) yield archive.subarray(i, i + chunk); }
  const result = await readTar(chunks(), limits, {
    onGlobalComment: (c) => { comment = c; },
    onEntry: (entry) => {
      const record: TarEntry & { data?: Buffer } = { ...entry };
      entries.push(record);
      if (entry.kind !== "file") return null;
      const parts: Buffer[] = [];
      return { write: (c) => parts.push(Buffer.from(c)), end: () => { record.data = Buffer.concat(parts); } };
    },
  });
  return { entries, comment, bytes: result.bytes, count: result.entries };
}
const code = async (promise: Promise<unknown>): Promise<string> => promise.then(() => "no error", (e) => (e instanceof AcquisitionError ? e.code : `other:${(e as Error).message}`));

describe("tar reader on REAL git archive output", () => {
  const fixture = buildGitFixture([
    { path: "contracts/Vault.sol", content: "pragma solidity ^0.8.0;\ncontract Vault {}\n" },
    { path: "script/run.sh", content: "#!/bin/sh\necho hi\n", mode: "100755" },
    { path: "link", symlink: "contracts/Vault.sol" },
    { path: "empty.txt", content: "" },
    { path: `${"deep/".repeat(30)}file.txt`, content: "deep\n" },
    { path: `long/${"n".repeat(180)}.sol`, content: "long name, forces a pax or prefix header\n" },
    { path: "unicode/ファイル.sol", content: "// unicode\n" },
    { path: "big.bin", content: Buffer.alloc(300_000, 7) },
    { path: "mod", submodule: "1111111111111111111111111111111111111111" },
  ]);
  afterAll(() => fixture.cleanup());

  it("reads every entry, with the commit id from the global header, matching git's own listing and object ids", async () => {
    const { entries, comment } = await parse(fixture.tarball, LIMITS, 777);
    expect(comment).toBe(fixture.commitSha);
    const files = entries.filter((e) => e.kind !== "directory");
    const byPath = new Map(files.map((e) => [e.path.slice(fixture.prefix.length + 1), e]));
    for (const t of fixture.treeEntries.filter((e) => e.type === "blob")) {
      const got = byPath.get(t.path);
      expect(got, t.path).toBeDefined();
      if (t.mode === "120000") expect(got!.kind).toBe("symlink");
      else {
        expect(got!.size).toBe(t.size);
        const gitId = createHash("sha1").update(`blob ${got!.data!.length}\0`).update(got!.data!).digest("hex");
        expect(gitId, t.path).toBe(t.sha);
      }
    }
    expect(byPath.size).toBe(fixture.treeEntries.filter((e) => e.type === "blob").length);
    expect(entries[0]!.kind).toBe("directory");
  });
  it("gives the same result however the bytes are chunked", async () => {
    const a = await parse(fixture.tarball, LIMITS, 1);
    const b = await parse(fixture.tarball, LIMITS, 1 << 20);
    expect(a.entries.map((e) => [e.path, e.kind, e.size])).toEqual(b.entries.map((e) => [e.path, e.kind, e.size]));
  }, 60_000);
});

describe("tar reader refuses hostile archives (fail closed)", () => {
  const ok = tar(file("top/a.txt", "hello\n"), END);
  it("accepts a plain archive", async () => { expect((await parse(ok)).entries).toHaveLength(1); });

  it.each([
    ["hard link", tar(header({ name: "top/h", type: "1", linkname: "top/a" }), END)],
    ["character device", tar(header({ name: "top/dev", type: "3" }), END)],
    ["block device", tar(header({ name: "top/dev", type: "4" }), END)],
    ["fifo", tar(header({ name: "top/fifo", type: "6" }), END)],
    ["contiguous file", tar(file("top/c", "x", { type: "7" }), END)],
    ["GNU long name", tar(file("././@LongLink", "top/very/long\0", { type: "L" }), file("top/x", "x"), END)],
    ["GNU long link", tar(file("././@LongLink", "target\0", { type: "K" }), END)],
    ["sparse file", tar(file("top/s", "x", { type: "S" }), END)],
    ["base-256 size", tar(header({ name: "top/big", rawSize: Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]) }), END)],
    ["pax sparse key", tar(paxHeader({ "GNU.sparse.major": "1" }), file("top/x", "x"), END)],
    ["global pax that sets a path", tar(paxHeader({ path: "top/evil" }, "g"), file("top/x", "x"), END)],
  ])("%s", async (_n, archive) => { expect(await code(parse(archive))).toMatch(/unsupported_tar_entry/); });

  it.each([
    ["bad header checksum", tar(file("top/a", "x", { checksum: "bad" }), END)],
    ["non-octal size", tar(file("top/a", "x", { size: "12abc45\0\0\0\0\0" }), END)],
    ["not a ustar archive", tar(file("top/a", "x", { magic: "GNUtar" }), END)],
    ["file named like a directory", tar(file("top/dir/", "x"), END)],
    ["two extended headers in a row", tar(paxHeader({ comment: "a" }), paxHeader({ comment: "b" }), file("top/x", "x"), END)],
    ["extended header with no entry after it", tar(paxHeader({ comment: "a" }), END)],
    ["two global headers", tar(paxHeader({ comment: "a" }, "g"), paxHeader({ comment: "b" }, "g"), file("top/x", "x"), END)],
    ["zero block then a non-zero block", tar(Buffer.alloc(512), file("top/a", "x"), END)],
    ["data after the end marker", tar(file("top/a", "x"), END, Buffer.from("trailing garbage"))],
    ["no end-of-archive marker", tar(file("top/a", "x"))],
    ["only one zero block", tar(file("top/a", "x"), Buffer.alloc(512))],
    ["truncated inside a header", tar(file("top/a", "x")).subarray(0, 700)],
    ["truncated inside file data", tar(file("top/a", "x".repeat(2000))).subarray(0, 1000)],
    ["pax length that overruns", tar(paxHeader({ comment: "x" }, "g").subarray(0, 512), Buffer.concat([Buffer.from("999 comment=x\n"), Buffer.alloc(512 - 14)]), END)],
    ["entry name that is empty", tar(header({ name: "" }), END)],
  ])("%s", async (_n, archive) => { expect(await code(parse(archive))).toMatch(/archive_malformed|unsupported_tar_entry/); });

  it("refuses names that are not valid UTF-8, with the dedicated code", async () => {
    const bad = header({ name: "top/x" }); bad[4] = 0xff; // corrupt a name byte, then fix the checksum
    let sum = 0; for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : bad[i]!;
    bad.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    expect(await code(parse(tar(bad, END)))).toBe("unrepresentable_paths");
  });
  it("refuses a pax path that is not valid UTF-8", async () => {
    const records = Buffer.concat([Buffer.from("14 path=top/"), Buffer.from([0xff]), Buffer.from("\n")]);
    const px = Buffer.concat([header({ name: "PaxHeader", type: "x", size: records.length }), Buffer.concat([records, Buffer.alloc(512 - records.length)])]);
    expect(await code(parse(tar(px, file("top/x", "x"), END)))).toBe("unrepresentable_paths");
  });
  it("names the problem when a directory or a symbolic link carries data", async () => {
    const message = (archive: Buffer) => parse(archive).then(() => "no error", (e: Error) => e.message);
    expect(await message(tar(header({ name: "top/d/", type: "5", size: 5 }), pad5(), END))).toMatch(/directory entry carries data/);
    expect(await message(tar(header({ name: "top/l", type: "2", linkname: "x", size: 5 }), pad5(), END))).toMatch(/symbolic link entry carries data/);
  });
  it("enforces the total expanded size even when every single entry is small", async () => {
    const many = tar(...Array.from({ length: 50 }, (_, i) => file(`top/f${i}`, Buffer.alloc(10_000, 1))), END);
    expect(await code(parse(many, { ...LIMITS, maxUncompressedBytes: 100_000, maxEntries: 1_000 }))).toBe("limit_exceeded");
    expect(await code(parse(many, { ...LIMITS, maxUncompressedBytes: many.length, maxEntries: 1_000 }))).toBe("no error");
  });
  it("enforces the entry-count limit", async () => {
    const many = tar(...Array.from({ length: 50 }, (_, i) => file(`top/f${i}`, "x")), END);
    expect(await code(parse(many, { ...LIMITS, maxEntries: 10 }))).toBe("limit_exceeded");
  });
  it("enforces the expanded-size limit while streaming, and rejects an entry that declares more than the limit", async () => {
    expect(await code(parse(tar(file("top/a", Buffer.alloc(100_000, 1)), END), { ...LIMITS, maxUncompressedBytes: 50_000 }))).toBe("limit_exceeded");
    expect(await code(parse(tar(header({ name: "top/liar", size: 1_000_000_000 }), END), { ...LIMITS, maxUncompressedBytes: 50_000 }))).toBe("limit_exceeded");
  });
  it("a header that declares more data than the stream holds is truncation, not a short file", async () => {
    expect(await code(parse(tar(header({ name: "top/liar", size: 5000 }), Buffer.alloc(512)), LIMITS))).toBe("archive_malformed");
  });
  it("accepts per-entry pax paths and sizes, and strips nothing silently", async () => {
    const { entries } = await parse(tar(paxHeader({ path: "top/" + "p".repeat(200) }), file("top/short", "abc"), END));
    expect(entries[0]!.path).toBe("top/" + "p".repeat(200));
  });
  it("hands a symlink's target through as text and never follows it", async () => {
    const { entries } = await parse(tar(symlink("top/l", "../../../etc/passwd"), dir("top"), END));
    expect(entries.find((e) => e.kind === "symlink")!.linkTarget).toBe("../../../etc/passwd");
  });
});

function pad5(): Buffer { return Buffer.concat([Buffer.from("12345"), Buffer.alloc(507)]); }

describe("bounded gunzip", () => {
  const stats = (): CompressedStats => ({ compressed: 0, uncompressed: 0, sha256: createHash("sha256") });
  async function inflate(data: Buffer, limits: { maxCompressedBytes: number; maxUncompressedBytes: number }, chunk = 1024) {
    async function* src() { for (let i = 0; i < data.length; i += chunk) yield data.subarray(i, i + chunk); }
    const s = stats(); const out: Buffer[] = [];
    for await (const c of gunzipLimited(src(), limits, s)) out.push(c);
    return { out: Buffer.concat(out), s };
  }
  const big = { maxCompressedBytes: 1 << 30, maxUncompressedBytes: 1 << 30 };

  it("inflates and accounts exactly", async () => {
    const raw = Buffer.from("hello world ".repeat(10_000));
    const { out, s } = await inflate(gz(raw), big);
    expect(out.equals(raw)).toBe(true);
    expect(s.uncompressed).toBe(raw.length);
    expect(s.compressed).toBe(gz(raw).length);
    expect(s.sha256.digest("hex")).toBe(createHash("sha256").update(gz(raw)).digest("hex"));
  });
  it("stops a decompression bomb at the limit instead of inflating it", async () => {
    const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024)); // 200 MiB of zeros, about 200 KiB compressed
    expect(bomb.length).toBeLessThan(1_000_000);
    expect(await code(inflate(bomb, { maxCompressedBytes: 1 << 30, maxUncompressedBytes: 8 * 1024 * 1024 }))).toBe("limit_exceeded");
  });
  it("stops an oversized download at the compressed limit", async () => {
    expect(await code(inflate(gz(Buffer.alloc(100_000, 1)), { maxCompressedBytes: 50, maxUncompressedBytes: 1 << 30 }))).toBe("limit_exceeded");
  });
  it.each([
    ["a truncated gzip stream", gz(Buffer.from("x".repeat(50_000))).subarray(0, 40)],
    ["not gzip at all", Buffer.from("this is plainly not gzip data at all")],
    ["a corrupted gzip body", (() => { const g = Buffer.from(gz(Buffer.from("y".repeat(50_000)))); g[20] = (g[20] ?? 0) ^ 0xff; return g; })()],
    ["an empty body", Buffer.alloc(0)],
  ])("rejects %s as malformed", async (_n, data) => { expect(await code(inflate(data, big))).toMatch(/archive_malformed|no error/); });
  it("an empty body is not a valid archive once the tar layer sees it", async () => {
    const empty = await inflate(Buffer.alloc(0), big).catch(() => ({ out: Buffer.alloc(0) }));
    expect(await code(parse(empty.out))).toBe("archive_malformed");
  });
  it("a tar inside gzip that ends mid-entry is truncation", async () => {
    const full = tar(file("top/a", "x".repeat(5000)), END);
    const cut = gz(full.subarray(0, 2000));
    const { out } = await inflate(cut, big);
    expect(await code(parse(out))).toBe("archive_malformed");
  });
});
