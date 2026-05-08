import { expect, test } from "@playwright/test";

import { startSpatialAnalyticsWorkbenchFixtureServer } from "../../examples/spatial-analytics-workbench/mock-server.mjs";

test.setTimeout(90_000);

test("spatial analytics workbench runs jobs and renders indexed aggregation widgets", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startSpatialAnalyticsWorkbenchFixtureServer();
  try {
    await page.goto(server.url);
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.ready === true))
      .toBe(true);

    await expect(page.locator("#cache-state")).toContainText("ready");
    await expect(page.locator("#capability-state")).toContainText("degraded");
    await expect(page.locator("#result-count")).toHaveText("0");

    await page.getByRole("button", { name: "Run Analysis" }).click();
    await expect(page.locator("#job-state")).toHaveText("Accepted");
    await page.getByRole("button", { name: "Advance Job" }).click();
    await expect(page.locator("#job-state")).toHaveText("Running");
    await page.getByRole("button", { name: "Advance Job" }).click();
    await expect(page.locator("#job-state")).toHaveText("Successful");
    await expect(page.locator("#result-count")).toHaveText("3");
    await expect(page.locator("#result-table")).toContainText("Iwilei electrical substation");
    await expect(page.locator("#materialized-layer")).toContainText("materialized-analytics-buffer-overlay");

    await page.locator("#risk-filter").selectOption("high");
    await expect(page.locator("#result-count")).toHaveText("1");
    await expect(page.locator("#result-table")).toContainText("Kakaako mixed-use parcel cluster");

    await page
      .locator("#result-table")
      .getByRole("button", { name: /Open Kakaako mixed-use parcel cluster/ })
      .click();
    await expect(page.locator("#feature-detail")).toContainText("Kakaako mixed-use parcel cluster");

    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.locator("#workspace-export")).toContainText("honua.saved-workspace");
    await expect(page.locator("#workspace-export")).toContainText("materialized-result");

    await page.getByRole("button", { name: "Run Indexed Aggregation" }).click();
    await expect(page.locator("#job-state")).toHaveText("Successful");
    await expect(page.locator("#result-count")).toHaveText("2");
    await expect(page.locator(".aggregation-cell")).toHaveCount(2);
    await expect(page.locator("#aggregation-widgets")).toContainText("Severity");
    await expect(page.locator("#aggregation-widgets")).toContainText("Response time");
    await expect(page.locator("#aggregation-widgets")).toContainText("Population exposure");
    await expect(page.locator("#job-diagnostics")).toContainText("No failed-job diagnostics");

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
