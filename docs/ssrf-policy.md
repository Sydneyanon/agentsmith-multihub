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

## Known limitations

- Resolution uses the platform resolver (`getaddrinfo`), so `/etc/hosts` and the platform's DNS are trusted for *answers* but every answer is still classified. A hostile DNS server can only produce answers that are then rejected or pinned.
- Only one address family fallback strategy: validated addresses are tried in order; a policy failure is never retried against another address.
- Bodies other than string/`Uint8Array`, HTTP proxies, `Accept-Encoding` negotiation and HTTP/2 are not supported by the client.
- GitHub acquisition (`acquisition/github-source.ts`) keeps its own host allow-list and redirect loop on top of this client (defence in depth); both must pass.
- Egress filtering at the network layer (Fly) is not configured; this is an application-layer control.
