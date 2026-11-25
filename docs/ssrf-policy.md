# Outbound request policy (SSRF)

Status: implemented in the SSRF PR (finding 1 of the stack review). Applies to every request whose destination derives from untrusted input: submitted source URLs, repository identities, and any redirect issued by a third-party host.

## Two layers

1. **Name policy** — `resolveSourceReference` (`apps/api/src/source-resolver.ts`, built on `net/ip-policy.ts`). Parses a submitted URL without a network request and rejects what can never be a public target: every IP-literal spelling (dotted, decimal, hex, octal, short, bracketed IPv6), single-label names, reserved or internal TLDs (`localhost`, `local`, `internal`, `intranet`, `lan`, `corp`, `home`, `private`, `localdomain`, `test`, `invalid`, `example`, `onion`, `arpa`, …), trailing-dot variants, malformed labels, credentials and non-default ports. This layer cannot see DNS, so it is advisory.
2. **Connect-time policy** — `net/safe-fetch.ts`, exposed to application code only as `outboundFetch` (`net/outbound.ts`). This is the enforcement point.

## What the connect-time client guarantees

| Property | Mechanism | Test |
|---|---|---|
| Destination is public | Name is resolved once; **every** answer must be public (default-deny classifier: only canonical global-unicast addresses outside all IANA special-use ranges, incl. IPv4-mapped, NAT64, 6to4, Teredo, ULA, link-local, multicast, documentation, CGNAT, benchmarking, class E) | `ip-policy.test.ts`, `safe-fetch.test.ts` |
| DNS rebinding | The TCP connection is made to the validated literal address; DNS is never consulted again for that hop | "connects to the address that was validated" |
| Verified actual destination | After `connect`, before any byte is written, `socket.remoteAddress` must equal the validated address, else `peer_mismatch` | "verifies the connected peer address" |
| TLS identity | SNI and certificate identity use the original hostname; `Host` is the original name | "sends the original hostname" |
| Redirects | Followed manually; each hop re-runs scheme, credentials, port, name and resolution checks; `Authorization`/`Cookie` dropped cross-origin; capped (default 5). `redirect: "manual"` returns the 3xx to the caller; `"error"` refuses | `safe-fetch.test.ts` redirects block |
| Scheme/port | HTTPS and port 443 only | scheme/port test |
| No bypass in code | A test scans application sources: only `net/` may reference global `fetch`, `http(s).request/get`, `net.connect`, or `undici` | `outbound.test.ts` |
| No bypass in production | Loopback/HTTP policies, the test override seam and the unguarded fixture fetch all throw when `NODE_ENV=production` | `outbound.test.ts`, `safe-fetch.test.ts` |

Revert-proof evidence: `scripts/ssrf-mutation-check.py` re-introduces 31 individual weaknesses in a scratch worktree; each must make the tests fail.

## Address classification

Default deny. IPv4 is public only if canonical dotted-decimal (no leading zeros, no decimal/hex/octal/short forms) and outside: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (incl. cloud metadata), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.31.196/24`, `192.52.193/24`, `192.88.99/24`, `192.168/16`, `192.175.48/24`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`. IPv6 is public only if inside `2000::/3` (global unicast) and not in `2001::/23` (IETF assignments, Teredo), `2001:db8::/32`, `2002::/16` (6to4), `3fff::/20`; everything outside `2000::/3` is blocked (loopback, unspecified, IPv4-mapped/compatible, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, discard `100::/64`, ULA `fc00::/7`, link-local `fe80::/10`, site-local, multicast). Zone ids are stripped; unparseable text is "invalid" and therefore blocked.

## Status statement

This closes the gaps found in review finding 1 at the application layer. It is **not** claimed to make SSRF "completely solved": the deployment environment (Fly egress, resolver behaviour), the real GitHub response path and a real Docker build have not been reviewed or exercised. Those remain open items for the combined stack review.

## Known limitations

- Resolution uses the platform resolver (`getaddrinfo`), so `/etc/hosts` and the platform's DNS are trusted for *answers* but every answer is still classified. A hostile DNS server can only produce answers that are then rejected or pinned.
- Only one address family fallback strategy: validated addresses are tried in order; a policy failure is never retried against another address.
- Bodies other than string/`Uint8Array`, HTTP proxies, `Accept-Encoding` negotiation and HTTP/2 are not supported by the client.
- GitHub acquisition (`acquisition/github-source.ts`) keeps its own host allow-list and redirect loop on top of this client (defence in depth); both must pass.
- Egress filtering at the network layer (Fly) is not configured; this is an application-layer control.
