import { gzipSync } from "node:zlib";

/** Builds tar archives byte by byte, including deliberately broken and hostile ones, for tests. */
export type RawHeader = {
  name?: string; prefix?: string; mode?: string; size?: number | string; type?: string; linkname?: string;
  magic?: string; checksum?: "auto" | "bad" | string; rawSize?: Buffer;
};

const put = (block: Buffer, offset: number, text: string | Buffer, max: number) => {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  bytes.copy(block, offset, 0, Math.min(bytes.length, max));
};

export function header(h: RawHeader): Buffer {
  const block = Buffer.alloc(512);
  put(block, 0, h.name ?? "x", 100);
  put(block, 100, h.mode ?? "0000644\0", 8);
  put(block, 108, "0000000\0", 8); put(block, 116, "0000000\0", 8);
  if (h.rawSize) h.rawSize.copy(block, 124, 0, 12);
  else put(block, 124, typeof h.size === "string" ? h.size : `${(h.size ?? 0).toString(8).padStart(11, "0")}\0`, 12);
  put(block, 136, "00000000000\0", 12);
  block.fill(0x20, 148, 156);
  block[156] = (h.type ?? "0").charCodeAt(0);
  put(block, 157, h.linkname ?? "", 100);
  put(block, 257, h.magic ?? "ustar\0", 6); put(block, 263, "00", 2);
  put(block, 345, h.prefix ?? "", 155);
  let sum = 0;
  for (const b of block) sum += b;
  const text = h.checksum === "bad" ? "0000001\0 " : h.checksum && h.checksum !== "auto" ? h.checksum : `${sum.toString(8).padStart(6, "0")}\0 `;
  put(block, 148, text, 8);
  return block;
}

export const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
export const file = (name: string, content: string | Buffer, extra: RawHeader = {}): Buffer => {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return Buffer.concat([header({ name, size: data.length, ...extra }), pad(data)]);
};
export const dir = (name: string): Buffer => header({ name: name.endsWith("/") ? name : `${name}/`, type: "5", mode: "0000755\0" });
export const symlink = (name: string, target: string): Buffer => header({ name, type: "2", linkname: target });
export const paxHeader = (records: Record<string, string>, kind: "x" | "g" = "x"): Buffer => {
  const body = Buffer.concat(Object.entries(records).map(([k, v]) => {
    const rest = Buffer.from(` ${k}=${v}\n`);
    let len = rest.length + 1;
    while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
    return Buffer.concat([Buffer.from(String(len)), rest]);
  }));
  return Buffer.concat([header({ name: kind === "g" ? "pax_global_header" : "PaxHeader/x", type: kind, size: body.length }), pad(body)]);
};
export const END = Buffer.alloc(1024);
export const tar = (...parts: Buffer[]): Buffer => Buffer.concat(parts);
export const gz = (data: Buffer): Buffer => gzipSync(data);
