import { expect, test } from "@playwright/test";

import { startSpatialAnalyticsWorkbenchFixtureServer } from "../../examples/spatial-analytics-workbench/mock-server.mjs";

test.setTimeout(90_000);

test("one accepted plan drives linked map, table, chart, evidence, and output", async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const server = await startSpatialAnalyticsWorkbenchFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.ready)).toBe(true);

    await expect(page.locator("#data-mode")).toHaveText("Fixture replay");
    await expect(page.locator("#plan-state")).toHaveText("Estimate");
    await expect(page.locator("#execution-truth")).toContainText("No result rows were read");
    await expect(page.locator("#plan-steps")).toContainText("remote · queryAggregate");
    await expect(page.locator("#plan-json")).toContainText("geoservices-rest-query-v1");
    await expect(page.locator("#result-count")).toHaveText("0");

    await page.getByRole("button", { name: "Accept plan" }).click();
    await expect(page.locator("#plan-state")).toHaveText("Accepted");
    await page.getByRole("button", { name: "Execute accepted plan" }).click();
    await expect(page.locator("#evidence-state")).toHaveText("Fixture Replay");
    await expect(page.locator("#execution-truth")).toContainText("committed response fixture");
    await expect(page.locator("#job-state")).toHaveText("Successful");
    await expect(page.locator("#result-count")).toHaveText("3");
    await expect(page.locator("#result-table")).toContainText("Iwilei electrical substation");
    await expect(page.locator("#risk-chart")).toContainText("Critical");
    await expect(page.locator("#artifact-json")).toContainText("honua.linked-analysis-output.v1");
    await expect(page.locator("#lineage")).toContainText("plan:sha256:");

    await page.locator('#risk-chart button[data-risk="high"]').click();
    await expect(page.locator("#plan-state")).toHaveText("Estimate");
    await expect(page.locator("#risk-filter")).toHaveValue("high");
    await expect(page.locator('#risk-chart button[data-risk="high"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#result-count")).toHaveText("1");
    await expect(page.locator("#result-table")).toContainText("Kakaako mixed-use parcel cluster");
    await expect(page.locator('.map-marker[aria-label="Open Kakaako mixed-use parcel cluster"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Accept plan" }).click();
    await page.getByRole("button", { name: "Execute accepted plan" }).click();
    await expect(page.locator("#result-count")).toHaveText("1");
    await expect(page.locator("#result-table")).toContainText("Kakaako mixed-use parcel cluster");
    await page.getByRole("button", { name: "Open Kakaako mixed-use parcel cluster" }).last().click();
    await expect(page.locator("#feature-detail")).toContainText("Kakaako mixed-use parcel cluster");
    await expect(page.locator('#result-table button[aria-pressed="true"]')).toHaveText(
      "Open Kakaako mixed-use parcel cluster",
    );
    await expect(page.locator('.map-marker[aria-pressed="true"]')).toHaveAttribute(
      "aria-label",
      "Open Kakaako mixed-use parcel cluster",
    );

    await page.locator("#execution-lane").selectOption("bounded-local");
    await expect(page.locator("#plan-steps")).toContainText("remote · queryAll");
    await expect(page.locator("#plan-steps")).toContainText("client · aggregate");
    await page.getByRole("button", { name: "Accept plan" }).click();
    await page.getByRole("button", { name: "Execute accepted plan" }).click();
    await expect(page.locator("#evidence-state")).toHaveText("Executed Local");
    await expect(page.locator("#execution-truth")).toContainText("row and byte ceilings");

    await page.locator("#execution-lane").selectOption("unsafe-rejected");
    await expect(page.locator("#plan-state")).toHaveText("Rejected");
    await expect(page.locator("#plan-steps")).toContainText("unsafe-materialization");
    await expect(page.getByRole("button", { name: "Accept plan" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Execute accepted plan" })).toBeDisabled();

    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.locator("#workspace-export")).toContainText("honua.saved-workspace");
    await expect(page.locator("#workspace-export")).toContainText("executionPlanFingerprint");

    await testInfo.attach("linked-analysis-workbench", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    const stateBeforeDispose = await page.locator("#plan-state").textContent();
    await page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.dispose());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.disposed)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Explain" }).click();
    await expect(page.locator("#plan-state")).toHaveText(stateBeforeDispose ?? "");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.explain()))
      .toBe("disposed");
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});

test("live OGC mode is a structured compiler skip, never simulated execution", async ({ page }) => {
  const server = await startSpatialAnalyticsWorkbenchFixtureServer();
  try {
    await page.goto(`${server.url}/?mode=live&protocol=ogc-features&baseUrl=https://example.test/ogc&serviceId=incidents&layerId=0`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__?.ready)).toBe(true);
    await expect(page.locator("#data-mode")).toHaveText("Configured live");
    await expect(page.locator("#plan-state")).toHaveText("Skipped");
    await expect(page.locator("#execution-truth")).toContainText("#389 follow-on");
    await expect(page.getByRole("button", { name: "Execute accepted plan" })).toBeDisabled();
    await expect(page.locator("#result-count")).toHaveText("0");
  } finally {
    await server.close();
  }
});

test("workbench remains keyboard-operable and responsive at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await startSpatialAnalyticsWorkbenchFixtureServer();
  try {
    await page.goto(server.url);
    await page.keyboard.press("Tab");
    await expect(page.locator(".skip-link")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#workbench-main")).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByLabel("Area of interest")).toBeVisible();
    await expect(page.getByLabel("Execution policy")).toBeVisible();
    await expect(page.getByRole("region", { name: "Schematic AOI map with linked analysis features" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept plan" })).toBeVisible();
  } finally {
    await server.close();
  }
});
