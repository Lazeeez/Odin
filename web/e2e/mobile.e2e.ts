import { expect, test } from "@playwright/test";

test("phone: the menu opens and closes, and no page scrolls sideways", async ({ page }) => {
  await page.goto("./#/benchmarks");
  await expect(page.locator("#site-menu")).toBeHidden();
  await page.locator(".menu-btn").click();
  await page.locator("#site-menu a", { hasText: "Explore" }).click();
  await expect(page.locator("#explorer .bug-title")).toBeVisible();
  await expect(page.locator("#site-menu")).toBeHidden();
  const width = page.viewportSize()!.width;
  for (const path of ["", "search", "benchmarks", "explore", "how-it-works"]) {
    await page.goto(`./#/${path}`);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `/${path}`).toBeLessThanOrEqual(width);
  }
});
