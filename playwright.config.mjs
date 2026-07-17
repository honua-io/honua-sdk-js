import { defineConfig } from "@playwright/test";

const BROWSER_NAMES = new Set(["chromium", "firefox", "webkit"]);

export function resolvePlaywrightProjects(value) {
  if (value === undefined) return [{ name: "chromium", use: { browserName: "chromium" } }];
  let declared;
  try {
    declared = JSON.parse(value);
  } catch {
    throw new Error("HONUA_SAMPLE_PLAYWRIGHT_PROJECTS must be valid JSON");
  }
  if (
    !Array.isArray(declared) ||
    declared.length === 0 ||
    declared.length > BROWSER_NAMES.size ||
    declared.some(
      (project) =>
        !project ||
        typeof project !== "object" ||
        Array.isArray(project) ||
        Object.keys(project).sort().join(",") !== "browserName,name" ||
        typeof project.name !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.name) ||
        !BROWSER_NAMES.has(project.browserName),
    ) ||
    new Set(declared.map((project) => project.name)).size !== declared.length ||
    new Set(declared.map((project) => project.browserName)).size !== declared.length
  ) {
    throw new Error("HONUA_SAMPLE_PLAYWRIGHT_PROJECTS is not a unique supported project matrix");
  }
  return declared.map((project) => ({ name: project.name, use: { browserName: project.browserName } }));
}

export default defineConfig({
  testDir: "./test/playwright",
  outputDir: process.env.HONUA_SAMPLE_PLAYWRIGHT_OUTPUT_DIR ?? ".tmp/playwright-output",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "dot" : "list",
  projects: resolvePlaywrightProjects(process.env.HONUA_SAMPLE_PLAYWRIGHT_PROJECTS),
  use: {
    headless: true,
  },
});
