/**
 * Small timing helpers used across the browser modules.
 */

import type { Page } from "playwright-core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Let a dynamic page briefly settle after a resize/render before measuring. */
export async function shortSettle(page: Page, ms = 150): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
}
