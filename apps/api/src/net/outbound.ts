import { createSafeFetch } from "./safe-fetch.js";
import { assertTestEnvironment } from "./test-env.js";
import { assertSideEffectAllowed } from "../engine/effects.js";

/**
 * The only fetch used for requests whose destination derives from untrusted input
 * (source URLs, repository identities, redirects from third-party hosts).
 * A test may replace it; the replacement hook works only when NODE_ENV is exactly "test", so a
 * deployed process can never run with the SSRF guard swapped out (even if NODE_ENV was forgotten).
 */
const production = createSafeFetch();
let override: typeof fetch | null = null;

export const outboundFetch: typeof fetch = (input, init) => {
  // a research-loop dry run may never reach the network (no-op outside a dry run)
  try { assertSideEffectAllowed("network", `fetch ${new URL(String(input instanceof Request ? input.url : input)).host}`); } catch (e) { return Promise.reject(e); }
  return (override ?? production)(input as string | URL, init);
};

export function setOutboundFetchForTests(replacement: typeof fetch | null): void {
  assertTestEnvironment("replacing the outbound fetch");
  override = replacement;
}

/**
 * Plain fetch for tests whose fixtures are loopback servers (which the SSRF guard correctly refuses).
 * Reachable only through GitHubSource's `testOrigins`, itself test-only; this refuses too.
 */
export const unguardedFetchForLoopbackFixtures: typeof fetch = (input, init) => {
  assertTestEnvironment("the unguarded loopback-fixture fetch");
  assertSideEffectAllowed("network", "loopback fixture fetch");
  return fetch(input, init);
};
