# Hub access model (alpha) and what internet exposure still needs

Status: the alpha is a **single-operator bootstrap**, not a finished private-access system. Nothing here is deployed.

## What protects the hub today
- `/hub/*` serves only the static client (a login shell, public code). Every research record is behind `/v1/*`, which requires the operator bearer token; without a configured token it answers `503`, never open.
- Token quality is enforced at startup (32+ characters, header-safe characters, not repetitive) and failed attempts lock the client out (`429` + `Retry-After`), per address and globally. Details and limits: `docs/security-and-scope.md`.
- The token lives in `sessionStorage` (tab-scoped, cleared on Lock) and is sent only as an `Authorization` header, never in a URL. Any script running on the hub origin could read it. What stops such a script from existing is the CSP (`script-src 'self'`, no inline script or eval, `connect-src 'self'`, `frame-ancestors 'none'`) together with text-only rendering of third-party content (no `innerHTML` anywhere; a test fails the build if one appears).
- `npm run hub:layout-check` drives a real browser against the served hub and fails if the CSP header weakens, if the browser stops refusing injected inline script, inline style attributes or foreign images, or if normal use produces any CSP violation. It is separate from `npm run verify` (needs Chromium and a loopback Postgres).

## Known limits of the bootstrap
- One shared secret: no per-user identity, no audit of *who* acted, no revocation short of rotating the secret.
- `sessionStorage` is not equivalent to an `HttpOnly` session cookie; it trades XSS exposure for simplicity.
- The limiter is in memory and per process, and trusts `X-Forwarded-For`.
- The login shell is public and reveals that a hub exists at the address.

## Required before the hub is reachable from the internet
1. A generated token in the host's secret store (never in source control), rotated on any suspicion.
2. The access model below, or an equivalent decision recorded by the owner.
3. TLS only, with HSTS, on the hub's own hostname (for example `hub.agentsmithdesk.xyz`), separate from the public Hunt site and its cookies.
4. A deliberate decision on whether the login shell should also sit behind network or identity-aware access.

## Proposed access model for multi-user (not built)
Put identity in front of the hub rather than growing a password system inside it: either an identity-aware proxy / OIDC login (single sign-on with the owner's identity provider, an allow-list of named operators), or passkey login handled by the API. In both cases the API would issue a short-lived server-side session in an `HttpOnly; Secure; SameSite=Strict` cookie, record the operator's identity on every write (reviews, withdrawals: Task 5.6 needs this, because review provenance must name a person), enforce CSRF protection on writes, and keep the bearer token only as a break-glass credential for scripts. This is a design note for the owner to accept or change; it needs its own reviewed task.
