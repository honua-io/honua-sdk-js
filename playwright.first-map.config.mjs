import { defineConfig } from "@playwright/test";

const releaseMatrix = process.env.HONUA_FIRST_MAP_RELEASE_MATRIX === "true";

export default defineConfig({
  testDir: "./test/playwright",
  outputDir: process.env.HONUA_SAMPLE_PLAYWRIGHT_OUTPUT_DIR ?? ".tmp/playwright-first-map-output",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "dot" : "list",
  projects: releaseMatrix
    ? [
        { name: "chromium", use: { browserName: "chromium" } },
        { name: "firefox", use: { browserName: "firefox" } },
        { name: "webkit", use: { browserName: "webkit" } },
      ]
    : [{ name: "chromium", use: { browserName: "chromium" } }],
  use: { headless: true },
});
