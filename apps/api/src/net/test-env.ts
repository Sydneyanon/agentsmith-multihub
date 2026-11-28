/**
 * Test seams (loopback destinations, plain HTTP, replaceable or unguarded fetch) exist only for the test suite.
 * They are enabled by an explicit positive condition, NODE_ENV === "test" (vitest sets it), rather than by "not production":
 * a deployment that forgets NODE_ENV (the default here is "development") must not keep them available.
 */
export function assertTestEnvironment(what: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`${what} is a test seam and requires NODE_ENV=test (current: ${JSON.stringify(process.env.NODE_ENV ?? null)})`);
  }
}
