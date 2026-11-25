import { createSafeFetch } from "./safe-fetch.js";

/**
 * The only fetch used for requests whose destination derives from untrusted input
 * (source URLs, repository identities, redirects from third-party hosts).
 * A test may replace it; the replacement hook refuses to operate in production, so a
 * production process can never run with the SSRF guard swapped out.
 */
const production = createSafeFetch();
let override: typeof fetch | null = null;

export const outboundFetch: typeof fetch = (input, init) =>
  (override ?? production)(input as string | URL, init);

export function setOutboundFetchForTests(replacement: typeof fetch | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("the outbound fetch cannot be replaced in production");
  override = replacement;
}

/**
 * Plain fetch for tests whose fixtures are loopback servers (which the SSRF guard correctly refuses).
 * Reachable only through GitHubSource's `testOrigins`, itself refused in production; this refuses too.
 */
export const unguardedFetchForLoopbackFixtures: typeof fetch = (input, init) => {
  if (process.env.NODE_ENV === "production") throw new Error("unguarded fetch is refused in production");
  return fetch(input, init);
};
