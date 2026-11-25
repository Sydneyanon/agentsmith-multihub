import type { FastifyRequest } from "fastify";
import { parseAddress } from "./net/ip-policy.js";

export type Cidr = { family: 4 | 6; network: bigint; bits: number };

/** Parses "a.b.c.d/n" or "v6/n". Returns an error string for anything not exact (no bare addresses, no wildcards). */
export function parseCidr(text: string): Cidr | string {
  const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(text.trim());
  if (!m) return `"${text}" is not a CIDR (expected address/prefix)`;
  const addr = parseAddress(m[1]!);
  const bits = Number(m[2]);
  if (!addr) return `"${text}" has an invalid address`;
  const max = addr.family === 4 ? 32 : 128;
  if (bits > max) return `"${text}" has an invalid prefix length`;
  // Reject a prefix so short it trusts a large part of the address space (a misconfiguration, not a proxy).
  if (bits < (addr.family === 4 ? 8 : 16)) return `"${text}" is too broad to be a proxy range`;
  const shift = BigInt(max - bits);
  return { family: addr.family, network: (addr.value >> shift) << shift, bits };
}

export function parseCidrList(raw: string | undefined): { cidrs: Cidr[] } | { error: string } {
  if (!raw || !raw.trim()) return { cidrs: [] };
  const out: Cidr[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const c = parseCidr(part);
    if (typeof c === "string") return { error: c };
    out.push(c);
  }
  return { cidrs: out };
}

export function inCidr(address: string, cidr: Cidr): boolean {
  const a = parseAddress(address);
  if (!a || a.family !== cidr.family) return false;
  const max = cidr.family === 4 ? 32 : 128;
  const shift = BigInt(max - cidr.bits);
  return ((a.value >> shift) << shift) === cidr.network;
}

/**
 * The identity used to key failed-attempt throttling. It is the TCP peer address, except that when (and only when) the peer is
 * inside an explicitly configured trusted-proxy range, a single well-formed `Fly-Client-IP` header is used. `X-Forwarded-For`,
 * `Forwarded` and every other client-supplied header are never consulted: on Fly the leftmost X-Forwarded-For entry is
 * attacker-controlled. Nothing is trusted by default.
 */
export function createClientIdentity(trusted: readonly Cidr[]): (request: FastifyRequest) => string {
  return (request) => {
    const peer = request.socket.remoteAddress ?? "unknown";
    if (trusted.length > 0 && trusted.some((c) => inCidr(peer, c))) {
      const header = request.headers["fly-client-ip"];
      if (typeof header === "string" && parseAddress(header) !== null && !header.includes("%")) return `client:${header.toLowerCase()}`;
    }
    return `peer:${peer}`;
  };
}
