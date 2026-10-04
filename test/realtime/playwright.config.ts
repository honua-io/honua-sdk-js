import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.browser.spec.ts",
  outputDir: "../../.tmp/realtime-playwright-output",
  workers: 1,
  use: { browserName: "chromium", headless: true },
});
