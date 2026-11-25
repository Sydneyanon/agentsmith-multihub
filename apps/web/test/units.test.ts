// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { h, s } from "../src/dom.js";
import { ApiError, createApi, describeError } from "../src/api.js";
import { link, linkWith, parseHash } from "../src/router.js";
import { squarify } from "../src/treemap.js";
import { AUTOMATION, HEALTH, HYPOTHESIS_STATUS, NAV, REVIEW_MODE, RUN_STATUS, STAGES, stageStates, word } from "../src/vocab.js";
import { bytes, relativeTime } from "../src/format.js";

describe("dom builder: untrusted text stays text", () => {
  it("never turns strings into markup", () => {
    const evil = `<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>`;
    const el = h("div", { title: evil }, evil, h("span", {}, evil));
    document.body.append(el);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain(evil);
    expect(el.getAttribute("title")).toBe(evil);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
  it("builds svg in the svg namespace and skips null attributes", () => {
    const node = s("circle", { r: 4, fill: null, hidden: false });
    expect(node.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(node.hasAttribute("fill")).toBe(false);
    expect(node.hasAttribute("hidden")).toBe(false);
  });
  it("source contains no innerHTML or insertAdjacentHTML or eval use", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "apps", "web", "src");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
    }
  });
});

describe("vocabulary", () => {
  it("never labels anything verified, confirmed or independent", () => {
    const all = [HYPOTHESIS_STATUS, RUN_STATUS, HEALTH, AUTOMATION, REVIEW_MODE].flatMap((t) => Object.values(t).map((w) => w.label));
    for (const label of all) expect(label.toLowerCase(), label).not.toMatch(/verified|confirmed|independent/);
  });
  it("describes support as a reason to pursue, not a finding", () => {
    expect(word(HYPOTHESIS_STATUS, "supported_by_review").label).toBe("Reviewer supports pursuing");
  });
  it("shows unknown backend values verbatim and marks them unrecognised", () => {
    expect(word(HYPOTHESIS_STATUS, "verified").label).toBe("verified (unrecognised)");
    expect(word(HYPOTHESIS_STATUS, undefined).label).toContain("unrecognised");
    expect(word(HYPOTHESIS_STATUS, "constructor").label).toContain("unrecognised");
  });
  it("keeps blinded assessment and disclosed adjudication visibly different", () => {
    expect(REVIEW_MODE["blinded_independent_assessment"]!.label).not.toBe(REVIEW_MODE["disclosed_adjudication"]!.label);
    expect(REVIEW_MODE["blinded_independent_assessment"]!.tone).not.toBe(REVIEW_MODE["disclosed_adjudication"]!.tone);
  });
  it("marks a stage done only when the backend reports a record for it", () => {
    const none = stageStates({ snapshots: { sealed: 0 }, hypotheses: { total: 0 }, evaluations: 0, reviews: 0 });
    expect(none.map((x) => x.state)).toEqual(["not_built", "none", "not_built", "none", "none", "none", "not_built"]);
    const some = stageStates({ snapshots: { sealed: 1 }, hypotheses: { total: 2 }, evaluations: 0, reviews: 1 });
    expect(Object.fromEntries(some.map((x) => [x.key, x.state]))).toMatchObject({ repository: "done", analysis: "done", challenge: "none", review: "done", discovery: "not_built", verification: "not_built" });
    expect(STAGES).toHaveLength(7);
  });
  it("lists only built sections as links in navigation", () => {
    expect(NAV.filter((n) => !n.later).map((n) => n.id)).toEqual(["home", "projects", "repository", "hypotheses", "evidence", "activity"]);
    expect(NAV.filter((n) => n.later).every((n) => n.later)).toBe(true);
  });
});

describe("router", () => {
  it("parses hash routes, ids, sub paths and queries", () => {
    expect(parseHash("")).toMatchObject({ name: "home" });
    expect(parseHash("#/projects/abc")).toMatchObject({ name: "projects", id: "abc" });
    expect(parseHash("#/repository/abc?path=a%2Fb.sol&prefix=a%2F")).toMatchObject({ name: "repository", id: "abc", query: { path: "a/b.sol", prefix: "a/" } });
    expect(parseHash("#/reviews")).toMatchObject({ name: "later", sub: "reviews" });
  });
  it("falls back to home for unknown or prototype-named routes", () => {
    expect(parseHash("#/nope").name).toBe("home");
    expect(parseHash("#/constructor").name).toBe("home");
    expect(parseHash("#/__proto__").name).toBe("home");
  });
  it("round-trips encoded links", () => {
    expect(parseHash(link("hypotheses", "a/b")).id).toBe("a/b");
    expect(linkWith("#/x", { a: "1", b: undefined })).toBe("#/x?a=1");
  });
});

describe("api client", () => {
  const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
  it("sends the bearer token and never puts it in the url", async () => {
    const fetchImpl = vi.fn(async () => ok({ ok: true }));
    const api = createApi({ getToken: () => "secret-token", onUnauthorized: () => {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.get("/v1/research/projects", { limit: 5, status: undefined });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/research/projects?limit=5");
    expect(url).not.toContain("secret");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer secret-token");
  });
  it("signals a rejected token and throws a typed error", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi({ getToken: () => "x", onUnauthorized, fetchImpl: (async () => ok({ error: "unauthorized" }, 401)) as unknown as typeof fetch });
    await expect(api.get("/v1/research/overview")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it("maps network failure, 503 variants and 404 to honest messages", async () => {
    const api = createApi({ getToken: () => "x", onUnauthorized: () => {}, fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    const err = await api.get("/v1/research/overview").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(describeError(err).title).toMatch(/reach/i);
    expect(describeError(new ApiError(503, "api_auth_not_configured")).title).toMatch(/no access token/i);
    expect(describeError(new ApiError(503, "database_not_configured")).title).toMatch(/no database/i);
    expect(describeError(new ApiError(404, "not_found")).title).toBe("Not found");
  });
  it("posts JSON", async () => {
    const fetchImpl = vi.fn(async () => ok({ id: "r" }, 202));
    const api = createApi({ getToken: () => "x", onUnauthorized: () => {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.post("/v1/intake", { kind: "idea", value: "abc" });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ kind: "idea", value: "abc" }));
  });
});

describe("treemap layout", () => {
  const items = [50, 30, 10, 6, 4].map((weight, i) => ({ weight, data: i }));
  it("fills the area with rectangles proportional to weight and inside the bounds", () => {
    const rects = squarify(items, 400, 200);
    expect(rects).toHaveLength(5);
    const total = rects.reduce((a, r) => a + r.w * r.h, 0);
    expect(total).toBeCloseTo(400 * 200, 3);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6); expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(400 + 1e-6); expect(r.y + r.h).toBeLessThanOrEqual(200 + 1e-6);
      expect((r.w * r.h) / (400 * 200)).toBeCloseTo(items[r.data]!.weight / 100, 6);
    }
  });
  it("handles empty, zero-weight and degenerate input", () => {
    expect(squarify([], 100, 100)).toEqual([]);
    expect(squarify([{ weight: 0, data: 1 }], 100, 100)).toEqual([]);
    expect(squarify(items, 0, 100)).toEqual([]);
  });
  it("does not let rectangles overlap", () => {
    const rects = squarify(items, 400, 200);
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]!, b = rects[j]!;
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      expect(overlapX > 1e-6 && overlapY > 1e-6).toBe(false);
    }
  });
});

describe("format", () => {
  it("formats sizes and ages without inventing precision", () => {
    expect(bytes(512)).toBe("512 B"); expect(bytes(2048)).toBe("2.0 KiB"); expect(bytes(null)).toBe("—");
    const now = new Date("2026-01-01T12:00:00Z");
    expect(relativeTime("2026-01-01T11:00:00Z", now)).toBe("1 h ago"); expect(relativeTime(null, now)).toBe("never"); expect(relativeTime("garbage", now)).toBe("unknown");
  });
});

describe("CSP-compatible styling", () => {
  it("sets inline sizes through the CSSOM, never a style attribute", () => {
    const el = h("span", { style: "width:40%" });
    expect(el.style.width).toBe("40%");
  });
});
