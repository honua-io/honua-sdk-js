import { expect, test } from "@playwright/test";

import { startServiceExplorerFixtureServer } from "../../examples/service-explorer/mock-server.mjs";
import { attestBrowserQuality, attestClosedFixture, finalizeSampleConsole } from "./sample-gate-assertions.mjs";

test.setTimeout(90_000);

test("service explorer source picker handles queryable and render-only standards sources", async ({ browser, browserName }, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const fixtureServer = await startServiceExplorerFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);
    await expect(page.locator("#source-picker")).toContainText("FeatureServer");
    await expect(page.locator("#source-picker")).toContainText("WFS");
    await expect(page.locator("#source-picker")).toContainText("WMTS");
    // Expanded protocol coverage: lanes for every SDK protocol family appear.
    await expect(page.locator("#source-picker")).toContainText("Honua gRPC");
    await expect(page.locator("#source-picker")).toContainText("ImageServer");
    await expect(page.locator("#source-picker")).toContainText("STAC");
    await expect(page.locator("#source-picker")).toContainText("MapLibre");
    // The picker is grouped into protocol-family optgroups.
    const familyLabels = await page.locator("#source-picker optgroup").evaluateAll((groups) =>
      groups.map((group) => group.label),
    );
    expect(familyLabels).toContain("Esri GeoServices");
    expect(familyLabels).toContain("OGC API & catalogs");
    await expect(page.locator("#source-kind")).toHaveText("FeatureServer / queryable");
    await expect(page.locator("#visible-count")).toHaveText("8");
    await expect(page.getByTestId("honua-sample-mode")).toHaveText(/source|packed/);
    await expect(page.getByTestId("honua-sample-evidence")).toContainText("Evidence");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.locator("#attribute-filter").selectOption({ label: "status: open" });
    await expect(page.locator("#visible-count")).toHaveText("3");
    await expect(page.locator("#query-json")).toContainText("status");

    await page.goto(`${fixtureServer.url}/?source=wfs-service-requests`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);
    await expect(page.locator("#source-kind")).toHaveText("WFS / queryable");
    await expect(page.locator("#visible-count")).toHaveText("8");
    await expect(page.locator("#source-cache-policy")).toContainText("GetCapabilities");

    await page.goto(`${fixtureServer.url}/?source=wmts-basemap`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);
    await expect(page.locator("#source-kind")).toHaveText("WMTS / render-only");
    await expect(page.locator("#attribute-filter")).toBeDisabled();
    await expect(page.locator("#result-table-body")).toContainText("disabled for this render-only standards source");
    await expect(page.locator("#capability-list")).toContainText("render");
    await expect(page.locator("#diagnostic-list")).toContainText("Table/query controls disabled");
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.queryable)).toBe(false);

    // STAC catalog-search lane is queryable and feeds the linked table.
    await page.goto(`${fixtureServer.url}/?source=stac-imagery`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);
    await expect(page.locator("#source-kind")).toHaveText("STAC / queryable");
    await expect(page.locator("#visible-count")).toHaveText("8");

    // Utility-only Geometry Service lane keeps metadata live but disables table/query.
    await page.goto(`${fixtureServer.url}/?source=geometry-utility`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);
    await expect(page.locator("#source-kind")).toHaveText("Geometry Service / degraded");
    await expect(page.locator("#attribute-filter")).toBeDisabled();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.queryable)).toBe(false);

    // Return to a queryable lane for the shared quality workflow and teardown
    // lifecycle check.
    await page.goto(`${fixtureServer.url}/?source=stac-imagery`);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);

    const runtimeReady = await page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready === true);
    const sampleReadyDurationMs = await page.evaluate(() => performance.now());
    await attestBrowserQuality({
      page,
      testInfo,
      sampleId: "service-explorer",
      browserName,
      sampleReadyDurationMs,
      runtimeReady,
      responsiveViewports: [
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ],
      workflowSelectors: ["#source-picker", "#map", "#result-table-body"],
    });

    // Prove the table/chart delegated handlers work before teardown and become
    // inert after their cleanup runs.
    await page.locator("#result-table-body button[data-feature-id]").first().click();
    await page.locator("#chart-buckets button.chart-bucket").first().click();
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.interactionCount)).toBe(2);
    const interactionCountBeforeDispose = await page.evaluate(
      () => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.interactionCount,
    );
    const pageErrorCountBeforeDispose = pageErrors.length;
    const consoleErrorCountBeforeDispose = consoleErrors.length;
    await page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_DISPOSE__?.());
    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.disposed)).toBe(true);
    await expect(page.locator(".maplibregl-canvas")).toHaveCount(0);
    await page.locator("#result-table-body button[data-feature-id]").first().evaluate((button) => button.click());
    await page.locator("#chart-buckets button.chart-bucket").first().evaluate((button) => button.click());
    expect(await page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.interactionCount)).toBe(
      interactionCountBeforeDispose,
    );
    expect(pageErrors).toHaveLength(pageErrorCountBeforeDispose);
    expect(consoleErrors).toHaveLength(consoleErrorCountBeforeDispose);
  } finally {
    try {
      await fixtureServer.close();
      await attestClosedFixture(testInfo, "service-explorer", "startServiceExplorerFixtureServer");
    } finally {
      await finalizeSampleConsole({
        testInfo,
        sampleId: "service-explorer",
        page,
        context,
        pageErrors,
        consoleErrors,
      });
    }
  }
});
