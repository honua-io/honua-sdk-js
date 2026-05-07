import { expect, test } from "@playwright/test";

import { startGeoprocessingJobRunnerFixtureServer } from "../../examples/geoprocessing-job-runner/mock-server.mjs";

test.setTimeout(90_000);

test("geoprocessing job runner materializes linked results and surfaces degraded states", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startGeoprocessingJobRunnerFixtureServer();
  try {
    await page.goto(server.url);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_GEOPROCESSING_JOB_RUNNER__?.ready === true))
      .toBe(true);

    await expect(page.locator("#job-state")).toHaveText("Idle");
    await expect(page.locator("#cache-state")).toContainText("ready");
    await expect(page.locator("#result-count")).toHaveText("0");

    await page.getByRole("button", { name: "Run Job" }).click();
    await expect(page.locator("#job-state")).toHaveText("Accepted");
    await page.getByRole("button", { name: "Poll" }).click();
    await expect(page.locator("#job-state")).toHaveText("Running");
    await page.getByRole("button", { name: "Poll" }).click();
    await expect(page.locator("#job-state")).toHaveText("Successful");
    await expect(page.locator("#result-count")).toHaveText("2");
    await expect(page.locator("#result-table")).toContainText("Iwilei electrical substation");
    await expect(page.locator("#materialized-layer")).toContainText("materialized-gp-runner-buffer-overlay");

    await page.locator("#category-filter").selectOption("asset");
    await expect(page.locator("#result-count")).toHaveText("1");
    await expect(page.locator("#result-table")).toContainText("Ala Moana pump station");

    await page.locator("#result-table").getByRole("button", { name: /Open Ala Moana pump station/ }).click();
    await expect(page.locator("#feature-detail")).toContainText("Ala Moana pump station");

    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.locator("#workspace-export")).toHaveValue(/honua\.saved-workspace/);
    await expect(page.locator("#workspace-export")).toHaveValue(/geospatial-grpc/);

    await page.locator("#plan-select").selectOption("network-allocation");
    await page.getByRole("button", { name: "Run Job" }).click();
    await page.getByRole("button", { name: "Poll" }).click();
    await expect(page.locator("#job-state")).toHaveText("Failed");
    await expect(page.locator("#job-diagnostics")).toContainText("CapabilityNotSupported");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
