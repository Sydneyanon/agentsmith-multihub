/**
 * Option D: the fetch the remote worker uses to reach the project's OWN API over the private network. Its destination is never derived
 * from untrusted input: it is the operator-configured WORKER_API_URL, validated at start-up (https, or http only to loopback or a Fly
 * private-network name). That is why it is not the SSRF-pinned outboundFetch, which (correctly) refuses private addresses. Redirects are
 * refused, so a response can never send the token elsewhere.
 */
export const internalApiFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });
