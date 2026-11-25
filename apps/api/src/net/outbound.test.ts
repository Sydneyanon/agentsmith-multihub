import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { outboundFetch, setOutboundFetchForTests, unguardedFetchForLoopbackFixtures } from "./outbound.js";

describe("production outbound client", () => {
  it("is the SSRF-pinned client by default: IP literals are refused before any network activity", async () => {
    await expect(outboundFetch("https://127.0.0.1/")).rejects.toMatchObject({ name: "SsrfError" });
    await expect(outboundFetch("https://[::1]/")).rejects.toMatchObject({ name: "SsrfError" });
    await expect(outboundFetch("https://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ name: "SsrfError" });
  });
  it("cannot be replaced, and the unguarded fixture fetch cannot be used, unless NODE_ENV is exactly 'test'", async () => {
    const prev = process.env.NODE_ENV;
    try {
      for (const v of ["production", "development", ""]) {
        process.env.NODE_ENV = v;
        expect(() => setOutboundFetchForTests(async () => new Response("x")), v).toThrow(/NODE_ENV/);
        expect(() => unguardedFetchForLoopbackFixtures("http://127.0.0.1:1/"), v).toThrow(/NODE_ENV/);
      }
      delete process.env.NODE_ENV;
      expect(() => setOutboundFetchForTests(null)).toThrow(/NODE_ENV/);
    } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
  });
});

describe("no unguarded outbound requests in application code", () => {
  const root = join(__dirname, "..");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "testing" && name !== "net" && name !== "integration") walk(p); }
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
    }
  })(root);
  it("only the net module may reference the global fetch, http(s).request or net.connect", () => {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/typeof fetch/g, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    const offenders = files.filter((f) => /(^|[^\w])fetch\b|\bhttps?\.(request|get)\s*\(|\bnet\.(connect|createConnection)\s*\(|\bfrom "undici"/.test(strip(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
  });
});
