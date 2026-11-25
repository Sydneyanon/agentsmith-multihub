import { isIP } from "node:net";
import { domainToASCII } from "node:url";

/**
 * Destination policy for outbound requests made on behalf of untrusted input.
 *
 * Design: DEFAULT DENY. An address is public only if it is canonical text for a
 * global-unicast address that is in no special-use range. Anything that is not
 * canonical (decimal/hex/octal/short IPv4 spellings, zone ids on v4, stray
 * whitespace) is "invalid" and therefore blocked, so a parser differential
 * between this module and the resolver cannot turn into a bypass.
 */

export type AddressClass =
  | { kind: "ipv4" | "ipv6"; public: boolean; reason: string }
  | { kind: "invalid"; public: false; reason: string };

const V4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

function parseV4(text: string): number | null {
  const m = V4.exec(text);
  if (!m) return null;
  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const part = Number(m[i]);
    if (part > 255) return null;
    value = value * 256 + part;
  }
  return value; // 0 .. 2^32-1 (safe integer)
}

/** [network, prefix length, reason] — every IANA IPv4 special-purpose block plus multicast and the reserved class E. */
const V4_BLOCKED: Array<[string, number, string]> = [
  ["0.0.0.0", 8, "this-network"], ["10.0.0.0", 8, "private"], ["100.64.0.0", 10, "shared-address-space"],
  ["127.0.0.0", 8, "loopback"], ["169.254.0.0", 16, "link-local"], ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "ietf-protocol-assignments"], ["192.0.2.0", 24, "documentation"], ["192.31.196.0", 24, "as112"],
  ["192.52.193.0", 24, "amt"], ["192.88.99.0", 24, "6to4-relay"], ["192.168.0.0", 16, "private"],
  ["192.175.48.0", 24, "as112"], ["198.18.0.0", 15, "benchmarking"], ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"], ["224.0.0.0", 4, "multicast"], ["240.0.0.0", 4, "reserved"],
];
const V4_RANGES = V4_BLOCKED.map(([net, bits, reason]) => {
  const base = parseV4(net)!;
  const size = 2 ** (32 - bits);
  return { lo: base, hi: base + size - 1, reason };
});

function parseV6(raw: string): number[] | null {
  let text = raw;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (isIP(text) !== 6) return null;
  // Trailing dotted-quad (::ffff:1.2.3.4) becomes two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function classifyV6(g: number[]): { public: boolean; reason: string } {
  // Default deny: only global unicast 2000::/3 can be public, minus the carve-outs below.
  if ((g[0]! & 0xe000) !== 0x2000) {
    if (g.every((x) => x === 0)) return { public: false, reason: "unspecified" };
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return { public: false, reason: "loopback" };
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return { public: false, reason: "ipv4-mapped" };
    if ((g[0]! & 0xfe00) === 0xfc00) return { public: false, reason: "unique-local" };
    if ((g[0]! & 0xffc0) === 0xfe80) return { public: false, reason: "link-local" };
    if ((g[0]! & 0xffc0) === 0xfec0) return { public: false, reason: "site-local" };
    if ((g[0]! & 0xff00) === 0xff00) return { public: false, reason: "multicast" };
    if (g[0] === 0x64 && g[1] === 0xff9b) return { public: false, reason: "nat64" };
    if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return { public: false, reason: "discard" };
    return { public: false, reason: "not-global-unicast" };
  }
  if (g[0] === 0x2002) return { public: false, reason: "6to4" }; // embeds an arbitrary IPv4 address
  if (g[0] === 0x2001 && g[1]! < 0x200) return { public: false, reason: "ietf-protocol-assignments/teredo" }; // 2001::/23
  if (g[0] === 0x2001 && g[1] === 0xdb8) return { public: false, reason: "documentation" };
  if (g[0] === 0x3fff && g[1]! < 0x1000) return { public: false, reason: "documentation" }; // 3fff::/20
  return { public: true, reason: "global-unicast" };
}

export function classifyAddress(text: string): AddressClass {
  if (typeof text !== "string" || text === "") return { kind: "invalid", public: false, reason: "empty" };
  if (text.includes(":")) {
    const groups = parseV6(text);
    if (!groups) return { kind: "invalid", public: false, reason: "unparseable-ipv6" };
    return { kind: "ipv6", ...classifyV6(groups) };
  }
  const v4 = parseV4(text);
  if (v4 === null) return { kind: "invalid", public: false, reason: "not-canonical-ipv4" };
  for (const r of V4_RANGES) if (v4 >= r.lo && v4 <= r.hi) return { kind: "ipv4", public: false, reason: r.reason };
  return { kind: "ipv4", public: true, reason: "global-unicast" };
}

export const isPublicAddress = (text: string): boolean => classifyAddress(text).public;

/** Loopback only (127.0.0.0/8 and ::1) — used solely by the explicit test-only policy. */
export function isLoopbackAddress(text: string): boolean {
  const c = classifyAddress(text);
  return !c.public && c.reason === "loopback";
}

/** Canonical comparison form for peer-address verification. */
export function canonicalAddress(text: string): string {
  const zone = text.indexOf("%");
  const bare = zone === -1 ? text : text.slice(0, zone);
  const g = bare.includes(":") ? parseV6(bare) : null;
  return g ? g.map((x) => x.toString(16)).join(":") : bare.toLowerCase();
}

export function normalizeHostname(host: string): string {
  const stripped = host.endsWith(".") ? host.slice(0, -1) : host;
  return (domainToASCII(stripped.toLowerCase()) || stripped.toLowerCase());
}

const BLOCKED_TLDS = new Set([
  "localhost", "local", "internal", "intranet", "lan", "corp", "home", "private", "localdomain",
  "test", "invalid", "example", "onion", "arpa", "alt", "i2p", "exit",
]);

export type HostAssessment = { ok: true; hostname: string } | { ok: false; reason: string };

/**
 * Names only. IP literals in any spelling (bracketed IPv6, decimal, hex, octal, short forms)
 * are refused outright: every legitimate target of this system is a DNS name, and
 * accepting literals only widens the surface. Single-label and reserved/internal names are
 * refused because they resolve through search domains or internal DNS, not the public internet.
 */
export function assessHostname(input: string): HostAssessment {
  if (typeof input !== "string" || input === "") return { ok: false, reason: "empty host" };
  if (input.startsWith("[") || input.includes(":")) return { ok: false, reason: "IP literal" };
  if (isIP(input) !== 0) return { ok: false, reason: "IP literal" };
  const host = normalizeHostname(input);
  if (host === "" || host.length > 253) return { ok: false, reason: "invalid host length" };
  const labels = host.split(".");
  // WHATWG treats a host whose last label is numeric/hex as an IPv4 spelling (2130706433, 0x7f.1, 1.2.3).
  if (/^(0x[0-9a-f]*|\d+)$/i.test(labels[labels.length - 1]!) || isIP(host) !== 0) return { ok: false, reason: "IP literal" };
  for (const label of labels) {
    if (label.length < 1 || label.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      return { ok: false, reason: "invalid host label" };
    }
  }
  if (labels.length < 2) return { ok: false, reason: "single-label host" };
  if (BLOCKED_TLDS.has(labels[labels.length - 1]!)) return { ok: false, reason: "reserved or internal name" };
  return { ok: true, hostname: host };
}
