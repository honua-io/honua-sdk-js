import { expect, test } from "@playwright/test";

import { startQuickstartFixtureServer } from "../../examples/maplibre-quickstart/mock-server.mjs";

test.setTimeout(90_000);

test("quickstart app loads fixture-backed data and opens an inspection popup", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const fixtureServer = await startQuickstartFixtureServer();

  try {
    await page.goto(fixtureServer.url);

    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.mapReady === true))
      .toBe(true);

    await expect(page.locator("#status-compatibility")).toHaveText(/Compatible/);
    await expect(page.locator("#status-feature-count")).toHaveText("3 renderable of 3");
    await expect(page.locator("#status-geometry-types")).toHaveText("polygon");

    const layerIds = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.layerIds ?? []);
    expect(layerIds).toContain("quickstart-fill");

    await expect(page.locator("#linked-visible-count")).toHaveText("3");
    await page.locator("#attribute-filter").selectOption({ label: "STATUS: Ready" });
    await expect(page.locator("#linked-visible-count")).toHaveText("1");
    await expect(page.locator("#feature-list")).toContainText("Kakaako utility corridor");
    await expect(page.locator("#feature-list")).not.toContainText("Harbor response district");
    await expect(page.locator("#linked-query-projection")).toContainText('"STATUS"');
    await page.locator("#clear-filter-button").click();
    await expect(page.locator("#linked-visible-count")).toHaveText("3");

    await page.getByRole("button", { name: "Inspect Harbor response district" }).click();

    await expect(page.locator("#selected-feature-title")).toHaveText("Harbor response district");
    await expect(page.locator(".maplibregl-popup")).toContainText("Harbor response district");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.selectedFeatureId))
      .toBe("2");
    await expect
      .poll(async () => page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.popupOpen === true))
      .toBe(true);

    expect(pageErrors).toEqual([]);
  } finally {
    await fixtureServer.close();
  }
});
