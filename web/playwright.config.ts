import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the production build (npm run build first). GitHub is replaced by a
// fixture repository (e2e/fixture.ts), so runs are deterministic and never rate-limited.
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:4173/", serviceWorkers: "block", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.e2e\.ts$/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.e2e\.ts$/ },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testIgnore: /mobile\.e2e\.ts$/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: /mobile\.e2e\.ts$/ },
    { name: "iphone", use: { ...devices["iPhone 14"] }, testMatch: /mobile\.e2e\.ts$/ },
  ],
  webServer: { command: "npm run preview -- --port 4173 --strictPort", port: 4173, reuseExistingServer: !process.env.CI },
});
