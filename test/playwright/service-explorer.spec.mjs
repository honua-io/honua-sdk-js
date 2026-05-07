import { expect, test } from "@playwright/test";

import { startServiceExplorerFixtureServer } from "../../examples/service-explorer/mock-server.mjs";

test.setTimeout(90_000);

test("service explorer source picker handles queryable and render-only standards sources", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const fixtureServer = await startServiceExplorerFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    await expect.poll(async () => page.evaluate(() => window.__HONUA_SERVICE_EXPLORER_RUNTIME__?.ready)).toBe(true);
    await expect(page.locator("#source-picker")).toContainText("FeatureServer");
    await expect(page.locator("#source-picker")).toContainText("WFS");
    await expect(page.locator("#source-picker")).toContainText("WMTS");
    await expect(page.locator("#source-kind")).toHaveText("FeatureServer / queryable");
    await expect(page.locator("#visible-count")).toHaveText("8");

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

    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
