/**
 * Development-only transport for sandboxes whose DNS is reachable only through an HTTPS proxy (Node's fetch with
 * NODE_USE_ENV_PROXY=1). It bypasses the SSRF guard's address checks, so it is refused in production; callers must still apply
 * URL-level checks. Used by the bounty collector's live tests in such sandboxes, never by a deployed process.
 */
export function devProxyFetch(env: Record<string, string | undefined> = process.env): typeof fetch {
  if (env.NODE_ENV === "production") throw new Error("the development proxy transport is refused in production");
  return (input, init) => fetch(input, init);
}
