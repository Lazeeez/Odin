import { test as base, expect } from "@playwright/test";
import { REPO, serveFixture } from "./fixture.ts";

// Every test gets the fixture repository, and fails on any uncaught page error.
const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await serveFixture(page);
      await use();
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

test("home shows the product and the measured numbers", async ({ page }) => {
  await page.goto("./");
  await expect(page).toHaveTitle(/^Odin/);
  await expect(page.locator(".hero h1")).toContainText("Find the code");
  await expect(page.locator(".tile-value").first()).toHaveText(/%$/);
});

test("pages route and set their titles", async ({ page }) => {
  await page.goto("./");
  for (const [link, title, marker] of [
    ["Benchmarks", /^Benchmarks/, ".bar-row"],
    ["How it works", /^How it works/, ".pipeline .stage"],
    ["Explore", /^Explore/, "#explorer .bug-title"],
    ["Search", /^Search/, "#repo-input"],
  ] as const) {
    await page.locator("#site-menu a", { hasText: link }).click();
    await expect(page).toHaveTitle(title);
    await expect(page.locator(marker).first()).toBeVisible();
  }
});

test("the theme toggles between light and dark only, and persists", async ({ page }) => {
  await page.goto("./");
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const first = await theme();
  const toggle = page.locator("button[aria-label^='Switch to']");
  await toggle.click();
  const second = await theme();
  expect(new Set([first, second])).toEqual(new Set(["light", "dark"]));
  await page.reload();
  expect(await theme()).toBe(second);
  await toggle.click();
  expect(await theme()).toBe(first);
});

test("search: load a repository, describe a bug, get the right function", async ({ page }) => {
  await page.goto("./");
  await page.locator(".quickstart input").fill(REPO);
  await page.locator(".quickstart button").click();
  await expect(page.locator(".repo-pill")).toContainText(REPO);
  await expect(page.locator(".repo-summary")).toContainText("functions and classes in 3 files"); // tests left out
  // The language-model stage needs a download these tests do not make: switch it off.
  await page.locator(".toolbar .switch", { hasText: "Language-model" }).click();
  await page.locator("#demo-query").fill("load_config crashes with KeyError when the settings file is missing");
  await expect(page.locator("#search-app ol.hits .qual").first()).toHaveText("load_config");
  await expect(page.locator("#search-app .why .reason").first()).toBeVisible();
  await expect(page).toHaveURL(/#\/search\?repo=odin-e2e%2Ffixture&q=/);

  // A traceback points at the function where it ended.
  await page.locator("#demo-query").fill('Traceback (most recent call last):\n  File "/srv/pkg/http.py", line 3, in fetch\nConnectionError');
  await expect(page.locator("#search-app ol.hits .qual").first()).toHaveText("Client.fetch");
  await expect(page.locator("#search-app .why .reason").first()).toContainText("traceback");

  // Keyboard: j moves to the next result.
  await page.locator("#search-app .hit-head").first().focus();
  await page.keyboard.press("j");
  await expect(page.locator("#search-app ol.hits > li").nth(1).locator(".hit-head")).toBeFocused();

  // File view groups by file.
  await page.locator("[aria-label='Result granularity'] button", { hasText: "Files" }).click();
  await expect(page.locator("#search-app ol.hits .qual").first()).toHaveText("pkg/http.py");
});

test("search state survives a visit to another page", async ({ page }) => {
  await page.goto(`./#/search?repo=${encodeURIComponent(REPO)}`);
  await expect(page.locator(".repo-pill")).toContainText(REPO);
  await page.locator("#site-menu a", { hasText: "Benchmarks" }).click();
  await page.locator("#site-menu a", { hasText: "Search" }).click();
  await expect(page.locator(".repo-pill")).toContainText(REPO);
});

test("bad input and unknown repositories are explained", async ({ page }) => {
  await page.route("https://api.github.com/repos/odin-e2e/missing/**", (route) => route.fulfill({ status: 404, json: {} }));
  await page.goto("./#/search");
  await page.locator("#repo-input").fill("not a repo");
  await page.locator(".repo-card button[type=submit]").click();
  await expect(page.locator(".progress-text.error")).toContainText("owner/name");
  await page.locator("#repo-input").fill("odin-e2e/missing");
  await page.locator(".repo-card button[type=submit]").click();
  await expect(page.locator(".progress-text.error")).toContainText("Couldn't find");
});

test("explorer deep links and old-style links", async ({ page }) => {
  await page.goto("./#/explore/sympy__sympy-20590");
  await expect(page.locator("#explorer .bug-id")).toHaveText("sympy__sympy-20590");
  // a newcomer's path: a verdict in words, a stage's list on request, another bug from the list
  await expect(page.locator(".verdict")).not.toBeEmpty();
  await page.locator(".climb-head").first().click();
  await expect(page.locator(".climb-list li").first()).toBeVisible();
  await page.locator(".picker button", { hasText: "Browse all" }).click();
  await page.locator(".bug-filters select").selectOption("django/django");
  await page.locator(".bug-card").first().click();
  await expect(page.locator("#explorer .bug-id")).toContainText("django__django-");
  await expect(page).toHaveURL(/#\/explore\/django__django-/);
  await page.goto("./#issue=django__django-11019");
  await expect(page).toHaveURL(/#\/explore\/django__django-11019$/);
  await page.goto(`./?repo=${encodeURIComponent(REPO)}&q=config`);
  await expect(page).toHaveURL(/#\/search\?repo=odin-e2e%2Ffixture&q=config$/);
});

test("the tools: why-bars, recent change, map, bookmarklet, issue links, palette, Beat Odin", async ({ page }) => {
  await page.route("https://api.github.com/repos/odin-e2e/fixture/issues/7", (route) =>
    route.fulfill({ json: { number: 7, title: "load_config crashes with KeyError", body: "when the settings file is missing", html_url: "https://github.com/odin-e2e/fixture/issues/7" } }));
  await page.route("https://api.github.com/repos/odin-e2e/fixture/commits**", (route) =>
    route.fulfill({ json: [{ sha: "abc", html_url: "https://github.com/odin-e2e/fixture/commit/abc", commit: { message: "Read settings lazily", author: { name: "Ada", date: new Date().toISOString() } } }] }));

  // A GitHub issue link (what the bookmarklet opens) fills the query from the issue.
  await page.goto(`./#/search?repo=${encodeURIComponent(REPO)}&issue=7`);
  await expect(page.locator("#demo-query")).toHaveValue(/load_config crashes with KeyError/);
  await page.locator(".toolbar .switch", { hasText: "Language-model" }).click();
  await expect(page.locator("#search-app ol.hits .qual").first()).toHaveText("load_config");

  // The first result is open: why it ranks there, and when its file last changed.
  await expect(page.locator(".whybox li").first()).toBeVisible();
  await expect(page.locator(".recent-change")).toContainText("recently changed");

  // The map draws the repository, with the results on it.
  await page.locator("button", { hasText: "Show the map" }).click();
  await expect(page.locator(".repo-map canvas")).toBeVisible();

  // The bookmarklet is a real javascript: link pointing at this site.
  await page.goto("./");
  expect(await page.locator("a.bookmarklet-btn").getAttribute("href")).toMatch(/^javascript:.*#\/search\?repo=/);

  // Ctrl+K opens the palette; typing narrows it; Enter runs the command.
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill("bench");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/benchmarks$/);

  // Beat Odin: six files, one guess, then the reveal and the score.
  await page.goto("./#/explore?mode=game");
  await expect(page.locator(".choice")).toHaveCount(6);
  await page.locator(".choice").first().click();
  await expect(page.locator(".reveal-box .verdict")).not.toBeEmpty();
  await expect(page.locator(".game-score")).toContainText("after 1 round");
});

test("sections that render after their data arrives still reveal on scroll", async ({ page }) => {
  await page.goto("./#/benchmarks");
  const table = page.locator("table.heat");
  await table.scrollIntoViewIfNeeded();
  await expect(page.locator("section.reveal", { has: table })).toHaveClass(/\bin\b/);
  await expect(page.locator(".tiles.reveal")).toHaveClass(/\bin\b/);
});
