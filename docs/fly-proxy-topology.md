# Fly proxy topology and client identity

Scope: what the application may believe about "who is the client", used only to key throttling of **invalid** authentication attempts (review finding 3).

## Verified
- **`X-Forwarded-For` is client-controlled.** Production experiment (harmless `GET`s, earlier in this engagement): with the old `trustProxy: true`, a request carrying `X-Forwarded-For: 198.51.100.9` was logged as client `198.51.100.9` instead of the real address. The leftmost entry is attacker-chosen, so it must never select a rate-limit bucket. A spoofed `Fly-Client-IP` header was ignored in that experiment (the logged address did not change).
- Fly documents `Fly-Client-IP` as added by Fly Proxy (docs, request headers page).

## Not verified (do not rely on)
- The **socket peer** of requests reaching the machine was never observed directly: the earlier logs recorded Fastify's computed `req.ip`, which under `trustProxy: true` is derived from headers, and an in-machine `netstat` attempt showed only the machine's own addresses. Internal-looking addresses (`172.19.5.x`, `fdaa:…`) and Fly IPv6 addresses appeared in logs, so the peer range is **unconfirmed**.
- Whether Fly Proxy **overwrites** a client-supplied `Fly-Client-IP`. The one observation above (spoof ignored) is consistent with overwriting, but is a single sample.

## Design (what this change does)
1. `trustProxy` is `false`. `request.ip` is the TCP peer.
2. **A valid token is never throttled.** Only invalid attempts count and are answered with 429, so invalid traffic from any address, including the operator's own or a shared gateway address, cannot lock the operator out.
3. Throttling is keyed by the TCP peer. Behind Fly the peer is a shared gateway, so in practice invalid attempts share one bucket; that is harmless because it can only reject *invalid* attempts.
4. Optional, off by default: `HUB_TRUSTED_PROXY_CIDRS` (comma-separated CIDRs, no range broader than /8 IPv4 or /16 IPv6). When — and only when — the peer is inside one of these ranges, a single well-formed `Fly-Client-IP` header selects the bucket. `X-Forwarded-For`, `Forwarded` and all other headers are never used.

## Procedure to enable per-client buckets (needs separate deployment approval)
1. Deploy with `trustProxy: false` (this change) and read `req.ip` in the logs — now the real socket peer — for several requests, including one from outside Fly, to learn the actual peer range.
2. Confirm overwrite semantics by sending a request with a forged `Fly-Client-IP` from outside and checking the application sees the real client address in a trusted-peer request.
3. Only then set `HUB_TRUSTED_PROXY_CIDRS` to the observed range. Until then, nothing is trusted.

## Limitations
- The limiter is in memory and per process (one machine today).
- Logs show the peer, not the end client, until step 3 is done.
