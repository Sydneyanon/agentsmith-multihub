import { describe, expect, it } from "vitest";
import { renderTvPage } from "./tv-page.js";

function feed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated_at: "2026-01-02T15:04:05.000Z",
    eligibility: { eligible: 3, needs_verification: 7 },
    sources: [{ enabled: true }, { enabled: true }, { enabled: false }],
    programmes: [
      { project: "Acme", platform: "sherlock", max_reward: 2_000_000, currency: "USD", eligibility: { tier: "eligible" } },
      { project: "Beta", platform: "hackenproof", max_reward: 250_000, currency: "USD", eligibility: { tier: "needs_verification" } },
      { project: "Gamma", platform: "code4rena", max_reward: 7500, currency: "USD", eligibility: { tier: "out_of_engine_scope" } },
    ],
    ...over,
  };
}

describe("renderTvPage", () => {
  it("is a self-contained no-JS page that refreshes itself and loads only the external TV stylesheet", () => {
    const html = renderTvPage(feed());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta http-equiv="refresh"');
    expect(html).toContain('<link rel="stylesheet" href="/hub/assets/tv.css">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
  });

  it("shows headline counts from the feed", () => {
    const html = renderTvPage(feed());
    expect(html).toContain(">3<"); // eligible
    expect(html).toContain(">7<"); // needs verify
    expect(html).toContain(">2<"); // live sources (enabled only)
    expect(html).toMatch(/>3<\/span><span class="l">Programmes/); // total programmes
  });

  it("formats rewards compactly and ranks the biggest first", () => {
    const html = renderTvPage(feed());
    expect(html).toContain("$2M");
    expect(html).toContain("$250K");
    expect(html).toContain("$7.5K");
    expect(html.indexOf("$2M")).toBeLessThan(html.indexOf("$250K"));
    expect(html.indexOf("$250K")).toBeLessThan(html.indexOf("$7.5K"));
  });

  it("escapes programme text so a crafted name cannot inject markup", () => {
    const html = renderTvPage(feed({ programmes: [{ project: "<img src=x onerror=alert(1)>", platform: "x\"y", max_reward: null }] }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("x&quot;y");
  });

  it("renders a friendly empty state with no programmes", () => {
    const html = renderTvPage(feed({ programmes: [] }));
    expect(html).toContain("No programmes to show yet");
    expect(html).not.toContain("<table");
  });

  it("shows a dash for programmes with no stated reward", () => {
    const html = renderTvPage(feed({ programmes: [{ project: "NoReward", platform: "sherlock", max_reward: null, eligibility: { tier: "eligible" } }] }));
    expect(html).toContain('class="reward none"');
  });
});
