/**
 * Control Room screenshots from SYNTHETIC data (hub-demo.ts) and from an EMPTY database (the honest idle state).
 *   npm run build && TEST_DATABASE_URL=... npx tsx scripts/control-room-screenshots.ts <outDir>
 * Not a pass/fail check: layout assertions live in `npm run hub:layout-check`.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchBrowser, startDemo } from "./hub-demo.js";

const outDir = resolve(process.argv[2] ?? "docs/control-room-screenshots");
mkdirSync(outDir, { recursive: true });
const browser = await launchBrowser();
for (const empty of [true, false]) {
  const demo = await startDemo({ empty });
  try {
    const shots: Array<[string, string]> = empty ? [["idle", "#/control"]] : [["synthetic", "#/control"], ["architecture", `#/repository/${demo.ids.snapshot}`]];
    for (const [label, width, height, mobile] of [["phone", 390, 844, true], ["desktop", 1440, 900, false]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
      await context.addInitScript((t) => sessionStorage.setItem("agentsmith.hub.token", t), demo.token);
      const page = await context.newPage();
      for (const [name, hash] of shots) {
        await page.goto(`${demo.base}/hub/${hash}`);
        await page.waitForSelector(".content .view", { timeout: 10_000 });
        await page.waitForFunction(() => !document.querySelector(".state-loading"), undefined, { timeout: 15_000 });
        if (name === "architecture") { await page.evaluate(() => { document.querySelectorAll("details.arch-component").forEach((d) => (d as HTMLDetailsElement).open = true); [...document.querySelectorAll(".panel")].find((p) => p.textContent?.includes("Protocol architecture"))?.scrollIntoView(); }); await page.screenshot({ path: join(outDir, `${label}-${name}.png`) }); }
        else {
          // a full-page capture would paint the fixed phone tab bar mid-page; pin it to the end of the document for the capture only
          await page.evaluate(() => document.querySelectorAll<HTMLElement>(".tabbar").forEach((t) => t.style.setProperty("position", "static", "important")));
          await page.screenshot({ path: join(outDir, `${label}-${name}.png`), fullPage: true });
        }
      }
      await context.close();
    }
  } finally { await demo.close(); }
}
await browser.close();
console.log(`screenshots in ${outDir}`);
