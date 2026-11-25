/**
 * Real-browser layout and security check of the built hub, run on SYNTHETIC data (hub-demo.ts). It is deliberately separate from
 * `npm run verify` because it needs Chromium and a loopback Postgres. Exit code 1 when any check fails.
 *
 *   npm run build && TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres npm run hub:layout-check
 *
 * Checks, per viewport (375, 390, 430 phones, 820 and 1180 tablet, 1440 desktop) and per screen: no horizontal overflow, no
 * text outside the viewport, spilling out of its box or clipped, no two pieces of text overlapping, touch targets of at least
 * 44px, and, on phones, the tab bar left as `position: fixed`, pinned to the bottom and not covering the last content.
 * Also: no Content-Security-Policy violation during normal use, the policy really blocks injected inline script, inline styles and
 * eval, and the attack-surface map re-lays out on resize and rotation.
 */
import { readFileSync } from "node:fs";
import { launchBrowser, startDemo } from "./hub-demo.js";

const probe = readFileSync(new URL("./hub-layout-probe.js", import.meta.url), "utf8").replace(/^\/\/.*$/gm, "").trim();
const VIEWPORTS: Array<[string, number, number, boolean]> = [
  ["iphone-se-375", 375, 667, true], ["iphone-390", 390, 844, true], ["iphone-max-430", 430, 932, true],
  ["ipad-820", 820, 1180, true], ["tablet-landscape-1180", 1180, 820, true], ["desktop-1440", 1440, 900, false],
];
const failures: string[] = [];
let checks = 0;
const fail = (where: string, what: string) => failures.push(`${where}: ${what}`);
const expectThat = (ok: boolean, where: string, what: string) => { checks += 1; if (!ok) fail(where, what); };

async function main(): Promise<void> {
  const demo = await startDemo();
  const browser = await launchBrowser();
  try {
    // the policy header is what the browser enforces; assert it is the strict one
    const res = await fetch(`${demo.base}/hub/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expectThat(/default-src 'none'/.test(csp) && /script-src 'self'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp), "csp-header", `unexpected policy: ${csp}`);

    for (const [name, width, height, touch] of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: touch && width < 800, hasTouch: touch, reducedMotion: "reduce" });
      await context.addInitScript((t) => {
        sessionStorage.setItem("agentsmith.hub.token", t);
        (window as unknown as { __csp: string[] }).__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(e.effectiveDirective), true);
      }, demo.token);
      const page = await context.newPage();
      const consoleCsp: string[] = [];
      page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text().slice(0, 160)); });
      page.on("pageerror", (e) => fail(`${name}`, `uncaught page error: ${e.message}`));
      for (const [route, hash] of demo.routes) {
        const where = `${name} ${route}`;
        await page.goto(`${demo.base}/hub/${hash}`);
        await page.reload();
        await page.waitForSelector(".content .view, .content .home-grid", { timeout: 10_000 });
        await page.waitForFunction(() => !document.querySelector(".state-loading"), undefined, { timeout: 10_000 });
        const problems = (await page.evaluate(`(${probe})(${JSON.stringify({ touch })})`)) as Array<{ kind: string; detail: string }>;
        checks += 1;
        for (const p of problems.slice(0, 6)) fail(where, `${p.kind}: ${p.detail}`);
        if (problems.length > 6) fail(where, `…and ${problems.length - 6} more`);

        if (width < 820) {
          // the tab bar must stay fixed and pinned, whatever the page length, and must not hide the end of the content
          const state = await page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            const bar = document.querySelector<HTMLElement>(".tabbar")!;
            const last = document.querySelector<HTMLElement>(".content")!.lastElementChild!;
            const r = bar.getBoundingClientRect();
            return { position: getComputedStyle(bar).position, display: getComputedStyle(bar).display, barTop: r.top, barBottom: r.bottom, vh: window.innerHeight, lastBottom: last.getBoundingClientRect().bottom, items: bar.querySelectorAll("a").length };
          });
          expectThat(state.display !== "none" && state.position === "fixed", where, `tab bar is ${state.display}/${state.position}, expected a visible fixed bar`);
          expectThat(Math.abs(state.barBottom - state.vh) <= 1, where, `tab bar bottom ${state.barBottom} is not at the viewport bottom ${state.vh}`);
          expectThat(state.lastBottom <= state.barTop + 1, where, `last content ends at ${Math.round(state.lastBottom)}, under the tab bar that starts at ${Math.round(state.barTop)}`);
          expectThat(state.items === 6, where, `tab bar has ${state.items} links, expected 6`);
        }
      }
      expectThat((await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).length === 0, `${name}`, "CSP violation during normal use");
      expectThat(consoleCsp.length === 0, `${name}`, `CSP console messages: ${consoleCsp.join(" | ")}`);
      await context.close();
    }

    // the policy blocks what it should: inject a script, an inline style attribute and a foreign image (eval is covered by the header assertion: code run through the test driver is exempt from the policy) and see the browser refuse
    {
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      await context.addInitScript((t) => {
        sessionStorage.setItem("agentsmith.hub.token", t);
        (window as unknown as { __csp: string[] }).__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(e.effectiveDirective), true);
      }, demo.token);
      const page = await context.newPage();
      await page.goto(`${demo.base}/hub/#/home`);
      await page.waitForSelector(".content");
      const outcome = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const script = document.createElement("script"); script.textContent = "window.__injected = 1"; document.body.append(script);
        const styled = document.createElement("div"); styled.setAttribute("style", "color: red"); styled.textContent = "x"; document.body.append(styled);
        const img = document.createElement("img"); img.src = "https://example.invalid/pixel.png"; document.body.append(img);
        return { injected: w["__injected"], inlineStyleApplied: getComputedStyle(styled).color === "rgb(255, 0, 0)" };
      });
      await page.waitForTimeout(300);
      const directives = (await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)) as string[];
      expectThat(outcome.injected === undefined, "csp-enforcement", "an injected inline <script> ran");
      expectThat(!outcome.inlineStyleApplied, "csp-enforcement", "an injected inline style attribute was applied");
      expectThat(directives.some((d) => d.startsWith("script-src")), "csp-enforcement", `no script-src violation reported (${directives.join(",")})`);
      expectThat(directives.some((d) => d.startsWith("style-src")), "csp-enforcement", `no style-src violation reported (${directives.join(",")})`);
      expectThat(directives.includes("img-src"), "csp-enforcement", `a foreign image was not blocked (${directives.join(",")})`);
      await context.close();
    }

    // the attack-surface map follows its container: phone, then desktop, then rotated, then back
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await context.addInitScript((t) => sessionStorage.setItem("agentsmith.hub.token", t), demo.token);
      const page = await context.newPage();
      await page.goto(`${demo.base}/hub/#/repository/${demo.ids.snapshot}`);
      await page.waitForSelector(".treemap");
      const box = async () => page.evaluate(() => document.querySelector(".treemap")!.getAttribute("viewBox"));
      expectThat((await box()) === "0 0 420 520", "treemap", `phone portrait viewBox was ${await box()}`);
      for (const [label, w, h, expected] of [["desktop", 1440, 900, "0 0 960 420"], ["phone landscape (sidebar layout leaves the map under 600px)", 844, 390, "0 0 420 520"], ["tablet landscape", 1180, 820, "0 0 960 420"], ["phone portrait again", 390, 844, "0 0 420 520"]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForFunction((e) => document.querySelector(".treemap")?.getAttribute("viewBox") === e, expected, { timeout: 3000 }).catch(() => undefined);
        expectThat((await box()) === expected, "treemap", `${label}: viewBox ${await box()}, expected ${expected}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await demo.close();
  }
  console.log(`hub layout check: ${checks} checks across ${VIEWPORTS.length} viewports x ${demo.routes.length} screens`);
  if (failures.length) { console.error(`FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join("\n")}`); process.exit(1); }
  console.log("PASS");
}
main().catch((error) => { console.error(error); process.exit(1); });
