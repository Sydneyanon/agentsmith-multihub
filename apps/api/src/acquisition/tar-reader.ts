import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import type { Hash } from "node:crypto";
import { AcquisitionError } from "./errors.js";
import { escapeForReport } from "./paths.js";

/**
 * A strict, streaming reader for the tar that `git archive` produces (ustar entries, pax headers). It treats the archive as
 * hostile: nothing is ever written to a filesystem, every header field is validated, sizes are bounded against the stream,
 * and every feature this task does not need (hard links, devices, sparse files, GNU long names, base-256 sizes) is refused
 * instead of guessed at. It parses and hashes; it never interprets file content.
 */
export type TarEntryKind = "file" | "directory" | "symlink";
export type TarEntry = { path: string; kind: TarEntryKind; size: number; linkTarget?: string };
export type TarSink = { write(chunk: Buffer): void; end(): void };
export type TarHandlers = {
  /** The comment of the pax global header, which `git archive` sets to the commit id. */
  onGlobalComment(comment: string): void;
  /** Called once per file, directory or symlink, in archive order. Return a sink for a file's bytes, or null to discard them. */
  onEntry(entry: TarEntry): TarSink | null;
};
export type TarLimits = { maxUncompressedBytes: number; maxEntries: number };

const BLOCK = 512;
const MAX_PAX_BYTES = 64 * 1024;
const MAX_NAME_BYTES = 4_096;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const malformed = (message: string, details: Record<string, unknown> = {}) => new AcquisitionError("archive_malformed", message, false, undefined, details);

function decodeName(bytes: Uint8Array, what: string): string {
  try { return strictUtf8.decode(bytes); } catch {
    throw new AcquisitionError("unrepresentable_paths", `${what} is not valid UTF-8`, false, undefined, { bytes_hex: Buffer.from(bytes.subarray(0, 64)).toString("hex") });
  }
}

function cString(block: Buffer, start: number, length: number): Uint8Array {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return end === -1 ? field : field.subarray(0, end);
}

/** Octal digits terminated by NUL or space. Anything else, including the base-256 extension, is refused. */
function octal(field: Buffer, what: string): number {
  if ((field[0]! & 0x80) !== 0) throw new AcquisitionError("unsupported_tar_entry", `${what} uses the base-256 encoding`);
  const text = field.toString("latin1").replace(/^ +/, "").replace(/[\0 ]+$/, "");
  if (text === "") return 0;
  if (!/^[0-7]{1,12}$/.test(text)) throw malformed(`${what} is not a valid octal number`);
  return Number.parseInt(text, 8);
}

function parsePax(data: Buffer, scope: "entry" | "global"): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1 || space - pos > 8) throw malformed("pax record has no length");
    const lengthText = data.subarray(pos, space).toString("latin1");
    if (!/^[1-9][0-9]{0,7}$/.test(lengthText)) throw malformed("pax record length is not a decimal number");
    const length = Number(lengthText);
    if (length <= space - pos + 1 || pos + length > data.length) throw malformed("pax record length is outside the header");
    const record = data.subarray(space + 1, pos + length);
    if (record[record.length - 1] !== 0x0a) throw malformed("pax record does not end with a newline");
    const eq = record.indexOf(0x3d);
    if (eq < 1) throw malformed("pax record has no key");
    const key = record.subarray(0, eq).toString("latin1");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(key)) throw malformed("pax record key is not plain text");
    if (key.startsWith("GNU.sparse") || key.startsWith("SCHILY.")) throw new AcquisitionError("unsupported_tar_entry", `pax key ${escapeForReport(key, 60)} is not supported`);
    const valueBytes = record.subarray(eq + 1, record.length - 1);
    const value = key === "path" || key === "linkpath" ? decodeName(valueBytes, `pax ${key}`) : (() => {
      try { return strictUtf8.decode(valueBytes); } catch { throw malformed(`pax value for ${escapeForReport(key, 60)} is not valid UTF-8`); }
    })();
    if (scope === "global" && (key === "path" || key === "linkpath" || key === "size")) throw new AcquisitionError("unsupported_tar_entry", `a global pax header may not set ${key}`);
    out[key] = value;
    pos += length;
  }
  return out;
}

type State = "header" | "data" | "padding" | "pax" | "end";

export class TarParser {
  private leftover: Buffer = Buffer.alloc(0);
  private state: State = "header";
  private zeroBlocks = 0;
  private total = 0;
  private entries = 0;
  private remaining = 0;
  private padding = 0;
  private sink: TarSink | null = null;
  private pax: { kind: "x" | "g"; chunks: Buffer[] } | null = null;
  private pendingPax: Record<string, string> | null = null;
  private sawGlobal = false;

  constructor(private readonly limits: TarLimits, private readonly handlers: TarHandlers) {}

  get bytes(): number { return this.total; }
  get entryCount(): number { return this.entries; }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.total > this.limits.maxUncompressedBytes) throw new AcquisitionError("limit_exceeded", `archive expands beyond ${this.limits.maxUncompressedBytes} bytes`, false, undefined, { limit: "uncompressed_bytes" });
    let data = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    this.leftover = Buffer.alloc(0);
    let offset = 0;
    while (offset < data.length) {
      if (this.state === "end") {
        for (let i = offset; i < data.length; i += 1) if (data[i] !== 0) throw malformed("data after the end-of-archive marker");
        return;
      }
      if (this.state === "header") {
        if (data.length - offset < BLOCK) { this.leftover = Buffer.from(data.subarray(offset)); return; }
        this.header(data.subarray(offset, offset + BLOCK));
        offset += BLOCK;
      } else if (this.state === "data") {
        const n = Math.min(this.remaining, data.length - offset);
        this.sink!.write(data.subarray(offset, offset + n));
        this.remaining -= n; offset += n;
        if (this.remaining === 0) { this.sink!.end(); this.sink = null; this.afterData(); }
      } else if (this.state === "pax") {
        const n = Math.min(this.remaining, data.length - offset);
        this.pax!.chunks.push(Buffer.from(data.subarray(offset, offset + n)));
        this.remaining -= n; offset += n;
        if (this.remaining === 0) this.finishPax();
      } else {
        const n = Math.min(this.padding, data.length - offset);
        this.padding -= n; offset += n;
        if (this.padding === 0) this.state = "header";
      }
    }
  }

  finish(): void {
    if (this.leftover.length > 0) throw malformed("archive ends inside a header block (truncated)");
    if (this.state !== "end") {
      const where = this.state === "data" || this.state === "padding" || this.state === "pax" ? "inside an entry" : "before the end-of-archive marker";
      throw malformed(`archive ended ${where} (truncated)`);
    }
    if (this.pendingPax) throw malformed("archive ended after an extended header with no entry");
  }

  private afterData(): void {
    this.state = this.padding > 0 ? "padding" : "header";
  }

  private header(block: Buffer): void {
    if (block.every((b) => b === 0)) {
      this.zeroBlocks += 1;
      if (this.zeroBlocks === 2) this.state = "end";
      return;
    }
    if (this.zeroBlocks !== 0) throw malformed("a zero block was not followed by a second zero block");
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
    if (octal(block.subarray(148, 156), "header checksum") !== sum) throw malformed("header checksum does not match");
    const magic = block.subarray(257, 262).toString("latin1");
    if (magic !== "ustar") throw malformed("not a ustar or pax archive");
    const typeflag = String.fromCharCode(block[156]!);
    let size = octal(block.subarray(124, 136), "entry size");
    const padFor = (n: number) => (BLOCK - (n % BLOCK)) % BLOCK;

    if (typeflag === "x" || typeflag === "g") {
      if (size > MAX_PAX_BYTES) throw malformed("extended header is too large");
      if (typeflag === "x" && this.pendingPax) throw malformed("two extended headers in a row");
      if (typeflag === "g" && this.sawGlobal) throw malformed("more than one global extended header");
      this.pax = { kind: typeflag, chunks: [] };
      this.remaining = size; this.padding = padFor(size);
      if (size === 0) this.finishPax(); else this.state = "pax";
      return;
    }
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5" && typeflag !== "2") {
      throw new AcquisitionError("unsupported_tar_entry", `entry type ${escapeForReport(typeflag, 8)} is not supported (only files, directories and symbolic links)`, false, undefined, { typeflag: block[156] });
    }

    this.entries += 1;
    if (this.entries > this.limits.maxEntries) throw new AcquisitionError("limit_exceeded", `archive has more than ${this.limits.maxEntries} entries`, false, undefined, { limit: "tar_entries" });
    const pax = this.pendingPax ?? {};
    this.pendingPax = null;
    if (pax.size !== undefined) {
      if (!/^[0-9]{1,15}$/.test(pax.size)) throw malformed("pax size is not a decimal number");
      size = Number(pax.size);
    }
    const nameBytes = cString(block, 0, 100);
    const prefixBytes = cString(block, 345, 155);
    if (nameBytes.length + prefixBytes.length > MAX_NAME_BYTES) throw malformed("entry name is too long");
    let path = pax.path ?? ((prefixBytes.length ? `${decodeName(prefixBytes, "entry prefix")}/` : "") + decodeName(nameBytes, "entry name"));
    if (Buffer.byteLength(path) > MAX_NAME_BYTES) throw malformed("entry name is too long");
    if (path === "") throw malformed("entry has an empty name");

    if (typeflag === "5") {
      if (size !== 0) throw malformed("a directory entry carries data");
      this.handlers.onEntry({ path: path.replace(/\/+$/, ""), kind: "directory", size: 0 });
      return;
    }
    if (typeflag === "2") {
      if (size !== 0) throw malformed("a symbolic link entry carries data");
      const target = pax.linkpath ?? decodeName(cString(block, 157, 100), "symbolic link target");
      if (Buffer.byteLength(target) > MAX_NAME_BYTES) throw malformed("symbolic link target is too long");
      this.handlers.onEntry({ path, kind: "symlink", size: 0, linkTarget: target });
      return;
    }
    if (path.endsWith("/")) throw malformed("a file entry has a directory-style name");
    if (size > this.limits.maxUncompressedBytes) throw new AcquisitionError("limit_exceeded", "an entry declares more data than the archive limit", false, undefined, { limit: "uncompressed_bytes" });
    const sink = this.handlers.onEntry({ path, kind: "file", size });
    this.padding = padFor(size);
    if (size === 0) {
      sink?.end();
      this.state = this.padding > 0 ? "padding" : "header";
      return;
    }
    this.sink = sink ?? { write() {}, end() {} };
    this.remaining = size;
    this.state = "data";
  }

  private finishPax(): void {
    const data = Buffer.concat(this.pax!.chunks);
    const kind = this.pax!.kind;
    this.pax = null;
    const records = parsePax(data, kind === "g" ? "global" : "entry");
    if (kind === "g") {
      this.sawGlobal = true;
      if (records.comment !== undefined) this.handlers.onGlobalComment(records.comment);
    } else this.pendingPax = records;
    this.state = this.padding > 0 ? "padding" : "header";
  }
}

export type CompressedStats = { compressed: number; uncompressed: number; sha256: Hash };

/**
 * Inflates a gzip stream with hard byte limits and exact accounting. A truncated or corrupt stream is an error, never a short
 * archive. `stats.sha256` hashes the compressed bytes as received (provenance of what was fetched).
 */
export async function* gunzipLimited(
  source: AsyncIterable<Uint8Array>, limits: { maxCompressedBytes: number; maxUncompressedBytes: number }, stats: CompressedStats, signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const gunzip = createGunzip({ chunkSize: 64 * 1024 });
  const input = (async function* () {
    for await (const piece of source) {
      signal?.throwIfAborted();
      const chunk = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
      stats.compressed += chunk.length;
      if (stats.compressed > limits.maxCompressedBytes) throw new AcquisitionError("limit_exceeded", `download is larger than ${limits.maxCompressedBytes} bytes`, false, undefined, { limit: "compressed_bytes" });
      stats.sha256.update(chunk);
      yield chunk;
    }
  })();
  const readable = Readable.from(input, { objectMode: false });
  readable.on("error", (error) => gunzip.destroy(error));
  readable.pipe(gunzip);
  try {
    for await (const out of gunzip) {
      signal?.throwIfAborted();
      const chunk = out as Buffer;
      stats.uncompressed += chunk.length;
      if (stats.uncompressed > limits.maxUncompressedBytes) throw new AcquisitionError("limit_exceeded", `archive expands beyond ${limits.maxUncompressedBytes} bytes`, false, undefined, { limit: "uncompressed_bytes" });
      yield chunk;
    }
  } catch (error) {
    readable.destroy(); gunzip.destroy();
    if (error instanceof AcquisitionError) throw error;
    const code = (error as { code?: string }).code ?? "";
    if (code.startsWith("Z_")) throw malformed(`the archive is not a valid gzip stream (${code})`);
    throw error;
  }
}

export async function readTar(source: AsyncIterable<Buffer>, limits: TarLimits, handlers: TarHandlers): Promise<{ bytes: number; entries: number }> {
  const parser = new TarParser(limits, handlers);
  for await (const chunk of source) parser.push(chunk);
  parser.finish();
  return { bytes: parser.bytes, entries: parser.entryCount };
}
