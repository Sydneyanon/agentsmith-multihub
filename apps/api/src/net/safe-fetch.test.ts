import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createSafeFetch, SsrfError, type Resolver } from "./safe-fetch.js";

/** A real loopback server stands in for "the internet" so the actual connected socket is exercised. */
async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
const open: Array<() => Promise<void>> = [];
afterEach(async () => { while (open.length) await open.pop()!(); });
const track = async (h: http.RequestListener) => { const s = await listen(h); open.push(s.close); return s; };

// "Production" policy (loopback refused). A test-only policy that permits loopback is exercised separately.
const staticResolver = (map: Record<string, string[]>): Resolver => async (host) => {
  const a = map[host]; if (!a) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return a;
};

describe("SSRF-safe fetch: destination validation", () => {
  it("refuses a hostname that resolves to a private address, without connecting", async () => {
    let hits = 0; const s = await track((_q, r) => { hits++; r.end("secret"); });
    const f = createSafeFetch({ resolver: staticResolver({ "evil.example.org": ["127.0.0.1"] }), allowedPorts: [s.port], allowInsecureHttp: true });
    await expect(f(`http://evil.example.org:${s.port}/`)).rejects.toMatchObject({ name: "SsrfError", code: "destination_blocked" });
    expect(hits).toBe(0);
  });
  it("refuses when ANY resolved address is non-public (mixed answers)", async () => {
    const f = createSafeFetch({ resolver: staticResolver({ "mixed.example.org": ["8.8.8.8", "10.0.0.5"] }) });
    await expect(f("https://mixed.example.org/")).rejects.toMatchObject({ code: "destination_blocked" });
  });
  it("refuses every IP-literal URL form without resolving", async () => {
    let resolved = 0; const f = createSafeFetch({ resolver: async () => { resolved++; return ["8.8.8.8"]; } });
    for (const u of ["https://127.0.0.1/", "https://[::1]/", "https://[::ffff:7f00:1]/", "https://2130706433/", "https://0x7f.1/", "https://[2606:4700:4700::1111]/", "https://8.8.8.8/"]) {
      await expect(f(u), u).rejects.toMatchObject({ name: "SsrfError" });
    }
    expect(resolved).toBe(0);
  });
  it("refuses non-http(s) schemes, credentials and non-default ports in production policy", async () => {
    const f = createSafeFetch({ resolver: staticResolver({ "ok.example.org": ["8.8.8.8"] }) });
    await expect(f("file:///etc/passwd")).rejects.toMatchObject({ code: "scheme_blocked" });
    await expect(f("ftp://ok.example.org/")).rejects.toMatchObject({ code: "scheme_blocked" });
    await expect(f("https://u:p@ok.example.org/")).rejects.toMatchObject({ code: "credentials_blocked" });
    await expect(f("https://ok.example.org:8443/")).rejects.toMatchObject({ code: "port_blocked" });
    await expect(f("http://ok.example.org/")).rejects.toMatchObject({ code: "scheme_blocked" });
  });
  it("treats a resolver failure and an empty answer as errors, never as a fallback to the system resolver", async () => {
    const f = createSafeFetch({ resolver: async () => [] });
    await expect(f("https://nothing.example.org/")).rejects.toMatchObject({ code: "resolution_failed" });
  });
});

describe("SSRF-safe fetch: connection pinning and DNS rebinding", () => {
  it("connects to the address that was validated, not to a second resolution", async () => {
    // A rebinding resolver: first answer is public, any later answer is loopback. The client must resolve once and pin.
    let calls = 0;
    const rebinding: Resolver = async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const seen: string[] = [];
    const f = createSafeFetch({
      resolver: rebinding, allowLoopbackForTests: false,
      connectHook: (addr) => { seen.push(addr); throw new SsrfError("connect_intercepted", "stop after recording the pinned address"); },
    });
    await expect(f("https://rebind.example.org/")).rejects.toMatchObject({ code: "connect_intercepted" });
    expect(calls).toBe(1);
    expect(seen).toEqual(["93.184.216.34"]);
  });
  it("verifies the connected peer address and aborts if it is not the validated one", async () => {
    const s = await track((_q, r) => r.end("leaked"));
    // Validator believes the host is 93.184.216.34 (public) but the pinned socket actually lands on loopback:
    // the post-connect peer check must refuse (defence in depth against a lookup that is bypassed).
    const f = createSafeFetch({
      resolver: staticResolver({ "peer.example.org": ["93.184.216.34"] }),
      allowedPorts: [s.port], allowInsecureHttp: true,
      connectOverrideForTests: () => ({ host: "127.0.0.1" }),
    });
    await expect(f(`http://peer.example.org:${s.port}/`)).rejects.toMatchObject({ code: "peer_mismatch" });
  });
  it("sends the original hostname as Host/SNI while connecting to the pinned address", async () => {
    let host = ""; const s = await track((q, r) => { host = String(q.headers.host); r.end("ok"); });
    const f = createSafeFetch({
      resolver: staticResolver({ "named.example.org": ["127.0.0.1"] }),
      allowedPorts: [s.port], allowInsecureHttp: true, allowLoopbackForTests: true,
    });
    const res = await f(`http://named.example.org:${s.port}/x`);
    expect(await res.text()).toBe("ok");
    expect(host).toBe(`named.example.org:${s.port}`);
  });
  it("test-only loopback policy is refused in production", () => {
    const prev = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { expect(() => createSafeFetch({ allowLoopbackForTests: true })).toThrow(/production/); } finally { process.env.NODE_ENV = prev; }
  });
});

describe("SSRF-safe fetch: redirects", () => {
  const opts = (port: number, map: Record<string, string[]>, extraPorts: number[] = []) => ({
    resolver: staticResolver(map), allowedPorts: [port, ...extraPorts], allowInsecureHttp: true, allowLoopbackForTests: true,
  });
  it("revalidates every hop: a redirect to a private hostname is refused and never contacted", async () => {
    let privateHits = 0;
    const priv = await track((_q, r) => { privateHits++; r.end("internal"); });
    const pub = await track((_q, r) => { r.statusCode = 302; r.setHeader("location", `http://internal.example.org:${priv.port}/admin`); r.end(); });
    // `internal.example.org` resolves to 10.0.0.1 => blocked even though the first hop (allowed loopback in tests) succeeded.
    const f = createSafeFetch(opts(pub.port, { "pub.example.org": ["127.0.0.1"], "internal.example.org": ["10.0.0.1"] }, [priv.port]));
    await expect(f(`http://pub.example.org:${pub.port}/`)).rejects.toMatchObject({ code: "destination_blocked" });
    expect(privateHits).toBe(0);
  });
  it("refuses a redirect to an IP literal, to a non-http scheme and to credentials", async () => {
    for (const loc of ["http://127.0.0.1/", "http://[::1]/", "file:///etc/passwd", "http://u:p@pub.example.org/", "gopher://x/"]) {
      const s = await track((_q, r) => { r.statusCode = 301; r.setHeader("location", loc); r.end(); });
      const f = createSafeFetch(opts(s.port, { "pub.example.org": ["127.0.0.1"] }));
      await expect(f(`http://pub.example.org:${s.port}/`), loc).rejects.toBeInstanceOf(SsrfError);
    }
  });
  it("caps the number of redirects", async () => {
    const s = await track((q, r) => { r.statusCode = 302; r.setHeader("location", `/${(Number(q.url!.slice(1)) || 0) + 1}`); r.end(); });
    const f = createSafeFetch({ ...opts(s.port, { "loop.example.org": ["127.0.0.1"] }), maxRedirects: 3 });
    await expect(f(`http://loop.example.org:${s.port}/`)).rejects.toMatchObject({ code: "too_many_redirects" });
  });
  it("follows a legitimate same-host redirect and returns the final response", async () => {
    const s = await track((q, r) => { if (q.url === "/a") { r.statusCode = 302; r.setHeader("location", "/b"); r.end(); } else r.end("final"); });
    const f = createSafeFetch(opts(s.port, { "ok.example.org": ["127.0.0.1"] }));
    const res = await f(`http://ok.example.org:${s.port}/a`);
    expect(await res.text()).toBe("final");
  });
  it("in manual mode returns the 3xx to the caller untouched (the caller owns redirect policy)", async () => {
    const s = await track((_q, r) => { r.statusCode = 302; r.setHeader("location", "/b"); r.end(); });
    const f = createSafeFetch(opts(s.port, { "ok.example.org": ["127.0.0.1"] }));
    const res = await f(`http://ok.example.org:${s.port}/a`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/b");
  });
  it("strips Authorization on a cross-origin redirect", async () => {
    let auth: string | undefined;
    const b = await track((q, r) => { auth = q.headers.authorization as string | undefined; r.end("b"); });
    const a = await track((_q, r) => { r.statusCode = 302; r.setHeader("location", `http://b.example.org:${b.port}/`); r.end(); });
    const f = createSafeFetch({ resolver: staticResolver({ "a.example.org": ["127.0.0.1"], "b.example.org": ["127.0.0.1"] }), allowedPorts: [a.port, b.port], allowInsecureHttp: true, allowLoopbackForTests: true });
    await (await f(`http://a.example.org:${a.port}/`, { headers: { authorization: "Bearer secret" } })).text();
    expect(auth).toBeUndefined();
  });
});

describe("SSRF-safe fetch: response handling", () => {
  it("supports AbortSignal and streams the body", async () => {
    const s = await track((_q, r) => { r.write("a"); /* never ends */ });
    const f = createSafeFetch({ resolver: staticResolver({ "slow.example.org": ["127.0.0.1"] }), allowedPorts: [s.port], allowInsecureHttp: true, allowLoopbackForTests: true });
    const ac = new AbortController();
    const res = await f(`http://slow.example.org:${s.port}/`, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await expect(reader.read()).rejects.toBeTruthy();
  });
});
