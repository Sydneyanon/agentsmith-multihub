/**
 * Visual walkthrough of the hub from SYNTHETIC records (see hub-demo.ts). Phone shots are real viewport captures at the top
 * and bottom of each page, so the fixed tab bar is shown exactly as it behaves; desktop shots are full-page.
 *
 *   npm run build && TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres npm run hub:screenshots -- <outDir>
 *
 * This is NOT a pass/fail check. The layout assertions live in `npm run hub:layout-check`.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchBrowser, startDemo } from "./hub-demo.js";

const outDir = resolve(process.argv[2] ?? "docs/hub-screenshots");

async function main(): Promise<void> {
  const demo = await startDemo();
  try {
    mkdirSync(outDir, { recursive: true });
    const browser = await launchBrowser();
    for (const [label, width, height, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
      await context.addInitScript((t) => sessionStorage.setItem("agentsmith.hub.token", t), demo.token);
      const page = await context.newPage();
      for (const [name, hash] of demo.routes) {
        await page.goto(`${demo.base}/hub/${hash}`);
        await page.reload();
        await page.waitForSelector(".content .view, .content .home-grid", { timeout: 10_000 });
        await page.waitForFunction(() => !document.querySelector(".state-loading"), undefined, { timeout: 10_000 });
        if (mobile) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: join(outDir, `${label}-${name}-top.png`) });
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await page.screenshot({ path: join(outDir, `${label}-${name}-bottom.png`) });
        } else await page.screenshot({ path: join(outDir, `${label}-${name}.png`), fullPage: true });
      }
      await context.close();
    }
    const locked = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
    const lockedPage = await locked.newPage();
    await lockedPage.goto(`${demo.base}/hub/`);
    await lockedPage.waitForSelector(".unlock-card");
    await lockedPage.screenshot({ path: join(outDir, "phone-locked.png") });
    await browser.close();
    console.log(`wrote screenshots to ${outDir}`);
  } finally {
    await demo.close();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
